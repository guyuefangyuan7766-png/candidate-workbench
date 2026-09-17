import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from 'node:worker_threads'
import { parseQueryPlan } from './search-query-plan.js'
import { hybridSearch, HybridSearchError } from './hybrid-search.js'
import { createSearchModelAdapters } from './search-model-adapters.js'
import { createVectorStore } from './search-vector-store.js'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const KIND = 'candidate-hybrid-search-v1'
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code, message, status = 400) => {
  throw new HybridSearchError(code, message, { status })
}
const boolean = (v, fallback) => {
  if (v === undefined) return fallback
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  fail('invalid_query', '布尔参数无效')
}
function integer(v, fallback, max) {
  const n = v === undefined ? fallback : Number(v)
  if (!Number.isInteger(n) || n < 1 || n > max)
    fail('invalid_query', '分页参数无效')
  return n
}
function list(v, allowed, max = 100) {
  const a =
    v === undefined || v === null || v === ''
      ? []
      : Array.isArray(v)
        ? v
        : String(v).split(',')
  if (
    a.length > max ||
    a.some(
      (x) =>
        typeof x !== 'string' ||
        !x.trim() ||
        x.length > 200 ||
        (allowed && !allowed.includes(x.trim()))
    )
  )
    fail('invalid_query', '筛选项无效')
  return [...new Set(a.map((x) => x.trim()))]
}
export function normalizeHybridInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('invalid_query', '检索参数无效')
  if ('plan' in input || 'sql' in input)
    fail('invalid_query', '客户端不能提交执行计划')
  const q = input.q ?? input.query ?? ''
  if (typeof q !== 'string' || q.length > 500)
    fail('invalid_query', '查询最多500字符')
  if (
    input.filters !== undefined &&
    (!input.filters ||
      typeof input.filters !== 'object' ||
      Array.isArray(input.filters))
  )
    fail('invalid_query', '筛选条件无效')
  const explicit = {
    ...(input.filters ?? {}),
    ...Object.fromEntries(
      Object.entries(input).filter(
        ([k, v]) => k !== 'filters' && v !== undefined
      )
    )
  }
  for (const [canonical, aliases] of Object.entries({
    min_years: ['minYears'],
    max_years: ['maxYears'],
    position_id: ['positionId'],
    talent_pool_id: ['talentPoolId', 'pool_id'],
    match_mode: ['matchMode']
  })) {
    if (explicit[canonical] === undefined)
      for (const alias of aliases)
        if (explicit[alias] !== undefined) {
          explicit[canonical] = explicit[alias]
          break
        }
    for (const alias of aliases) delete explicit[alias]
  }
  const sourceTypes = list(
    explicit.source_types ?? explicit.sourceTypes,
    ['candidate', 'profile_section', 'attachment'],
    3
  )
  const fields = [
    ...new Set(
      list(
        explicit.fields ?? explicit.field_paths ?? explicit.fieldPaths,
        [
          'title',
          'content',
          'candidate_resume_documents.title',
          'candidate_resume_documents.content'
        ],
        2
      ).map((f) => f.split('.').at(-1))
    )
  ]
  const candidateIds = list(
    explicit.candidate_ids ?? explicit.candidateIds,
    null,
    100
  )
  const archived =
    explicit.archived ??
    (boolean(explicit.include_archived, true) ? 'include' : 'exclude')
  if (!['exclude', 'include', 'only'].includes(archived))
    fail('invalid_query', '归档范围无效')
  const fast = boolean(input.fast, false)
  const includeTotal = boolean(input.include_total ?? input.includeTotal, !fast)
  if (fast && includeTotal)
    fail('invalid_query', '快速检索不能同时请求精确总数')
  const cursor = input.cursor ?? null
  if (cursor && (typeof cursor !== 'string' || cursor.length > 2048))
    fail('invalid_cursor', '分页凭据无效')
  const page = integer(input.page, 1, 10000)
  const pageSize = integer(
    input.page_size ?? input.pageSize ?? input.limit,
    20,
    100
  )
  const evidenceLimit = integer(
    input.evidence_limit ?? input.evidenceLimit,
    5,
    5
  )
  for (const k of ['min_years', 'max_years'])
    if (
      explicit[k] !== undefined &&
      (!Number.isFinite(Number(explicit[k])) ||
        Number(explicit[k]) < 0 ||
        Number(explicit[k]) > 80)
    )
      fail('invalid_query', '年限必须在0至80之间')
  if (
    !q.trim() &&
    ![
      'location',
      'min_years',
      'max_years',
      'stage',
      'position_id',
      'talent_pool_id',
      'keywords',
      'phrases'
    ].some((k) => explicit[k] !== undefined) &&
    !candidateIds.length
  )
    fail('invalid_query', '查询不能为空')
  const effective = {
    ...explicit,
    q,
    archived,
    source_types: sourceTypes,
    fields
  }
  for (const k of [
    'page',
    'page_size',
    'pageSize',
    'limit',
    'cursor',
    'fast',
    'include_total'
  ])
    delete effective[k]
  return {
    effective,
    q,
    page,
    pageSize,
    cursor,
    includeTotal,
    evidenceLimit,
    fields,
    sourceTypes,
    candidateIds,
    fingerprint: digest({ effective, pageSize, includeTotal, evidenceLimit })
  }
}
function fileStamp(path) {
  try { const s = statSync(path, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String) }
  catch { return null }
}
function manifestIdentity(directory) {
  if (!directory) return null
  const file = join(directory, 'manifest.json')
  try {
    if (statSync(file).size > 65536) return digest(['invalid', fileStamp(file)])
    return digest(readFileSync(file))
  } catch { return digest(['missing', fileStamp(file)]) }
}
function revision(db, databasePath) {
  // O(1) metadata: never aggregate over candidates or document rows. Persistent
  // connections make data_version meaningful; total_changes covers inline tests.
  return digest({
    files: databasePath ? [fileStamp(databasePath), fileStamp(`${databasePath}-wal`)] : null,
    fts: db.prepare('SELECT * FROM candidate_resume_fts_data WHERE id IN (1,10)').all(),
    changes: db.prepare('SELECT total_changes() n').get(),
    version: db.prepare('PRAGMA data_version').get()
  })
}
function runtime(options) {
  const db = options.db ?? new DatabaseSync(options.databasePath, { readOnly: true })
  // The file-backed connection already opens read-only, which keeps every write to
  // the resume database impossible while still allowing the temporary projection
  // tables a single search needs.
  if (!options.db) db.exec('PRAGMA busy_timeout=2000;')
  const adapters = options.adapters ?? createSearchModelAdapters(options.modelConfig ?? {})
  let store = null
  let vectorError = null
  const identity = manifestIdentity(options.vectorDirectory)
  try {
    if (options.vectorDirectory) store = createVectorStore({
      directory: options.vectorDirectory, readOnly: true, memoryMap: !options.db,
      dimensions: options.dimensions ?? 1024,
      model: options.modelConfig?.embeddingModel ?? process.env.SEARCH_EMBEDDING_MODEL ?? 'text-embedding-v4'
    })
  } catch (error) { vectorError = String(error.code ?? 'search_vector_not_ready') }
  const status = () => ({
    model: { remote_enabled: options.remoteEnabled === true, ...adapters.configured },
    vector: store ? { available: true, ...store.status() } : { available: false, generation: null, error: vectorError }
  })
  return { db, adapters, store, identity, status, close: () => { store?.close(); if (!options.db) db.close() } }
}
async function execute(resource, input, options) {
  const { db, adapters, store } = resource
  const before = revision(db, options.databasePath)
  if (manifestIdentity(options.vectorDirectory) !== resource.identity) fail('search_index_changed', '检索索引已变化，请重试', 409)
  store?.assertCurrent()
  const vectorRevision = store?.status().generation ?? null
  if (options.cached && (options.cached.revision !== before || options.cached.vectorRevision !== vectorRevision)) fail('search_cursor_stale', '数据或索引已变化，请重新检索', 409)
  const remote = options.remoteEnabled === true
  // Embedding only needs the original query; do not serialize it behind planning.
  // Cache pages reuse the saved ranking and never make another remote request.
  const embeddingController = new AbortController()
  const abortEmbedding = () => embeddingController.abort()
  options.signal?.addEventListener('abort', abortEmbedding, { once: true })
  if (options.signal?.aborted) abortEmbedding()
  const embedded = !options.cached && store && input.q.trim() && (!input.fields.length || input.fields.includes('content')) && remote && adapters.configured.embedding
    ? adapters.embedTexts([input.q], { dimensions: store.status().dimensions, signal: embeddingController.signal }).then(value => ({ value }), error => ({ error }))
    : null
  try {
  const plan = options.cached?.plan ?? await parseQueryPlan(input.effective, {
    planner: remote && adapters.configured.planner ? adapters.planner : undefined, signal: options.signal
  })
  const result = await hybridSearch(db, {
    plan, query: input.q, page: options.page ?? input.page, page_size: input.pageSize,
    evidenceLimit: input.evidenceLimit, fields: input.fields, sourceTypes: input.sourceTypes,
    candidateIds: input.candidateIds, includeTotal: input.includeTotal, vectorStore: store,
    embedTexts: embedded ? async () => { const outcome = await embedded; if (outcome.error) throw outcome.error; return outcome.value } : undefined,
    rerankDocuments: !options.cached && remote && adapters.configured.rerank ? adapters.rerankDocuments : undefined,
    snapshot: options.cached?.snapshot, signal: options.signal
  })
  if (revision(db, options.databasePath) !== before || manifestIdentity(options.vectorDirectory) !== resource.identity) fail('search_index_changed', '检索期间数据或索引已变化，请重试', 409)
  store?.assertCurrent()
  if (!result.degradation.some(d => d.stage === 'planning')) {
    if (remote && plan.metadata?.source !== 'model') result.degradation.push({ code: 'model_planning_unavailable', message: '查询理解暂不可用，已使用本地条件解析', stage: 'planning' })
    else if (!remote) result.degradation.push({ code: 'model_disabled', message: '当前使用本地条件解析', stage: 'planning' })
  }
  result.query = { raw: input.q, plan_source: plan.metadata?.source ?? 'rules' }
  result.performance.peak_rss_bytes = process.memoryUsage().rss
  const snapshot = result._snapshot
  delete result._snapshot
  return { result, cache: { revision: before, vectorRevision, plan, snapshot } }
  } finally {
    embeddingController.abort()
    options.signal?.removeEventListener('abort', abortEmbedding)
    if (embedded) await embedded
  }
}
function publicError(error) {
  if (error?.name === 'SearchPlanError' && ['invalid_query', 'invalid_search_plan'].includes(error.code)) return { code: error.code, message: '查询条件无效，请检查后重试', status: 400 }
  return {
    code: error instanceof HybridSearchError ? error.code : String(error?.code ?? '').startsWith('search_vector_') ? error.code : 'hybrid_search_failed',
    message: error instanceof HybridSearchError ? error.message : '检索暂不可用，请重试',
    status: error instanceof HybridSearchError ? error.status : 503
  }
}
if (!isMainThread && workerData?.kind === KIND) {
  let resource
  try {
    resource = runtime(workerData.options)
    parentPort.postMessage({ type: 'ready', status: resource.status() })
    let busy = false
    parentPort.on('message', async message => {
      if (message.type !== 'execute' || busy) return
      busy = true
      try {
        const value = await execute(resource, message.input, { ...workerData.options, ...message.options })
        parentPort.postMessage({ type: 'result', id: message.id, ok: true, value, status: resource.status() })
      } catch (error) { parentPort.postMessage({ type: 'result', id: message.id, ok: false, error: publicError(error) }) }
      finally { busy = false }
    })
    parentPort.on('close', () => resource.close())
  } catch (error) {
    resource?.close()
    parentPort.postMessage({ type: 'startup_error', error: publicError(error) })
    parentPort.close()
  }
}
export class HybridSearchService {
  constructor(options = {}) {
    this.options = options
    this.cache = new Map()
    this.workers = new Set()
    this.queue = []
    this.active = null
    this.workerHandle = null
    this.workerReady = false
    this.workerStarts = 0
    this.closed = false
    this.recycling = Promise.resolve()
    this.lastStatus = { model: { remote_enabled: options.remoteEnabled === true }, vector: { available: false, generation: null } }
    this.maxQueued = Number.isInteger(options.maxQueued) && options.maxQueued >= 0 ? Math.min(options.maxQueued, 32) : 8
    this.timeoutMs = Math.min(18000, Math.max(1, Number(options.requestTimeoutMs) || 18000))
    this.warmupTimeoutMs = Math.min(120000, Math.max(1, Number(options.warmupTimeoutMs) || 120000))
    // Worker startup opens the vector generation and the resume database, which is
    // I/O bound and unrelated to how fast a query can run. It gets its own bounded
    // budget so a cold start can no longer consume the whole query deadline.
    this.startupTimeoutMs = Math.min(this.warmupTimeoutMs, Math.max(this.timeoutMs, Number(options.startupTimeoutMs) || 60000))
  }
  status() {
    const current = this.identity === manifestIdentity(this.options.vectorDirectory)
    return { ...this.lastStatus, vector: { ...this.lastStatus.vector, loaded: !this.closed && this.workerReady, current }, closed: this.closed, worker: {
      running: Boolean(this.workerHandle || this.inline), ready: !this.closed && this.workerReady && current,
      starts: this.workerStarts, active: Boolean(this.active), queued: this.queue.length,
      max_queue: this.maxQueued, query_budget_ms: this.timeoutMs
    } }
  }
  warmup() {
    if (!this.warming) this.warming = this.enqueue(null, {}, undefined, true).then(() => this.status()).finally(() => { this.warming = null })
    return this.warming
  }
  async search(raw, { signal } = {}) {
    if (this.closed) fail('search_service_closed', '检索服务已关闭', 503)
    if (signal?.aborted) fail('search_cancelled', '检索已取消', 499)
    const input = normalizeHybridInput(raw)
    let cached = null
    let page = input.page
    let id = randomUUID()
    for (const [key, value] of this.cache) if (value.expires < Date.now()) this.cache.delete(key)
    if (input.cursor) {
      let token
      try { token = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) }
      catch { fail('invalid_cursor', '分页凭据无效') }
      const entry = this.cache.get(token?.id)
      if (!entry || entry.fingerprint !== input.fingerprint) fail('search_cursor_stale', '分页已过期或条件已变化，请重新检索', 409)
      page = integer(token.page, 1, 10000); cached = entry.cache; id = token.id
    }
    const output = await this.enqueue(input, { cached, page }, signal)
    if (signal?.aborted) fail('search_cancelled', '检索已取消', 499)
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(id, { fingerprint: input.fingerprint, cache: output.cache, expires: Date.now() + 300000 })
    output.result.pagination.current_cursor = Buffer.from(JSON.stringify({ id, page })).toString('base64url')
    if (output.result.pagination.has_more) output.result.pagination.next_cursor = Buffer.from(JSON.stringify({ id, page: page + 1 })).toString('base64url')
    return output.result
  }
  enqueue(input, options, signal, warmup = false) {
    if (this.closed) return Promise.reject(new HybridSearchError('search_service_closed', '检索服务已关闭', { status: 503 }))
    if (signal?.aborted) return Promise.reject(new HybridSearchError('search_cancelled', '检索已取消', { status: 499 }))
    if (this.active && this.queue.length >= this.maxQueued) return Promise.reject(new HybridSearchError('search_busy', '检索繁忙，请稍后重试', { status: 429 }))
    const pending = new Promise((resolve, reject) => {
      const task = { id: randomUUID(), input, options, signal, warmup, resolve, reject, done: false, controller: new AbortController() }
      task.cancel = () => this.finish(task, new HybridSearchError('search_cancelled', '检索已取消', { status: 499 }), null, this.active === task)
      task.timer = setTimeout(() => this.finish(task, new HybridSearchError('search_timeout', '检索超时，请重试', { status: 504 }), null, this.active === task), warmup ? this.warmupTimeoutMs : this.startupTimeoutMs)
      signal?.addEventListener('abort', task.cancel, { once: true })
      this.queue.push(task)
      this.pump()
    })
    // A deadline or a recycled worker can settle this task before its caller
    // attaches a handler. Marking it handled keeps a late settlement from taking
    // the whole service down; callers still observe the rejection.
    void pending.catch(() => {})
    return pending
  }
  pump() {
    if (this.active || this.closed) return
    const task = this.queue.shift()
    if (!task) return
    this.active = task
    void this.run(task).catch(error => this.finish(task, error))
  }
  finish(task, error, value, recycle = false) {
    if (task.done) return
    task.done = true
    clearTimeout(task.timer)
    task.signal?.removeEventListener('abort', task.cancel)
    if (error) task.controller.abort()
    if (recycle) void this.recycle()
    if (this.active === task) this.active = null
    else this.queue = this.queue.filter(item => item !== task)
    error ? task.reject(error) : task.resolve(value)
    this.pump()
  }
  recycle() {
    const worker = this.workerHandle
    this.workerHandle = null; this.workerReady = false; this.initializing = null
    if (this.inline) { this.inline.close(); this.inline = null }
    if (worker) {
      this.workers.delete(worker)
      this.recycling = this.recycling.then(() => worker.terminate()).catch(() => {})
    }
    return this.recycling
  }
  async ensureWorker() {
    await this.recycling
    if (this.closed) fail('search_service_closed', '检索服务已关闭', 503)
    const identity = manifestIdentity(this.options.vectorDirectory)
    if ((this.workerHandle || this.inline) && this.identity !== identity) await this.recycle()
    if (this.workerReady) return
    if (this.initializing) return this.initializing
    const options = {
      databasePath: this.options.databasePath, remoteEnabled: this.options.remoteEnabled === true,
      modelConfig: this.options.modelConfig, vectorDirectory: this.options.vectorDirectory, dimensions: this.options.dimensions
    }
    this.identity = identity
    if (this.options.db) {
      this.inline = runtime({ ...options, db: this.options.db, adapters: this.options.adapters })
      this.lastStatus = this.inline.status(); this.workerReady = true
      return
    }
    const worker = new Worker(new URL('./hybrid-search-service.js', import.meta.url), { workerData: { kind: KIND, options }, execArgv: [] })
    this.workerHandle = worker; this.workers.add(worker); this.workerStarts++
    this.initializing = new Promise((resolve, reject) => {
      let initialized = false
      const broken = error => {
        if (!initialized) reject(error)
        if (this.workerHandle !== worker) return
        const active = this.active
        if (active) this.finish(active, error, null, true)
        else void this.recycle()
      }
      worker.on('message', message => {
        if (this.workerHandle !== worker) return
        if (message.type === 'ready') {
          initialized = true; this.workerReady = true; this.lastStatus = message.status; resolve(); return
        }
        if (message.type === 'startup_error') { broken(new HybridSearchError(message.error.code, message.error.message, { status: message.error.status })); return }
        if (message.type !== 'result' || this.active?.id !== message.id) return
        const task = this.active
        if (manifestIdentity(this.options.vectorDirectory) !== this.identity) {
          this.finish(task, new HybridSearchError('search_index_changed', '检索索引已变化，请重试', { status: 409 }), null, true); return
        }
        if (message.ok) { this.lastStatus = message.status; this.finish(task, null, message.value) }
        else this.finish(task, new HybridSearchError(message.error.code, message.error.message, { status: message.error.status }), null, message.error.code === 'search_index_changed' || message.error.code.startsWith('search_vector_'))
      })
      worker.once('error', () => broken(new HybridSearchError('search_worker_error', '检索暂不可用', { status: 503 })))
      worker.once('exit', () => broken(new HybridSearchError('search_worker_exit', '检索已中断', { status: 503 })))
    })
    // Startup can be abandoned when a task settles first (a deadline or a recycle),
    // so the rejection must never be left unobserved.
    void this.initializing.catch(() => {})
    return this.initializing
  }
  async run(task) {
    await this.ensureWorker()
    if (task.done || this.closed) return
    if (task.warmup) { this.finish(task, null, this.lastStatus); return }
    // Startup is done, so the query now runs on its own deadline rather than on
    // whatever was left of the startup budget.
    clearTimeout(task.timer)
    task.timer = setTimeout(() => this.finish(task, new HybridSearchError('search_timeout', '检索超时，请重试', { status: 504 }), null, this.active === task), this.timeoutMs)
    if (this.inline) {
      const value = await execute(this.inline, task.input, { ...this.options, ...task.options, signal: task.controller.signal })
      if (!task.done) { this.lastStatus = this.inline.status(); this.finish(task, null, value) }
    } else this.workerHandle.postMessage({ type: 'execute', id: task.id, input: task.input, options: task.options })
  }
  async close() {
    if (this.closed) { await this.recycling; return }
    this.closed = true; this.cache.clear()
    for (const task of [this.active, ...this.queue].filter(Boolean)) this.finish(task, new HybridSearchError('search_service_closed', '检索服务已关闭', { status: 503 }))
    await this.recycle()
  }
}
