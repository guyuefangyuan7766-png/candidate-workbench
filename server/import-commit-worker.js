import { readFile, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { commitImport, ImportPreviewStore } from './import-export.js'

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function dirtyRows(db) {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get()?.count ?? 0)
  } catch {
    return 0
  }
}

async function fileSize(path) {
  try {
    return Number((await stat(path)).size ?? 0)
  } catch {
    return 0
  }
}

const startedAt = performance.now()
let db
let store
try {
  let persistedText
  try {
    persistedText = await readFile(workerData.previewPath, 'utf8')
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause
    const error = new Error('The persisted import preview is missing.')
    error.status = 410
    error.code = 'import_preview_state_missing'
    throw error
  }
  const persisted = parseJson(persistedText)
  if (!persisted?.preview) {
    const error = new Error('The persisted import preview is missing or invalid.')
    error.status = 410
    error.code = 'import_preview_state_missing'
    throw error
  }
  db = new DatabaseSync(workerData.databasePath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA busy_timeout = ${Math.max(1_000, Number(workerData.busyTimeoutMs ?? 5_000))}`)
  db.exec('PRAGMA journal_mode = WAL')
  store = new ImportPreviewStore({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 1 })
  const preview = {
    ...persisted.preview,
    mappedFields: Array.isArray(persisted.preview.mappedFields)
      ? new Set(persisted.preview.mappedFields)
      : persisted.preview.mappedFields,
    committing: false
  }
  store.restore(workerData.previewToken, preview, {
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  })

  const dirtyBefore = dirtyRows(db)
  const walPath = `${workerData.databasePath}-wal`
  const walBefore = await fileSize(walPath)
  const transactionStartedAt = performance.now()
  const commitOperationMetrics = {}
  const committed = commitImport({
    db,
    token: workerData.previewToken,
    onDuplicate: workerData.onDuplicate,
    store,
    batchId: workerData.batchId,
    taskId: workerData.taskId,
    metrics: commitOperationMetrics
  })
  const businessTransactionMs = Math.round(performance.now() - transactionStartedAt)
  const dirtyAfter = dirtyRows(db)
  const walAfter = await fileSize(walPath)
  parentPort.postMessage({
    ok: true,
    result: {
      ...committed,
      search_index: {
        status: dirtyAfter > 0 ? 'pending' : 'ready',
        queued_rows: dirtyAfter,
        queued_by_import: Math.max(0, dirtyAfter - dirtyBefore),
        processed_rows: 0,
        resumable: true
      }
    },
    metrics: {
      ...commitOperationMetrics,
      commit_ms: Math.round(performance.now() - startedAt),
      business_transaction_ms: businessTransactionMs,
      affected_rows: Number(committed.imported_rows ?? 0) + Number(committed.updated_rows ?? 0),
      search_index_queue_before: dirtyBefore,
      search_index_queue_after: dirtyAfter,
      search_index_queued_by_import: Math.max(0, dirtyAfter - dirtyBefore),
      search_index_processed_rows: 0,
      wal_before_bytes: walBefore,
      wal_after_bytes: walAfter,
      wal_growth_bytes: Math.max(0, walAfter - walBefore)
    }
  })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      status: Number.isInteger(error?.status) ? error.status : 500,
      code: String(error?.code ?? 'import_commit_worker_failed').slice(0, 120),
      message: String(error?.message ?? 'The import commit worker failed.').slice(0, 1_000),
      ...(error?.details !== undefined ? { details: error.details } : {})
    }
  })
} finally {
  store?.close()
  if (db?.open) db.close()
}
