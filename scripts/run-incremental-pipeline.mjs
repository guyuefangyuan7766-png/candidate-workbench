#!/usr/bin/env node
// 增量管道驱动（2026-10-08 定档：事件驱动 + 显式触发，不设定时器）。
//
//   node scripts/run-incremental-pipeline.mjs                # 预演：拉索引算差集 + 下载分片 + 导入 dry-run
//   node scripts/run-incremental-pipeline.mjs --apply        # 真跑：逐步骤串起来（写库前要求服务已停）
// 注意：预演模式下 **步骤 1–2 会真的联网**（拉 manifest、下载分片），只是不写主库；
//       不想联网可加 --skip-sync，直接对本地已有的 data/incremental/manifest 做 dry-run。
//
// 步骤顺序（与 docs/VECTOR_HYBRID_PLAN.md §5 一致）：
//   1. incremental-sync.mjs --check                    拉最新索引并算差集（只读 + 下载 manifest）
//   2. incremental-sync.mjs --download --targeted      只下载覆盖差集的档案/简历分片（断点续跑）
//   3. import-incremental.mjs [--apply]                增量导入（新增/变化/消失三态）
//   4. run-phase3-full.mjs                             解析原件补区块（新导入者自动入队）
//   5. persist-attachment-text.mjs --apply             附件正文落库（新 parsed 者）
//   6. search-vector-maintenance.mjs --formal ...       显式更新向量索引（Q4=A）
//
// 闸门：步骤 3–5 会写主库，执行前必须确认应用服务已停（否则 SQLite 会 database is locked）；
// 步骤 6 只读主库、只写向量目录，服务在跑也可以，但这里一并要求停服，行为更可预测。

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(DATA, 'recruitment.db')
const VECTOR_DIR = process.env.SEARCH_VECTOR_DIRECTORY ? resolve(process.env.SEARCH_VECTOR_DIRECTORY) : resolve(DATA, 'search-vectors')
const REPORT_PATH = resolve(DATA, 'incremental-pipeline-report.json')

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const skipSync = argv.includes('--skip-sync')
const skipParse = argv.includes('--skip-parse')
const skipVector = argv.includes('--skip-vector')
const shardsIndex = argv.indexOf('--shards')
const shards = shardsIndex >= 0 ? Number.parseInt(argv[shardsIndex + 1], 10) : 512
if (!Number.isInteger(shards) || shards < 1 || shards > 2048) throw new Error('--shards 必须在 1–2048 之间')
const profileShardsIndex = argv.indexOf('--profile-shards')
const profileShards = profileShardsIndex >= 0 ? Number.parseInt(argv[profileShardsIndex + 1], 10) : 128
if (!Number.isInteger(profileShards) || profileShards < 1 || profileShards > 2048) throw new Error('--profile-shards 必须在 1–2048 之间')
const concurrencyIndex = argv.indexOf('--concurrency')
const concurrency = concurrencyIndex >= 0 ? Number.parseInt(argv[concurrencyIndex + 1], 10) : 3
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('--concurrency 必须在 1–8 之间')

const started = Date.now()
const steps = []
const run = (label, args, { allowServiceRunning = false } = {}) => {
  if (!allowServiceRunning && serviceAlive()) {
    throw Object.assign(new Error(`步骤「${label}」要写库，但应用服务仍在运行。请先停止服务（data/service.pid 或 server/index.mjs 进程）再重跑。`), { code: 'service_running' })
  }
  const stepStarted = Date.now()
  const result = spawnSync(process.execPath, args, { cwd: ROOT, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const entry = {
    step: label, args, status: result.status, ms: Date.now() - stepStarted,
    stdout_tail: String(result.stdout ?? '').slice(-800).trim(),
    stderr_tail: String(result.stderr ?? '').slice(-400).trim()
  }
  steps.push(entry)
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))
  if (result.status !== 0) throw Object.assign(new Error(`步骤「${label}」失败（exit ${result.status}）`), { code: 'step_failed' })
  return entry
}

function serviceAlive() {
  const probe = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } | Measure-Object | Select-Object -ExpandProperty Count"
  ], { windowsHide: true, encoding: 'utf8' })
  return Number.parseInt(String(probe.stdout ?? '0').trim() || '0', 10) > 0
}

const summary = { mode: apply ? 'apply' : 'dry-run', started_at: new Date().toISOString(), steps: [] }
try {
  if (!skipSync) {
    run('check-manifest', ['scripts/incremental-sync.mjs', '--check'], { allowServiceRunning: true })
    run('download-shards', ['scripts/incremental-sync.mjs', '--download', '--targeted', '--shards', String(shards), '--profile-shards', String(profileShards), '--concurrency', String(concurrency)], { allowServiceRunning: true })
  }
  const importArgs = ['scripts/import-incremental.mjs', ...(apply ? ['--apply'] : [])]
  run('import-incremental', importArgs, { allowServiceRunning: !apply })
  if (!skipParse) {
    if (apply) run('parse-origin-sections', ['scripts/run-phase3-full.mjs'])
    else console.log(JSON.stringify({ step: 'parse-origin-sections', skipped: 'dry-run（加 --apply 才跑）' }))
    if (apply) run('persist-attachment-text', ['scripts/persist-attachment-text.mjs', '--apply'])
    else console.log(JSON.stringify({ step: 'persist-attachment-text', skipped: 'dry-run（加 --apply 才跑）' }))
  }
  if (!skipVector && apply) {
    run('vector-maintenance', ['scripts/search-vector-maintenance.mjs', '--formal', '--database', DB_PATH, '--directory', VECTOR_DIR, '--dimensions', '1024', '--concurrency', '4'])
  } else if (!skipVector) {
    console.log(JSON.stringify({ step: 'vector-maintenance', skipped: 'dry-run（加 --apply 才跑）' }))
  }
  summary.state = 'ok'
} catch (error) {
  summary.state = 'failed'
  summary.error = { code: String(error?.code ?? 'error'), message: String(error?.message ?? error).slice(0, 500) }
} finally {
  summary.elapsed_ms = Date.now() - started
  summary.steps = steps
  mkdirSync(DATA, { recursive: true })
  writeFileSync(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ...summary, steps: `${steps.length} 步（见 data/incremental-pipeline-report.json）` }, null, 1))
  if (summary.state !== 'ok') process.exitCode = 1
}
