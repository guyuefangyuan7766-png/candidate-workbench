import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const evidenceDir = resolve("docs/evidence/round14-ui-polish");
const shotsDir = resolve(evidenceDir, "screenshots");
mkdirSync(shotsDir, { recursive: true });

const bundle = await build({
  entryPoints: [resolve("tests/browser/avatar-harness.tsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  outdir: "avatar-test",
  platform: "browser",
  write: false,
});

const javascript = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
assert.ok(javascript, "头像测试 bundle 缺少 JavaScript");

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="/avatar-test.js"></script></body></html>`);
    return;
  }
  if (requestUrl.pathname === "/avatar-test.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(javascript);
    return;
  }
  if (requestUrl.pathname === "/api/candidates/avatar-failure/avatar") {
    response.statusCode = 500;
    response.end("avatar failed");
    return;
  }
  if (requestUrl.pathname === "/api/candidates/avatar-success/avatar") {
    response.setHeader("content-type", "image/png");
    response.end(png);
    return;
  }
  if (requestUrl.pathname === "/api/candidates/avatar-loading/avatar") {
    setTimeout(() => {
      response.setHeader("content-type", "image/png");
      response.end(png);
    }, 2_500);
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push({
      text: message.text(),
      url: message.location().url,
    });
  }
});
page.on("pageerror", (error) => consoleErrors.push({ text: `pageerror: ${error.message}`, url: "" }));

async function inspect(selector) {
  return page.locator(selector).evaluate((element) => {
    const image = element.querySelector("img");
    const container = element.querySelector(".avatar, .tw-avatar");
    return {
      image: image
        ? {
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            width: image.getBoundingClientRect().width,
            height: image.getBoundingClientRect().height,
          }
        : null,
      text: container?.textContent?.trim() ?? "",
      containerWidth: container?.getBoundingClientRect().width ?? 0,
      containerHeight: container?.getBoundingClientRect().height ?? 0,
    };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-avatar-case="tw-success"] img');

  for (const component of ["candidate", "tw"]) {
    const noPhoto = await inspect(`[data-avatar-case="${component}-noPhoto"]`);
    assert.equal(noPhoto.image, null, `${component} 无图状态不应渲染 img`);
    assert.ok(noPhoto.text, `${component} 无图状态应显示姓名首字`);

    const loading = await inspect(`[data-avatar-case="${component}-loading"]`);
    assert.ok(loading.image, `${component} 加载中应渲染 img`);
    assert.equal(loading.image.complete, false, `${component} 加载中图片不应已经完成`);
    assert.equal(loading.text, "", `${component} 加载中不得同时显示姓名首字`);

    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector(`${selector} img`);
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
      },
      `[data-avatar-case="${component}-success"]`,
    );
    const success = await inspect(`[data-avatar-case="${component}-success"]`);
    assert.ok(success.image?.naturalWidth, `${component} 成功状态应显示真实图片`);
    assert.equal(success.text, "", `${component} 成功状态不得同时显示姓名首字`);

    await page.waitForFunction(
      (selector) => !document.querySelector(`${selector} img`),
      `[data-avatar-case="${component}-failure"]`,
    );
    const failure = await inspect(`[data-avatar-case="${component}-failure"]`);
    assert.equal(failure.image, null, `${component} 失败状态应卸载 img`);
    assert.ok(failure.text, `${component} 失败状态应稳定回退到姓名首字`);
  }

  const success = await inspect('[data-avatar-case="tw-success"]');
  assert.deepEqual(
    { width: success.containerWidth, height: success.containerHeight },
    { width: 40, height: 40 },
    "TwAvatar 默认尺寸不应改变",
  );
  const candidateAvatar = await inspect('[data-avatar-case="candidate-success"]');
  assert.deepEqual(
    { width: candidateAvatar.containerWidth, height: candidateAvatar.containerHeight },
    { width: 32, height: 32 },
    "CandidateAvatar 默认尺寸不应改变",
  );
  const unexpectedErrors = consoleErrors.filter((error) => !error.url.includes("/api/candidates/avatar-failure/avatar"));
  assert.equal(
    unexpectedErrors.length,
    0,
    `控制台错误：${unexpectedErrors.map((error) => error.text).join(" | ")}`,
  );
  const screenshotPath = resolve(shotsDir, "avatar-states.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  writeFileSync(
    resolve(evidenceDir, "avatar-report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        states: ["no-photo", "loading", "success", "failure"],
        components: ["CandidateAvatar", "TwAvatar"],
        screenshot: "screenshots/avatar-states.png",
        console_errors: unexpectedErrors,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("头像组件状态验收通过");
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
