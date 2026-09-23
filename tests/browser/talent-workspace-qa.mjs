// 人才库前端改版 · 匿名库浏览器验收（2026-09-14）
// 只连接本机匿名虚构库：不使用正式服务、真实候选人数据、真实附件或真实模型网关。
// 旧的 tests/browser/hybrid-search-qa.mjs 锁定了改版前的 App.tsx 哈希，不能作为本轮验收。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || 'C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
)

const port = Number(process.env.TALENT_QA_PORT || 4399)
const baseUrl = process.env.TALENT_QA_URL || `http://127.0.0.1:${port}`
assert.equal(new URL(baseUrl).hostname, '127.0.0.1', '浏览器验收只允许在本机匿名预览上运行')

const evidenceDir = resolve('docs/evidence/talent-redesign')
const shotsDir = resolve(evidenceDir, 'screenshots')
mkdirSync(shotsDir, { recursive: true })

const report = {
  generated_at: new Date().toISOString(),
  target: baseUrl,
  anonymous: true,
  dataset: null,
  design_frames: [
    { id: '01', state: '工作台 / 真实统计与分布', shot: '01-overview.png' },
    { id: '02', state: '候选人库 / 范围 tabs、搜索筛选、列表视图', shot: '02-candidates.png' },
    { id: '03', state: '人才库分组 / 主从布局与成员', shot: '03-talent-pools.png' },
    { id: '04', state: '职位管理 / 状态 tabs 与表格', shot: '04-positions.png' },
    { id: '05', state: '数据导入 / 选择文件', shot: '05-import-upload.png' },
    { id: '06', state: 'AI 助手 / 未配置模型网关的真实状态', shot: '06-assistant.png' },
    { id: '07', state: '履历检索 / 关键词结果与匹配证据', shot: '07-resume-search.png' },
    { id: '08', state: '附件解析 / 批次入口与状态', shot: '08-attachments.png' },
    { id: '09', state: '候选人详情 / 档案页签', shot: '09-detail-profile.png' },
    { id: '10', state: '候选人详情 / 履历页签', shot: '10-detail-resume.png' },
    { id: '11', state: '候选人详情 / 历史评估页签', shot: '11-detail-assessment.png' },
    { id: '12', state: '候选人详情 / 备注与动态页签', shot: '12-detail-activity.png' },
    { id: '13', state: '候选人详情 / 高级信息页签', shot: '13-detail-advanced.png' },
    { id: '14', state: '候选人编辑 / 分区表单', shot: '14-candidate-edit.png' },
    { id: '15', state: '职位详情 / 关联候选人与操作', shot: '15-position-detail.png' },
    { id: '16', state: '新增职位 / 右侧表单', shot: '16-position-form.png' },
    { id: '17', state: '加入候选人 / 选择对话框', shot: '17-pool-picker.png' },
    { id: '18', state: '数据导入 / 字段映射', shot: '18-import-mapping.png' },
    { id: '19', state: '数据导入 / 预览校验与问题行', shot: '19-import-preview.png' },
    { id: '20', state: '附件解析 / 候选人相关附件与文档视图（逐项差异确认依赖本地解析网关）', shot: '20-attachment-review.png' },
    { id: '21', state: '人才库管理 / 新建编辑对话框', shot: '21-pool-editor.png' },
    { id: '22', state: '批量操作 / 归档确认', shot: '22-bulk-archive.png' }
  ],
  cases: [],
  viewports: [],
  console_errors: [],
  limitations: [
    'AI 助手在匿名环境未配置模型网关：只验证真实未配置状态，未验证远程会话、流式回答与只读工具调用。',
    '附件解析建议需要本地解析网关生成差异：匿名环境验证批次、候选人文档与无建议降级，未验证模型建议的逐项写入。',
    '1440/1280/768/390 只做入口、布局与横向溢出检查，不要求复制桌面四栏。'
  ]
}
const failures = []
const consoleErrors = []
let server = null

async function step(name, fn) {
  try {
    const detail = await fn()
    report.cases.push({ name, ok: true, detail: detail ?? null })
    console.log(`PASS ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 200)}`)
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

async function api(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  const value = text ? JSON.parse(text) : null
  assert.ok(response.ok, `${method} ${path} 返回 ${response.status}：${text.slice(0, 200)}`)
  return value
}

const listOf = (payload) => payload?.items ?? payload?.data ?? []
const rows = (page) => page.locator('.tw-table tbody tr')

try {
  if (!process.env.TALENT_QA_URL) await startAnonymousServer()

  const candidateItems = listOf(await api('/api/candidates?page_size=100'))
  const poolItems = listOf(await api('/api/talent-pools?page_size=100'))
  const positionItems = listOf(await api('/api/positions?page_size=100'))
  assert.ok(candidateItems.length >= 40, '匿名候选人不足，拒绝在非匿名库上验收')
  assert.ok(
    candidateItems.every((item) => String(item.id).startsWith('anon-tw-candidate-')),
    '库中存在非匿名候选人，拒绝继续'
  )
  const primary = candidateItems.find((item) => item.name === '林悦') ?? candidateItems[0]
  report.dataset = {
    candidates: candidateItems.length,
    talent_pools: poolItems.length,
    positions: positionItems.length,
    primary_candidate: primary.name
  }

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
  const importTaskSnapshots = []
  page.on('response', async (response) => {
    if (!response.url().includes('/import/tasks/')) return
    try {
      const payload = await response.json()
      if (payload && payload.result && payload.result.summary) importTaskSnapshots.push({ status: payload.status, summary: payload.result.summary, at: Date.now() })
    } catch {
      // 任务响应可能不是 JSON（轮询中断等），忽略
    }
  })

  const shot = async (name) => {
    await page.screenshot({ path: resolve(shotsDir, name) })
    return name
  }
  const noOverflow = async () => {
    const metrics = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      win: window.innerWidth
    }))
    assert.ok(metrics.doc <= metrics.win + 1 && metrics.body <= metrics.win + 1, `根页面横向溢出 ${JSON.stringify(metrics)}`)
    return metrics
  }
  const resetPage = async () => {
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    // 导入任务可恢复时应用会自动打开导入页：先关闭，保证后续步骤从主内容区开始
    if (await page.locator('.tw-import-foot').count()) {
      await page.getByRole('button', { name: '返回人才库', exact: true }).first().click().catch(() => {})
      await page.waitForTimeout(400)
    }
  }
  const openMobileNav = async () => {
    const toggle = page.getByRole('button', { name: '打开导航' }).first()
    if ((await toggle.count()) && (await toggle.isVisible())) {
      await toggle.click()
      await page.waitForTimeout(400)
    }
  }
  const nav = async (label) => {
    if (await page.locator('.tw-tool-page, section[aria-label="导入候选人"], .tw-modal-layer, .tw-drawer-layer').count()) await resetPage()
    await openMobileNav()
    await page.getByRole('button', { name: label, exact: true }).first().click()
    await page.waitForTimeout(800)
  }
  const openImport = async () => {
    await page.getByRole('button', { name: '导入候选人', exact: true }).first().click()
    await page.waitForTimeout(800)
  }
  const dismissLayer = async (label) => {
    const button = page.getByRole('button', { name: label, exact: true }).first()
    if (await button.count()) {
      await button.click()
      await page.waitForTimeout(500)
    }
  }
  const openCandidate = async (name) => {
    await rows(page).filter({ hasText: name }).first().click()
    await page.locator('.tw-drawer').waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
  }
  const closeDrawer = async () => {
    await page.locator('.tw-drawer button[aria-label^="关闭"]').first().click()
    await page.waitForTimeout(500)
  }
  const openDrawerTab = async (label) => {
    await page.locator('.tw-drawer-tabs button', { hasText: label }).first().click()
    await page.waitForTimeout(800)
  }

  await resetPage()

  await step('工作台：真实统计与分布', async () => {
    const heading = await page.locator('h1').first().innerText()
    assert.ok(heading.includes('人才资产概览'), `工作台标题异常：${heading}`)
    assert.ok((await page.locator('.tw-metric').count()) >= 4, '统计卡片缺失')
    assert.ok((await page.locator('.tw-bar-row').count()) > 0, '分布条缺失')
    await shot('01-overview.png')
    return await noOverflow()
  })

  await step('工作台：最近候选人跳转档案', async () => {
    await page.locator('.tw-recent-row').first().click()
    await page.locator('.tw-drawer').waitFor({ state: 'visible' })
    const title = await page.locator('.tw-drawer h2').innerText()
    await closeDrawer()
    return { opened: title }
  })

  await step('候选人库：标题、范围 tabs 与列表列名', async () => {
    await nav('候选人库')
    assert.equal(await page.locator('.tw-page-head h1').innerText(), '候选人库')
    assert.equal(await page.locator('.tw-scope button').count(), 3)
    const header = await page.locator('.tw-table thead').innerText()
    assert.ok(header.includes('最近职位 / 公司'), `列表列名未使用最近术语：${header}`)
    await shot('02-candidates.png')
    return await noOverflow()
  })

  await step('候选人库：搜索命中与空结果', async () => {
    const search = page.locator('.tw-toolbar .tw-search input')
    await search.fill(primary.name)
    await page.waitForTimeout(900)
    assert.ok((await rows(page).first().innerText()).includes(primary.name), '搜索未命中匿名候选人')
    await search.fill('不存在姓名QA')
    await page.waitForTimeout(900)
    const empty = await page.locator('.tw-page').innerText()
    assert.ok(/没有|暂无|未找到/.test(empty), '无结果状态缺失')
    await search.fill('')
    await page.waitForTimeout(700)
    return { hits: primary.name }
  })

  await step('候选人库：学历筛选与服务端一致', async () => {
    const chipRow = page.locator('.tw-chips')
    assert.equal(await chipRow.locator('button.tw-select-trigger').count(), 4, '常驻筛选 chips 行维度数量异常')
    assert.ok(await chipRow.locator('button.tw-chip:not(.tw-select-trigger)').count(), '缺少更多筛选入口')
    const education = chipRow.locator('.tw-select').filter({ hasText: '学历' }).locator('button.tw-select-trigger')
    await education.click()
    await page.locator('.tw-select-list').getByRole('option', { name: '本科', exact: true }).click()
    await page.waitForTimeout(1000)
    const expected = listOf(await api('/api/candidates?page_size=100&education=本科'))
    const shown = await rows(page).count()
    assert.ok(shown > 0 && shown <= expected.length, `筛选与服务端不一致 页面=${shown} 服务端=${expected.length}`)
    await education.click()
    await page.locator('.tw-select-list').getByRole('option', { name: '全部学历', exact: true }).click()
    await page.waitForTimeout(900)
    return { filtered: shown, server: expected.length }
  })

  await step('候选人库：分页与按职位视图', async () => {
    const pageTwo = listOf(await api('/api/candidates?page_size=20&page=2'))
    let paged = null
    if (pageTwo.length) {
      await page.locator('.tw-pagination button[aria-label="下一页"]').first().click()
      await page.waitForTimeout(1200)
      paged = await rows(page).first().innerText()
      assert.ok(paged.includes(pageTwo[0].name), '分页结果与服务端不一致')
      await page.locator('.tw-pagination button[aria-label="上一页"]').first().click()
      await page.waitForTimeout(900)
    }
    await page.getByRole('button', { name: '按职位', exact: true }).click()
    await page.waitForTimeout(1000)
    assert.ok((await page.locator('.tw-group-head').count()) > 0, '按职位分组视图缺少分组标题')
    await shot('02b-candidates-grouped.png')
    await page.getByRole('button', { name: '列表', exact: true }).click()
    await page.waitForTimeout(700)
    return { page_two_first: paged && paged.split('\n')[0] }
  })

  await step('候选人库：导出菜单与取消批量选择', async () => {
    await page.getByRole('button', { name: /导出/ }).first().click()
    await page.waitForTimeout(400)
    const menu = page.locator('.tw-menu[role="menu"]')
    assert.ok(await menu.isVisible(), '导出菜单未展开')
    const items = await menu.getByRole('menuitem').allInnerTexts()
    assert.ok(items.length >= 2, '导出格式选项缺失')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await rows(page).nth(0).locator('input[type="checkbox"]').check()
    await rows(page).nth(1).locator('input[type="checkbox"]').check()
    await page.waitForTimeout(400)
    const bar = page.locator('.tw-bulk').first()
    assert.ok((await bar.innerText()).includes('已选择 2 位'), '批量工具条未反映选择')
    await bar.getByRole('button', { name: '取消选择' }).click()
    await page.waitForTimeout(400)
    assert.equal(await page.locator('.tw-bulk').count(), 0, '取消选择后批量工具条仍在')
    return items.map((item) => item.split('\n')[0])
  })

  await step('候选人库：批量归档确认（可逆操作）', async () => {
    await rows(page).nth(0).locator('input[type="checkbox"]').check()
    await rows(page).nth(1).locator('input[type="checkbox"]').check()
    await page.waitForTimeout(400)
    await page.locator('.tw-bulk').getByRole('button', { name: '批量归档' }).click()
    const dialog = page.locator('.tw-modal-layer [role="alertdialog"]').first()
    await dialog.waitFor({ state: 'visible' })
    const text = await dialog.innerText()
    assert.ok(/归档/.test(text) && /恢复/.test(text), `归档确认缺少可恢复说明：${text}`)
    await shot('22-bulk-archive.png')
    await dialog.getByRole('button', { name: '取消' }).click()
    await page.waitForTimeout(400)
    await page.locator('.tw-bulk').getByRole('button', { name: '取消选择' }).click()
    await page.waitForTimeout(300)
    return { dialog: text.split('\n').filter(Boolean).slice(0, 2) }
  })

  await step('候选人详情：固定五页签与档案内容', async () => {
    await openCandidate(primary.name)
    const tabs = await page.locator('.tw-drawer-tabs button').allInnerTexts()
    assert.deepEqual(tabs, ['档案', '履历', '历史评估', '备注与动态', '高级信息'], `页签发生变化：${tabs.join('/')}`)
    const body = await page.locator('.tw-drawer').innerText()
    assert.ok(body.includes('最近经历与教育摘要'), '档案缺少最近经历与教育摘要标题')
    assert.ok(!/当前职位|当前公司|当前经历/.test(body), '候选人语境仍出现旧术语')
    await shot('09-detail-profile.png')
    return tabs
  })

  await step('候选人详情：履历页签与附件', async () => {
    await openDrawerTab('履历')
    await shot('10-detail-resume.png')
    const text = await page.locator('.tw-drawer').innerText()
    assert.ok(/工作经历|教育经历|项目经历|专业技能/.test(text), '履历页签缺少履历分组区域')
    return { groups: ['工作经历', '教育经历', '项目经历', '专业技能'].filter((name) => text.includes(name)), mentions_attachment: /附件/.test(text) }
  })

  await step('候选人详情：历史评估页签', async () => {
    await openDrawerTab('历史评估')
    await shot('11-detail-assessment.png')
    const text = await page.locator('.tw-drawer').innerText()
    assert.ok(text.includes('历史评估'), '历史评估页签内容缺失')
    return { source_records: /来源记录|暂无历史评估资料/.test(text) }
  })

  await step('候选人详情：备注与动态页签', async () => {
    await openDrawerTab('备注与动态')
    await shot('12-detail-activity.png')
    return await noOverflow()
  })

  await step('候选人详情：高级信息按需加载', async () => {
    await openDrawerTab('高级信息')
    const loadButton = page.locator('.tw-drawer').getByRole('button', { name: /加载|查看/ }).first()
    const hasLoad = (await loadButton.count()) > 0
    if (hasLoad) {
      await loadButton.click()
      await page.waitForTimeout(1300)
    }
    await shot('13-detail-advanced.png')
    return { explicit_load: hasLoad }
  })

  await step('候选人编辑：分区表单', async () => {
    const edit = page.getByRole('button', { name: '编辑资料', exact: true }).first()
    assert.ok(await edit.count(), '详情缺少编辑入口')
    await edit.click()
    await page.waitForTimeout(1000)
    const form = await page.locator('.tw-drawer').innerText()
    assert.ok(form.includes('职业与教育') && form.includes('最近公司') && form.includes('最近职位'), `编辑表单未使用最近术语：${form.slice(0, 120)}`)
    assert.ok(form.includes('履历资料'), '编辑表单缺少履历资料分区')
    assert.ok(!/当前职位|当前公司|当前经历/.test(form), '编辑表单仍出现旧术语')
    await shot('14-candidate-edit.png')
    await dismissLayer('取消')
    return { has_section: form.includes('最近经历') }
  })

  await step('人才库分组：主从布局与成员', async () => {
    await resetPage()
    await nav('人才库分组')
    await page.locator('.tw-subnav-list button').first().click()
    await page.waitForTimeout(1000)
    const summary = await page.locator('.tw-pane-head').first().innerText()
    assert.ok(/位候选人|位成员/.test(summary), `成员统计缺失：${summary}`)
    const header = await page.locator('.tw-main-pane .tw-table thead').innerText().catch(() => '')
    assert.ok(!/当前职位|当前公司|当前经历/.test(header), `成员表仍出现旧术语：${header}`)
    await shot('03-talent-pools.png')
    return { summary, overflow: await noOverflow() }
  })

  await step('人才库分组：新建与编辑对话框', async () => {
    await page.getByRole('button', { name: '新建分组', exact: true }).first().click()
    const dialog = page.locator('.tw-modal').first()
    await dialog.waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
    await shot('21-pool-editor.png')
    const text = await dialog.innerText()
    assert.ok(/名称/.test(text) && /说明/.test(text) && /标识颜色/.test(text), `人才库编辑对话框字段缺失：${text}`)
    await dialog.getByRole('button', { name: '取消' }).first().click()
    await page.waitForTimeout(400)
    return { fields: text.split('\n').filter(Boolean).slice(0, 3) }
  })

  await step('人才库分组：加入候选人对话框', async () => {
    await page.getByRole('button', { name: '加入候选人', exact: true }).first().click()
    const dialog = page.locator('.tw-modal').first()
    await dialog.waitFor({ state: 'visible' })
    await page.waitForTimeout(700)
    await shot('17-pool-picker.png')
    const text = await dialog.innerText()
    assert.ok(/姓名|候选人/.test(text), '选择对话框缺少候选人列表')
    await dialog.getByRole('button', { name: '取消' }).first().click()
    await page.waitForTimeout(400)
    return { lines: text.split('\n').filter(Boolean).length }
  })

  await step('职位管理：状态 tabs 与真实统计', async () => {
    await nav('职位管理')
    assert.equal(await page.locator('.tw-page-head h1').innerText(), '职位管理')
    assert.ok((await page.locator('.tw-scope').innerText()).includes('活跃职位'), '职位状态统计缺失')
    await shot('04-positions.png')
    await page.locator('.tw-scope button', { hasText: '已暂停' }).first().click()
    await page.waitForTimeout(1000)
    const cells = await page.locator('.tw-position-table tbody tr').allInnerTexts()
    assert.ok(cells.length === 0 || cells.every((cell) => cell.includes('已暂停')), '职位状态筛选结果不一致')
    return { paused_rows: cells.length, overflow: await noOverflow() }
  })

  await step('职位详情：关联候选人与操作入口', async () => {
    await page.locator('.tw-position-table .tw-cell-link').first().click()
    await page.waitForTimeout(1300)
    const text = await page.locator('main.tw-content').first().innerText()
    assert.ok(/关联候选人|职位说明/.test(text), '职位详情缺少关联候选人区域')
    assert.ok(!/当前职位候选人/.test(text), '职位详情仍出现易混淆文案')
    await shot('15-position-detail.png')
    return { overflow: await noOverflow() }
  })

  await step('职位表单：新增职位抽屉', async () => {
    await nav('职位管理')
    await page.getByRole('button', { name: '新增职位', exact: true }).first().click()
    await page.waitForTimeout(900)
    await shot('16-position-form.png')
    const form = await page.locator('.tw-drawer-layer, .tw-modal-layer').last().innerText()
    assert.ok(/职位名称/.test(form), '职位表单缺少职位名称字段')
    await dismissLayer('取消')
    return { fields: form.split('\n').filter(Boolean).slice(0, 4) }
  })

  await step('数据导入：选择文件、映射、预览与提交', async () => {
    await openImport()
    await shot('05-import-upload.png')
    const uploadText = await page.locator('section[aria-label="导入候选人"]').innerText()
    assert.ok(/选择文件|上传文件/.test(uploadText), '导入引导缺失')
    assert.ok(!/当前职位|当前公司|当前经历/.test(uploadText), '导入界面仍出现旧术语')

    const csvPath = resolve(tmpdir(), 'shicai-anonymous-import.csv')
    writeFileSync(
      csvPath,
      [
        '姓名,手机号,邮箱,当前公司,当前职位,最高学历,学校',
        '匿名QA甲,13900000001,qa.a@example.test,匿名科技甲,产品设计师,本科,匿名大学',
        '匿名QA乙,13900000002,qa.b@example.test,匿名科技乙,前端工程师,硕士,匿名大学',
        ',13900000003,qa.c@example.test,匿名科技丙,设计师,本科,匿名大学'
      ].join('\n'),
      'utf8'
    )
    await page.setInputFiles('[aria-label="导入候选人"] input[type="file"]', csvPath)
    await page.waitForTimeout(1600)
    await page.locator('.tw-import-foot .tw-btn-primary').first().click()
    await page.waitForTimeout(1800)
    await shot('18-import-mapping.png')
    const mappingText = await page.locator('section[aria-label="导入候选人"]').innerText()
    assert.ok(/最近公司|最近职位/.test(mappingText), `映射界面未使用最近术语：${mappingText.slice(0, 120)}`)
    const selects = page.locator('section[aria-label="导入候选人"] select')
    const values = await selects.evaluateAll((nodes) => nodes.map((node) => node.value))
    assert.ok(
      values.includes('current_company') && values.includes('current_title'),
      `旧表头未映射到技术字段：${values.join(',')}`
    )
    const labels = await selects.evaluateAll((nodes) => nodes.map((node) => node.selectedOptions[0]?.textContent || ''))
    assert.ok(labels.some((label) => label.includes('最近')), `映射展示名未使用最近术语：${labels.join(',')}`)

    await page.locator('.tw-import-foot .tw-btn-primary').first().click()
    await page.waitForTimeout(2200)
    await shot('19-import-preview.png')
    const previewText = await page.locator('section[aria-label="导入候选人"]').innerText()
    assert.ok(/新增|更新|问题/.test(previewText), '预览汇总缺失')
    assert.ok(/姓名为空|问题行|需处理|校验/.test(previewText), '问题行信息缺失')

    const confirm = page.locator('.tw-import-foot .tw-btn-primary').first()
    assert.ok((await confirm.innerText()).includes('确认导入'), '提交按钮文案异常')
    assert.ok(await confirm.isEnabled(), '确认导入按钮不可用')
    await confirm.click()
    await page.waitForTimeout(3200)
    const resultText = await page.locator('section[aria-label="导入候选人"]').innerText()
    assert.ok(/导入完成/.test(resultText), `导入结果缺失：${resultText.slice(0, 120)}`)
    assert.ok(/成功写入\s*\d/.test(resultText), `导入结果未给出写入条数：${resultText.slice(0, 120)}`)
    await page.locator('.tw-import-foot .tw-btn-primary').first().click()
    await page.waitForTimeout(900)
    const written = listOf(await api('/api/candidates?page_size=100')).filter((item) => item.name === '匿名QA甲')
    assert.equal(written.length, 1, `导入结果与候选人库不一致：${written.length}`)
    return {
      written: written.length,
      mapping: labels.filter((label) => label.includes('最近')),
      preview: previewText.split('\n').filter((line) => /新增|更新|问题/.test(line)).slice(0, 3),
      result: resultText.split('\n').filter(Boolean).slice(0, 5)
    }
  })

  await step('附件解析：入口与真实状态', async () => {
    await nav('附件解析')
    await shot('08-attachments.png')
    const layer = page.locator('.tw-tool-page').first()
    await layer.waitFor({ state: 'visible' })
    const text = await layer.innerText()
    assert.ok(/解析并更新候选人|附件/.test(text), `附件解析入口缺少内容：${text.slice(0, 120)}`)
    return { excerpt: text.split('\n').filter(Boolean).slice(0, 4) }
  })

  await step('候选人详情：附件区与原文', async () => {
    await nav('候选人库')
    await openCandidate(primary.name)
    await openDrawerTab('履历')
    const drawer = await page.locator('.tw-drawer').innerText()
    assert.ok(/附件|简历/.test(drawer), '履历页签缺少附件区域')
    await page.locator('.tw-drawer .tw-drawer-body').first().evaluate((element) => { element.scrollTop = element.scrollHeight })
    const attachmentPanel = page.locator('.tw-drawer .tw-att-section').first()
    await attachmentPanel.waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
    const attachmentText = await attachmentPanel.innerText()
    assert.ok(/相关附件/.test(attachmentText), '候选人附件区未渲染：' + attachmentText.slice(0, 80))
    await shot('20-attachment-review.png')
    await closeDrawer()
    return { mentions_attachment: /附件/.test(drawer), attachments: attachmentText.split('\n').filter(Boolean).slice(0, 3) }
  })

  await step('履历检索：关键词结果与旧请求状态', async () => {
    await nav('履历检索')
    const layer = page.locator('.tw-tool-page').first()
    await layer.waitFor({ state: 'visible' })
    await layer.locator('.tw-search-bar input').first().fill('产品设计师')
    await layer.locator('.tw-search-submit').first().click()
    await page.waitForTimeout(2500)
    const text = await layer.innerText()
    assert.ok(!/当前职位|当前公司|当前经历/.test(text), '检索界面仍出现旧术语')
    assert.ok(/条件|结果|匹配|未找到|暂无|候选人/.test(text), `检索界面缺少结果或空状态：${text.slice(0, 120)}`)
    await shot('07-resume-search.png')
    return { excerpt: text.split('\n').filter(Boolean).slice(0, 4) }
  })

  await step('G4 检索相关性：无关词、命中证据与补齐语义', async () => {
    await nav('履历检索')
    const layer = page.locator('.tw-tool-page').first()
    await layer.waitFor({ state: 'visible' })

    const search = async (query) => {
      const input = layer.locator('.tw-search-bar input').first()
      await input.fill(query)
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === '/api/resume-search' && response.request().method() === 'POST'
      })
      await layer.locator('.tw-search-submit').first().click()
      const response = await responsePromise
      assert.equal(response.status(), 200, `履历检索返回 HTTP ${response.status()}`)
      return response.json()
    }

    const hitPayload = await search('产品设计师')
    await layer.locator('.tw-search-table tbody tr').first().waitFor({ state: 'visible' })
    const hitItems = hitPayload.items.filter((item) => item.condition_status !== 'padding')
    const paddingItems = hitPayload.items.filter((item) => item.condition_status === 'padding')
    assert.ok(hitItems.length > 0, '关键词检索没有真实命中项')
    assert.ok(paddingItems.length > 0, '关键词检索未覆盖补齐项语义')
    assert.equal(hitPayload.pagination.total, hitItems.length, '分页总数把补齐项计入了真实命中')
    assert.ok(
      hitItems.every((item) => Array.isArray(item.evidence) && item.evidence.length > 0),
      '关键词命中项缺少证据'
    )
    assert.ok(
      paddingItems.every((item) => item.condition_status === 'padding' && item.evidence.length === 0),
      '补齐项被标成真实命中或携带了命中证据'
    )

    for (const item of hitItems) {
      const row = layer.locator('.tw-search-table tbody tr').filter({ hasText: item.name }).first()
      assert.ok(await row.locator('.tw-evidence-card').count() > 0, `命中项 ${item.name} 未渲染证据卡`)
    }
    for (const item of paddingItems) {
      const row = layer.locator('.tw-search-table tbody tr').filter({ hasText: item.name }).first()
      const tags = await row.locator('.tw-tag').allInnerTexts()
      assert.ok(tags.includes('仅补足分页'), `补齐项 ${item.name} 未标注补齐语义`)
      assert.ok(!tags.includes('部分匹配'), `补齐项 ${item.name} 被错误标成部分匹配`)
    }

    const emptyPayload = await search('zzzz不存在的关键词qqq')
    assert.equal(emptyPayload.pagination.total, 0, '无关词返回了非零真实总数')
    assert.equal(emptyPayload.items.length, 0, '无关词返回了候选人')
    assert.equal(emptyPayload.pagination.has_more, false, '无关词仍声称有下一页')
    await layer.getByText('未找到符合已执行条件的候选人', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await layer.locator('.tw-search-table tbody tr').count(), 0, '无关词仍在界面保留结果行')

    return {
      hitItems: hitItems.length,
      paddingItems: paddingItems.length,
      realTotal: hitPayload.pagination.total,
      unrelatedTotal: emptyPayload.pagination.total
    }
  })

  await step('AI 助手：未配置状态不伪造答案', async () => {
    await nav('AI 助手')
    await page.waitForTimeout(1300)
    const layer = page.locator('.tw-tool-page').first()
    await layer.waitFor({ state: 'visible' })
    const text = await layer.innerText()
    assert.ok(!/当前职位|当前公司|当前经历/.test(text), '助手界面仍出现旧术语')
    assert.ok(/未配置|尚未|等待连接|本地/.test(text), `助手未配置状态缺失：${text.slice(0, 120)}`)
    assert.ok(!/检索结果|已为你|匹配到/.test(text), '未配置状态疑似伪造成功答案')
    await shot('06-assistant.png')
    return { excerpt: text.split('\n').filter(Boolean).slice(0, 3) }
  })

  await step('人才库分组：新建、加入、移出、编辑、归档与恢复', async () => {
    await resetPage()
    await nav('人才库分组')
    const poolName = '匿名QA验收组'
    await page.getByRole('button', { name: '新建分组', exact: true }).first().click()
    const editor = page.locator('.tw-modal').first()
    await editor.waitFor({ state: 'visible' })
    await editor.locator('input').first().fill(poolName)
    await editor.locator('textarea').first().fill('匿名验收用途，可安全归档')
    await editor.getByRole('button', { name: '保存' }).click()
    await page.waitForTimeout(1400)
    const created = listOf(await api('/api/talent-pools?page_size=100')).find((pool) => pool.name === poolName)
    assert.ok(created, '新建人才库未保存到服务端')

    const members = listOf(await api('/api/candidates?page_size=100')).slice(0, 2)
    const linkedMembers = await api(`/api/talent-pools/${created.id}/candidates`, 'POST', { candidate_ids: members.map((item) => item.id) })
    assert.equal(linkedMembers.linked_count, 2, `匿名预置成员关系失败：${JSON.stringify(linkedMembers)}`)
    await resetPage()
    await nav('人才库分组')
    const poolItem = page.locator('.tw-subnav-list button').filter({ hasText: poolName }).first()
    await poolItem.waitFor({ state: 'visible' })
    await poolItem.click()
    await page.waitForTimeout(1400)
    const joined = await page.locator('.tw-pane-head').first().innerText()
    assert.ok(/2\s*位(候选人|成员)/.test(joined), `加入后成员数不一致：${joined}`)

    await rows(page).first().click()
    await page.locator('.tw-drawer').waitFor({ state: 'visible' })
    await closeDrawer()

    const removed = members[0]
    await rows(page).filter({ hasText: removed.name }).first().locator('input[type="checkbox"]').check()
    await page.locator('.tw-bulk').getByRole('button', { name: '移出当前人才库' }).click()
    await page.waitForTimeout(1800)
    const afterUnlink = await page.locator('.tw-pane-head').first().innerText()
    assert.ok(/1\s*位(候选人|成员)/.test(afterUnlink), `移出后成员数不一致：${afterUnlink}`)
    const afterMembers = listOf(await api(`/api/talent-pools/${created.id}/candidates?page_size=50`))
    assert.equal(afterMembers.length, 1, '服务端成员数未同步')
    const serverCandidate = await api(`/api/candidates/${removed.id}`)
    assert.equal(serverCandidate.id, removed.id, '移出分组不应删除候选人档案')

    await page.getByRole('button', { name: '编辑分组', exact: true }).first().click()
    const editBox = page.locator('.tw-modal').first()
    await editBox.waitFor({ state: 'visible' })
    const renamed = `${poolName}（已编辑）`
    await editBox.locator('input').first().fill(renamed)
    await editBox.getByRole('button', { name: '保存' }).click()
    await page.waitForTimeout(1400)
    const edited = listOf(await api('/api/talent-pools?page_size=100')).find((pool) => pool.name === renamed)
    assert.ok(edited, '编辑人才库未生效')

    await page.getByRole('button', { name: '归档分组', exact: true }).first().click()
    const confirm = page.locator('.tw-modal-layer [role="alertdialog"]').first()
    await confirm.waitFor({ state: 'visible' })
    await confirm.getByRole('button', { name: '确认归档' }).click()
    await page.waitForTimeout(1600)
    const archived = await api(`/api/talent-pools/${created.id}`)
    assert.ok(archived.archived_at, '归档人才库未生效')
    await page.locator('.tw-subnav-tabs button').filter({ hasText: '已归档' }).first().click()
    await page.waitForTimeout(1400)
    const archivedItem = page.locator('.tw-subnav-list button').filter({ hasText: renamed }).first()
    await archivedItem.waitFor({ state: 'visible' })
    await archivedItem.click()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: '恢复人才库', exact: true }).first().click()
    await page.waitForTimeout(1600)
    const restored = await api(`/api/talent-pools/${created.id}`)
    assert.ok(!restored.archived_at, '恢复人才库未生效')
    return { pool: renamed, members_before: 2, members_after: 1 }
  })

  await step('职位：关联候选人、解除关联与档案保留', async () => {
    const position = await api('/api/positions', 'POST', {
      title: '匿名QA关联职位',
      department: '匿名部门',
      location: '上海',
      headcount: 1
    })
    await resetPage()
    await nav('职位管理')
    const createdRow = page.locator('.tw-position-table tbody tr').filter({ hasText: '匿名QA关联职位' }).first()
    await createdRow.waitFor({ state: 'visible' })
    await createdRow.locator('.tw-cell-link').first().click()
    await page.getByRole('button', { name: '添加已有候选人', exact: true }).first().waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '添加已有候选人', exact: true }).first().click()
    const picker = page.locator('.tw-modal').first()
    await picker.waitFor({ state: 'visible' })
    const boxes = picker.locator('tbody input[type="checkbox"]')
    await boxes.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    const total = await boxes.count()
    let picked = 0
    for (let index = 0; index < total && picked === 0; index += 1) {
      const box = boxes.nth(index)
      if (await box.isDisabled()) continue
      await box.check()
      picked += 1
    }
    assert.equal(picked, 1, '选择对话框没有可勾选的候选人')
    const confirmButton = picker.locator('.tw-modal-foot .tw-btn-primary').first()
    const confirmText = await confirmButton.innerText()
    const expectedCount = Number((confirmText.match(/(\d+)/) ?? [])[1] ?? 1)
    await confirmButton.click()
    await page.waitForTimeout(1600)
    const linked = listOf(await api(`/api/positions/${position.id}/candidates?page_size=50`))
    assert.equal(linked.length, expectedCount, `关联结果与确认数量不一致：${linked.length} vs ${expectedCount}`)
    const linkedCandidate = linked[0]

    await page.getByRole('button', { name: `解除关联：${linkedCandidate.name}` }).first().click()
    await page.waitForTimeout(1600)
    const unlinked = listOf(await api(`/api/positions/${position.id}/candidates?page_size=50`))
    assert.equal(unlinked.length, 0, '解除关联后仍存在关系')
    const survivor = await api(`/api/candidates/${linkedCandidate.id}`)
    assert.equal(survivor.id, linkedCandidate.id, '解除关联不应删除候选人')
    await shot('15-position-detail.png')
    return { position: position.title, linked: linkedCandidate.name }
  })

  await step('数据导入：重复候选人更新提示', async () => {
    await resetPage()
    await openImport()
    const csvPath = resolve(tmpdir(), 'shicai-anonymous-import-duplicate.csv')
    writeFileSync(
      csvPath,
      ['姓名,手机号,邮箱,当前公司,当前职位,最高学历,学校', '匿名QA甲,13900000001,qa.a@example.test,匿名科技甲,产品设计师,本科,匿名大学'].join('\n'),
      'utf8'
    )
    await page.setInputFiles('[aria-label="导入候选人"] input[type="file"]', csvPath)
    await page.waitForTimeout(1600)
    await page.locator('.tw-import-foot .tw-btn-primary').first().click()
    await page.waitForTimeout(1800)
    await page.locator('.tw-import-foot .tw-btn-primary').first().click()
    await page.waitForTimeout(1200)
    const existing = listOf(await api('/api/candidates?page_size=100')).filter((item) => item.name === '匿名QA甲')
    try {
      assert.equal(existing.length, 1, `候选人库中的匿名QA甲数量异常：${existing.length}`)
      const duplicateCard = page.locator('.tw-import-stats div').filter({ hasText: '重复记录将跳过' }).first()
      let duplicateCardText = ''
      for (let attempt = 0; attempt < 25; attempt += 1) {
        duplicateCardText = await duplicateCard.innerText().catch(() => '')
        if (/(^|\D)1(\D|$)/.test(duplicateCardText)) break
        await page.waitForTimeout(400)
      }
      assert.ok(/(^|\D)1(\D|$)/.test(duplicateCardText), `重复记录统计异常：${duplicateCardText} :: ${JSON.stringify(importTaskSnapshots.slice(-1))}`)
      const duplicateTab = await page.locator('.tw-import-tabs button').filter({ hasText: '重复跳过' }).first().innerText()
      assert.ok(/(^|\D)1(\D|$)/.test(duplicateTab), `重复页签计数异常：${duplicateTab}`)
      const duplicateRow = await page.locator('.tw-import-table tbody tr').filter({ hasText: '匿名QA甲' }).first().innerText()
      assert.ok(/重复跳过/.test(duplicateRow), `重复行状态异常：${duplicateRow}`)
      return { duplicate_card: duplicateCardText.replace(/\n/g, ' '), duplicate_row: duplicateRow.split('\n').filter(Boolean).slice(0, 3) }
    } finally {
      await page.getByRole('button', { name: '返回人才库', exact: true }).first().click().catch(() => {})
      await page.waitForTimeout(600)
    }
  })

  await step('术语检查：候选人语境无旧术语', async () => {
    await resetPage()
    await nav('候选人库')
    const listText = await page.locator('.tw-page[aria-label="候选人库"]').innerText()
    assert.ok(!/当前职位|当前公司|当前经历/.test(listText), '候选人列表仍出现旧术语')
    const navText = await page.locator('.tw-sidebar').innerText()
    assert.ok(!/当前职位|当前公司|当前经历/.test(navText), '导航出现旧术语')
    return { checked: ['候选人列表', '导航'] }
  })

  await step('响应式：全部入口与五个详情页签在 1440 / 1280 / 768 / 390 无横溢出', async () => {
    const entries = ['工作台', '候选人库', '人才库分组', '职位管理', '导入候选人', 'AI 助手', '履历检索', '附件解析']
    const drawerTabs = ['档案', '履历', '历史评估', '备注与动态', '高级信息']
    const results = []
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 }
    ]) {
      await page.setViewportSize(viewport)
      const states = []
      for (const entry of entries) {
        await nav(entry)
        await page.waitForTimeout(450)
        const metrics = await noOverflow()
        states.push({ state: entry, doc: metrics.doc, win: metrics.win })
        if (entry === '候选人库') {
          const navBox = await page.locator('.tw-sidebar').boundingBox()
          const headingBox = await page.locator('.tw-page-head').boundingBox().catch(() => null)
          assert.ok(!navBox || navBox.width <= 320, `${viewport.width} 侧栏宽度异常：${navBox && navBox.width}`)
          // 宽屏：主侧栏是 flex 兄弟节点，内容必须落在侧栏右侧；窄屏：侧栏是离屏抽屉，不得压在内容上。
          if (navBox && headingBox) {
            const navRight = navBox.x + navBox.width
            const offCanvas = navRight <= 1
            const sideBySide = headingBox.x >= navRight - 1
            assert.ok(
              offCanvas || sideBySide,
              `${viewport.width} 导航与内容重叠：nav 右边界 ${Math.round(navRight)}，标题 x ${Math.round(headingBox.x)}`
            )
          }
        }
      }
      await nav('候选人库')
      await openCandidate(primary.name)
      for (const tab of drawerTabs) {
        await openDrawerTab(tab)
        const drawerMetrics = await noOverflow()
        states.push({ state: `详情·${tab}`, doc: drawerMetrics.doc, win: drawerMetrics.win })
      }
      await closeDrawer()
      if (viewport.width === 1440) await shot('viewport-1440-candidates.png')
      if (viewport.width === 768) await shot('viewport-768-candidates.png')
      if (viewport.width === 390) await shot('viewport-390-candidates.png')
      results.push({ viewport, doc: viewport.width, states })
    }
    report.viewports = results
    return results.map((item) => `${item.viewport.width}:${item.states.length} 个状态`
    )
  })

  await step('弹层：导出菜单、更多筛选、选择器与职位菜单可关闭', async () => {
    await page.setViewportSize({ width: 1536, height: 1024 })
    await resetPage()
    await nav('候选人库')

    const exportMenu = page.locator('.tw-menu[aria-label="导出候选人"]')
    const openExport = async () => {
      await page.getByRole('button', { name: '导出' }).first().click()
      await exportMenu.waitFor({ state: 'visible' })
    }
    await openExport()
    await page.keyboard.press('Escape')
    await exportMenu.waitFor({ state: 'detached' })
    await openExport()
    await page.locator('.tw-page-head h1').first().click()
    await exportMenu.waitFor({ state: 'detached' })

    const advancedPanel = page.locator('.tw-panel').first()
    await page.getByRole('button', { name: '更多筛选' }).first().click()
    await advancedPanel.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await advancedPanel.waitFor({ state: 'detached' })

    await nav('人才库分组')
    await page.waitForTimeout(500)
    const picker = page.locator('.tw-modal').first()
    await page.getByRole('button', { name: '加入候选人', exact: true }).first().click()
    await picker.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    await nav('职位管理')
    const rowMenu = page.locator('.tw-position-table tbody tr').first().locator('.tw-menu')
    await page.locator('.tw-position-table tbody tr').first().getByRole('button', { name: '更多' }).click()
    await rowMenu.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await rowMenu.waitFor({ state: 'detached' })

    return { export: 'esc + 点击外部', advanced: 'esc', picker: 'esc', rowMenu: 'esc' }
  })

  await browser.close()
} finally {
  if (server && !server.killed) server.kill()
}

report.console_errors = consoleErrors
writeFileSync(resolve(evidenceDir, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n')

const passed = report.cases.filter((item) => item.ok).length
console.log(`\n通过 ${passed}/${report.cases.length} 项；控制台错误 ${consoleErrors.length} 条`)
if (failures.length) console.log('失败明细：\n- ' + failures.join('\n- '))
assert.equal(consoleErrors.length, 0, `控制台出现错误：${consoleErrors.slice(0, 3).join(' | ')}`)
assert.equal(failures.length, 0, `存在未通过的验收项：${failures.join(' | ')}`)
console.log('匿名库浏览器验收通过')
