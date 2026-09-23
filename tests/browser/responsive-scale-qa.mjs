// 响应式尺度与列优先级验收 · 第十二轮 G1 + G3（2026-09-16）
// 15 视口 × 6 页面：无根节点横向溢出、列显隐符合规范 3.4、主标题字号落在档位区间、
// 候选人列表首屏行数达标、同一列表行高唯一、职位操作按钮不换行、显示按钮不越界。
// 只连接本机匿名虚构库：不使用正式服务、真实候选人数据、真实附件或真实模型网关。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || 'C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
)

const port = Number(process.env.RESPONSIVE_QA_PORT || 4396)
const baseUrl = process.env.TALENT_QA_URL || `http://127.0.0.1:${port}`
assert.equal(new URL(baseUrl).hostname, '127.0.0.1', '浏览器验收只允许在本机匿名预览上运行')

const evidenceDir = resolve('docs/evidence/talent-redesign')
const shotsDir = resolve(evidenceDir, 'screenshots')
mkdirSync(shotsDir, { recursive: true })

const VIEWPORTS = [
  { width: 1024, height: 768, label: '1024x768' },
  { width: 1152, height: 864, label: '1152x864' },
  { width: 1280, height: 720, label: '1280x720' },
  { width: 1366, height: 768, label: '1366x768' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1600, height: 900, label: '1600x900' },
  { width: 1680, height: 1050, label: '1680x1050' },
  { width: 1728, height: 1117, label: '1728x1117' },
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 2560, height: 1440, label: '2560x1440' },
  { width: 3840, height: 2160, label: '3840x2160' },
  { width: 768, height: 1024, label: '768x1024' },
  { width: 820, height: 1180, label: '820x1180' },
  { width: 390, height: 844, label: '390x844' }
]

const PAGES = [
  { id: 'dashboard', path: '/', table: null },
  { id: 'candidates', path: '/candidates', table: '.tw-table-candidates', columns: 'candidates' },
  { id: 'talent-pools', path: '/talent-pools', table: '.tw-table-members', columns: 'members' },
  { id: 'positions', path: '/positions', table: '.tw-position-table', columns: 'positions' },
  { id: 'assistant', path: '/assistant', table: null },
  { id: 'resume-search', path: '/resume-search', table: '.tw-search-table', columns: 'search', search: true }
]

const tierOf = (width) => {
  if (width >= 1920) return { name: 'XL', h1: 34 }
  if (width >= 1600) return { name: 'L', h1: 32 }
  if (width >= 1366) return { name: 'M', h1: 28 }
  if (width >= 1152) return { name: 'S', h1: 26 }
  if (width >= 1024) return { name: 'XS', h1: 24 }
  if (width >= 721) return { name: '平板', h1: 22 }
  return { name: '手机', h1: 20 }
}

const COLUMN_EXPECTATIONS = {
  candidates: (width) => ({
    'tw-col-select': true,
    'tw-col-name': true,
    'tw-col-recent': width > 720,
    'tw-col-positions': width >= 1024,
    'tw-col-pools': width >= 1152,
    'tw-col-place': width > 720,
    'tw-col-tags': width >= 1600,
    'tw-col-time': width >= 1366,
    'tw-col-actions': true
  }),
  members: (width) => ({
    'tw-col-select': true,
    'tw-col-name': true,
    'tw-col-recent': width > 720,
    'tw-col-positions': width >= 1024,
    'tw-col-place': width > 720,
    'tw-col-tags': width >= 1600,
    'tw-col-time': width >= 1366,
    'tw-col-actions': true
  }),
  positions: (width) => ({
    'tw-col-select': true,
    'tw-col-position-name': true,
    'tw-col-department': width >= 1152,
    'tw-col-location': width >= 1024,
    'tw-col-owner': width >= 1366,
    'tw-col-status': true,
    'tw-col-headcount': width >= 1600,
    'tw-col-candidate-count': width >= 1024,
    'tw-col-time': width >= 1366,
    'tw-col-actions': true
  }),
  search: (width) => ({
    'tw-col-name': true,
    'tw-col-place': width >= 1024,
    'tw-col-education': width >= 1152,
    'tw-col-experience': width >= 1152,
    'tw-col-recent': width >= 1024,
    'tw-col-evidence': true,
    'tw-col-actions': true
  })
}

const report = {
  generated_at: new Date().toISOString(),
  target: baseUrl,
  anonymous: true,
  gate: 'G1 分辨率矩阵 + G3 布局',
  viewports: VIEWPORTS.map((viewport) => viewport.label),
  pages: PAGES.map((page) => page.id),
  cases: [],
  matrix: [],
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
    return detail
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 400)
    failures.push(`${name}: ${message}`)
    report.cases.push({ name, ok: false, error: message })
    console.log(`FAIL ${name} :: ${message}`)
    return undefined
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

const measurement = async (page, pageDef, width) => page.evaluate((payload) => {
  const { tableSelector, columnKey, columns, width: viewportWidth } = payload
  const result = {
    overflow: {
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      win: window.innerWidth
    },
    h1: null,
    table: null,
    columns: [],
    rows: null,
    actions: null
  }
  const h1 = [...document.querySelectorAll('h1')].find((node) => {
    const style = window.getComputedStyle(node)
    return node.offsetParent !== null && style.display !== 'none' && node.textContent.trim()
  })
  if (h1) {
    result.h1 = {
      text: h1.textContent.trim(),
      size: Number.parseFloat(window.getComputedStyle(h1).fontSize)
    }
  }
  if (!tableSelector) return result
  const table = document.querySelector(tableSelector)
  if (!table) return result
  const scroll = table.closest('.tw-table-scroll') || table.parentElement
  const scrollRect = scroll.getBoundingClientRect()
  result.table = {
    scrollWidth: table.scrollWidth,
    clientWidth: scroll.clientWidth,
    fits: table.scrollWidth <= scroll.clientWidth + 2
  }
  result.columns = Object.entries(columns).map(([className, expected]) => {
    const cell = table.querySelector(`tbody td.${className}`) || table.querySelector(`thead th.${className}`)
    const display = cell ? window.getComputedStyle(cell).display : 'missing'
    return { className, expected, display, visible: display !== 'none' }
  })
  const rows = [...table.querySelectorAll('tbody tr')]
  if (rows.length) {
    const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height))
    const visible = rows.filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.top >= scrollRect.top - 1 && rect.bottom <= scrollRect.bottom + 1
    })
    result.rows = {
      total: rows.length,
      firstScreen: visible.length,
      min: Math.min(...heights),
      max: Math.max(...heights),
      unique: [...new Set(heights)].sort((left, right) => left - right)
    }
  }
  if (columnKey === 'positions') {
    const buttons = [...table.querySelectorAll('tbody .tw-col-actions .tw-link-btn')]
    result.actions = buttons.map((button) => ({
      text: button.textContent.trim(),
      width: Math.round(button.getBoundingClientRect().width),
      scrollHeight: button.scrollHeight,
      clientHeight: button.clientHeight
    }))
  }
  if (columnKey && viewportWidth) result.columnKey = columnKey
  return result
}, { tableSelector: pageDef.table, columnKey: pageDef.columns ?? null, columns: pageDef.columns ? COLUMN_EXPECTATIONS[pageDef.columns](width) : {}, width })

const runSearch = async (page) => {
  const input = page.locator('input[aria-label="检索候选人履历"]')
  if (!(await input.count())) return false
  await input.fill('产品')
  await page.locator('.tw-search-submit').click()
  try {
    await page.waitForSelector('.tw-search-table tbody tr', { timeout: 15000 })
    return true
  } catch {
    return false
  }
}

try {
  if (!process.env.TALENT_QA_URL) await startAnonymousServer()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 500) consoleErrors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })

  for (const viewport of VIEWPORTS) {
    const tier = tierOf(viewport.width)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    for (const pageDef of PAGES) {
      const label = `${viewport.label} · ${pageDef.id}`
      await step(label, async () => {
        await page.goto(`${baseUrl}${pageDef.path}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(220)
        if (pageDef.search) await runSearch(page)
        const data = await measurement(page, pageDef, viewport.width)
        await page.screenshot({
          path: resolve(shotsDir, `viewport-${viewport.width}x${viewport.height}-${pageDef.id}.jpg`),
          type: 'jpeg',
          quality: 72
        })
        const problems = []
        assert.ok(
          data.overflow.doc <= data.overflow.win + 1 && data.overflow.body <= data.overflow.win + 1,
          `根节点横向溢出 ${JSON.stringify(data.overflow)}`
        )
        if (data.h1) {
          assert.ok(
            Math.abs(data.h1.size - tier.h1) <= 1,
            `${tier.name} 档主标题字号 ${data.h1.size}px ≠ ${tier.h1}px（${data.h1.text}）`
          )
        }
        if (data.columns.length) {
          const wrong = data.columns.filter((column) => column.expected !== column.visible)
          assert.equal(
            wrong.length,
            0,
            `列显隐不符：${wrong.map((column) => `${column.className}=${column.display}`).join('、')}`
          )
        }
        if (data.table && data.table.fits === false) {
          problems.push(`表格横向滚动 ${data.table.scrollWidth} > ${data.table.clientWidth}`)
          assert.fail(`表格横向滚动 ${data.table.scrollWidth} > ${data.table.clientWidth}`)
        }
        if (data.rows && data.rows.total) {
          const spread = data.rows.max - data.rows.min
          if (pageDef.columns === 'candidates' || pageDef.columns === 'members' || pageDef.columns === 'positions') {
            assert.ok(spread <= 2, `行高不一致：${data.rows.unique.join('/')}`)
          }
          if (pageDef.columns === 'candidates') {
            const minimum = tier.name === 'XL' || tier.name === 'L' || tier.name === 'M' ? 5 : 4
            assert.ok(
              data.rows.firstScreen >= minimum,
              `首屏可见行数 ${data.rows.firstScreen} < ${minimum}（共 ${data.rows.total} 行）`
            )
          }
        }
        if (data.actions) {
          for (const action of data.actions) {
            assert.ok(
              action.scrollHeight <= action.clientHeight + 1,
              `职位操作按钮换行：${action.text} ${action.scrollHeight}/${action.clientHeight}`
            )
            assert.ok(action.width >= 24, `职位操作按钮被压扁：${action.text} ${action.width}px`)
          }
        }
        report.matrix.push({ viewport: viewport.label, tier: tier.name, page: pageDef.id, ...data, problems })
        return { h1: data.h1?.size ?? null, columns: data.columns.length, rows: data.rows?.firstScreen ?? null, problems }
      })
    }
  }

  // G3 · 详情抽屉「显示」按钮不越出卡片（D4）
  for (const viewport of [{ width: 1536, height: 1024 }, { width: 1093, height: 614 }, { width: 1280, height: 720 }]) {
    await step(`抽屉显示按钮不越界 · ${viewport.width}x${viewport.height}`, async () => {
      await page.setViewportSize(viewport)
      await page.goto(`${baseUrl}/candidates`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(260)
      await page.locator('.tw-table-candidates tbody tr').first().click()
      await page.waitForSelector('.tw-drawer .tw-section', { timeout: 15000 })
      await page.waitForTimeout(200)
      const result = await page.evaluate(() => {
        const section = document.querySelector('.tw-drawer .tw-section')
        if (!section) return null
        const style = window.getComputedStyle(section)
        const sectionRect = section.getBoundingClientRect()
        const buttons = [...section.querySelectorAll('.tw-reveal-btn')]
        if (!buttons.length) return { skipped: true }
        return buttons.map((button) => {
          const rect = button.getBoundingClientRect()
          return {
            right: Math.round(rect.right),
            limit: Math.round(sectionRect.right - Number.parseFloat(style.paddingRight)),
            width: Math.round(rect.width)
          }
        })
      })
      if (!result) throw new Error('详情抽屉未渲染基本资料卡片')
      const screenshot = `viewport-${viewport.width}x${viewport.height}-candidates-drawer.jpg`
      await page.screenshot({
        path: resolve(shotsDir, screenshot),
        type: 'jpeg',
        quality: 72
      })
      if (result.skipped) return { skipped: true, screenshot }
      for (const item of result) {
        assert.ok(item.right <= item.limit + 1, `显示按钮越界：${item.right} > ${item.limit}`)
      }
      return { measurements: result, screenshot }
    })
  }

  assert.equal(consoleErrors.length, 0, `控制台错误：${consoleErrors.slice(0, 3).join(' | ')}`)
  await context.close()
  await browser.close()
} catch (error) {
  failures.push(`未捕获异常：${String((error && error.message) || error)}`)
  console.log(`FAIL 未捕获异常 :: ${String((error && error.message) || error)}`)
} finally {
  report.console_errors = consoleErrors
  report.failures = failures
  writeFileSync(resolve(evidenceDir, 'responsive-scale-report.json'), JSON.stringify(report, null, 2))
  if (server) server.kill()
}

console.log(`\n响应式验收：${report.cases.filter((item) => item.ok).length}/${report.cases.length} 通过`)
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures.slice(0, 40)) console.log(` - ${failure}`)
  process.exitCode = 1
}
