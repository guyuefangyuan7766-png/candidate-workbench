import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../../server/app.js'
import { createAgentService } from '../../server/agent.js'
import { insertCandidate } from '../../server/candidates.js'
import { createAgentSessionService } from '../../server/agent-sessions.js'
import { openDatabase } from '../../server/database.js'

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function listen(handler) {
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: String(error?.message ?? error) }))
  }))
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

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

function finalResponse(content) {
  return { model: 'anonymous-v9-model', choices: [{ message: { role: 'assistant', content } }] }
}

function toolResponse() {
  return {
    model: 'anonymous-v9-model',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'anonymous-query-callback',
          type: 'function',
          function: {
            name: 'query_candidates',
            arguments: JSON.stringify({ archived: 'exclude', page: 1, page_size: 1 })
          }
        }]
      }
    }]
  }
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

async function startFixture(gatewayHandler, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-agent-v9-'))
  const databasePath = join(directory, 'anonymous.db')
  const gateway = await listen(gatewayHandler)
  const { agentConfig: agentConfigOverrides = {}, ...appOptions } = options
  const app = createApp({
    ...appOptions,
    databasePath,
    agentExportRoot: join(directory, 'exports'),
    agentConfig: {
      baseUrl: `${gateway.url}/v1`,
      apiKey: 'anonymous-test-key',
      model: 'anonymous-v9-model',
      syncResponseWindowMs: 40,
      taskDeadlineMs: 5_000,
      maxConcurrentTasks: 2,
      maxQueuedTasks: 4,
      questionRouter: () => 'database',
      ...agentConfigOverrides
    }
  })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  insertCandidate(app.locals.db, {
    id: 'anonymous-v9-candidate',
    name: 'Anonymous V9 Candidate',
    phone: '13800000009',
    email: 'anonymous-v9@example.test',
    expected_salary: 'CNY 50000/month'
  })
  return {
    app,
    url: `http://127.0.0.1:${server.address().port}`,
    gatewayUrl: gateway.url,
    directory,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await app.closeDatabase()
      await gateway.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

async function createSession(url) {
  const response = await requestJson(`${url}/api/agent/sessions`, { method: 'POST', body: {} })
  assert.equal(response.response.status, 201)
  return response.body
}

async function waitForTask(url, taskId, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = (await requestJson(`${url}/api/agent/tasks/${taskId}`)).body.task
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`task did not reach expected state: ${latest?.status}`)
}

async function waitForDirectTask(agent, taskId, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = agent.getTask(taskId).task
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`direct task did not reach expected state: ${latest?.status}`)
}

function directAgentFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-agent-v9-direct-'))
  const databasePath = join(directory, 'anonymous.db')
  const db = openDatabase(databasePath, { synchronizeSearch: false })
  const readonlyQueryService = options.readonlyQueryService ?? {
    async queryTable() {
      return {
        rows: [{ id: 'anonymous-direct-candidate', name: 'Anonymous Direct Candidate' }],
        pagination: { page: 1, page_size: 1, has_more: false },
        returned_rows: 1,
        has_more: false
      }
    }
  }
  const agent = createAgentService(db, {
    baseUrl: 'https://anonymous-gateway.invalid/v1',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-v9-model',
    databasePath,
    readonlyQueryService,
    syncResponseWindowMs: 50,
    questionRouter: () => 'database',
    ...options.agentConfig
  })
  return {
    agent,
    db,
    async close() {
      await agent.close()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function jsonModelResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('V9 accepts long work asynchronously and duplicate client IDs replay the same task', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    calls += 1
    await gate
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, finalResponse('匿名延迟回答'))
      return
    }
    sendJson(res, toolResponse())
  })
  try {
    const session = await createSession(fixture.url)
    const body = { message: '匿名长任务', client_request_id: 'v9-idempotent-1' }
    const pending = requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, { method: 'POST', body })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const replay = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, { method: 'POST', body })
    assert.equal(replay.response.status, 202)
    assert.equal(replay.body.replayed, true)
    assert.ok(replay.body.task.task_id)
    assert.equal(calls, 1)
    release()
    const completed = await pending
    assert.equal(completed.response.status, 201)
    assert.equal(completed.body.state, 'completed')
    assert.equal(calls, 2)
  } finally {
    release()
    await fixture.close()
  }
})

test('V9 caller history truncation never sends an unpaired surrogate to the model', async () => {
  let planningPayload = null
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, finalResponse('completed with valid UTF-8 history'))
      return
    }
    planningPayload = payload
    sendJson(res, toolResponse())
  })
  try {
    const session = await createSession(fixture.url)
    const history = [
      { role: 'assistant', content: '\u{1F600}' },
      { role: 'user', content: 'a'.repeat(2_301) },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: 'a'.repeat(12_000)
      }))
    ]
    const result = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: {
        message: 'Use the bounded anonymous history',
        history,
        client_request_id: 'v9-surrogate-history-1'
      }
    })
    assert.equal(result.response.status, 201)
    assert.ok(planningPayload)
    assert.equal(planningPayload.messages.some((message) => hasUnpairedSurrogate(message.content)), false)
  } finally {
    await fixture.close()
  }
})

test('V9 retains database results and retry can continue with another tool before answering', async () => {
  let calls = 0
  let resumedPlanningPayload = null
  const question = 'Query the anonymous candidate before retrying'
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    calls += 1
    const resumed = payload.messages?.some((message) => String(message.content).includes('[Retained read-only evidence'))
    if (resumed) {
      if (!payload.messages?.some((message) => message.role === 'tool')) resumedPlanningPayload ??= payload
      if (payload.messages?.some((message) => message.role === 'tool')) {
        sendJson(res, finalResponse('基于续查结果的回答'))
        return
      }
      const continuation = toolResponse()
      continuation.choices[0].message.tool_calls[0].id = 'anonymous-query-continuation'
      continuation.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ archived: 'exclude', page: 2, page_size: 1 })
      sendJson(res, continuation)
      return
    }
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, { error: 'anonymous gateway failure' }, 503)
      return
    }
    if (payload.tools?.length === 0) {
      sendJson(res, finalResponse('基于已保留结果的回答'))
      return
    }
    sendJson(res, toolResponse())
  })
  try {
    const session = await createSession(fixture.url)
    const first = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: question, client_request_id: 'v9-partial-1' }
    })
    const taskId = first.body.task?.task_id || first.body.error?.details?.task_id
    assert.ok(taskId)
    const partial = await waitForTask(fixture.url, taskId, (task) => task.status === 'partial')
    assert.ok(partial.result)
    assert.ok(partial.result.tool_results?.length > 0)
    const partialResponse = (await requestJson(`${fixture.url}/api/agent/tasks/${taskId}`)).body
    const partialAnswer = partialResponse.assistant_message.content
    const currentSequence = fixture.app.locals.db.prepare(`
      SELECT sequence FROM agent_messages WHERE client_request_id = ?
    `).get('v9-partial-1').sequence
    fixture.app.locals.db.prepare(`
      INSERT INTO agent_session_summaries(
        id, session_id, through_sequence, summary_text, source_message_count,
        model, prompt_version, input_bytes, created_at
      ) VALUES (?, ?, ?, ?, 2, NULL, 1, ?, ?)
    `).run(
      'anonymous-current-partial-summary',
      session.id,
      currentSequence + 1,
      'CURRENT_PARTIAL_TURN_MUST_NOT_BE_REPLAYED',
      Buffer.byteLength('CURRENT_PARTIAL_TURN_MUST_NOT_BE_REPLAYED', 'utf8'),
      new Date().toISOString()
    )
    const toolCallsBeforeRetry = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits WHERE task_id = ? AND tool_name LIKE 'agent_tool_call:%'
    `).get(taskId).count
    const retry = await requestJson(`${fixture.url}/api/agent/tasks/${taskId}/retry-answer`, { method: 'POST' })
    assert.ok([200, 202].includes(retry.response.status))
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.error, null)
    const toolCallsAfterRetry = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits WHERE task_id = ? AND tool_name LIKE 'agent_tool_call:%'
    `).get(taskId).count
    assert.equal(toolCallsAfterRetry, toolCallsBeforeRetry + 1)
    assert.equal(calls, 6)
    assert.ok(resumedPlanningPayload)
    assert.equal(
      resumedPlanningPayload.messages.filter((message) => message.role === 'user' && message.content === question).length,
      1,
      'retry must append the current question once instead of replaying its completed partial turn from history'
    )
    assert.equal(
      resumedPlanningPayload.messages.some((message) => message.role === 'assistant' && message.content === partialAnswer),
      false
    )
    assert.equal(
      resumedPlanningPayload.messages.some((message) => String(message.content).includes('CURRENT_PARTIAL_TURN_MUST_NOT_BE_REPLAYED')),
      false,
      'a summary that already includes the partial turn must also be excluded from retry context'
    )
  } finally {
    await fixture.close()
  }
})

test('V9 does not trust an oversized notice-only snapshot and re-executes its query on retry', { timeout: 8_000 }, async () => {
  const sql = `
    SELECT id, self_summary FROM candidates
    WHERE id LIKE 'anonymous-large-%'
    ORDER BY id
  `
  let retrying = false
  let retryPlanningPayload = null
  const sendLargeQueryPlan = (res, id) => sendJson(res, {
    model: 'anonymous-v9-model',
    choices: [{ message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name: 'execute_readonly_query',
          arguments: JSON.stringify({ sql, max_rows: 20, max_bytes: 800_000 })
        }
      }]
    } }]
  })
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    const hasToolMessage = payload.messages?.some((message) => message.role === 'tool')
    if (retrying) {
      if (!hasToolMessage) {
        retryPlanningPayload = payload
        sendLargeQueryPlan(res, 'anonymous-large-retry')
        return
      }
      sendJson(res, finalResponse('completed from the re-executed oversized anonymous result'))
      return
    }
    if (!hasToolMessage) {
      sendLargeQueryPlan(res, 'anonymous-large-initial')
      return
    }
    sendJson(res, { error: 'anonymous composition outage' }, 503)
  })
  for (let index = 1; index <= 20; index += 1) {
    insertCandidate(fixture.app.locals.db, {
      id: `anonymous-large-${String(index).padStart(2, '0')}`,
      name: `Anonymous Large Candidate ${index}`,
      self_summary: 'x'.repeat(15_000)
    })
  }
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Read the oversized anonymous evidence', client_request_id: 'v9-oversized-retry-1' }
    })
    const taskId = submission.body.task?.task_id || submission.body.error?.details?.task_id
    assert.ok(taskId)
    const partial = await waitForTask(fixture.url, taskId, (task) => task.status === 'partial')
    const oversized = partial.result?.tool_results?.[0]
    assert.equal(oversized?.snapshot_truncated, true)
    assert.equal(oversized?.evidence_retained, false)
    assert.equal(oversized?.arguments?.sql, sql)
    assert.equal(partial.error.retained_result, false)

    retrying = true
    const retry = await requestJson(`${fixture.url}/api/agent/tasks/${taskId}/retry-answer`, { method: 'POST' })
    assert.ok([200, 202].includes(retry.response.status))
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.error, null)
    assert.ok(retryPlanningPayload)
    assert.equal(
      retryPlanningPayload.messages.some((message) => String(message.content).includes('[Retained read-only evidence')),
      false,
      'notice-only snapshots must not satisfy the retained evidence gate'
    )
    const auditedToolCalls = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'agent_tool_call:execute_readonly_query'
    `).get(taskId).count
    assert.equal(auditedToolCalls, 2)
  } finally {
    await fixture.close()
  }
})

test('V9 completes a supported question that needs more than the former four-tool budget', { timeout: 8_000 }, async () => {
  let gatewayCalls = 0
  const fixture = await startFixture(async (req, res) => {
    await readBody(req)
    gatewayCalls += 1
    if (gatewayCalls > 2) {
      sendJson(res, finalResponse('completed after collecting all six anonymous pages'))
      return
    }
    const pages = gatewayCalls === 1 ? [1, 2, 3, 4, 5] : [6]
    sendJson(res, {
      model: 'anonymous-v9-model',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: pages.map((page) => ({
            id: `anonymous-page-${page}`,
            type: 'function',
            function: {
              name: 'query_candidates',
              arguments: JSON.stringify({ archived: 'exclude', page, page_size: 1 })
            }
          }))
        }
      }]
    })
  })
  for (let index = 2; index <= 6; index += 1) {
    insertCandidate(fixture.app.locals.db, {
      id: `anonymous-v9-candidate-${index}`,
      name: `Anonymous V9 Candidate ${index}`,
      phone: `138000000${index}`,
      email: `anonymous-v9-${index}@example.test`
    })
  }
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Collect six anonymous pages before answering', client_request_id: 'v9-six-tools-1' }
    })
    assert.ok([201, 202].includes(submission.response.status))
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)

    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed', 6_000)
    assert.equal(completed.error, null)
    assert.equal(completed.deadline_at, null)
    assert.equal(completed.result?.tool_results?.length, 6)
    assert.equal(gatewayCalls, 3)
    const auditedToolCalls = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'agent_tool_call:query_candidates'
    `).get(taskId).count
    assert.equal(auditedToolCalls, 6)

    const taskResponse = (await requestJson(`${fixture.url}/api/agent/tasks/${taskId}`)).body
    assert.equal(taskResponse.assistant_message.content, 'completed after collecting all six anonymous pages')
    assert.equal(taskResponse.task.error?.code, undefined)
    const status = (await requestJson(`${fixture.url}/api/agent/status`)).body
    assert.equal(status.task_limits.max_tool_calls, null)
    assert.equal(status.task_limits.deadline_ms, null)
  } finally {
    await fixture.close()
  }
})

test('V9 stops duplicate tool loops and still produces a final evidence-based answer', { timeout: 6_000 }, async () => {
  let gatewayCalls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    gatewayCalls += 1
    if (payload.tools?.length === 0) {
      sendJson(res, finalResponse('final answer from the retained anonymous result'))
      return
    }
    const orderedArguments = gatewayCalls % 2 === 1
      ? { archived: 'exclude', page: 1, page_size: 1 }
      : { page_size: 1, page: 1, archived: 'exclude' }
    sendJson(res, {
      model: 'anonymous-v9-model',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `anonymous-duplicate-${gatewayCalls}`,
            type: 'function',
            function: {
              name: 'query_candidates',
              arguments: JSON.stringify(orderedArguments)
            }
          }]
        }
      }]
    })
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Avoid an anonymous duplicate loop', client_request_id: 'v9-duplicate-progress-1' }
    })
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.result?.tool_results?.length, 1)
    assert.equal(completed.error, null)
    assert.equal(gatewayCalls, 4)
    const auditedToolCalls = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'agent_tool_call:query_candidates'
    `).get(taskId).count
    assert.equal(auditedToolCalls, 1)
  } finally {
    await fixture.close()
  }
})

test('V9 canonicalizes SQL whitespace, comments, case, and a trailing terminator for duplicate detection', { timeout: 6_000 }, async () => {
  let gatewayCalls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    gatewayCalls += 1
    const toolMessages = payload.messages?.filter((message) => message.role === 'tool') ?? []
    if (toolMessages.length >= 2) {
      sendJson(res, finalResponse('completed from one canonical SQL result'))
      return
    }
    const first = toolMessages.length === 0
    sendJson(res, {
      model: 'anonymous-v9-model',
      choices: [{ message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: first ? 'anonymous-sql-canonical-1' : 'anonymous-sql-canonical-2',
          type: 'function',
          function: {
            name: 'execute_readonly_query',
            arguments: JSON.stringify(first
              ? {
                  sql: 'SELECT id FROM candidates WHERE id = ?',
                  parameters: ['anonymous-v9-candidate'],
                  max_rows: 1
                }
              : {
                  max_rows: 1,
                  parameters: ['anonymous-v9-candidate'],
                  sql: ' /* same query */ SeLeCt  id\nFROM candidates -- comment\n WHERE id = ? ; '
                })
          }
        }]
      } }]
    })
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Run one canonical anonymous SQL query', client_request_id: 'v9-sql-canonical-1' }
    })
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.error, null)
    assert.equal(completed.result?.tool_results?.length, 1)
    assert.equal(gatewayCalls, 3)
    const auditedToolCalls = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'agent_tool_call:execute_readonly_query'
    `).get(taskId).count
    assert.equal(auditedToolCalls, 1)
  } finally {
    await fixture.close()
  }
})

test('V9 treats repeated empty pages as one evidence result and then composes', { timeout: 6_000 }, async () => {
  let gatewayCalls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    gatewayCalls += 1
    if (payload.tools?.length === 0) {
      sendJson(res, finalResponse('no candidates were found in the verified empty result'))
      return
    }
    const page = 100 + gatewayCalls
    sendJson(res, {
      model: 'anonymous-v9-model',
      choices: [{ message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `anonymous-empty-page-${page}`,
          type: 'function',
          function: {
            name: 'query_candidates',
            arguments: JSON.stringify({ archived: 'exclude', page, page_size: 1 })
          }
        }]
      } }]
    })
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Verify an empty anonymous result without paging forever', client_request_id: 'v9-empty-evidence-1' }
    })
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.error, null)
    assert.equal(completed.result?.tool_results?.length, 1, 'only the first empty result is new evidence')
    assert.equal(gatewayCalls, 4)
    const auditedToolCalls = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'agent_tool_call:query_candidates'
    `).get(taskId).count
    assert.equal(auditedToolCalls, 3)
  } finally {
    await fixture.close()
  }
})

test('V9 rejects direct model text when no database tool evidence exists', async () => {
  let gatewayCalls = 0
  const fixture = await startFixture(async (req, res) => {
    await readBody(req)
    gatewayCalls += 1
    sendJson(res, finalResponse('unsupported direct answer without evidence'))
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Require verified anonymous evidence', client_request_id: 'v9-evidence-required-1' }
    })
    assert.equal(submission.response.status, 201)
    assert.equal(submission.body.state, 'failed')
    assert.equal(submission.body.task.error.code, 'agent_evidence_required')
    const taskId = submission.body.task.task_id
    const failed = await waitForTask(fixture.url, taskId, (task) => task.status === 'failed')
    assert.equal(failed.result, null)
    assert.equal(failed.error.code, 'agent_evidence_required')
    assert.equal(gatewayCalls, 2)
    const response = (await requestJson(`${fixture.url}/api/agent/tasks/${taskId}`)).body
    assert.equal(response.assistant_message, null)
  } finally {
    await fixture.close()
  }
})

test('V9 cancellation reaches a terminal state and does not leave the task polling forever', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fixture = await startFixture(async (req, res) => {
    await readBody(req)
    await gate
    sendJson(res, finalResponse('should not complete'))
  })
  try {
    const session = await createSession(fixture.url)
    const pending = requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: '取消匿名任务', client_request_id: 'v9-cancel-1' }
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const taskList = (await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/tasks?recoverable=1`)).body
    const active = taskList.items.find((task) => task.status === 'planning' || task.status === 'queued')
    assert.ok(active)
    const cancelled = await requestJson(`${fixture.url}/api/agent/tasks/${active.task_id}/cancel`, { method: 'POST' })
    assert.equal(cancelled.response.status, 200)
    release()
    const terminal = await waitForTask(fixture.url, active.task_id, (task) => task.status === 'cancelled')
    assert.equal(terminal.error.code, 'task_cancelled')
    await pending.catch(() => undefined)
  } finally {
    release()
    await fixture.close()
  }
})

test('V9 exposes 90 second default planning and composition budgets with a 120 second retry ceiling', async () => {
  const fixture = directAgentFixture()
  try {
    const status = fixture.agent.status()
    assert.equal(status.task_limits.model_planning_timeout_ms, 90_000)
    assert.equal(status.task_limits.model_composition_timeout_ms, 90_000)
    assert.equal(status.task_limits.model_planning_max_attempt_timeout_ms, 120_000)
    assert.equal(status.task_limits.model_composition_max_attempt_timeout_ms, 120_000)
    assert.equal(status.task_limits.model_max_attempts, 3)
  } finally {
    await fixture.close()
  }
})

test('V9 default model retries use 90, 120, and 120 second attempt budgets without waiting in real time', { timeout: 3_000 }, async () => {
  const fixture = directAgentFixture()
  const originalFetch = globalThis.fetch
  const originalAbortTimeout = AbortSignal.timeout
  const modelAttemptBudgets = []
  let modelRequests = 0
  try {
    AbortSignal.timeout = function immediateModelTimeout(milliseconds) {
      if (milliseconds >= 25_000) {
        modelAttemptBudgets.push(milliseconds)
        if (modelAttemptBudgets.length <= 2) {
          return AbortSignal.abort(new DOMException('anonymous model timeout', 'TimeoutError'))
        }
      }
      return originalAbortTimeout.call(AbortSignal, milliseconds)
    }
    globalThis.fetch = async (_url, init = {}) => {
      modelRequests += 1
      if (init.signal?.aborted) throw init.signal.reason
      const payload = JSON.parse(String(init.body ?? '{}'))
      return jsonModelResponse(
        payload.messages?.some((message) => message.role === 'tool')
          ? finalResponse('completed after two immediate simulated model timeouts')
          : toolResponse()
      )
    }

    const session = fixture.agent.createSession({ title: 'Default timeout budgets' })
    const submitted = await fixture.agent.querySession(session.id, {
      message: 'Complete after the anonymous model timeout retries',
      client_request_id: 'v9-default-model-timeout-retry-1'
    })
    const taskId = submitted.task.task_id
    const completed = await waitForDirectTask(fixture.agent, taskId, (task) => task.status === 'completed')

    assert.equal(completed.error, null)
    assert.deepEqual(modelAttemptBudgets.slice(0, 3), [90_000, 120_000, 120_000])
    assert.equal(modelRequests, 4)
    assert.equal(
      fixture.db.prepare(`
        SELECT COUNT(*) AS count FROM agent_query_audits
        WHERE task_id = ? AND tool_name = 'model_gateway_wait' AND error_code = 'model_timeout'
      `).get(taskId).count,
      2
    )
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalAbortTimeout
    await fixture.close()
  }
})

test('V9 composition timeout retries the model without executing retained tools twice', { timeout: 3_000 }, async () => {
  let queryTableCalls = 0
  const fixture = directAgentFixture({
    readonlyQueryService: {
      async queryTable() {
        queryTableCalls += 1
        return {
          rows: [{ id: 'anonymous-composition-retry', name: 'Anonymous Composition Retry' }],
          pagination: { page: 1, page_size: 1, has_more: false },
          returned_rows: 1,
          has_more: false
        }
      }
    }
  })
  const originalFetch = globalThis.fetch
  const originalAbortTimeout = AbortSignal.timeout
  const modelAttemptBudgets = []
  let modelRequests = 0
  try {
    AbortSignal.timeout = function immediateFirstCompositionTimeout(milliseconds) {
      if (milliseconds >= 25_000) {
        modelAttemptBudgets.push(milliseconds)
        if (modelAttemptBudgets.length === 2) {
          return AbortSignal.abort(new DOMException('anonymous composition timeout', 'TimeoutError'))
        }
      }
      return originalAbortTimeout.call(AbortSignal, milliseconds)
    }
    globalThis.fetch = async (_url, init = {}) => {
      modelRequests += 1
      if (init.signal?.aborted) throw init.signal.reason
      const payload = JSON.parse(String(init.body ?? '{}'))
      return jsonModelResponse(
        payload.messages?.some((message) => message.role === 'tool')
          ? finalResponse('composition recovered without duplicate tools')
          : toolResponse()
      )
    }

    const session = fixture.agent.createSession({ title: 'Composition retry' })
    const submitted = await fixture.agent.querySession(session.id, {
      message: 'Use anonymous evidence and retry only the composition',
      client_request_id: 'v9-composition-auto-retry-1'
    })
    const taskId = submitted.task.task_id
    const completed = await waitForDirectTask(fixture.agent, taskId, (task) => task.status === 'completed')
    const toolAudits = fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'agent_tool_call:query_candidates'
    `).get(taskId).count

    assert.equal(completed.error, null)
    assert.deepEqual(modelAttemptBudgets.slice(0, 3), [90_000, 90_000, 120_000])
    assert.equal(modelRequests, 3)
    assert.equal(queryTableCalls, 1)
    assert.equal(toolAudits, 1)
    assert.equal(
      fixture.db.prepare(`
        SELECT COUNT(*) AS count FROM agent_query_audits
        WHERE task_id = ? AND phase = 'composing'
          AND tool_name = 'model_gateway_wait' AND error_code = 'model_timeout'
      `).get(taskId).count,
      1
    )
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalAbortTimeout
    await fixture.close()
  }
})

test('V9 cancellation aborts an in-flight default-budget model request immediately', { timeout: 3_000 }, async () => {
  const fixture = directAgentFixture()
  const originalFetch = globalThis.fetch
  let gatewayStartedResolve
  let gatewayAbortedResolve
  const gatewayStarted = new Promise((resolve) => { gatewayStartedResolve = resolve })
  const gatewayAborted = new Promise((resolve) => { gatewayAbortedResolve = resolve })
  let gatewayRequests = 0
  let gatewayAborts = 0
  try {
    globalThis.fetch = async (_url, init = {}) => {
      gatewayRequests += 1
      gatewayStartedResolve()
      return new Promise((resolve, reject) => {
        const abort = () => {
          gatewayAborts += 1
          gatewayAbortedResolve()
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'))
        }
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener('abort', abort, { once: true })
      })
    }

    const session = fixture.agent.createSession({ title: 'Default timeout cancellation' })
    const submissionPromise = fixture.agent.querySession(session.id, {
      message: 'Cancel the anonymous default-budget request',
      client_request_id: 'v9-default-timeout-cancel-1'
    })
    await gatewayStarted
    const submitted = await submissionPromise
    const taskId = submitted.task.task_id

    fixture.agent.cancelTask(taskId)
    await gatewayAborted
    const cancelled = await waitForDirectTask(fixture.agent, taskId, (task) => task.status === 'cancelled')

    assert.equal(cancelled.error.code, 'task_cancelled')
    assert.equal(cancelled.error.retryable, false)
    assert.equal(gatewayRequests, 1)
    assert.equal(gatewayAborts, 1)
  } finally {
    globalThis.fetch = originalFetch
    await fixture.close()
  }
})

test('V9 cancellation aborts model retry backoff before another request starts', { timeout: 3_000 }, async () => {
  const fixture = directAgentFixture()
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  let stretchNextBackoff = false
  let backoffStartedResolve
  const backoffStarted = new Promise((resolve) => { backoffStartedResolve = resolve })
  let gatewayRequests = 0
  try {
    globalThis.setTimeout = function stretchedModelBackoff(callback, milliseconds, ...args) {
      if (stretchNextBackoff && milliseconds === 100) {
        stretchNextBackoff = false
        backoffStartedResolve()
        return originalSetTimeout(callback, 10_000, ...args)
      }
      return originalSetTimeout(callback, milliseconds, ...args)
    }
    globalThis.fetch = async () => {
      gatewayRequests += 1
      stretchNextBackoff = true
      throw new TypeError('anonymous gateway failure before retry backoff')
    }

    const session = fixture.agent.createSession({ title: 'Retry backoff cancellation' })
    const submitted = await fixture.agent.querySession(session.id, {
      message: 'Cancel the anonymous request during retry backoff',
      client_request_id: 'v9-model-backoff-cancel-1'
    })
    const taskId = submitted.task.task_id
    await backoffStarted

    const cancelledAt = performance.now()
    fixture.agent.cancelTask(taskId)
    const cancelled = await waitForDirectTask(fixture.agent, taskId, (task) => task.status === 'cancelled')
    const cancellationElapsedMs = performance.now() - cancelledAt
    await new Promise((resolve) => originalSetTimeout(resolve, 25))

    assert.equal(cancelled.error.code, 'task_cancelled')
    assert.equal(cancelled.error.retryable, false)
    assert.equal(gatewayRequests, 1)
    assert.ok(cancellationElapsedMs < 500, `retry backoff cancellation took ${cancellationElapsedMs} ms`)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    await fixture.close()
  }
})

test('V9 expands the model stage timeout on retry so a supported slow request can complete', { timeout: 7_000 }, async () => {
  let planningRequests = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, finalResponse('completed after the adaptive slow planning retry'))
      return
    }
    planningRequests += 1
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    sendJson(res, toolResponse())
  }, {
    agentConfig: {
      modelPlanningTimeoutMs: 1_000,
      syncResponseWindowMs: 50
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Complete the supported slow anonymous request', client_request_id: 'v9-adaptive-timeout-1' }
    })
    assert.equal(submission.response.status, 202)
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed', 5_000)
    assert.equal(completed.error, null)
    assert.equal(planningRequests, 2)
    const audits = fixture.app.locals.db.prepare(`
      SELECT error_code FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'model_gateway_wait'
    `).all(taskId)
    assert.equal(audits.filter((audit) => audit.error_code === 'model_timeout').length, 1)
    const status = (await requestJson(`${fixture.url}/api/agent/status`)).body
    assert.equal(status.task_limits.model_planning_timeout_ms, 1_000)
    assert.equal(status.task_limits.model_planning_max_attempt_timeout_ms, 4_000)
  } finally {
    await fixture.close()
  }
})

test('V9 persistent planning timeouts still become a stable failed task with stage metadata', { timeout: 11_000 }, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fixture = await startFixture(async (req, res) => {
    await readBody(req)
    await gate
    sendJson(res, finalResponse('late planning response'))
  }, {
    agentConfig: {
      modelPlanningTimeoutMs: 1_000,
      taskDeadlineMs: 5_000
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Trigger an anonymous planning timeout', client_request_id: 'v9-planning-timeout-1' }
    })
    assert.equal(submission.response.status, 202)
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)

    const failed = await waitForTask(fixture.url, taskId, (task) => task.status === 'failed', 9_000)
    assert.equal(failed.stage, 'failed')
    assert.equal(failed.result, null)
    assert.equal(failed.can_retry_answer, false)
    assert.deepEqual(failed.error, {
      code: 'model_timeout',
      stage: 'planning',
      message: failed.error.message,
      retryable: true,
      retained_result: false
    })

    const stable = (await requestJson(`${fixture.url}/api/agent/tasks/${taskId}`)).body.task
    assert.equal(stable.status, 'failed')
    assert.equal(stable.error.code, 'model_timeout')
    assert.equal(stable.completed_at, failed.completed_at)
  } finally {
    release()
    await fixture.close()
  }
})

test('V9 model timeout covers a response body that stalls after successful headers', { timeout: 11_000 }, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let requests = 0
  const fixture = await startFixture(async (req, res) => {
    await readBody(req)
    requests += 1
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.flushHeaders()
    await gate
    if (!res.destroyed) res.end(JSON.stringify(finalResponse('late response body')))
  }, {
    agentConfig: {
      modelPlanningTimeoutMs: 1_000
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Trigger a database model body timeout', client_request_id: 'v9-model-body-timeout-1' }
    })
    assert.equal(submission.response.status, 202)
    const taskId = submission.body.task.task_id
    const failed = await waitForTask(fixture.url, taskId, (task) => task.status === 'failed', 9_000)
    assert.equal(failed.error.code, 'model_timeout')
    assert.equal(failed.error.retryable, true)
    assert.equal(requests, 3)
    const audits = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits
      WHERE task_id = ? AND tool_name = 'model_gateway_wait' AND error_code = 'model_timeout'
    `).get(taskId).count
    assert.equal(audits, 3)
  } finally {
    release()
    await fixture.close()
  }
})

test('V9 rejects an oversized model response without retrying or retaining its body', { timeout: 5_000 }, async () => {
  let requests = 0
  const fixture = await startFixture(async (req, res) => {
    await readBody(req)
    requests += 1
    sendJson(res, finalResponse('x'.repeat(2 * 1024 * 1024 + 1_024)))
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Trigger a database oversized model response', client_request_id: 'v9-model-oversized-1' }
    })
    assert.ok([201, 202].includes(submission.response.status))
    const taskId = submission.body.task.task_id
    const failed = await waitForTask(fixture.url, taskId, (task) => task.status === 'failed')
    assert.equal(failed.error.code, 'agent_gateway_response_too_large')
    assert.equal(failed.error.retryable, false)
    assert.equal(failed.result, null)
    assert.equal(requests, 1)
  } finally {
    await fixture.close()
  }
})

test('V9 composition timeout retry may answer directly from sufficient retained evidence', { timeout: 11_000 }, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let toolPlanningCalls = 0
  let resumedCalls = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    if (payload.messages?.some((message) => String(message.content).includes('[Retained read-only evidence'))) {
      resumedCalls += 1
      sendJson(res, finalResponse('answer rebuilt from retained anonymous evidence'))
      return
    }
    if (payload.messages?.some((message) => message.role === 'tool')) {
      await gate
      sendJson(res, finalResponse('late composition response'))
      return
    }
    toolPlanningCalls += 1
    sendJson(res, toolResponse())
  }, {
    agentConfig: {
      modelCompositionTimeoutMs: 1_000,
      taskDeadlineMs: 5_000
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Query anonymous evidence before timing out', client_request_id: 'v9-composition-timeout-1' }
    })
    assert.equal(submission.response.status, 202)
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)

    const partial = await waitForTask(fixture.url, taskId, (task) => task.status === 'partial', 9_000)
    assert.equal(partial.stage, 'partial')
    assert.ok(partial.result?.tool_results?.length > 0)
    assert.ok(partial.result_count > 0)
    assert.equal(partial.can_retry_answer, true)
    assert.equal(partial.error.code, 'model_timeout')
    assert.equal(partial.error.stage, 'composing')
    assert.equal(partial.error.retryable, true)
    assert.equal(partial.error.retained_result, true)

    const recoverable = (await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/tasks?recoverable=1`)).body.items
    assert.ok(recoverable.some((task) => task.task_id === taskId && task.status === 'partial'))
    const toolCallsBeforeRetry = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits WHERE task_id = ? AND tool_name LIKE 'agent_tool_call:%'
    `).get(taskId).count

    const retry = await requestJson(`${fixture.url}/api/agent/tasks/${taskId}/retry-answer`, { method: 'POST' })
    assert.ok([200, 202].includes(retry.response.status))
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.error, null)
    assert.equal(completed.result_count, partial.result_count)
    const toolCallsAfterRetry = fixture.app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_query_audits WHERE task_id = ? AND tool_name LIKE 'agent_tool_call:%'
    `).get(taskId).count
    assert.equal(toolCallsAfterRetry, toolCallsBeforeRetry)
    assert.equal(toolPlanningCalls, 1)
    assert.equal(resumedCalls, 1)
  } finally {
    release()
    await fixture.close()
  }
})

test('V9 retry-answer bounds retained multibyte JSON by actual UTF-8 message bytes', { timeout: 6_000 }, async () => {
  let sentContextBytes = 0
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    sentContextBytes = Buffer.byteLength(JSON.stringify(payload.messages), 'utf8')
    sendJson(res, finalResponse('rebuilt from bounded multibyte evidence'))
  })
  try {
    const service = createAgentSessionService(fixture.app.locals.db)
    const session = service.createSession({ title: 'Multibyte retry evidence' })
    const turn = service.beginTurn(session.id, {
      message: 'Answer from large multibyte evidence',
      client_request_id: 'v9-multibyte-retry-1'
    })
    const task = service.createTask(turn, {
      task_id: 'v9-multibyte-retry-task',
      trace_id: 'v9-multibyte-retry-trace'
    })
    const snapshot = {
      tool_results: Array.from({ length: 20 }, (_, index) => ({
        tool: 'query_candidates',
        result: { rows: [{ id: `anonymous-${index}`, summary: '证'.repeat(12_000) }] }
      })),
      result_count: 20,
      has_more: false
    }
    service.completeTurn(turn, {
      answer: 'temporary partial answer',
      model: 'anonymous-v9-model',
      tools_used: [{ name: 'query_candidates' }],
      error_code: 'model_timeout'
    })
    service.updateTask(task.task_id, {
      status: 'partial',
      stage: 'partial',
      result: snapshot,
      result_count: 20,
      error_code: 'model_timeout',
      error_stage: 'composing',
      error_message: 'temporary timeout',
      retryable: true
    })

    const retry = await requestJson(`${fixture.url}/api/agent/tasks/${task.task_id}/retry-answer`, { method: 'POST' })
    assert.ok([200, 202].includes(retry.response.status))
    const completed = await waitForTask(fixture.url, task.task_id, (item) => item.status === 'completed')
    assert.equal(completed.error, null)
    assert.ok(sentContextBytes > 0)
    assert.ok(sentContextBytes <= 512 * 1024)
    const response = (await requestJson(`${fixture.url}/api/agent/tasks/${task.task_id}`)).body
    assert.equal(response.assistant_message.input_bytes, sentContextBytes)
    assert.equal(response.assistant_message.content, 'rebuilt from bounded multibyte evidence')
  } finally {
    await fixture.close()
  }
})

test('V9 keeps the question alive when an expanded read-only retry succeeds', async () => {
  const attemptTimeouts = []
  const readonlyQueryService = {
    async executeReadonlyQuery(request) {
      attemptTimeouts.push(request.timeoutMs)
      if (attemptTimeouts.length === 1) {
        const error = new Error(`Read-only query exceeded the ${request.timeoutMs} ms timeout.`)
        error.code = 'query_timeout'
        error.status = 408
        error.retryable = true
        throw error
      }
      return {
        rows: [{ recovered_value: 42 }],
        returned_rows: 1,
        has_more: false,
        truncated: false
      }
    }
  }
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, finalResponse('The expanded retry retained the successful database evidence.'))
      return
    }
    sendJson(res, {
      model: 'anonymous-v9-model',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'anonymous-sql-recovery-callback',
            type: 'function',
            function: {
              name: 'execute_readonly_query',
              arguments: JSON.stringify({ sql: 'SELECT 42 AS recovered_value', max_rows: 1 })
            }
          }]
        }
      }]
    })
  }, {
    agentConfig: {
      sqlTimeoutMs: 100,
      readonlyQueryService
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Retry this anonymous database query', client_request_id: 'v9-sql-recovery-1' }
    })
    assert.ok([201, 202].includes(submission.response.status))
    const taskId = submission.body.task.task_id
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.deepEqual(attemptTimeouts, [100, 400])
    assert.equal(completed.result_count, 1)
    assert.equal(completed.result.tool_results[0].result.rows[0].recovered_value, 42)
    assert.equal(completed.error, null)
  } finally {
    await fixture.close()
  }
})

test('V9 retries a SQL Worker timeout but does not complete without successful evidence', { timeout: 7_000 }, async () => {
  let sawTimeoutResult = false
  let timeoutToolContent = ''
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    const toolMessage = payload.messages?.findLast?.((message) => message.role === 'tool')
    if (toolMessage) {
      timeoutToolContent = String(toolMessage.content)
      sawTimeoutResult = timeoutToolContent.includes('query_timeout')
      sendJson(res, finalResponse('The anonymous SQL query timed out safely.'))
      return
    }
    sendJson(res, {
      model: 'anonymous-v9-model',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'anonymous-sql-timeout-callback',
            type: 'function',
            function: {
              name: 'execute_readonly_query',
              arguments: JSON.stringify({
                sql: `
                  WITH RECURSIVE endless(value) AS (
                    VALUES(1) UNION ALL SELECT value + 1 FROM endless
                  )
                  SELECT SUM(value) FROM endless
                `,
                max_rows: 1
              })
            }
          }]
        }
      }]
    })
  }, {
    agentConfig: {
      sqlTimeoutMs: 100,
      taskDeadlineMs: 5_000
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Trigger an anonymous SQL Worker timeout', client_request_id: 'v9-sql-timeout-1' }
    })
    assert.ok([201, 202].includes(submission.response.status))
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)

    const failed = await waitForTask(fixture.url, taskId, (task) => task.status === 'failed')
    assert.equal(failed.error.code, 'query_timeout')
    assert.equal(failed.result, null)
    assert.equal(failed.can_cancel, false)
    assert.equal(failed.can_retry_answer, false)

    const audits = fixture.app.locals.db.prepare(`
      SELECT tool_name, error_code FROM agent_query_audits WHERE task_id = ? ORDER BY created_at ASC
    `).all(taskId)
    assert.equal(sawTimeoutResult, true, JSON.stringify(audits))
    assert.match(timeoutToolContent, /1600 ms/, 'the third tool attempt should receive a substantially larger timeout allowance')
    assert.ok(audits.some((audit) => audit.error_code === 'query_timeout'))
    assert.equal(
      audits.filter((audit) => audit.tool_name === 'agent_tool_call:execute_readonly_query' && audit.error_code === 'query_timeout').length,
      3,
      'a retryable tool timeout should receive two expanded attempts before the model receives the error'
    )
    const status = (await requestJson(`${fixture.url}/api/agent/status`)).body
    assert.equal(status.task_limits.sql_timeout_ms, 100)
    assert.equal(status.task_limits.sql_max_attempt_timeout_ms, 1_600)
  } finally {
    await fixture.close()
  }
})

test('V9 persistent tasks have no overall wall-clock deadline and complete after the sync window', { timeout: 5_000 }, async () => {
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, finalResponse('completed without an overall deadline'))
      return
    }
    sendJson(res, toolResponse())
  }, {
    agentConfig: {
      modelPlanningTimeoutMs: 1_000,
      syncResponseWindowMs: 50,
      taskDeadlineMs: 50
    }
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Complete this anonymous persistent task', client_request_id: 'v9-no-overall-deadline-1' }
    })
    assert.equal(submission.response.status, 202)
    const taskId = submission.body.task?.task_id
    assert.ok(taskId)

    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed')
    assert.equal(completed.error, null)
    assert.equal(completed.deadline_at, null)
    assert.equal(completed.status, 'completed')
  } finally {
    await fixture.close()
  }
})

test('V9 service shutdown preserves an active task and startup resumes it with tools', { timeout: 8_000 }, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let resumedAgent = null
  const fixture = await startFixture(async (req, res) => {
    const payload = await readBody(req)
    await gate
    if (payload.messages?.some((message) => message.role === 'tool')) {
      sendJson(res, finalResponse('completed after automatic service recovery'))
      return
    }
    sendJson(res, toolResponse())
  })
  try {
    const session = await createSession(fixture.url)
    const submission = await requestJson(`${fixture.url}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { message: 'Resume this anonymous task after shutdown', client_request_id: 'v9-shutdown-resume-1' }
    })
    assert.equal(submission.response.status, 202)
    const taskId = submission.body.task.task_id

    await fixture.app.locals.agent.close()
    const interrupted = (await requestJson(`${fixture.url}/api/agent/tasks/${taskId}`)).body
    assert.equal(interrupted.task.status, 'queued')
    assert.equal(interrupted.task.error, null)
    assert.equal(interrupted.user_message.status, 'processing')
    assert.equal(interrupted.assistant_message, null)

    release()
    resumedAgent = createAgentService(fixture.app.locals.db, {
      baseUrl: `${fixture.gatewayUrl}/v1`,
      apiKey: 'anonymous-test-key',
      model: 'anonymous-v9-model',
      databasePath: join(fixture.directory, 'anonymous.db'),
      exportRoot: join(fixture.directory, 'resumed-exports'),
      syncResponseWindowMs: 50
    })
    const completed = await waitForTask(fixture.url, taskId, (task) => task.status === 'completed', 5_000)
    assert.equal(completed.error, null)
    const response = (await requestJson(`${fixture.url}/api/agent/tasks/${taskId}`)).body
    assert.equal(response.task.task_id, taskId)
    assert.equal(response.assistant_message.content, 'completed after automatic service recovery')
    assert.ok(response.task.result?.tool_results?.length > 0)
  } finally {
    release?.()
    await resumedAgent?.close()
    await fixture.close()
  }
})

test('V9 recovery exposes completed task evidence after service restart', async () => {
  const fixture = await startFixture(async (req, res) => sendJson(res, finalResponse('匿名回答')))
  const databasePath = join(fixture.directory, 'anonymous.db')
  try {
    const service = createAgentSessionService(fixture.app.locals.db)
    const session = service.createSession({ title: '恢复测试' })
    const turn = service.beginTurn(session.id, { message: '恢复问题', client_request_id: 'v9-recovery-1' })
    const task = service.createTask(turn, {
      task_id: 'v9-recovery-task',
      trace_id: 'v9-recovery-trace',
      deadline_at: new Date(Date.now() + 5_000).toISOString()
    })
    service.updateTask(task.task_id, {
      status: 'completed',
      stage: 'completed',
      result: { tool_results: [{ tool: 'query_candidates', result: { items: [{ id: 'anonymous-v9-candidate' }] } }] },
      result_count: 1
    })
    service.completeTurn(turn, { answer: '匿名回答', model: 'anonymous-v9-model', tools_used: [] })
    const recoveredTasks = service.listTasks(session.id, { recoverable: true })
    assert.equal(recoveredTasks.items[0].task_id, task.task_id)
    assert.equal(recoveredTasks.items[0].result_count, 1)
    assert.equal(databasePath.endsWith('anonymous.db'), true)
  } finally {
    await fixture.close()
  }
})

test('V9 recovery keeps cancelled tasks that retain database evidence', async () => {
  const fixture = await startFixture(async (req, res) => sendJson(res, finalResponse('匿名回答')))
  try {
    const service = createAgentSessionService(fixture.app.locals.db)
    const session = service.createSession({ title: '取消恢复测试' })
    const turn = service.beginTurn(session.id, { message: '保留取消结果', client_request_id: 'v9-cancel-recovery-1' })
    const task = service.createTask(turn, {
      task_id: 'v9-cancel-recovery-task',
      trace_id: 'v9-cancel-recovery-trace',
      deadline_at: new Date(Date.now() + 5_000).toISOString()
    })
    service.updateTask(task.task_id, {
      status: 'cancelled',
      stage: 'cancelled',
      result: { tool_results: [{ tool: 'query_candidates', result: { items: [{ id: 'anonymous-v9-candidate' }] } }] },
      result_count: 1,
      error_code: 'task_cancelled',
      error_message: '匿名取消测试'
    })
    const recoveredTasks = service.listTasks(session.id, { recoverable: true })
    assert.equal(recoveredTasks.items.length, 1)
    assert.equal(recoveredTasks.items[0].task_id, task.task_id)
    assert.equal(recoveredTasks.items[0].status, 'cancelled')
    assert.equal(recoveredTasks.items[0].result_count, 1)
  } finally {
    await fixture.close()
  }
})
