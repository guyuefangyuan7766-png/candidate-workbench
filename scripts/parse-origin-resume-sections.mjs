#!/usr/bin/env node
// 阶段 3：用模型解析原始简历，补齐结构化履历里空缺的区块。
//
//   node scripts/parse-origin-resume-sections.mjs --limit 100                    # 试跑，只读
//   node scripts/parse-origin-resume-sections.mjs --limit 100 --apply            # 试跑并写库
//   node scripts/parse-origin-resume-sections.mjs --apply --offset 100 --limit 100
//
// 只补空缺：某位候选人在某个 section_type 已经有区块时，该类型整体跳过，
// 不覆盖北森已经解析出来的内容。
//
// 数据边界：正文（纯文本）会发送到 AGENT_BASE_URL 指向的模型网关；本地不
// 留请求副本，只落解析结果。字段口径来自 C 盘旧项目实测的区块字段名。
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PARSER_VERSION = 'origin-section-parse-v1'
const SOURCE_LABEL = '原始简历解析'

// 每个区块的规范字段与顺序沿用 C 盘旧项目实测口径，前端按同样顺序渲染。
// extra 段是「规范字段之外的字段」：解析时保留，并在报告里列出待并入规范。
const SECTION_SCHEMAS = Object.freeze({
  internship: {
    title: '实习经历',
    headingFields: ['单位名称', '职位名称'],
    time: ['开始时间', '结束时间'],
    fields: ['单位名称', '职位名称', '开始时间', '结束时间', '实习地点', '实习内容', '实习成果', '单位介绍', '证明人', '证明人职务', '证明人关系', '证明人联系方式']
  },
  campus: {
    title: '校园经历',
    headingFields: ['职务名称', '实践名称', '活动名称'],
    time: ['开始时间', '结束时间'],
    fields: ['职务名称', '实践名称', '活动名称', '开始时间', '结束时间', '职务描述', '实践描述', '活动描述', '项目成果', '团队规模']
  },
  skill: {
    title: '技能',
    headingFields: ['技能名称'],
    time: [],
    fields: ['技能名称', '掌握程度', '技能描述', '使用时间总计']
  },
  language: {
    title: '语言能力',
    headingFields: ['语言类型'],
    time: [],
    fields: ['语言类型', '掌握程度', '听说', '读写']
  },
  certificate: {
    title: '证书',
    headingFields: ['证书名称'],
    time: ['获得时间'],
    fields: ['证书名称', '颁发机构', '获得时间', '成绩', '证书编号', '证书种类', '有效日期至', '证书描述']
  },
  training: {
    title: '培训经历',
    headingFields: ['培训机构', '课程名称'],
    time: ['开始时间', '结束时间'],
    fields: ['培训机构', '课程名称', '开始时间', '结束时间', '培训地点', '培训课时数总计', '培训描述', '获得证书']
  },
  award: {
    title: '奖励与荣誉',
    headingFields: ['奖项名称'],
    time: ['获得时间'],
    fields: ['奖项名称', '级别', '获得时间', '颁发机构', '奖项描述']
  },
  publication: {
    title: '论文与作品',
    headingFields: ['名称'],
    time: ['发表时间'],
    fields: ['名称', '类型', '发表时间', '发表载体', '作者排序', '描述']
  },
  management: {
    title: '管理经历',
    headingFields: ['组织', '职务'],
    time: ['开始时间', '结束时间'],
    fields: ['组织', '职务', '开始时间', '结束时间', '团队规模', '管理内容', '管理成果']
  },
  other: {
    title: '附加信息',
    headingFields: [],
    time: [],
    fields: [
      '特殊技能', '特长', '社会活动', '宗教信仰', '推荐信', '专利成果', '专业组织',
      '学术专著', '兴趣爱好', '荣誉', '标题', '获得荣誉', '内容', '其他'
    ]
  }
})

// 同义字段合并表（按区块作用域）：同一个词在不同区块含义不同，例如「机构」
// 在实习里是单位、在证书里是颁发机构，因此别名必须按 section_type 限定。
const FIELD_ALIASES = Object.freeze({
  internship: {
    实习公司: '单位名称', 公司: '单位名称', 公司名称: '单位名称', 单位: '单位名称', 机构: '单位名称',
    机构名称: '单位名称', 单位全称: '单位名称', 实习单位: '单位名称', 公司全称: '单位名称', 组织: '单位名称',
    职位: '职位名称', 岗位: '职位名称', 职务: '职位名称', 角色: '职位名称', 实习岗位: '职位名称',
    实习职位: '职位名称', 岗位名称: '职位名称', 担任职位: '职位名称',
    时间: '开始时间', 起始时间: '开始时间', 开始日期: '开始时间', 入职时间: '开始时间', 起止时间: '开始时间', 时间范围: '开始时间',
    结束日期: '结束时间', 离职时间: '结束时间',
    工作内容: '实习内容', 主要职责: '实习内容', 职责: '实习内容', 内容: '实习内容', 描述: '实习内容',
    实习职责: '实习内容', 经历描述: '实习内容', 主要工作: '实习内容', 工作描述: '实习内容', 实习内容描述: '实习内容',
    工作成果: '实习成果', 成果: '实习成果', 主要成果: '实习成果'
  },
  campus: {
    组织名称: '职务名称', 社团名称: '职务名称', 学生会职务: '职务名称', 担任职务: '职务名称',
    职位: '职务名称', 岗位: '职务名称', 角色: '职务名称',
    校园描述: '职务描述', 职务职责: '职务描述', 职责描述: '职务描述', 工作内容: '职务描述', 主要职责: '职务描述',
    活动: '活动名称', 项目名称: '实践名称', 实践项目: '实践名称', 实践组织: '实践名称',
    项目描述: '实践描述', 活动内容: '活动描述', 活动成果: '项目成果',
    团队人数: '团队规模', 团队大小: '团队规模',
    时间: '开始时间', 起始时间: '开始时间', 结束日期: '结束时间'
  },
  skill: {
    技能: '技能名称', 熟练程度: '掌握程度', 水平: '掌握程度', 掌握: '掌握程度',
    使用时间: '使用时间总计', 使用时长: '使用时间总计', 技能说明: '技能描述', 说明: '技能描述'
  },
  language: {
    语言: '语言类型', 语言名称: '语言类型', 语种: '语言类型',
    等级: '掌握程度', 证书等级: '掌握程度', 水平: '掌握程度'
  },
  certificate: {
    证书: '证书名称', 证书名: '证书名称', 名称: '证书名称',
    分数: '成绩', 成绩分数: '成绩', 分数段: '成绩',
    机构: '颁发机构', 发证机构: '颁发机构', 颁发单位: '颁发机构',
    编号: '证书编号', 有效期: '有效日期至', 有效期至: '有效日期至',
    证书说明: '证书描述', 类别: '证书种类',
    获得日期: '获得时间', 获得年月: '获得时间', 颁发时间: '获得时间', 取得时间: '获得时间'
  },
  training: {
    培训单位: '培训机构', 机构: '培训机构', 课程: '课程名称', 课程名: '课程名称',
    课时: '培训课时数总计', 培训内容: '培训描述', 课程描述: '培训描述',
    证书: '获得证书', 获得证书名称: '获得证书', 地点: '培训地点',
    时间: '开始时间', 起始时间: '开始时间', 结束日期: '结束时间'
  },
  award: {
    奖项: '奖项名称', 获奖名称: '奖项名称', 奖励名称: '奖项名称', 名称: '奖项名称',
    等级: '级别', 获奖级别: '级别', 颁奖机构: '颁发机构', 机构: '颁发机构',
    获奖时间: '获得时间', 获得日期: '获得时间', 描述: '奖项描述'
  },
  publication: {
    论文名称: '名称', 作品名称: '名称', 成果名称: '名称', 题目: '名称',
    类型: '类型', 载体: '发表载体', 期刊: '发表载体', 刊物: '发表载体',
    排序: '作者排序', 作者名次: '作者排序', 时间: '发表时间', 描述: '描述'
  },
  management: {
    组织名称: '组织', 单位: '组织', 团队: '组织', 职务: '职务', 职位: '职务',
    时间: '开始时间', 起始时间: '开始时间', 结束日期: '结束时间',
    团队人数: '团队规模', 团队大小: '团队规模', 管理职责: '管理内容', 职责: '管理内容'
  },
  other: {}
})

function parseArgs(argv) {
  const options = {
    dbPath: process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(ROOT, 'data', 'recruitment.db'),
    limit: 100,
    offset: 0,
    apply: false,
    batchSize: 5,
    concurrency: 4,
    seed: 'phase3-pilot',
    candidateIds: null,
    verbose: false,
    reportPath: resolve(ROOT, 'data', 'origin-section-parse-report.json')
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`缺少参数值：${arg}`); return argv[index] }
    if (arg === '--apply') options.apply = true
    else if (arg === '--limit') options.limit = Number.parseInt(next(), 10)
    else if (arg === '--offset') options.offset = Number.parseInt(next(), 10)
    else if (arg === '--batch-size') options.batchSize = Number.parseInt(next(), 10)
    else if (arg === '--concurrency') options.concurrency = Number.parseInt(next(), 10)
    else if (arg === '--seed') options.seed = next()
    else if (arg === '--candidate-ids') options.candidateIds = next().split(',').map((value) => value.trim()).filter(Boolean)
    else if (arg === '--report') options.reportPath = resolve(next())
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 14).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10) throw new Error('--batch-size 必须在 1..10 之间')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('--concurrency 必须在 1..8 之间')
  return options
}

function readEnvironmentVariable(name) {
  const script = `$v = [Environment]::GetEnvironmentVariable('${name}','User'); if (-not $v) { $v = [Environment]::GetEnvironmentVariable('${name}','Machine') }; if ($v) { $v }`
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const options = parseArgs(process.argv.slice(2))
const startedAt = Date.now()

const baseUrl = (process.env.AGENT_BASE_URL || readEnvironmentVariable('AGENT_BASE_URL')).replace(/\/$/, '')
const apiKey = process.env.AGENT_API_KEY || readEnvironmentVariable('AGENT_API_KEY')
const model = process.env.AGENT_RESUME_MODEL || process.env.AGENT_MODEL || readEnvironmentVariable('AGENT_RESUME_MODEL') || readEnvironmentVariable('AGENT_MODEL') || 'deepseek/deepseek-flash'
if (!baseUrl || !apiKey) throw new Error('缺少 AGENT_BASE_URL / AGENT_API_KEY，无法调用解析模型')

const db = new DatabaseSync(options.dbPath)
db.exec('PRAGMA busy_timeout = 15000')

const ORIGIN_TEXT_TYPES = new Set(['text/html', 'text/plain', 'application/pdf'])

// 默认只处理「还没有本解析器产物」的候选人，保证幂等、可断点续跑。
// --candidate-ids 用于定向补跑（例如上一轮网络失败的批次）。
const parserFilter = `AND NOT EXISTS (
       SELECT 1 FROM candidate_profile_sections parsed
       WHERE parsed.candidate_id = a.candidate_id
         AND parsed.archived_at IS NULL
         AND json_extract(parsed.structured_data, '$.parser') = 'origin-section-parse-v1'
     )`
const candidateFilter = options.candidateIds?.length
  ? `AND a.candidate_id IN (${options.candidateIds.map(() => '?').join(',')})`
  : ''
const queryParams = options.candidateIds?.length ? [...options.candidateIds] : []

// 分波取数：以 candidate_attachments 主键（a.id）做游标顺序扫描。
// 不要加 ORDER BY / OFFSET：实测在 13 GB 主库上会让 SQLite 整体物化候选集，
// 8 分钟涨到 2.9 GB 并最终以 0xC0000005（访问违例）崩溃。
const candidateQuery = db.prepare(`
  SELECT a.id AS attachment_id, a.candidate_id, a.storage_path, a.mime_type, a.file_size, c.name
  FROM candidate_attachments a
  JOIN candidates c ON c.id = a.candidate_id
  WHERE a.attachment_type = 'resume_origin'
    AND a.mime_type IN ('text/html','text/plain','application/pdf')
    AND COALESCE(c.archived_at, '') = ''
    AND NOT EXISTS (
      SELECT 1 FROM candidate_profile_sections existing
      WHERE existing.candidate_id = a.candidate_id
        AND existing.section_type IN ('internship','campus','skill','language','certificate','training','award','publication','management')
        AND existing.archived_at IS NULL
    )
    ${parserFilter}
    ${candidateFilter}
    AND a.id > ?
  LIMIT ?
`)
const waveSize = Math.max(options.batchSize, Number.parseInt(process.env.PHASE3_WAVE ?? '500', 10) || 500)
// 正文提取是 CPU 密集（PDF 解析）且每份独立子进程；批量上限之外的并发还要
// 与模型调用重叠，所以这里用适中并发 + 分块流水线（见 runWave）。
const extractConcurrency = Math.max(1, Math.min(6, Number.parseInt(process.env.PHASE3_EXTRACT_CONCURRENCY ?? '4', 10) || 4))
// 波内分块大小：小块先完成提取就先发模型，避免「全部提取完再统一调用」的空等。
const chunkSize = Math.max(options.batchSize, Number.parseInt(process.env.PHASE3_CHUNK ?? '50', 10) || 50)

const eligibleTotal = db.prepare(`
  SELECT COUNT(*) AS n
  FROM candidate_attachments a
  JOIN candidates c ON c.id = a.candidate_id
  WHERE a.attachment_type = 'resume_origin'
    AND a.mime_type IN ('text/html','text/plain','application/pdf')
    AND COALESCE(c.archived_at, '') = ''
    AND NOT EXISTS (
      SELECT 1 FROM candidate_profile_sections existing
      WHERE existing.candidate_id = a.candidate_id
        AND existing.section_type IN ('internship','campus','skill','language','certificate','training','award','publication','management')
        AND existing.archived_at IS NULL
    )
`).get().n

// 逐份隔离提取：PDF 解析在原生层，畸形文件会让进程直接退出（0xC0000005），
// 因此每份正文都交给独立子进程，崩溃/超时只影响这一份。
function extractTextInChild(storagePath, mimeType, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/extract-origin-text.mjs', storagePath, mimeType], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, error: 'extract_timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: String(error?.message ?? error).slice(0, 120) })
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) return resolve({ ok: false, error: `extract_exit_${code}` })
      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed)
      } catch {
        resolve({ ok: false, error: `extract_bad_output:${stderr.slice(0, 80)}` })
      }
    })
  })
}

async function extractText(row) {
  const result = await extractTextInChild(row.storage_path, row.mime_type)
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error })
  return { text: result.text ?? '', method: result.method ?? 'unknown' }
}

// 受控并发提取：保持结果顺序与入参一致，便于与批次对齐。
async function extractTextsInOrder(rows, concurrency) {
  const results = new Array(rows.length)
  let cursor = 0
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor
      cursor += 1
      const row = rows[index]
      try {
        const { text, method } = await extractText(row)
        results[index] = { ok: true, row, text, method }
      } catch (error) {
        results[index] = { ok: false, row, error: String(error?.message ?? error).slice(0, 120) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()))
  return results
}

function buildSchemaPrompt() {
  const lines = []
  for (const [type, schema] of Object.entries(SECTION_SCHEMAS)) {
    lines.push(`- ${type}（${schema.title}）：条目字段固定为 ${schema.fields.join('、')}，没有的字段直接省略`)
  }
  return lines.join('\n')
}

function buildRequestBody(texts) {
  const payload = texts.map((entry, index) => `【简历 ${index + 1}｜candidate_id=${entry.candidateId}】\n${entry.text.slice(0, 12000)}`).join('\n\n')
  const system = [
    '你是简历结构化助手。输入是多份候选人简历的纯文本，按简历逐份抽取“实习经历、校园经历、技能、语言能力、证书、培训经历、奖励与荣誉、论文与作品、管理经历、附加信息”这些区块。',
    '严格规则：',
    '1. 只输出 JSON，不要解释。顶层形如 {"resumes":[{"candidate_id":"...","sections":[{"section_type":"...","entries":[{"fields":{...}}],"evidence":"..."}]}]}。',
    '2. 字段名必须使用下面给定的中文名，不要自造同义词；原文没有的字段直接省略，不要编造。',
    '3. 每条 evidence 必须是该区块在原文里连续出现的一段文字，不能改写。',
    '4. 同一区块有多段经历时，entries 里放多条；一条经历里没有的字段不要填“-”。',
    '5. 只抽取列出的区块类型，不要输出教育经历、工作经历、项目经历。',
    '6. 简历里出现的每个字段都要有落点：能对上规范字段的用规范字段名；',
    '   确实不对应任何规范字段的，保留简历里的原字段名放进该区块的 fields，不要丢。',
    '7. 简历标题很短（例如只有“语言能力：普通话”）时也要抽取，不要因为内容少而跳过。',
    '',
    buildSchemaPrompt()
  ].join('\n')
  const user = `请解析以下简历：\n\n${payload}`
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }
}

async function callGateway(texts) {
  const body = JSON.stringify(buildRequestBody(texts))
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(300000)
      })
      const raw = await response.text()
      if (!response.ok) {
        // 5xx / 429 属于可重试；4xx 直接抛出，避免无意义重试。
        if (response.status >= 500 || response.status === 429) throw new Error(`gateway_${response.status}: ${raw.slice(0, 200)}`)
        throw Object.assign(new Error(`gateway_${response.status}: ${raw.slice(0, 200)}`), { fatal: true })
      }
      let parsed
      try { parsed = JSON.parse(raw) } catch { throw new Error('gateway_invalid_json') }
      const content = parsed?.choices?.[0]?.message?.content
      if (!content) throw new Error('gateway_empty_content')
      let json
      try { json = JSON.parse(content) } catch { throw new Error('model_invalid_json') }
      return { json, usage: parsed?.usage ?? null, attempts: attempt }
    } catch (error) {
      lastError = error
      if (error?.fatal || attempt === 3) break
      const delayMs = 2000 * attempt + Math.floor(Math.random() * 1000)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError ?? new Error('gateway_unavailable')
}

function normalizeFieldName(type, rawName) {
  const schema = SECTION_SCHEMAS[type]
  if (!schema) return null
  const name = String(rawName ?? '').trim()
  if (!name) return null
  if (schema.fields.includes(name)) return name
  const alias = FIELD_ALIASES[type]?.[name]
  if (alias && schema.fields.includes(alias)) return alias
  return null
}

function normalizeEntry(type, entry) {
  const schema = SECTION_SCHEMAS[type]
  const fields = {}
  const extra = {}
  // 「附加信息」是兜底区块：简历里出现的字段名原样保留并展示；
  // 其余区块只接受规范字段与同义合并结果，避免把正文句子写进结构化数据。
  const keepUnknownLabels = type === 'other'
  for (const [rawName, rawValue] of Object.entries(entry?.fields ?? {})) {
    const name = normalizeFieldName(type, rawName)
    const cleanName = String(rawName ?? '').trim()
    const value = String(rawValue ?? '').trim().replace(/\s+\n/g, '\n')
    if (!value || value === '-' || value === '无') continue
    if (name) {
      // 同义字段合并：别名与规范名落到同一个 key，先到先得，避免重复堆叠。
      if (!fields[name]) fields[name] = value.slice(0, 2000)
      continue
    }
    // 规范字段之外的字段保留下来，前端按原名展示，报告里列出待并入规范。
    if (cleanName && keepUnknownLabels && !extra[cleanName]) extra[cleanName] = value.slice(0, 2000)
  }
  if (!Object.keys(fields).length && !Object.keys(extra).length) return null
  const ordered = {}
  for (const name of schema.fields) if (fields[name]) ordered[name] = fields[name]
  return { fields: ordered, extra }
}

// 经验类区块的合并键：同一「单位 + 开始时间」只保留一条，避免同一段经历
// 同时出现在管理经历/校园经历里。技能、语言这类清单型区块不参与合并。
const MERGE_KEY_FIELDS = Object.freeze({
  internship: ['单位名称', '开始时间'],
  campus: ['职务名称', '实践名称', '活动名称', '开始时间'],
  management: ['组织', '开始时间']
})

function mergeKeyFor(type, fields) {
  const names = MERGE_KEY_FIELDS[type]
  if (!names) return null
  const parts = names.map((name) => String(fields[name] ?? '').trim().replace(/\s+/g, '').toLowerCase()).filter(Boolean)
  if (parts.length < 2) return null
  return `${type}\u0000${parts.join('\u0000')}`
}

// 与已接受的条目比较：同区块、同主键（单位）、时间区间有重叠即视为同一条。
function sameExperience(left, right) {
  const leftPrimary = String(left['单位名称'] ?? left['实践名称'] ?? left['职务名称'] ?? left['组织'] ?? '').trim().replace(/\s+/g, '')
  const rightPrimary = String(right['单位名称'] ?? right['实践名称'] ?? right['职务名称'] ?? right['组织'] ?? '').trim().replace(/\s+/g, '')
  if (!leftPrimary || !rightPrimary) return false
  if (!leftPrimary.includes(rightPrimary) && !rightPrimary.includes(leftPrimary)) return false
  const leftStart = String(left['开始时间'] ?? '').trim()
  const rightStart = String(right['开始时间'] ?? '').trim()
  if (!leftStart || !rightStart) return true
  const leftYear = leftStart.match(/(19|20)\d{2}/)?.[0] ?? ''
  const rightYear = rightStart.match(/(19|20)\d{2}/)?.[0] ?? ''
  return !leftYear || !rightYear || leftYear === rightYear
}

function dedupeEntries(type, entries) {
  const seenKeys = new Set()
  const seenEntries = []
  const kept = []
  let removed = 0
  for (const entry of entries) {
    const key = mergeKeyFor(type, entry.fields)
    if (key && seenKeys.has(key)) { removed += 1; continue }
    if (seenEntries.some((existing) => sameExperience(existing, entry.fields))) { removed += 1; continue }
    if (key) seenKeys.add(key)
    seenEntries.push(entry.fields)
    kept.push(entry)
  }
  return { kept, removed }
}

function normalizedEvidenceContext(text) {
  const normalizedText = String(text).replace(/\s+/g, '')
  const sourceBigrams = new Set()
  for (let index = 0; index + 1 < normalizedText.length; index += 1) {
    sourceBigrams.add(normalizedText.slice(index, index + 2))
  }
  return { normalizedText, sourceBigrams }
}

function evidenceLocatable(evidence, context) {
  const normalizedEvidence = String(evidence ?? '').replace(/\s+/g, '')
  if (normalizedEvidence.length < 8) return false
  const { normalizedText, sourceBigrams } = context
  if (normalizedText.includes(normalizedEvidence)) return true
  // 允许模型轻微改写：取前 60 字符做定位。
  const probe = normalizedEvidence.slice(0, Math.min(60, normalizedEvidence.length))
  if (probe.length >= 8 && normalizedText.includes(probe)) return true
  // 再退一步：用字符二元组重合度判断这段证据是否确实来自原文，
  // 避免因为标点/换行改写整段被丢弃，同时拦住凭空编造的内容。
  let hits = 0
  let total = 0
  for (let index = 0; index + 1 < normalizedEvidence.length; index += 1) {
    total += 1
    if (sourceBigrams.has(normalizedEvidence.slice(index, index + 2))) hits += 1
  }
  return total > 0 && hits / total >= 0.45
}

// 第二道闸：证据不可定位时，检查该区块的字段值是否能在原文找到。
// 值来自原文即可入库，并用命中的原文片段补出证据，避免整段合法内容被丢弃。
function fieldValuesGrounded(entries, context) {
  const values = []
  for (const entry of entries) {
    for (const value of Object.values(entry.fields ?? {})) values.push(String(value))
    for (const value of Object.values(entry.extra ?? {})) values.push(String(value))
  }
  const probes = values
    .flatMap((value) => value.split(/\n|[；;|｜]/))
    .map((value) => value.trim())
    .filter((value) => value.length >= 4)
    .slice(0, 12)
  if (!probes.length) return null
  let hits = 0
  let firstHit = ''
  for (const probe of probes) {
    const normalized = probe.replace(/\s+/g, '')
    if (context.normalizedText.includes(normalized.slice(0, Math.min(24, normalized.length)))) {
      hits += 1
      if (!firstHit) firstHit = probe.slice(0, 240)
    }
  }
  return hits >= Math.min(2, probes.length) ? { hits, evidence: firstHit } : null
}

function buildSectionRow(candidateId, type, fields, extra, sortOrder, originalTitle = '') {
  const schema = SECTION_SCHEMAS[type]
  const heading = schema.headingFields.map((name) => fields[name]).filter(Boolean).join(' · ')
  const start = fields['开始时间'] ?? fields['获得时间'] ?? fields['发表时间'] ?? ''
  const end = fields['结束时间'] ?? ''
  const time = start && end ? `${start} - ${end}` : start
  const canonicalLines = schema.fields
    .filter((name) => fields[name])
    .map((name) => `${name}：${String(fields[name]).replace(/\n+/g, ' / ')}`)
  // 规范字段之外的字段照原样呈现，保证「简历里有的都看得到」。
  const extraLines = Object.entries(extra ?? {}).map(([name, value]) => `${name}：${String(value).replace(/\n+/g, ' / ')}`)
  const content = [time, [...canonicalLines, ...extraLines].join('\n')].filter(Boolean).join('\n')
  return {
    id: randomUUID(),
    candidateId,
    sectionType: type,
    title: heading || originalTitle || schema.title,
    content,
    structured: { ...fields, ...(Object.keys(extra ?? {}).length ? { _extra: extra } : {}), semantic_type: type, source: 'origin_resume_parse' },
    sortOrder
  }
}

const stats = {
  candidates: 0,
  textExtracted: 0,
  textFailed: 0,
  batches: 0,
  batchFailed: 0,
  sectionsProposed: 0,
  sectionsAccepted: 0,
  sectionsRejected: 0,
  entriesDeduped: 0,
  unmatchedFieldsCaptured: 0,
  sectionsAcceptedByFieldValues: 0,
  rowsInserted: 0,
  candidatesWithSections: 0,
  candidatesPlanned: 0,
  rowsPlanned: 0,
  skippedExistingSections: 0,
  rejectReasons: {},
  extraFieldNames: {},
  byType: {},
  inputCharacters: 0
}
const perCandidate = []

function bump(map, key, amount = 1) { map[key] = (map[key] ?? 0) + amount }

async function extractChunk(rows, offset, count) {
  const chunk = rows.slice(offset, offset + count)
  const extracted = await extractTextsInOrder(chunk, extractConcurrency)
  const prepared = []
  for (const item of extracted) {
    if (!item.ok) {
      stats.textFailed += 1
      perCandidate.push({
        candidate_id: item.row.candidate_id, name: item.row.name,
        status: 'text_failed', error: item.error
      })
      continue
    }
    if (!item.text || item.text.length < 40) {
      stats.textFailed += 1
      perCandidate.push({
        candidate_id: item.row.candidate_id, name: item.row.name,
        status: 'text_too_short', chars: item.text?.length ?? 0
      })
      continue
    }
    stats.textExtracted += 1
    stats.inputCharacters += item.text.length
    prepared.push({ candidateId: item.row.candidate_id, name: item.row.name, text: item.text, method: item.method })
  }
  return { chunk, prepared }
}

async function modelResults(prepared) {
  const batches = []
  for (let index = 0; index < prepared.length; index += options.batchSize) {
    batches.push(prepared.slice(index, index + options.batchSize))
  }
  stats.batches += batches.length
  const results = new Array(batches.length)
  let cursor = 0
  async function callWorker() {
    while (cursor < batches.length) {
      const index = cursor
      cursor += 1
      const batch = batches[index]
      try {
        const { json, usage } = await callGateway(batch)
        results[index] = { batch, json, usage, error: null }
      } catch (error) {
        stats.batchFailed += 1
        results[index] = { batch, json: null, usage: null, error: String(error?.message ?? error).slice(0, 200) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, batches.length)) }, () => callWorker()))
  return results
}

// 波内流水线：第 n 块的模型调用与第 n+1 块的正文提取重叠执行。
async function runWave(rows, onChunkDone) {
  let offset = 0
  let pending = null
  while (offset < rows.length) {
    const current = await extractChunk(rows, offset, chunkSize)
    const previous = pending
    offset += chunkSize
    const nextExtraction = offset < rows.length ? extractChunk(rows, offset, chunkSize) : null
    const calls = modelResults(current.prepared)
    pending = Promise.all([nextExtraction, calls]).then(([, results]) => results)
    if (previous) {
      const results = await previous
      if (onChunkDone) onChunkDone(results)
    }
  }
  if (pending) {
    const results = await pending
    if (onChunkDone) onChunkDone(results)
  }
}

const insertSection = db.prepare(`
  INSERT INTO candidate_profile_sections(
    id, candidate_id, section_type, title, content, structured_data,
    sort_order, sensitivity, source_record_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?, ?)
`)
const existingTypes = db.prepare(`
  SELECT DISTINCT section_type FROM candidate_profile_sections
  WHERE candidate_id = ? AND archived_at IS NULL
`)
const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM candidate_profile_sections WHERE candidate_id = ?')

// 校验 + 入计划：把模型输出转成待写入的区块。
function planWave(results) {
  const batchPlan = []
for (const result of results) {
  if (result.error) {
    for (const entry of result.batch) perCandidate.push({ candidate_id: entry.candidateId, name: entry.name, status: 'batch_failed', error: result.error })
    continue
  }
  const byCandidate = new Map(result.batch.map((entry) => [entry.candidateId, entry]))
  for (const resume of result.json?.resumes ?? []) {
    const entry = byCandidate.get(String(resume?.candidate_id ?? '').trim())
    if (!entry) { bump(stats.rejectReasons, 'unknown_candidate_id'); continue }
    const evidenceContext = normalizedEvidenceContext(entry.text)
    const accepted = []
    const acceptedByType = new Map()
    for (const section of resume.sections ?? []) {
      const rawType = String(section?.section_type ?? '').trim()
      // 解析出的区块名不在规范类型里时，不丢弃：并入「附加信息」，标题保留原区块名。
      const type = SECTION_SCHEMAS[rawType] ? rawType : 'other'
      const sectionTitle = SECTION_SCHEMAS[rawType] ? '' : rawType
      const schema = SECTION_SCHEMAS[type]
      if (!schema) { stats.sectionsRejected += 1; bump(stats.rejectReasons, `unknown_type:${rawType}`); continue }
      const entries = []
      for (const rawEntry of section.entries ?? []) {
        const normalized = normalizeEntry(type, rawEntry)
        if (!normalized) continue
        const hasCanonical = Object.keys(normalized.fields).length > 0
        const hasExtra = Object.keys(normalized.extra).length > 0
        // 其他区块允许只有原始字段（这是它的职责）；结构化区块必须有规范字段，
        // 否则视为解析噪声丢弃。
        if (hasCanonical || (type === 'other' && hasExtra)) entries.push(normalized)
      }
      let evidence = String(section.evidence ?? '').slice(0, 500)
      if (!evidenceLocatable(section?.evidence, evidenceContext)) {
        const grounded = fieldValuesGrounded(entries, evidenceContext)
        if (!grounded) {
          stats.sectionsRejected += 1
          bump(stats.rejectReasons, `evidence_not_locatable:${rawType}`)
          continue
        }
        evidence = grounded.evidence
        stats.sectionsAcceptedByFieldValues += 1
      }
      if (!entries.length) {
        stats.sectionsRejected += 1
        bump(stats.rejectReasons, `no_valid_fields:${rawType}`)
        continue
      }
      stats.sectionsProposed += 1
      // 同一候选人的同类区块合并进一个 section，后续统一去重。
      const existing = acceptedByType.get(type)
      if (existing) {
        existing.entries.push(...entries)
        if (sectionTitle && !existing.originalTitles.includes(sectionTitle)) existing.originalTitles.push(sectionTitle)
      } else {
        acceptedByType.set(type, {
          type,
          entries: [...entries],
          originalTitles: sectionTitle ? [sectionTitle] : [],
          evidence
        })
      }
    }

    // 去重合并：同一段经历只留一条。
    for (const section of acceptedByType.values()) {
      const { kept, removed } = dedupeEntries(section.type, section.entries)
      stats.entriesDeduped += removed
      if (kept.length) {
        section.entries = kept
        stats.sectionsAccepted += 1
        bump(stats.byType, section.type, kept.length)
        accepted.push(section)
      } else {
        acceptedByType.delete(section.type)
      }
    }

    batchPlan.push({ entry, accepted })
  }
}
  return batchPlan
}

// 写库：一个 wave 一次事务，写完即提交。
function writeWave(batchPlan) {
  if (!batchPlan.length) return
  let transactionStarted = false
  try {
    if (options.apply) { db.exec('BEGIN IMMEDIATE'); transactionStarted = true }
    const timestamp = new Date().toISOString()
  for (const plan of batchPlan) {
    const already = new Set(existingTypes.all(plan.entry.candidateId).map((row) => row.section_type))
    let sortOrder = Number(maxSort.get(plan.entry.candidateId).n) + 1
    let inserted = 0
    let planned = 0
    for (const section of plan.accepted) {
      if (already.has(section.type)) {
        stats.skippedExistingSections += section.entries.length
        continue
      }
      section.entries.forEach(({ fields, extra }, entryIndex) => {
        const row = buildSectionRow(
          plan.entry.candidateId, section.type, fields, extra, sortOrder,
          section.originalTitles?.join(' · ') ?? ''
        )
        const structured = { ...row.structured, entry_index: entryIndex, evidence: section.evidence, parser: PARSER_VERSION }
        for (const name of Object.keys(extra ?? {})) bump(stats.extraFieldNames, name)
        sortOrder += 1
        planned += 1
        if (!options.apply) return
        insertSection.run(
          row.id, row.candidateId, row.sectionType, row.title, row.content,
          JSON.stringify(structured), row.sortOrder, `${PARSER_VERSION}:${row.candidateId}`,
          timestamp, timestamp
        )
        stats.rowsInserted += 1
        inserted += 1
      })
    }
    if (planned) { stats.candidatesPlanned += 1; stats.rowsPlanned += planned }
    if (inserted) stats.candidatesWithSections += 1
    perCandidate.push({
      candidate_id: plan.entry.candidateId,
      name: plan.entry.name,
      status: options.apply ? 'written' : 'planned',
      method: plan.entry.method,
      accepted: plan.accepted.map((section) => section.type),
      skipped_existing: plan.accepted.filter((section) => already.has(section.type)).map((section) => section.type),
      sections: plan.accepted.map((section) => ({
        section_type: section.type,
        skipped: already.has(section.type),
        entries: section.entries.map(({ fields, extra }) => ({
          fields,
          ...(Object.keys(extra ?? {}).length ? { extra_fields: extra } : {})
        }))
      })),
      inserted
    })
  }
    if (transactionStarted) { db.exec('COMMIT'); transactionStarted = false }
  } catch (error) {
    if (transactionStarted) { try { db.exec('ROLLBACK') } catch {} }
    throw error
  }
}

function writeReport() {
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    model,
    limit: options.limit,
    offset: options.offset,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    elapsedMs: Date.now() - startedAt,
    stats,
    perCandidate
  }
  mkdirSync(dirname(options.reportPath), { recursive: true })
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // 优雅退出：当前 wave 写完后结束，丢弃未开始的 wave，下次运行会自动续跑。
    stopping = true
    console.error(`[avatar] 收到 ${signal}，当前波次结束后退出`)
  })
}

let processed = 0
let waveIndex = 0
let cursorId = '' // 游标：上一波最后一个 candidate_attachments.id（UUID 均大于空串）
while (true) {
  if (stopping) break
  const remaining = options.limit - processed
  if (remaining <= 0) break
  const rows = candidateQuery.all(
    ...queryParams,
    cursorId,
    Math.min(remaining, waveSize)
  )
  if (!rows.length) break
  cursorId = rows[rows.length - 1].attachment_id
  waveIndex += 1
  const waveStartedAt = Date.now()
  // 每块结果一出就写库（分块提交），避免整波结束才落盘。
  let waveInserted = 0
  const before = stats.rowsInserted
  await runWave(rows, (results) => {
    writeWave(planWave(results))
  })
  waveInserted = stats.rowsInserted - before
  processed += rows.length
  stats.candidates += rows.length
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000)
  console.log(`[wave ${waveIndex}] ${processed}/${options.limit} 人，落库 ${stats.rowsInserted} 行（本波 +${waveInserted}），` +
    `${(processed / elapsedSeconds).toFixed(1)} 人/秒，RSS ${Math.round(process.memoryUsage().rss / 1048576)}MB，` +
    `本波 ${Math.round((Date.now() - waveStartedAt) / 1000)}s`)
}

const report = writeReport()
db.close()
console.log(JSON.stringify({ ...report, perCandidate: `${perCandidate.length} 条（见报告文件）`, reportPath: options.reportPath }, null, 1))
