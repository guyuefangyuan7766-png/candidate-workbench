import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
);

const evidenceDir = resolve("docs/evidence/round14-ui-polish");
const shotsDir = resolve(evidenceDir, "screenshots");
mkdirSync(shotsDir, { recursive: true });
const report = {
  generated_at: new Date().toISOString(),
  anonymous: true,
  viewports: [375, 768, 1440],
  cases: [],
  screenshots: [],
  console_errors: [],
  hidden_audit: {},
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(20_000);
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

async function shot(targetPage, filename) {
  const path = resolve(shotsDir, filename);
  await targetPage.screenshot({ path, fullPage: false });
  report.screenshots.push(filename);
}

function recordCase(name, detail = null) {
  report.cases.push({ name, ok: true, detail });
}

async function collectHiddenNodes(targetPage, label) {
  const entries = await targetPage.evaluate(() =>
    [...document.querySelectorAll("*")]
      .map((element) => {
        const style = getComputedStyle(element);
        const reasons = [
          element.hasAttribute("hidden") ? "hidden-attribute" : "",
          style.display === "none" ? "display-none" : "",
          style.visibility === "hidden" ? "visibility-hidden" : "",
          style.opacity === "0" ? "opacity-zero" : "",
        ].filter(Boolean);
        if (!reasons.length) return null;
        const rect = element.getBoundingClientRect();
        const className = typeof element.className === "string" ? element.className : "";
        const interactive = Boolean(
          element.matches("button, a, input, select, textarea, [role='button'], [tabindex]"),
        );
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          className: className || null,
          role: element.getAttribute("role"),
          ariaLabel: element.getAttribute("aria-label"),
          text: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 60),
          reasons,
          interactive,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter(Boolean),
  );
  report.hidden_audit[label] = entries;
  recordCase(`隐藏节点审计 ${label}`, { count: entries.length });
}

async function computedStyle(selector) {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
    };
  });
}

async function computedBox(targetPage, selector) {
  return targetPage.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      position: getComputedStyle(element).position,
    };
  });
}

async function verifyAssistantLayout(viewport) {
  const context = await browser.newContext({ viewport });
  const assistantPage = await context.newPage();
  assistantPage.setDefaultTimeout(20_000);
  const errors = [];
  assistantPage.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  assistantPage.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await assistantPage.goto(`${baseUrl}/assistant`, { waitUntil: "networkidle" });
  await assistantPage.locator(".tw-chat-shell").waitFor({ state: "visible" });
  if (viewport.width === 1440) {
    await assistantPage.locator(".tw-chat-empty").waitFor({ state: "visible" });
    await shot(assistantPage, `assistant-empty-${viewport.width}.png`);
    await collectHiddenNodes(assistantPage, "assistant-empty-1440");
  }

  const shell = await assistantPage.locator(".tw-chat-shell").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const appSidebar = document.querySelector(".tw-sidebar")?.getBoundingClientRect();
    return {
      x: rect.x,
      width: rect.width,
      mainX: element.parentElement?.getBoundingClientRect().x ?? 0,
      mainWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
      centerOffset: rect.x + rect.width / 2 - window.innerWidth / 2,
      appSidebarWidth: appSidebar?.width ?? 0,
      navDotDisplay: getComputedStyle(document.querySelector(".tw-nav-dot")).display,
    };
  });
  assert.ok(shell.width <= 880, `${viewport.width}px 会话列超过 880px`);
  assert.ok(shell.appSidebarWidth <= 72, `${viewport.width}px 工具页全局侧栏未压缩为图标栏`);
  assert.notEqual(shell.navDotDisplay, "none", "工具页压缩侧栏不得隐藏助手在线状态点");
  assert.ok(Math.abs(shell.centerOffset) <= 80, `${viewport.width}px 会话列整体偏斜过大`);
  assert.equal(await assistantPage.locator(".tw-tool-side").count(), 0, "历史会话首次进入应保持收起");
  assert.equal(await assistantPage.locator(".tw-tool-rail").count(), 0, "不应保留额外历史窄轨");
  await assistantPage.getByRole("button", { name: "展开历史会话" }).click();
  const overlaySide = await computedBox(assistantPage, ".tw-tool-side");
  assert.ok(
    overlaySide.position === "absolute" || overlaySide.position === "fixed",
    "历史会话必须使用覆盖层而不是文档流侧栏",
  );
  const sidebarHead = await assistantPage.locator(".tw-tool-side").evaluate((element) => {
    const heading = element.querySelector(".tw-tool-side-head h2");
    const actions = element.querySelector(".tw-tool-side-head-actions");
    const headingRect = heading?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      headingHeight: headingRect?.height ?? 0,
      headingRight: headingRect?.right ?? 0,
      actionsLeft: actionsRect?.left ?? 0,
    };
  });
  assert.ok(sidebarHead.headingHeight <= 24, "历史侧栏标题必须保持单行");
  assert.ok(sidebarHead.headingRight <= sidebarHead.actionsLeft + 1, "历史侧栏标题不得与操作区重叠");
  assert.ok(
    sidebarHead.scrollWidth <= sidebarHead.clientWidth + 2,
    "历史侧栏不得产生横向溢出",
  );
  assert.equal(await assistantPage.locator(".tw-tool-side-scrim").count(), 1, "历史覆盖层需要可关闭 scrim");
  const overlayShell = await assistantPage.locator(".tw-chat-shell").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.x + rect.width / 2 - window.innerWidth / 2;
  });
  assert.ok(Math.abs(overlayShell) <= 80, "打开历史覆盖层不得推动会话列");
  if (viewport.width === 1440 || viewport.width === 375) {
    await shot(assistantPage, `assistant-history-${viewport.width}.png`);
  }
  const scrimBox = await computedBox(assistantPage, ".tw-tool-side-scrim");
  await assistantPage.locator(".tw-tool-side-scrim").click({
    position: {
      x: Math.min(scrimBox.width - 20, overlaySide.width + 20),
      y: 20,
    },
  });
  await assistantPage.locator(".tw-tool-side").waitFor({ state: "detached" });
  await assistantPage.getByRole("button", { name: "展开历史会话" }).click();
  await assistantPage.locator(".tw-tool-side-close").click();
  await assistantPage.locator(".tw-tool-side").waitFor({ state: "detached" });
  if (viewport.width >= 1024) {
    const leftInset = shell.x - shell.mainX;
    const rightInset = shell.mainWidth - shell.width - leftInset;
    assert.ok(Math.abs(leftInset - rightInset) < 2, "桌面会话列未居中");
  }

  const longQuestion = `BROWSER_TOOL ${"请筛选上海有产品设计经验且近期活跃的候选人。".repeat(24)}`;
  await assistantPage.getByLabel("向拾才助手提问").fill(longQuestion);
  await assistantPage.getByRole("button", { name: "发送" }).click();
  await assistantPage.locator(".assistant-markdown").last().waitFor({ state: "visible" });
  await assistantPage.locator(".assistant-markdown-table-scroll table").last().waitFor({ state: "visible" });
  await assistantPage.locator(".assistant-markdown pre code").last().waitFor({ state: "visible" });
  await assistantPage.locator(".tw-chat").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot(assistantPage, `assistant-success-${viewport.width}.png`);
  const processToggle = assistantPage.locator(".assistant-task-process-toggle").last();
  if ((await processToggle.getAttribute("aria-expanded")) !== "true") {
    await processToggle.click();
  }
  assert.equal(await processToggle.getAttribute("aria-expanded"), "true", "执行过程应可由用户展开");
  if (viewport.width === 1440) {
    await shot(assistantPage, "assistant-process-expanded-1440.png");
  }

  const desktopStyles = await assistantPage.evaluate(() => {
    const styleOf = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        width: rect.width,
      };
    };
    const send = document.querySelector(".tw-chat-send");
    return {
      assistantBubble: styleOf(".tw-msg.is-assistant .tw-msg-bubble"),
      assistantMarkdown: styleOf(".tw-msg.is-assistant .assistant-markdown"),
      userBubble: styleOf(".tw-msg.is-user .tw-msg-bubble"),
      form: styleOf(".tw-chat-composer"),
      surface: styleOf(".tw-chat-composer-surface"),
      textarea: styleOf(".tw-chat-composer textarea"),
      sendInsideSurface: Boolean(send?.closest(".tw-chat-composer-surface")),
      chatScrollWidth: document.querySelector(".tw-chat")?.scrollWidth ?? 0,
      chatClientWidth: document.querySelector(".tw-chat")?.clientWidth ?? 0,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  assert.equal(
    desktopStyles.assistantBubble?.backgroundColor,
    "rgba(0, 0, 0, 0)",
    "助手消息不应使用厚重气泡背景",
  );
  assert.equal(
    desktopStyles.assistantMarkdown?.backgroundColor,
    "rgba(0, 0, 0, 0)",
    "助手 Markdown 正文不应使用厚重卡片背景",
  );
  assert.equal(desktopStyles.assistantBubble?.borderTopWidth, "0px", "助手消息不应有重边框");
  assert.notEqual(
    desktopStyles.userBubble?.backgroundColor,
    "rgba(0, 0, 0, 0)",
    "用户消息应保留克制气泡",
  );
  assert.equal(desktopStyles.form?.borderTopWidth, "0px", "输入表单外层不应有边框");
  assert.equal(desktopStyles.surface?.borderTopWidth, "1px", "输入表面应保留唯一边框");
  assert.equal(desktopStyles.textarea?.borderTopWidth, "0px", "textarea 不应形成第二层边框");
  assert.equal(desktopStyles.sendInsideSurface, true, "发送按钮必须位于输入表面内部");
  assert.ok(
    desktopStyles.chatScrollWidth <= desktopStyles.chatClientWidth + 2,
    `${viewport.width}px 聊天区存在内部横向溢出`,
  );
  assert.equal(desktopStyles.documentOverflow, false, `${viewport.width}px 页面出现横向溢出`);
  const markdownLayout = await assistantPage.evaluate(() => {
    const tableScroll = [...document.querySelectorAll(".assistant-markdown-table-scroll")].at(-1);
    const pre = [...document.querySelectorAll(".assistant-markdown pre")].at(-1);
    return {
      tableOverflowX: tableScroll ? getComputedStyle(tableScroll).overflowX : null,
      tableScrollWidth: tableScroll?.scrollWidth ?? 0,
      tableClientWidth: tableScroll?.clientWidth ?? 0,
      preMaxWidth: pre ? pre.getBoundingClientRect().width : 0,
      messageWidth: [...document.querySelectorAll(".tw-msg.is-assistant")].at(-1)?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.ok(["auto", "scroll"].includes(markdownLayout.tableOverflowX), "Markdown 表格容器应支持横向滚动");
  assert.ok(
    markdownLayout.preMaxWidth <= markdownLayout.messageWidth + 1,
    `${viewport.width}px 代码块不得撑破助手消息列`,
  );

  if (viewport.width === 1440) {
    await assistantPage.getByRole("button", { name: "展开历史会话" }).click();
    const sessionRows = assistantPage.locator(".tw-session-row");
    const initialSessions = await sessionRows.count();
    await assistantPage.getByRole("button", { name: "新建会话" }).click();
    await assistantPage.waitForFunction(
      (count) => document.querySelectorAll(".tw-session-row").length > count,
      initialSessions,
    );
    const activeRow = assistantPage.locator(".tw-session-row.is-active");
    await activeRow.hover();
    await activeRow.getByRole("button", { name: /重命名会话/ }).click();
    const renameInput = activeRow.getByLabel("会话名称");
    await renameInput.fill("界面回归会话");
    await activeRow.getByRole("button", { name: "保存名称" }).click();
    const renamedRow = assistantPage.locator(".tw-session-row").filter({ hasText: "界面回归会话" });
    await renamedRow.waitFor({ state: "visible" });
    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: /删除会话/ }).click();
    await assistantPage.getByRole("button", { name: "确认删除" }).click();
    await renamedRow.waitFor({ state: "detached" });
    recordCase("AI 会话新建、重命名和删除");
  }

  assert.equal(errors.length, 0, `${viewport.width}px 助手控制台错误：${errors.join(" | ")}`);
  recordCase(`AI 助手布局 ${viewport.width}px`, {
    shell,
    desktopStyles,
    markdownLayout,
  });
  await context.close();
}

async function verifyAssistantRequestStates() {
  const loadingContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const loadingPage = await loadingContext.newPage();
  const loadingErrors = [];
  loadingPage.on("console", (message) => {
    if (message.type() === "error") loadingErrors.push(message.text());
  });
  loadingPage.on("pageerror", (error) => loadingErrors.push(`pageerror: ${error.message}`));
  await loadingPage.goto(`${baseUrl}/assistant`, { waitUntil: "networkidle" });
  await loadingPage.getByRole("button", { name: "展开历史会话" }).click();
  await loadingPage.getByRole("button", { name: "新建会话" }).click();
  await loadingPage.locator(".tw-tool-side-close").click();
  await loadingPage.locator(".tw-chat-empty").waitFor({ state: "visible" });
  await loadingPage.getByLabel("向拾才助手提问").fill("BROWSER_CANCEL 请等待加载状态");
  await loadingPage.getByRole("button", { name: "发送" }).click();
  await loadingPage
    .locator(".assistant-task-result.is-active, .tw-msg-status.is-processing")
    .first()
    .waitFor({ state: "visible" });
  assert.ok(
    (await loadingPage.locator(".tw-msg.is-pending .spin").count()) > 0,
    "加载状态应显示明确的进度指示",
  );
  await shot(loadingPage, "assistant-loading-1440.png");
  assert.equal(
    await loadingPage.locator(".tw-chat").evaluate((element) => element.scrollWidth > element.clientWidth + 2),
    false,
    "加载状态不得造成聊天区横向溢出",
  );
  await collectHiddenNodes(loadingPage, "assistant-loading-1440");
  const cancelButton = loadingPage.getByRole("button", { name: "取消任务" });
  if (await cancelButton.count()) await cancelButton.click();
  assert.equal(loadingErrors.length, 0, `加载状态控制台错误：${loadingErrors.join(" | ")}`);
  recordCase("AI 助手加载与取消状态");
  await loadingContext.close();

  const failureContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const failurePage = await failureContext.newPage();
  const failureErrors = [];
  failurePage.on("console", (message) => {
    if (message.type() === "error") {
      failureErrors.push({
        text: message.text(),
        url: message.location().url,
      });
    }
  });
  failurePage.on("pageerror", (error) => failureErrors.push({ text: `pageerror: ${error.message}`, url: "" }));
  await failurePage.route("**/api/agent/sessions/*/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "invalid_query_plan",
          message: "匿名验收失败状态",
        },
      }),
    });
  });
  await failurePage.goto(`${baseUrl}/assistant`, { waitUntil: "networkidle" });
  await failurePage.getByRole("button", { name: "展开历史会话" }).click();
  await failurePage.getByRole("button", { name: "新建会话" }).click();
  await failurePage.locator(".tw-tool-side-close").click();
  await failurePage.locator(".tw-chat-empty").waitFor({ state: "visible" });
  await failurePage.getByLabel("向拾才助手提问").fill("触发匿名失败状态");
  await failurePage.getByRole("button", { name: "发送" }).click();
  await failurePage.locator(".tw-chat-error").waitFor({ state: "visible" });
  assert.match(await failurePage.locator(".tw-chat-error").innerText(), /匿名验收失败状态/);
  await shot(failurePage, "assistant-failure-1440.png");
  const unexpectedFailureErrors = failureErrors.filter(
    (error) => !error.url.includes("/api/agent/sessions/") || !error.url.endsWith("/messages"),
  );
  assert.equal(
    unexpectedFailureErrors.length,
    0,
    `失败状态控制台错误：${unexpectedFailureErrors.map((error) => error.text).join(" | ")}`,
  );
  recordCase("AI 助手失败状态");
  await failureContext.close();
}

try {
  await page.goto(`${baseUrl}/candidates`, { waitUntil: "networkidle" });
  await page.locator(".tw-table-candidates tbody tr").first().click();
  await page.locator(".tw-drawer").waitFor({ state: "visible" });
  await page.locator(".tw-drawer-tabs button", { hasText: "备注与动态" }).click();
  await page.locator(".tw-note-section").waitFor({ state: "visible" });

  const section = await computedStyle(".tw-note-section");
  const composer = await computedStyle(".tw-note-section .tw-note-composer");
  const textarea = await computedStyle(".tw-note-section textarea");
  assert.deepEqual(
    [section.borderTopWidth, section.borderRightWidth, section.borderBottomWidth, section.borderLeftWidth],
    ["0px", "0px", "0px", "0px"],
    "备注逻辑区不应增加外层面板边框",
  );
  assert.deepEqual(
    [composer.borderTopWidth, composer.borderRightWidth, composer.borderBottomWidth, composer.borderLeftWidth],
    ["0px", "0px", "0px", "0px"],
    "备注布局容器不应形成中间框体",
  );
  assert.equal(composer.backgroundColor, "rgba(0, 0, 0, 0)", "备注布局容器不应增加背景面板");
  assert.deepEqual(
    [
      textarea.borderTopWidth,
      textarea.borderRightWidth,
      textarea.borderBottomWidth,
      textarea.borderLeftWidth,
    ],
    ["1px", "1px", "1px", "1px"],
    "textarea 必须保留唯一输入边界",
  );
  await page.getByRole("heading", { name: "添加跟进备注" }).waitFor();
  await page.getByRole("button", { name: "保存备注" }).waitFor();
  await shot(page, "note-composer-1440.png");
  await collectHiddenNodes(page, "candidate-drawer-activity-1440");
  assert.equal(consoleErrors.length, 0, `控制台错误：${consoleErrors.join(" | ")}`);
  recordCase("备注区单层容器", { section, composer, textarea });
  console.log("备注区单层容器验收通过");

  await verifyAssistantLayout({ width: 1440, height: 900 });
  await verifyAssistantLayout({ width: 768, height: 1024 });
  await verifyAssistantLayout({ width: 375, height: 812 });
  await verifyAssistantRequestStates();
  console.log("AI 助手桌面与移动端布局验收通过");
} finally {
  report.console_errors = consoleErrors;
  writeFileSync(resolve(evidenceDir, "qa-report.json"), JSON.stringify(report, null, 2), "utf8");
  await browser.close();
  if (!server.killed) server.kill();
}
