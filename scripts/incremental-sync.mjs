#!/usr/bin/env node
// WDCloud 共享资产 → 本地工作台的增量同步。
//
//   node scripts/incremental-sync.mjs --check                 # 只比对版本与差集
//   node scripts/incremental-sync.mjs --download --shards 32  # 下载变化分片（可断点续跑）
//   node scripts/incremental-sync.mjs --import                # 把新快照导入本地库
//   node scripts/incremental-sync.mjs --all                   # 三步连做
//
// 链路（依据 2026-09-24 实测）：
//   1. 触发 talent-pool-agent 的 sync.export（scope=manifest），拿到最新
//      generationId / treeHash / asset-candidates.jsonl，与本地
//      candidate_asset_index.profile_sha256 做差集（新增 / 变化 / 消失 / 无法定位）。
//      注意：官方 `applicantIds` 参数实测不会收窄导出范围（传 2 个 ID 仍返回
//      39,651 个档案），因此增量必须走「整份索引 + 差集 + 分片快照」。
//   2. 按差集决定要拉的分片；resumes 分片是整份快照，下载后按需取用，
//      本地导入按差集只处理新增/变化的候选人。
//   3. 导入后跑 scripts/parse-origin-resume-sections.mjs —— 它只处理
//      「还没有解析产物」的候选人，因此新导入的人会自动进入解析队列。
//
// 安全：任何写库动作都要显式传 --import；默认只做检查与下载。
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
const WORK = resolve(DATA, 'incremental')
const MANIFEST_DIR = resolve(WORK, 'manifest')
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(DATA, 'recruitment.db')
const CLI = 'C:/Users/cboy/.codex/plugins/cache/wdcloud-plugin/wdcloud/0.2.80/scripts/wdcloud-pluginctl.ps1'
const AGENT_ID = 'talent-pool-agent'
const STATE_PATH = resolve(WORK, 'sync-state.json')

function parseArgs(argv) {
  const options = { check: false, download: false, import: false, shards: 32, env: 'test' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--download') options.download = true
    else if (arg === '--import') options.import = true
    else if (arg === '--all') { options.check = true; options.download = true; options.import = true }
    else if (arg === '--shards') { index += 1; options.shards = Number.parseInt(argv[index], 10) }
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 20).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  if (!options.check && !options.download && !options.import) options.check = true
  return options
}

function cli(args, timeout = 300000) {
  const command = `& '${CLI}' ${args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(' ')} --json`
  const output = execFileSync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })
  const start = output.indexOf('{')
  if (start < 0) throw new Error(`CLI 无 JSON 输出：${output.slice(0, 200)}`)
  return JSON.parse(output.slice(start))
}

function readState() {
  if (!existsSync(STATE_PATH)) return { downloadedShards: {}, lastCheck: null, lastImport: null }
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return { downloadedShards: {}, lastCheck: null, lastImport: null } }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

async function runAgentTask(input, { title, timeoutMs = 45 * 60 * 1000 }) {
  const payloadPath = resolve(WORK, `payload-${Date.now()}.json`)
  mkdirSync(WORK, { recursive: true })
  writeFileSync(payloadPath, JSON.stringify({ env: 'test', title, input }, null, 2))
  const run = cli(['agent', 'run', AGENT_ID, '--input', payloadPath])
  const task = run.data?.taskRun ?? run.data ?? run
  const taskId = String(task.taskRunId)
  const deadline = Date.now() + timeoutMs
  let status = 'unknown'
  while (Date.now() < deadline) {
    const result = cli(['agent', 'status', taskId])
    const current = result.data?.taskRun ?? result.data ?? result
    status = String(current.status ?? 'unknown')
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) {
      return { taskId, status, error: current.lastError ?? null }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 8000))
  }
  return { taskId, status: 'timeout', error: null }
}

async function downloadArtifacts(taskId, targetDir, { only = null } = {}) {
  mkdirSync(targetDir, { recursive: true })
  const payload = cli(['agent', 'artifacts', taskId])
  const artifacts = payload.data?.artifacts ?? []
  const saved = []
  for (const item of artifacts) {
    if (!item.url) continue
    if (only && !only(item.name)) continue
    const target = resolve(targetDir, item.name)
    // 已存在且 sha256 一致才跳过；只有大小相符不算数（可能是不完整下载）。
    if (existsSync(target)) {
      const sha = createHash('sha256').update(readFileSync(target)).digest('hex')
      if (sha === item.sha256) { saved.push({ name: item.name, skipped: true }); continue }
    }
    const response = await fetch(item.url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
    if (!response.ok) throw new Error(`下载 ${item.name} 失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(target, buffer)
    saved.push({
      name: item.name,
      bytes: buffer.length,
      shaMatch: createHash('sha256').update(buffer).digest('hex') === item.sha256
    })
  }
  return saved
}

// 分片产物是 zip（内含 candidates/<relativeDir>/origin.pdf 等），下载后需要解压。
// 用系统自带 tar 解压（Windows 10+ 自带 bsdtar，能处理 zip），避免引入依赖。
async function extractArtifact(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const result = spawnSync('tar', ['-xf', zipPath, '-C', targetDir], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`解压失败 ${zipPath}: ${String(result.stderr ?? '').slice(0, 200)}`)
  }
  return true
}

async function computeDelta(indexPath) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const local = new Map(db.prepare('SELECT applicant_id AS a, profile_sha256 AS s FROM candidate_asset_index').all().map((row) => [row.a, row.s]))
  db.close()
  const delta = { incoming: 0, same: 0, added: [], changed: [], unkeyable: 0, removed: [] }
  const incomingIds = new Set()
  const reader = createInterface({ input: createReadStream(indexPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of reader) {
    const text = line.trim()
    if (!text) continue
    const row = JSON.parse(text)
    delta.incoming += 1
    if (!row.candidateId) { delta.unkeyable += 1; continue }
    incomingIds.add(row.applicantId)
    const known = local.get(row.applicantId)
    if (known === undefined) delta.added.push({ applicantId: row.applicantId, candidateId: row.candidateId, sha: row.profileSha256 })
    else if (known === row.profileSha256) delta.same += 1
    else delta.changed.push({ applicantId: row.applicantId, candidateId: row.candidateId, sha: row.profileSha256, previous: known })
  }
  delta.removed = [...local.keys()].filter((id) => !incomingIds.has(id))
  return delta
}

const options = parseArgs(process.argv.slice(2))
const state = readState()
const summary = { steps: [] }

// ── 1. 拉最新 manifest 并算差集 ────────────────────────────────────────────
let manifest = null
if (options.check) {
  const exportResult = await runAgentTask(
    { mode: 'sync.export', scope: 'manifest' },
    { title: '增量同步：导出资产清单' }
  )
  if (exportResult.status !== 'succeeded') throw new Error(`manifest 导出失败：${exportResult.status} ${exportResult.error ?? ''}`)
  const saved = await downloadArtifacts(exportResult.taskId, MANIFEST_DIR)
  manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, 'manifest.json'), 'utf8'))
  const delta = await computeDelta(resolve(MANIFEST_DIR, 'asset-candidates.jsonl'))
  state.lastCheck = { at: new Date().toISOString(), revision: manifest.revision, taskId: exportResult.taskId, delta: { added: delta.added.length, changed: delta.changed.length, removed: delta.removed.length, same: delta.same } }
  saveState(state)
  summary.steps.push({ step: 'check', taskId: exportResult.taskId, revision: manifest.revision, delta: state.lastCheck.delta, artifacts: saved.length })
  summary.delta = { added: delta.added, changed: delta.changed, removed: delta.removed }
}

// ── 2. 下载简历快照分片 ───────────────────────────────────────────────────
if (options.download) {
  const pending = []
  for (let index = 0; index < options.shards; index += 1) {
    const key = `origin:${index}/${options.shards}`
    if (!state.downloadedShards[key]) pending.push(index)
  }
  for (const index of pending) {
    const result = await runAgentTask({
      mode: 'sync.export',
      scope: 'resumes',
      shardIndex: index,
      shardCount: options.shards,
      maxArtifactBytes: 1073741824,
      includeOrigin: true,
      includeStandard: true
    }, { title: `增量同步：简历分片 ${index}/${options.shards}` })
    if (result.status !== 'succeeded') {
      summary.steps.push({ step: 'download', shard: index, status: result.status, error: result.error })
      continue
    }
    // zip 落到 resumes/_zips，解压到 resumes/，保证与首次导入的目录结构一致
    // （scripts/import-incremental.mjs 读 <base>/candidates/<relativeDir>/origin.pdf）。
    const zipDir = resolve(WORK, 'resumes', '_zips')
    const saved = await downloadArtifacts(result.taskId, zipDir, { only: (name) => name.endsWith('.zip') })
    let extracted = 0
    for (const item of saved) {
      if (!item.name?.endsWith('.zip')) continue
      await extractArtifact(resolve(zipDir, item.name), resolve(WORK, 'resumes'))
      extracted += 1
    }
    state.downloadedShards[`origin:${index}/${options.shards}`] = {
      taskId: result.taskId, at: new Date().toISOString(), zips: saved.length, extracted
    }
    saveState(state)
    summary.steps.push({ step: 'download', shard: index, zips: saved.length, extracted })
  }
}

// ── 3. 导入（默认只提示命令，避免误写库）───────────────────────────────────
if (options.import) {
  const report = spawnSync('node', ['scripts/import-talent-asset.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  summary.steps.push({ step: 'import', status: report.status === 0 ? 'succeeded' : 'failed', output: String(report.stdout ?? '').slice(-1500) })
}

console.log(JSON.stringify(summary, null, 1))
