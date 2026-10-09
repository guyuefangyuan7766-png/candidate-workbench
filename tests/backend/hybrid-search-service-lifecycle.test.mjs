import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { openDatabase } from '../../server/database.js'
import { insertCandidate } from '../../server/candidates.js'
import { HybridSearchService } from '../../server/hybrid-search-service.js'
import { parseRuleQueryPlan } from '../../server/search-query-plan.js'
import { buildVectorIndex } from '../../server/search-vector-maintenance.js'

const vector = () => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(body) {
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-service-life-'))
  const databasePath = join(directory, 'anonymous.db')
  const vectorDirectory = join(directory, 'vectors')
  const db = openDatabase(databasePath)
  const candidates = Array.from({ length: 4 }, (_, i) => insertCandidate(db, { name: `匿名${i}`, current_title: 'Unity 工程师' }))
  const services = []
  const make = options => { const service = new HybridSearchService({ databasePath, ...options }); services.push(service); return service }
  const build = () => buildVectorIndex({ databasePath, directory: vectorDirectory, embedTexts: async texts => texts.map(vector) })
  try { await body({ db, databasePath, vectorDirectory, candidates, make, build }) }
  finally { await Promise.all(services.map(service => service.close())); db.close(); rmSync(directory, { recursive: true, force: true }) }
}
async function gateway(body) {
  const calls = { planner: 0, embedding: 0, rerank: 0 }
  let onPlanner = async () => {}
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const data = JSON.parse(Buffer.concat(chunks).toString())
    let result
    if (request.url.endsWith('/chat/completions')) {
      calls.planner++; const behavior = await onPlanner()
      if (behavior?.status) { response.writeHead(behavior.status); response.end('anonymous upstream failure'); return }
      const query = JSON.parse(data.messages.at(-1).content).query
      const { metadata, ...plan } = parseRuleQueryPlan(query)
      result = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }] }
    } else if (request.url.endsWith('/embeddings')) { calls.embedding++; result = { data: data.input.map((_, index) => ({ index, embedding: vector() })) } }
    else { calls.rerank++; result = { results: data.documents.slice(0, data.top_n).map((_, index) => ({ index, relevance_score: 1-index/100 })) } }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const modelConfig = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'anonymous-only', allowLoopbackForTests: true }
  try { await body({ calls, modelConfig, setPlanner: fn => { onPlanner = fn } }) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('warmup and repeated queries reuse a single resident worker and stale pages detect database edits', async () => fixture(async ({ db, candidates, make }) => {
  const service = make()
  await service.warmup()
  const first = await service.search({ q: 'Unity', page_size: 1 })
  await service.search({ q: 'Unity', page_size: 1, cursor: first.pagination.next_cursor })
  assert.equal(service.status().worker.starts, 1)
  assert.equal(service.status().worker.ready, true)
  db.prepare('UPDATE candidates SET current_title=? WHERE id=?').run('Unreal', candidates[0].id)
  await assert.rejects(service.search({ q: 'Unity', page_size: 1, cursor: first.pagination.next_cursor }), { code: 'search_cursor_stale' })
  await service.close()
  assert.equal(service.status().worker.running, false)
}))

test('unrelated database writes do not invalidate a stable hybrid search snapshot', async () => gateway(async ({ modelConfig, setPlanner }) => fixture(async ({ db, make, build, vectorDirectory }) => {
  await build()
  const entered = deferred(); const release = deferred()
  setPlanner(async () => { entered.resolve(); await release.promise })
  const service = make({ modelConfig, remoteEnabled: true, vectorDirectory })
  await service.warmup()
  const pending = service.search({ q: 'Unity' })
  await entered.promise
  db.prepare(`
    INSERT INTO agent_query_audits(id, tool_name, query_scope, duration_ms, row_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('unrelated-audit', 'agent_response_assembly', '{}', 1, 0, new Date().toISOString())
  release.resolve()
  const result = await pending
  assert.equal(result.items.length, 4)
  assert.equal(service.status().worker.starts, 1)
})))

test('active manifest changes release the old mmap worker and invalidate its pagination snapshot', async () => fixture(async ({ db, vectorDirectory, make, build }) => {
  await build()
  const service = make({ vectorDirectory })
  await service.warmup()
  assert.equal(service.status().vector.memory_mapped, true)
  const generation = service.status().vector.generation
  const first = await service.search({ q: 'Unity', page_size: 1 })
  insertCandidate(db, { name: '匿名新增', current_title: 'Unity 技术美术' })
  await build()
  await assert.rejects(service.search({ q: 'Unity', page_size: 1, cursor: first.pagination.next_cursor }), { code: 'search_cursor_stale' })
  assert.equal(service.status().worker.starts, 2)
  assert.notEqual(service.status().vector.generation, generation)
  assert.equal((await service.search({ q: 'Unity' })).items.length, 5)
}))

test('the bounded queue rejects overflow, queued cancellation preserves the worker, active cancellation recycles it', async () => gateway(async ({ modelConfig, setPlanner }) => fixture(async ({ make }) => {
  const entered = deferred(); const release = deferred()
  setPlanner(async () => { entered.resolve(); await release.promise })
  const service = make({ modelConfig, remoteEnabled: true, maxQueued: 1 })
  await service.warmup()
  const activeAbort = new AbortController()
  const active = service.search({ q: 'Unity' }, { signal: activeAbort.signal })
  const activeRejected = assert.rejects(active, { code: 'search_cancelled' })
  await entered.promise
  const queuedAbort = new AbortController()
  const queued = service.search({ q: 'Unity' }, { signal: queuedAbort.signal })
  const queuedRejected = assert.rejects(queued, { code: 'search_cancelled' })
  await assert.rejects(service.search({ q: 'Unity' }), { code: 'search_busy' })
  queuedAbort.abort(); await queuedRejected
  assert.equal(service.status().worker.starts, 1)
  activeAbort.abort(); await activeRejected
  setPlanner(async () => {}); release.resolve()
  await service.search({ q: 'Unity' })
  assert.equal(service.status().worker.starts, 2)
})))

test('query deadline and close settle active and queued work and a later query recovers after timeout', async () => gateway(async ({ modelConfig, setPlanner }) => fixture(async ({ make }) => {
  const entered = deferred(); const release = deferred()
  setPlanner(async () => { entered.resolve(); await release.promise })
  const service = make({ modelConfig, remoteEnabled: true, requestTimeoutMs: 100 })
  await service.warmup()
  await assert.rejects(service.search({ q: 'Unity' }), { code: 'search_timeout' })
  setPlanner(async () => {}); release.resolve()
  await service.warmup()
  await service.search({ q: 'Unity' })
  const hanging = deferred(); const started = deferred()
  setPlanner(async () => { started.resolve(); await hanging.promise })
  const active = assert.rejects(service.search({ q: 'Unity' }), { code: 'search_service_closed' })
  await started.promise
  const queued = assert.rejects(service.search({ q: 'Unity' }), { code: 'search_service_closed' })
  await service.close(); hanging.resolve(); await Promise.all([active, queued])
  assert.equal(service.status().worker.running, false)
  await assert.rejects(service.search({ q: 'Unity' }), { code: 'search_service_closed' })
})))

test('planning overlaps query embedding and cached pages never repeat remote planning, embedding or rerank', async () => gateway(async ({ calls, modelConfig, setPlanner }) => fixture(async ({ make, build, vectorDirectory }) => {
  await build()
  setPlanner(async () => { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls.embedding, 1) })
  const service = make({ modelConfig, remoteEnabled: true, vectorDirectory })
  await service.warmup()
  const first = await service.search({ q: 'Unity', page_size: 1 })
  const before = { ...calls }
  await service.search({ q: 'Unity', page_size: 1, cursor: first.pagination.next_cursor })
  assert.deepEqual(calls, before)
  assert.deepEqual(before, { planner: 1, embedding: 1, rerank: 1 })
  assert.equal(service.status().worker.starts, 1)
})))

test('title-only searches never start an unused query embedding request', async () => gateway(async ({ calls, modelConfig }) => fixture(async ({ make, build, vectorDirectory }) => {
  await build()
  const service = make({ modelConfig, remoteEnabled: true, vectorDirectory })
  await service.warmup()
  const result = await service.search({ q: 'Unity', fields: ['title'] })
  assert.ok(Array.isArray(result.items))
  assert.equal(calls.embedding, 0)
  assert.ok(result.degradation.some(item => item.code === 'vector_title_scope'))
})))

test('an index publication during planning discards the old result, then the next worker warms the new generation', async () => gateway(async ({ modelConfig, setPlanner }) => fixture(async ({ db, make, build, vectorDirectory }) => {
  await build()
  const entered = deferred(); const release = deferred()
  setPlanner(async () => { entered.resolve(); await release.promise })
  const service = make({ modelConfig, remoteEnabled: true, vectorDirectory })
  await service.warmup()
  const pending = service.search({ q: 'Unity' })
  await entered.promise
  insertCandidate(db, { name: '匿名换代', current_title: 'Unity 工程师' }); await build()
  assert.equal(service.status().worker.ready, false)
  release.resolve(); const recovered = await pending; setPlanner(async () => {})
  assert.equal(recovered.items.length, 5)
  assert.equal(service.status().worker.starts, 2)
})))

test('failed remote planning preserves local results and status contains no gateway configuration', async () => gateway(async ({ modelConfig, setPlanner }) => fixture(async ({ make, vectorDirectory }) => {
  setPlanner(async () => ({ status: 503 }))
  const service = make({ modelConfig, remoteEnabled: true, vectorDirectory })
  const result = await service.search({ q: 'Unity' })
  assert.equal(result.items.length, 4)
  assert.equal(result.query.plan_source, 'rules')
  assert.ok(result.degradation.some(item => item.stage === 'planning'))
  assert.ok(result.degradation.some(item => item.code === 'vector_not_ready'))
  const state = JSON.stringify(service.status())
  assert.ok(!state.includes(modelConfig.baseUrl)); assert.ok(!state.includes(modelConfig.apiKey)); assert.ok(!state.includes(vectorDirectory))
})))

test('an unexpected resident-worker exit is recovered before the next query', async () => fixture(async ({ make }) => {
  const service = make()
  await service.warmup()
  await [...service.workers][0].terminate()
  assert.equal((await service.search({ q: 'Unity' })).items.length, 4)
  assert.equal(service.status().worker.starts, 2)
}))

test('invalid natural-language year ranges return a safe 400 without failing the resident service', async () => fixture(async ({ make }) => {
  const service = make()
  await assert.rejects(service.search({ q: '找5到3年经验的后端工程师' }), { code: 'invalid_query', status: 400 })
  assert.equal((await service.search({ q: 'Unity' })).items.length, 4)
  assert.equal(service.status().worker.starts, 1)
}))

test('early planning failure settles prestarted embedding before the caller observes rejection', async () => fixture(async ({ db, vectorDirectory, build }) => {
  await build()
  let settled = false
  const service = new HybridSearchService({ db, vectorDirectory, remoteEnabled: true, adapters: {
    configured: { planner: false, embedding: true, rerank: false },
    embedTexts: (_texts, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => { settled = true; reject(new Error('anonymous cancellation')) }, 20), { once: true })
    })
  } })
  try {
    await assert.rejects(service.search({ q: '找5到3年经验的后端工程师' }), { code: 'invalid_query' })
    assert.equal(settled, true)
  } finally { await service.close() }
}))

test('query deadline defaults to 30 seconds and caps larger requests at 120 seconds', async () => {
  const defaultBudget = new HybridSearchService({ db: {} })
  const longerRequest = new HybridSearchService({ db: {}, requestTimeoutMs: 60_000 })
  const beyondCap = new HybridSearchService({ db: {}, requestTimeoutMs: 600_000 })
  try {
    assert.equal(defaultBudget.status().worker.query_budget_ms, 30_000)
    // 正式库规模下高频宽泛词会打满 30 秒（2026-10-08 实测），上限放宽到 120 秒；
    // 仍然是显式有界预算，不接受无限等待。
    assert.equal(longerRequest.status().worker.query_budget_ms, 60_000)
    assert.equal(beyondCap.status().worker.query_budget_ms, 120_000)
  } finally {
    await Promise.all([defaultBudget.close(), longerRequest.close(), beyondCap.close()])
  }
})
