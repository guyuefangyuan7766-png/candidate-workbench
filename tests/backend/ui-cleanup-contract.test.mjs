import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../../src/views/AppShell.tsx", import.meta.url), "utf8");
const assistantSource = readFileSync(new URL("../../src/components/AssistantDrawer.tsx", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("../../src/components/AssistantExecutionTimeline.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../../src/workspace.css", import.meta.url), "utf8");

test("permanently unreachable UI and unused props have no source references", () => {
  assert.doesNotMatch(appSource, /function ExportMenu\b/, "App.tsx 不应保留无引用的 ExportMenu");
  assert.doesNotMatch(appSource, /className="export-menu"/, "App.tsx 不应保留无引用的导出菜单");
  assert.doesNotMatch(
    appShellSource,
    /\boverlays\b/,
    "AppShell 不应保留从未传入的 overlays 插槽",
  );
  assert.doesNotMatch(
    assistantSource,
    /presentation\??:\s*"drawer"\s*\|\s*"page"/,
    "AssistantDrawer 当前只有页面形态，不应保留不可达 presentation 分支",
  );
  assert.doesNotMatch(assistantSource, /tw-assistant-drawer/, "不可达 drawer JSX 必须删除");
  assert.doesNotMatch(assistantSource, /tw-tool-tabs/, "drawer 专属工具页签必须删除");
  assert.doesNotMatch(assistantSource, /\bonOpenCandidate\b/, "候选人结果回退 handler 没有调用方");
  assert.doesNotMatch(assistantSource, /\bcandidateApi\b/, "无调用方后不应残留 candidateApi import");
});

test("orphan legacy CSS is removed without deleting functional hidden states", () => {
  for (const selector of [
    ".export-menu",
    ".assistant-content",
    ".assistant-composer",
    ".assistant-mode-tabs",
    ".assistant-session-item",
    ".assistant-drawer",
    ".note-composer",
  ]) {
    assert.equal(
      stylesSource.includes(selector),
      false,
      `styles.css 仍包含无引用选择器 ${selector}`,
    );
  }
  assert.doesNotMatch(workspaceSource, /\.tw-avatar-accent\b/, "无引用头像修饰类必须删除");
  assert.doesNotMatch(workspaceSource, /\.tw-session\.active\b/, "无匹配 JSX 的会话 active 选择器必须删除");

  assert.match(workspaceSource, /\.tw-content-stack\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(timelineSource, /hidden=\{!expanded\} role="region" aria-label="执行过程详情"/);
  assert.match(stylesSource, /\.assistant-task-process-content\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(stylesSource, /\.sr-only\s*\{/, "无障碍隐藏内容必须保留");
});
