import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgentService } from '../../server/agent.js'
import { createApp } from '../../server/app.js'

const RUN_SLOW_ACCEPTANCE = process.env.RUN_SLOW_AGENT_ACCEPTANCE === '1'
const slowTest = RUN_SLOW_ACCEPTANCE ? test : test.skip
const MODEL_DELAY_MS = 9_000
const TOOL_STEPS = 13

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(response, body) {
  if (response.destroyed || response.writableEnded) return
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

async function startGateway() {
  let requestCount = 0
  const server = http.createServer((request, response) => {
    void (async () => {
      const payload = await readJsonBody(request)
      requestCount += 1
      await new Promise((resolve) => setTimeout(resolve, MODEL_DELAY_MS))
      const serialized = JSON.stringify(payload.messages ?? [])
      const completedSteps = [...serialized.matchAll(/long_step_(\d+)/g)]
        .reduce((maximum, match) => Math.max(maximum, Number(match[1]) || 0), 0)
      if (completedSteps >= TOOL_STEPS) {
        sendJson(response, {
          model: 'long-duration-model',
          choices: [{ message: { role: 'assistant', content: 'Completed after more than two minutes with all retained evidence.' } }]
        })
        return
      }
      const next = completedSteps + 1
      sendJson(response, {
        model: 'long-duration-model',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `long-duration-call-${next}`,
              type: 'function',
              function: {
                name: 'execute_readonly_query',
                arguments: JSON.stringify({ sql: `SELECT ${next} AS long_step_${next}`, max_rows: 1 })
              }
            }]
          }
        }]
      })
    })().catch((error) => {
      if (!response.destroyed) {
        response.statusCode = 500
        response.end(String(error?.message ?? error))
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get requestCount() { return requestCount },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

function readonlyService() {
  return {
    async executeReadonlyQuery(request) {
      const match = String(request.sql).match(/long_step_(\d+)/)
      const step = Number(match?.[1])
      assert.ok(Number.isInteger(step) && step >= 1 && step <= TOOL_STEPS)
      return {
        rows: [{ [`long_step_${step}`]: step }],
        row_count: 1,
        returned_rows: 1,
        has_more: false,
        truncated: false
      }
    }
  }
}

async function dashboardMustStayResponsive(url) {
  const startedAt = performance.now()
  const response = await requestJson(`${url}/api/dashboard`)
  assert.equal(response.response.status, 200)
  assert.ok(performance.now() - startedAt < 1_000, 'Dashboard should respond in under one second during Agent work')
}

async function waitUntil(startedAt, elapsedMs) {
  const remaining = elapsedMs - (Date.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}

slowTest('durable Agent task survives 6s, 30s, refresh polling, service restart, and two minutes', { timeout: 180_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-agent-long-'))
  const databasePath = join(directory, 'long-duration.db')
  const gateway = await startGateway()
  const injectedReadonly = readonlyService()
  const agentOptions = {
    baseUrl: `${gateway.url}/v1`,
    apiKey: 'long-duration-key',
    model: 'long-duration-model',
    databasePath,
    exportRoot: join(directory, 'exports'),
    readonlyQueryService: injectedReadonly,
    syncResponseWindowMs: 50,
    modelPlanningTimeoutMs: 20_000,
    modelCompositionTimeoutMs: 20_000
  }
  const app = createApp({
    databasePath,
    agentExportRoot: agentOptions.exportRoot,
    agentConfig: agentOptions
  })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${server.address().port}`
  let resumedAgent = null
  try {
    const session = await requestJson(`${url}/api/agent/sessions`, { method: 'POST', body: {} })
    assert.equal(session.response.status, 201)
    const startedAt = Date.now()
    const submitted = await requestJson(`${url}/api/agent/sessions/${session.body.id}/messages`, {
      method: 'POST',
      body: {
        message: 'Run this long database evidence task without an overall deadline',
        client_request_id: 'long-duration-request-1'
      }
    })
    assert.equal(submitted.response.status, 202)
    const taskId = submitted.body.task.task_id
    assert.ok(taskId)

    await waitUntil(startedAt, 6_500)
    const afterSixSeconds = await requestJson(`${url}/api/agent/tasks/${taskId}`)
    assert.equal(afterSixSeconds.response.status, 200)
    assert.ok(['planning', 'querying', 'retrieving', 'composing'].includes(afterSixSeconds.body.task.status))
    assert.equal(afterSixSeconds.body.task.deadline_at, null)
    await dashboardMustStayResponsive(url)

    await waitUntil(startedAt, 31_000)
    const afterThirtySeconds = await requestJson(`${url}/api/agent/tasks/${taskId}`)
    assert.equal(afterThirtySeconds.body.task.task_id, taskId)
    assert.ok(
      ['planning', 'querying', 'retrieving', 'composing'].includes(afterThirtySeconds.body.task.status),
      JSON.stringify(afterThirtySeconds.body.task)
    )
    assert.ok(afterThirtySeconds.body.task.result?.tool_results?.length >= 3)
    await dashboardMustStayResponsive(url)

    await app.locals.agent.close()
    const interrupted = await requestJson(`${url}/api/agent/tasks/${taskId}`)
    assert.equal(interrupted.body.task.status, 'queued')
    assert.ok(interrupted.body.task.result?.tool_results?.length >= 3)
    resumedAgent = createAgentService(app.locals.db, agentOptions)

    await waitUntil(startedAt, 120_500)
    const afterTwoMinutes = await requestJson(`${url}/api/agent/tasks/${taskId}`)
    assert.equal(afterTwoMinutes.body.task.task_id, taskId)
    assert.notEqual(afterTwoMinutes.body.task.status, 'failed')
    assert.notEqual(afterTwoMinutes.body.task.status, 'cancelled')
    assert.equal(afterTwoMinutes.body.task.deadline_at, null)
    await dashboardMustStayResponsive(url)

    const completionDeadline = Date.now() + 35_000
    let completed = afterTwoMinutes.body
    while (completed.task.status !== 'completed' && Date.now() < completionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      completed = (await requestJson(`${url}/api/agent/tasks/${taskId}`)).body
    }
    assert.equal(completed.task.status, 'completed')
    assert.ok(completed.task.elapsed_ms >= 120_000)
    assert.equal(completed.task.result_count, TOOL_STEPS)
    assert.equal(completed.task.result.tool_results.length, TOOL_STEPS)
    assert.equal(new Set(completed.task.result.tool_results.map((item) => item.arguments.sql)).size, TOOL_STEPS)
    assert.match(completed.assistant_message.content, /more than two minutes/)
    assert.ok(gateway.requestCount >= TOOL_STEPS + 1)
  } finally {
    await resumedAgent?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
    await gateway.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
