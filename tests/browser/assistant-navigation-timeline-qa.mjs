import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE
    || "C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
);

const evidenceDir = resolve("docs/evidence/assistant-a-20260918");
const shotsDir = resolve(evidenceDir, "screenshots");
mkdirSync(shotsDir, { recursive: true });

const report = {
  generated_at: new Date().toISOString(),
  anonymous: true,
  viewports: [375, 768, 1440],
  cases: [],
  screenshots: [],
  console_errors: [],
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function startAnonymousServer(appPort, gatewayPort) {
  const child = spawn(
    process.execPath,
    ["tests/browser/anonymous-v6-1-server.mjs", String(appPort), String(gatewayPort)],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("匿名助手验收服务启动超时")), 45_000);
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes('"ready":true')) return;
      clearTimeout(timer);
      resolveReady(child);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`匿名助手验收服务提前退出：${code}`));
    });
  });
}

const appPort = await freePort();
const gatewayPort = await freePort();
const server = await startAnonymousServer(appPort, gatewayPort);
const baseUrl = `http://127.0.0.1:${appPort}`;
const browser = await chromium.launch({ headless: true });

function record(name, detail = null) {
  report.cases.push({ name, ok: true, detail });
}

async function box(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
      display: style.display,
      position: style.position,
      visibility: style.visibility,
    };
  });
}

async function screenshot(page, name) {
  const path = resolve(shotsDir, name);
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push(name);
}

async function openAssistant(page) {
  await page.goto(`${baseUrl}/candidates`, { waitUntil: "networkidle" });
  const beforeSidebar = await box(page, ".tw-sidebar");
  await page.getByRole("button", { name: "助手", exact: true }).click();
  await page.locator(".tw-chat-shell").waitFor({ state: "visible" });
  return beforeSidebar;
}

async function verifyViewport(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const beforeSidebar = await openAssistant(page);
  const sidebar = await box(page, ".tw-sidebar");
  const shell = await box(page, ".tw-chat-shell");
  const main = await box(page, ".tw-tool-main");
  const trigger = await box(page, ".tw-assistant-history-trigger");
  const heading = await box(page, ".tw-chat-head h1");

  assert.ok(shell.width <= 880, `${width}px 会话列超过 880px`);
  assert.ok(Math.abs((shell.x + shell.width / 2) - (main.x + main.width / 2)) <= 3, `${width}px 会话列未在内容区居中`);
  assert.equal(trigger.position, "fixed", `${width}px 历史入口未固定在页面左上角`);
  assert.ok(trigger.x <= 240, `${width}px 历史入口未固定在页面左侧`);
  assert.equal(
    trigger.x < heading.right && trigger.right > heading.x && trigger.y < heading.bottom && trigger.bottom > heading.y,
    false,
    `${width}px 历史入口遮挡页面标题`,
  );
  if (width >= 1366) {
    assert.ok(sidebar.width >= 160, `${width}px 展开态主导航被 AI 页面意外压缩`);
  } else {
    assert.ok(sidebar.width <= 72, `${width}px 响应式主导航应保持图标栏`);
  }

  const draft = `A方案-${width}-草稿`;
  await page.getByLabel("向拾才助手提问").fill(draft);
  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.locator(".tw-tool-side").waitFor({ state: "visible" });

  const historyPanel = await box(page, ".tw-tool-side");
  const historySidebar = await box(page, ".tw-sidebar");
  const historyScrim = await box(page, ".tw-tool-side-scrim");
  assert.equal(historySidebar.display, "none", `${width}px 历史栏打开时主导航仍可见`);
  assert.equal(await page.locator(".tw-tool-main").getAttribute("inert"), null, `${width}px 历史栏打开后正文仍被 inert 锁死`);
  assert.equal(historyPanel.position, "fixed", `${width}px 历史栏未使用固定侧栏定位`);
  assert.equal(historyPanel.x, 0, `${width}px 历史栏未从页面左边界开始`);
  assert.equal(
    historyScrim.display,
    width > 720 ? "none" : "block",
    `${width}px 历史栏 scrim 显示状态错误`,
  );
  assert.equal(await page.getByLabel("向拾才助手提问").inputValue(), draft, `${width}px 打开历史栏丢失草稿`);
  await screenshot(page, `assistant-history-${width}.png`);

  await page.keyboard.press("Escape");
  await page.locator(".tw-tool-side").waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).pathname, "/assistant", `${width}px Escape 越过历史栏关闭了 AI 助手`);
  assert.equal(await page.getByLabel("向拾才助手提问").inputValue(), draft, `${width}px 关闭历史栏丢失草稿`);
  assert.equal(
    await page.getByRole("button", { name: "展开历史会话" }).evaluate((element) => element === document.activeElement),
    true,
    `${width}px 关闭历史栏后焦点未恢复`,
  );
  const restoredSidebar = await box(page, ".tw-sidebar");
  assert.equal(restoredSidebar.display, beforeSidebar.display, `${width}px 关闭历史栏后主导航显示状态未恢复`);
  assert.ok(Math.abs(restoredSidebar.width - sidebar.width) < 1, `${width}px 关闭历史栏后主导航宽度未恢复`);
  await screenshot(page, `assistant-main-${width}.png`);

  assert.equal(errors.length, 0, `${width}px 助手控制台错误：${errors.join(" | ")}`);
  record(`AI 助手侧栏与焦点 ${width}px`, { sidebar, historyPanel, trigger });
  await context.close();
}

async function verifyCollapsedPreference() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("candidate-workbench.sidebar-collapsed", "true"));
  await page.goto(`${baseUrl}/assistant`, { waitUntil: "networkidle" });
  const before = await box(page, ".tw-sidebar");
  assert.ok(before.width <= 72, "持久化的主导航收起偏好未生效");
  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.locator(".tw-tool-side").waitFor({ state: "visible" });
  await page.locator(".tw-tool-side-close").click();
  await page.locator(".tw-tool-side").waitFor({ state: "detached" });
  const after = await box(page, ".tw-sidebar");
  assert.ok(after.width <= 72, "切换历史栏后未恢复主导航收起偏好");
  record("主导航收起偏好恢复");
  await context.close();
}

async function verifyHistoryInputAndEnter(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  let messagePosts = 0;
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/agent\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) {
      messagePosts += 1;
    }
  });
  await page.goto(`${baseUrl}/assistant`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.locator(".tw-tool-side-close").click();
  await page.locator(".tw-chat-empty").waitFor({ state: "visible" });

  const composer = page.getByLabel("向拾才助手提问");
  const question = (round) => `BROWSER_TOOL ${round}-${width}-${"请筛选上海有产品设计经验且近期活跃的候选人。".repeat(24)}`;
  await composer.fill(question("第一轮"));
  await composer.press("Enter");
  await page.locator(".assistant-markdown").nth(0).waitFor({ state: "visible" });
  assert.equal(await composer.inputValue(), "", `${width}px Enter 发送后输入框未清空`);
  assert.equal(messagePosts, 1, `${width}px Enter 未触发一次消息请求`);

  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.locator(".tw-tool-side").waitFor({ state: "visible" });
  assert.equal(await page.locator(".tw-tool-main").getAttribute("inert"), null, `${width}px 历史栏打开后正文仍被 inert 锁死`);
  await composer.fill(question("第二轮"));
  await composer.press("Enter");
  await page.locator(".assistant-markdown").nth(1).waitFor({ state: "visible" });
  assert.equal(messagePosts, 2, `${width}px 历史栏打开时未发送第二轮问题`);
  assert.equal(await page.locator(".tw-tool-side").isVisible(), true, `${width}px 发送后历史栏意外消失`);
  assert.equal(await composer.isEnabled(), true, `${width}px 发送完成后输入框未恢复可操作`);

  await page.locator(".tw-tool-side-close").click();
  await page.locator(".tw-tool-side").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.locator(".tw-tool-side").waitFor({ state: "visible" });
  await page.locator(".tw-tool-side-close").click();
  await page.locator(".tw-tool-side").waitFor({ state: "detached" });
  assert.equal(errors.length, 0, `${width}px 历史栏交互控制台错误：${errors.join(" | ")}`);
  record(`历史栏开放时输入与 Enter 发送 ${width}px`, { messagePosts });
  await context.close();
}

async function verifyCompletedTimeline(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(`${baseUrl}/assistant`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.locator(".tw-tool-side-close").click();
  await page.locator(".tw-chat-empty").waitFor({ state: "visible" });

  const question = `BROWSER_TOOL ${"请筛选上海有产品设计经验且近期活跃的候选人。".repeat(24)}`;
  await page.getByLabel("向拾才助手提问").fill(question);
  await page.getByRole("button", { name: "发送" }).click();
  await page.locator(".assistant-markdown").last().waitFor({ state: "visible" });
  await page.locator(".assistant-markdown-table-scroll table").last().waitFor({ state: "visible" });
  await page.locator(".assistant-markdown pre code").last().waitFor({ state: "visible" });

  const toggle = page.locator(".assistant-task-process-toggle").last();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "执行时间线无法展开");
  assert.equal(await page.locator(".assistant-task-workflow > li").count(), 5, "执行时间线阶段数量错误");
  assert.ok(await page.locator(".assistant-task-tool-list li").count() > 0, "执行时间线未展示已调用工具");
  assert.match(await page.locator(".assistant-task-result").last().innerText(), /查询完成[\s\S]*已调用工具[\s\S]*查询候选人/);
  assert.match(await page.locator(".assistant-task-workflow").last().innerText(), /(ms|秒)/, "执行时间线未展示耗时");
  const timelineLayout = await page.evaluate(() => {
    const chat = document.querySelector(".tw-chat");
    const result = document.querySelector(".assistant-task-result");
    return {
      chatOverflow: chat ? chat.scrollWidth > chat.clientWidth + 2 : false,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      resultWidth: result?.getBoundingClientRect().width ?? 0,
      chatWidth: chat?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.equal(timelineLayout.chatOverflow, false, `${width}px 执行时间线造成聊天区横向溢出`);
  assert.equal(timelineLayout.documentOverflow, false, `${width}px 执行时间线造成页面横向溢出`);
  assert.ok(timelineLayout.resultWidth <= timelineLayout.chatWidth, `${width}px 执行时间线超出会话列`);

  const chat = page.locator(".tw-chat");
  const scrollBefore = await page.evaluate(() => {
    const element = document.querySelector(".tw-chat");
    const maxChat = element ? Math.max(0, element.scrollHeight - element.clientHeight) : 0;
    if (element && maxChat > 0) {
      element.scrollTop = Math.min(180, maxChat);
    } else {
      window.scrollTo(0, Math.min(180, Math.max(0, document.documentElement.scrollHeight - window.innerHeight)));
    }
    return { chat: element?.scrollTop ?? 0, window: window.scrollY };
  });
  await page.getByRole("button", { name: "展开历史会话" }).click();
  await page.locator(".tw-tool-side").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator(".tw-tool-side").waitFor({ state: "detached" });
  const scrollAfter = await page.evaluate(() => ({
    chat: document.querySelector(".tw-chat")?.scrollTop ?? 0,
    window: window.scrollY,
  }));
  assert.ok(Math.abs(scrollAfter.chat - scrollBefore.chat) <= 2, "切换历史栏后聊天区滚动位置发生变化");
  assert.ok(Math.abs(scrollAfter.window - scrollBefore.window) <= 2, "切换历史栏后页面滚动位置发生变化");
  await screenshot(page, `assistant-timeline-${width}.png`);
  assert.equal(errors.length, 0, `任务时间线控制台错误：${errors.join(" | ")}`);
  record(`执行时间线与滚动保持 ${width}px`, { scrollBefore, scrollAfter });
  await context.close();
}

try {
  await verifyViewport(375, 812);
  await verifyViewport(768, 1024);
  await verifyViewport(1440, 900);
  await verifyCollapsedPreference();
  await verifyHistoryInputAndEnter(768, 1024);
  await verifyHistoryInputAndEnter(1440, 900);
  await verifyCompletedTimeline(375, 812);
  await verifyCompletedTimeline(1440, 900);
} finally {
  report.console_errors = report.cases.flatMap((item) => item.detail?.errors ?? []);
  writeFileSync(resolve(evidenceDir, "qa-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close();
  if (!server.killed) server.kill();
}

console.log(`AI 助手交互验收通过：${report.cases.length} 项，截图 ${report.screenshots.length} 张，console error ${report.console_errors.length} 条`);
