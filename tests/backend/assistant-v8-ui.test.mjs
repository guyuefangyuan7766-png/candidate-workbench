import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeSearchHighlightRanges } from '../../src/types.ts'

const drawerSource = readFileSync(new URL('../../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')

function renderHighlightedText(text, ranges) {
  const children = []
  let cursor = 0
  for (const range of normalizeSearchHighlightRanges(text, ranges)) {
    if (range.start > cursor) children.push(text.slice(cursor, range.start))
    children.push(createElement('mark', { key: `${range.start}-${range.end}` }, text.slice(range.start, range.end)))
    cursor = range.end
  }
  if (cursor < text.length) children.push(text.slice(cursor))
  return renderToStaticMarkup(createElement(Fragment, null, ...children))
}

test('V8 evidence highlighting clamps invalid ranges and merges overlap without HTML injection', () => {
  const text = '<script>Unity++ 与 unity 海外项目</script>'
  const ranges = normalizeSearchHighlightRanges(text, [
    { start: -50, end: 8, actual_terms: ['<script>'] },
    { start: 8, end: 15, actual_term: 'Unity++' },
    { start: 12, end: 18, actual_terms: ['Unity', '++ 与'] },
    { start: 10_000, end: 20_000, actual_term: '越界' },
    { start: Number.NaN, end: 2, actual_term: '无效' }
  ])

  assert.deepEqual(ranges, [{
    start: 0,
    end: 18,
    actualTerms: ['<script>', 'Unity++', 'Unity', '++ 与']
  }])
  const html = renderHighlightedText(text, ranges)
  assert.match(html, /^<mark>&lt;script&gt;Unity\+\+ 与 /)
  assert.doesNotMatch(html, /<script>/i)
})

test('V8 assistant UI persists only opaque session state and sends idempotent session turns', () => {
  assert.match(drawerSource, /ACTIVE_SESSION_STORAGE_KEY[\s\S]*active-session-id/)
  assert.match(drawerSource, /UUID_PATTERN\.test\(value\)/)
  assert.match(drawerSource, /globalThis\.crypto\.randomUUID\(\)/)
  assert.match(drawerSource, /agentSessionApi\.send\(sessionId, value, clientRequestId, controller\.signal\)/)
  assert.match(apiSource, /client_request_id: clientRequestId/)
  assert.match(apiSource, /before_sequence: beforeSequence/)

  const storageWrites = [...drawerSource.matchAll(/localStorage\.setItem\(([^,\n]+)/g)].map((match) => match[1])
  assert.deepEqual(storageWrites.sort(), ['ACTIVE_SESSION_STORAGE_KEY', 'HISTORY_OPEN_STORAGE_KEY'].sort())
  assert.doesNotMatch(drawerSource, /localStorage\.setItem\([^\n]*(?:message|content|phone|email|resume)/i)
})

test('V9 assistant task UI exposes bounded progress, cancellation, recovery and answer-only retry', () => {
  for (const status of ['queued', 'planning', 'querying', 'retrieving', 'composing', 'partial', 'cancelled']) {
    assert.match(drawerSource, new RegExp(`['"]${status}['"]`))
  }
  assert.match(drawerSource, /agentTaskApi\.get\(taskId, controller\.signal\)/)
  assert.match(drawerSource, /agentTaskApi\.sessionTasks\(sessionId, signal\)/)
  assert.match(drawerSource, /agentTaskApi\.cancel\(task\.task_id(?:,\s*controller\.signal)?\)/)
  assert.match(drawerSource, /agentTaskApi\.retryAnswer\(task\.task_id(?:,\s*controller\.signal)?\)/)
  assert.match(apiSource, /export const agentTaskApi = \{/)
  assert.match(apiSource, /\/api\/agent\/tasks\/\$\{encodeURIComponent\(taskId\)\}/)
  assert.match(apiSource, /\/cancel/)
  assert.match(apiSource, /\/retry-answer/)
  assert.match(drawerSource, /setTimeout\(\(\) => void pollTask\(taskId/)
  assert.match(drawerSource, /retained_result/)
  assert.match(drawerSource, /继续生成结果/)
  assert.match(drawerSource, /取消任务/)
  assert.match(drawerSource, /TASK_WORKFLOW_STAGES/)
  assert.match(drawerSource, /aria-label="Agent 工作流程"/)
  assert.match(drawerSource, /taskDurationLabel\(duration\)/)
  assert.match(drawerSource, /first_evidence_ms/)
  for (const label of ['进入队列', '分析问题', '查询数据', '整理证据', '生成回答']) {
    assert.match(drawerSource, new RegExp(label))
  }
  assert.doesNotMatch(drawerSource, /发送失败，可重新提问/)
})

test('Agent CSV artifacts render only trusted same-origin task metadata as download controls', () => {
  assert.match(drawerSource, /function trustedTaskArtifacts\(task: AgentTask\)/)
  assert.match(drawerSource, /entry\.tool === "export_query_results"/)
  assert.match(drawerSource, /artifact\.download_url === `\/api\/agent\/exports\/\$\{encodeURIComponent\(artifact\.artifact_id\)\}`/)
  assert.match(drawerSource, /<Download size=\{16\}/)
  assert.match(drawerSource, /aria-label=\{`下载 \$\{artifact\.filename\}`\}/)
  assert.match(drawerSource, /response\.status === 404 \? "文件已过期或不存在，请重新生成导出。"/)
  assert.doesNotMatch(drawerSource, /match\([^\n]*api\/agent\/exports|replace\([^\n]*api\/agent\/exports/)
})

test('assistant execution process precedes its answer and follows accessible collapse defaults', () => {
  assert.match(drawerSource, /function defaultTaskProcessExpanded\(task[^)]*\) \{\s*return task\.status !== "completed"/)
  assert.match(drawerSource, /enteredTerminalState = previous\.status !== task\.status && TERMINAL_TASK_STATUSES\.has\(task\.status\)/)
  assert.match(drawerSource, /resumed = TERMINAL_TASK_STATUSES\.has\(previous\.status\) && !TERMINAL_TASK_STATUSES\.has\(task\.status\)/)
  assert.match(drawerSource, /setProcessExpanded\(defaultTaskProcessExpanded\(task\)\)/)
  assert.match(drawerSource, /onClick=\{\(\) => setProcessExpanded\(\(expanded\) => !expanded\)\}/)
  assert.match(drawerSource, /aria-expanded=\{processExpanded\}/)
  assert.match(drawerSource, /aria-controls=\{processRegionId\}/)
  assert.match(drawerSource, /hidden=\{!processExpanded\} role="region" aria-label="执行过程详情"/)

  // Fresh and restored tasks can anchor to the persisted assistant message,
  // its reply relationship, or the idempotent request identity.
  assert.match(drawerSource, /task\.assistant_message\?\.id && message\.id === task\.assistant_message\.id/)
  assert.match(drawerSource, /message\.reply_to_message_id === task\.user_message_id/)
  assert.match(drawerSource, /message\.client_request_id === task\.client_request_id/)
  assert.match(drawerSource, /taskAnswerMessageId === message\.id && <TaskResultPreview[\s\S]*?<div className=\{`tw-msg /)
  assert.match(drawerSource, /activeTask && !taskAnswerMessageId && <TaskResultPreview/)

  assert.match(stylesSource, /\.assistant-task-process-content\[hidden\] \{ display: none; \}/)
  assert.match(stylesSource, /\.assistant-task-result-header \{ align-items: flex-start; \}/)
  assert.doesNotMatch(drawerSource, /思维链|思考过程|chain[ _-]?of[ _-]?thought/i)
})

test('V9 waits through task completion and continuously recovers by idempotent request identity', () => {
  const legacyTimeoutCopy = ["请求超时", "；任务仍可能在服务端继续处理，请刷新查看任务状态。"].join("")
  assert.equal(apiSource.includes(legacyTimeoutCopy), false)
  assert.match(apiSource, /AGENT_SEND_TIMEOUT_MS = 15_000/)
  assert.match(apiSource, /AGENT_TASK_REQUEST_TIMEOUT_MS = 20_000/)
  assert.doesNotMatch(drawerSource, /TASK_RECOVERY_WINDOW_MS|TASK_RECOVERY_ATTEMPTS/)
  assert.match(drawerSource, /const recoverable = isRetryableAgentRequest\(error\)/)
  assert.match(drawerSource, /while \(!controller\.signal\.aborted && activeSessionRef\.current === sessionId\)/)
  assert.match(drawerSource, /recoverTaskForRequest\(sessionId, clientRequestId, value\)/)
  assert.match(drawerSource, /task\.client_request_id === clientRequestId/)
  assert.match(drawerSource, /withoutOptimisticMessage/)
  assert.match(drawerSource, /正在恢复任务状态…/)
  assert.match(drawerSource, /正在确认任务已受理…/)
  assert.match(drawerSource, /agentTaskApi\.sessionTasks\(sessionId, controller\.signal\)/)
  assert.match(drawerSource, /agentSessionApi\.send\(sessionId, message, clientRequestId, controller\.signal\)/)
  assert.match(drawerSource, /waitForRecoveryDelay\(controller\.signal, delay\)/)
  assert.match(drawerSource, /tasks\?\.find\(\(task\) => task\.client_request_id === processingTurn\.client_request_id\)/)
  assert.match(drawerSource, /matchingTask && !isActiveTask\(matchingTask\)/)
  assert.match(drawerSource, /recoverTasks: false/)
  assert.match(drawerSource, /if \(!isRequestTimeout\(error\)/)
  assert.match(drawerSource, /MESSAGE_RECOVERY_COPY/)
  assert.match(drawerSource, /scheduleMessageRecovery\(sessionId\)/)
  assert.match(drawerSource, /isRetryableAgentRequest\(error\)/)
  assert.match(drawerSource, /authoritative: error instanceof ApiError/)
  assert.match(drawerSource, /controller\.signal\.aborted \|\| activeSessionRef\.current !== sessionId/)
  assert.match(drawerSource, /task\.timings\?\./)
  assert.match(drawerSource, /return .*\? "complete" : "skipped"/)
  assert.match(drawerSource, /if \(sendAbort\.current === controller\) \{[\s\S]*?setPending\(false\)/)
  assert.match(drawerSource, /submitLockRef\.current/)
  assert.doesNotMatch(drawerSource, /刷新会话后可继续查看/)
})

test('V9 keeps an ambiguous submit recoverable across message-read failures', () => {
  assert.match(drawerSource, /pendingRequestRecovery/)
  assert.match(drawerSource, /preserveRequest: pendingRequestRecovery\.current\.get\(clientRequestId\)/)
  assert.match(drawerSource, /failProcessingMessages\(current, errorCode/)
  assert.match(drawerSource, /error\.status === 408 \|\| error\.status >= 500/)
  assert.doesNotMatch(drawerSource, /error\.status === 408 \|\| error\.status === 429 \|\| error\.status >= 500/)
  assert.match(drawerSource, /Keep the optimistic turn and its client_request_id/)
  assert.match(drawerSource, /clearMessageRecovery\(\)/)
  assert.match(drawerSource, /messageRetryDelay\.current = MESSAGE_RECOVERY_INITIAL_DELAY_MS/)
})

test('V8 assistant UI restores server messages and exposes session lifecycle actions', () => {
  for (const call of [
    'agentSessionApi.list',
    'agentSessionApi.get',
    'agentSessionApi.messages',
    'agentSessionApi.create',
    'agentSessionApi.update',
    'agentSessionApi.delete'
  ]) {
    assert.match(drawerSource, new RegExp(call.replace('.', '\\.')))
  }
  assert.match(drawerSource, /加载更早消息/)
  assert.match(drawerSource, /确认删除/)
  assert.match(drawerSource, /SQLite remains the source of truth for all chat content/)
})

test('V8 resume evidence renders table, field, actual terms and React mark nodes', () => {
  assert.match(drawerSource, /evidence\.source_table/)
  assert.match(drawerSource, /evidence\.field_path/)
  assert.match(drawerSource, /matched_actual_terms/)
  assert.match(drawerSource, /<mark key=/)
  assert.match(drawerSource, /normalizeSearchHighlightRanges/)
  assert.doesNotMatch(drawerSource, /dangerouslySetInnerHTML/)
})

test('opening a V8 search result does not depend on candidates loaded on the current page', () => {
  assert.match(drawerSource, /onOpenCandidateId\(item\.candidate_id, tab\)/)
  assert.match(drawerSource, /candidateApi\.get\(item\.candidate_id\)/)
  // The open-result handler must not depend on candidates already loaded on the page.
  const openResultStart = drawerSource.indexOf('async function openResult(')
  const openResultBody = drawerSource.slice(openResultStart, drawerSource.indexOf('\n  }', openResultStart))
  assert.ok(openResultStart > 0)
  assert.doesNotMatch(openResultBody, /candidates\.find\(/)
  assert.match(openResultBody, /candidateApi\.get\(item\.candidate_id\)/)
})

test('resume index status refresh is revision-driven instead of tab-toggle driven', () => {
  assert.match(drawerSource, /const \[resumeStatusRevision, setResumeStatusRevision\] = useState\(0\)/)
  assert.match(drawerSource, /setResumeStatusRevision\(\(revision\) => revision \+ 1\)/)
  assert.match(drawerSource, /\}, \[open, resumeStatusRevision\]\)/)
  assert.doesNotMatch(drawerSource, /\}, \[open, tab\]\)/)
  assert.doesNotMatch(drawerSource, /setTab\("chat"\)[\s\S]{0,120}setTab\("resume-search"\)/)
})
