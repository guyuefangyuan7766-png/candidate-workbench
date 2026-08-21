import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachmentSuggestionChangesCandidate,
  attachmentSuggestionText,
  attachmentSuggestionValue,
  attachmentProfileSectionDrafts,
  candidateDraftFromAttachmentRecord,
  candidateFieldValue,
  defaultAttachmentFieldsForCandidate,
  hasCandidateValue,
  parsedAttachmentCandidateName,
  sameCandidateFieldValue
} from '../../src/attachment-candidate-prefill.ts'

function suggestion(field, value, confidence = 'high') {
  return {
    field,
    value,
    confidence,
    evidence: `${field}: ${String(value)}`,
    current_value: null,
    default_selected: false
  }
}

function previewRecord({ suggestions = [], sections = [], identity = {}, matchedCandidate } = {}) {
  return {
    record_id: 'record-1',
    row_number: 1,
    identity: { phone: '', email: '', ...identity },
    match: {
      status: matchedCandidate ? 'single_identity' : 'not_found',
      ...(matchedCandidate ? { candidate_id: matchedCandidate.id, candidate: matchedCandidate } : {}),
      reason: ''
    },
    suggestions,
    sections
  }
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    name: 'Existing Candidate',
    phone: '',
    email: '',
    photo_url: '',
    has_photo: false,
    gender: '',
    birth_date: null,
    age: null,
    current_company: '',
    current_title: '',
    location: '',
    years_experience: 0,
    education: '',
    highest_school: '',
    highest_major: '',
    job_seeking_status: '',
    resume_updated_at: null,
    self_summary: '',
    source: '',
    stage: '新候选人',
    owner: '',
    tags: [],
    expected_salary: '',
    source_system: 'manual',
    source_record_id: 'source-1',
    import_batch_id: null,
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:00.000Z',
    archived_at: null,
    positions: [],
    talent_pools: [],
    preferences: null,
    ...overrides
  }
}

test('attachment candidate prefill reads scalar suggestions and falls back to the matched name', () => {
  const matchedCandidate = {
    id: 'candidate-1',
    name: 'Matched Name',
    phone: '',
    email: '',
    updated_at: '2026-08-14T00:00:00.000Z'
  }
  const record = previewRecord({
    matchedCandidate,
    suggestions: [
      suggestion('name', '   '),
      suggestion('years_experience', 6),
      suggestion('tags', ['TypeScript'])
    ]
  })

  assert.equal(attachmentSuggestionValue(record, 'years_experience'), 6)
  assert.equal(attachmentSuggestionText(record, 'years_experience'), '6')
  assert.equal(attachmentSuggestionText(record, 'tags'), '')
  assert.equal(parsedAttachmentCandidateName(record), 'Matched Name')
})

test('attachment candidate draft prefills identity, profile fields, and preferences', () => {
  const record = previewRecord({
    identity: { phone: '13800000000', email: 'identity@example.com' },
    suggestions: [
      suggestion('name', '  张三  '),
      suggestion('gender', '女'),
      suggestion('birth_date', '1995-04-12'),
      suggestion('age', 31),
      suggestion('phone', '13900000000'),
      suggestion('email', 'suggested@example.com'),
      suggestion('current_company', '示例科技'),
      suggestion('current_title', '高级工程师'),
      suggestion('location', '深圳'),
      suggestion('years_experience', '7'),
      suggestion('education', '硕士'),
      suggestion('highest_school', '示例大学'),
      suggestion('highest_major', '计算机科学'),
      suggestion('job_seeking_status', '在职看机会'),
      suggestion('resume_updated_at', '2026-08-01'),
      suggestion('self_summary', '专注平台工程'),
      suggestion('source', '猎头推荐'),
      suggestion('owner', '本人'),
      suggestion('tags', ['平台', 'TypeScript', 'Node.js']),
      suggestion('expected_salary', '35k-45k'),
      suggestion('desired_titles', [' 技术负责人 ', '', '平台架构师']),
      suggestion('desired_locations', [' 深圳 ', '', '上海']),
      suggestion('employment_type', '全职'),
      suggestion('availability', '一个月内')
    ]
  })

  const draft = candidateDraftFromAttachmentRecord(record)

  assert.deepEqual(draft, {
    name: '张三',
    phone: '13800000000',
    email: 'identity@example.com',
    gender: '女',
    birth_date: '1995-04-12',
    age: 31,
    current_company: '示例科技',
    current_title: '高级工程师',
    location: '深圳',
    years_experience: 7,
    education: '硕士',
    highest_school: '示例大学',
    highest_major: '计算机科学',
    job_seeking_status: '在职看机会',
    hire_status: '',
    hire_date: null,
    resume_updated_at: '2026-08-01',
    self_summary: '专注平台工程',
    source: '猎头推荐',
    stage: '新候选人',
    owner: '本人',
    tags: ['平台', 'TypeScript', 'Node.js'],
    expected_salary: '35k-45k',
    preferences: {
      employment_status: '在职看机会',
      desired_titles: ['技术负责人', '平台架构师'],
      desired_locations: ['深圳', '上海'],
      employment_type: '全职',
      expected_salary: '35k-45k',
      availability: '一个月内'
    },
    profile_sections: []
  })
})

test('attachment candidate draft prefills only selected canonical resume sections', () => {
  const record = previewRecord({ sections: [
    { section_id: 'education-1', section_type: 'education_experience', title: '教育经历', content: '示例大学 | 本科', structured_data: { school: '示例大学' }, confidence: 'high', evidence: '教育经历：示例大学', default_selected: true },
    { section_id: 'summary-1', section_type: 'self_summary', title: '自我评价', content: '不应重复保存为履历区块', structured_data: null, confidence: 'high', evidence: '自我评价：不应重复保存为履历区块', default_selected: true },
    { section_id: 'work-1', section_type: 'work_experience', title: '工作经历', content: '未勾选的工作经历', structured_data: null, confidence: 'medium', evidence: '工作经历：未勾选', default_selected: false },
    { section_id: 'internship-1', section_type: 'internship', title: '实习经历', content: '示例公司 | 实习生', structured_data: { organization: '示例公司' }, confidence: 'high', evidence: '实习经历：示例公司', default_selected: true }
  ] })
  assert.deepEqual(attachmentProfileSectionDrafts(record), [
    { section_type: 'education', title: '教育经历', content: '示例大学 | 本科', structured_data: { school: '示例大学' }, sort_order: 0, sensitivity: 'internal' },
    { section_type: 'internship', title: '实习经历', content: '示例公司 | 实习生', structured_data: { organization: '示例公司' }, sort_order: 1, sensitivity: 'internal' }
  ])
  assert.deepEqual(candidateDraftFromAttachmentRecord(record).profile_sections, attachmentProfileSectionDrafts(record))
  assert.equal('id' in attachmentProfileSectionDrafts(record)[0], false)
  assert.equal('source_record_id' in attachmentProfileSectionDrafts(record)[0], false)
})

test('attachment candidate draft does not invent education when the resume has none', () => {
  const draft = candidateDraftFromAttachmentRecord(previewRecord({
    suggestions: [suggestion('name', 'Contactless candidate')]
  }))

  assert.equal(draft.name, 'Contactless candidate')
  assert.equal(draft.phone, '')
  assert.equal(draft.email, '')
  assert.equal(draft.education, '')
})

test('candidate field comparison understands preferences, empty values, and tag merging', () => {
  const existing = candidate({
    tags: ['React'],
    expected_salary: '25k',
    preferences: {
      employment_status: '',
      desired_titles: ['前端工程师'],
      desired_locations: ['深圳'],
      employment_type: '全职',
      expected_salary: '30k',
      availability: '一个月内'
    }
  })

  assert.deepEqual(candidateFieldValue(existing, 'desired_titles'), ['前端工程师'])
  assert.deepEqual(candidateFieldValue(existing, 'desired_locations'), ['深圳'])
  assert.equal(candidateFieldValue(existing, 'employment_type'), '全职')
  assert.equal(candidateFieldValue(existing, 'availability'), '一个月内')
  assert.equal(candidateFieldValue(existing, 'expected_salary'), '30k')
  assert.equal(candidateFieldValue(existing, 'unknown_field'), null)
  assert.equal(sameCandidateFieldValue('desired_titles', ['前端工程师'], ['前端工程师']), true)
  assert.equal(attachmentSuggestionChangesCandidate(existing, 'tags', ['React']), false)
  assert.equal(attachmentSuggestionChangesCandidate(existing, 'tags', ['React', 'TypeScript']), true)
  assert.equal(attachmentSuggestionChangesCandidate(existing, 'expected_salary', '30k'), false)
  assert.equal(hasCandidateValue('   '), false)
  assert.equal(hasCandidateValue('-'), false)
  assert.equal(hasCandidateValue(Number.NaN), false)
  assert.equal(hasCandidateValue(0), true)
})

test('default attachment fields include only real, non-low-confidence updates to empty fields', () => {
  const existing = candidate({
    phone: '',
    email: 'existing@example.com',
    current_company: '',
    current_title: 'Engineer',
    tags: []
  })
  const record = previewRecord({
    suggestions: [
      suggestion('phone', '13800000000', 'high'),
      suggestion('email', 'incoming@example.com', 'high'),
      suggestion('current_company', 'Example Inc.', 'low'),
      suggestion('current_title', 'Engineer', 'high'),
      suggestion('tags', ['TypeScript'], 'medium')
    ]
  })

  assert.deepEqual(
    [...defaultAttachmentFieldsForCandidate(record, existing)].sort(),
    ['phone', 'tags']
  )
})
