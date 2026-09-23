import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { sanitizeOriginalFilename } from './attachment-parser.js'
import { extractSecureZip, SECURE_ZIP_LIMITS } from './secure-zip.js'

const FINAL_ITEM_STATUSES = new Set(['confirmed', 'failed', 'skipped', 'cancelled'])
const RETRYABLE_ITEM_ERRORS = new Set([
  'attachment_parse_failed',
  'parse_interrupted',
  'parse_timeout',
  'parser_unavailable',
  'attachment_service_closing'
])

export const ATTACHMENT_BATCH_LIMITS = Object.freeze({
  maxUploadFiles: 100,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxBatchUploadBytes: 256 * 1024 * 1024,
  maxExtractedFiles: 256,
  maxExtractedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
  processingConcurrency: 2,
  maxIdempotencyKeyLength: 300,
  minBatchTokenLength: 16,
  maxBatchTokenLength: 512
})

export const ATTACHMENT_BATCH_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS attachment_import_batches (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
    idempotency_key TEXT,
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
    requested_candidate_id TEXT,
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'processing', 'awaiting_confirmation', 'completed',
      'completed_with_errors', 'failed', 'cancelled'
    )),
    phase TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
    source_file_count INTEGER NOT NULL DEFAULT 0 CHECK(source_file_count >= 0),
    total_items INTEGER NOT NULL DEFAULT 0 CHECK(total_items >= 0),
    confirmed_items INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_items >= 0),
    failed_items INTEGER NOT NULL DEFAULT 0 CHECK(failed_items >= 0),
    skipped_items INTEGER NOT NULL DEFAULT 0 CHECK(skipped_items >= 0),
    cancelled_items INTEGER NOT NULL DEFAULT 0 CHECK(cancelled_items >= 0),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(requested_candidate_id) REFERENCES candidates(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS attachment_import_batches_idempotency_idx
    ON attachment_import_batches(idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
  CREATE INDEX IF NOT EXISTS attachment_import_batches_status_idx
    ON attachment_import_batches(status, updated_at, id);

  CREATE TABLE IF NOT EXISTS attachment_import_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    parent_item_id TEXT,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    item_kind TEXT NOT NULL CHECK(item_kind IN ('file', 'archive', 'archive_entry')),
    archive_path TEXT,
    original_filename TEXT NOT NULL,
    staging_path TEXT,
    mime_type TEXT,
    file_size INTEGER CHECK(file_size IS NULL OR file_size >= 0),
    sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
    format TEXT,
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'extracting', 'identifying', 'parsing', 'matching',
      'awaiting_confirmation', 'confirmed', 'failed', 'skipped', 'cancelled'
    )),
    phase TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    heartbeat_at TEXT,
    preview_id TEXT,
    deduplicated_item_id TEXT,
    error_code TEXT,
    error_message TEXT,
    retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
    confirmation_idempotency_key TEXT,
    confirmation_fingerprint TEXT,
    confirmation_result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(batch_id) REFERENCES attachment_import_batches(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_item_id) REFERENCES attachment_import_items(id) ON DELETE SET NULL,
    FOREIGN KEY(preview_id) REFERENCES attachment_update_previews(id) ON DELETE SET NULL,
    FOREIGN KEY(deduplicated_item_id) REFERENCES attachment_import_items(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS attachment_import_items_batch_idx
    ON attachment_import_items(batch_id, ordinal, id);
  CREATE INDEX IF NOT EXISTS attachment_import_items_work_idx
    ON attachment_import_items(status, updated_at, id);
  CREATE INDEX IF NOT EXISTS attachment_import_items_preview_idx
    ON attachment_import_items(preview_id) WHERE preview_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS attachment_import_items_hash_idx
    ON attachment_import_items(batch_id, sha256) WHERE sha256 IS NOT NULL;
`

export function migrateAttachmentBatchDatabase(db) {
  if (!db?.exec) throw new TypeError('db is required')
  db.exec(ATTACHMENT_BATCH_MIGRATION_SQL)
}

export function attachmentBatchError(status, code, message, details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function nowIso(clock) {
  return new Date(clock()).toISOString()
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function safeHashEqual(left, right) {
  try {
    const leftBytes = Buffer.from(left, 'hex')
    const rightBytes = Buffer.from(right, 'hex')
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
  } catch {
    return false
  }
}

function cleanText(value, maximum) {
  if (value === null || value === undefined) return null
  const text = String(value).replaceAll('\0', '').trim()
  return text ? text.slice(0, maximum) : null
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex')
}

function safePathWithin(root, candidatePath) {
  const rootPath = resolve(root)
  const path = resolve(candidatePath)
  const child = relative(rootPath, path)
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    throw attachmentBatchError(500, 'unsafe_storage_path', 'Attachment batch path is outside controlled storage')
  }
  return path
}

function normalizeMime(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream'
}

function inferredMime(filename) {
  switch (extname(filename).toLowerCase()) {
    case '.pdf': return 'application/pdf'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xlsm': return 'application/vnd.ms-excel.sheet.macroenabled.12'
    case '.xls': return 'application/vnd.ms-excel'
    case '.csv': return 'text/csv'
    case '.txt': return 'text/plain'
    case '.zip': return 'application/zip'
    default: return 'application/octet-stream'
  }
}

export function isTopLevelAttachmentArchive(filename, mimeType) {
  const extension = extname(filename).toLowerCase()
  if (['.docx', '.xlsx', '.xlsm'].includes(extension)) return false
  return extension === '.zip' || normalizeMime(mimeType) === 'application/zip'
}

function nestedArchiveKind(filename, buffer) {
  const extension = extname(filename).toLowerCase()
  const office = new Set(['.docx', '.xlsx', '.xlsm'])
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'].includes(extension)) return extension.slice(1)
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50 && !office.has(extension)) return 'zip'
  if (buffer.length >= 6 && buffer.subarray(0, 6).equals(Buffer.from('377abcaf271c', 'hex'))) return '7z'
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'Rar!') return 'rar'
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gzip'
  return null
}

function publicError(error) {
  const code = cleanText(error?.code, 200) ?? 'attachment_batch_processing_failed'
  const message = cleanText(error?.message, 1000) ?? 'Attachment batch processing failed'
  return {
    code,
    message,
    retryable: RETRYABLE_ITEM_ERRORS.has(code) || error?.retryable === true
  }
}

function serializedFile(row) {
  if (!row.sha256 && row.file_size == null && !row.mime_type && !row.format) return undefined
  return {
    mime_type: row.mime_type,
    file_size: row.file_size == null ? null : Number(row.file_size),
    sha256: row.sha256,
    format: row.format
  }
}

function displayArchivePath(value) {
  if (!value) return undefined
  return String(value)
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => sanitizeOriginalFilename(segment))
    .join('/')
}

function itemError(row) {
  return row.error_code ? {
    code: row.error_code,
    message: row.error_message,
    retryable: Boolean(row.retryable)
  } : undefined
}

function batchSummary(row) {
  return {
    total: Number(row.total_items),
    queued: Number(row.queued_items ?? 0),
    extracting: Number(row.extracting_items ?? 0),
    identifying: Number(row.identifying_items ?? 0),
    parsing: Number(row.parsing_items ?? 0),
    matching: Number(row.matching_items ?? 0),
    awaiting_confirmation: Number(row.awaiting_confirmation_items ?? 0),
    confirmed: Number(row.confirmed_items),
    failed: Number(row.failed_items),
    skipped: Number(row.skipped_items),
    cancelled: Number(row.cancelled_items)
  }
}

function statusCounts(db, batchId) {
  const counts = Object.fromEntries(db.prepare(`
    SELECT status, count(*) AS count FROM attachment_import_items
    WHERE batch_id = ? GROUP BY status
  `).all(batchId).map((row) => [row.status, Number(row.count)]))
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return { counts, total }
}

function computeBatchState(batch, counts, total) {
  const count = (status) => counts[status] ?? 0
  const active = ['queued', 'extracting', 'identifying', 'parsing', 'matching'].reduce((sum, status) => sum + count(status), 0)
  const awaiting = count('awaiting_confirmation')
  const confirmed = count('confirmed')
  const failed = count('failed')
  const skipped = count('skipped')
  const cancelled = count('cancelled')
  let status = 'queued'
  if (batch.cancel_requested && active === 0 && awaiting === 0) status = 'cancelled'
  else if (active > 0) status = 'processing'
  else if (awaiting > 0) status = 'awaiting_confirmation'
  else if (total === 0) status = 'failed'
  else if (confirmed > 0 && failed + skipped + cancelled === 0) status = 'completed'
  else if (confirmed > 0 || skipped > 0) status = 'completed_with_errors'
  else if (failed > 0) status = 'failed'
  else if (cancelled > 0) status = 'cancelled'
  const terminal = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status)
  const progressUnits =
    count('extracting') * 0.2 + count('identifying') * 0.35 + count('parsing') * 0.65 +
    count('matching') * 0.85 + awaiting * 0.9 + (confirmed + failed + skipped + cancelled)
  return {
    status,
    phase: status,
    progress: total ? Math.min(1, progressUnits / total) : 0,
    terminal,
    counts: { total, confirmed, failed, skipped, cancelled }
  }
}

export function createAttachmentBatchService({
  db,
  attachmentService,
  rootDir,
  clock = Date.now,
  limits: suppliedLimits = {},
  processingConcurrency
} = {}) {
  if (!db) throw new TypeError('db is required')
  if (!attachmentService?.createPreview || !attachmentService?.confirmPreviewForBatch) {
    throw new TypeError('attachmentService with batch confirmation support is required')
  }
  migrateAttachmentBatchDatabase(db)
  const limits = { ...ATTACHMENT_BATCH_LIMITS, ...suppliedLimits }
  const concurrency = processingConcurrency ?? limits.processingConcurrency
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TypeError('processingConcurrency must be between 1 and 8')
  }
  const attachmentRoot = resolve(attachmentService.root)
  const root = resolve(rootDir ?? attachmentRoot, rootDir ? '' : 'batches')
  const relativeRoot = relative(attachmentRoot, root)
  if (root === attachmentRoot || isAbsolute(relativeRoot) || relativeRoot === '..' || relativeRoot.startsWith(`..${sep}`)) {
    throw new TypeError('attachment batch root must be a child of attachmentService.root')
  }
  const incomingRoot = resolve(root, 'incoming')
  const extractedRoot = resolve(root, 'extracted')
  mkdirSync(incomingRoot, { recursive: true })
  mkdirSync(extractedRoot, { recursive: true })

  const queuedIds = []
  const jobs = new Map()
  const idleWaiters = new Set()
  let activeJobs = 0
  let closing = false

  const readBatch = (id) => db.prepare('SELECT * FROM attachment_import_batches WHERE id = ?').get(id)
  const readItem = (id) => db.prepare('SELECT * FROM attachment_import_items WHERE id = ?').get(id)

  const assertAccess = (batchId, batchToken) => {
    const batch = readBatch(batchId)
    if (!batch) throw attachmentBatchError(404, 'attachment_batch_not_found', 'Attachment batch was not found')
    const supplied = typeof batchToken === 'string' ? tokenHash(batchToken) : ''
    if (!supplied || !safeHashEqual(supplied, batch.token_hash)) {
      throw attachmentBatchError(403, 'attachment_batch_token_invalid', 'Attachment batch token is invalid')
    }
    return batch
  }

  const refreshBatch = (batchId) => {
    const batch = readBatch(batchId)
    if (!batch) return null
    const { counts, total } = statusCounts(db, batchId)
    const state = computeBatchState(batch, counts, total)
    const timestamp = nowIso(clock)
    db.prepare(`
      UPDATE attachment_import_batches SET
        status = ?, phase = ?, progress = ?, total_items = ?, confirmed_items = ?,
        failed_items = ?, skipped_items = ?, cancelled_items = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 1 THEN coalesce(completed_at, ?) ELSE NULL END
      WHERE id = ?
    `).run(
      state.status, state.phase, state.progress, state.counts.total, state.counts.confirmed,
      state.counts.failed, state.counts.skipped, state.counts.cancelled, timestamp,
      state.terminal ? 1 : 0, timestamp, batchId
    )
    return readBatch(batchId)
  }

  const serializeItem = (row) => {
    let preview
    if (row.preview_id && ['parsing', 'matching', 'awaiting_confirmation'].includes(row.status)) {
      try {
        const internalPreview = attachmentService.getPreview(row.preview_id)
        preview = {
          ...internalPreview,
          preview_token: '',
          preview_token_reissued: false
        }
      } catch {}
    }
    return {
      item_id: row.id,
      batch_id: row.batch_id,
      parent_item_id: row.parent_item_id ?? undefined,
      kind: row.item_kind,
      ordinal: Number(row.ordinal),
      original_filename: sanitizeOriginalFilename(row.original_filename),
      archive_path: displayArchivePath(row.archive_path),
      status: row.status,
      phase: row.phase,
      progress: Number(row.progress),
      attempts: Number(row.attempts),
      file: serializedFile(row),
      preview_id: row.preview_id ?? undefined,
      preview,
      deduplicated_item_id: row.deduplicated_item_id ?? undefined,
      error: itemError(row),
      confirmation: parseJson(row.confirmation_result_json, undefined),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at ?? undefined
    }
  }

  const serializeBatch = (batch, { batchToken, includeItems = true } = {}) => {
    const counts = Object.fromEntries(db.prepare(`
      SELECT status, count(*) AS count FROM attachment_import_items
      WHERE batch_id = ? GROUP BY status
    `).all(batch.id).map((row) => [`${row.status}_items`, Number(row.count)]))
    const current = { ...batch, ...counts }
    const body = {
      batch_id: current.id,
      status: current.status,
      phase: current.phase,
      progress: Number(current.progress),
      poll_after_ms: ['queued', 'processing'].includes(current.status) ? 500 : undefined,
      summary: batchSummary(current),
      created_at: current.created_at,
      updated_at: current.updated_at,
      completed_at: current.completed_at ?? undefined
    }
    if (batchToken) body.batch_token = batchToken
    if (includeItems) {
      body.items = db.prepare(`
        SELECT * FROM attachment_import_items WHERE batch_id = ? ORDER BY ordinal, id
      `).all(current.id).map(serializeItem)
    }
    return body
  }

  const enqueueCleanupInTransaction = (path, reason, timestamp) => {
    if (!path) return
    safePathWithin(attachmentRoot, path)
    attachmentService.enqueueCleanup(path, reason, timestamp)
  }

  const processCleanup = () => {
    try { attachmentService.processCleanupJobs({ limit: 100 }) } catch {}
  }

  const markFailed = (itemId, error) => {
    const item = readItem(itemId)
    if (!item || FINAL_ITEM_STATUSES.has(item.status)) return
    const batch = readBatch(item.batch_id)
    if (!batch || batch.cancel_requested || closing && error?.name === 'AbortError') return
    const failure = publicError(error)
    const timestamp = nowIso(clock)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!failure.retryable) enqueueCleanupInTransaction(item.staging_path, 'attachment_batch_item_failed', timestamp)
      db.prepare(`
        UPDATE attachment_import_items SET status = 'failed', phase = 'failed', progress = 1,
          staging_path = CASE WHEN ? = 1 THEN staging_path ELSE NULL END,
          error_code = ?, error_message = ?, retryable = ?, heartbeat_at = ?,
          updated_at = ?, completed_at = ? WHERE id = ?
      `).run(
        failure.retryable ? 1 : 0, failure.code, failure.message, failure.retryable ? 1 : 0,
        timestamp, timestamp, timestamp, itemId
      )
      db.exec('COMMIT')
    } catch (transactionError) {
      try { db.exec('ROLLBACK') } catch {}
      throw transactionError
    }
    processCleanup()
    refreshBatch(item.batch_id)
  }

  const updateItemPhase = (id, status, progress) => {
    const timestamp = nowIso(clock)
    db.prepare(`
      UPDATE attachment_import_items SET status = ?, phase = ?, progress = ?,
        heartbeat_at = ?, updated_at = ? WHERE id = ?
    `).run(status, status, progress, timestamp, timestamp, id)
  }

  const monitorPreview = async (item) => {
    let preview = attachmentService.getPreview(item.preview_id)
    if (preview.status === 'parsing') preview = await attachmentService.waitForPreview(item.preview_id)
    const current = readItem(item.id)
    if (!current || FINAL_ITEM_STATUSES.has(current.status)) return
    if (preview.status === 'ready') {
      updateItemPhase(item.id, 'matching', 0.85)
      const timestamp = nowIso(clock)
      db.prepare(`
        UPDATE attachment_import_items SET status = 'awaiting_confirmation',
          phase = 'awaiting_confirmation', progress = 0.9, error_code = NULL,
          error_message = NULL, retryable = 0, heartbeat_at = ?, updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, item.id)
    } else if (preview.status === 'failed') {
      const error = attachmentBatchError(
        preview.retryable ? 503 : 422,
        preview.error_code ?? 'attachment_parse_failed',
        preview.error ?? 'Attachment parsing failed'
      )
      error.retryable = Boolean(preview.retryable)
      markFailed(item.id, error)
    } else if (['cancelled', 'expired'].includes(preview.status)) {
      markFailed(item.id, attachmentBatchError(409, `attachment_preview_${preview.status}`, `Attachment preview is ${preview.status}`))
    }
    refreshBatch(item.batch_id)
  }

  const processFileItem = async (item, signal) => {
    if (item.preview_id) {
      await monitorPreview(item)
      return
    }
    updateItemPhase(item.id, 'identifying', 0.25)
    const path = safePathWithin(root, item.staging_path)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw attachmentBatchError(422, 'attachment_staging_invalid', 'Attachment staging file is not a regular file')
    }
    if (signal.aborted) throw signal.reason
    const buffer = await readFile(path)
    if (
      buffer.length !== Number(item.file_size) ||
      createHash('sha256').update(buffer).digest('hex') !== item.sha256
    ) {
      throw attachmentBatchError(422, 'attachment_staging_invalid', 'Attachment staging file failed size or hash verification')
    }
    if (item.item_kind === 'archive_entry') {
      const archiveKind = nestedArchiveKind(item.original_filename, buffer)
      if (archiveKind) {
        throw attachmentBatchError(
          415,
          'nested_archive_unsupported',
          `Nested ${archiveKind.toUpperCase()} archives are not supported; DOCX/XLSX/XLSM Office containers remain supported`
        )
      }
    }
    const batch = readBatch(item.batch_id)
    if (!batch || batch.cancel_requested || signal.aborted) throw attachmentBatchError(409, 'attachment_batch_cancelled', 'Attachment batch was cancelled')
    const preview = attachmentService.createPreview({
      file: {
        originalname: item.original_filename,
        mimetype: item.mime_type || inferredMime(item.original_filename),
        buffer
      },
      requestedCandidateId: batch.requested_candidate_id
    })
    const timestamp = nowIso(clock)
    db.prepare(`
      UPDATE attachment_import_items SET preview_id = ?, status = 'parsing', phase = 'parsing',
        progress = 0.55, mime_type = ?, file_size = ?, sha256 = ?, format = ?,
        heartbeat_at = ?, updated_at = ? WHERE id = ?
    `).run(
      preview.preview_id, preview.file.mime_type, preview.file.file_size, preview.file.sha256,
      preview.file.format, timestamp, timestamp, item.id
    )
    await monitorPreview(readItem(item.id))
  }

  const nextOrdinal = (batchId) => Number(db.prepare(`
    SELECT coalesce(max(ordinal), -1) + 1 AS ordinal FROM attachment_import_items WHERE batch_id = ?
  `).get(batchId).ordinal)

  const processArchiveItem = async (item, signal) => {
    updateItemPhase(item.id, 'extracting', 0.1)
    const path = safePathWithin(root, item.staging_path)
    const result = await extractSecureZip(path, extractedRoot, {
      signal,
      limits: {
        ...SECURE_ZIP_LIMITS,
        maxArchiveBytes: limits.maxArchiveBytes,
        maxEntries: limits.maxExtractedFiles,
        maxEntryUncompressedBytes: limits.maxAttachmentBytes,
        maxUncompressedBytes: limits.maxExtractedBytes,
        maxCompressionRatio: limits.maxCompressionRatio
      },
      onProgress: ({ progress }) => {
        const timestamp = nowIso(clock)
        db.prepare(`
          UPDATE attachment_import_items SET progress = ?, heartbeat_at = ?, updated_at = ?
          WHERE id = ? AND status = 'extracting'
        `).run(0.1 + progress * 0.7, timestamp, timestamp, item.id)
      }
    })
    if (result.file_count < 1) throw attachmentBatchError(422, 'zip_empty', 'ZIP archive contains no files')
    const timestamp = nowIso(clock)
    const queuedChildren = []
    let ordinal = nextOrdinal(item.batch_id)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of result.entries) {
        const duplicate = db.prepare(`
          SELECT id FROM attachment_import_items
          WHERE batch_id = ? AND sha256 = ? AND item_kind <> 'archive'
            AND status <> 'cancelled' ORDER BY ordinal, id LIMIT 1
        `).get(item.batch_id, entry.sha256)
        const childId = randomUUID()
        const childStatus = duplicate ? 'skipped' : 'queued'
        const childPath = safePathWithin(root, entry.output_path)
        db.prepare(`
          INSERT INTO attachment_import_items(
            id, batch_id, parent_item_id, ordinal, item_kind, archive_path,
            original_filename, staging_path, mime_type, file_size, sha256, format,
            status, phase, progress, attempts, heartbeat_at, preview_id,
            deduplicated_item_id, error_code, error_message, retryable,
            confirmation_idempotency_key, confirmation_fingerprint,
            confirmation_result_json, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, 'archive_entry', ?, ?, ?, ?, ?, ?, NULL,
            ?, ?, ?, 0, NULL, NULL, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?)
        `).run(
          childId, item.batch_id, item.id, ordinal, entry.archive_path,
          sanitizeOriginalFilename(entry.original_filename), duplicate ? null : childPath,
          inferredMime(entry.original_filename), entry.file_size, entry.sha256,
          childStatus, childStatus, duplicate ? 1 : 0,
          duplicate?.id ?? null,
          duplicate ? 'duplicate_content' : null,
          duplicate ? 'An identical file already exists in this batch' : null,
          timestamp, timestamp, duplicate ? timestamp : null
        )
        ordinal += 1
        if (duplicate) {
          enqueueCleanupInTransaction(childPath, 'attachment_batch_duplicate_entry', timestamp)
        } else {
          queuedChildren.push(childId)
        }
      }
      enqueueCleanupInTransaction(item.staging_path, 'attachment_batch_archive_expanded', timestamp)
      db.prepare(`
        UPDATE attachment_import_items SET status = 'skipped', phase = 'skipped', progress = 1,
          staging_path = NULL, error_code = 'archive_expanded',
          error_message = 'Archive container was safely expanded into individual items',
          retryable = 0, heartbeat_at = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(timestamp, timestamp, timestamp, item.id)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      for (const entry of result.entries) {
        try { await unlink(safePathWithin(root, entry.output_path)) } catch {}
      }
      throw error
    }
    processCleanup()
    for (const id of queuedChildren) schedule(id)
    refreshBatch(item.batch_id)
  }

  const processItem = async (itemId, signal) => {
    const item = readItem(itemId)
    if (!item || FINAL_ITEM_STATUSES.has(item.status)) return
    const batch = readBatch(item.batch_id)
    if (!batch || batch.cancel_requested) return
    const timestamp = nowIso(clock)
    db.prepare(`
      UPDATE attachment_import_items SET attempts = attempts + 1,
        heartbeat_at = ?, updated_at = ? WHERE id = ?
    `).run(timestamp, timestamp, itemId)
    try {
      if (item.item_kind === 'archive') await processArchiveItem(readItem(itemId), signal)
      else await processFileItem(readItem(itemId), signal)
    } catch (error) {
      if (closing && (signal.aborted || error?.name === 'AbortError')) return
      markFailed(itemId, error)
    }
  }

  const notifyIdle = () => {
    if (queuedIds.length || activeJobs) return
    for (const resolvePromise of idleWaiters) resolvePromise()
    idleWaiters.clear()
  }

  const settleJob = (job) => {
    if (job.settled) return
    job.settled = true
    jobs.delete(job.id)
    job.resolve()
  }

  const drain = () => {
    if (closing) return
    while (activeJobs < concurrency && queuedIds.length) {
      const id = queuedIds.shift()
      const job = jobs.get(id)
      if (!job || job.settled) continue
      activeJobs += 1
      job.state = 'running'
      job.controller = new AbortController()
      processItem(id, job.controller.signal).catch(() => {}).finally(() => {
        activeJobs -= 1
        settleJob(job)
        drain()
        notifyIdle()
      })
    }
    notifyIdle()
  }

  function schedule(id) {
    if (closing || jobs.has(id)) return jobs.get(id)?.promise
    let resolvePromise
    const promise = new Promise((resolveJob) => { resolvePromise = resolveJob })
    const job = { id, promise, resolve: resolvePromise, state: 'queued', controller: null, settled: false }
    jobs.set(id, job)
    queuedIds.push(id)
    drain()
    return promise
  }

  const stageUpload = async (file) => {
    const originalFilename = sanitizeOriginalFilename(file?.originalname ?? basename(file?.path ?? ''))
    const mimeType = normalizeMime(file?.mimetype || inferredMime(originalFilename))
    const archive = isTopLevelAttachmentArchive(originalFilename, mimeType)
    const maximum = archive ? limits.maxArchiveBytes : limits.maxAttachmentBytes
    const outputPath = resolve(incomingRoot, `${randomUUID()}${archive ? '.zip' : '.upload'}`)
    safePathWithin(root, outputPath)
    let size = 0
    const hash = createHash('sha256')
    try {
      if (Buffer.isBuffer(file?.buffer)) {
        size = file.buffer.length
        if (size < 1) throw attachmentBatchError(422, 'empty_file', 'Cannot upload an empty attachment')
        if (size > maximum) throw attachmentBatchError(413, 'file_too_large', 'Attachment exceeds its upload limit')
        hash.update(file.buffer)
        await writeFile(outputPath, file.buffer, { flag: 'wx', mode: 0o600 })
      } else if (file?.path) {
        const sourceStat = await lstat(file.path)
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          throw attachmentBatchError(422, 'unsafe_upload_file', 'Uploaded attachment is not a regular file')
        }
        const guard = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length
            if (size > maximum) {
              callback(attachmentBatchError(413, 'file_too_large', 'Attachment exceeds its upload limit'))
              return
            }
            hash.update(chunk)
            callback(null, chunk)
          }
        })
        await pipeline(
          createReadStream(file.path, { highWaterMark: 64 * 1024 }),
          guard,
          createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
        )
        if (size < 1) throw attachmentBatchError(422, 'empty_file', 'Cannot upload an empty attachment')
      } else {
        throw attachmentBatchError(400, 'file_required', 'Attachment file content is required')
      }
      return {
        originalFilename,
        mimeType,
        archive,
        size,
        sha256: hash.digest('hex'),
        path: outputPath,
        relativePath: cleanText(file?.relativePath ?? file?.webkitRelativePath, 1000)
      }
    } catch (error) {
      try { await unlink(outputPath) } catch {}
      throw error
    }
  }

  const removePaths = async (paths) => {
    for (const path of paths) {
      try { await unlink(safePathWithin(root, path)) } catch {}
    }
  }

  const createBatch = async ({ files, requestedCandidateId, idempotencyKey, batchToken } = {}) => {
    await readyPromise
    if (initializationError) throw initializationError
    if (closing) throw attachmentBatchError(503, 'attachment_batch_service_closing', 'Attachment batch service is closing')
    if (!Array.isArray(files) || files.length < 1) {
      throw attachmentBatchError(400, 'files_required', 'At least one attachment file is required')
    }
    if (files.length > limits.maxUploadFiles) {
      throw attachmentBatchError(413, 'attachment_batch_file_limit', `A batch supports at most ${limits.maxUploadFiles} uploaded files`)
    }
    const key = cleanText(idempotencyKey, limits.maxIdempotencyKeyLength)
    const rawToken = batchToken == null ? randomBytes(32).toString('base64url') : String(batchToken)
    if (rawToken.length < limits.minBatchTokenLength || rawToken.length > limits.maxBatchTokenLength) {
      throw attachmentBatchError(422, 'attachment_batch_token_invalid', 'Attachment batch token length is invalid')
    }
    const candidateId = cleanText(requestedCandidateId, 200)
    if (candidateId) {
      const candidate = db.prepare('SELECT id, archived_at FROM candidates WHERE id = ?').get(candidateId)
      if (!candidate) throw attachmentBatchError(404, 'candidate_not_found', 'Requested candidate does not exist')
      if (candidate.archived_at) throw attachmentBatchError(409, 'candidate_archived', 'Archived candidates cannot receive attachment updates')
    }

    const staged = []
    try {
      let totalBytes = 0
      for (const file of files) {
        const upload = await stageUpload(file)
        staged.push(upload)
        totalBytes += upload.size
        if (totalBytes > limits.maxBatchUploadBytes) {
          throw attachmentBatchError(413, 'attachment_batch_size_limit', 'Batch upload exceeds the total byte limit')
        }
      }
      const requestFingerprint = fingerprint({
        requested_candidate_id: candidateId,
        files: staged.map((file) => ({
          original_filename: file.originalFilename,
          relative_path: file.relativePath,
          mime_type: file.mimeType,
          file_size: file.size,
          sha256: file.sha256
        }))
      })
      if (key) {
        const existing = db.prepare('SELECT * FROM attachment_import_batches WHERE idempotency_key = ?').get(key)
        if (existing) {
          await removePaths(staged.map((file) => file.path))
          if (existing.request_fingerprint !== requestFingerprint) {
            throw attachmentBatchError(409, 'attachment_batch_idempotency_conflict', 'Idempotency key is already associated with different files')
          }
          if (!safeHashEqual(existing.token_hash, tokenHash(rawToken))) {
            throw attachmentBatchError(409, 'attachment_batch_token_conflict', 'Idempotent replay must use the original batch token')
          }
          return serializeBatch(refreshBatch(existing.id), { batchToken: rawToken })
        }
      }

      const batchId = randomUUID()
      const timestamp = nowIso(clock)
      const queued = []
      const seenHashes = new Map()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          INSERT INTO attachment_import_batches(
            id, token_hash, idempotency_key, request_fingerprint, requested_candidate_id,
            status, phase, progress, source_file_count, total_items, confirmed_items,
            failed_items, skipped_items, cancelled_items, cancel_requested,
            error_code, error_message, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, 0, 0, 0, 0, 0,
            NULL, NULL, ?, ?, NULL)
        `).run(
          batchId, tokenHash(rawToken), key, requestFingerprint, candidateId,
          staged.length, staged.length, timestamp, timestamp
        )
        for (const [ordinal, file] of staged.entries()) {
          const itemId = randomUUID()
          const duplicateOf = file.archive ? null : seenHashes.get(file.sha256)
          const status = duplicateOf ? 'skipped' : 'queued'
          db.prepare(`
            INSERT INTO attachment_import_items(
              id, batch_id, parent_item_id, ordinal, item_kind, archive_path,
              original_filename, staging_path, mime_type, file_size, sha256, format,
              status, phase, progress, attempts, heartbeat_at, preview_id,
              deduplicated_item_id, error_code, error_message, retryable,
              confirmation_idempotency_key, confirmation_fingerprint,
              confirmation_result_json, created_at, updated_at, completed_at
            ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL,
              NULL, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?)
          `).run(
            itemId, batchId, ordinal, file.archive ? 'archive' : 'file', file.relativePath,
            file.originalFilename, duplicateOf ? null : file.path, file.mimeType, file.size,
            file.sha256, status, status, duplicateOf ? 1 : 0, duplicateOf ?? null,
            duplicateOf ? 'duplicate_content' : null,
            duplicateOf ? 'An identical file already exists in this batch' : null,
            timestamp, timestamp, duplicateOf ? timestamp : null
          )
          if (duplicateOf) enqueueCleanupInTransaction(file.path, 'attachment_batch_duplicate_upload', timestamp)
          else {
            seenHashes.set(file.sha256, itemId)
            queued.push(itemId)
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        if (key && (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT')) {
          const existing = db.prepare('SELECT * FROM attachment_import_batches WHERE idempotency_key = ?').get(key)
          if (existing) {
            await removePaths(staged.map((file) => file.path))
            if (existing.request_fingerprint !== requestFingerprint) {
              throw attachmentBatchError(409, 'attachment_batch_idempotency_conflict', 'Idempotency key is already associated with different files')
            }
            if (!safeHashEqual(existing.token_hash, tokenHash(rawToken))) {
              throw attachmentBatchError(409, 'attachment_batch_token_conflict', 'Idempotent replay must use the original batch token')
            }
            return serializeBatch(refreshBatch(existing.id), { batchToken: rawToken })
          }
        }
        throw error
      }
      processCleanup()
      for (const id of queued) schedule(id)
      return serializeBatch(refreshBatch(batchId), { batchToken: rawToken })
    } catch (error) {
      const referenced = new Set(db.prepare(`
        SELECT staging_path FROM attachment_import_items WHERE staging_path IS NOT NULL
      `).all().map((row) => row.staging_path))
      await removePaths(staged.map((file) => file.path).filter((path) => !referenced.has(path)))
      throw error
    }
  }

  const reconcileAwaitingPreviews = ({ batchId, itemId } = {}) => {
    const clauses = ["status = 'awaiting_confirmation'"]
    const values = []
    if (batchId) {
      clauses.push('batch_id = ?')
      values.push(batchId)
    }
    if (itemId) {
      clauses.push('id = ?')
      values.push(itemId)
    }
    const awaiting = db.prepare(`
      SELECT * FROM attachment_import_items WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at, ordinal, id
    `).all(...values)
    for (const item of awaiting) {
      let preview
      try { preview = attachmentService.getPreview(item.preview_id) } catch {}
      if (preview?.status === 'ready') continue
      const status = preview?.status ?? 'missing'
      markFailed(item.id, attachmentBatchError(
        409,
        `attachment_preview_${status}`,
        `Attachment preview is ${status}`
      ))
    }
  }

  const getBatch = (batchId, { batchToken } = {}) => {
    assertAccess(batchId, batchToken)
    reconcileAwaitingPreviews({ batchId })
    return serializeBatch(refreshBatch(batchId))
  }

  const getItem = (batchId, itemId, { batchToken } = {}) => {
    assertAccess(batchId, batchToken)
    reconcileAwaitingPreviews({ batchId, itemId })
    const item = readItem(itemId)
    if (!item || item.batch_id !== batchId) throw attachmentBatchError(404, 'attachment_batch_item_not_found', 'Attachment batch item was not found')
    return serializeItem(item)
  }

  const createCandidateForItem = async (batchId, itemId, input = {}, { batchToken } = {}) => {
    assertAccess(batchId, batchToken)
    reconcileAwaitingPreviews({ batchId, itemId })
    const item = readItem(itemId)
    if (!item || item.batch_id !== batchId) {
      throw attachmentBatchError(404, 'attachment_batch_item_not_found', 'Attachment batch item was not found')
    }
    if (item.status !== 'awaiting_confirmation' || !item.preview_id) {
      throw attachmentBatchError(409, 'attachment_batch_item_not_ready', 'Attachment item is not awaiting confirmation')
    }
    return attachmentService.createCandidateFromPreview(item.preview_id, input, { authorizedBatch: true })
  }

  const confirmItem = async (batchId, itemId, input = {}, { batchToken, idempotencyKey } = {}) => {
    assertAccess(batchId, batchToken)
    reconcileAwaitingPreviews({ batchId, itemId })
    const item = readItem(itemId)
    if (!item || item.batch_id !== batchId) throw attachmentBatchError(404, 'attachment_batch_item_not_found', 'Attachment batch item was not found')
    const key = cleanText(idempotencyKey, limits.maxIdempotencyKeyLength)
    const confirmationInput = { ...input }
    delete confirmationInput.preview_token
    const confirmationFingerprint = fingerprint(confirmationInput)
    if (item.status === 'confirmed') {
      if (
        item.confirmation_fingerprint !== confirmationFingerprint ||
        key && item.confirmation_idempotency_key && key !== item.confirmation_idempotency_key
      ) {
        throw attachmentBatchError(409, 'attachment_confirmation_idempotency_conflict', 'Attachment item was confirmed with different input')
      }
      const confirmation = parseJson(item.confirmation_result_json, {})
      return {
        item: serializeItem(item),
        confirmation,
        next_item_id: db.prepare(`
          SELECT id FROM attachment_import_items
          WHERE batch_id = ? AND status = 'awaiting_confirmation' ORDER BY ordinal, id LIMIT 1
        `).get(batchId)?.id,
        batch: serializeBatch(refreshBatch(batchId))
      }
    }
    if (item.status !== 'awaiting_confirmation' || !item.preview_id) {
      throw attachmentBatchError(409, 'attachment_batch_item_not_ready', 'Attachment item is not awaiting confirmation')
    }
    const stagingPath = item.staging_path
    const result = attachmentService.confirmPreviewForBatch(item.preview_id, confirmationInput, {
      beforeCommit: ({ result: confirmation, timestamp }) => {
        const updated = db.prepare(`
          UPDATE attachment_import_items SET status = 'confirmed', phase = 'confirmed',
            progress = 1, staging_path = NULL, confirmation_idempotency_key = ?,
            confirmation_fingerprint = ?, confirmation_result_json = ?, error_code = NULL,
            error_message = NULL, retryable = 0, heartbeat_at = ?, updated_at = ?, completed_at = ?
          WHERE id = ? AND batch_id = ? AND status = 'awaiting_confirmation'
        `).run(
          key, confirmationFingerprint, JSON.stringify(confirmation), timestamp,
          timestamp, timestamp, itemId, batchId
        )
        if (updated.changes !== 1) {
          throw attachmentBatchError(409, 'attachment_confirmation_race', 'Attachment item confirmation state changed')
        }
        enqueueCleanupInTransaction(stagingPath, 'attachment_batch_item_confirmed', timestamp)
      }
    })
    processCleanup()
    const batch = refreshBatch(batchId)
    return {
      item: serializeItem(readItem(itemId)),
      confirmation: result,
      next_item_id: db.prepare(`
        SELECT id FROM attachment_import_items
        WHERE batch_id = ? AND status = 'awaiting_confirmation' ORDER BY ordinal, id LIMIT 1
      `).get(batchId)?.id,
      batch: serializeBatch(batch)
    }
  }

  const cancelPreviewIfNeeded = (item) => {
    if (!item.preview_id) return
    try { attachmentService.cancelPreview(item.preview_id) } catch (error) {
      if (!['attachment_preview_consumed', 'not_found'].includes(error?.code)) throw error
    }
  }

  const finalizeItem = (batchId, itemId, status, { batchToken } = {}) => {
    assertAccess(batchId, batchToken)
    const item = readItem(itemId)
    if (!item || item.batch_id !== batchId) throw attachmentBatchError(404, 'attachment_batch_item_not_found', 'Attachment batch item was not found')
    if (item.status === status) return serializeItem(item)
    if (item.status === 'confirmed') throw attachmentBatchError(409, 'attachment_batch_item_confirmed', 'Confirmed attachment items cannot be changed')
    cancelPreviewIfNeeded(item)
    const job = jobs.get(itemId)
    job?.controller?.abort()
    const timestamp = nowIso(clock)
    db.exec('BEGIN IMMEDIATE')
    try {
      enqueueCleanupInTransaction(item.staging_path, `attachment_batch_item_${status}`, timestamp)
      db.prepare(`
        UPDATE attachment_import_items SET status = ?, phase = ?, progress = 1,
          staging_path = NULL, retryable = 0, heartbeat_at = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND batch_id = ?
      `).run(status, status, timestamp, timestamp, timestamp, itemId, batchId)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    processCleanup()
    refreshBatch(batchId)
    return serializeItem(readItem(itemId))
  }

  const skipItem = (batchId, itemId, options = {}) => finalizeItem(batchId, itemId, 'skipped', options)
  const cancelItem = (batchId, itemId, options = {}) => finalizeItem(batchId, itemId, 'cancelled', options)

  const retryItem = (batchId, itemId, { batchToken } = {}) => {
    assertAccess(batchId, batchToken)
    const item = readItem(itemId)
    if (!item || item.batch_id !== batchId) throw attachmentBatchError(404, 'attachment_batch_item_not_found', 'Attachment batch item was not found')
    if (item.status !== 'failed') throw attachmentBatchError(409, 'attachment_batch_item_not_failed', 'Only failed attachment items can be retried')
    if (!item.retryable) throw attachmentBatchError(409, 'attachment_batch_item_not_retryable', 'This attachment failure is not retryable')
    if (!item.staging_path) throw attachmentBatchError(409, 'attachment_batch_source_missing', 'Attachment source was already cleaned up')
    try {
      const stat = db.prepare('SELECT cancel_requested FROM attachment_import_batches WHERE id = ?').get(batchId)
      if (stat?.cancel_requested) throw attachmentBatchError(409, 'attachment_batch_cancelled', 'Cancelled batches cannot be retried')
      cancelPreviewIfNeeded(item)
    } catch (error) {
      if (error?.code !== 'attachment_preview_consumed') throw error
    }
    const timestamp = nowIso(clock)
    db.prepare(`
      UPDATE attachment_import_items SET status = 'queued', phase = 'queued', progress = 0,
        preview_id = NULL, error_code = NULL, error_message = NULL, retryable = 0,
        heartbeat_at = ?, updated_at = ?, completed_at = NULL WHERE id = ?
    `).run(timestamp, timestamp, itemId)
    refreshBatch(batchId)
    schedule(itemId)
    return serializeItem(readItem(itemId))
  }

  const cancelBatch = (batchId, { batchToken } = {}) => {
    const batch = assertAccess(batchId, batchToken)
    if (['completed', 'completed_with_errors'].includes(batch.status)) {
      throw attachmentBatchError(409, 'attachment_batch_completed', 'Completed attachment batches cannot be cancelled')
    }
    const timestamp = nowIso(clock)
    db.prepare(`
      UPDATE attachment_import_batches SET cancel_requested = 1, status = 'cancelled',
        phase = 'cancelled', updated_at = ?, completed_at = coalesce(completed_at, ?) WHERE id = ?
    `).run(timestamp, timestamp, batchId)
    const pending = db.prepare(`
      SELECT * FROM attachment_import_items WHERE batch_id = ?
        AND status NOT IN ('confirmed', 'failed', 'skipped', 'cancelled')
    `).all(batchId)
    for (const item of pending) {
      try { cancelPreviewIfNeeded(item) } catch {}
      jobs.get(item.id)?.controller?.abort()
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of pending) {
        enqueueCleanupInTransaction(item.staging_path, 'attachment_batch_cancelled', timestamp)
        db.prepare(`
          UPDATE attachment_import_items SET status = 'cancelled', phase = 'cancelled',
            progress = 1, staging_path = NULL, retryable = 0, heartbeat_at = ?,
            updated_at = ?, completed_at = ? WHERE id = ?
        `).run(timestamp, timestamp, timestamp, item.id)
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    processCleanup()
    return serializeBatch(refreshBatch(batchId))
  }

  const cleanupOrphans = async () => {
    const referenced = new Set(db.prepare(`
      SELECT staging_path FROM attachment_import_items WHERE staging_path IS NOT NULL
    `).all().map((row) => resolve(row.staging_path)))
    for (const directory of [incomingRoot, extractedRoot]) {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue
        const path = resolve(directory, entry.name)
        if (!referenced.has(path)) {
          try { await unlink(safePathWithin(root, path)) } catch {}
        }
      }
    }
  }

  const recover = () => {
    const timestamp = nowIso(clock)
    const cancelledBatches = db.prepare(`
      SELECT id FROM attachment_import_batches WHERE cancel_requested = 1
    `).all()
    for (const batch of cancelledBatches) {
      const pending = db.prepare(`
        SELECT * FROM attachment_import_items WHERE batch_id = ?
          AND status NOT IN ('confirmed', 'failed', 'skipped', 'cancelled')
      `).all(batch.id)
      for (const item of pending) {
        try { cancelPreviewIfNeeded(item) } catch {}
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const item of pending) {
          enqueueCleanupInTransaction(item.staging_path, 'attachment_batch_restart_cancelled', timestamp)
          db.prepare(`
            UPDATE attachment_import_items SET status = 'cancelled', phase = 'cancelled',
              progress = 1, staging_path = NULL, updated_at = ?,
              completed_at = coalesce(completed_at, ?) WHERE id = ?
          `).run(timestamp, timestamp, item.id)
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        throw error
      }
      processCleanup()
      refreshBatch(batch.id)
    }
    const awaiting = db.prepare(`
      SELECT item.* FROM attachment_import_items item
      JOIN attachment_import_batches batch ON batch.id = item.batch_id
      WHERE batch.cancel_requested = 0 AND item.status = 'awaiting_confirmation'
      ORDER BY item.updated_at, item.ordinal, item.id
    `).all()
    for (const row of awaiting) {
      let preview
      try { preview = row.preview_id ? attachmentService.getPreview(row.preview_id) : null } catch {}
      if (preview?.status === 'ready') continue
      const status = preview?.status ?? 'missing'
      const error = attachmentBatchError(
        409,
        `attachment_preview_${status}`,
        'Attachment preview is no longer available; upload the file again'
      )
      error.retryable = false
      markFailed(row.id, error)
    }
    const interrupted = db.prepare(`
      SELECT item.* FROM attachment_import_items item
      JOIN attachment_import_batches batch ON batch.id = item.batch_id
      WHERE batch.cancel_requested = 0
        AND item.status IN ('queued', 'extracting', 'identifying', 'parsing', 'matching')
      ORDER BY item.updated_at, item.ordinal, item.id
    `).all()
    for (const row of interrupted) {
      if (!row.preview_id) {
        db.prepare(`
          UPDATE attachment_import_items SET status = 'queued', phase = 'queued',
            progress = 0, updated_at = ? WHERE id = ?
        `).run(timestamp, row.id)
      }
      schedule(row.id)
    }
    for (const batch of db.prepare(`
      SELECT id FROM attachment_import_batches
      WHERE status IN ('queued', 'processing', 'awaiting_confirmation')
    `).all()) refreshBatch(batch.id)
  }

  let initializationError = null
  const readyPromise = cleanupOrphans().then(() => {
    if (!closing) recover()
  }).catch((error) => {
    initializationError = error
  })

  const waitForIdle = async () => {
    await readyPromise
    if (initializationError) throw initializationError
    if (!queuedIds.length && activeJobs === 0) return
    await new Promise((resolvePromise) => idleWaiters.add(resolvePromise))
  }

  const close = async () => {
    if (closing) return
    closing = true
    await readyPromise
    for (const job of jobs.values()) {
      if (job.state === 'queued') settleJob(job)
      else job.controller?.abort(abortReason())
    }
    await Promise.allSettled([...jobs.values()].map((job) => job.promise))
  }

  function abortReason() {
    const error = new Error('Attachment batch service is closing')
    error.name = 'AbortError'
    error.code = 'attachment_batch_service_closing'
    return error
  }

  return {
    root,
    incomingRoot,
    extractedRoot,
    limits,
    createBatch,
    getBatch,
    getItem,
    createCandidateForItem,
    confirmItem,
    skipItem,
    retryItem,
    cancelItem,
    cancelBatch,
    waitForIdle,
    close
  }
}
