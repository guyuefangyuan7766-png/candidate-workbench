import { randomUUID } from 'node:crypto'
import { findDuplicate, insertCandidate, patchCandidate } from './candidates.js'
import { now, withTransaction } from './database.js'
import { sanitizeCandidateInput } from './validation.js'

const SOURCE_SYSTEM = 'beisen'
const IMPORT_FAILURE_DETAIL_LIMIT = 100

function appendImportFailure(failures, failure) {
  if (failures.length < IMPORT_FAILURE_DETAIL_LIMIT) failures.push(failure)
}

function failureDetailMetadata(failedRows, failures) {
  const omitted = Math.max(0, failedRows - failures.length)
  return {
    failure_details_returned: failures.length,
    failure_details_limit: IMPORT_FAILURE_DETAIL_LIMIT,
    failure_details_omitted: omitted,
    failure_details_truncated: omitted > 0
  }
}

const FIELD_ALIASES = {
  candidate_id: ['应聘者ID'],
  application_id: ['申请ID'],
  position_code: ['职位编号', '最后职位类投递的职位id'],
  last_position_key: ['最后职位类投递的职位id'],
  last_position_delivery_at: ['最后职位类投递时间'],
  name: ['姓名', '应聘者姓名', '应聘者Id'],
  phone: ['手机', '手机号', '手机号码', '联系电话'],
  email: ['邮箱', '电子邮箱'],
  photo_url: ['证件照'],
  position_title: ['职位名称', '招聘职位', '应聘职位', '最后职位类投递的职位id'],
  current_company: ['最近工作公司', '最近公司', '当前公司'],
  current_title: ['最近工作职位', '最近职位', '当前职位'],
  location: ['现居住地', '现居地', '所在地'],
  gender: ['性别'],
  birth_date: ['出生日期'],
  age: ['年龄'],
  years_experience: ['工作年限'],
  education: ['最高学历'],
  highest_school: ['最高学历学校', '最高学历院校'],
  highest_major: ['最高学历专业'],
  job_seeking_status: ['求职状态'],
  hire_position: ['入职职位', '入职岗位'],
  hire_status: ['入职状态', '入职情况'],
  hire_date: ['入职日期', '入职时间'],
  resume_updated_at: ['简历更新时间'],
  self_summary: ['自我评价', '自我概述'],
  tags: ['标签', '人才标签'],
  effective_source: ['有效投递渠道', '有效来源', '来源渠道'],
  first_source: ['最初投递渠道', '最初来源'],
  last_source: ['最后投递渠道', '最后来源'],
  talent_pool: ['应聘者关联人才库', '所属人才库', '人才库分类', '人才库', '最近人才库'],
  position_department: ['职位部门', '需求部门'],
  position_location: ['职位工作地点', '工作地点'],
  position_owner: ['招聘负责人'],
  position_category: ['职位类别', '职位类型'],
  professional_line: ['专业线'],
  job_sequence: ['职位序列'],
  headcount_type: ['编制类型', '需求类型'],
  project_name: ['所属项目'],
  headcount: ['计划人数', '招聘人数'],
  applied_at: ['申请时间', '投递时间']
}

const PROFILE_FIELDS = new Map([
  ['教育经历', 'education'],
  ['工作经历', 'experience'],
  ['项目经历', 'project'],
  ['实习经历', 'internship'],
  ['技能', 'skill'],
  ['校园经历', 'campus'],
  ['在校实践', 'campus'],
  ['在校职务', 'campus'],
  ['语言能力', 'language'],
  ['证书', 'certificate'],
  ['获奖经历', 'award'],
  ['获奖', 'award'],
  ['培训经历', 'training'],
  ['论文著作', 'publication'],
  ['论文专著', 'publication'],
  ['管理经验', 'management'],
  ['团队管理', 'management'],
  ['附加信息', 'additional']
])

function isAssessmentHeader(header) {
  if (FIELD_ALIASES.self_summary.includes(header)) return false
  if (/(Offer|录用)/i.test(header)) return false
  return /(面试|测评|评价|筛选|考试|AI面|背调)/i.test(header)
}

function textValue(value, maximum = 20_000) {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text.slice(0, maximum) : null
}

function firstValue(values, aliases, maximum) {
  for (const alias of aliases) {
    const value = textValue(values[alias], maximum)
    if (value) return value
  }
  return null
}

function fieldValue(values, field, maximum) {
  return firstValue(values, FIELD_ALIASES[field] ?? [], maximum)
}

function associatedPositionKey(values) {
  const dedicatedHeader = '最后职位类投递的职位id'
  if (Object.prototype.hasOwnProperty.call(values, dedicatedHeader)) {
    return textValue(values[dedicatedHeader], 300)
  }
  return fieldValue(values, 'position_code', 300)
}

function rawFieldValue(values, field) {
  for (const alias of FIELD_ALIASES[field] ?? []) {
    const value = values[alias]
    if (hasNonEmptyValue(value)) return value
  }
  return null
}

function fieldValues(values, field, maximum) {
  return (FIELD_ALIASES[field] ?? [])
    .map((alias) => textValue(values[alias], maximum))
    .filter(Boolean)
    .join('，')
}

function splitValues(value, maximum = 50) {
  return [...new Set(String(value ?? '').split(/[,，;；|\n]+/).map((item) => item.trim()).filter(Boolean))].slice(0, maximum)
}

function subset(values, predicate) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => predicate(key) && textValue(value)))
}

function jsonText(value) {
  return JSON.stringify(value ?? {})
}

function parseJsonObject(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseJsonArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function hasNonEmptyValue(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function mergeNonEmptyPayload(existing, incoming) {
  const merged = { ...(existing ?? {}) }
  for (const [field, value] of Object.entries(incoming ?? {})) {
    if (!hasNonEmptyValue(value)) continue
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      merged[field] && typeof merged[field] === 'object' && !Array.isArray(merged[field])
    ) {
      merged[field] = mergeNonEmptyPayload(merged[field], value)
    } else {
      merged[field] = value
    }
  }
  return merged
}

function mergeCandidateValues(target, incoming) {
  for (const [field, value] of Object.entries(incoming ?? {})) {
    if (!hasNonEmptyValue(value)) continue
    if (field === 'hire_status' && value === '不确定' && hasNonEmptyValue(target.hire_status) && target.hire_status !== '不确定') continue
    if (field === 'tags') {
      target.tags = [...new Set([...(target.tags ?? []), ...value])].slice(0, 50)
      continue
    }
    target[field] = value
  }
  return target
}

function sourceFieldHasValue(values, field) {
  return (FIELD_ALIASES[field] ?? []).some((alias) => hasNonEmptyValue(values?.[alias]))
}

const IMPORT_POSITION_TEXT_FIELDS = [
  'title',
  'department',
  'location',
  'owner',
  'source_system',
  'source_record_id',
  'external_code',
  'category',
  'professional_line',
  'job_sequence',
  'headcount_type',
  'project_name'
]

function normalizePositionText(value) {
  if (value == null) return ''
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}

function stablePositionValue(value) {
  return value == null ? '' : String(value).trim()
}

function mergePositionValues(target, incoming) {
  for (const field of [...IMPORT_POSITION_TEXT_FIELDS, 'headcount']) {
    if (!hasNonEmptyValue(target[field]) && hasNonEmptyValue(incoming?.[field])) target[field] = incoming[field]
  }
  return target
}

function importPositionHasData(position) {
  return Boolean(position && [
    position.title,
    position.department,
    position.location,
    position.owner,
    position.source_record_id,
    position.external_code
  ].some(hasNonEmptyValue))
}

function addPositionIndex(index, key, record) {
  if (!key) return
  if (!index.has(key)) index.set(key, new Set())
  index.get(key).add(record)
}

function positionStableKeys(position) {
  const sourceSystem = normalizePositionText(position?.source_system)
  if (!sourceSystem) return []
  const keys = []
  const sourceRecordId = stablePositionValue(position?.source_record_id)
  const externalCode = stablePositionValue(position?.external_code)
  if (sourceRecordId) keys.push(`record:${sourceSystem}\u0000${sourceRecordId}`)
  if (externalCode) keys.push(`code:${sourceSystem}\u0000${externalCode}`)
  return keys
}

function positionTripleKey(position) {
  const title = normalizePositionText(position?.title)
  const department = normalizePositionText(position?.department)
  const location = normalizePositionText(position?.location)
  return title && department && location ? `${title}\u0000${department}\u0000${location}` : ''
}

function positionTitleKey(position) {
  return normalizePositionText(position?.title)
}

export function importPositionError(resolution) {
  if (!resolution || !['ambiguous', 'invalid', 'archived_conflict'].includes(resolution.action)) return null
  const messages = {
    ambiguous: '职位信息命中多个在用职位，需要人工选择',
    archived_conflict: '职位信息命中已归档职位，请先恢复职位或修改导入映射',
    invalid: resolution.reason === 'missing_position_title'
      ? '无法创建职位：缺少职位名称'
      : resolution.reason === 'missing_position_source_system'
        ? '职位编号需要同时提供职位来源系统'
        : '职位部门和职位地点必须同时提供，或仅提供职位名称'
  }
  return {
    field: 'position',
    code: resolution.reason,
    message: messages[resolution.action]
  }
}

export function createImportPositionResolver(db) {
  const stableIndex = new Map()
  const tripleIndex = new Map()
  const titleIndex = new Map()
  let nextPlanId = 1

  const addRecord = (record) => {
    for (const key of positionStableKeys(record.position)) addPositionIndex(stableIndex, key, record)
    addPositionIndex(tripleIndex, positionTripleKey(record.position), record)
    addPositionIndex(titleIndex, positionTitleKey(record.position), record)
  }

  for (const row of db.prepare(`
    SELECT id, title, department, location, owner, headcount, status,
      source_system, source_record_id, external_code, category, professional_line,
      job_sequence, headcount_type, project_name, archived_at
    FROM positions
  `).all()) {
    addRecord({ id: row.id, planned: false, position: row, archived_at: row.archived_at })
  }

  const recordsFor = (index, keys) => {
    const records = new Set()
    for (const key of keys) {
      for (const record of index.get(key) ?? []) records.add(record)
    }
    return [...records]
  }

  const classify = (matches, strategy, incoming) => {
    if (matches.length === 0) return null
    if (matches.some((record) => record.archived_at)) {
      return {
        action: 'archived_conflict',
        reason: 'archived_position_match',
        strategy,
        match_count: matches.length,
        matched_position_ids: matches.filter((record) => record.id).map((record) => record.id)
      }
    }
    if (matches.length !== 1) {
      return {
        action: 'ambiguous',
        reason: 'ambiguous_position_match',
        strategy,
        match_count: matches.length,
        matched_position_ids: matches.filter((record) => record.id).map((record) => record.id)
      }
    }
    const [record] = matches
    if (record.planned) {
      mergePositionValues(record.position, incoming)
      addRecord(record)
    }
    return {
      action: record.planned ? 'create' : 'match',
      reason: record.planned ? 'same_planned_position' : `${strategy}_match`,
      strategy,
      record,
      plan_key: record.plan_key,
      position_id: record.id ?? null,
      position: record.planned ? record.position : incoming
    }
  }

  const createPlan = (position, strategy) => {
    const record = {
      id: null,
      planned: true,
      plan_key: `position-plan-${nextPlanId++}`,
      archived_at: null,
      position: { ...position, status: 'draft' }
    }
    addRecord(record)
    return {
      action: 'create',
      reason: 'no_existing_position',
      strategy,
      record,
      plan_key: record.plan_key,
      position_id: null,
      position: record.position
    }
  }

  const resolve = (position) => {
    if (!importPositionHasData(position)) return { action: 'none', reason: 'no_position_data', position: null }

    const stableIdsPresent = Boolean(position?.source_record_id || position?.external_code)
    const stableKeys = positionStableKeys(position)
    if (stableIdsPresent && stableKeys.length === 0) {
      return { action: 'invalid', reason: 'missing_position_source_system', position }
    }
    if (stableKeys.length) {
      const stableMatch = classify(recordsFor(stableIndex, stableKeys), 'stable_id', position)
      if (stableMatch) return stableMatch
      if (!positionTitleKey(position)) return { action: 'invalid', reason: 'missing_position_title', position }
      return createPlan(position, 'stable_id')
    }

    const title = positionTitleKey(position)
    const hasDepartment = Boolean(normalizePositionText(position?.department))
    const hasLocation = Boolean(normalizePositionText(position?.location))
    if (!title) return { action: 'invalid', reason: 'missing_position_title', position }
    if (hasDepartment !== hasLocation) {
      return { action: 'invalid', reason: 'incomplete_position_identity', position }
    }

    if (hasDepartment && hasLocation) {
      const tripleMatch = classify(recordsFor(tripleIndex, [positionTripleKey(position)]), 'title_department_location', position)
      if (tripleMatch) return tripleMatch
      return createPlan(position, 'title_department_location')
    }

    const titleMatch = classify(recordsFor(titleIndex, [title]), 'unique_title', position)
    if (titleMatch) return titleMatch
    return createPlan(position, 'unique_title')
  }

  const materialize = (resolution, { updateExisting = false } = {}) => {
    if (!resolution || !['create', 'match'].includes(resolution.action)) return null
    const record = resolution.record
    const position = resolution.position ?? record.position
    const timestamp = now()
    if (record.id) {
      if (record.planned || updateExisting) {
        const values = record.planned ? record.position : position
        db.prepare(`
          UPDATE positions SET
            title = COALESCE(?, title), department = COALESCE(?, department), location = COALESCE(?, location),
            owner = COALESCE(?, owner), headcount = COALESCE(?, headcount),
            source_system = COALESCE(source_system, ?), source_record_id = COALESCE(source_record_id, ?),
            external_code = COALESCE(external_code, ?), category = COALESCE(?, category),
            professional_line = COALESCE(?, professional_line), job_sequence = COALESCE(?, job_sequence),
            headcount_type = COALESCE(?, headcount_type), project_name = COALESCE(?, project_name), updated_at = ?
          WHERE id = ?
        `).run(
          values.title ?? null, values.department ?? null, values.location ?? null, values.owner ?? null,
          values.headcount ?? null, values.source_system ?? null, values.source_record_id ?? null,
          values.external_code ?? null, values.category ?? null, values.professional_line ?? null,
          values.job_sequence ?? null, values.headcount_type ?? null, values.project_name ?? null,
          timestamp, record.id
        )
      }
      return { id: record.id, created: false, position }
    }

    const id = randomUUID()
    db.prepare(`
      INSERT INTO positions(
        id, title, department, location, owner, headcount, status, description, tags,
        source_system, source_record_id, external_code, category, professional_line,
        job_sequence, headcount_type, project_name, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, position.title, position.department ?? null, position.location ?? null, position.owner ?? null,
      position.headcount ?? 1, position.source_system ?? null, position.source_record_id ?? null,
      position.external_code ?? null, position.category ?? null, position.professional_line ?? null,
      position.job_sequence ?? null, position.headcount_type ?? null, position.project_name ?? null,
      timestamp, timestamp
    )
    record.id = id
    return { id, created: true, position }
  }

  return { resolve, materialize }
}

function createApplicationOwnerLookup(db) {
  const owners = new Map()
  const add = (applicationId, candidateId) => {
    if (!applicationId || !candidateId) return
    const values = owners.get(applicationId) ?? new Set()
    values.add(candidateId)
    owners.set(applicationId, values)
  }
  for (const row of db.prepare(`
    SELECT source_application_id AS application_id, candidate_id
    FROM candidate_position_sources WHERE source_system = ?
    UNION ALL
    SELECT source_record_id AS application_id, candidate_id
    FROM candidate_assessments
    WHERE source_system = ? AND assessment_type = 'beisen_history'
  `).all(SOURCE_SYSTEM, SOURCE_SYSTEM)) add(row.application_id, row.candidate_id)
  return (applicationId) => {
    if (!applicationId) return new Set()
    return owners.get(applicationId) ?? new Set()
  }
}

function createCandidateIdentitySnapshot(db) {
  const source = new Map()
  const email = new Map()
  const phone = new Map()
  const add = (index, key, row) => {
    if (!key) return
    const values = index.get(key) ?? []
    values.push(row)
    index.set(key, values)
  }
  for (const row of db.prepare(`
    SELECT id, name, email, phone, source_system, source_record_id, archived_at
    FROM candidates
  `).all()) {
    if (row.source_system && row.source_record_id) add(source, `${row.source_system}\u0000${row.source_record_id}`, row)
    add(email, row.email, row)
    add(phone, row.phone, row)
  }
  const sourceCandidate = (sourceSystem, sourceRecordId) => (
    source.get(`${sourceSystem}\u0000${sourceRecordId}`)?.[0] ?? null
  )
  const duplicate = (candidate, excludeId = null) => {
    const matches = new Map()
    const addMatches = (rows, matchedBy) => {
      for (const row of rows ?? []) {
        if (excludeId && row.id === excludeId) continue
        const current = matches.get(row.id)
        if (current) current.matched_fields.push(matchedBy)
        else matches.set(row.id, { ...row, matched_fields: [matchedBy] })
      }
    }
    if (candidate.source_system && candidate.source_record_id) {
      addMatches(source.get(`${candidate.source_system}\u0000${candidate.source_record_id}`), 'source_record')
    }
    if (candidate.email) addMatches(email.get(candidate.email), 'email')
    if (candidate.phone) addMatches(phone.get(candidate.phone), 'phone')
    const values = [...matches.values()]
    if (values.length === 0) return null
    if (values.length > 1) return { identity_conflict: true, matched_by: 'identity_conflict', matches: values }
    return { ...values[0], matched_by: values[0].matched_fields[0] }
  }
  return { sourceCandidate, duplicate }
}

function hasApplicationIdentityConflict(ownerIds, candidateId) {
  return ownerIds.size > 0 && (!candidateId || ownerIds.size !== 1 || !ownerIds.has(candidateId))
}

function applicationIdentityError() {
  return {
    field: '申请ID',
    code: 'application_identity_conflict',
    message: '申请 ID 已属于另一候选人，需要人工复核'
  }
}

function archivedCandidateImportError() {
  return {
    field: 'candidate',
    code: 'candidate_archived',
    message: '已归档候选人不能通过导入更新或建立关系，请先恢复候选人'
  }
}

function importError(status, message, details, code = 'request_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

export function isBeisenTalentWorkbook(headers) {
  const available = new Set(headers)
  return available.has('应聘者ID')
}

function candidateFromValues(values, validStages) {
  const rawValues = {
    name: fieldValue(values, 'name', 200),
    phone: fieldValue(values, 'phone', 80),
    email: fieldValue(values, 'email', 320),
    photo_url: fieldValue(values, 'photo_url', 2049),
    current_company: fieldValue(values, 'current_company', 300),
    current_title: fieldValue(values, 'current_title', 300),
    location: fieldValue(values, 'location', 200),
    gender: fieldValue(values, 'gender', 40),
    birth_date: fieldValue(values, 'birth_date', 80),
    age: fieldValue(values, 'age', 20),
    years_experience: fieldValue(values, 'years_experience', 80),
    education: fieldValue(values, 'education', 200),
    highest_school: fieldValue(values, 'highest_school', 300),
    highest_major: fieldValue(values, 'highest_major', 300),
    job_seeking_status: fieldValue(values, 'job_seeking_status', 200),
    hire_position: fieldValue(values, 'hire_position', 301),
    // Keep one character beyond the API limit so sanitizeCandidateInput can reject,
    // rather than silently normalize, an overlong source status.
    hire_status: fieldValue(values, 'hire_status', 201),
    hire_date: rawFieldValue(values, 'hire_date'),
    resume_updated_at: fieldValue(values, 'resume_updated_at', 80),
    self_summary: fieldValue(values, 'self_summary', 20_000),
    source: fieldValue(values, 'effective_source', 200),
    tags: splitValues(fieldValue(values, 'tags', 10_000)),
    source_system: SOURCE_SYSTEM,
    source_record_id: fieldValue(values, 'candidate_id', 300)
  }
  const raw = Object.fromEntries(Object.entries(rawValues).filter(([, value]) => hasNonEmptyValue(value)))
  const { value, errors } = sanitizeCandidateInput(raw, {
    partial: true,
    validStages,
    fallbackHireStatus: true,
    allowExcelHireDateValues: true
  })
  delete value.stage
  return { candidate: value, errors }
}

function positionFromValues(values) {
  const dedicatedHeaderPresent = Object.prototype.hasOwnProperty.call(values, '最后职位类投递的职位id')
  const positionCode = associatedPositionKey(values)
  if (dedicatedHeaderPresent && !positionCode) {
    return {
      title: null,
      department: null,
      location: null,
      owner: null,
      headcount: null,
      status: 'draft',
      source_system: SOURCE_SYSTEM,
      source_record_id: null,
      external_code: null,
      category: null,
      professional_line: null,
      job_sequence: null,
      headcount_type: null,
      project_name: null
    }
  }
  const headcountText = fieldValue(values, 'headcount', 40)
  const match = headcountText?.match(/\d+/)
  return {
    // A standalone 职位编号 is only a stable lookup key. It must not become
    // a synthetic title for a new position; the resolver requires a title
    // unless an existing canonical position is matched.
    title: dedicatedHeaderPresent ? textValue(positionCode, 200) : fieldValue(values, 'position_title', 200),
    department: fieldValue(values, 'position_department', 200),
    location: fieldValue(values, 'position_location', 200),
    owner: fieldValue(values, 'position_owner', 200),
    headcount: match ? Math.min(10_000, Math.max(1, Number(match[0]))) : null,
    status: 'draft',
    source_system: SOURCE_SYSTEM,
    source_record_id: positionCode,
    external_code: positionCode,
    category: fieldValue(values, 'position_category', 300),
    professional_line: fieldValue(values, 'professional_line', 300),
    job_sequence: fieldValue(values, 'job_sequence', 300),
    headcount_type: fieldValue(values, 'headcount_type', 300),
    project_name: fieldValue(values, 'project_name', 300)
  }
}

function normalizeImportTimestamp(value) {
  if (value == null) return ''
  return String(value)
    .trim()
    .replace(/T/g, ' ')
    .replace(/\.\d{1,3}(?=Z$|[+-]\d{2}:?\d{2}$)/, '')
    .replace(/Z$/, '')
    .replace(/\s+/g, ' ')
}

function positionLabelMatches(sourceLabel, position) {
  const source = normalizePositionText(sourceLabel)
  if (!source) return false
  if (source === normalizePositionText(position?.external_code)
    || source === normalizePositionText(position?.source_record_id)) return true
  const title = normalizePositionText(position?.title)
  if (source === title) return true
  // Existing positions commonly append the stable code in parentheses, e.g.
  // "用研实习生(J10407)" while the Beisen export contains "用研实习生".
  return title.startsWith(`${source}(`) || title.startsWith(`${source}（`)
}

function addAssociatedPositionIndex(index, candidateSourceId, deliveryAt, record) {
  const candidateKey = stablePositionValue(candidateSourceId)
  const timestampKey = normalizeImportTimestamp(deliveryAt)
  if (!candidateKey || !timestampKey || !record?.id) return
  const key = `${candidateKey}\u0000${timestampKey}`
  const records = index.get(key) ?? []
  if (!records.some((item) => item.id === record.id)) records.push(record)
  index.set(key, records)
}

/**
 * Build a Beisen-specific lookup for the "最后职位类投递" column.
 *
 * The export calls the value a position ID, but many historical rows contain
 * only the display title. Candidate application history retains the exact
 * delivery timestamp and the canonical position code, so using both fields
 * lets us resolve duplicate titles without inventing a new draft position.
 */
function createBeisenAssociatedPositionIndex(db, candidateSourceIds = []) {
  const index = new Map()
  const ids = [...new Set(candidateSourceIds)].filter(Boolean)
  if (ids.length === 0) return index
  const baseQuery = `
    SELECT c.source_record_id AS candidate_source_id,
      cps.raw_payload, p.id, p.title, p.department, p.location, p.owner,
      p.headcount, p.source_system, p.source_record_id, p.external_code,
      p.category, p.professional_line, p.job_sequence, p.headcount_type,
      p.project_name, p.archived_at
    FROM candidates c
    JOIN candidate_position_sources cps ON cps.candidate_id = c.id
    JOIN positions p ON p.id = cps.position_id
    WHERE c.source_system = ? AND c.source_record_id IN (`
  // Keep the parameter list below SQLite's variable limit for large imports.
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500)
    for (const row of db.prepare(`${baseQuery}${chunk.map(() => '?').join(',')})`).all(SOURCE_SYSTEM, ...chunk)) {
      const payload = parseJsonObject(row.raw_payload)
      const deliveryAt = payload['最后投递时间'] ?? payload['最后职位类投递时间']
      addAssociatedPositionIndex(index, row.candidate_source_id, deliveryAt, row)
    }
  }
  return index
}

function resolveBeisenAssociatedPosition(index, candidateSourceId, positionKey, deliveryAt) {
  if (!index || !candidateSourceId || !positionKey || !deliveryAt) return null
  const key = `${stablePositionValue(candidateSourceId)}\u0000${normalizeImportTimestamp(deliveryAt)}`
  const matches = (index.get(key) ?? []).filter((position) => positionLabelMatches(positionKey, position))
  return matches.length === 1 ? matches[0] : null
}

function enrichBeisenPosition(position, associatedPosition) {
  if (!associatedPosition) return position
  return {
    ...position,
    title: associatedPosition.title || position.title,
    department: associatedPosition.department ?? position.department,
    location: associatedPosition.location ?? position.location,
    owner: associatedPosition.owner ?? position.owner,
    headcount: associatedPosition.headcount ?? position.headcount,
    source_system: associatedPosition.source_system || position.source_system,
    source_record_id: associatedPosition.source_record_id || associatedPosition.external_code || position.source_record_id,
    external_code: associatedPosition.external_code || associatedPosition.source_record_id || position.external_code,
    category: associatedPosition.category ?? position.category,
    professional_line: associatedPosition.professional_line ?? position.professional_line,
    job_sequence: associatedPosition.job_sequence ?? position.job_sequence,
    headcount_type: associatedPosition.headcount_type ?? position.headcount_type,
    project_name: associatedPosition.project_name ?? position.project_name
  }
}

function beisenPositionGroupKey(position, rowNumber) {
  const stableKeys = positionStableKeys(position)
  if (stableKeys.length) return `stable:${stableKeys.join('|')}`
  const tripleKey = positionTripleKey(position)
  if (tripleKey) return `triple:${tripleKey}`
  const titleKey = positionTitleKey(position)
  if (titleKey) return `title:${titleKey}`
  return `row:${rowNumber}`
}

function assignBeisenPositionResolutions(db, rows) {
  const resolver = createImportPositionResolver(db)
  const groups = new Map()
  for (const row of rows) {
    const previousResolution = row.position_resolution
    const hasBlockingPositionError = row.errors.some((error) => error.field === 'position')
    row.position_ready = false
    row.application_ready = false
    row.application_used = Boolean(
      row.source_application_id && Object.keys(row.assessment_payload).length > 0
    )
    row.existing_position_id = null
    row.position_resolution = hasBlockingPositionError && previousResolution
      ? previousResolution
      : { action: 'none', reason: 'no_position_data', position: null }
    if (row.errors.length || !importPositionHasData(row.position)) continue
    const key = beisenPositionGroupKey(row.position, row.row_number)
    let group = groups.get(key)
    if (!group) {
      group = { position: { ...row.position }, rows: [] }
      groups.set(key, group)
    } else {
      mergePositionValues(group.position, row.position)
    }
    group.rows.push(row)
  }

  for (const group of groups.values()) {
    const resolution = resolver.resolve(group.position)
    const resolutionError = importPositionError(resolution)
    for (const row of group.rows) {
      row.position = { ...group.position }
      row.position_resolution = resolution
      row.position_ready = ['create', 'match'].includes(resolution.action)
      row.existing_position_id = resolution.position_id ?? null
      row.application_ready = Boolean(row.source_application_id && row.position_ready)
      row.application_used = Boolean(
        row.source_application_id && (row.position_ready || Object.keys(row.assessment_payload).length > 0)
      )
      if (resolutionError) row.errors.push(resolutionError)
    }
  }
  return resolver
}

function publicImportPositionResolution(resolution) {
  if (!resolution) return null
  const { record, ...safe } = resolution
  return safe
}

function buildBeisenPositionPreview(rows) {
  const items = new Map()
  const links = new Set()
  let ambiguousCount = 0
  let invalidCount = 0
  let archivedConflictCount = 0

  for (const row of rows) {
    const resolution = row.position_resolution
    if (!resolution || resolution.action === 'none') continue
    if (row.errors.length > 0 && ['create', 'match'].includes(resolution.action)) continue
    if (resolution.action === 'ambiguous') ambiguousCount += 1
    if (resolution.action === 'invalid') invalidCount += 1
    if (resolution.action === 'archived_conflict') archivedConflictCount += 1
    const key = resolution.action === 'create'
      ? `create:${resolution.plan_key}`
      : resolution.action === 'match'
        ? `match:${resolution.position_id}`
        : `${resolution.action}:${row.row_number}`
    if (!items.has(key)) {
      items.set(key, {
        action: resolution.action,
        reason: resolution.reason,
        title: row.position?.title ?? null,
        external_code: row.position?.external_code ?? null,
        source_record_id: row.position?.source_record_id ?? null,
        source_system: row.position?.source_system ?? null,
        department: row.position?.department ?? null,
        location: row.position?.location ?? null,
        owner: row.position?.owner ?? null,
        ...(resolution.position_id ? { position_id: resolution.position_id } : {}),
        ...(resolution.match_count ? { match_count: resolution.match_count } : {}),
        row_numbers: []
      })
    }
    items.get(key).row_numbers.push(row.row_number)
    if (row.errors.length === 0 && ['create', 'match'].includes(resolution.action)) {
      const positionKey = resolution.action === 'create'
        ? `plan:${resolution.plan_key}`
        : `position:${resolution.position_id}`
      links.add(`${row.candidate_source_id}\u0000${positionKey}`)
    }
  }

  const values = [...items.values()]
  return {
    create_count: values.filter((item) => item.action === 'create').length,
    match_count: values.filter((item) => item.action === 'match').length,
    ambiguous_count: ambiguousCount,
    invalid_count: invalidCount,
    archived_conflict_count: archivedConflictCount,
    link_count: links.size,
    items: values.slice(0, 100)
  }
}

export function prepareBeisenPreview({ db, rows, headers, filename, sheetName, validStages, store }) {
  if (!isBeisenTalentWorkbook(headers)) throw importError(422, '北森人才库导入缺少应聘者ID列')
  const candidateIds = new Set()
  const applicationIds = new Set()
  const candidateSourceIds = rows
    .map(({ values }) => fieldValue(values, 'candidate_id', 300))
    .filter(Boolean)
  const associatedPositionIndex = createBeisenAssociatedPositionIndex(db, candidateSourceIds)
  const preparedRows = rows.map(({ row_number: rowNumber, values }) => {
    const candidateId = fieldValue(values, 'candidate_id', 300)
    const applicationId = fieldValue(values, 'application_id', 300)
    const positionCode = associatedPositionKey(values)
    const { candidate, errors: candidateErrors } = candidateFromValues(values, validStages)
    const positionKey = positionCode
    const lastDeliveryAt = fieldValue(values, 'last_position_delivery_at', 80)
    const position = enrichBeisenPosition(
      positionFromValues(values),
      resolveBeisenAssociatedPosition(associatedPositionIndex, candidateId, positionKey, lastDeliveryAt)
    )
    const errors = [...candidateErrors]
    if (!candidateId) errors.push({ field: '应聘者ID', code: 'missing_candidate_id', message: '缺少稳定候选人 ID' })
    if (candidateId) candidateIds.add(candidateId)
    return {
      row_number: rowNumber,
      candidate,
      candidate_source_id: candidateId,
      source_application_id: applicationId,
      position,
      position_ready: false,
      application_ready: false,
      application_used: false,
      existing_position_id: null,
      last_position_delivery_at: lastDeliveryAt,
      applied_at: fieldValue(values, 'applied_at', 80),
      pool_names: splitValues(fieldValues(values, 'talent_pool', 5_000)),
      sources: {
        effective: fieldValue(values, 'effective_source', 200),
        first: fieldValue(values, 'first_source', 200),
        last: fieldValue(values, 'last_source', 200)
      },
      profile_sections: [...PROFILE_FIELDS.entries()].flatMap(([header, sectionType]) => {
        const content = textValue(values[header], 100_000)
        return content ? [{ section_type: sectionType, title: header, content }] : []
      }),
      assessment_payload: subset(values, isAssessmentHeader),
      consent_payload: subset(values, (header) => /(授权|协议|同意)/.test(header)),
      raw_payload: values,
      errors,
      duplicate: null
    }
  })

  assignBeisenPositionResolutions(db, preparedRows)

  const seenApplications = new Map()
  for (const row of preparedRows) {
    if (row.errors.length) continue
    if (!row.application_used) continue
    if (seenApplications.has(row.source_application_id)) {
      row.duplicate = {
        type: 'file',
        matched_by: 'application_id',
        row_number: seenApplications.get(row.source_application_id)
      }
      row.errors.push({ field: '申请ID', code: 'duplicate_application_id', message: '文件内申请 ID 重复' })
      continue
    }
    seenApplications.set(row.source_application_id, row.row_number)
  }

  const candidateGroups = new Map()
  for (const row of preparedRows) {
    if (!row.candidate_source_id || row.errors.length) continue
    let group = candidateGroups.get(row.candidate_source_id)
    if (!group) {
      group = { candidate: {}, rows: [], existing: null }
      candidateGroups.set(row.candidate_source_id, group)
    }
    mergeCandidateValues(group.candidate, row.candidate)
    group.rows.push(row)
  }

  const candidateIdentity = createCandidateIdentitySnapshot(db)
  for (const [candidateSourceId, group] of candidateGroups) {
    group.candidate.source_system = SOURCE_SYSTEM
    group.candidate.source_record_id = candidateSourceId
    group.existing = candidateIdentity.sourceCandidate(SOURCE_SYSTEM, candidateSourceId)

    const groupErrors = []
    if (group.existing?.archived_at) groupErrors.push(archivedCandidateImportError())
    if (!group.existing && !group.candidate.name) {
      groupErrors.push({ field: '姓名', code: 'missing_identity', message: '新候选人必须提供姓名；已有应聘者ID可省略姓名进行增量更新' })
    }
    const identityConflict = candidateIdentity.duplicate(group.candidate, group.existing?.id ?? null)
    if (identityConflict) {
      groupErrors.push({ field: 'identity', code: 'identity_conflict', message: '手机或邮箱已属于另一候选人，需要人工复核' })
    }
    for (const row of group.rows) {
      row.candidate = { ...group.candidate }
      if (groupErrors.length) row.errors.push(...groupErrors)
    }
  }

  assignBeisenPositionResolutions(db, preparedRows)
  const applicationOwners = createApplicationOwnerLookup(db)
  for (const group of candidateGroups.values()) {
    if (!group.rows.some((row) => (
      row.errors.length === 0 && row.application_used &&
      hasApplicationIdentityConflict(applicationOwners(row.source_application_id), group.existing?.id)
    ))) continue
    for (const row of group.rows) {
      if (!row.errors.some((error) => error.code === 'application_identity_conflict')) {
        row.errors.push(applicationIdentityError())
      }
    }
  }
  assignBeisenPositionResolutions(db, preparedRows)
  for (const row of preparedRows) {
    if (row.errors.length === 0 && row.application_ready) applicationIds.add(row.source_application_id)
  }
  const positionPreview = buildBeisenPositionPreview(preparedRows)
  const summary = {
    total_rows: preparedRows.length,
    valid_rows: preparedRows.filter((row) => row.errors.length === 0).length,
    invalid_rows: preparedRows.filter((row) => row.errors.length > 0).length,
    existing_duplicates: [...candidateGroups.values()].filter((group) => group.existing).length,
    file_duplicates: preparedRows.filter((row) => row.duplicate?.type === 'file').length,
    candidate_records: candidateIds.size,
    application_records: applicationIds.size,
    position_records: positionPreview.create_count + positionPreview.match_count,
    missing_identity_rows: preparedRows.filter((row) => row.errors.some((error) => error.code === 'missing_identity')).length,
    missing_candidate_id_rows: preparedRows.filter((row) => row.errors.some((error) => error.code === 'missing_candidate_id')).length,
    missing_application_id_rows: preparedRows.filter((row) => !row.source_application_id).length,
    missing_position_id_rows: preparedRows.filter((row) => !row.position.external_code).length,
    skipped_application_rows: preparedRows.filter((row) => row.source_application_id && !row.application_ready).length,
    skipped_position_rows: preparedRows.filter((row) => (
      row.position.external_code || row.position.title
    ) && !row.position_ready).length
  }
  const stored = store.put({
    kind: 'beisen_talent',
    filename,
    sheetName,
    rows: preparedRows,
    summary
  })
  return {
    profile: 'beisen_talent',
    preview_token: stored.token,
    expires_at: new Date(stored.expiresAt).toISOString(),
    filename,
    sheet_name: sheetName,
    headers,
    mapping: {
      source_record_id: '应聘者ID',
      source_application_id: '申请ID',
      // In a Beisen talent export this column is the authoritative relation
      // key. A generic 职位编号 is only a fallback for files without it.
      position_external_code: headers.includes('最后职位类投递的职位id')
        ? '最后职位类投递的职位id'
        : (headers.includes('职位编号') ? '职位编号' : null)
    },
    unmapped_headers: [],
    summary,
    position_preview: positionPreview,
    rows: preparedRows.slice(0, 20).map(({ raw_payload, assessment_payload, consent_payload, ...row }) => {
      const { photo_url: photoUrl, ...candidate } = row.candidate
      return {
        ...row,
        candidate: { ...candidate, has_photo: Boolean(photoUrl) },
        position_resolution: publicImportPositionResolution(row.position_resolution)
      }
    }),
    preview_row_limit: 20
  }
}

function patchFromCandidate(candidate, batchId) {
  return Object.fromEntries(Object.entries({ ...candidate, import_batch_id: batchId }).filter(([field, value]) => (
    field !== 'stage' && value != null && value !== '' && (!Array.isArray(value) || value.length)
  )))
}

function upsertCandidateSource(db, candidateId, recordId, recordType, sourceName, rawPayload, timestamp) {
  const sourceRecordId = recordType === 'candidate' ? recordId : `${recordId}:${recordType}`
  const existing = db.prepare(`
    SELECT id, raw_payload FROM candidate_source_records
    WHERE source_system = ? AND source_record_id = ? AND record_type = ?
  `).get(SOURCE_SYSTEM, sourceRecordId, recordType)
  if (existing) {
    const mergedPayload = mergeNonEmptyPayload(parseJsonObject(existing.raw_payload), rawPayload)
    db.prepare(`
      UPDATE candidate_source_records SET
        candidate_id = ?, source_name = COALESCE(?, source_name), raw_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(candidateId, sourceName, jsonText(mergedPayload), timestamp, existing.id)
    return
  }
  db.prepare(`
    INSERT INTO candidate_source_records(
      id, candidate_id, source_system, source_record_id, record_type, source_name,
      source_timestamp, raw_payload, sensitivity, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'high', ?, ?)
  `).run(randomUUID(), candidateId, SOURCE_SYSTEM, sourceRecordId, recordType, sourceName, jsonText(rawPayload), timestamp, timestamp)
}

function upsertProfileSections(db, candidateId, candidateSourceId, sections, timestamp) {
  for (const section of sections) {
    const existing = db.prepare(`
      SELECT id FROM candidate_profile_sections
      WHERE candidate_id = ? AND source_record_id = ? AND section_type = ? AND title = ?
    `).get(candidateId, candidateSourceId, section.section_type, section.title)
    if (existing) {
      db.prepare(`UPDATE candidate_profile_sections SET content = ?, updated_at = ?, archived_at = NULL WHERE id = ?`)
        .run(section.content, timestamp, existing.id)
    } else {
      db.prepare(`
        INSERT INTO candidate_profile_sections(
          id, candidate_id, section_type, title, content, structured_data, sort_order,
          sensitivity, source_record_id, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, '{}', 0, 'internal', ?, ?, ?, NULL)
      `).run(randomUUID(), candidateId, section.section_type, section.title, section.content, candidateSourceId, timestamp, timestamp)
    }
  }
}

function upsertAssessment(db, candidateId, positionId, applicationId, payload, timestamp) {
  if (!applicationId || Object.keys(payload).length === 0) return
  const existing = db.prepare(`
    SELECT id, candidate_id, raw_payload FROM candidate_assessments
    WHERE source_system = ? AND source_record_id = ? AND assessment_type = 'beisen_history'
  `).get(SOURCE_SYSTEM, applicationId)
  if (existing) {
    if (existing.candidate_id !== candidateId) {
      throw importError(409, '申请 ID 已属于另一候选人，需要重新预览并人工复核', undefined, 'application_identity_conflict')
    }
    const mergedPayload = mergeNonEmptyPayload(parseJsonObject(existing.raw_payload), payload)
    db.prepare(`
      UPDATE candidate_assessments
      SET candidate_id = ?, position_id = COALESCE(?, position_id), raw_payload = ?, updated_at = ? WHERE id = ?
    `).run(candidateId, positionId, jsonText(mergedPayload), timestamp, existing.id)
  } else {
    db.prepare(`
      INSERT INTO candidate_assessments(
        id, candidate_id, position_id, assessment_type, title, status, score,
        conclusion, occurred_at, source_system, source_record_id, raw_payload,
        sensitivity, created_at, updated_at
      ) VALUES (?, ?, ?, 'beisen_history', '北森历史面试与测评', NULL, NULL, NULL, NULL, ?, ?, ?, 'high', ?, ?)
    `).run(randomUUID(), candidateId, positionId, SOURCE_SYSTEM, applicationId, jsonText(payload), timestamp, timestamp)
  }
}

function upsertConsent(db, candidateId, candidateSourceId, payload, timestamp) {
  if (Object.keys(payload).length === 0) return
  const existing = db.prepare(`
    SELECT id, raw_payload FROM candidate_consents
    WHERE source_system = ? AND source_record_id = ? AND consent_type = 'beisen_privacy'
  `).get(SOURCE_SYSTEM, candidateSourceId)
  if (existing) {
    const mergedPayload = mergeNonEmptyPayload(parseJsonObject(existing.raw_payload), payload)
    db.prepare('UPDATE candidate_consents SET candidate_id = ?, raw_payload = ?, updated_at = ? WHERE id = ?')
      .run(candidateId, jsonText(mergedPayload), timestamp, existing.id)
  } else {
    db.prepare(`
      INSERT INTO candidate_consents(
        id, candidate_id, consent_type, status, agreement_name, consented_at, expires_at,
        source_system, source_record_id, raw_payload, sensitivity, created_at, updated_at
      ) VALUES (?, ?, 'beisen_privacy', NULL, NULL, NULL, NULL, ?, ?, ?, 'high', ?, ?)
    `).run(randomUUID(), candidateId, SOURCE_SYSTEM, candidateSourceId, jsonText(payload), timestamp, timestamp)
  }
}

function upsertCandidatePositionSource(db, candidateId, positionId, row, timestamp) {
  const existing = db.prepare(`
    SELECT id, candidate_id, raw_payload FROM candidate_position_sources
    WHERE source_system = ? AND source_application_id = ?
  `).get(SOURCE_SYSTEM, row.source_application_id)
  if (existing) {
    if (existing.candidate_id !== candidateId) {
      throw importError(409, '申请 ID 已属于另一候选人，需要重新预览并人工复核', undefined, 'application_identity_conflict')
    }
    const mergedPayload = mergeNonEmptyPayload(parseJsonObject(existing.raw_payload), row.raw_payload)
    db.prepare(`
      UPDATE candidate_position_sources SET
        candidate_id = ?, position_id = ?, applied_at = COALESCE(?, applied_at),
        raw_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(candidateId, positionId, row.applied_at, jsonText(mergedPayload), timestamp, existing.id)
    return
  }
  db.prepare(`
    INSERT INTO candidate_position_sources(
      id, candidate_id, position_id, source_system, source_application_id,
      applied_at, raw_payload, sensitivity, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'high', ?, ?)
  `).run(
    randomUUID(), candidateId, positionId, SOURCE_SYSTEM, row.source_application_id,
    row.applied_at, jsonText(row.raw_payload), timestamp, timestamp
  )
}

export function commitBeisenImport({ db, preview, batchId, taskId = null, metrics = null }) {
  return withTransaction(db, () => {
    const timestamp = now()
    const summary = {
      imported_rows: 0,
      updated_rows: 0,
      skipped_rows: 0,
      failed_rows: 0,
      candidate_count: 0,
      application_count: 0,
      position_count: 0,
      positions_created: 0,
      positions_matched: 0,
      links_created: 0,
      pools_created: 0
    }
    const failures = []
    const candidatesBySource = new Map()
    const poolsByName = new Map()
    const processedCandidates = new Set()
    const processedApplications = new Set()
    const usedPositionIds = new Set()
    const createdPositionIds = new Set()
    const matchedPositionIds = new Set()
    const positionResolver = createImportPositionResolver(db)
    const positionResolutions = new Map()
    const positionFailures = new Map()
    const applicationOwners = createApplicationOwnerLookup(db)
    const existingCandidates = new Map()
    const applicationConflictCandidates = new Set()

    for (const row of preview.rows) {
      if (row.errors.length || !row.candidate_source_id) continue
      const positionResolution = positionResolver.resolve(row.position)
      positionResolutions.set(row.row_number, positionResolution)
      const positionFailure = importPositionError(positionResolution)
      if (positionFailure) {
        positionFailures.set(row.row_number, positionFailure)
        continue
      }
      const applicationUsed = Boolean(
        row.source_application_id && (
          ['create', 'match'].includes(positionResolution.action) || Object.keys(row.assessment_payload).length > 0
        )
      )
      if (!applicationUsed) continue
      if (!existingCandidates.has(row.candidate_source_id)) {
        existingCandidates.set(row.candidate_source_id, db.prepare(`
          SELECT id FROM candidates WHERE source_system = ? AND source_record_id = ?
        `).get(SOURCE_SYSTEM, row.candidate_source_id) ?? null)
      }
      const candidate = existingCandidates.get(row.candidate_source_id)
      if (hasApplicationIdentityConflict(applicationOwners(row.source_application_id), candidate?.id)) {
        applicationConflictCandidates.add(row.candidate_source_id)
      }
    }

    db.prepare(`
      INSERT INTO import_batches(
        id, filename, sheet_name, total_rows, imported_rows, updated_rows,
        skipped_rows, failed_rows, status, created_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'processing', ?)
    `).run(batchId, preview.filename, preview.sheetName, preview.rows.length, timestamp)

    for (const row of preview.rows) {
      if (row.errors.length) {
        summary.failed_rows += 1
        appendImportFailure(failures, { row_number: row.row_number, errors: row.errors })
        continue
      }
      if (positionFailures.has(row.row_number)) {
        summary.failed_rows += 1
        appendImportFailure(failures, { row_number: row.row_number, errors: [positionFailures.get(row.row_number)] })
        continue
      }
      if (applicationConflictCandidates.has(row.candidate_source_id)) {
        summary.failed_rows += 1
        appendImportFailure(failures, { row_number: row.row_number, errors: [applicationIdentityError()] })
        continue
      }

      let candidateId
      if (candidatesBySource.has(row.candidate_source_id)) {
        candidateId = candidatesBySource.get(row.candidate_source_id)
        if (!candidateId) {
          summary.failed_rows += 1
          appendImportFailure(failures, {
            row_number: row.row_number,
            errors: [{ field: 'identity', code: 'identity_conflict', message: '手机或邮箱已属于另一候选人，需要人工复核' }]
          })
          continue
        }
        summary.updated_rows += 1
      } else {
        const existing = db.prepare(`
          SELECT id, tags, hire_status, archived_at FROM candidates WHERE source_system = ? AND source_record_id = ?
        `).get(SOURCE_SYSTEM, row.candidate_source_id)
        const duplicate = findDuplicate(db, row.candidate, existing?.id ?? null)
        if (duplicate) {
          candidatesBySource.set(row.candidate_source_id, null)
          summary.failed_rows += 1
          appendImportFailure(failures, {
            row_number: row.row_number,
            errors: [{ field: 'identity', code: 'identity_conflict', message: '手机或邮箱已属于另一候选人，需要人工复核' }]
          })
          continue
        }

        if (existing?.archived_at) {
          summary.failed_rows += 1
          appendImportFailure(failures, { row_number: row.row_number, errors: [archivedCandidateImportError()] })
          continue
        }

        if (existing) {
          candidateId = existing.id
          const patch = patchFromCandidate(row.candidate, batchId)
          if (
            patch.hire_status === '不确定'
            && existing.hire_status
            && !sourceFieldHasValue(row.raw_payload, 'hire_status')
          ) delete patch.hire_status
          if (patch.tags) patch.tags = [...new Set([...parseJsonArray(existing.tags), ...patch.tags])].slice(0, 50)
          patchCandidate(db, candidateId, patch, {
            activityType: 'candidate_import_updated',
            activityMetadata: { import_batch_id: batchId, source_system: SOURCE_SYSTEM },
            hydrate: false
          })
          summary.updated_rows += 1
        } else {
          if (!row.candidate.name) {
            candidatesBySource.set(row.candidate_source_id, null)
            summary.failed_rows += 1
            appendImportFailure(failures, {
              row_number: row.row_number,
              errors: [{ field: '姓名', code: 'missing_identity', message: '新候选人必须提供姓名' }]
            })
            continue
          }
          candidateId = insertCandidate(db, { ...row.candidate, import_batch_id: batchId }, {
            activityType: 'candidate_imported',
            activityMetadata: { import_batch_id: batchId, source_system: SOURCE_SYSTEM },
            hydrate: false
          }).id
          summary.imported_rows += 1
        }
        candidatesBySource.set(row.candidate_source_id, candidateId)
      }
      processedCandidates.add(candidateId)

      let position = null
      const positionResolution = positionResolutions.get(row.row_number) ?? positionResolver.resolve(row.position)
      if (['create', 'match'].includes(positionResolution.action)) {
        position = positionResolver.materialize(positionResolution, { updateExisting: true })
        if (position) {
          usedPositionIds.add(position.id)
          if (position.created) createdPositionIds.add(position.id)
          else if (!createdPositionIds.has(position.id)) matchedPositionIds.add(position.id)
          const link = db.prepare(`
            INSERT OR IGNORE INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, ?, ?)
          `).run(candidateId, position.id, timestamp)
          if (link.changes) {
            summary.links_created += 1
            db.prepare(`
              INSERT INTO activities(id, candidate_id, type, description, metadata, created_at)
              VALUES (?, ?, 'position_linked', '北森导入关联职位', ?, ?)
            `).run(randomUUID(), candidateId, jsonText({ position_id: position.id, import_batch_id: batchId }), timestamp)
          }
        }
      }

      if (row.source_application_id && position) {
        if (processedApplications.has(row.source_application_id)) {
          summary.skipped_rows += 1
          continue
        }
        processedApplications.add(row.source_application_id)
        upsertCandidatePositionSource(db, candidateId, position.id, row, timestamp)
        summary.application_count += 1
      }

      upsertCandidateSource(db, candidateId, row.candidate_source_id, 'candidate', row.sources.effective, row.raw_payload, timestamp)
      for (const sourceType of ['effective', 'first', 'last']) {
        if (row.sources[sourceType]) {
          upsertCandidateSource(db, candidateId, row.candidate_source_id, `source_${sourceType}`, row.sources[sourceType], {
            source_name: row.sources[sourceType]
          }, timestamp)
        }
      }
      upsertProfileSections(db, candidateId, row.candidate_source_id, row.profile_sections, timestamp)
      upsertAssessment(db, candidateId, position?.id ?? null, row.source_application_id, row.assessment_payload, timestamp)
      upsertConsent(db, candidateId, row.candidate_source_id, row.consent_payload, timestamp)

      if (row.candidate.job_seeking_status || row.candidate.expected_salary) {
        db.prepare(`
          INSERT INTO candidate_preferences(
            candidate_id, employment_status, desired_titles, desired_locations,
            employment_type, expected_salary, availability, raw_payload, updated_at
          ) VALUES (?, ?, '[]', '[]', NULL, ?, NULL, '{}', ?)
          ON CONFLICT(candidate_id) DO UPDATE SET
            employment_status = COALESCE(excluded.employment_status, employment_status),
            expected_salary = COALESCE(excluded.expected_salary, expected_salary),
            updated_at = excluded.updated_at
        `).run(candidateId, row.candidate.job_seeking_status ?? null, row.candidate.expected_salary ?? null, timestamp)
      }

      for (const poolName of row.pool_names) {
        const key = poolName.toLocaleLowerCase('zh-CN')
        let poolId = poolsByName.get(key)
        if (!poolId) {
          const existingPool = db.prepare('SELECT id FROM talent_pools WHERE name = ? COLLATE NOCASE').get(poolName)
          if (existingPool) poolId = existingPool.id
          else {
            poolId = randomUUID()
            db.prepare(`
              INSERT INTO talent_pools(
                id, name, description, color, source_system, source_record_id,
                created_at, updated_at, archived_at
              ) VALUES (?, ?, NULL, '#2563eb', ?, ?, ?, ?, NULL)
            `).run(poolId, poolName, SOURCE_SYSTEM, poolName, timestamp, timestamp)
            summary.pools_created += 1
          }
          poolsByName.set(key, poolId)
        }
        db.prepare(`
          INSERT OR IGNORE INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at)
          VALUES (?, ?, ?)
        `).run(candidateId, poolId, timestamp)
      }
    }

    summary.candidate_count = processedCandidates.size
    summary.position_count = usedPositionIds.size
    summary.positions_created = createdPositionIds.size
    summary.positions_matched = matchedPositionIds.size
    db.prepare(`
      UPDATE import_batches SET imported_rows = ?, updated_rows = ?, skipped_rows = ?,
        failed_rows = ?, status = 'completed', completed_at = ? WHERE id = ?
    `).run(summary.imported_rows, summary.updated_rows, summary.skipped_rows, summary.failed_rows, now(), batchId)
    const output = {
      import_batch_id: batchId,
      profile: 'beisen_talent',
      ...summary,
      failures,
      ...failureDetailMetadata(summary.failed_rows, failures)
    }
    const queuedSearchRows = taskId
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count ?? 0)
      : 0
    const taskOutput = taskId
      ? {
          ...output,
          search_index: {
            status: queuedSearchRows > 0 ? 'pending' : 'ready',
            queued_rows: queuedSearchRows,
            processed_rows: 0,
            resumable: true
          }
        }
      : output
    if (metrics && taskId) metrics.search_index_queued_rows = queuedSearchRows
    if (taskId) {
      const completedAt = now()
      db.prepare(`
        UPDATE candidate_import_tasks SET
          status = 'committed', phase = 'committed', progress = 95,
          result_json = ?, error_json = NULL, metrics_json = ?, updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(JSON.stringify(taskOutput), JSON.stringify(metrics ?? {}), completedAt, taskId)
    }
    return taskOutput
  }, { synchronizeSearch: false })
}
