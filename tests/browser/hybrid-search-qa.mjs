import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const baseUrl = process.env.ANONYMOUS_QA_URL || 'http://127.0.0.1:4397'
assert.equal(new URL(baseUrl).hostname, '127.0.0.1', 'Only an explicitly local anonymous preview is allowed')
const output = resolve(process.env.ANONYMOUS_QA_OUTPUT_DIRECTORY || 'docs/evidence')
mkdirSync(output, { recursive: true })
const report = { generated_at: new Date().toISOString(), target: baseUrl, anonymous: true, navigation: ['工作台', '候选人库', '人才库分组', '职位管理', '导入候选人', 'AI 助手', '履历检索', '附件解析'], viewports: [], limitations: ['AI assistant uses the existing unconfigured state; no remote chat, real resume, file upload or production data was used.', 'No prior browser screenshots exist for pixel comparison. App.tsx is verified against the approved worktree fingerprint.'] }
const expectedAppHash = process.env.ANONYMOUS_QA_APP_HASH || '7c5ccccabc843c5a5852279aaa3e377a7f1f5ddde89b8ba7f65fafb7b59417c8'
const appHash = createHash('sha256').update(readFileSync('src/App.tsx')).digest('hex')
assert.equal(appHash, expectedAppHash, 'Navigation/business App must preserve the approved worktree')
report.app_baseline_unchanged = true

async function api(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const value = await response.json()
  assert.ok(response.ok, `${method} ${path}: ${response.status}`)
  return value
}
const people = await api('/api/candidates?page_size=100')
const candidates = people.items ?? people.data
assert.ok(candidates.length >= 20 && candidates.every((candidate) => candidate.name.startsWith('匿名')), 'Refuse any non-synthetic database')
const existingPositions = (await api('/api/positions?page_size=100')).items
const positions = []
for (let i = 1; i <= 23; i++) {
  const title = `匿名 QA 职位 ${String(i).padStart(2, '0')}`
  positions.push(existingPositions.find((position) => position.title === title) ?? await api('/api/positions', 'POST', { title, status: 'open', location: '上海', description: '匿名测试职位要求，不作为候选人本人能力证据。' }))
}
const existingPools = (await api('/api/talent-pools?page_size=100')).items
const pool = existingPools.find((item) => item.name === '匿名 QA 人才库') ?? await api('/api/talent-pools', 'POST', { name: '匿名 QA 人才库', description: '匿名分组，仅供浏览器验收。' })
await api(`/api/positions/${positions.at(-1).id}/candidates`, 'POST', { candidate_ids: candidates.map((candidate) => candidate.id) })
await api(`/api/talent-pools/${pool.id}/candidates`, 'POST', { candidate_ids: candidates.map((candidate) => candidate.id) })

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    page.setDefaultTimeout(12_000)
    const result = { viewport, cases: [], screenshots: [], layout: [], console_errors: [], console_warnings: [], page_errors: [], unexpected_http: [], expected_http: [] }
    report.viewports.push(result)
    let faultMode = 'none'
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const entry = message.text()
        if (/503|409/.test(entry) && faultMode !== 'none') result.expected_http.push(entry)
        else result.console_errors.push(entry)
      }
      if (message.type() === 'warning') result.console_warnings.push(message.text())
    })
    page.on('pageerror', (error) => result.page_errors.push(error.message))
    page.on('response', (response) => {
      if (response.status() < 400) return
      const entry = { path: new URL(response.url()).pathname, status: response.status() }
      if (faultMode !== 'none' && entry.path === '/api/resume-search') result.expected_http.push(entry)
      else result.unexpected_http.push(entry)
    })
    const check = async (name, action) => {
      try { await action(); result.cases.push({ name, passed: true }) }
      catch (error) { result.cases.push({ name, passed: false, error: String(error.message).slice(0, 800) }); console.log(`FAIL ${viewport.width} ${name}: ${error.message}`) }
    }
    const screenshot = async (name) => {
      const filename = `search-ui-${viewport.width}-${name}.png`
      await page.screenshot({ path: resolve(output, filename), animations: 'disabled' })
      result.screenshots.push(filename)
    }
    const audit = async (name) => {
      const geometry = await page.evaluate(() => {
        const region = document.querySelector('.candidate-drawer') || document.querySelector('.import-page-layer') || document.querySelector('.assistant-layer') || document.querySelector('.main-shell')
        const blocked = []
        for (const element of region.querySelectorAll('button, input:not([type="file"]), select, summary, textarea')) {
          if (element.disabled || getComputedStyle(element).visibility === 'hidden' || !element.getClientRects().length) continue
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) continue
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
          let clipped = false
          for (let parent = element.parentElement; parent && parent !== region.parentElement; parent = parent.parentElement) {
            const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect()
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (x < bounds.left || x > bounds.right)) clipped = true
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (y < bounds.top || y > bounds.bottom)) clipped = true
          }
          if (clipped) continue
          const top = document.elementFromPoint(x, y)
          if (top !== element && !element.contains(top)) blocked.push({ label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 80), tag: element.tagName, covered_by: top?.className })
        }
        return { width: innerWidth, root_width: document.documentElement.scrollWidth, blocked, nested_interactive: document.querySelectorAll('.resume-search-results button button, .resume-search-results button summary').length }
      })
      result.layout.push({ name, ...geometry })
      assert.ok(geometry.root_width <= viewport.width + 1, `${name}: root overflow ${geometry.root_width}`)
      assert.deepEqual(geometry.blocked, [], `${name}: blocked controls`)
      assert.equal(geometry.nested_interactive, 0)
    }
    const navigate = async (label) => {
      await page.goto(`${baseUrl}/index.html`)
      const nav = page.getByRole('navigation', { name: '主导航' })
      assert.deepEqual(await nav.locator('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), report.navigation)
      const mobileMenu = page.getByRole('button', { name: '打开导航', exact: true })
      if (await mobileMenu.isVisible()) await mobileMenu.click()
      await nav.getByRole('button', { name: label, exact: true }).click()
      await page.waitForLoadState('networkidle')
    }
    for (const [index, label] of report.navigation.entries()) {
      await check(`entry:${label}`, async () => {
        await navigate(label)
        await screenshot(`entry-${index + 1}`)
        await audit(label)
        if (label === '候选人库') {
          await page.getByTitle('按职位分组', { exact: true }).click()
          await audit('候选人按职位')
          await page.getByTitle('列表视图', { exact: true }).click()
          const filter = page.getByRole('button', { name: '筛选', exact: true })
          await filter.click(); await filter.click()
          assert.ok(await page.locator('.candidate-page select').count() >= 3)
          const frame = page.locator('.candidate-desktop-table')
          if (await frame.isVisible()) {
            const scroll = await frame.evaluate((element) => { element.scrollLeft = element.scrollWidth; return { width: element.clientWidth, scrollWidth: element.scrollWidth, left: element.scrollLeft } })
            assert.ok(scroll.scrollWidth <= scroll.width || scroll.left > 0, 'Wide tables must scroll inside their own container')
            await audit('候选人表格横向滚动')
          }
        }
        if (label === '人才库分组') {
          assert.ok((await page.locator('.talent-pool-page').innerText()).includes('匿名 QA 人才库'))
          await page.locator('.talent-pool-page').getByRole('button', { name: '使用中', exact: true }).click()
        }
        if (label === '职位管理') {
          assert.ok((await page.locator('.positions-page').innerText()).includes('匿名 QA 职位'))
          await page.getByRole('button', { name: '筛选', exact: true }).click()
          await page.getByRole('button', { name: '筛选', exact: true }).click()
        }
        if (label === '导入候选人') {
          await page.locator('.import-modal').getByRole('button', { name: '选择文件', exact: true }).click({ trial: true })
          await page.locator('.import-modal').getByRole('button', { name: '取消', exact: true }).click()
        }
        if (label === '附件解析') {
          assert.ok(await page.locator('.attachment-tool-panel h3').evaluate((element) => element.getBoundingClientRect().top >= document.querySelector('.assistant-page-header').getBoundingClientRect().bottom), 'Attachment heading must not overlap the back control')
          await page.getByRole('button', { name: '选择文件夹', exact: true }).click({ trial: true })
          await page.getByRole('button', { name: '返回人才库', exact: true }).click()
        }
        if (label === 'AI 助手') assert.ok((await page.locator('.assistant-drawer').innerText()).includes('尚未配置'))
      })
    }

    await navigate('履历检索')
    const panel = page.locator('.resume-search-panel')
    const input = page.getByRole('textbox', { name: '检索候选人履历' })
    const submit = page.getByRole('button', { name: '检索', exact: true })
    const search = async (query) => {
      await input.fill(query)
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/resume-search' && response.request().method() === 'POST')
      await submit.click()
      const payload = await (await response).json()
      await page.waitForFunction(() => !document.querySelector('.resume-search-progress .spin'))
      return payload
    }
    await check('independent-select-options', async () => {
      assert.ok(await panel.getByRole('combobox', { name: '职位', exact: true }).locator('option').count() >= 24)
      assert.ok((await panel.getByRole('combobox', { name: '人才库', exact: true }).innerText()).includes('匿名 QA 人才库'))
    })
    for (const query of ['上海 游戏策划 战斗系统', '找3到5年经验的后端工程师', '找3年以下经验的后端工程师', 'Unity 或 Unreal', 'Unity 不要外包', '找熟悉数值策划的人']) {
      await check(`query:${query}`, async () => {
        const payload = await search(query)
        assert.ok(payload.items.length > 0)
        assert.equal(await panel.locator('.resume-condition-summary[open]').count(), 0)
        assert.equal(await panel.locator('.resume-search-results article').count(), payload.items.length)
        await audit(query)
      })
    }
    await check('evidence-and-keyboard', async () => {
      await search('Unity 或 Unreal')
      const summary = panel.locator('.resume-evidence-detail summary').first()
      await summary.focus(); await page.keyboard.press('Enter')
      assert.equal(await panel.locator('.resume-evidence-detail').first().getAttribute('open'), '')
      assert.ok(await summary.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'))
      await audit('展开证据')
      await screenshot('search-evidence')
      await panel.locator('.resume-condition-summary summary').click()
      assert.ok(await panel.locator('.resume-condition').count() >= 1)
      await panel.locator('.resume-condition-summary summary').click()
    })
    await check('stable-pagination-and-filter-reset', async () => {
      const first = await panel.locator('.resume-result-main strong').allTextContents()
      const response = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/resume-search')
      await panel.getByRole('button', { name: '下一页', exact: true }).click()
      await response; await panel.getByText('第 2 页', { exact: true }).waitFor()
      const second = await panel.locator('.resume-result-main strong').allTextContents()
      assert.equal(first.filter((name) => second.includes(name)).length, 0)
      const previousResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/resume-search')
      const previousRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/resume-search')
      await panel.getByRole('button', { name: '上一页', exact: true }).click()
      assert.ok((await previousRequest).postDataJSON().cursor, 'Returning to page one must use its snapshot cursor')
      await previousResponse; await panel.getByText('第 1 页', { exact: true }).waitFor()
      assert.deepEqual(await panel.locator('.resume-result-main strong').allTextContents(), first, 'Returning to page one must preserve the frozen candidate order')
      await panel.getByRole('combobox', { name: '职位', exact: true }).selectOption(positions.at(-1).id)
      assert.equal(await panel.getByRole('button', { name: '下一页', exact: true }).isEnabled(), false)
      const nextRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/resume-search')
      await submit.click()
      const body = (await nextRequest).postDataJSON()
      assert.equal(body.page, 1); assert.equal(body.cursor, undefined)
      await panel.getByText('第 1 页', { exact: true }).waitFor()
      await panel.getByRole('combobox', { name: '职位', exact: true }).selectOption('')
      await panel.getByRole('combobox', { name: '人才库', exact: true }).selectOption(pool.id)
      await search('Unity 或 Unreal')
      await panel.getByRole('combobox', { name: '人才库', exact: true }).selectOption('')
    })
    await check('archive-field-source-controls', async () => {
      await panel.getByRole('group', { name: '归档范围' }).getByRole('button', { name: '归档', exact: true }).click()
      const archived = await search('Unity')
      assert.equal(archived.items.length, 0)
      await panel.getByRole('group', { name: '归档范围' }).getByRole('button', { name: '全部', exact: true }).click()
      await panel.getByRole('combobox', { name: '字段', exact: true }).selectOption('content')
      await panel.getByRole('combobox', { name: '来源', exact: true }).selectOption('profile_section')
      const scoped = await search('Unity')
      assert.ok(scoped.items.length > 0)
      await panel.getByRole('combobox', { name: '字段', exact: true }).selectOption('')
      await panel.getByRole('combobox', { name: '来源', exact: true }).selectOption('')
    })
    await check('candidate-detail-open-close', async () => {
      await search('Unity')
      await panel.locator('.resume-search-results article > button').first().click()
      const dialog = page.locator('.candidate-drawer')
      await dialog.waitFor()
      await audit('候选人详情')
      await screenshot('candidate-detail')
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      assert.equal(await dialog.count(), 0)
    })

    await navigate('履历检索')
    let pendingRelease
    await page.route('**/api/resume-search', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      if (faultMode === 'delay') {
        await new Promise((resolve) => { pendingRelease = resolve })
        try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], pagination: { page: 1, page_size: 20, total: 0, has_more: false, next_cursor: null } }) }) } catch {}
      } else if (faultMode === 'error' || faultMode === 'stale') {
        await route.fulfill({ status: faultMode === 'error' ? 503 : 409, contentType: 'application/json', body: JSON.stringify({ error: { code: faultMode === 'error' ? 'search_unavailable' : 'search_index_changed', message: faultMode === 'error' ? '匿名故障：检索暂时不可用' : '匿名故障：索引已变化，请重新检索' } }) })
      } else if (faultMode === 'long') {
        const response = await route.fetch(), payload = await response.json()
        payload.items[0].name = '匿名长姓名'.repeat(25)
        payload.items[0].current_title = 'SeniorCombatSystemsDesigner'.repeat(8)
        payload.items[0].evidence[0].snippet.text = ('匿名超长项目证据 ' + 'LongUnbrokenEvidenceToken'.repeat(10) + '\n').repeat(8)
        payload.items[0].evidence[0].snippet.highlights = []
        await route.fulfill({ response, json: payload })
      } else await route.continue()
    })
    await check('cancel-and-no-late-overwrite', async () => {
      await search('Unity')
      const before = await panel.locator('.resume-result-main strong').allTextContents()
      faultMode = 'delay'
      await input.fill('Unreal'); await submit.click()
      await page.getByRole('button', { name: '取消检索', exact: true }).click()
      pendingRelease?.(); faultMode = 'none'
      await page.getByText(/检索已取消/).waitFor()
      await page.waitForTimeout(150)
      assert.deepEqual(await panel.locator('.resume-result-main strong').allTextContents(), before)
      await page.getByRole('button', { name: '重新检索', exact: true }).click()
      await panel.locator('.resume-results-summary').getByText('“Unreal”', { exact: true }).waitFor()
    })
    await check('error-retry-and-stale-pagination', async () => {
      faultMode = 'error'; await search('Unity 或 Unreal')
      await page.getByRole('button', { name: '重试检索', exact: true }).waitFor()
      faultMode = 'none'; await page.getByRole('button', { name: '重试检索', exact: true }).click()
      await panel.getByRole('button', { name: '下一页', exact: true }).waitFor()
      faultMode = 'stale'; await panel.getByRole('button', { name: '下一页', exact: true }).click()
      await page.getByText(/匿名故障：索引已变化/).waitFor()
      assert.equal(await panel.getByRole('button', { name: '下一页', exact: true }).isEnabled(), false)
      faultMode = 'none'; await page.getByRole('button', { name: '重试检索', exact: true }).click()
      await panel.getByText('第 1 页', { exact: true }).waitFor()
    })
    await check('long-text-and-empty-state', async () => {
      faultMode = 'long'; await search('Unity')
      await panel.locator('.resume-evidence-detail summary').first().click()
      await audit('长文本展开')
      const focusClear = await panel.locator('.resume-evidence-detail summary').first().evaluate((element) => {
        const r = element.getBoundingClientRect(), header = document.querySelector('.assistant-page-header').getBoundingClientRect()
        return r.top >= header.bottom || r.right <= header.left || r.left >= header.right
      })
      assert.equal(focusClear, true, 'Evidence control must stay clear of the fixed header')
      await screenshot('long-text')
      faultMode = 'none'; await search('"ZZZUnavailableSkill987"')
      await page.getByText('未找到符合已执行条件的候选人', { exact: true }).waitFor()
      await audit('空结果')
      await screenshot('empty')
    })
    await check('composition-does-not-submit', async () => {
      let submitted = 0
      const count = (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/resume-search') submitted++ }
      page.on('request', count)
      await input.fill('数值策划')
      await input.dispatchEvent('compositionstart')
      await input.press('Enter')
      await input.dispatchEvent('compositionend')
      await page.waitForTimeout(100)
      page.off('request', count)
      assert.equal(submitted, 0)
    })
    result.passed = result.cases.every((item) => item.passed) && result.console_errors.length === 0 && result.page_errors.length === 0 && result.unexpected_http.length === 0
    await page.close()
    writeFileSync(resolve(output, 'search-ui-report.json'), JSON.stringify(report, null, 2))
  }
} finally { await browser.close() }
report.passed = report.viewports.every((viewport) => viewport.passed)
writeFileSync(resolve(output, 'search-ui-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: report.passed, viewports: report.viewports.map((result) => ({ width: result.viewport.width, passed: result.passed, cases: result.cases.length, failed: result.cases.filter((item) => !item.passed).map((item) => item.name), console_errors: result.console_errors.length, page_errors: result.page_errors.length, unexpected_http: result.unexpected_http.length })) }, null, 2))
process.exitCode = report.passed ? 0 : 1
