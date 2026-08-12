import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgentSessionService, AGENT_SESSION_LIMITS } from '../../server/agent-sessions.js'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

function removeDirectory(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body)
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function listen(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendModelResponse(res, content, model = 'anonymous-test-model') {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    model,
    choices: [{ message: { role: 'assistant', content } }]
  }))
}

function sendToolPlan(res, id = 'anonymous-session-query') {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    model: 'anonymous-test-model',
    choices: [{ message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name: 'query_candidates',
          arguments: JSON.stringify({ archived: 'exclude', page: 1, page_size: 1 })
        }
      }]
    } }]
  }))
}

function hasUnpairedSurrogate(value) {
  const text = String(value ?? '')
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) return true
  }
  return false
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待异步 Agent 会话状态超时')
}

async function startFixture(gatewayHandler = null, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-agent-v8-'))
  const databasePath = join(directory, 'anonymous.db')
  const gateway = gatewayHandler ? await listen(gatewayHandler) : null
  const { agentConfig: agentConfigOverrides = {}, ...appOptions } = options
  const app = createApp({
    ...appOptions,
    databasePath,
    agentExportRoot: join(directory, 'exports'),
    agentConfig: {
      ...(gateway
        ? { baseUrl: `${gateway.url}/v1`, apiKey: 'anonymous-test-key', model: 'anonymous-test-model' }
        : { baseUrl: '', apiKey: '', model: '' }),
      questionRouter: () => 'database',
      ...agentConfigOverrides
    }
  })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    app,
    databasePath,
    directory,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await app.closeDatabase()
      if (gateway) await gateway.close()
      removeDirectory(directory)
    }
  }
}

async function createSession(url, title) {
  const created = await requestJson(`${url}/api/agent/sessions`, {
    method: 'POST',
    body: title ? { title } : {}
  })
  assert.equal(created.response.status, 201)
  assert.match(created.response.headers.get('cache-control') ?? '', /private.*no-store/)
  return created.body
}

test('V8 session migration is additive and idempotent on an anonymous file database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-agent-migration-v8-'))
  const databasePath = join(directory, 'anonymous.db')
  let db
  try {
    db = openDatabase(databasePath)
    for (const table of ['agent_sessions', 'agent_messages', 'agent_session_summaries']) {
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.['1'], 1)
    }
    const migration = db.prepare('SELECT version, name FROM schema_migrations WHERE version = 8').get()
    assert.equal(migration.version, 8)
    assert.equal(migration.name, 'agent_sessions_and_full_business_search')
    db.close()
    db = null

    db = openDatabase(databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 8').get().count, 1)
    const sessions = createAgentSessionService(db)
    assert.equal(sessions.createSession({ title: '匿名迁移验收' }).title, '匿名迁移验收')
    db.close()
    db = null
  } finally {
    db?.close()
    removeDirectory(directory)
  }
})

test('session history UTF-8 truncation never splits a surrogate pair', async () => {
  const fixture = await startFixture()
  try {
    const service = createAgentSessionService(fixture.app.locals.db)
    const session = service.createSession({ title: 'UTF-8 boundary history' })
    const timestamp = new Date().toISOString()
    const insert = fixture.app.locals.db.prepare(`
      INSERT INTO agent_messages(
        id, session_id, sequence, role, content, status, tools_used_json, created_at, completed_at
      ) VALUES (?, ?, ?, 'assistant', ?, 'completed', '[]', ?, ?)
    `)
    insert.run('anonymous-surrogate-1', session.id, 1, '\u{1F600}', timestamp, timestamp)
    insert.run('anonymous-surrogate-2', session.id, 2, 'a'.repeat(2_301), timestamp, timestamp)
    for (let sequence = 3; sequence <= 10; sequence += 1) {
      insert.run(`anonymous-surrogate-${sequence}`, session.id, sequence, 'a'.repeat(12_000), timestamp, timestamp)
    }

    const context = service.contextForSession(session.id)
    assert.equal(context.context_bytes, AGENT_SESSION_LIMITS.maxHistoryBytes - 3)
    assert.equal(context.history.some((message) => hasUnpairedSurrogate(message.content)), false)
  } finally {
    await fixture.close()
  }
})

test('session CRUD, cursor pagination, archive, and permanent clear cascade through messages', async () => {
  const fixture = await startFixture()
  try {
    const session = await createSession(fixture.url, '匿名会话 CRUD')
    const service = createAgentSessionService(fixture.app.locals.db)
    for (let index = 1; index <= 3; index += 1) {
      const turn = service.beginTurn(session.id, {
        client_request_id: `crud-request-${index}`,
        message: `匿名问题 ${index}`
      })
      service.completeTurn(turn, {
        answer: `匿名回答 ${index}`,
        model: 'local-test',
        tools_used: []
      })
    }

    const firstPage = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages?page_size=2`)
    assert.equal(firstPage.response.status, 200)
    assert.deepEqual(firstPage.body.items.map((message) => message.sequence), [5, 6])
    assert.equal(firstPage.body.pagination.has_more, true)
    assert.equal(firstPage.body.pagination.next_before_sequence, 5)

    const secondPage = await requestJson(
      `${fixture.url}/api/agent/sessions/${session.id}/messages?page_size=2&before_sequence=5`
    )
    assert.deepEqual(secondPage.body.items.map((message) => message.sequence), [3, 4])

    const archived = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}`, {
      method: 'PATCH',
      body: { status: 'archived', title: '已归档匿名会话' }
    })
    assert.equal(archived.response.status, 200)
    assert.equal(archived.body.status, 'archived')
    assert.ok(archived.body.archived_at)

    const archivedList = await requestJson(`${fixture.url}/api/agent/sessions?status=archived&page_size=10`)
    assert.deepEqual(archivedList.body.items.map((item) => item.id), [session.id])
    assert.equal(archivedList.body.items[0].message_count, 6)

    const deleted = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}`, { method: 'DELETE' })
    assert.equal(deleted.response.status, 200)
    assert.deepEqual(deleted.body, { deleted: true, session_id: session.id })
    assert.equal(fixture.app.locals.db.prepare('SELECT COUNT(*) AS count FROM agent_messages').get().count, 0)
    assert.equal(fixture.app.locals.db.prepare('SELECT COUNT(*) AS count FROM agent_session_summaries').get().count, 0)

    const missing = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}`)
    assert.equal(missing.response.status, 404)
    assert.equal(missing.body.error.code, 'agent_session_not_found')
    assert.match(missing.response.headers.get('cache-control') ?? '', /private.*no-store/)
  } finally {
    await fixture.close()
  }
})

test('persistent turns carry server history and completed idempotent replays do not call the model twice', async () => {
  const modelRequests = []
  let answers = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readJsonBody(req)
    modelRequests.push(payload)
    if (!payload.messages?.some((message) => message.role === 'tool')) {
      sendToolPlan(res, `anonymous-turn-${modelRequests.length}`)
      return
    }
    answers += 1
    sendModelResponse(res, `匿名回答 ${answers}`)
  })
  try {
    const session = await createSession(fixture.url)
    const firstBody = { message: '第一轮匿名问题', client_request_id: 'turn-request-1' }
    const first = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: firstBody
    })
    assert.equal(first.response.status, 201)
    assert.equal(first.body.state, 'completed')
    assert.equal(first.body.replayed, false)
    assert.equal(first.body.assistant_message.content, '匿名回答 1')

    const replay = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: firstBody
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.body.replayed, true)
    assert.equal(replay.body.assistant_message.id, first.body.assistant_message.id)
    assert.equal(modelRequests.length, 2)

    const conflict = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '被篡改的内容', client_request_id: 'turn-request-1' }
    })
    assert.equal(conflict.response.status, 409)
    assert.equal(conflict.body.error.code, 'idempotency_conflict')

    const second = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '第二轮匿名问题', client_request_id: 'turn-request-2' }
    })
    assert.equal(second.response.status, 201)
    assert.equal(modelRequests.length, 4)
    const secondMessages = modelRequests[2].messages
    assert.deepEqual(
      secondMessages.slice(-3).map(({ role, content }) => ({ role, content })),
      [
        { role: 'user', content: '第一轮匿名问题' },
        { role: 'assistant', content: '匿名回答 1' },
        { role: 'user', content: '第二轮匿名问题' }
      ]
    )

    const legacy = await requestJson(`${fixture.url}/api/agent/query`, {
      method: 'POST',
      body: { message: '旧接口匿名问题', history: [{ role: 'user', content: '旧接口历史' }] }
    })
    assert.equal(legacy.response.status, 200)
    assert.equal(legacy.body.answer, '匿名回答 3')
    assert.match(legacy.response.headers.get('cache-control') ?? '', /private.*no-store/)

    const status = await requestJson(`${fixture.url}/api/agent/status`)
    assert.equal(status.body.persistent_sessions, true)

    const timingAudits = fixture.app.locals.db.prepare(`
      SELECT tool_name, query_scope, duration_ms, row_count
      FROM agent_query_audits
      WHERE tool_name IN ('model_gateway_wait', 'agent_response_assembly')
      ORDER BY created_at, id
    `).all()
    assert.ok(timingAudits.filter((row) => row.tool_name === 'model_gateway_wait').length >= 6)
    assert.ok(timingAudits.filter((row) => row.tool_name === 'agent_response_assembly').length >= 3)
    assert.ok(timingAudits.every((row) => row.duration_ms >= 0 && row.row_count === 0))
    const serializedTimingAudits = JSON.stringify(timingAudits)
    assert.equal(serializedTimingAudits.includes('第一轮匿名问题'), false)
    assert.equal(serializedTimingAudits.includes('匿名回答 1'), false)
  } finally {
    await fixture.close()
  }
})

test('processing replay returns 202 and a different request is rejected while the session is busy', async () => {
  let releaseGateway
  let gatewayStarted
  const started = new Promise((resolve) => { gatewayStarted = resolve })
  const gate = new Promise((resolve) => { releaseGateway = resolve })
  let calls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readJsonBody(req)
    calls += 1
    gatewayStarted()
    await gate
    if (!payload.messages?.some((message) => message.role === 'tool')) {
      sendToolPlan(res, `anonymous-busy-${calls}`)
      return
    }
    sendModelResponse(res, '延迟匿名回答')
  })
  try {
    const session = await createSession(fixture.url)
    const body = { message: '需要等待的匿名问题', client_request_id: 'busy-request-1' }
    const pending = requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body
    })
    await started

    const replay = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body
    })
    assert.equal(replay.response.status, 202)
    assert.equal(replay.body.state, 'processing')
    assert.equal(replay.response.headers.get('retry-after'), '1')

    const busy = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '并发匿名问题', client_request_id: 'busy-request-2' }
    })
    assert.equal(busy.response.status, 409)
    assert.equal(busy.body.error.code, 'session_busy')
    assert.equal(calls, 1)

    releaseGateway()
    const completed = await pending
    assert.equal(completed.response.status, 201)
    assert.equal(calls, 2)
  } finally {
    releaseGateway()
    await fixture.close()
  }
})

test('a stale processing replay is marked failed and releases its session lock', async () => {
  const fixture = await startFixture()
  try {
    const service = createAgentSessionService(fixture.app.locals.db)
    const session = service.createSession({ title: '匿名陈旧请求' })
    service.beginTurn(session.id, {
      message: '会中断的匿名请求',
      client_request_id: 'stale-request-1'
    })
    fixture.app.locals.db.prepare(`
      UPDATE agent_sessions SET active_request_started_at = ? WHERE id = ?
    `).run('2000-01-01T00:00:00.000Z', session.id)

    const replay = service.beginTurn(session.id, {
      message: '会中断的匿名请求',
      client_request_id: 'stale-request-1'
    })
    assert.equal(replay.kind, 'failed')
    assert.equal(replay.error_code, 'agent_interrupted')
    assert.equal(
      fixture.app.locals.db.prepare('SELECT active_request_id FROM agent_sessions WHERE id = ?').get(session.id).active_request_id,
      null
    )
    assert.equal(
      fixture.app.locals.db.prepare('SELECT status FROM agent_messages WHERE client_request_id = ?').get('stale-request-1').status,
      'failed'
    )

    const next = service.beginTurn(session.id, {
      message: '新的匿名请求',
      client_request_id: 'stale-request-2'
    })
    assert.equal(next.kind, 'started')
    service.failTurn(next, { code: 'test_cleanup' })
  } finally {
    await fixture.close()
  }
})

test('a transient gateway failure is retried before the turn completes and releases the lock', async () => {
  let calls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readJsonBody(req)
    calls += 1
    if (calls === 1) {
      res.statusCode = 503
      res.end('temporary failure')
      return
    }
    if (!payload.messages?.some((message) => message.role === 'tool')) {
      sendToolPlan(res, `anonymous-retry-${calls}`)
      return
    }
    sendModelResponse(res, '恢复后的匿名回答')
  })
  try {
    const session = await createSession(fixture.url)
    const retriedBody = { message: '首次失败请求', client_request_id: 'failed-request-1' }
    const retried = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: retriedBody
    })
    assert.equal(retried.response.status, 201)
    assert.equal(retried.body.state, 'completed')
    assert.equal(retried.body.assistant_message.content, '恢复后的匿名回答')
    assert.equal(calls, 3)
    assert.equal(
      fixture.app.locals.db.prepare('SELECT active_request_id FROM agent_sessions WHERE id = ?').get(session.id).active_request_id,
      null
    )
    assert.equal(
      fixture.app.locals.db.prepare('SELECT status FROM agent_messages WHERE client_request_id = ?').get('failed-request-1').status,
      'completed'
    )

    const completedReplay = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: retriedBody
    })
    assert.equal(completedReplay.response.status, 200)
    assert.equal(completedReplay.body.replayed, true)
    assert.equal(completedReplay.body.state, 'completed')
    assert.equal(completedReplay.body.task.error, null)

    const next = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '新的恢复请求', client_request_id: 'recovered-request-2' }
    })
    assert.equal(next.response.status, 201)
    assert.equal(next.body.assistant_message.content, '恢复后的匿名回答')
    assert.equal(calls, 5)
  } finally {
    await fixture.close()
  }
})

test('long-session replies do not wait for the single-flight background summary', async () => {
  const regularRequests = []
  const summaryRequests = []
  let summaryStartedResolve
  let releaseSummary
  const summaryStarted = new Promise((resolve) => { summaryStartedResolve = resolve })
  const summaryGate = new Promise((resolve) => { releaseSummary = resolve })
  const fixture = await startFixture(async (req, res) => {
    const payload = await readJsonBody(req)
    if (payload.response_format?.json_schema?.name === 'agent_session_summary') {
      summaryRequests.push(payload)
      summaryStartedResolve()
      await summaryGate
      sendModelResponse(res, JSON.stringify({ summary: '匿名历史摘要：保留已确认筛选条件。' }))
      return
    }
    regularRequests.push(payload)
    if (!payload.messages.some((message) => message.role === 'tool')) {
      sendToolPlan(res, `anonymous-summary-${regularRequests.length}`)
      return
    }
    sendModelResponse(res, `摘要测试回答 ${Math.ceil(regularRequests.length / 2)}`)
  })
  try {
    const session = await createSession(fixture.url)
    for (let index = 1; index <= 6; index += 1) {
      const result = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
        method: 'POST',
        body: { message: `摘要测试问题 ${index}`, client_request_id: `summary-request-${index}` }
      })
      assert.equal(result.response.status, 201)
    }

    const seventh = await withTimeout(
      requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
        method: 'POST',
        body: { message: '摘要测试问题 7', client_request_id: 'summary-request-7' }
      }),
      1_500,
      '当前回复被后台摘要阻塞'
    )
    assert.equal(seventh.response.status, 201)
    await withTimeout(summaryStarted, 1_500, '后台摘要未启动')
    assert.equal(
      fixture.app.locals.db.prepare('SELECT COUNT(*) AS count FROM agent_session_summaries').get().count,
      0
    )
    const eighthWhileSummaryRuns = await withTimeout(
      requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
        method: 'POST',
        body: { message: '摘要测试问题 8', client_request_id: 'summary-request-8' }
      }),
      1_500,
      '后台摘要阻塞了同一会话的下一轮回复'
    )
    assert.equal(eighthWhileSummaryRuns.response.status, 201)

    assert.equal(summaryRequests.length, 1)
    assert.equal(summaryRequests[0].response_format.json_schema.strict, true)
    assert.equal(Object.hasOwn(summaryRequests[0], 'tools'), false)
    assert.equal(Object.hasOwn(summaryRequests[0], 'tool_choice'), false)
    releaseSummary()
    const summaryRow = await waitFor(() => fixture.app.locals.db.prepare(`
        SELECT through_sequence, summary_text, input_bytes
        FROM agent_session_summaries WHERE session_id = ?
      `).get(session.id))
    assert.equal(summaryRow.summary_text, '匿名历史摘要：保留已确认筛选条件。')
    assert.equal(summaryRow.through_sequence, 8)
    assert.ok(summaryRow.input_bytes <= AGENT_SESSION_LIMITS.maxSummaryInputBytes)

    const ninth = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '摘要测试问题 9', client_request_id: 'summary-request-9' }
    })
    assert.equal(ninth.response.status, 201)
    const ninthContext = JSON.stringify(regularRequests.at(-1).messages)
    assert.match(ninthContext, /历史对话摘要/)
    assert.match(ninthContext, /匿名历史摘要：保留已确认筛选条件/)
    assert.equal(summaryRequests.length, 1)
  } finally {
    releaseSummary()
    await fixture.close()
  }
})

test('multiple large tool results share one 512 KiB model-message budget', async () => {
  const modelRequests = []
  const fixture = await startFixture(async (req, res) => {
    const payload = await readJsonBody(req)
    modelRequests.push(payload)
    res.setHeader('content-type', 'application/json')
    if (modelRequests.length === 1) {
      const args = JSON.stringify({
        sql: 'SELECT self_summary FROM candidates WHERE id = ?',
        parameters: ['anonymous-context-budget-candidate'],
        max_rows: 1
      })
      res.end(JSON.stringify({
        model: 'anonymous-test-model',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'large-call-1', type: 'function', function: { name: 'execute_readonly_query', arguments: args } },
              { id: 'large-call-2', type: 'function', function: { name: 'execute_readonly_query', arguments: args } }
            ]
          }
        }]
      }))
      return
    }
    sendModelResponse(res, '已使用受控上下文预算。')
  })
  try {
    insertCandidate(fixture.app.locals.db, {
      id: 'anonymous-context-budget-candidate',
      name: 'Anonymous Context Budget Candidate',
      self_summary: 'x'.repeat(300_000)
    }, { hydrate: false })
    const session = await createSession(fixture.url)
    const result = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '读取两次匿名大字段', client_request_id: 'context-budget-request' }
    })
    assert.equal(result.response.status, 201)
    assert.equal(modelRequests.length, 2)
    const secondMessages = modelRequests[1].messages
    assert.ok(Buffer.byteLength(JSON.stringify(secondMessages), 'utf8') <= 512 * 1024)
    const toolMessages = secondMessages.filter((message) => message.role === 'tool')
    assert.equal(toolMessages.length, 2)
    assert.equal(toolMessages.some((message) => message.content.includes('tool_result_too_large')), true)
    assert.ok(result.body.assistant_message.input_bytes <= 512 * 1024)
  } finally {
    await fixture.close()
  }
})
