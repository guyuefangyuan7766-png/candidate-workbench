import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { synchronizeBusinessSearch } from './business-search.js'

function structuredError(error) {
  return {
    code: String(error?.code ?? 'search_index_worker_failed').slice(0, 100),
    message: String(error?.message ?? 'Search index worker failed.').slice(0, 500)
  }
}

function persistFailure(databasePath, error) {
  let db
  try {
    db = new DatabaseSync(databasePath)
    db.exec('PRAGMA busy_timeout = 5000')
    const checkpointExists = db.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'search_index_checkpoints_v2'
    `).get()
    if (!checkpointExists) return
    db.prepare(`
      UPDATE search_index_checkpoints_v2
      SET status = 'failed', completed_at = NULL, updated_at = ?, error_code = ?
      WHERE scope = 'full'
    `).run(new Date().toISOString(), structuredError(error).code)
  } catch {
    // The main process reports the worker failure even if SQLite is unavailable.
  } finally {
    try { db?.close() } catch {}
  }
}

const started = performance.now()
let db
try {
  db = new DatabaseSync(workerData.databasePath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
  const result = synchronizeBusinessSearch(db, {
    batchSize: workerData.batchSize,
    maxBatches: workerData.maxBatches ?? 1,
    // 后台维护只做增量：绝不允许它续跑历史遗留的全量回填队列，
    // 否则会形成「整库 190 万行、约 50 分钟一轮」的循环并占满 CPU/SQLite。
    allowBackfill: false
  })
  parentPort.postMessage({
    ok: true,
    result,
    duration_ms: Number((performance.now() - started).toFixed(1)),
    worker_peak_rss_bytes: process.memoryUsage().rss
  })
} catch (error) {
  persistFailure(workerData.databasePath, error)
  parentPort.postMessage({ ok: false, error: structuredError(error), duration_ms: Number((performance.now() - started).toFixed(1)) })
} finally {
  try { db?.close() } catch {}
}
