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

test('standalone parser noise is removed from sections while the source corpus stays auditable', async () => {
  const opaque = '72162b05314733391HN_2965EFFZxIq5WP6ZWOOimf7TPxVq2w~~'
  const text = [
    '项目经历',
    'Anonymous Project',
    '~',
    `~ ${opaque}`,
    '负责匿名数据管道交付。',
    '专业技能',
    'SQL、Node.js'
  ].join('\n')
  const { service, db } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const publicText = JSON.stringify({ sections: record.sections, suggestions: record.suggestions })

  assert.equal(publicText.includes(opaque), false)
  assert.equal(publicText.includes('~'), false)
  assert.match(record.sections.find((section) => section.section_type === 'project')?.content ?? '', /Anonymous Project/)
  assert.match(record.sections.find((section) => section.section_type === 'skill')?.content ?? '', /SQL、Node\.js/)
  assert.equal(text.includes(opaque), true)
  const stored = db.prepare('SELECT extracted_text, records_json FROM attachment_update_previews WHERE id = ?').get(preview.preview_id)
  assert.match(stored.extracted_text, new RegExp(opaque))
  assert.match(stored.records_json, new RegExp(opaque))
})

test('sample-style Chinese headings stay in independent canonical sections', async () => {
  const text = [
    '教育经历',
    '匿名大学 计算机技术 硕士 2024.09-2027.06',
    '项目经历',
    '匿名数据项目 2025.01-2025.03\n负责可复核的数据分析。',
    '实习经历',
    '匿名科技 助理测试工程师 2023.02-2023.05',
    '发表文章及专利',
    '匿名论文与专利成果。',
    '相关技能',
    'Python、SQL、PowerBI',
    '在校经历',
    '匿名学生组织运营。',
    '荣誉奖励',
    '匿名奖学金。',
    '自我评价',
    '具备结构化分析能力。'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const record = preview.records[0]

  assert.deepEqual(record.sections.map((section) => section.section_type), [
    'education', 'project', 'internship', 'publication', 'skill', 'campus', 'award'
  ])
  assert.equal(record.suggestions.find((suggestion) => suggestion.field === 'self_summary')?.value, '具备结构化分析能力。')
  assert.equal(record.sections.some((section) => section.content.includes('匿名奖学金。')), true)
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
  assert.equal(
    preview.records[0].sections.some((section) => section.section_type === 'self_summary'),
    false,
    'self_summary must remain a scalar suggestion instead of becoming a resume section'
  )
})

test('legacy model summary sections stay scalar-only at the service boundary', async () => {
  const text = [
    '邮箱：legacy-summary@example.test',
    '自我评价：可核对的摘要证据'
  ].join('\n')
  const suggestionProvider = async ({ records }) => ({
    records: [{
      record_id: records[0].record_id,
      suggestions: [],
      sections: [
        {
          section_type: 'self_summary',
          title: '自我评价',
          content: '可核对的摘要证据',
          confidence: 'high',
          evidence: '自我评价：可核对的摘要证据',
          default_selected: true
        },
        {
          section_type: 'resume_summary',
          title: '个人概述',
          content: '可核对的摘要证据',
          confidence: 'high',
          evidence: '自我评价：可核对的摘要证据',
          default_selected: true
        },
        {
          section_type: 'other',
          title: '简介',
          content: '可核对的摘要证据',
          structured_data: { semantic_type: 'self_summary' },
          confidence: 'high',
          evidence: '自我评价：可核对的摘要证据',
          default_selected: true
        }
      ]
    }]
  })
  const { service } = fixture(textParser(text), { suggestionProvider })
  const preview = await readyPreview(service)
  const sections = preview.records[0].sections

  assert.equal(sections.some((section) => (
    ['self_summary', 'resume_summary'].includes(String(section.section_type).toLowerCase())
      || section.structured_data?.semantic_type === 'self_summary'
  )), false)
  assert.equal(preview.records[0].suggestions.some((item) => item.field === 'self_summary'), true)
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
    '所在地原文',
    '### 2. Education: Bachelor'
  ].join('\n')
  const suggestionProvider = async ({ records }) => ({
    records: [{
      record_id: records[0].record_id,
      suggestions: [{
        field: 'location',
        value: text,
        confidence: 'high',
        evidence: '所在地原文',
        default_selected: true
      }],
      sections: [{
        section_type: 'project',
        content: text,
        confidence: 'high',
        evidence: '所在地原文',
        default_selected: true
      }]
    }]
  })
  const { service } = fixture(textParser(text), { suggestionProvider })
  const preview = await readyPreview(service)
  const record = preview.records[0]

  assert.equal(record.suggestions.find((item) => item.field === 'location')?.value, '所在地原文')
  assert.deepEqual(record.sections.map((section) => section.section_type), ['project'])
  assert.equal(record.sections[0].content, '所在地原文')
  assert.doesNotMatch(record.sections[0].content, /###\s*2\./)
})

test('model scalar suggestions require evidence containing the proposed value', async () => {
  const text = [
    '姓名：匿名候选人',
    '邮箱：evidence-binding@example.test',
    '项目经历',
    '真实项目证据'
  ].join('\n')
  const suggestionProvider = async ({ records }) => ({
    records: [{
      record_id: records[0].record_id,
      suggestions: [{
        field: 'current_company',
        value: 'Fabricated Company',
        confidence: 'high',
        evidence: '真实项目证据'
      }],
      sections: []
    }]
  })
  const { service } = fixture(textParser(text), { suggestionProvider })
  const preview = await readyPreview(service)

  assert.equal(preview.records[0].suggestions.some((item) => item.field === 'current_company'), false)
})

test('model text suggestions cannot turn a historical role into the current company', async () => {
  const evidence = 'Historical Company | Historical Analyst | 2020年1月-2022年12月'
  const text = [
    '邮箱：historical-role@example.test',
    '工作经历',
    evidence
  ].join('\n')
  const suggestionProvider = async ({ records }) => ({
    records: [{
      record_id: records[0].record_id,
      suggestions: [{
        field: 'current_company',
        value: 'Historical Company',
        confidence: 'high',
        evidence
      }],
      sections: []
    }]
  })
  const { service } = fixture(textParser(text), { suggestionProvider })
  const preview = await readyPreview(service)

  assert.equal(preview.records[0].suggestions.some((item) => item.field === 'current_company'), false)
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
    '青禾咨询 匿名分析实习生 2024.02-2024.07'
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

test('multiple inline phones and emails remain ambiguous instead of selecting the first contact', async () => {
  const text = [
    '姓名：多联系方式候选人',
    '手机：13800000011 / 13900000022',
    '邮箱：first@example.test；second@example.test',
    '项目经历：匿名项目交付'
  ].join('\n')
  const { service } = fixture(textParser(text))
  const preview = await readyPreview(service)
  const record = preview.records[0]

  assert.equal(record.match.status, 'multiple_matches')
  assert.equal(record.identity.phone, '')
  assert.equal(record.identity.email, '')
  assert.equal(record.identity_candidates, undefined)
  assert.equal(record.suggestions.some((item) => item.field === 'phone'), false)
  assert.equal(record.suggestions.some((item) => item.field === 'email'), false)
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

test('attachment work-year suggestions preserve raw text with their evidence and confidence', async () => {
  for (const raw of ['3年6个月', '应届', '0']) {
    const text = [
      '姓名：工作年限候选人',
      `工作年限：${raw}`
    ].join('\n')
    const preview = await readyPreview(fixture(textParser(text)).service)
    const suggestion = preview.records[0].suggestions.find((item) => item.field === 'years_experience')

    assert.ok(suggestion, raw)
    assert.equal(suggestion.value, raw, raw)
    assert.equal(suggestion.confidence, 'medium', raw)
    assert.equal(suggestion.evidence, `工作年限：${raw}`, raw)
  }

  const missingPreview = await readyPreview(fixture(textParser('姓名：没有工作年限')).service)
  assert.equal(
    missingPreview.records[0].suggestions.some((item) => item.field === 'years_experience'),
    false,
    'missing extraction must not become a numeric zero suggestion'
  )

  const fallbackPreview = await readyPreview(fixture(textParser('候选人拥有3年工作经验')).service)
  const fallback = fallbackPreview.records[0].suggestions.find((item) => item.field === 'years_experience')
  assert.ok(fallback)
  assert.equal(fallback.value, '3年')
  assert.equal(fallback.evidence, '3年工作经验')

  const compoundFallbackPreview = await readyPreview(fixture(textParser('候选人拥有3年6个月工作经验，负责产品交付。')).service)
  const compoundFallback = compoundFallbackPreview.records[0].suggestions.find((item) => item.field === 'years_experience')
  assert.ok(compoundFallback)
  assert.equal(compoundFallback.value, '3年6个月')
  assert.equal(compoundFallback.evidence, '3年6个月工作经验')
})

test('attachment work-year suggestions retain source text up to the shared 1000-character limit', async () => {
  const raw = `经验${'未详'.repeat(300)}`
  assert.ok(raw.length > 300 && raw.length < 1000)
  const text = `工作年限：${raw}`
  const preview = await readyPreview(fixture(textParser(text)).service)
  const suggestion = preview.records[0].suggestions.find((item) => item.field === 'years_experience')

  assert.ok(suggestion)
  assert.equal(suggestion.value, raw)
  assert.equal(suggestion.evidence, text)
})

test('attachment confirmation persists the raw work-years text with its numeric projection', async () => {
  const text = [
    '邮箱：work-years-confirm@example.test',
    '工作年限：3年6个月'
  ].join('\n')
  const { db, service } = fixture(textParser(text))
  const candidate = insertCandidate(db, {
    id: 'work-years-confirm',
    name: 'Work Years Confirm',
    email: 'work-years-confirm@example.test'
  })
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const result = service.confirmPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    records: [{
      record_id: record.record_id,
      candidate_id: candidate.id,
      expected_updated_at: record.match.candidate.updated_at,
      selected_fields: ['years_experience'],
      selected_sections: [],
      merge_mode: 'merge'
    }]
  })

  assert.deepEqual(result.records[0].changed_fields, ['years_experience', 'years_experience_raw'])
  assert.deepEqual({ ...db.prepare(`
    SELECT years_experience, years_experience_raw FROM candidates WHERE id = ?
  `).get(candidate.id) }, {
    years_experience: 3.5,
    years_experience_raw: '3年6个月'
  })
})

test('attachment confirmation clears stale numeric work years for unknown raw text', async () => {
  const text = [
    '邮箱：work-years-unknown@example.test',
    '工作年限：应届'
  ].join('\n')
  const { db, service } = fixture(textParser(text))
  const candidate = insertCandidate(db, {
    id: 'work-years-unknown',
    name: 'Work Years Unknown',
    email: 'work-years-unknown@example.test',
    years_experience: 4,
    years_experience_raw: '4年'
  })
  const preview = await readyPreview(service)
  const record = preview.records[0]
  const result = service.confirmPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    records: [{
      record_id: record.record_id,
      candidate_id: candidate.id,
      expected_updated_at: record.match.candidate.updated_at,
      selected_fields: ['years_experience'],
      selected_sections: [],
      merge_mode: 'merge'
    }]
  })

  assert.deepEqual(result.records[0].changed_fields, ['years_experience', 'years_experience_raw'])
  assert.deepEqual({ ...db.prepare(`
    SELECT years_experience, years_experience_raw FROM candidates WHERE id = ?
  `).get(candidate.id) }, {
    years_experience: null,
    years_experience_raw: '应届'
  })
})
