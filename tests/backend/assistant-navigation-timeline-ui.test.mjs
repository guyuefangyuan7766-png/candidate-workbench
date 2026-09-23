import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = (path) => existsSync(new URL(path, import.meta.url))
  ? readFileSync(new URL(path, import.meta.url), 'utf8')
  : ''

const appSource = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../../src/views/AppShell.tsx', import.meta.url), 'utf8')
const drawerSource = readFileSync(new URL('../../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('../../src/workspace.css', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
const timelineSource = readSource('../../src/components/AssistantExecutionTimeline.tsx')

test('assistant navigation exposes one explicit left-panel state and preserves the main sidebar preference', () => {
  assert.match(appSource, /type AssistantPanel = "main" \| "history"/)
  assert.match(appSource, /const \[assistantPanel, setAssistantPanel\] = useState<AssistantPanel>\("main"\)/)
  assert.match(appSource, /assistantHistoryOpen=\{assistantPanel === "history"\}/)
  assert.match(appSource, /onHistoryOpenChange=\{\(open\) => setAssistantPanel\(open \? "history" : "main"\)\}/)
  assert.match(appSource, /if \(next !== "assistant"\) setAssistantPanel\("main"\)/)
  assert.match(shellSource, /assistantHistoryOpen/)
  assert.match(shellSource, /is-assistant-page/)
  assert.match(shellSource, /is-assistant-history-open/)
  assert.doesNotMatch(
    workspaceSource,
    /\.tw-app\.is-tool-page \.tw-sidebar,\s*\.tw-app\.is-tool-page\.is-collapsed \.tw-sidebar/,
  )
  assert.match(workspaceSource, /\.tw-app\.is-tool-page:not\(\.is-assistant-page\) \.tw-sidebar/)
  assert.match(workspaceSource, /\.tw-assistant-history-trigger/)
  assert.match(workspaceSource, /\.tw-app\.is-assistant-history-open \.tw-sidebar \{ display: none; \}/)
})

test('assistant history owns Escape and restores focus to its top-left trigger', () => {
  assert.match(drawerSource, /useDismissableLayer/)
  assert.match(drawerSource, /historyPanelRef/)
  assert.match(drawerSource, /historyTriggerRef/)
  assert.match(drawerSource, /aria-controls="assistant-history-panel"/)
  assert.match(drawerSource, /id="assistant-history-panel"/)
  assert.match(drawerSource, /setHistoryOpen\(false\)/)
  assert.doesNotMatch(drawerSource, /tab === "chat" && configured && <button className="tw-icon-plain"/)
})

test('assistant execution timeline uses only persisted task facts and keeps tools distinct from reasoning', () => {
  assert.match(drawerSource, /AssistantExecutionTimeline/)
  assert.match(timelineSource, /function toolNameLabel/)
  assert.match(timelineSource, /task\.tools_used/)
  assert.match(timelineSource, /aria-label="Agent 工作流程"/)
  assert.match(timelineSource, /任务已进入本机队列/)
  assert.match(timelineSource, /分析问题并确定只读工具/)
  assert.match(timelineSource, /检索和读取可验证数据/)
  assert.match(timelineSource, /整理证据与来源/)
  assert.match(timelineSource, /组织最终回答/)
  assert.match(timelineSource, /已调用工具/)
  assert.match(timelineSource, /aria-current/)
  assert.match(timelineSource, /taskDurationLabel/)
  assert.doesNotMatch(timelineSource, /思维链|思考过程|chain[ _-]?of[ _-]?thought/i)
  assert.match(stylesSource, /\.assistant-task-tool-list/)
  assert.match(workspaceSource, /\.tw-tool-page\.is-assistant-chat/)
})

test('history sidebar never disables the composer and Enter sends while preserving Shift+Enter', () => {
  assert.doesNotMatch(drawerSource, /aria-hidden=\{historyOpen \|\| undefined\}/)
  assert.doesNotMatch(drawerSource, /inert=\{historyOpen \|\| undefined\}/)
  assert.match(drawerSource, /onKeyDown=/)
  assert.match(drawerSource, /event\.key !== "Enter"/)
  assert.match(drawerSource, /event\.shiftKey/)
  assert.match(drawerSource, /nativeEvent\.isComposing/)
  assert.match(drawerSource, /event\.preventDefault\(\)/)
  assert.match(drawerSource, /void submit\(\)/)
})
