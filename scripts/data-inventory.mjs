#!/usr/bin/env node
// 全量数据清单 + 校验（交给 IT 核对"数据是否完整搬过去"）。
//
//   node scripts/data-inventory.mjs --out data\deploy\data-manifest.json   # 生成清单
//   node scripts/data-inventory.mjs --verify data\deploy\data-manifest.json # 校验（文件数/大小/SHA256）
//
// 分类：
//   runtime  —— 服务器运行必需（主库三件套 / 向量目录 / 附件目录 / 检索配置）
//   archive  —— 原始资产快照与增量缓存（留档用，服务器非必需但建议保留）
//   reports  —— 解析/评测/审计报告
//   logs     —— 运行日志与 PID（可忽略）
//   handover —— 本工具生成的清单与部署脚本（不参与自身清单）
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
const argv = process.argv.slice(2)
const verifyIndex = argv.indexOf('--verify')

const RUNTIME = new Set(['recruitment.db', 'recruitment.db-wal', 'recruitment.db-shm', 'search-vectors', 'private', 'search-runtime.json'])
const ARCHIVE = new Set(['asset-export', 'incremental'])
const HANDOVER = new Set(['deploy', 'packages'])
const LOG_PATTERN = /\.(log|pid)$/iu

function classify(name) {
  if (RUNTIME.has(name)) return 'runtime'
  if (ARCHIVE.has(name)) return 'archive'
  if (HANDOVER.has(name)) return 'handover'
  if (LOG_PATTERN.test(name) || /^(extract|phase3-b2000|vector-build|business-search|self-test|search-test|vacuum|tests-run|persist-|download|profile|resume)/iu.test(name)) return 'logs'
  return 'reports'
}

function measure(target) {
  const stats = statSync(target)
  if (!stats.isDirectory()) return { type: 'file', files: 1, bytes: stats.size }
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files += 1
        try { bytes += statSync(full).size } catch {}
      }
    }
  }
  walk(target)
  return { type: 'dir', files, bytes }
}

// 主库 >2 GiB，readFileSync 会直接抛 ERR_FS_FILE_TOO_LARGE，必须流式哈希。
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function buildManifest() {
  const items = []
  for (const entry of readdirSync(DATA, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const category = classify(entry.name)
    if (category === 'handover') continue
    const full = join(DATA, entry.name)
    const { type, files, bytes } = measure(full)
    const item = { path: `data/${entry.name}`, category, type, files, bytes }
    if (type === 'file' && ['recruitment.db', 'search-runtime.json'].includes(entry.name)) item.sha256 = await sha256(full)
    items.push(item)
  }
  const totals = items.reduce((acc, item) => {
    acc.files += item.files
    acc.bytes += item.bytes
    acc.by_category[item.category] = acc.by_category[item.category] ?? { files: 0, bytes: 0 }
    acc.by_category[item.category].files += item.files
    acc.by_category[item.category].bytes += item.bytes
    return acc
  }, { files: 0, bytes: 0, by_category: {} })
  return {
    generated_at: new Date().toISOString(),
    hostname: hostname(),
    source_root: DATA,
    note: 'runtime=服务器运行必需；archive=原始快照/增量缓存（留档）；reports=报告；logs=可忽略',
    totals,
    items
  }
}

const gib = (bytes) => Number((bytes / 1024 ** 3).toFixed(2))

if (verifyIndex >= 0) {
  const manifestPath = resolve(argv[verifyIndex + 1] ?? '')
  if (!existsSync(manifestPath)) throw new Error(`清单不存在：${manifestPath}`)
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const problems = []
  for (const item of expected.items) {
    const name = item.path.replace(/^data\//u, '')
    const full = join(DATA, name)
    if (!existsSync(full)) { problems.push({ path: item.path, issue: 'missing' }); continue }
    const actual = measure(full)
    if (actual.files !== item.files) problems.push({ path: item.path, issue: 'files_mismatch', expected: item.files, actual: actual.files })
    if (actual.bytes !== item.bytes) problems.push({ path: item.path, issue: 'bytes_mismatch', expected: item.bytes, actual: actual.bytes })
    if (item.sha256) {
      const actualSha = await sha256(full)
      if (actualSha !== item.sha256) problems.push({ path: item.path, issue: 'sha256_mismatch', expected: item.sha256, actual: actualSha })
    }
  }
  console.log(JSON.stringify({ verified: problems.length === 0, items: expected.items.length, problems }, null, 1))
  process.exit(problems.length === 0 ? 0 : 1)
}

const manifest = await buildManifest()
const outIndex = argv.indexOf('--out')
const outPath = resolve(outIndex >= 0 ? String(argv[outIndex + 1]) : join(DATA, 'deploy', 'data-manifest.json'))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({
  written: outPath,
  items: manifest.items.length,
  files: manifest.totals.files,
  bytes: manifest.totals.bytes,
  total_gib: gib(manifest.totals.bytes),
  by_category: Object.fromEntries(Object.entries(manifest.totals.by_category).map(([key, value]) => [key, { files: value.files, gib: gib(value.bytes) }]))
}, null, 1))
