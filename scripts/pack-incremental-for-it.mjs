#!/usr/bin/env node
// 打包"增量同步包"交给 IT，让他们在服务器上把数据同步更新过去。
//
//   node scripts/pack-incremental-for-it.mjs                      # 预演：报告将包含多少文件/多大
//   node scripts/pack-incremental-for-it.mjs --since <ISO>        # 只打包该时间之后新增/修改的文件
//   node scripts/pack-incremental-for-it.mjs --all                # 打包整个 data/incremental
//   node scripts/pack-incremental-for-it.mjs --apply              # 真正产出 zip（默认预演）
//
// 产物：data/packages/incremental-<时间戳>.zip（内含 incremental/ 数据 + README.txt + package.json）
//      data/packages/last-pack.json（记录本次打包时间，供下一次 --since 默认使用）
//
// 服务器侧应用：scripts/apply-incremental-package.ps1（停服 → 解包 → 导入 → 解析 → 落文本 → 向量维护 → 起服）
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, linkSync, copyFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = resolve(ROOT, 'data', 'incremental')
const PACKAGE_DIR = resolve(ROOT, 'data', 'packages')
const LAST_PACK = resolve(PACKAGE_DIR, 'last-pack.json')

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const all = argv.includes('--all')
const sinceIndex = argv.indexOf('--since')
let since = sinceIndex >= 0 ? String(argv[sinceIndex + 1] ?? '') : ''
const outIndex = argv.indexOf('--out')
const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const outPath = resolve(outIndex >= 0 ? String(argv[outIndex + 1]) : join(PACKAGE_DIR, `incremental-${stamp}.zip`))

if (!all && !since && existsSync(LAST_PACK)) {
  try { since = String(JSON.parse(readFileSync(LAST_PACK, 'utf8')).packed_at ?? '') } catch { since = '' }
}
const sinceMs = since ? Date.parse(since) : 0
if (since && Number.isNaN(sinceMs)) throw new Error(`--since 不是合法时间：${since}`)

function collect(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, predicate, out)
    else if (entry.isFile() && predicate(full)) out.push(full)
  }
  return out
}

const files = []
// manifest 始终整份带上（导入器需要索引文件）
for (const file of collect(join(WORK, 'manifest'), () => true)) files.push(file)

// 差集候选人目录：本地库 imported_at >= since 的人，就是本轮真正要同步的人。
// （分片下载会把同片其他候选人一起解压出来，若不按目录过滤，包会膨胀到数 GB。）
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(ROOT, 'data', 'recruitment.db')
let deltaDirs = []
if (!all && since && existsSync(DB_PATH)) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    deltaDirs = db.prepare('SELECT relative_dir AS dir FROM candidate_asset_index WHERE imported_at >= ?').all(since)
      .map((row) => String(row.dir ?? '').replace(/\\/gu, '/')).filter(Boolean)
    db.close()
  } catch { deltaDirs = [] }
}
const deltaPrefixes = deltaDirs.map((dir) => `${dir}/`)

// profiles / resumes：优先按差集目录精确取；没有差集信息时退回按 mtime 过滤（--all 则全带）
for (const sub of ['profiles', 'resumes']) {
  const base = join(WORK, sub)
  for (const file of collect(base, (full) => {
    const rel = relative(base, full)
    if (rel.includes(`${sep}_zips${sep}`)) return false // 原始分片 zip 不必再传，解压产物已在
    if (all) return true
    const relPosix = rel.split(sep).join('/')
    if (deltaPrefixes.length > 0) return deltaPrefixes.some((prefix) => relPosix.startsWith(prefix))
    try { return statSync(full).mtimeMs > sinceMs } catch { return false }
  })) files.push(file)
}

const manifestJson = existsSync(join(WORK, 'manifest', 'manifest.json'))
  ? JSON.parse(readFileSync(join(WORK, 'manifest', 'manifest.json'), 'utf8'))
  : null
const syncState = existsSync(join(WORK, 'sync-state.json'))
  ? JSON.parse(readFileSync(join(WORK, 'sync-state.json'), 'utf8'))
  : null

const entries = files.map((full) => ({ full, rel: relative(WORK, full).split(sep).join('/'), size: statSync(full).size }))
const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
const summary = {
  generated_at: new Date().toISOString(),
  since: since || null,
  mode: all ? 'all' : (since ? 'since' : 'delta-unknown'),
  delta_candidates: deltaDirs.length,
  files: entries.length,
  bytes: totalBytes,
  generation_id: manifestJson?.revision?.generationId ?? null,
  last_check: syncState?.lastCheck?.delta ?? null,
  output: outPath,
  dry_run: !apply
}
console.log(JSON.stringify(summary, null, 1))

if (!apply) process.exit(0)

// 硬链接暂存（同盘零拷贝）→ tar 打成 zip（bsdtar 支持 >2GB）
const stagingRoot = resolve(PACKAGE_DIR, `.staging-${stamp}`)
const stagingIncremental = join(stagingRoot, 'incremental')
mkdirSync(stagingIncremental, { recursive: true })
mkdirSync(PACKAGE_DIR, { recursive: true })

const checksums = []
for (const entry of entries) {
  const target = join(stagingIncremental, entry.rel)
  mkdirSync(dirname(target), { recursive: true })
  try { linkSync(entry.full, target) } catch { copyFileSync(entry.full, target) }
}
for (const entry of entries) {
  const hash = createHash('sha256').update(readFileSync(entry.full)).digest('hex')
  checksums.push(`${hash}  ${entry.rel}`)
}
writeFileSync(join(stagingRoot, 'checksums.sha256'), `${checksums.join('\n')}\n`)
writeFileSync(join(stagingRoot, 'package.json'), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(join(stagingRoot, 'README.txt'), [
  'Talent asset workbench - incremental data package',
  '',
  `generation: ${summary.generation_id ?? 'n/a'}`,
  `files: ${summary.files}`,
  `uncompressed: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
  `packed_at: ${summary.generated_at}`,
  '',
  'How to apply on the server (service must be stopped):',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File "<code>\\scripts\\apply-incremental-package.ps1" -Package "<this zip>"',
  '',
  'The script will:',
  '  1. stop server/index.mjs and the TalentWorkbench task',
  '  2. expand this package into C:\\talent-data\\incremental',
  '  3. node scripts/import-incremental.mjs --apply       (candidates + profile sections + attachments)',
  '  4. node scripts/run-phase3-full.mjs                 (parse newly added origin resumes; uses the model gateway)',
  '  5. node scripts/persist-attachment-text.mjs --apply (attachment text into the DB)',
  '  6. node scripts/search-vector-maintenance.mjs --formal ... (refresh the f16 vector index)',
  '  7. node scripts/converge-business-search.mjs --apply (converge the business index)',
  '  8. start the service again',
  ''
].join('\n'))

const tar = spawnSync('tar', ['-a', '-cf', outPath, '-C', stagingRoot, '.'], { encoding: 'utf8', windowsHide: true })
if (tar.status !== 0) {
  console.error(JSON.stringify({ error: 'tar_failed', detail: String(tar.stderr ?? '').slice(0, 300) }))
  process.exitCode = 1
} else {
  rmSync(stagingRoot, { recursive: true, force: true })
  mkdirSync(PACKAGE_DIR, { recursive: true })
  writeFileSync(LAST_PACK, `${JSON.stringify({ packed_at: summary.generated_at, package: outPath, files: entries.length, bytes: totalBytes }, null, 2)}\n`)
  console.log(JSON.stringify({ packed: outPath, bytes: statSync(outPath).size, files: entries.length }))
}
