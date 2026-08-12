import { Worker } from 'node:worker_threads'

export class BusinessSearchMaintenanceService {
  constructor({
    databasePath,
    batchSize = 100,
    batchesPerRun = batchSize >= 100 ? 20 : 1,
    activeDelayMs = 25,
    idleDelayMs = 1_000,
    retryDelayMs = 2_000,
    workerTimeoutMs = 120_000,
    autoStart = true
  } = {}) {
    if (!databasePath || databasePath === ':memory:') {
      throw new TypeError('A file-backed databasePath is required for search index maintenance.')
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
      throw new TypeError('batchSize must be between 1 and 5000.')
    }
    if (!Number.isSafeInteger(batchesPerRun) || batchesPerRun < 1 || batchesPerRun > 20) {
      throw new TypeError('batchesPerRun must be between 1 and 20.')
    }
    if (!Number.isSafeInteger(workerTimeoutMs) || workerTimeoutMs < 1_000 || workerTimeoutMs > 600_000) {
      throw new TypeError('workerTimeoutMs must be between 1000 and 600000.')
    }
    this.databasePath = databasePath
    this.batchSize = batchSize
    this.batchesPerRun = batchesPerRun
    this.activeDelayMs = activeDelayMs
    this.idleDelayMs = idleDelayMs
    this.retryDelayMs = retryDelayMs
    this.workerTimeoutMs = workerTimeoutMs
    this.closed = false
    this.timer = null
    this.worker = null
    this.running = null
    this.lastResult = null
    this.lastError = null
    if (autoStart) this.kick()
  }

  schedule(delayMs) {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.runOnce().catch(() => undefined)
    }, delayMs)
    this.timer.unref?.()
  }

  kick() {
    this.schedule(0)
  }

  runOnce() {
    if (this.closed) return Promise.resolve(null)
    if (this.running) return this.running
    this.running = new Promise((resolve) => {
      const worker = new Worker(new URL('./business-search-worker.js', import.meta.url), {
        workerData: {
          databasePath: this.databasePath,
          batchSize: this.batchSize,
          maxBatches: this.batchesPerRun
        },
        // Node's test runner injects internal flags that workers reject. The
        // worker uses only stable built-in ESM/SQLite APIs, so an empty argv is
        // both portable and deterministic.
        execArgv: []
      })
      this.worker = worker
      let message = null
      let workerError = null
      const watchdog = setTimeout(() => {
        const error = new Error('Search index worker stopped responding.')
        error.code = 'search_index_worker_timeout'
        workerError = error
        void worker.terminate()
      }, this.workerTimeoutMs)
      watchdog.unref?.()
      worker.once('message', (value) => { message = value })
      worker.once('error', (error) => { workerError = error })
      worker.once('exit', (code) => {
        clearTimeout(watchdog)
        this.worker = null
        if (this.closed) {
          resolve(null)
          return
        }
        if (code !== 0 || workerError || !message?.ok) {
          this.lastError = message?.error ?? {
            code: String(workerError?.code ?? 'search_index_worker_exit'),
            message: String(workerError?.message ?? `Search index worker exited with code ${code}.`).slice(0, 500)
          }
          this.schedule(this.retryDelayMs)
          resolve({ ok: false, error: this.lastError })
          return
        }
        this.lastResult = message
        this.lastError = null
        const remaining = Number(message.result?.remaining_rows ?? 0)
        this.schedule(remaining > 0 ? this.activeDelayMs : this.idleDelayMs)
        resolve(message)
      })
    }).finally(() => {
      this.running = null
    })
    return this.running
  }

  status() {
    return {
      running: Boolean(this.worker),
      closed: this.closed,
      last_result: this.lastResult,
      last_error: this.lastError
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.worker) {
      try { await this.worker.terminate() } catch {}
    }
    try { await this.running } catch {}
  }
}
