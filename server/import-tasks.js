import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { sanitizeOriginalFilename } from './attachment-parser.js'
import { commitImport, createImportPreview } from './import-export.js'

const ACTIVE_STATUSES = new Set([
  'queued', 'validating', 'parsing', 'mapping', 'previewing', 'committing', 'cancelling'
])
const TERMINAL_STATUSES = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])
const RETRYABLE_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000

function timestamp() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function json(value) {
  return value === undefined ? null : JSON.stringify(value)
}

// Idempotency fingerprints must be stable across retries while remaining
// independent of the random multer upload path.  Sorting object keys also
// keeps equivalent multipart field orderings from producing conflicts.
function stableJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

async function importRequestFingerprint(path, body) {
  const hash = createHash('sha256')
  const semanticBody = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.fromEntries(Object.entries(body).filter(([key]) => ![
        'async', 'client_request_id', 'idempotency_key'
      ].includes(key)))
    : body
  hash.update(stableJson(semanticBody))
  hash.update('\0')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function taskError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  const code = String(error?.code ?? (status >= 500 ? 'import_task_failed' : 'import_failed')).slice(0, 120)
  return {
    code,
    message: status >= 500
      ? 'The candidate import task failed.'
      : String(error?.message ?? 'The candidate import task failed.').slice(0, 1_000),
    status,
    retryable: status >= 500 || ['import_worker_failed', 'import_parse_timeout', 'import_commit_timeout'].includes(code),
    ...(status < 500 && error?.details !== undefined ? { details: error.details } : {})
  }
}

function interruptedCommitPatch(metrics = {}) {
  return {
    status: 'timed_out',
    phase: 'interrupted',
    error: {
      code: 'import_commit_interrupted',
      message: 'The candidate import commit was interrupted before completion.',
      status: 503,
      retryable: true
    },
    metrics: {
      ...metrics,
      recovered_after_interruption: true
    }
  }
}

function safeTaskFile(root, path) {
  if (!path) return null
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    const error = new Error('The candidate import task file path is invalid.')
    error.status = 500
    error.code = 'import_task_path_invalid'
    throw error
  }
  return absolutePath
}

async function removeFile(path) {
  if (!path) return
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function dirtySearchRows(db) {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get()?.count ?? 0)
  } catch {
    return 0
  }
}

function currentSearchIndexResult(db, stored = {}) {
  if (!db || typeof db.prepare !== 'function') return stored
  try {
    const schema = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name IN ('search_index_checkpoints_v2', 'search_index_dirty_v2')
    `).get().count ?? 0)
    if (schema !== 2) return stored
    const checkpoint = db.prepare(`
      SELECT status, queued_rows, processed_rows, document_count,
             updated_at, error_code
      FROM search_index_checkpoints_v2
      WHERE scope = 'full'
    `).get()
    if (!checkpoint) return stored
    const remainingRows = dirtySearchRows(db)
    const checkpointStatus = String(checkpoint.status ?? 'pending')
    const status = checkpointStatus === 'failed'
      ? 'failed'
      : remainingRows === 0 && checkpointStatus === 'ready'
        ? 'ready'
        : checkpointStatus === 'indexing'
          ? 'indexing'
          : 'pending'
    return {
      ...stored,
      status,
      queued_rows: Number(checkpoint.queued_rows ?? stored.queued_rows ?? 0),
      processed_rows: Number(checkpoint.processed_rows ?? stored.processed_rows ?? 0),
      remaining_rows: remainingRows,
      document_count: Number(checkpoint.document_count ?? 0),
      checkpoint_status: checkpointStatus,
      checkpoint_updated_at: checkpoint.updated_at ?? null,
      error_code: checkpoint.error_code ?? null,
      resumable: status !== 'ready',
      auto_retry: true
    }
  } catch {
    return stored
  }
}

async function fileSize(path) {
  if (!path || path === ':memory:') return 0
  try {
    return Number((await stat(path)).size ?? 0)
  } catch {
    return 0
  }
}

function runCommitWorker(workerData, resourceLimits, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL('./import-commit-worker.js', import.meta.url), {
      workerData,
      execArgv: [],
      name: `candidate-import-commit-${workerData.taskId}`,
      resourceLimits: {
        maxOldGenerationSizeMb: Number(resourceLimits.maxWorkerOldGenerationMb ?? 1_024),
        maxYoungGenerationSizeMb: Number(resourceLimits.maxWorkerYoungGenerationMb ?? 128),
        codeRangeSizeMb: Number(resourceLimits.maxWorkerCodeRangeMb ?? 64),
        stackSizeMb: Number(resourceLimits.maxWorkerStackMb ?? 8)
      }
    })
    let settled = false
    let exited = false
    let exitCode = null
    let message = null
    let workerError = null
    let terminationError = null
    let timer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const workerFailure = (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error ?? 'The import commit worker failed.'))
      if (normalized.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        normalized.status = 422
        normalized.code = 'import_commit_memory_limit_exceeded'
        normalized.message = 'The import commit exceeded its configured memory limit.'
        return normalized
      }
      normalized.status ??= 500
      normalized.code ??= 'import_commit_worker_failed'
      return normalized
    }
    const finishAfterExit = () => {
      if (settled || !exited) return
      if (terminationError) {
        finish(rejectPromise, terminationError)
        return
      }
      if (workerError) {
        finish(rejectPromise, workerFailure(workerError))
        return
      }
      if (exitCode !== 0) {
        const error = workerFailure(new Error(`The import commit worker exited with code ${exitCode}.`))
        finish(rejectPromise, error)
        return
      }
      if (!message?.ok) {
        const error = new Error(message?.error?.message ?? 'The import commit worker failed.')
        error.status = message?.error?.status ?? 500
        error.code = message?.error?.code ?? 'import_commit_worker_failed'
        error.details = message?.error?.details
        finish(rejectPromise, error)
        return
      }
      finish(resolvePromise, message)
    }
    const abort = () => {
      // Once the worker has durably committed the business result, let it
      // finish and allow the caller to recover that result after a lost
      // response.  Terminating before the commit boundary is safe to cancel.
      if (message?.ok) return
      const cancellation = Object.assign(new Error('Import commit interrupted.'), {
        status: 499,
        code: 'import_cancelled'
      })
      terminationError = cancellation
      worker.terminate().then(
        () => finish(rejectPromise, cancellation),
        () => finish(rejectPromise, cancellation)
      )
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      if (settled || message?.ok) return
      const timeout = Object.assign(new Error('The import commit exceeded its configured time limit.'), {
        status: 504,
        code: 'import_commit_timeout'
      })
      terminationError = timeout
      worker.terminate().then(
        () => finish(rejectPromise, timeout),
        () => finish(rejectPromise, timeout)
      )
    }, Math.max(1_000, Number(resourceLimits.maxCommitMs ?? 60 * 60 * 1000)))
    timer.unref?.()
    worker.once('message', (value) => {
      message = value
      finishAfterExit()
    })
    worker.once('error', (error) => {
      workerError = error
      if (!exited) {
        worker.terminate().then(
          () => finish(rejectPromise, workerFailure(error)),
          () => finish(rejectPromise, workerFailure(error))
        )
      } else finishAfterExit()
    })
    worker.once('exit', (code) => {
      exited = true
      exitCode = code
      finishAfterExit()
    })
  })
}

function serializablePreview(preview) {
  return {
    ...preview,
    mappedFields: preview.mappedFields instanceof Set ? [...preview.mappedFields] : preview.mappedFields,
    committing: false
  }
}

function hydratedPreview(preview) {
  return {
    ...preview,
    mappedFields: Array.isArray(preview?.mappedFields) ? new Set(preview.mappedFields) : preview?.mappedFields,
    committing: false
  }
}

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_import_tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      file_path TEXT,
      file_name TEXT,
      file_mime TEXT,
      file_size INTEGER,
      preview_token TEXT,
      preview_path TEXT,
      request_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error_json TEXT,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS candidate_import_tasks_idempotency_idx
      ON candidate_import_tasks(task_type, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
    CREATE INDEX IF NOT EXISTS candidate_import_tasks_status_idx
      ON candidate_import_tasks(status, updated_at, id);
    CREATE INDEX IF NOT EXISTS candidate_import_tasks_preview_idx
      ON candidate_import_tasks(preview_token, created_at DESC);
    CREATE TABLE IF NOT EXISTS candidate_import_task_request_keys (
      request_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES candidate_import_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS candidate_import_task_request_keys_task_idx
      ON candidate_import_task_request_keys(task_id, created_at);
  `)
}

function publicTask(row, { clientRequestId, db } = {}) {
  if (!row) return null
  const storedResult = parseJson(row.result_json)
  const normalizedResult = row.task_type === 'preview' && storedResult?.filename
    ? { ...storedResult, filename: sanitizeOriginalFilename(storedResult.filename) }
    : storedResult
  const result = row.task_type === 'commit' && normalizedResult?.search_index
    ? { ...normalizedResult, search_index: currentSearchIndexResult(db, normalizedResult.search_index) }
    : normalizedResult
  const error = parseJson(row.error_json)
  const metrics = parseJson(row.metrics_json, {})
  return {
    task_id: row.id,
    task_type: row.task_type,
    operation: row.task_type,
    client_request_id: clientRequestId ?? row.idempotency_key ?? undefined,
    status: row.status,
    phase: row.phase,
    progress: Number(row.progress ?? 0),
    terminal: TERMINAL_STATUSES.has(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    ...(row.preview_token ? { preview_token: row.preview_token } : {}),
    ...(row.file_name ? { file_name: sanitizeOriginalFilename(row.file_name) } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    metrics
  }
}

export function importTaskIdempotencyKey(value, fallbackParts = []) {
  const requested = String(value ?? '').trim()
  if (requested) return requested.slice(0, 300)
  const hash = createHash('sha256')
  for (const part of fallbackParts) hash.update(String(part ?? '')).update('\0')
  return hash.digest('hex')
}

export class CandidateImportTaskService {
  constructor(options) {
    this.db = options.db
    this.databasePath = options.databasePath
    this.previewStore = options.previewStore
    this.createPreview = options.createPreview ?? createImportPreview
    this.uploadRoot = resolve(options.uploadRoot)
    this.validStages = options.validStages
    this.resourceLimits = options.resourceLimits ?? {}
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent ?? 1))
    this.removeUpload = options.removeUpload ?? removeFile
    this.recoverOnStartup = options.recoverOnStartup !== false
    this.enablePreviewCleanupTimer = options.enablePreviewCleanupTimer !== false
    this.queue = []
    this.queuedIds = new Set()
    this.runtimes = new Map()
    this.runningPromises = new Set()
    this.runtimePromises = new Map()
    this.commitCreationLocks = new Map()
    this.previewPurgeLocks = new Set()
    this.running = 0
    this.closing = false
    createTables(this.db)
    if (this.recoverOnStartup) this.recover()
    this.cleanupTimer = this.enablePreviewCleanupTimer
      ? setInterval(() => {
          void this.purgeExpiredPreviews().catch(() => undefined)
        }, Math.max(10_000, Number(options.previewCleanupIntervalMs ?? 60_000)))
      : null
    this.cleanupTimer?.unref?.()
  }

  row(id) {
    return this.db.prepare('SELECT * FROM candidate_import_tasks WHERE id = ?').get(id) ?? null
  }

  get(id) {
    return publicTask(this.row(id), { db: this.db })
  }

  hasActiveCommit() {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM candidate_import_tasks
      WHERE task_type = 'commit' AND status IN ('queued', 'committing', 'cancelling')
      LIMIT 1
    `).get())
  }

  getByIdempotency(taskType, key) {
    if (!key) return null
    return this.db.prepare(`
      SELECT task.* FROM candidate_import_tasks task
      LEFT JOIN candidate_import_task_request_keys alias ON alias.task_id = task.id
      WHERE task.task_type = ? AND (task.idempotency_key = ? OR alias.request_key = ?)
      ORDER BY task.created_at DESC LIMIT 1
    `).get(taskType, key, key) ?? null
  }

  getByClientRequestId(key) {
    if (!key) return null
    const requestKey = String(key).slice(0, 300)
    return publicTask(this.db.prepare(`
      SELECT task.* FROM candidate_import_tasks task
      LEFT JOIN candidate_import_task_request_keys alias ON alias.task_id = task.id
      WHERE task.idempotency_key = ? OR alias.request_key = ?
      ORDER BY task.created_at DESC LIMIT 1
    `).get(requestKey, requestKey) ?? null, { clientRequestId: requestKey, db: this.db })
  }

  addRequestKey(taskId, key) {
    if (!key) return
    this.db.prepare(`
      INSERT INTO candidate_import_task_request_keys(request_key, task_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(request_key) DO NOTHING
    `).run(String(key).slice(0, 300), taskId, timestamp())
  }

  update(id, patch = {}) {
    const current = this.row(id)
    if (!current) return null
    const nextMetrics = patch.metrics
      ? { ...parseJson(current.metrics_json, {}), ...patch.metrics }
      : parseJson(current.metrics_json, {})
    const completedAt = patch.completed_at !== undefined
      ? patch.completed_at
      : TERMINAL_STATUSES.has(patch.status) ? timestamp() : current.completed_at
    this.db.prepare(`
      UPDATE candidate_import_tasks SET
        status = ?, phase = ?, progress = ?, preview_token = ?, preview_path = ?,
        result_json = ?, error_json = ?, metrics_json = ?, heartbeat_at = ?,
        updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.phase ?? current.phase,
      patch.progress ?? current.progress,
      patch.preview_token !== undefined ? patch.preview_token : current.preview_token,
      patch.preview_path !== undefined ? patch.preview_path : current.preview_path,
      patch.result !== undefined ? json(patch.result) : current.result_json,
      patch.error !== undefined ? json(patch.error) : current.error_json,
      json(nextMetrics),
      ACTIVE_STATUSES.has(patch.status ?? current.status) ? timestamp() : current.heartbeat_at,
      timestamp(),
      completedAt,
      id
    )
    return this.get(id)
  }

  async createPreviewTask({ file, body = {}, idempotencyKey, uploadMetrics = {} }) {
    const key = idempotencyKey ? String(idempotencyKey).slice(0, 300) : null
    const filePath = safeTaskFile(this.uploadRoot, file.path)
    const fingerprintStartedAt = performance.now()
    const requestFingerprint = key ? await importRequestFingerprint(filePath, body) : null
    const fingerprintMs = key ? Math.round(performance.now() - fingerprintStartedAt) : 0
    const existing = this.getByIdempotency('preview', key)
    if (existing) {
      const previousFingerprint = parseJson(existing.request_json, {})?.file_fingerprint
      try {
        await this.removeUpload(filePath)
      } catch (cause) {
        const error = new Error('The duplicate candidate import upload could not be removed.')
        error.status = 500
        error.code = 'import_temp_cleanup_failed'
        error.cause = cause
        throw error
      }
      if (previousFingerprint && previousFingerprint !== requestFingerprint) {
        const error = new Error('The idempotency key is already associated with a different import preview.')
        error.status = 409
        error.code = 'import_preview_idempotency_conflict'
        error.details = { task_id: existing.id, operation: 'preview' }
        throw error
      }
      return publicTask(existing, { db: this.db })
    }
    const id = randomUUID()
    const createdAt = timestamp()
    this.db.prepare(`
      INSERT INTO candidate_import_tasks(
        id, task_type, status, phase, progress, idempotency_key,
        file_path, file_name, file_mime, file_size, request_json,
        metrics_json, heartbeat_at, created_at, updated_at
      ) VALUES (?, 'preview', 'queued', 'uploaded', 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      key,
      filePath,
      basename(String(file.originalname ?? 'candidate-import')),
      String(file.mimetype ?? '').slice(0, 200),
      Number(file.size ?? 0),
      json({ body, ...(requestFingerprint ? { file_fingerprint: requestFingerprint } : {}) }),
      json({
        ...uploadMetrics,
        file_size_bytes: Number(file.size ?? 0),
        ...(requestFingerprint ? { idempotency_fingerprint_ms: fingerprintMs } : {})
      }),
      createdAt,
      createdAt,
      createdAt
    )
    this.addRequestKey(id, key)
    this.enqueue(id)
    return this.get(id)
  }

  async ensurePreview(token) {
    let preview = this.previewStore.get(token)
    if (preview) return preview
    const task = this.db.prepare(`
      SELECT preview_path FROM candidate_import_tasks
      WHERE preview_token = ? AND preview_path IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(token)
    if (!task?.preview_path) return null
    const path = safeTaskFile(this.uploadRoot, task.preview_path)
    let persistedText
    try {
      persistedText = await readFile(path, 'utf8')
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        const error = new Error('The persisted import preview is missing.')
        error.status = 410
        error.code = 'import_preview_state_missing'
        throw error
      }
      throw cause
    }
    const persisted = parseJson(persistedText)
    if (!persisted?.preview) {
      const error = new Error('The persisted import preview is invalid.')
      error.status = 410
      error.code = 'import_preview_state_missing'
      throw error
    }
    const restored = hydratedPreview(persisted.preview)
    const commitTask = this.db.prepare(`
      SELECT status, error_json FROM candidate_import_tasks
      WHERE task_type = 'commit' AND preview_token = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(token)
    const resumableCommit = commitTask && (
      ['queued', 'committing', 'committed', 'cancelling'].includes(commitTask.status) ||
      (['failed', 'timed_out'].includes(commitTask.status) && parseJson(commitTask.error_json, {})?.retryable === true)
    )
    const restoredExpiresAt = resumableCommit
      ? Math.max(Number(restored.expiresAt ?? 0), Date.now() + RETRYABLE_PREVIEW_TTL_MS)
      : restored.expiresAt
    this.previewStore.restore(token, restored, {
      createdAt: restored.createdAt,
      expiresAt: restoredExpiresAt
    })
    return this.previewStore.get(token)
  }

  async purgeExpiredPreviews(referenceTime = Date.now()) {
    const rows = this.db.prepare(`
      SELECT preview.* FROM candidate_import_tasks preview
      WHERE preview.task_type = 'preview'
        AND preview.status = 'preview_ready'
        AND preview.preview_path IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM candidate_import_tasks commit_task
          WHERE commit_task.task_type = 'commit'
            AND commit_task.preview_token = preview.preview_token
            AND (
              commit_task.status IN ('queued', 'committing', 'committed', 'cancelling')
              OR (
                commit_task.status IN ('failed', 'timed_out')
                AND json_valid(commit_task.error_json)
                AND json_extract(commit_task.error_json, '$.retryable') = 1
              )
            )
        )
    `).all()
    let removed = 0
    for (const row of rows) {
      const result = parseJson(row.result_json, {})
      const expiresAt = Date.parse(String(result?.expires_at ?? ''))
      if (!Number.isFinite(expiresAt) || expiresAt > referenceTime) continue
      if (this.commitCreationLocks.has(row.preview_token) || this.previewPurgeLocks.has(row.preview_token)) continue
      this.previewPurgeLocks.add(row.preview_token)
      try {
        const stillUnclaimed = this.db.prepare(`
          SELECT 1 FROM candidate_import_tasks preview
          WHERE preview.id = ? AND preview.status = 'preview_ready'
            AND NOT EXISTS (
              SELECT 1 FROM candidate_import_tasks commit_task
              WHERE commit_task.task_type = 'commit'
                AND commit_task.preview_token = preview.preview_token
                AND (
                  commit_task.status IN ('queued', 'committing', 'committed', 'cancelling')
                  OR (
                    commit_task.status IN ('failed', 'timed_out')
                    AND json_valid(commit_task.error_json)
                    AND json_extract(commit_task.error_json, '$.retryable') = 1
                  )
                )
            )
        `).get(row.id)
        if (!stillUnclaimed) continue
        await this.removeUpload(safeTaskFile(this.uploadRoot, row.preview_path)).catch(() => undefined)
        this.previewStore.delete(row.preview_token)
        this.update(row.id, {
          status: 'failed',
          phase: 'expired',
          progress: 100,
          preview_path: null,
          result: null,
          error: {
            code: 'import_preview_expired',
            message: 'The candidate import preview expired before it was committed.',
            status: 410,
            retryable: false
          }
        })
        removed += 1
      } finally {
        this.previewPurgeLocks.delete(row.preview_token)
      }
    }
    return removed
  }

  async createCommitTask({ token, onDuplicate = 'skip', idempotencyKey }) {
    const lockKey = String(token ?? '')
    const previous = this.commitCreationLocks.get(lockKey) ?? Promise.resolve()
    let release
    const current = new Promise((resolvePromise) => { release = resolvePromise })
    this.commitCreationLocks.set(lockKey, current)
    await previous
    try {
      return await this.createCommitTaskUnlocked({ token, onDuplicate, idempotencyKey })
    } finally {
      release()
      if (this.commitCreationLocks.get(lockKey) === current) this.commitCreationLocks.delete(lockKey)
    }
  }

  async createCommitTaskUnlocked({ token, onDuplicate = 'skip', idempotencyKey }) {
    if (!['skip', 'update'].includes(onDuplicate)) {
      const error = new Error('on_duplicate must be skip or update.')
      error.status = 400
      throw error
    }
    const key = importTaskIdempotencyKey(idempotencyKey, [token, onDuplicate])
    const existing = this.getByIdempotency('commit', key)
    if (existing) {
      const request = parseJson(existing.request_json, {})
      if (request.token !== token || (request.onDuplicate ?? 'skip') !== onDuplicate) {
        const error = new Error('The idempotency key is already associated with a different import commit.')
        error.status = 409
        error.code = 'import_commit_idempotency_conflict'
        error.details = { task_id: existing.id, operation: 'commit' }
        throw error
      }
      return this.resumeCommitTask(existing, key)
    }
    const existingForPreview = this.db.prepare(`
      SELECT * FROM candidate_import_tasks
      WHERE task_type = 'commit' AND preview_token = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(token)
    if (existingForPreview) {
      const request = parseJson(existingForPreview.request_json, {})
      if ((request.onDuplicate ?? 'skip') !== onDuplicate) {
        const error = new Error('This import preview already has a commit task with a different duplicate policy.')
        error.status = 409
        error.code = 'import_commit_policy_conflict'
        error.details = {
          task_id: existingForPreview.id,
          operation: 'commit',
          existing_on_duplicate: request.onDuplicate ?? 'skip',
          requested_on_duplicate: onDuplicate
        }
        throw error
      }
      return this.resumeCommitTask(existingForPreview, key)
    }
    if (this.previewPurgeLocks.has(token)) {
      const error = new Error('The import preview expired before the commit could be created.')
      error.status = 410
      error.code = 'import_preview_expired'
      throw error
    }
    const preview = await this.ensurePreview(token)
    if (!preview) {
      const error = new Error('The import preview does not exist or has expired.')
      error.status = 404
      error.code = 'import_preview_missing'
      throw error
    }
    const id = randomUUID()
    const createdAt = timestamp()
    this.db.prepare(`
      INSERT INTO candidate_import_tasks(
        id, task_type, status, phase, progress, idempotency_key,
        preview_token, request_json, metrics_json, heartbeat_at, created_at, updated_at
      ) VALUES (?, 'commit', 'queued', 'queued', 0, ?, ?, ?, '{}', ?, ?, ?)
    `).run(id, key, token, json({ token, onDuplicate, batchId: id }), createdAt, createdAt, createdAt)
    this.addRequestKey(id, key)
    this.enqueue(id)
    return publicTask(this.row(id), { clientRequestId: key, db: this.db })
  }

  async resumeCommitTask(row, requestKey) {
    this.addRequestKey(row.id, requestKey)
    if (row.result_json) {
      if (row.status !== 'completed') {
        this.update(row.id, {
          status: 'completed',
          phase: 'completed',
          progress: 100,
          error: null,
          metrics: { recovered_after_commit: true }
        })
      }
      return publicTask(this.row(row.id), { clientRequestId: requestKey, db: this.db })
    }

    const visible = publicTask(row, { clientRequestId: requestKey, db: this.db })
    if (!['failed', 'timed_out'].includes(row.status) || !visible.error?.retryable) return visible
    if (this.previewPurgeLocks.has(row.preview_token)) {
      const error = new Error('The import preview expired before the commit could be retried.')
      error.status = 410
      error.code = 'import_preview_expired'
      throw error
    }
    const preview = await this.ensurePreview(row.preview_token)
    if (!preview) {
      const error = new Error('The import preview does not exist or has expired.')
      error.status = 410
      error.code = 'import_preview_missing'
      throw error
    }

    const latest = this.row(row.id)
    if (!latest || !['failed', 'timed_out'].includes(latest.status)) {
      return publicTask(latest, { clientRequestId: requestKey, db: this.db })
    }
    const previousMetrics = parseJson(latest.metrics_json, {})
    this.update(latest.id, {
      status: 'queued',
      phase: 'queued',
      progress: 0,
      error: null,
      completed_at: null,
      metrics: {
        retry_count: Number(previousMetrics.retry_count ?? 0) + 1,
        retry_previous_error_code: visible.error.code
      }
    })
    this.enqueue(latest.id)
    return publicTask(this.row(latest.id), { clientRequestId: requestKey, db: this.db })
  }

  enqueue(id) {
    if (this.closing || this.queuedIds.has(id) || this.runtimes.has(id)) return
    this.queuedIds.add(id)
    this.queue.push(id)
    queueMicrotask(() => this.pump())
  }

  pump() {
    if (this.closing) return
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()
      this.queuedIds.delete(id)
      const row = this.row(id)
      if (!row || !ACTIVE_STATUSES.has(row.status) || row.status === 'cancelling') continue
      this.running += 1
      const controller = new AbortController()
      this.runtimes.set(id, controller)
      const runPromise = yieldToEventLoop()
        .then(() => row.task_type === 'preview'
          ? this.runPreview(row, controller.signal)
          : this.runCommit(row, controller.signal))
        .catch(() => undefined)
        .finally(() => {
          this.runtimes.delete(id)
          this.runtimePromises.delete(id)
          this.runningPromises.delete(runPromise)
          this.running -= 1
          this.pump()
        })
      this.runningPromises.add(runPromise)
      this.runtimePromises.set(id, runPromise)
    }
  }

  async runPreview(row, signal) {
    const startedAt = performance.now()
    const filePath = safeTaskFile(this.uploadRoot, row.file_path)
    let previewToken = null
    let previewPath = null
    try {
      if (!existsSync(filePath)) {
        const error = new Error('The candidate import temporary file is missing.')
        error.status = 410
        error.code = 'import_task_file_missing'
        throw error
      }
      const request = parseJson(row.request_json, {})
      this.update(row.id, { status: 'validating', phase: 'validating', progress: 10 })
      const response = await this.createPreview({
        db: this.db,
        file: {
          path: filePath,
          originalname: sanitizeOriginalFilename(row.file_name),
          mimetype: row.file_mime,
          size: Number(row.file_size ?? 0)
        },
        body: request.body ?? {},
        validStages: this.validStages(),
        store: this.previewStore,
        resourceLimits: this.resourceLimits,
        signal,
        onProgress: (progress) => {
          if (signal.aborted) return
          const status = progress.phase === 'preview'
            ? 'previewing'
            : ['validating', 'parsing', 'mapping'].includes(progress.phase)
              ? progress.phase
              : 'parsing'
          this.update(row.id, {
            status,
            phase: progress.phase,
            progress: progress.progress,
            metrics: progress.metrics
          })
        }
      })
      previewToken = response.preview_token
      const preview = this.previewStore.get(previewToken)
      if (!preview) throw Object.assign(new Error('The candidate import preview state is missing.'), { code: 'import_preview_state_missing' })
      previewPath = safeTaskFile(this.uploadRoot, join(this.uploadRoot, `${row.id}.preview.json`))
      const serializationStartedAt = performance.now()
      const serializedPreview = json({ preview: serializablePreview(preview) })
      const previewSerializationMs = Math.round(performance.now() - serializationStartedAt)
      const previewPersistStartedAt = performance.now()
      await writeFile(previewPath, serializedPreview, { encoding: 'utf8', mode: 0o600 })
      await chmod(previewPath, 0o600).catch(() => undefined)
      const previewPersistMs = Math.round(performance.now() - previewPersistStartedAt)
      await this.removeUpload(filePath)
      this.update(row.id, {
        status: 'preview_ready',
        phase: 'preview',
        progress: 100,
        preview_token: previewToken,
        preview_path: previewPath,
        result: response,
        error: null,
        metrics: {
          ...(response.metrics ?? {}),
          preview_serialization_ms: previewSerializationMs,
          preview_persist_ms: previewPersistMs,
          preview_payload_bytes: Buffer.byteLength(serializedPreview, 'utf8'),
          task_total_ms: Math.round(performance.now() - startedAt)
        }
      })
    } catch (error) {
      if (previewToken) this.previewStore.delete(previewToken)
      if (previewPath) await this.removeUpload(previewPath).catch(() => undefined)
      if (this.closing) {
        this.update(row.id, {
          status: 'queued',
          phase: 'queued',
          progress: 5,
          preview_token: null,
          preview_path: null,
          result: null,
          error: null,
          completed_at: null
        })
        return
      }
      await this.removeUpload(filePath).catch(() => undefined)
      const cancelled = signal.aborted || error?.code === 'import_cancelled'
      const timedOut = error?.code === 'import_parse_timeout'
      this.update(row.id, {
        status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
        phase: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'failed',
        preview_token: null,
        preview_path: null,
        result: null,
        error: cancelled
          ? { code: 'import_cancelled', message: 'The candidate import task was cancelled.', status: 499, retryable: false }
          : taskError(error),
        metrics: { task_total_ms: Math.round(performance.now() - startedAt) }
      })
    }
  }

  async runCommit(row, signal) {
    const startedAt = performance.now()
    try {
      const request = parseJson(row.request_json, {})
      const preview = await this.ensurePreview(request.token)
      if (!preview) {
        const error = new Error('The import preview does not exist or has expired.')
        error.status = 404
        error.code = 'import_preview_missing'
        throw error
      }
      if (signal.aborted) throw Object.assign(new Error('import cancelled'), { code: 'import_cancelled', status: 499 })
      this.update(row.id, { status: 'committing', phase: 'committing', progress: 20 })
      await yieldToEventLoop()
      const sourceTask = this.db.prepare(`
        SELECT preview_path FROM candidate_import_tasks
        WHERE preview_token = ? AND task_type = 'preview'
        ORDER BY created_at DESC LIMIT 1
      `).get(request.token)
      let result
      let commitMetrics
      if (this.databasePath && this.databasePath !== ':memory:' && sourceTask?.preview_path) {
        const workerResult = await runCommitWorker({
          databasePath: this.databasePath,
          taskId: row.id,
          previewPath: safeTaskFile(this.uploadRoot, sourceTask.preview_path),
          previewToken: request.token,
          onDuplicate: request.onDuplicate,
          batchId: request.batchId,
          busyTimeoutMs: 5_000
        }, this.resourceLimits, signal)
        result = workerResult.result
        commitMetrics = workerResult.metrics
      } else {
        const dirtyBefore = dirtySearchRows(this.db)
        const walPath = this.databasePath && this.databasePath !== ':memory:' ? `${this.databasePath}-wal` : null
        const walBefore = await fileSize(walPath)
        const transactionStartedAt = performance.now()
        const commitOperationMetrics = {}
        const committed = commitImport({
          db: this.db,
          token: request.token,
          onDuplicate: request.onDuplicate,
          store: this.previewStore,
          batchId: request.batchId,
          taskId: row.id,
          metrics: commitOperationMetrics
        })
        const businessTransactionMs = Math.round(performance.now() - transactionStartedAt)
        const dirtyAfter = dirtySearchRows(this.db)
        const walAfter = await fileSize(walPath)
        result = {
          ...committed,
          search_index: {
            status: dirtyAfter > 0 ? 'pending' : 'ready',
            queued_rows: dirtyAfter,
            queued_by_import: Math.max(0, dirtyAfter - dirtyBefore),
            processed_rows: 0,
            resumable: true
          }
        }
        commitMetrics = {
          ...commitOperationMetrics,
          commit_ms: Math.round(performance.now() - startedAt),
          business_transaction_ms: businessTransactionMs,
          affected_rows: Number(result.imported_rows ?? 0) + Number(result.updated_rows ?? 0),
          search_index_queue_before: dirtyBefore,
          search_index_queue_after: dirtyAfter,
          search_index_queued_by_import: Math.max(0, dirtyAfter - dirtyBefore),
          search_index_processed_rows: 0,
          wal_before_bytes: walBefore,
          wal_after_bytes: walAfter,
          wal_growth_bytes: Math.max(0, walAfter - walBefore)
        }
      }
      if (sourceTask?.preview_path) await removeFile(safeTaskFile(this.uploadRoot, sourceTask.preview_path)).catch(() => undefined)
      this.previewStore.delete(request.token)
      this.update(row.id, {
        status: 'completed',
        phase: 'completed',
        progress: 100,
        result,
        error: null,
        metrics: commitMetrics
      })
    } catch (error) {
      if (this.closing) return
      const durable = this.row(row.id)
      if (durable?.result_json && ['committing', 'committed', 'completed', 'cancelling'].includes(durable.status)) {
        this.update(row.id, {
          status: 'completed',
          phase: 'completed',
          progress: 100,
          error: null,
          metrics: { worker_result_recovered: true, commit_ms: Math.round(performance.now() - startedAt) }
        })
        return
      }
      const cancelled = signal.aborted || error?.code === 'import_cancelled'
      const timedOut = error?.code === 'import_commit_timeout'
      this.update(row.id, {
        status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
        phase: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'failed',
        error: cancelled
          ? { code: 'import_cancelled', message: 'The candidate import task was cancelled.', status: 499, retryable: false }
          : taskError(error),
        metrics: { commit_ms: Math.round(performance.now() - startedAt) }
      })
    }
  }

  async cancel(id) {
    const row = this.row(id)
    if (!row) return null
    if (TERMINAL_STATUSES.has(row.status)) return publicTask(row, { db: this.db })
    const runtime = this.runtimes.get(id)
    if (runtime) {
      runtime.abort()
      await this.runtimePromises.get(id)
    } else {
      this.queuedIds.delete(id)
      this.update(id, {
        status: 'cancelled',
        phase: 'cancelled',
        error: { code: 'import_cancelled', message: 'The candidate import task was cancelled.', status: 499, retryable: false }
      })
      if (row.file_path) void this.removeUpload(safeTaskFile(this.uploadRoot, row.file_path)).catch(() => undefined)
    }
    return this.get(id)
  }

  recover() {
    const rows = this.db.prepare(`
      SELECT * FROM candidate_import_tasks
      WHERE status IN ('queued', 'validating', 'parsing', 'mapping', 'previewing', 'committing', 'committed', 'cancelling')
      ORDER BY created_at, id
    `).all()
    for (const row of rows) {
      if (row.task_type === 'commit' && row.result_json) {
        this.update(row.id, {
          status: 'completed',
          phase: 'completed',
          progress: 100,
          error: null,
          metrics: { recovered_after_commit: true }
        })
        continue
      }
      if (row.task_type === 'commit' && row.status === 'committed') {
        this.update(row.id, {
          status: 'failed',
          phase: 'failed',
          error: {
            code: 'import_commit_result_missing',
            message: 'The committed import result is missing.',
            status: 500,
            retryable: false
          }
        })
        continue
      }
      if (row.task_type === 'commit' && row.status === 'committing') {
        this.update(row.id, interruptedCommitPatch())
        continue
      }
      if (row.status === 'cancelling') {
        this.update(row.id, {
          status: 'cancelled',
          phase: 'cancelled',
          error: { code: 'import_cancelled', message: 'The candidate import task was cancelled.', status: 499, retryable: false }
        })
        continue
      }
      if (row.task_type === 'preview' && !existsSync(safeTaskFile(this.uploadRoot, row.file_path))) {
        this.update(row.id, {
          status: 'failed',
          phase: 'failed',
          error: { code: 'import_task_file_missing', message: 'The candidate import temporary file is missing.', status: 410, retryable: false }
        })
        continue
      }
      this.update(row.id, { status: 'queued', phase: 'queued', error: null, completed_at: null })
      this.enqueue(row.id)
    }
  }

  async close() {
    this.closing = true
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    this.queue.length = 0
    this.queuedIds.clear()
    const interrupted = [...this.runtimes.entries()].map(([id, runtime]) => ({ id, runtime }))
    for (const { runtime } of interrupted) runtime.abort()
    await Promise.allSettled([...this.runningPromises])
    for (const { id } of interrupted) {
      const row = this.row(id)
      if (!row || !ACTIVE_STATUSES.has(row.status)) continue
      if (row.task_type === 'commit') {
        if (row.result_json) {
          this.update(id, {
            status: 'completed',
            phase: 'completed',
            progress: 100,
            error: null,
            metrics: { recovered_after_commit: true }
          })
        } else {
          this.update(id, interruptedCommitPatch({ interrupted_during_shutdown: true }))
        }
      } else {
        this.update(id, { status: 'queued', phase: 'queued', error: null, completed_at: null })
      }
    }
  }
}
