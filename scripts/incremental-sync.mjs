#!/usr/bin/env node
// WDCloud 共享资产 → 本地工作台的增量同步。
//
//   node scripts/incremental-sync.mjs --check                    # 只比对版本与差集
//   node scripts/incremental-sync.mjs --download                 # 全量分片（简历 32 + 档案 32）
//   node scripts/incremental-sync.mjs --download --targeted      # 只拉覆盖差集的分片（简历 512 / 档案 128）
//   node scripts/incremental-sync.mjs --download --targeted --profiles-full   # 档案走全量（0.74 GB、片数少）
//   node scripts/incremental-sync.mjs --import                   # 增量写库（转调 import-incremental --apply）
//   node scripts/incremental-sync.mjs --all                      # 三步连做
//
// 链路（依据 2026-09-24 / 2026-10-08 实测）：
//   1. 触发 talent-pool-agent 的 sync.export（scope=manifest），拿到最新
//      generationId / treeHash / asset-candidates.jsonl，与本地
//      candidate_asset_index.profile_sha256 做差集（新增 / 变化 / 消失 / 无法定位）。
//      注意：官方 `applicantIds` 参数实测不会收窄导出范围（传 2 个 ID 仍返回
//      39,651 个档案），因此增量必须走「整份索引 + 差集 + 分片快照」。
//   2. 分片导出只有 shardIndex / shardCount 一个口子。线上 agent 按 applicantId
//      排序后连续切片（用下载到的 `_meta.json` 反推确认；agent.yaml 写的也是
//      applicantId，源码里那句 candidateId 与线上行为不一致），本地用同一排序
//      复算差集落在哪些片，`--targeted` 只拉这些片；不加则按全量快照拉。
//      applicantId 是随机 UUID，差集在片间基本均匀散布：片越细下载越小、任务越多。
//      档案总量只有 0.74 GB，`--profiles-full` 反而比逐人定位省任务数。
//      profiles 与 resumes 是两个独立 scope，各自分片、各自记录断点。
//   3. 分片 zip 内部路径是 candidates/<xx>/<xx>/<id>/...（档案是 profile.json，
//      简历是 resumes/standard.pdf 与 resumes/origin/origin.pdf），统一解压到
//      data/incremental/{profiles,resumes}/，import-incremental.mjs 按同一布局读取。
//
// 安全：任何写库动作都要显式传 --import；默认只做检查与下载。
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const execFileAsync = promisify(execFile)

function parseArgs(argv) {
  const options = {
    check: false,
    download: false,
    import: false,
    targeted: false,
    profilesFull: false,
    only: null,
    indexesPath: null,
    shards: null,
    profileShards: null,
    concurrency: 3,
    env: 'test'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--download') options.download = true
    else if (arg === '--import') options.import = true
    else if (arg === '--targeted') options.targeted = true
    else if (arg === '--profiles-full') options.profilesFull = true
    else if (arg === '--only') {
      index += 1
      options.only = String(argv[index] ?? '').trim().toLowerCase()
      if (!['profiles', 'resumes'].includes(options.only)) throw new Error('--only 只能是 profiles 或 resumes')
    }
    else if (arg === '--indexes') { index += 1; options.indexesPath = argv[index] }
    else if (arg === '--all') { options.check = true; options.download = true; options.import = true }
    else if (arg === '--shards') { index += 1; options.shards = Number.parseInt(argv[index], 10) }
    else if (arg === '--profile-shards') { index += 1; options.profileShards = Number.parseInt(argv[index], 10) }
    else if (arg === '--concurrency') { index += 1; options.concurrency = Number.parseInt(argv[index], 10) }
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 22).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  if (!options.check && !options.download && !options.import) options.check = true
  if (!Number.isInteger(options.shards) || options.shards < 1) options.shards = options.targeted ? 512 : 32
  if (!Number.isInteger(options.profileShards) || options.profileShards < 1) options.profileShards = options.targeted ? 128 : 32
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) options.concurrency = 3
  if (options.shards > 2048) throw new Error('--shards 不能超过 2048（agent 上限）')
  if (options.profileShards > 2048) throw new Error('--profile-shards 不能超过 2048（agent 上限）')
  return options
}

// 必须异步：同步 execFileSync 会阻塞事件循环，把并发拉成串行
// （2026-10-08 实测：12 路并发时 8 秒一次的 status 轮询把吞吐压到 ~5 片/分钟）。
async function cli(args, timeout = 300000) {
  const command = `& '${CLI}' ${args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(' ')} --json`
  const { stdout: output } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
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
  const payloadPath = resolve(WORK, `payload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  mkdirSync(WORK, { recursive: true })
  writeFileSync(payloadPath, JSON.stringify({ env: 'test', title, input }, null, 2))
  const run = await cli(['agent', 'run', AGENT_ID, '--input', payloadPath])
  const task = run.data?.taskRun ?? run.data ?? run
  const taskId = String(task.taskRunId)
  const deadline = Date.now() + timeoutMs
  let status = 'unknown'
  while (Date.now() < deadline) {
    const result = await cli(['agent', 'status', taskId])
    const current = result.data?.taskRun ?? result.data ?? result
    status = String(current.status ?? 'unknown')
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) {
      return { taskId, status, error: current.lastError ?? null }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15000))
  }
  return { taskId, status: 'timeout', error: null }
}

async function downloadArtifacts(taskId, targetDir, { only = null } = {}) {
  mkdirSync(targetDir, { recursive: true })
  const payload = await cli(['agent', 'artifacts', taskId])
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

// 分片产物是 zip（内含 candidates/<relativeDir>/...），下载后需要解压。
// 用系统自带 tar 解压（Windows 10+ 自带 bsdtar，能处理 zip），避免引入依赖。
// _meta.json 单独用 `tar -xOf` 取出存到 _meta/，避免并发解压互相覆盖。
async function extractArtifact(zipPath, targetDir, metaPath) {
  mkdirSync(targetDir, { recursive: true })
  const result = spawnSync('tar', ['-xf', zipPath, '-C', targetDir, '--exclude', '_meta.json'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`解压失败 ${zipPath}: ${String(result.stderr ?? '').slice(0, 200)}`)
  }
  const meta = spawnSync('tar', ['-xOf', zipPath, '_meta.json'], { maxBuffer: 128 * 1024 * 1024, windowsHide: true })
  if (meta.status === 0 && meta.stdout?.length) {
    mkdirSync(dirname(metaPath), { recursive: true })
    writeFileSync(metaPath, meta.stdout)
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

async function readJsonl(path) {
  const rows = []
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of reader) {
    const text = line.trim()
    if (text) rows.push(JSON.parse(text))
  }
  return rows
}

// --targeted 的分片口径：线上 agent 侧 ordered = sorted(entries, key=applicantId)，
// 分片边界 shard_bounds(total, index, count)。这里用同一排序复算位置。
// （2026-10-08 实测：用下载到的 _meta.json 抽样反推，applicantId 序命中 39/40，
//   candidateId 序命中 0/40；线上行为与 worker 源码里的 candidateId 写法不一致。）
async function computeTargetedShards({ resumeShards, profileShards }) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const localIndex = new Map(db.prepare('SELECT applicant_id AS a, profile_sha256 AS s FROM candidate_asset_index').all().map((row) => [row.a, row.s]))
  const localCandidateIds = new Set(db.prepare("SELECT source_record_id AS a FROM candidates WHERE source_system = 'beisen'").all().map((row) => String(row.a)))
  // 附件表按「北森 candidateId（= candidates.source_record_id）」对齐：
  // candidate_asset_index.candidate_id 存的是内部 UUID，不能直接拿来比对。
  const localAttachments = new Map()
  for (const row of db.prepare(`
    SELECT c.source_record_id AS candidateId, a.attachment_type AS type, a.sha256 AS sha
    FROM candidate_attachments a JOIN candidates c ON c.id = a.candidate_id
    WHERE a.attachment_type IN ('resume', 'resume_origin')
  `).all()) {
    localAttachments.set(`${row.candidateId}|${row.type}`, row.sha)
  }
  db.close()

  const rows = await readJsonl(resolve(MANIFEST_DIR, 'asset-candidates.jsonl'))
  const fileSha = new Map()
  for (const row of await readJsonl(resolve(MANIFEST_DIR, 'asset-files.jsonl'))) {
    if (row.kind !== 'resume-standard' && row.kind !== 'resume-origin') continue
    const current = fileSha.get(row.applicantId) ?? {}
    current[row.kind === 'resume-standard' ? 'standard' : 'origin'] = row.sha256
    fileSha.set(row.applicantId, current)
  }

  const ordered = [...rows].sort((a, b) => {
    const left = String(a.applicantId ?? '')
    const right = String(b.applicantId ?? '')
    return left < right ? -1 : left > right ? 1 : 0
  })
  const position = new Map(ordered.map((row, index) => [row.applicantId, index]))
  const total = ordered.length
  const shardOf = (applicantId, shardCount) => {
    const at = position.get(applicantId)
    if (at === undefined) return null
    return Math.floor((at * shardCount) / total)
  }

  const deltaApplicants = []
  for (const row of rows) {
    const applicantId = String(row.applicantId ?? '')
    const candidateId = String(row.candidateId ?? '')
    if (!applicantId || !candidateId) continue
    const known = localIndex.get(applicantId)
    if (known === undefined && !localCandidateIds.has(candidateId)) deltaApplicants.push({ applicantId, candidateId, relativeDir: row.relativeDir, kind: 'added' })
    else if (known !== undefined && known !== row.profileSha256) deltaApplicants.push({ applicantId, candidateId, relativeDir: row.relativeDir, kind: 'changed' })
  }

  const resumeApplicants = []
  for (const item of deltaApplicants) {
    const files = fileSha.get(item.applicantId) ?? {}
    const standardChanged = files.standard && localAttachments.get(`${item.candidateId}|resume`) !== files.standard
    const originChanged = files.origin && localAttachments.get(`${item.candidateId}|resume_origin`) !== files.origin
    if (standardChanged || originChanged) resumeApplicants.push(item.applicantId)
  }

  const toShards = (applicantIds, shardCount) => new Set(applicantIds.map((id) => shardOf(id, shardCount)).filter((index) => Number.isInteger(index)))
  return {
    total,
    deltaApplicants,
    resumeApplicants,
    profiles: toShards(deltaApplicants.map((item) => item.applicantId), profileShards),
    resumes: toShards(resumeApplicants, resumeShards)
  }
}

function channelDefinitions(options) {
  const channels = [
    {
      scope: 'resumes',
      dir: resolve(WORK, 'resumes'),
      statePrefix: 'resumes',
      legacyPrefix: 'origin',
      shardCount: options.shards,
      title: (index, count) => `增量同步：简历分片 ${index}/${count}`,
      input: (index, count) => ({
        mode: 'sync.export',
        scope: 'resumes',
        shardIndex: index,
        shardCount: count,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        includeOrigin: true,
        includeStandard: true
      })
    },
    {
      scope: 'profiles',
      dir: resolve(WORK, 'profiles'),
      statePrefix: 'profiles',
      legacyPrefix: null,
      shardCount: options.profileShards,
      title: (index, count) => `增量同步：档案分片 ${index}/${count}`,
      input: (index, count) => ({
        mode: 'sync.export',
        scope: 'profiles',
        shardIndex: index,
        shardCount: count,
        maxArtifactBytes: MAX_ARTIFACT_BYTES
      })
    }
  ]
  return options.only ? channels.filter((channel) => channel.scope === options.only) : channels
}

async function downloadChannel(channel, { state, summary, concurrency }) {
  const shardCount = channel.shardCount
  const pending = []
  for (const index of [...channel.indexes].sort((a, b) => a - b)) {
    const key = `${channel.statePrefix}:${index}/${shardCount}`
    if (state.downloadedShards[key]) continue
    const legacyKey = channel.legacyPrefix ? `${channel.legacyPrefix}:${index}/${shardCount}` : null
    if (legacyKey && state.downloadedShards[legacyKey]) {
      state.downloadedShards[key] = state.downloadedShards[legacyKey]
      continue
    }
    pending.push(index)
  }
  const zipDir = resolve(channel.dir, '_zips')
  const metaDir = resolve(channel.dir, '_meta')
  mkdirSync(zipDir, { recursive: true })
  mkdirSync(metaDir, { recursive: true })

  const queue = [...pending]
  let done = 0
  let failed = 0
  console.log(JSON.stringify({
    at: new Date().toISOString(), step: 'channel-start', channel: channel.scope,
    shardCount, planned: channel.indexes.size, pending: pending.length, concurrency
  }))
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1))
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const index = queue.shift()
      const key = `${channel.statePrefix}:${index}/${shardCount}`
      let lastError = null
      for (let attempt = 1; attempt <= 3 && !lastError; attempt += 1) {
        try {
          const result = await runAgentTask(channel.input(index, shardCount), { title: channel.title(index, shardCount) })
          if (result.status !== 'succeeded') throw new Error(`agent 任务 ${result.status}${result.error ? `：${result.error}` : ''}`)
          const saved = await downloadArtifacts(result.taskId, zipDir, { only: (name) => name.endsWith('.zip') })
          const zips = saved.filter((item) => item.name?.endsWith('.zip'))
          if (!zips.length) throw new Error('agent 任务没有产出 zip')
          for (const item of zips) {
            const zipPath = resolve(zipDir, item.name)
            await extractArtifact(zipPath, channel.dir, resolve(metaDir, `${item.name}.json`))
          }
          state.downloadedShards[key] = {
            taskId: result.taskId,
            at: new Date().toISOString(),
            zips: zips.length,
            attempt
          }
          saveState(state)
          done += 1
          console.log(JSON.stringify({
            at: new Date().toISOString(), step: 'download', channel: channel.scope,
            shard: index, of: shardCount, zips: zips.length, remaining: queue.length, done, failed
          }))
          break
        } catch (error) {
          lastError = error
          console.error(JSON.stringify({
            at: new Date().toISOString(), step: 'download', channel: channel.scope,
            shard: index, attempt, error: String(error?.message ?? error).slice(0, 300)
          }))
          if (attempt < 3) await new Promise((resolveSleep) => setTimeout(resolveSleep, 15000 * attempt))
        }
      }
      if (lastError) {
        failed += 1
        summary.steps.push({ step: 'download', channel: channel.scope, shard: index, status: 'failed', error: String(lastError?.message ?? lastError).slice(0, 300) })
      } else {
        summary.steps.push({ step: 'download', channel: channel.scope, shard: index, status: 'succeeded' })
      }
    }
  })
  await Promise.all(workers)

  channel.result = {
    scope: channel.scope,
    shardCount,
    planned: channel.indexes.size,
    pending: pending.length,
    done,
    failed
  }
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

// ── 2. 下载分片（profiles + resumes，可断点续跑）────────────────────────────
if (options.download) {
  const channels = channelDefinitions(options)
  if (options.indexesPath) {
    // 显式分片清单：差集已被导入消费掉时（imported_at 之后差集归零），
    // 用上一轮算好的 shardIndex 列表继续把分片拉完。
    const explicit = JSON.parse(readFileSync(resolve(ROOT, options.indexesPath), 'utf8'))
    for (const channel of channels) {
      const list = explicit[channel.scope]
      if (!Array.isArray(list)) continue
      channel.indexes = new Set(list
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value < channel.shardCount))
    }
    summary.targets = { explicitIndexes: options.indexesPath, channels: channels.map((channel) => ({ scope: channel.scope, shards: channel.indexes.size })) }
    console.log(JSON.stringify({ at: new Date().toISOString(), step: 'targets', ...summary.targets }))
  } else if (options.targeted) {
    const targets = await computeTargetedShards({ resumeShards: options.shards, profileShards: options.profileShards })
    for (const channel of channels) {
      if (channel.scope === 'profiles' && options.profilesFull) {
        channel.indexes = new Set(Array.from({ length: channel.shardCount }, (_, index) => index))
      } else {
        channel.indexes = channel.scope === 'profiles' ? targets.profiles : targets.resumes
      }
    }
    summary.targets = {
      manifestRows: targets.total,
      deltaApplicants: targets.deltaApplicants.length,
      resumeApplicants: targets.resumeApplicants.length,
      resumeShardCount: options.shards,
      resumeShards: targets.resumes.size,
      profileShardCount: options.profileShards,
      profileShards: options.profilesFull ? options.profileShards : targets.profiles.size,
      profilesFull: options.profilesFull
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), step: 'targets', ...summary.targets }))
  } else {
    for (const channel of channels) {
      channel.indexes = new Set(Array.from({ length: channel.shardCount }, (_, index) => index))
    }
  }
  for (const channel of channels) {
    await downloadChannel(channel, { state, summary, concurrency: options.concurrency })
    summary.steps.push({ step: 'download-summary', ...channel.result })
  }
  if (options.targeted && (!options.only || options.only === 'profiles')) {
    // 校验：差集候选人的 profile.json 是否都已落地（缺了说明分片口径或解压有问题）
    const targets = await computeTargetedShards({ resumeShards: options.shards, profileShards: options.profileShards })
    const missing = targets.deltaApplicants.filter((item) => !existsSync(resolve(WORK, 'profiles', String(item.relativeDir), 'profile.json')))
    summary.verify = { deltaApplicants: targets.deltaApplicants.length, profilesMissing: missing.length, examples: missing.slice(0, 5).map((item) => item.relativeDir) }
    console.log(JSON.stringify({ at: new Date().toISOString(), step: 'verify', ...summary.verify }))
  }
}

// ── 3. 增量写库（默认只提示命令，避免误写库）───────────────────────────────
if (options.import) {
  const report = spawnSync(process.execPath, ['scripts/import-incremental.mjs', '--apply'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const ok = report.status === 0
  summary.steps.push({ step: 'import', status: ok ? 'succeeded' : 'failed', output: String(report.stdout ?? '').slice(-1500) })
  if (ok) {
    state.lastImport = { at: new Date().toISOString(), output: String(report.stdout ?? '').slice(0, 2000) }
    saveState(state)
  }
}

console.log(JSON.stringify(summary, null, 1))
