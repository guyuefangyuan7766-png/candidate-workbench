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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAttachment, validateAttachmentFile } from '../server/attachment-parser.js'

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

const candidates = db.prepare(`
  SELECT a.candidate_id, a.storage_path, a.mime_type, a.file_size, c.name
  FROM candidate_attachments a
  JOIN candidates c ON c.id = a.candidate_id
  JOIN candidate_source_records s ON s.candidate_id = a.candidate_id AND s.record_type = 'talent_profile'
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
  ORDER BY a.candidate_id
  LIMIT ? OFFSET ?
`).all(...queryParams, options.limit, options.offset)

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

function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(td|th|div|p|li|tr|h[1-6]|table)>/gi, '\n')
    .replace(/<\/(br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
    .trim()
}

async function extractText(row) {
  const buffer = readFileSync(row.storage_path)
  if (row.mime_type === 'text/html') return { text: htmlToText(buffer.toString('utf8')), method: 'html_strip' }
  if (row.mime_type === 'text/plain') return { text: buffer.toString('utf8'), method: 'plain' }
  const file = { buffer, originalname: row.storage_path.split(/[\\/]/).pop(), mimetype: row.mime_type }
  const validated = validateAttachmentFile(file)
  const parsed = await parseAttachment(file, validated)
  const text = parsed?.records?.map((record) => record?.values?.raw_text ?? '').filter(Boolean).join('\n') ?? ''
  return { text, method: `attachment_parser:${parsed?.format ?? 'pdf'}` }
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
    if (cleanName && !extra[cleanName]) extra[cleanName] = value.slice(0, 2000)
  }
  if (!Object.keys(fields).length && !Object.keys(extra).length) return null
  const ordered = {}
  for (const name of schema.fields) if (fields[name]) ordered[name] = fields[name]
  return { fields: ordered, extra }
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

function buildSectionRow(candidateId, type, fields, extra, sortOrder) {
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
    title: heading ? `${heading}${''}` : schema.title,
    content,
    structured: { ...fields, ...(Object.keys(extra ?? {}).length ? { _extra: extra } : {}), semantic_type: type, source: 'origin_resume_parse' },
    sortOrder
  }
}

const stats = {
  candidates: candidates.length,
  textExtracted: 0,
  textFailed: 0,
  batches: 0,
  batchFailed: 0,
  sectionsProposed: 0,
  sectionsAccepted: 0,
  sectionsRejected: 0,
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

const prepared = []
for (const row of candidates) {
  try {
    const { text, method } = await extractText(row)
    if (!text || text.length < 40) { stats.textFailed += 1; continue }
    stats.textExtracted += 1
    stats.inputCharacters += text.length
    prepared.push({ candidateId: row.candidate_id, name: row.name, text, method })
  } catch (error) {
    stats.textFailed += 1
    perCandidate.push({ candidate_id: row.candidate_id, name: row.name, status: 'text_failed', error: String(error?.message ?? error).slice(0, 120) })
  }
}

const batches = []
for (let index = 0; index < prepared.length; index += options.batchSize) {
  batches.push(prepared.slice(index, index + options.batchSize))
}
stats.batches = batches.length

const results = new Array(batches.length)
let cursor = 0
async function worker() {
  while (cursor < batches.length) {
    const index = cursor
    cursor += 1
    const batch = batches[index]
    stats.batches += 0
    try {
      const { json, usage } = await callGateway(batch)
      results[index] = { batch, json, usage, error: null }
    } catch (error) {
      stats.batchFailed += 1
      results[index] = { batch, json: null, usage: null, error: String(error?.message ?? error).slice(0, 200) }
    }
  }
}
await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, batches.length)) }, () => worker()))

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
    for (const section of resume.sections ?? []) {
      const type = String(section?.section_type ?? '').trim()
      const schema = SECTION_SCHEMAS[type]
      if (!schema) { stats.sectionsRejected += 1; bump(stats.rejectReasons, `unknown_type:${type}`); continue }
      if (!evidenceLocatable(section?.evidence, evidenceContext)) {
        stats.sectionsRejected += 1
        bump(stats.rejectReasons, `evidence_not_locatable:${type}`)
        continue
      }
      const entries = []
      for (const rawEntry of section.entries ?? []) {
        const normalized = normalizeEntry(type, rawEntry)
        if (normalized) entries.push(normalized)
      }
      if (!entries.length) {
        stats.sectionsRejected += 1
        bump(stats.rejectReasons, `no_valid_fields:${type}`)
        continue
      }
      stats.sectionsProposed += 1
      stats.sectionsAccepted += 1
      bump(stats.byType, type, entries.length)
      accepted.push({ type, entries, evidence: String(section.evidence ?? '').slice(0, 500) })
    }
    batchPlan.push({ entry, accepted })
  }
}

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
        const row = buildSectionRow(plan.entry.candidateId, section.type, fields, extra, sortOrder)
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
db.close()
console.log(JSON.stringify({ ...report, perCandidate: `${perCandidate.length} 条（见报告文件）`, reportPath: options.reportPath }, null, 1))
