import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createSearchModelAdapters } from '../../server/search-model-adapters.js'

async function withGateway(handler, body) {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    await handler(request, response, JSON.parse(Buffer.concat(chunks).toString()))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await body({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'anonymous-test-key', allowLoopbackForTests: true })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
const reply = (response, value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }

test('embedding contract batches ten inputs and restores provider index order', async () => {
  assert.equal(typeof createSearchModelAdapters, 'function')
  const batches = []
  await withGateway((request, response, body) => {
    assert.equal(request.url, '/v1/embeddings')
    assert.equal(body.model, 'text-embedding-v4')
    batches.push(body.input.length)
    reply(response, { data: body.input.map((text, index) => ({ index, embedding: Array(512).fill(Number(text)) })).reverse() })
  }, async config => {
    const vectors = await createSearchModelAdapters(config).embedTexts(Array.from({ length: 11 }, (_, i) => String(i)), { dimensions: 512 })
    assert.equal(vectors.length, 11)
    assert.deepEqual(vectors.map(x => x[0]), [0,1,2,3,4,5,6,7,8,9,10])
  })
  assert.deepEqual(batches, [10, 1])
})

test('embedding rejects malformed dimensions, missing and duplicate indexes', async () => {
  for (const data of [
    [{ index: 0, embedding: [1,2] }],
    [],
    [{ index: 0, embedding: Array(512).fill(1) }, { index: 0, embedding: Array(512).fill(1) }],
  ]) await withGateway((_request, response) => reply(response, { data }), async config => {
    await assert.rejects(createSearchModelAdapters(config).embedTexts(['匿名文本'], { dimensions: 512 }), { code: 'search_embedding_invalid' })
  })
})

test('rerank honors actual results contract and rejects duplicate or out-of-bounds indexes', async () => {
  await withGateway((request, response, body) => {
    assert.equal(request.url, '/v1/rerank')
    assert.equal(body.return_documents, false)
    assert.equal(body.top_n, 2)
    reply(response, { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] })
  }, async config => {
    const ranking = await createSearchModelAdapters(config).rerankDocuments('战斗系统', ['匿名物流', '匿名战斗策划'], { topN: 2 })
    assert.deepEqual(ranking.map(x => x.index), [1, 0])
  })
  for (const results of [[{ index: 4, relevance_score: 1 }], [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }]]) {
    await withGateway((_request, response) => reply(response, { results }), async config => {
      await assert.rejects(createSearchModelAdapters(config).rerankDocuments('匿名', ['A', 'B'], { topN: 2 }), { code: 'search_rerank_invalid' })
    })
  }
})

test('chat planning sends strict schema and rejects refusal, truncation and unexpected fields', async () => {
  const valid = { version: 1, must: [{ kind: 'term', text: 'Unity', match: 'concept', evidence_scope: 'self', span: [0,5] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  const { searchQueryPlanSchema } = await import('../../server/search-query-plan.js')
  await withGateway((request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(body.model, 'gpt-6-astra')
    assert.equal(body.response_format.json_schema.strict, true)
    assert.equal(body.tools, undefined)
    reply(response, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }] })
  }, async config => assert.deepEqual(await createSearchModelAdapters(config).understandQuery('Unity', searchQueryPlanSchema), valid))
  for (const choice of [
    { finish_reason: 'length', message: { content: JSON.stringify(valid) } },
    { finish_reason: 'stop', message: { refusal: 'refused', content: null } },
    { finish_reason: 'stop', message: { content: JSON.stringify({ ...valid, sql: 'SELECT 1' }) } },
  ]) await withGateway((_request, response) => reply(response, { choices: [choice] }), async config => {
    await assert.rejects(createSearchModelAdapters(config).understandQuery('Unity', searchQueryPlanSchema), { code: 'search_planner_invalid' })
  })
})

test('query reasoning is isolated from the agent and explicit overrides win over search environment', async () => {
  const previous = Object.fromEntries(['AGENT_MODEL', 'SEARCH_QUERY_MODEL', 'SEARCH_QUERY_REASONING_EFFORT'].map(key => [key, process.env[key]]))
  const valid = { version: 1, must: [{ kind: 'term', text: 'Unity', match: 'concept', evidence_scope: 'self', span: [0,5] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  try {
    process.env.AGENT_MODEL = 'unrelated-agent-model'
    process.env.SEARCH_QUERY_MODEL = 'anonymous-fast-planner'
    process.env.SEARCH_QUERY_REASONING_EFFORT = 'none'
    for (const override of [undefined, 'minimal']) await withGateway((_request, response, body) => {
      assert.equal(body.model, 'anonymous-fast-planner')
      assert.equal(body.reasoning_effort, override ?? 'none')
      assert.equal(body.response_format.json_schema.strict, true)
      reply(response, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }] })
    }, async config => assert.deepEqual(await createSearchModelAdapters({ ...config, plannerReasoningEffort: override }).understandQuery('Unity'), valid))
    assert.equal(process.env.AGENT_MODEL, 'unrelated-agent-model')
    assert.throws(() => createSearchModelAdapters({ plannerReasoningEffort: 'arbitrary' }), { code: 'search_model_configuration_invalid' })
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('planner receives protected deterministic constraints while unknown concepts remain for model interpretation', async () => {
  const valid = { version: 1, must: [{ kind: 'filter', field: 'current_location', op: 'eq', value: '深圳', span: [0,2] }, { kind: 'term', text: '可观测性', match: 'concept', evidence_scope: 'self', span: [3,7] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  let requestData
  await withGateway((_request, response, body) => {
    requestData = JSON.parse(body.messages.at(-1).content)
    reply(response, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }] })
  }, async config => assert.deepEqual(await createSearchModelAdapters(config).understandQuery('深圳 可观测性'), valid))
  assert.equal(requestData.query, '深圳 可观测性')
  assert.equal(requestData.known_constraints.must[0].field, 'current_location')
  assert.equal(requestData.known_constraints.unresolved[0].text, '可观测性')
  assert.equal(requestData.known_constraints.metadata, undefined)
})

test('guided adapter resolves an unknown Boolean expression while retaining a protected exclusion', async () => {
  const { parseQueryPlan } = await import('../../server/search-query-plan.js')
  const query = '(可观测性 OR 链路追踪) AND NOT 外包'
  const term = text => ({ kind: 'term', text, match: 'concept', evidence_scope: 'self', span: [query.indexOf(text), query.indexOf(text)+text.length] })
  const valid = { version: 1, must: [{ kind: 'any', scope: 'candidate', children: [term('可观测性'), term('链路追踪')] }], should: [], minimum_should_match: 0, must_not: [term('外包')], unresolved: [] }
  await withGateway((_request, response) => reply(response, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }] }), async config => {
    const plan = await parseQueryPlan(query, { planner: createSearchModelAdapters(config).planner })
    assert.equal(plan.metadata.source, 'model')
    assert.equal(plan.must[0].kind, 'any')
    assert.deepEqual(plan.must[0].children.map(node => node.text), ['可观测性', '链路追踪'])
    assert.equal(plan.must_not[0].text, '外包')
    assert.deepEqual(plan.unresolved, [])
  })
})

test('gateway strict structural schema compatibility keeps local semantic and length validation', async () => {
  const { searchQueryPlanSchema } = await import('../../server/search-query-plan.js')
  const unsupported = new Set(['$schema', '$id', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'const'])
  const rejectedKeyword = object => object && typeof object === 'object' && Object.entries(object).some(([key, value]) => unsupported.has(key) || rejectedKeyword(value))
  const malformed = { version: 1, must: [{ kind: 'term', text: 'Unity', match: 'concept', evidence_scope: 'self', span: [0, 5, 99] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  let schemaAccepted = false
  await withGateway((_request, response, body) => {
    if (body.response_format.type !== 'json_schema' || body.response_format.json_schema.strict !== true || rejectedKeyword(body.response_format.json_schema.schema)) {
      response.writeHead(400)
      response.end('{}')
      return
    }
    schemaAccepted = true
    reply(response, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(malformed) } }] })
  }, async config => {
    await assert.rejects(createSearchModelAdapters(config).understandQuery('Unity', searchQueryPlanSchema), { code: 'search_planner_invalid' })
  })
  assert.equal(schemaAccepted, true)
  assert.ok(searchQueryPlanSchema.$defs.span.prefixItems)
})

test('gateway errors and redirects never expose address, key or provider body', async () => {
  for (const status of [302, 429, 500]) {
    await withGateway((_request, response) => { response.writeHead(status, { location: 'http://example.invalid/secret' }); response.end('provider secret failure body') }, async config => {
      await assert.rejects(createSearchModelAdapters(config).embedTexts(['匿名']), error => {
        assert.ok(!JSON.stringify(error).includes('provider secret'))
        assert.ok(!error.message.includes(config.apiKey))
        assert.ok(!error.message.includes(config.baseUrl))
        return true
      })
    })
  }
})

test('timeouts, cancellation and response-size limits fail without retained response text', async () => {
  await withGateway((_request, response) => { response.writeHead(200); response.write('{'); }, async config => {
    await assert.rejects(createSearchModelAdapters({ ...config, timeoutMs: 30 }).embedTexts(['匿名']), { code: 'search_model_timeout' })
  })
  await withGateway((_request, response) => reply(response, { data: 'x'.repeat(1024) }), async config => {
    await assert.rejects(createSearchModelAdapters({ ...config, maxResponseBytes: 100 }).embedTexts(['匿名']), { code: 'search_model_response_too_large' })
  })
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(createSearchModelAdapters({ baseUrl: 'https://example.invalid/v1', apiKey: 'anonymous' }).embedTexts(['匿名'], { signal: cancelled.signal }), { code: 'search_cancelled' })
})

test('outbound configuration requires HTTPS and allows loopback only by explicit test override', async () => {
  for (const baseUrl of ['http://example.invalid/v1', 'http://127.0.0.1/v1', 'https://169.254.169.254/v1', 'https://user:pass@example.invalid/v1']) {
    await assert.rejects(createSearchModelAdapters({ baseUrl, apiKey: 'anonymous' }).embedTexts(['匿名']), { code: 'search_model_endpoint_blocked' })
  }
  await assert.rejects(createSearchModelAdapters({ baseUrl: 'https://example.invalid/v1', apiKey: 'anonymous', allowedHosts: ['different.invalid'] }).embedTexts(['匿名']), { code: 'search_model_endpoint_blocked' })
})

test('DNS resolution rejects private and metadata destinations, while only named corporate hosts can use private HTTPS', async () => {
  for (const [address, trustedPrivateHosts] of [['127.0.0.1', []], ['10.10.10.10', []], ['169.254.169.254', ['gateway.example.invalid']], ['127.0.0.1', ['gateway.example.invalid']]]) {
    const adapters = createSearchModelAdapters({ baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'anonymous', dnsLookup: async () => [{ address, family: 4 }], trustedPrivateHosts })
    await assert.rejects(adapters.embedTexts(['匿名']), { code: 'search_model_endpoint_blocked' })
  }
})

test('gateway request pins the previously validated DNS address and preserves TLS verification', async () => {
  const { EventEmitter } = await import('node:events')
  let captured
  const adapters = createSearchModelAdapters({
    baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'anonymous', trustedPrivateHosts: ['gateway.example.invalid'],
    dnsLookup: async () => [{ address: '10.10.10.10', family: 4 }],
    httpsRequest: (_url, options, callback) => {
      captured = options
      const request = new EventEmitter()
      request.destroy = () => {}
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        response.headers = { 'content-type': 'application/json' }
        response.destroy = () => {}
        callback(response)
        response.emit('data', Buffer.from(JSON.stringify({ data: [{ index: 0, embedding: Array(512).fill(0.25) }] })))
        response.emit('end')
      })
      return request
    },
  })
  const vectors = await adapters.embedTexts(['匿名'], { dimensions: 512 })
  assert.equal(vectors[0][0], 0.25)
  assert.notEqual(captured.rejectUnauthorized, false)
  assert.equal(captured.servername, 'gateway.example.invalid')
  const addresses = await new Promise((resolve, reject) => captured.lookup('gateway.example.invalid', { all: true }, (error, result) => error ? reject(error) : resolve(result)))
  assert.deepEqual(addresses, [{ address: '10.10.10.10', family: 4 }])
})

test('rerank requires all requested indexes and checks the request size before sending', async () => {
  await withGateway((_request, response) => reply(response, { results: [{ index: 0, relevance_score: 1 }] }), async config => {
    await assert.rejects(createSearchModelAdapters(config).rerankDocuments('匿名', ['A', 'B'], { topN: 2 }), { code: 'search_rerank_invalid' })
  })
  await assert.rejects(createSearchModelAdapters({ baseUrl: 'https://example.invalid/v1', apiKey: 'anonymous' }).rerankDocuments('匿名', ['A'.repeat(300_000)]), { code: 'search_model_request_too_large' })
})

test('planner uses the bounded 30-second budget while embedding and rerank expire at 5 seconds', async t => {
  const { EventEmitter } = await import('node:events')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = process.env.SEARCH_QUERY_TIMEOUT_MS
  delete process.env.SEARCH_QUERY_TIMEOUT_MS
  try {
    for (const [method, configuredTimeout, expectedMs, maintenance] of [['planner', undefined, 30_000], ['embedding', 30_000, 5_000], ['rerank', 30_000, 5_000], ['planner', 20, 20], ['embedding', 20, 20], ['rerank', 20, 20], ['embedding', undefined, 30_000, true], ['embedding', 60_000, 30_000, true], ['rerank', 30_000, 5_000, true]]) {
      let started
      const requestStarted = new Promise(resolve => { started = resolve })
      const adapter = createSearchModelAdapters({
        baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'anonymous', timeoutMs: configuredTimeout, maintenance,
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        httpsRequest: () => { const request = new EventEmitter(); request.end = started; request.destroy = () => {}; return request },
      })
      let finished = false
      const result = (method === 'planner' ? adapter.understandQuery('Unity') : method === 'embedding' ? adapter.embedTexts(['匿名']) : adapter.rerankDocuments('匿名', ['匿名'])).catch(error => { finished = true; return error })
      await requestStarted
      t.mock.timers.tick(expectedMs - 1)
      for (let step = 0; step < 8; step++) await Promise.resolve()
      assert.equal(finished, false, method)
      t.mock.timers.tick(1)
      for (let step = 0; step < 8; step++) await Promise.resolve()
      assert.equal(finished, true, method)
      assert.equal((await result).code, 'search_model_timeout', method)
    }
  } finally {
    if (previous === undefined) delete process.env.SEARCH_QUERY_TIMEOUT_MS
    else process.env.SEARCH_QUERY_TIMEOUT_MS = previous
  }
})

test('SEARCH_QUERY_TIMEOUT_MS can shorten planning but cannot extend it beyond 30 seconds', async t => {
  const { EventEmitter } = await import('node:events')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = process.env.SEARCH_QUERY_TIMEOUT_MS
  try {
    for (const [setting, deadline] of [['25', 25], ['60000', 30_000]]) {
      process.env.SEARCH_QUERY_TIMEOUT_MS = setting
      let started
      const requestStarted = new Promise(resolve => { started = resolve })
      const adapter = createSearchModelAdapters({ baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'anonymous', dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }], httpsRequest: () => { const request = new EventEmitter(); request.end = started; request.destroy = () => {}; return request } })
      let finished = false
      const pending = adapter.understandQuery('Unity').catch(error => { finished = true; return error })
      await requestStarted
      t.mock.timers.tick(deadline)
      for (let step = 0; step < 8; step++) await Promise.resolve()
      assert.equal(finished, true)
      assert.equal((await pending).code, 'search_model_timeout')
    }
  } finally {
    if (previous === undefined) delete process.env.SEARCH_QUERY_TIMEOUT_MS
    else process.env.SEARCH_QUERY_TIMEOUT_MS = previous
  }
})
