import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createAttachmentService } from '../../server/attachments.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

const resources = []

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()
    try { await resource.service.close() } catch {}
    try { resource.db.close() } catch {}
    try { rmSync(resource.root, { recursive: true, force: true }) } catch {}
  }
})

function fixture(parser, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'attachment-semantic-parsing-'))
  const db = openDatabase(':memory:')
  const options = {
    db,
    rootDir: root,
    suggestionProvider: null,
    cleanupIntervalMs: 60 * 60 * 1000,
    ...overrides
  }
  if (parser) options.parser = parser
  const service = createAttachmentService(options)
  const resource = { root, db, service }
  resources.push(resource)
  return resource
}

function textParser(text) {
  return async () => ({
    text,
    records: [{ row_number: 1, values: { raw_text: text } }],
    metadata: {}
  })
}

function rowParser(values) {
  return async () => ({
    text: Object.entries(values).map(([header, value]) => `${header}: ${value}`).join(' | '),
    records: [{ row_number: 2, values }],
    metadata: {}
  })
}

function uploadFile(name = 'resume.txt') {
  return {
    originalname: name,
    mimetype: 'text/plain',
    buffer: Buffer.from('valid parser fixture payload', 'utf8')
  }
}

async function readyPreview(service, file = uploadFile()) {
  const pending = service.createPreview({ file })
  return service.waitForPreview(pending.preview_id)
}

test('scalar fields stop at their physical line and opaque parser tokens are not suggested', async () => {
  const opaque = '6a52b9a5e86aa56c1HN-3tS8F1dSxli2UfudWOOimf7TPxVq2w'
  const text = [
    '姓名：边界候选人',
    '邮箱：boundary@example.test',
    `意 向 岗 位：内容运营 ${opaque}`,
    '这一行是没有标签的简历正文，不属于意向岗位。',
    '实 习 经 历：实习公司：示例科技；实习职位：产品实习生；实习时间：2025.01-2025.06',
    '语 言 能 力：英语 CET-6',
    '附 加 信 息：可立即到岗'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const suggestions = Object.fromEntries(record.suggestions.map((suggestion) => [suggestion.field, suggestion]))

  assert.deepEqual(suggestions.desired_titles.value, ['内容运营'])
  assert.equal(JSON.stringify(record.suggestions).includes(opaque), false, 'user-facing suggestions must not expose opaque parser tokens')
  assert.equal(text.includes(opaque), true, 'the raw attachment source remains available for audit')
  assert.equal(JSON.stringify(record.suggestions.map((suggestion) => suggestion.value)).includes(opaque), false)
  assert.equal(suggestions.desired_titles.value.join('').includes('这一行'), false)
  for (const suggestion of record.suggestions) assert.equal(text.includes(suggestion.evidence), true)
  assert.equal(record.suggestions.some((suggestion) => suggestion.field === 'current_title'), false)
  assert.deepEqual(record.sections.map((section) => section.section_type), ['internship', 'language', 'other'])
  assert.equal(record.sections[0].structured_data.organization, '示例科技')
  assert.equal(record.sections[0].structured_data.role, '产品实习生')
  assert.equal(record.sections[0].structured_data.period, '2025.01-2025.06')
})

test('standalone scalar labels consume only the immediately following line', async () => {
  const text = [
    '姓名：独立标签候选人',
    '意向岗位',
    '数据分析师',
    '这里是后续无标签正文，不应进入意向岗位。'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const suggestion = preview.records[0].suggestions.find((item) => item.field === 'desired_titles')
  assert.ok(suggestion)
  assert.deepEqual(suggestion.value, ['数据分析师'])
  assert.equal(suggestion.value.join('').includes('后续无标签正文'), false)
  assert.equal(text.includes(suggestion.evidence), true)
})

test('historical start dates do not become candidate availability while explicit arrival labels still do', async () => {
  const chineseHistory = [
    '姓名：中文经历候选人',
    '工作经历：',
    '公司：示例科技',
    '入职时间：2021-01',
    '离职时间：2024-06'
  ].join('\n')
  const chinesePreview = await readyPreview(fixture(textParser(chineseHistory)).service)
  assert.equal(
    chinesePreview.records[0].suggestions.some((suggestion) => suggestion.field === 'availability'),
    false
  )

  const englishHistory = [
    'Name: English History Candidate',
    'Work Experience:',
    'Company: Example Technology',
    'Start Date: 2021-01',
    'End Date: 2024-06'
  ].join('\n')
  const englishPreview = await readyPreview(fixture(textParser(englishHistory)).service)
  assert.equal(
    englishPreview.records[0].suggestions.some((suggestion) => suggestion.field === 'availability'),
    false
  )

  const explicitAvailability = [
    '姓名：明确到岗候选人',
    '到岗时间：一个月内'
  ].join('\n')
  const availabilityPreview = await readyPreview(fixture(textParser(explicitAvailability)).service)
  const availability = availabilityPreview.records[0].suggestions.find(
    (suggestion) => suggestion.field === 'availability'
  )
  assert.ok(availability)
  assert.equal(availability.value, '一个月内')
  assert.equal(availability.evidence, '到岗时间：一个月内')
})

test('concatenated labels in PDF-like text still produce bounded scalar values', async () => {
  const text = '姓名：粘连候选人邮箱：joined@example.test意向岗位：数据分析师工作经历：示例公司 数据分析师'
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const suggestions = Object.fromEntries(preview.records[0].suggestions.map((item) => [item.field, item]))
  assert.equal(suggestions.name.value, '粘连候选人')
  assert.equal(suggestions.email.value, 'joined@example.test')
  assert.deepEqual(suggestions.desired_titles.value, ['数据分析师'])
  assert.equal(suggestions.name.evidence, '姓名：粘连候选人')
  assert.equal(suggestions.email.evidence, '邮箱：joined@example.test')
})

test('education details update profile fields while historical jobs stay in resume sections', async () => {
  const text = [
    '邮箱：education@example.test',
    '教育经历：',
    '学历：本科',
    '学校名称：示例大学',
    '专业名称：计算机科学',
    '工作经历：',
    '公司：历史公司',
    '职位：历史职位',
    '负责历史项目交付。'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const suggestions = Object.fromEntries(record.suggestions.map((suggestion) => [suggestion.field, suggestion.value]))

  assert.equal(suggestions.education, '本科')
  assert.equal(suggestions.highest_school, '示例大学')
  assert.equal(suggestions.highest_major, '计算机科学')
  assert.equal(Object.hasOwn(suggestions, 'current_company'), false)
  assert.equal(Object.hasOwn(suggestions, 'current_title'), false)
  assert.deepEqual(record.sections.map((section) => section.section_type), ['education', 'experience'])
})

test('numbered and markdown section headings retain canonical section boundaries', async () => {
  const text = [
    '1、教育经历',
    '示例大学 本科',
    '### 2. 实习经历',
    '示例公司 产品实习生 2025.01-2025.06',
    '三、语言能力',
    '英语 CET-6'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const sections = preview.records[0].sections
  assert.deepEqual(sections.map((section) => section.section_type), ['education', 'internship', 'language'])
  assert.match(sections[0].content, /示例大学 本科/)
  assert.doesNotMatch(sections[0].content, /实习经历/)
})

test('multiline scalar fields stop before a numbered section heading prefix', async () => {
  const text = [
    '自我评价：重视质量与可验证交付',
    '### 2. 实习经历',
    '示例公司 产品实习生 2025.01-2025.06'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const suggestion = preview.records[0].suggestions.find((item) => item.field === 'self_summary')
  assert.ok(suggestion)
  assert.equal(suggestion.value, '重视质量与可验证交付')
  assert.equal(text.includes(suggestion.evidence), true)
})

test('Chinese OCR spacing joins singleton characters while preserving word spaces', async () => {
  const text = [
    '姓名：张 三 丰',
    '教育经历：示例大学 本科',
    '语言能力：数 据 分 析'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const suggestions = Object.fromEntries(record.suggestions.map((item) => [item.field, item.value]))
  assert.equal(suggestions.name, '张三丰')
  assert.match(record.sections.find((section) => section.section_type === 'education')?.content ?? '', /示例大学 本科/)
  assert.match(record.sections.find((section) => section.section_type === 'language')?.content ?? '', /数据分析/)
})

test('noise cleanup preserves a long business ID under an explicit identifier label', async () => {
  const businessId = 'abcdef1234567890ABCDEF'
  const internalLineageId = 'attachment-preview:00000000-0000-4000-8000-000000000001:record-1'
  const text = [
    '项目经历：',
    `业务编号：${businessId}`,
    `候选人编号：${internalLineageId}`,
    '负责项目交付'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const project = preview.records[0].sections.find((section) => section.section_type === 'project')

  assert.ok(project)
  assert.match(project.content, new RegExp(businessId))
  assert.doesNotMatch(project.content, /attachment-preview:/i)
  assert.equal(text.includes(project.evidence), true)
})

test('model values stop before the physical start of a numbered Markdown heading', async () => {
  const text = [
    '目标职位原文',
    '### 2. Education: Bachelor'
  ].join('\n')
  const suggestionProvider = async ({ records }) => ({
    records: [{
      record_id: records[0].record_id,
      suggestions: [{
        field: 'current_title',
        value: text,
        confidence: 'high',
        evidence: '目标职位原文',
        default_selected: true
      }],
      sections: [{
        section_type: 'project',
        content: text,
        confidence: 'high',
        evidence: '目标职位原文',
        default_selected: true
      }]
    }]
  })
  const { service } = fixture(textParser(text), { suggestionProvider })
  const preview = await readyPreview(service)
  const record = preview.records[0]

  assert.equal(record.suggestions.find((item) => item.field === 'current_title')?.value, '目标职位原文')
  assert.deepEqual(record.sections.map((section) => section.section_type), ['project'])
  assert.equal(record.sections[0].content, '目标职位原文')
  assert.doesNotMatch(record.sections[0].content, /###\s*2\./)
})

test('spreadsheet resume columns create canonical sections in physical-column order', async () => {
  const values = {
    姓名: '表格候选人',
    邮箱: 'sheet@example.test',
    教育经历: '示例大学，计算机科学，本科',
    工作经历: '示例公司，平台工程师，2023-2025',
    项目经历: '候选人系统重构',
    实习经历: '示例实验室，研发实习生，2022.01-2022.06',
    语言能力: '英语 CET-6',
    专业技能: 'TypeScript、Node.js',
    附加信息: '可立即到岗',
    候选人编号: 'EXTERNAL-2026-001'
  }
  const { service } = fixture(rowParser(values))
  const preview = await readyPreview(service)
  const record = preview.records[0]

  assert.deepEqual(record.sections.map((section) => section.section_type), [
    'education', 'experience', 'project', 'internship', 'language', 'skill', 'other'
  ])
  assert.equal(record.sections.every((section) => section.structured_data.canonical_type === section.section_type), true)
  assert.equal(record.sections.every((section) => section.evidence.includes(':')), true)
  assert.equal(record.suggestions.some((suggestion) => suggestion.field === 'source_record_id'), false)
})

test('combined skills and certificates headings create a canonical skill section', async () => {
  const text = [
    '姓名：技能证书候选人',
    '技能证书',
    'SQL、Excel、Python；数据分析专业证书。',
    '实习经历',
    '青禾咨询 数据分析实习生 2024.02-2024.07'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const sections = preview.records[0].sections

  assert.deepEqual(sections.map((section) => section.section_type), ['skill', 'internship'])
  assert.equal(sections[0].title, '技能')
  assert.match(sections[0].content, /SQL、Excel、Python/)
  assert.match(sections[0].content, /数据分析专业证书/)
  assert.equal(text.includes(sections[0].evidence), true)
})

test('real CSV parsing preserves duplicate resume columns by physical position', async () => {
  const { service } = fixture()
  const file = {
    originalname: 'duplicate-resume-columns.csv',
    mimetype: 'text/csv',
    buffer: Buffer.from([
      '姓名,邮箱,教育经历,教育经历,实习经历,语言能力',
      '重复列候选人,duplicate@example.test,"示例大学 本科","示例学院 交换学习","示例公司 产品实习生","英语 CET-6"'
    ].join('\n'), 'utf8')
  }
  const preview = await readyPreview(service, file)
  const sections = preview.records[0].sections
  const education = sections.find((section) => section.section_type === 'education')

  assert.ok(education)
  assert.deepEqual(education.structured_data.source_headers, ['教育经历', '教育经历_2'])
  assert.match(education.content, /示例大学 本科/)
  assert.match(education.content, /示例学院 交换学习/)
  assert.deepEqual(sections.map((section) => section.section_type), ['education', 'internship', 'language'])
})

test('duplicate physical identity columns block automatic matching and contact suggestions', async () => {
  const { service } = fixture()
  const file = {
    originalname: 'duplicate-identity-columns.csv',
    mimetype: 'text/csv',
    buffer: Buffer.from([
      '姓名,邮箱,邮箱,手机号,手机号',
      '身份歧义候选人,first@example.test,second@example.test,13800000001,13800000002'
    ].join('\n'), 'utf8')
  }
  const preview = await readyPreview(service, file)
  const record = preview.records[0]

  assert.equal(record.match.status, 'multiple_matches')
  assert.equal(record.identity.email, '')
  assert.equal(record.identity.phone, '')
  assert.equal(record.suggestions.some((suggestion) => suggestion.field === 'email'), false)
  assert.equal(record.suggestions.some((suggestion) => suggestion.field === 'phone'), false)
})

test('confirmation persists only canonical profile types and keeps self summary scalar-only', async () => {
  const text = [
    '邮箱：canonical@example.test',
    '自我评价：重视可验证的数据质量',
    '工作经历：示例科技 数据工程师',
    '实习经历：示例实验室 研发实习生',
    '语言能力：英语 CET-6'
  ].join('\n')
  const { db, service } = fixture(textParser(text))
  const candidate = insertCandidate(db, { id: 'canonical-sections', name: 'Canonical', email: 'canonical@example.test' })
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const selfSummary = record.suggestions.find((suggestion) => suggestion.field === 'self_summary')
  assert.ok(selfSummary)

  service.confirmPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    records: [{
      record_id: record.record_id,
      candidate_id: candidate.id,
      expected_updated_at: record.match.candidate.updated_at,
      selected_fields: ['self_summary'],
      selected_sections: record.sections.map((section) => section.section_id),
      merge_mode: 'merge'
    }]
  })

  const storedTypes = db.prepare(`
    SELECT section_type FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL ORDER BY sort_order
  `).all(candidate.id).map((section) => section.section_type)
  assert.deepEqual(storedTypes, ['experience', 'internship', 'language'])
  assert.equal(db.prepare('SELECT self_summary FROM candidates WHERE id = ?').get(candidate.id).self_summary, '重视可验证的数据质量')
  assert.equal(storedTypes.includes('self_summary'), false)
  assert.equal(storedTypes.includes('work_experience'), false)
})
