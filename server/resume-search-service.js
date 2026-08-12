import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { getResumeSearchStatus, searchCandidateResumesIndexed } from './resume-search.js'

const WORKER_KIND = 'candidate-workbench-resume-search-v1'
const RETRYABLE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'search_worker_error',
  'search_worker_exit',
  'search_worker_timeout'
])

export class ResumeSearchServiceError extends Error {
  constructor(code, message, { status = 500, details, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ResumeSearchServiceError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function structuredWorkerError(error) {
  const status = Number(error?.status)
  const message = String(error?.message ?? 'Resume search failed.').slice(0, 500)
  const sqliteCode = Number(error?.errcode) === 5 || /database\s+(?:is\s+)?busy/i.test(message)
    ? 'SQLITE_BUSY'
    : Number(error?.errcode) === 6 || /database\s+(?:is\s+)?locked/i.test(message)
      ? 'SQLITE_LOCKED'
      : null
  return {
    code: sqliteCode ?? String(error?.code ?? 'resume_search_failed').slice(0, 100),
    message,
    status: sqliteCode ? 503 : Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    ...(error?.details && typeof error.details === 'object'
      ? { details: { ...error.details, ...(sqliteCode ? { retryable: true } : {}) } }
      : sqliteCode ? { details: { retryable: true } } : {})
  }
}

async function executeWorkerOperation() {
  const started = performance.now()
  let db
  try {
    db = new DatabaseSync(workerData.databasePath, { readOnly: true })
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
    if (workerData.operation === 'status') {
      const value = getResumeSearchStatus(db)
      parentPort.postMessage({
        ok: true,
        value,
        worker_duration_ms: Number((performance.now() - started).toFixed(1)),
        worker_peak_rss_bytes: process.memoryUsage().rss
      })
      return
    }
    if (workerData.operation !== 'search') {
      throw new ResumeSearchServiceError('invalid_operation', 'Unsupported resume search worker operation.')
    }
    const value = searchCandidateResumesIndexed(db, workerData.input ?? {}, { defaultFast: true })
    value.performance = {
      ...(value.performance ?? {}),
      worker_duration_ms: Number((performance.now() - started).toFixed(1)),
      worker_peak_rss_bytes: process.memoryUsage().rss
    }
    parentPort.postMessage({ ok: true, value })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: structuredWorkerError(error) })
  } finally {
    try { db?.close() } catch {}
    parentPort.close()
  }
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  void executeWorkerOperation()
}

export class ResumeSearchService {
  constructor({
    databasePath,
    workerTimeoutMs = 30_000,
    retryCount = 1,
    maxConcurrent = 2
  } = {}) {
    if (!databasePath || databasePath === ':memory:') {
      throw new TypeError('A file-backed databasePath is required for resume search workers.')
    }
    if (!Number.isSafeInteger(workerTimeoutMs) || workerTimeoutMs < 1_000 || workerTimeoutMs > 300_000) {
      throw new TypeError('workerTimeoutMs must be between 1000 and 300000.')
    }
    if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount > 3) {
      throw new TypeError('retryCount must be between 0 and 3.')
    }
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
      throw new TypeError('maxConcurrent must be between 1 and 8.')
    }
    this.databasePath = resolve(databasePath)
    this.workerTimeoutMs = workerTimeoutMs
    this.retryCount = retryCount
    this.maxConcurrent = maxConcurrent
    this.activeWorkers = new Set()
    this.closed = false
  }

  runOnce(operation, input, { signal } = {}) {
    if (this.closed) {
      return Promise.reject(new ResumeSearchServiceError('search_service_closed', 'Resume search service is closed.', { status: 503 }))
    }
    if (signal?.aborted) {
      return Promise.reject(new ResumeSearchServiceError('search_cancelled', 'Resume search was cancelled.', { status: 499 }))
    }
    if (this.activeWorkers.size >= this.maxConcurrent) {
      return Promise.reject(new ResumeSearchServiceError('search_busy', 'Resume search capacity is temporarily full.', {
        status: 429,
        details: { max_concurrent: this.maxConcurrent, retry_after_ms: 500 }
      }))
    }

    return new Promise((resolvePromise, rejectPromise) => {
      const worker = new Worker(new URL('./resume-search-service.js', import.meta.url), {
        workerData: {
          kind: WORKER_KIND,
          operation,
          databasePath: this.databasePath,
          input
        },
        execArgv: []
      })
      this.activeWorkers.add(worker)
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.activeWorkers.delete(worker)
        callback(value)
      }
      const cancel = () => {
        void worker.terminate()
        finish(rejectPromise, new ResumeSearchServiceError('search_cancelled', 'Resume search was cancelled.', { status: 499 }))
      }
      const timer = setTimeout(() => {
        void worker.terminate()
        finish(rejectPromise, new ResumeSearchServiceError('search_worker_timeout', 'Resume search worker stopped responding.', {
          status: 504,
          details: { timeout_ms: this.workerTimeoutMs, retryable: true }
        }))
      }, this.workerTimeoutMs)
      signal?.addEventListener('abort', cancel, { once: true })
      worker.once('message', (message) => {
        if (message?.ok) {
          finish(resolvePromise, message.value)
          return
        }
        const error = message?.error ?? {}
        finish(rejectPromise, new ResumeSearchServiceError(
          String(error.code ?? 'resume_search_failed'),
          String(error.message ?? 'Resume search failed.'),
          { status: Number(error.status) || 500, details: error.details }
        ))
      })
      worker.once('error', (error) => {
        finish(rejectPromise, new ResumeSearchServiceError('search_worker_error', 'Resume search worker failed.', {
          status: 503,
          details: { retryable: true },
          cause: error
        }))
      })
      worker.once('exit', (code) => {
        if (code !== 0) {
          finish(rejectPromise, new ResumeSearchServiceError('search_worker_exit', 'Resume search worker exited unexpectedly.', {
            status: 503,
            details: { retryable: true }
          }))
        }
      })
    })
  }

  async execute(operation, input, options = {}) {
    let lastError
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        return await this.runOnce(operation, input, options)
      } catch (error) {
        lastError = error
        if (options.signal?.aborted || !RETRYABLE_CODES.has(String(error?.code)) || attempt >= this.retryCount) throw error
      }
    }
    throw lastError
  }

  search(input, options) {
    return this.execute('search', input, options)
  }

  status(options) {
    return this.execute('status', null, options)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const workers = [...this.activeWorkers]
    await Promise.allSettled(workers.map((worker) => worker.terminate()))
    this.activeWorkers.clear()
  }
}
