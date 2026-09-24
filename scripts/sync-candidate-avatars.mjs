#!/usr/bin/env node
// 阶段 2：把标准简历 PDF 里的证件照同步到候选人头像。
//
//   node scripts/sync-candidate-avatars.mjs --limit 200          # 抽样实测，只读
//   node scripts/sync-candidate-avatars.mjs --apply --limit 20   # 小批写入
//   node scripts/sync-candidate-avatars.mjs --apply              # 全量
//
// 复用应用既有能力（server/attachment-avatar.js），不另写解析器：
//   extractPdfAvatarCandidates → selectPdfAvatarCandidate →
//   materializePrivateAttachmentAvatar → sanitizeMaterializedAttachmentAvatar
//
// 口径：只处理身份与证件区块里 IDPhoto 有值的候选人。
// 实测依据：无 IDPhoto 标记的档案里，standard.pdf 内嵌的是一张固定的
// 160x160 默认剪影占位图（全库同一 sha256），不是真人照片，必须排除。
//
// 写入内容（仅 --apply）：一条 attachment_type='avatar' 的附件行 +
// candidates.photo_url='attachment-avatar:<附件ID>'。全程本地，不出网。
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractPdfAvatarCandidates,
  selectPdfAvatarCandidate,
  projectAttachmentAvatarSuggestion,
  materializePrivateAttachmentAvatar,
  sanitizeMaterializedAttachmentAvatar,
  releasePrivateAttachmentAvatar
} from '../server/attachment-avatar.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB_PATH = resolve(ROOT, 'data', 'recruitment.db')
const DEFAULT_FILES_ROOT = resolve(ROOT, 'data', 'private', 'attachments', 'files')
// 附件表单里头像行的 parser_version；沿用应用既有取值，避免前端把导入头像
// 当成未知解析器产物。
const AVATAR_PARSER_VERSION = 'attachment-avatar-v1'

function parseArgs(argv) {
  const options = {
    dbPath: process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULT_DB_PATH,
    filesRoot: process.env.ATTACHMENT_FILES_ROOT ? resolve(process.env.ATTACHMENT_FILES_ROOT) : DEFAULT_FILES_ROOT,
    apply: false,
    limit: null,
    random: false,
    includeUnmarked: false,
    concurrency: 4,
    seed: 'phase2-avatar',
    verbose: false,
    samples: 0
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`缺少参数值：${arg}`)
      return argv[index]
    }
    if (arg === '--apply') options.apply = true
    else if (arg === '--db') options.dbPath = resolve(next())
    else if (arg === '--files-root') options.filesRoot = resolve(next())
    else if (arg === '--limit') options.limit = Number.parseInt(next(), 10)
    else if (arg === '--concurrency') options.concurrency = Number.parseInt(next(), 10)
    else if (arg === '--seed') options.seed = next()
    else if (arg === '--samples') options.samples = Number.parseInt(next(), 10)
    else if (arg === '--random') options.random = true
    else if (arg === '--include-unmarked') options.includeUnmarked = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8')
        .split('\n').slice(0, 17).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error('--concurrency 必须在 1..16 之间')
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit 必须是正整数')
  }
  if (options.random && options.limit === null) {
    throw new Error('--random 必须与 --limit 一起使用')
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const startedAt = Date.now()

const db = new DatabaseSync(options.dbPath)
db.exec('PRAGMA busy_timeout = 15000')

function normalizeStoredPath(path) {
  return resolve(path)
}

mkdirSync(options.filesRoot, { recursive: true })

const IDPHOTO_FILTER = `
  EXISTS (
    SELECT 1 FROM json_each(json_extract(s.raw_payload, '$.personProfile')) AS field
    WHERE json_extract(field.value, '$.name') = 'IDPhoto'
      AND trim(coalesce(json_extract(field.value, '$.value'), '')) <> ''
  )
`

const idPhotoWanted = options.includeUnmarked ? 0 : 1

function selectTraversalRows() {
  // 抽样走子查询：先选出候选集再取明细，避免把 3.6 万行的 raw_payload 全拉进内存。
  const poolSelect = `
    SELECT s.candidate_id AS candidate_id, s.raw_payload AS raw_payload,
           a.id AS resume_attachment_id, a.storage_path AS storage_path, a.file_size AS file_size
    FROM candidate_source_records s
    JOIN candidate_attachments a
      ON a.candidate_id = s.candidate_id AND a.attachment_type = 'resume'
    JOIN candidates c ON c.id = s.candidate_id
    WHERE s.record_type = 'talent_profile'
      AND COALESCE(c.photo_url, '') = ''
      AND NOT EXISTS (
        SELECT 1 FROM candidate_attachments avatar
        WHERE avatar.candidate_id = s.candidate_id AND avatar.attachment_type = 'avatar'
      )
      AND COALESCE(c.archived_at, '') = ''
      AND (${IDPHOTO_FILTER}) = ?
  `
  const detailSelect = `
    SELECT a.id AS resume_attachment_id, a.candidate_id, c.name AS candidate_name,
           a.storage_path, a.file_size, s.raw_payload
    FROM candidate_source_records s
    JOIN candidate_attachments a
      ON a.candidate_id = s.candidate_id AND a.attachment_type = 'resume'
    JOIN candidates c ON c.id = s.candidate_id
    WHERE s.record_type = 'talent_profile'
      AND COALESCE(c.photo_url, '') = ''
      AND NOT EXISTS (
        SELECT 1 FROM candidate_attachments avatar
        WHERE avatar.candidate_id = s.candidate_id AND avatar.attachment_type = 'avatar'
      )
      AND COALESCE(c.archived_at, '') = ''
      AND (${IDPHOTO_FILTER}) = ?
  `
  if (!options.limit) {
    return db.prepare(`${detailSelect} ORDER BY s.candidate_id`).all(idPhotoWanted)
  }
  if (options.random) {
    return db.prepare(`
      WITH pool AS (${poolSelect}),
           ranked AS (
             SELECT candidate_id,
                    ROW_NUMBER() OVER (ORDER BY (candidate_id || ?)) AS rank
             FROM pool
           )
      SELECT detail.id AS resume_attachment_id, detail.candidate_id, detail.name AS candidate_name,
             detail.storage_path, detail.file_size, detail.raw_payload
      FROM ranked
      JOIN (
        SELECT c.id AS candidate_id, c.name AS name, a.id AS id, a.storage_path AS storage_path,
               a.file_size AS file_size, s.raw_payload AS raw_payload
        FROM candidate_source_records s
        JOIN candidate_attachments a
          ON a.candidate_id = s.candidate_id AND a.attachment_type = 'resume'
        JOIN candidates c ON c.id = s.candidate_id
        WHERE s.record_type = 'talent_profile'
      ) detail ON detail.candidate_id = ranked.candidate_id
      WHERE ranked.rank <= ?
      ORDER BY detail.candidate_id
    `).all(idPhotoWanted, options.seed, options.limit)
  }
  return db.prepare(`${detailSelect} ORDER BY s.candidate_id LIMIT ?`).all(idPhotoWanted, options.limit)
}

const rows = selectTraversalRows()

const insertAttachment = db.prepare(`
  INSERT INTO candidate_attachments(
    id, candidate_id, original_filename, storage_path, mime_type, file_size, sha256,
    attachment_type, parse_status, parser_version, extracted_text, source, import_batch_id,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'avatar', 'parsed', ?, '', 'avatar_sync', NULL, ?, ?)
`)
const updatePhotoUrl = db.prepare(`
  UPDATE candidates SET photo_url = ?, updated_at = ?
  WHERE id = ? AND COALESCE(photo_url, '') = ''
`)
const BATCH_SIZE = 250
let pendingBatch = []

function flushBatch() {
  if (!pendingBatch.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const item of pendingBatch) {
      insertAttachment.run(
        item.avatarId,
        item.candidateId,
        `attachment-avatar.${item.extension}`,
        item.target,
        item.contentType,
        item.byteLength,
        item.sha256,
        AVATAR_PARSER_VERSION,
        item.timestamp,
        item.timestamp
      )
      const update = updatePhotoUrl.run(`attachment-avatar:${item.avatarId}`, item.timestamp, item.candidateId)
      if (!Number(update.changes)) {
        throw Object.assign(new Error('photo_url_occupied'), { code: 'photo_url_occupied' })
      }
      writeFileSync(item.target, item.buffer, { flag: 'wx' })
    }
    db.exec('COMMIT')
    stats.stored += pendingBatch.length
    stats.bytesWritten += pendingBatch.reduce((sum, item) => sum + item.byteLength, 0)
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    const code = String(error?.code ?? error?.message ?? 'unknown_error')
    if (code === 'photo_url_occupied') stats.conflict += pendingBatch.length
    else if (code.includes('UNIQUE')) stats.duplicate += pendingBatch.length
    else if (code.includes('CHECK')) stats.oversized += pendingBatch.length
    else { stats.error += pendingBatch.length; bump(errorCounts, code) }
    for (const item of pendingBatch) {
      if (existsSync(item.target)) {
        try { unlinkSync(item.target) } catch {}
      }
    }
    pendingBatch = []
    throw error
  }
  pendingBatch = []
}

const PLACEHOLDER_HASHES = new Set(
  String(process.env.AVATAR_PLACEHOLDER_SHA256 ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
)

const stats = {
  candidates: rows.length,
  ready: 0,
  stored: 0,
  ambiguous: 0,
  none: 0,
  placeholder: 0,
  oversized: 0,
  duplicate: 0,
  conflict: 0,
  error: 0,
  bytesWritten: 0
}
const errorCounts = new Map()
const notReadyReasons = new Map()
const storedHashes = new Map()
const sampleRecords = []

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

async function extractOne(row) {
  const outcome = { row, avatar: null, status: 'none', reason: null }
  let references = []
  try {
    const buffer = readFileSync(row.storage_path)
    references = await extractPdfAvatarCandidates(buffer)
    const selected = selectPdfAvatarCandidate(references)
    const projection = projectAttachmentAvatarSuggestion(selected)
    outcome.status = projection.status
    if (projection.status === 'ambiguous') {
      outcome.reason = `ambiguous:${projection.eligible_candidate_count ?? references.length}`
      return outcome
    }
    if (projection.status !== 'ready') {
      outcome.reason = references.length
        ? `ineligible_below_minimum:${references[0].width}x${references[0].height}`
        : 'no_embedded_image'
      return outcome
    }
    const materialized = materializePrivateAttachmentAvatar(selected.reference)
    const sanitized = sanitizeMaterializedAttachmentAvatar(materialized)
    if (PLACEHOLDER_HASHES.has(sanitized.sha256)) {
      outcome.status = 'placeholder'
      outcome.reason = 'known_template_placeholder'
      return outcome
    }
    outcome.avatar = {
      buffer: sanitized.buffer,
      content_type: sanitized.content_type,
      extension: sanitized.extension,
      width: sanitized.width,
      height: sanitized.height,
      sha256: sanitized.sha256,
      byte_length: sanitized.byte_length
    }
    return outcome
  } catch (error) {
    outcome.status = 'error'
    outcome.reason = error?.code ?? error?.message ?? 'unknown_error'
    return outcome
  } finally {
    for (const reference of references) {
      // 释放 pdfjs 解码出来的私有像素缓冲，避免并发下堆积。
      releasePrivateAttachmentAvatar(reference)
    }
  }
}

async function processRow(row) {
  const outcome = await extractOne(row)
  const target = outcome.avatar ? join(options.filesRoot, `${randomUUID()}.${outcome.avatar.extension}`) : null
  if (outcome.status === 'ready') stats.ready += 1
  else if (outcome.status === 'ambiguous') stats.ambiguous += 1
  else if (outcome.status === 'placeholder') stats.placeholder += 1
  else if (outcome.status === 'error') { stats.error += 1; bump(errorCounts, outcome.reason) }
  else { stats.none += 1; bump(notReadyReasons, outcome.reason) }
  if (outcome.avatar) {
    const key = outcome.avatar.sha256
    if (!storedHashes.has(key)) storedHashes.set(key, [])
    if (storedHashes.get(key).length < 5) storedHashes.get(key).push(row.candidate_name)
  }

  if (!options.apply || !outcome.avatar) {
    if (options.samples > 0 && sampleRecords.length < options.samples) {
      sampleRecords.push(describeSample(row, outcome, null))
    }
    return outcome
  }

  const item = {
    avatarId: randomUUID(),
    candidateId: row.candidate_id,
    extension: outcome.avatar.extension,
    target,
    contentType: outcome.avatar.content_type,
    byteLength: outcome.avatar.byte_length,
    sha256: outcome.avatar.sha256,
    buffer: outcome.avatar.buffer,
    timestamp: new Date().toISOString()
  }
  pendingBatch.push(item)
  if (pendingBatch.length >= BATCH_SIZE) flushBatch()
  if (options.samples > 0 && sampleRecords.length < options.samples) {
    sampleRecords.push(describeSample(row, outcome, item.avatarId))
  }
  return outcome
}

function describeSample(row, outcome, avatarId) {
  return {
    candidate_id: row.candidate_id,
    name: row.candidate_name,
    status: outcome.status,
    reason: outcome.reason ?? null,
    avatar_id: avatarId ?? null,
    dimensions: outcome.avatar ? `${outcome.avatar.width}x${outcome.avatar.height}` : null,
    bytes: outcome.avatar ? outcome.avatar.byte_length : null,
    sha256: outcome.avatar ? outcome.avatar.sha256 : null,
    id_photo: readIdPhoto(row.raw_payload).slice(0, 160)
  }
}

function readIdPhoto(rawPayload) {
  try {
    const fields = JSON.parse(rawPayload)?.personProfile
    if (!Array.isArray(fields)) return ''
    const entry = fields.find((field) => field?.name === 'IDPhoto')
    return typeof entry?.value === 'string' ? entry.value : ''
  } catch {
    return ''
  }
}

let cursor = 0
let completed = 0
let lastProgressAt = 0
async function worker() {
  while (cursor < rows.length) {
    const index = cursor
    cursor += 1
    const row = rows[index]
    await processRow(row)
    completed += 1
    if (completed % 250 === 0 || Date.now() - lastProgressAt > 30_000) {
      lastProgressAt = Date.now()
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000)
      const memoryMb = Math.round(process.memoryUsage().rss / 1048576)
      console.log(`[avatar] ${completed}/${rows.length} 已处理，可提取 ${stats.ready}，已落库 ${stats.stored}，` +
        `${(completed / elapsedSeconds).toFixed(1)} 份/秒，RSS ${memoryMb}MB`)
    }
  }
}

await Promise.all(Array.from({ length: options.concurrency }, () => worker()))
if (options.apply) flushBatch()

const elapsedMs = Date.now() - startedAt
const summary = {
  mode: options.apply ? 'apply' : 'dry-run',
  scope: options.includeUnmarked ? 'unmarked' : 'idphoto-marked',
  sampling: options.random ? `random(seed=${options.seed})` : (options.limit ? 'first-n' : 'full'),
  candidates: stats.candidates,
  stored: stats.stored,
  ready: stats.ready,
  ambiguous: stats.ambiguous,
  none: stats.none,
  placeholder: stats.placeholder,
  duplicate: stats.duplicate,
  conflict: stats.conflict,
  oversized: stats.oversized,
  error: stats.error,
  errorReasons: Object.fromEntries([...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
  notReadyReasons: Object.fromEntries([...notReadyReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
  distinctImageHashes: storedHashes.size,
  repeatedImageGroups: [...storedHashes.values()].filter((names) => names.length > 1).length,
  bytesWritten: stats.bytesWritten,
  elapsedMs,
  docsPerSecond: Number((stats.candidates / Math.max(0.001, elapsedMs / 1000)).toFixed(2)),
  samples: sampleRecords
}

const checkpointPath = resolve(ROOT, 'data', 'avatar-sync-last-run.json')
writeFileSync(checkpointPath, `${JSON.stringify(summary, null, 2)}\n`)

db.close()
console.log(JSON.stringify({ ...summary, samples: sampleRecords.length, checkpoint: checkpointPath }, null, 1))
