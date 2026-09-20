// 导航表面（surface）互斥验收 · 第十二轮 G2
// 只连接本机匿名虚构库：不使用正式服务、真实候选人数据或真实模型网关。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || 'C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
)

const port = Number(process.env.SURFACE_QA_PORT || 4397)
const baseUrl = process.env.TALENT_QA_URL || `http://127.0.0.1:${port}`
assert.equal(new URL(baseUrl).hostname, '127.0.0.1', '浏览器验收只允许在本机匿名预览上运行')

const evidenceDir = resolve('docs/evidence/talent-redesign')
mkdirSync(evidenceDir, { recursive: true })

const report = {
  generated_at: new Date().toISOString(),
  target: baseUrl,
  anonymous: true,
  gate: 'G2 导航表面互斥',
  cases: [],
  console_errors: []
}
const failures = []
const consoleErrors = []
let server = null

async function step(name, fn) {
  try {
    const detail = await fn()
    report.cases.push({ name, ok: true, detail: detail ?? null })
    console.log(`PASS ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 220)}`)
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 400)
    failures.push(`${name}: ${message}`)
    report.cases.push({ name, ok: false, error: message })
    console.log(`FAIL ${name} :: ${message}`)
  }
}

async function startAnonymousServer() {
  server = spawn(process.execPath, ['tests/browser/anonymous-talent-workspace-server.mjs', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error('匿名预览服务启动超时')), 45000)
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Anonymous talent workspace')) {
        clearTimeout(timer)
        resolveStart()
      }
    })
    server.stderr.on('data', (chunk) => process.stderr.write(String(chunk)))
    server.on('exit', (code) => rejectStart(new Error(`匿名预览服务提前退出：${code}`)))
  })
}

const hostname = new URL(baseUrl).hostname
assert.equal(hostname, '127.0.0.1')

try {
  if (!process.env.TALENT_QA_URL) await startAnonymousServer()

  const candidates = await fetch(`${baseUrl}/api/candidates?page_size=100`).then((response) => response.json())
  const pools = await fetch(`${baseUrl}/api/talent-pools?page_size=100`).then((response) => response.json())
  const poolNames = (pools.items ?? pools.data ?? []).map((pool) => pool.name).filter(Boolean)
  const items = candidates.items ?? candidates.data ?? []
  assert.ok(items.length >= 40, '匿名候选人不足，拒绝在非匿名库上验收')
  assert.ok(items.every((item) => String(item.id).startsWith('anon-tw-candidate-')), '库中存在非匿名候选人，拒绝继续')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 500) consoleErrors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })

  const pathname = () => new URL(page.url()).pathname
  const visibleHeadings = async () => page.locator('h1:visible').allInnerTexts()
  const activeNavItems = async () => page.locator('.tw-nav-item.active:visible').evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-label') || item.textContent || '')
  )
  const visibleSurfaces = async () => ({
    page: await page.locator('.tw-content-stack:visible').count(),
    tool: await page.locator('.tw-tool-page:visible').count(),
    import: await page.locator('section[aria-label="导入候选人"]:visible').count()
  })

  const state = async () => {
    const headings = (await visibleHeadings()).map((item) => item.trim()).filter(Boolean)
    const nav = (await activeNavItems()).map((item) => item.trim()).filter(Boolean)
    return { path: pathname(), headings, nav, surfaces: await visibleSurfaces() }
  }
  const expectState = async (expected) => {
    const current = await state()
    assert.equal(current.headings.length, 1, `可见 h1 数量应为 1，实际 ${JSON.stringify(current)}`)
    const allowed = expected.headings || [expected.heading]
    assert.ok(
      allowed.includes(current.headings[0]),
      `屏幕标题应为 ${JSON.stringify(allowed)} 之一，实际 ${JSON.stringify(current.headings)}`
    )
    assert.equal(current.nav.length, 1, `侧栏高亮应唯一，实际 ${JSON.stringify(current.nav)}`)
    assert.equal(current.nav[0], expected.nav, `侧栏高亮应为「${expected.nav}」，实际 ${JSON.stringify(current.nav)}`)
    assert.equal(current.path, expected.path, `URL 应为 ${expected.path}，实际 ${current.path}`)
    const surfaceCount = current.surfaces.page + current.surfaces.tool + current.surfaces.import
    assert.equal(surfaceCount, 1, `可见表面数量应为 1，实际 ${JSON.stringify(current.surfaces)}`)
    return current
  }
  const clickNav = async (label) => {
    await page.getByRole('button', { name: label, exact: true }).first().click()
    await page.waitForTimeout(700)
  }
  const goto = async (path) => {
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
  }
  const closeRecoveredImport = async () => {
    if (await page.locator('section[aria-label="导入候选人"]').count()) {
      await page.getByRole('button', { name: '返回人才库', exact: true }).first().click()
      await page.waitForTimeout(600)
    }
  }

  await step('起始：/ 只有工作台一个表面', async () => {
    await goto('/')
    await closeRecoveredImport()
    return await expectState({ heading: '人才资产概览', nav: '工作台', path: '/' })
  })

  await step('场景 1：先开助手，再点导入候选人 → 只有一个表面', async () => {
    await clickNav('AI 助手')
    await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
    await clickNav('导入候选人')
    return await expectState({ heading: '导入候选人', nav: '导入候选人', path: '/import' })
  })

  await step('场景 2：先开导入，再点 AI 助手 → 不叠加', async () => {
    await clickNav('AI 助手')
    await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
    await clickNav('导入候选人')
    await expectState({ heading: '导入候选人', nav: '导入候选人', path: '/import' })
    await clickNav('AI 助手')
    return await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
  })

  await step('场景 3：直接访问 /assistant（刷新后仍是助手）', async () => {
    await goto('/assistant')
    await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    return await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
  })

  await step('场景 4：直接访问 /import（刷新后仍是导入页）', async () => {
    await goto('/import')
    await expectState({ heading: '导入候选人', nav: '导入候选人', path: '/import' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    return await expectState({ heading: '导入候选人', nav: '导入候选人', path: '/import' })
  })

  await step('场景 5：工具页三页互切，URL 与高亮同步', async () => {
    await clickNav('履历检索')
    await expectState({ heading: '履历检索', nav: '履历检索', path: '/resume-search' })
    await clickNav('附件解析')
    await expectState({ heading: '解析并更新候选人', nav: '附件解析', path: '/attachment-parser' })
    await clickNav('AI 助手')
    return await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
  })

  await step('重复点击已激活入口 = 关闭并回到进入前页面', async () => {
    await clickNav('候选人库')
    await expectState({ heading: '候选人库', nav: '候选人库', path: '/candidates' })
    await clickNav('AI 助手')
    await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
    await clickNav('AI 助手')
    await expectState({ heading: '候选人库', nav: '候选人库', path: '/candidates' })
    await clickNav('导入候选人')
    await expectState({ heading: '导入候选人', nav: '导入候选人', path: '/import' })
    await clickNav('导入候选人')
    return await expectState({ heading: '候选人库', nav: '候选人库', path: '/candidates' })
  })

  await step('工具页打开时切换主页面不残留', async () => {
    await clickNav('AI 助手')
    await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
    await clickNav('人才库分组')
    await expectState({ headings: ['人才库分组', ...poolNames], nav: '人才库分组', path: '/talent-pools' })
    await clickNav('职位管理')
    const current = await expectState({ heading: '职位管理', nav: '职位管理', path: '/positions' })
    const toolSurface = await page.locator('.tw-tool-page:visible').count()
    assert.equal(toolSurface, 0, '主页面可见时不应残留工具页')
    return current
  })

  await step('Esc 关闭工具页并回到进入前页面', async () => {
    await clickNav('候选人库')
    await clickNav('AI 助手')
    await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    return await expectState({ heading: '候选人库', nav: '候选人库', path: '/candidates' })
  })

  await step('浏览器前进后退与表面一致', async () => {
    await clickNav('AI 助手')
    await page.goBack()
    await page.waitForTimeout(700)
    await expectState({ heading: '候选人库', nav: '候选人库', path: '/candidates' })
    await page.goForward()
    await page.waitForTimeout(700)
    return await expectState({ heading: 'AI 助手', nav: 'AI 助手', path: '/assistant' })
  })

  await step('检索结果打开候选人档案不清空工具表面', async () => {
    await clickNav('履历检索')
    const layer = page.locator('.tw-tool-page').first()
    await layer.waitFor({ state: 'visible' })
    await layer.locator('.tw-search-bar input').first().fill('产品')
    await layer.locator('.tw-search-submit').first().click()
    await page.waitForTimeout(2500)
    const action = page.locator('.tw-search-table tbody tr .tw-col-actions button').first()
    if (!(await action.count())) return { skipped: '匿名库无检索结果' }
    await action.click()
    await page.locator('.tw-drawer').first().waitFor({ state: 'visible' })
    await page.waitForTimeout(500)
    const headings = await visibleHeadings()
    assert.ok(headings.some((item) => item.includes('履历检索')), `抽屉打开后工具页标题丢失：${JSON.stringify(headings)}`)
    assert.equal(pathname(), '/resume-search', `抽屉打开后 URL 被改写：${pathname()}`)
    await page.locator('.tw-drawer button[aria-label^="关闭"]').first().click()
    await page.waitForTimeout(500)
    return { drawer: true }
  })

  await browser.close()
} finally {
  if (server && !server.killed) server.kill()
}

report.console_errors = consoleErrors
writeFileSync(resolve(evidenceDir, 'surface-navigation-report.json'), JSON.stringify(report, null, 2) + '\n')

const passed = report.cases.filter((item) => item.ok).length
console.log(`\n通过 ${passed}/${report.cases.length} 项；控制台错误 ${consoleErrors.length} 条`)
if (failures.length) console.log('失败明细：\n- ' + failures.join('\n- '))
assert.equal(consoleErrors.length, 0, `控制台出现错误：${consoleErrors.slice(0, 3).join(' | ')}`)
assert.equal(failures.length, 0, `存在未通过的验收项：${failures.join(' | ')}`)
console.log('导航表面互斥验收通过')
