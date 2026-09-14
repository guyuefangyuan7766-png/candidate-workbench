import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { buildVectorIndex } from './search-vector-maintenance.js'
import { createSearchModelAdapters } from './search-model-adapters.js'

const KIND = 'search-vector-maintenance-v1'
const safeError = error => /^search_[a-z_]+$/u.test(error?.code ?? '') ? error.code : 'search_vector_maintenance_failed'
const statusFile = directory => path.join(directory, 'maintenance-status.json')
export function readVectorMaintenanceStatus(directory) {
  if (!directory) return { enabled: false, state: 'disabled' }
  try { return JSON.parse(fs.readFileSync(statusFile(directory), 'utf8')) }
  catch { return { state: 'not_started' } }
}
function writeStatus(directory, value) {
  fs.mkdirSync(directory, { recursive: true })
  const temporary = path.join(directory, `maintenance-${randomUUID()}.tmp`)
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2))
  fs.renameSync(temporary, statusFile(directory))
}

// Aggregate counters only: never persist source text, identities or upstream errors.
export async function runVectorMaintenance(options, { signal, onProgress } = {}) {
  const started = new Date().toISOString()
  let lastWrite = 0
  const previous = readVectorMaintenanceStatus(options.directory)
  const lastSuccess = previous.last_success ?? null
  const publish = progress => {
    const value = { state: progress.stage, started_at: started, updated_at: new Date().toISOString(), last_success: lastSuccess, ...progress }
    if (Date.now() - lastWrite >= 5000 || progress.stage !== 'building') {
      writeStatus(options.directory, value); lastWrite = Date.now()
    }
    onProgress?.(value)
  }
  publish({ stage: 'starting' })
  try {
    const adapters = createSearchModelAdapters({ ...options.modelConfig, maintenance: true })
    if (!adapters.configured.embedding && !options.embedTexts) throw Object.assign(new Error('Embedding unavailable'), { code: 'search_embedding_unconfigured' })
    const report = await buildVectorIndex({ ...options, embedTexts: options.embedTexts ?? adapters.embedTexts, signal, onProgress: publish })
    const completed = new Date().toISOString()
    const value = { state: 'ready', stage: 'ready', started_at: started, updated_at: completed, completed_at: completed, last_success: completed, ...report }
    writeStatus(options.directory, value); onProgress?.(value)
    return value
  } catch (error) {
    const value = { state: signal?.aborted ? 'cancelled' : 'failed', started_at: started, updated_at: new Date().toISOString(), last_success: lastSuccess, error_code: safeError(error) }
    writeStatus(options.directory, value); onProgress?.(value)
    throw Object.assign(new Error('Vector maintenance did not complete'), { code: value.error_code })
  }
}

if (process.argv[2] === '--search-vector-maintenance-child' && process.send) {
  const controller = new AbortController()
  process.on('disconnect', () => controller.abort())
  let started = false
  process.on('message', async message => {
    if (message?.type === 'cancel') { controller.abort(); return }
    if (message?.kind !== KIND || started) return
    started = true; let lastProgress = 0
    const send = value => { if (process.connected) process.send(value) }
    try {
      const result = await runVectorMaintenance(message.options, { signal: controller.signal, onProgress: value => {
        if (Date.now() - lastProgress > 5000 || value.state !== 'building') { send({ type: 'progress', value }); lastProgress = Date.now() }
      } })
      send({ type: 'done', value: result })
    } catch (error) { send({ type: 'failed', code: safeError(error) }) }
    finally { if (process.connected) process.disconnect() }
  })
}

export class SearchVectorMaintenanceService {
  constructor(options) {
    this.options = options
    this.intervalMs = Math.max(30_000, Number(options.intervalMs) || 300_000)
    this.closed = false
    this.worker = null
    this.current = readVectorMaintenanceStatus(options.directory)
    this.timer = setTimeout(() => this.run(), Math.max(0, Number(options.initialDelayMs ?? 30_000)))
    this.timer.unref()
  }
  status() { return { enabled: true, running: Boolean(this.worker), interval_ms: this.intervalMs, ...this.current } }
  run() {
    if (this.closed || this.worker) return
    clearTimeout(this.timer)
    const { intervalMs, initialDelayMs, ...options } = this.options
    // A distinct PID makes the existing writer lock recoverable after crashes
    // or forced cancellation without deleting a live owner's lock.
    const worker = fork(fileURLToPath(import.meta.url), ['--search-vector-maintenance-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, execArgv: [] })
    this.worker = worker
    this.current = { ...this.current, state: 'starting' }
    let terminalMessage = false
    const persistStopped = (state, errorCode) => {
      const previous = this.current
      this.current = { state, stage: state, started_at: previous.started_at ?? null, updated_at: new Date().toISOString(), last_success: previous.last_success ?? null, error_code: errorCode }
      // Keep only bounded counters and timestamps, never a child error body.
      for (const key of ['documents', 'embedded_chunks', 'cached_chunks', 'retries']) if (Number.isSafeInteger(previous[key]) && previous[key] >= 0) this.current[key] = previous[key]
      writeStatus(options.directory, this.current)
    }
    worker.on('message', message => {
      if (message.type === 'progress' || message.type === 'done') {
        this.current = message.value
        if (message.type === 'done' && message.value?.state === 'ready') terminalMessage = true
      } else if (message.type === 'failed') {
        terminalMessage = true
        persistStopped(this.closed || this.current.state === 'cancelled' ? 'cancelled' : 'failed', safeError({ code: message.code }))
      }
    })
    worker.once('error', () => { this.current = { ...this.current, state: 'failed', error_code: 'search_vector_worker_error' } })
    worker.once('exit', (code, signal) => {
      if (this.worker === worker) this.worker = null
      if (this.closed && this.current.state !== 'ready') persistStopped('cancelled', 'search_cancelled')
      else if (signal || code !== 0 || !terminalMessage) persistStopped('failed', 'search_vector_worker_exit')
      if (!this.closed) {
        const next = this.current.state === 'ready' && this.current.source_changed_during_build ? 5000 : this.intervalMs
        this.timer = setTimeout(() => this.run(), next); this.timer.unref()
      }
    })
    worker.send({ kind: KIND, options })
  }
  async close() {
    this.closed = true; clearTimeout(this.timer)
    const worker = this.worker; if (!worker) return
    await new Promise(resolve => {
      const timer = setTimeout(() => { worker.kill() }, 10_000)
      worker.once('exit', () => { clearTimeout(timer); resolve() })
      if (worker.connected) worker.send({ type: 'cancel' })
    })
  }
}
