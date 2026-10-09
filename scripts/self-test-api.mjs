#!/usr/bin/env node
// 全功能自检：对本地已启动的服务打一遍主要只读接口 + 一轮 AI 助手问答。
//
//   node scripts/self-test-api.mjs                       # 全量（含 AI 助手，会走模型网关）
//   node scripts/self-test-api.mjs --skip-agent          # 跳过 AI 助手（省费用）
//   node scripts/self-test-api.mjs --base http://127.0.0.1:4173
//   node scripts/self-test-api.mjs --cookie "tw_session=<值>"   # 服务开启 AUTH_ENABLED 时带上登录态
//
// 报告写 data/self-test-report.json；任一检查失败时进程退出码为 1。
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

const baseIndex = process.argv.indexOf('--base')
const BASE = String(baseIndex >= 0 ? process.argv[baseIndex + 1] : 'http://127.0.0.1:4173').replace(/\/+$/u, '')
const cookieIndex = process.argv.indexOf('--cookie')
const COOKIE = String(cookieIndex >= 0 ? process.argv[cookieIndex + 1] : (process.env.SELF_TEST_COOKIE ?? '')).trim()
const skipAgent = process.argv.includes('--skip-agent')
const reportPath = resolve('data/self-test-report.json')
const startedAt = Date.now()
const checks = []

async function call(name, path, { method = 'GET', body = null, timeoutMs = 120_000 } = {}) {
  const started = Date.now()
  const entry = { name, method, path, ok: false, status: null, ms: 0, detail: null }
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(COOKIE ? { cookie: COOKIE } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })
    entry.status = response.status
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* CSV/HTML 等非 JSON 响应 */ }
    entry.ok = response.ok
    entry.json = json
    entry.bytes = text.length
    if (!response.ok) entry.detail = text.slice(0, 200)
  } catch (error) {
    entry.detail = String(error?.message ?? error).slice(0, 200)
  }
  entry.ms = Date.now() - started
  checks.push(entry)
  console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name} ${entry.status ?? '-'} ${entry.ms}ms${entry.detail ? ` :: ${entry.detail}` : ''}`)
  return entry
}

function assert(name, condition, detail = '') {
  const entry = { name, ok: Boolean(condition), status: 'assert', ms: 0, detail: condition ? null : detail }
  checks.push(entry)
  console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${entry.ok ? '' : ` :: ${detail}`}`)
  return entry
}

const health = await call('health', '/api/health')
assert('health.status=ok', health.json?.status === 'ok')

const dashboard = await call('dashboard', '/api/dashboard')
assert('dashboard 有统计字段', Boolean(dashboard.json && Object.keys(dashboard.json).length))

const list = await call('candidates.list', '/api/candidates?page_size=5')
const firstCandidate = list.json?.items?.[0] ?? list.json?.data?.[0] ?? null
assert('candidates 列表非空', Array.isArray(list.json?.items ?? list.json?.data) && (list.json?.items ?? list.json?.data).length > 0)

await call('candidates.facets', '/api/candidates/facets')
await call('positions.list', '/api/positions?page_size=5')
await call('talent-pools.list', '/api/talent-pools')

if (firstCandidate?.id) {
  const detail = await call('candidate.detail', `/api/candidates/${firstCandidate.id}`)
  const detailKeys = Object.keys(detail.json ?? {})
  assert('候选人详情返回主体', detailKeys.length > 0, detailKeys.join(',').slice(0, 120))
  const attachments = await call('candidate.attachments', `/api/candidates/${firstCandidate.id}/attachments`)
  await call('candidate.notes', `/api/candidates/${firstCandidate.id}/notes`)
  await call('candidate.activities', `/api/candidates/${firstCandidate.id}/activities`)
  await call('candidate.positions', `/api/candidates/${firstCandidate.id}/positions`)
  // profile-sections / preferences 是 PUT 写接口，只读自检不调用；详情里已包含这两块数据。
  const attachmentId = attachments.json?.items?.[0]?.id ?? attachments.json?.data?.[0]?.id ?? null
  if (attachmentId) await call('attachment.text', `/api/attachments/${attachmentId}/text`)
}

const searchStatus = await call('resume-search.status', '/api/resume-search/status', { timeoutMs: 60_000 })
const vector = searchStatus.json?.hybrid?.vector ?? {}
assert('向量索引 loaded/current', vector.available === true && vector.loaded === true && vector.current === true, JSON.stringify(vector).slice(0, 200))
assert('向量算法为 f16', String(vector.algorithm ?? '').includes('f16'), String(vector.algorithm))

const searchStarted = Date.now()
const search = await call('resume-search.query', '/api/resume-search', {
  method: 'POST',
  body: { q: '数值策划', page_size: 5 },
  timeoutMs: 180_000
})
assert('检索返回条数', Array.isArray(search.json?.items) && search.json.items.length > 0, `items=${search.json?.items?.length ?? 0}`)
assert('检索排序为 hybrid_reranked/rrf', ['hybrid_reranked', 'rrf'].includes(search.json?.completeness?.ranking), String(search.json?.completeness?.ranking))
console.log(`INFO 检索耗时 ${((Date.now() - searchStarted) / 1000).toFixed(1)}s`)

const agentStatus = await call('agent.status', '/api/agent/status')
assert('AI 助手已配置', agentStatus.json?.configured === true, JSON.stringify(agentStatus.json).slice(0, 200))

if (!skipAgent && agentStatus.json?.configured) {
  const sessionResponse = await call('agent.session.create', '/api/agent/sessions', { method: 'POST', body: { title: '自检会话' } })
  const sessionId = sessionResponse.json?.id ?? sessionResponse.json?.session_id ?? null
  assert('会话创建返回 id', Boolean(sessionId), JSON.stringify(sessionResponse.json).slice(0, 200))
  if (sessionId) {
    const question = '请用一句话说明你能做什么，并给出人才库里任意一位候选人的姓名。'
    const answer = await call('agent.ask', `/api/agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { message: question, client_request_id: randomUUID() },
      timeoutMs: 200_000
    })
    let payload = answer.json
    const taskId = payload?.task_id ?? payload?.task?.task_id ?? payload?.task?.id ?? null
    const deadline = Date.now() + 240_000
    while (taskId && Date.now() < deadline) {
      const state = payload?.state ?? payload?.status ?? payload?.task?.status ?? null
      if (state && !['processing', 'queued', 'running', 'planning', 'answering'].includes(state)) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000))
      const task = await call('agent.task.poll', `/api/agent/tasks/${taskId}`, { timeoutMs: 60_000 })
      payload = task.json ?? payload
    }
    const messages = await call('agent.messages', `/api/agent/sessions/${sessionId}/messages`, { timeoutMs: 60_000 })
    const assistant = (messages.json?.items ?? []).filter((item) => item.role === 'assistant').pop() ?? null
    const reply = assistant?.content ?? payload?.assistant_message?.content ?? payload?.answer ?? null
    assert('AI 助手返回回答', typeof reply === 'string' && reply.trim().length > 0, `state=${payload?.state ?? payload?.status}`)
    assert('AI 助手用了只读工具', Array.isArray(assistant?.tools_used) && assistant.tools_used.length > 0, JSON.stringify(assistant?.tools_used ?? []).slice(0, 120))
    if (reply) console.log(`INFO 回答摘要：${String(reply).replace(/\s+/gu, ' ').slice(0, 160)}`)
  }
}

const failed = checks.filter((entry) => !entry.ok)
const report = {
  base: BASE,
  started_at: new Date(startedAt).toISOString(),
  elapsed_ms: Date.now() - startedAt,
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks: checks.map(({ json, ...rest }) => rest)
}
mkdirSync(resolve('data'), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, report: reportPath }, null, 1))
process.exit(failed.length ? 1 : 0)
