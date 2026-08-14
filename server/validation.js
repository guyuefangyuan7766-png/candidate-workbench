import { CANDIDATE_FIELDS } from './constants.js'

export const HEADER_ALIASES = Object.freeze({
  name: ['name', 'candidate name', 'applicant name', 'candidate_name', '姓名', '候选人姓名', '应聘者姓名'],
  phone: [
    'phone', 'mobile', 'mobile phone', 'telephone', 'phone number',
    '手机号', '手机号码', '移动电话', '电话', '联系电话'
  ],
  email: ['email', 'e-mail', 'email address', '邮箱', '电子邮箱', '邮箱地址'],
  photo_url: ['photo url', 'photo_url', 'avatar url', 'avatar_url', '证件照', '头像地址', '照片地址'],
  current_company: ['current company', 'current_company', 'company', 'employer', '当前公司', '目前公司', '现公司', '公司'],
  current_title: ['current title', 'current_title', 'title', 'position', '当前职位', '目前职位', '现职位', '职位', '职务'],
  location: ['location', 'city', 'region', '所在地', '城市', '地区', '工作地点'],
  gender: ['gender', 'sex', '性别'],
  birth_date: ['birth date', 'birth_date', 'birthday', 'date of birth', '出生日期', '生日'],
  age: ['age', '年龄'],
  years_experience: ['years experience', 'years_experience', 'experience years', 'experience', '工作年限', '工作经验', '经验年限', '年限'],
  education: ['education', 'degree', 'highest education', '学历', '最高学历'],
  highest_school: ['highest school', 'highest_school', '最高学历学校', '最高学历院校', '学校'],
  highest_major: ['highest major', 'highest_major', '最高学历专业', '专业'],
  job_seeking_status: ['job seeking status', 'job_seeking_status', '求职状态'],
  resume_updated_at: ['resume updated at', 'resume_updated_at', '简历更新时间'],
  self_summary: [
    'self summary', 'self_summary', 'summary',
    '自我评价', '个人评价', '自我概述', '自我总结', '个人总结'
  ],
  source: ['source', 'channel', 'candidate source', '来源', '渠道', '候选人来源'],
  stage: ['stage', 'status', 'pipeline stage', '阶段', '招聘阶段', '候选人状态', '状态'],
  owner: ['owner', 'recruiter', 'responsible', '负责人', '招聘负责人', '招聘顾问'],
  tags: [
    'tags', 'tag', 'labels', 'skills', 'technical skills',
    '标签', '人才标签', '技能', '专业技能', '核心技能', '技能清单',
    '技能/荣誉', '技能与荣誉', '荣誉', '荣誉证书', '证书/竞赛', '证书与竞赛'
  ],
  expected_salary: ['expected salary', 'expected_salary', 'salary expectation', 'salary', '期望薪资', '薪资要求'],
  source_system: ['source system', 'source_system', 'system', '来源系统', '源系统'],
  source_record_id: [
    'source record id',
    'source_record_id',
    'candidate id',
    'applicant id',
    'record id',
    '来源记录id',
    '源记录id',
    '候选人编号',
    '人才编号'
  ]
})

export const POSITION_IMPORT_FIELDS = [
  'position_title',
  'position_external_code',
  'position_department',
  'position_location',
  'position_owner',
  'position_source_system',
  'position_source_record_id'
]

const POSITION_HEADER_ALIASES = {
  position_title: [
    'position title', 'requisition title', 'recruiting position',
    '职位名称', '招聘职位', '应聘职位', '招聘岗位', '岗位名称'
  ],
  position_external_code: [
    'position code', 'job code', 'requisition code',
    '职位编号', '招聘职位编号', '岗位编号'
  ],
  position_department: [
    'position department', 'requisition department',
    '职位部门', '需求部门', '招聘部门'
  ],
  position_location: [
    'position location', 'requisition location',
    '职位工作地点', '职位地点', '招聘地点'
  ],
  position_owner: [
    'position owner', 'requisition owner',
    '职位负责人', '招聘负责人'
  ],
  position_source_system: [
    'position source system', 'position_source_system',
    '职位来源系统', '职位源系统'
  ],
  position_source_record_id: [
    'position source record id', 'position_source_record_id', 'position id', 'requisition id',
    '职位id', '招聘职位id', '岗位id'
  ]
}

const STAGE_ALIASES = new Map([
  ['new', '新候选人'],
  ['新候选人', '新候选人'],
  ['新建', '新候选人'],
  ['待处理', '新候选人'],
  ['screening', '筛选中'],
  ['初筛', '筛选中'],
  ['筛选', '筛选中'],
  ['筛选中', '筛选中'],
  ['interview', '面试中'],
  ['面试', '面试中'],
  ['面试中', '面试中'],
  ['offer', 'Offer'],
  ['发放offer', 'Offer'],
  ['已发offer', 'Offer'],
  ['hired', '已入职'],
  ['已录用', '已入职'],
  ['录用', '已入职'],
  ['已入职', '已入职'],
  ['rejected', '不合适'],
  ['已淘汰', '不合适'],
  ['淘汰', '不合适'],
  ['不合适', '不合适']
])

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—–./\\:：()（）\[\]【】]+/g, '')
}

const HEADER_LOOKUP = new Map()
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const alias of [field, ...aliases]) HEADER_LOOKUP.set(normalizeHeader(alias), field)
}

const POSITION_HEADER_LOOKUP = new Map()
for (const [field, aliases] of Object.entries(POSITION_HEADER_ALIASES)) {
  for (const alias of [field, ...aliases]) POSITION_HEADER_LOOKUP.set(normalizeHeader(alias), field)
}

function cleanString(value, maxLength = 1000) {
  if (value == null) return null
  const string = String(value).trim().replace(/\s+/g, ' ')
  if (!string) return null
  return string.slice(0, maxLength)
}

export function normalizePhotoUrl(value) {
  if (value == null) return null
  const photoUrl = String(value).trim()
  if (!photoUrl || photoUrl.length > 2048 || /\s/.test(photoUrl)) return null
  try {
    const parsed = new URL(photoUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null
    if (parsed.username || parsed.password) return null
    if (!/\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)) return null
    return photoUrl
  } catch {
    return null
  }
}

export function normalizeEmail(value) {
  const email = cleanString(value, 320)?.toLowerCase() ?? null
  if (!email) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export function normalizePhone(value) {
  const input = cleanString(value, 80)
  if (!input) return null

  let compact = input.replace(/(?:ext\.?|extension|转)\s*\d+$/i, '').trim()
  const hadPlus = compact.startsWith('+')
  const hadInternationalPrefix = compact.startsWith('00')
  let digits = compact.replace(/\D/g, '')
  if (hadInternationalPrefix) digits = digits.slice(2)
  if (/^1[3-9]\d{9}$/.test(digits)) return `+86${digits}`
  if (/^86(1[3-9]\d{9})$/.test(digits)) return `+${digits}`
  if (digits.length < 7 || digits.length > 15) return null
  return hadPlus || hadInternationalPrefix ? `+${digits}` : digits
}

function normalizeTags(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,，;；|\n]+/)
  return [...new Set(values.map((tag) => cleanString(tag, 80)).filter(Boolean))].slice(0, 50)
}

function normalizeYears(value) {
  if (value == null || value === '') return null
  const match = String(value).match(/\d+(?:\.\d+)?/)
  if (!match) return null
  const years = Number(match[0])
  return Number.isFinite(years) && years >= 0 && years <= 80 ? years : null
}

const GENDER_ALIASES = new Map([
  ['男', '男'], ['男性', '男'], ['male', '男'], ['m', '男'], ['man', '男'],
  ['女', '女'], ['女性', '女'], ['female', '女'], ['f', '女'], ['woman', '女'],
  ['其他', '其他'], ['非二元', '其他'], ['other', '其他'], ['nonbinary', '其他'], ['non-binary', '其他'],
  ['未说明', '未说明'], ['未知', '未说明'], ['不详', '未说明'], ['保密', '未说明'],
  ['unknown', '未说明'], ['unspecified', '未说明'], ['prefer not to say', '未说明']
])

export function normalizeGender(value) {
  const gender = cleanString(value, 40)
  if (!gender) return null
  return GENDER_ALIASES.get(gender.toLowerCase()) ?? null
}

export function normalizeBirthDate(value) {
  const input = cleanString(value, 80)
  if (!input) return null
  const match = input.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:[T\s].*)?$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
    date.getTime() > Date.now() || year < 1900
  ) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function normalizeAge(value) {
  if (value == null || value === '') return null
  const match = String(value).trim().match(/^(\d{1,3})(?:\s*岁)?$/)
  if (!match) return null
  const age = Number(match[1])
  return Number.isInteger(age) && age >= 0 && age <= 120 ? age : null
}

export function normalizeStage(value) {
  const stage = cleanString(value, 80)
  if (!stage) return null
  return STAGE_ALIASES.get(normalizeHeader(stage)) ?? stage.toLowerCase()
}

export function sanitizeCandidateInput(input, { partial = false, validStages = [] } = {}) {
  const errors = []
  const value = {}
  const has = (field) => Object.prototype.hasOwnProperty.call(input ?? {}, field)

  if (!partial || has('name')) {
    value.name = cleanString(input?.name, 200)
    if (!value.name) errors.push({ field: 'name', message: '姓名不能为空' })
  }

  if (!partial || has('email')) {
    value.email = normalizeEmail(input?.email)
    if (cleanString(input?.email) && !value.email) errors.push({ field: 'email', message: '邮箱格式无效' })
  }

  if (!partial || has('phone')) {
    value.phone = normalizePhone(input?.phone)
    if (cleanString(input?.phone) && !value.phone) errors.push({ field: 'phone', message: '手机号或电话号码格式无效' })
  }

  if (!partial || has('photo_url')) {
    value.photo_url = normalizePhotoUrl(input?.photo_url)
    if (input?.photo_url != null && String(input.photo_url).trim() && !value.photo_url) {
      errors.push({ field: 'photo_url', message: '证件照地址必须是有效的 HTTP 或 HTTPS JPG、PNG 或 WebP 地址，且不超过 2048 个字符' })
    }
  }

  const stringLimits = {
    current_company: 300,
    current_title: 300,
    location: 200,
    education: 200,
    highest_school: 300,
    highest_major: 300,
    job_seeking_status: 200,
    resume_updated_at: 80,
    self_summary: 20_000,
    source: 200,
    owner: 200,
    expected_salary: 200,
    source_system: 120,
    source_record_id: 300,
    import_batch_id: 120
  }
  for (const [field, limit] of Object.entries(stringLimits)) {
    if (!partial || has(field)) value[field] = cleanString(input?.[field], limit)
  }

  if (!partial || has('years_experience')) {
    value.years_experience = normalizeYears(input?.years_experience)
    if (input?.years_experience != null && input.years_experience !== '' && value.years_experience == null) {
      errors.push({ field: 'years_experience', message: '工作年限必须是 0 至 80 之间的数字' })
    }
  }

  if (!partial || has('gender')) {
    value.gender = normalizeGender(input?.gender)
    if (cleanString(input?.gender) && !value.gender) {
      errors.push({ field: 'gender', message: '性别仅支持男、女、其他或未说明' })
    }
  }

  if (!partial || has('birth_date')) {
    value.birth_date = normalizeBirthDate(input?.birth_date)
    if (cleanString(input?.birth_date) && !value.birth_date) {
      errors.push({ field: 'birth_date', message: '出生日期必须是有效且不晚于今天的日期' })
    }
  }

  if (!partial || has('age')) {
    value.age = normalizeAge(input?.age)
    if (input?.age != null && input.age !== '' && value.age == null) {
      errors.push({ field: 'age', message: '年龄必须是 0 至 120 之间的整数' })
    }
  }

  if (!partial || has('tags')) value.tags = normalizeTags(input?.tags)

  if (!partial || has('stage')) {
    value.stage = normalizeStage(input?.stage) ?? '新候选人'
    if (validStages.length > 0 && !validStages.includes(value.stage)) {
      errors.push({ field: 'stage', message: `未知招聘阶段：${value.stage}` })
    }
  }

  return { value, errors }
}

export function buildHeaderMapping(headers, override = {}) {
  const mapped = {}
  const positionMapped = {}
  const usedHeaders = new Set()
  const available = new Map(headers.map((header) => [normalizeHeader(header), header]))

  for (const [field, header] of Object.entries(override ?? {})) {
    const isCandidateField = CANDIDATE_FIELDS.includes(field) && field !== 'import_batch_id'
    const isPositionField = POSITION_IMPORT_FIELDS.includes(field)
    if (!isCandidateField && !isPositionField) continue
    const actual = available.get(normalizeHeader(header))
    if (actual && !usedHeaders.has(actual)) {
      if (isPositionField) positionMapped[field] = actual
      else mapped[field] = actual
      usedHeaders.add(actual)
    }
  }

  for (const header of headers) {
    if (usedHeaders.has(header)) continue
    const field = HEADER_LOOKUP.get(normalizeHeader(header))
    if (field && !['import_batch_id', 'stage'].includes(field) && !mapped[field]) {
      mapped[field] = header
      usedHeaders.add(header)
    }
  }

  for (const header of headers) {
    if (usedHeaders.has(header)) continue
    const field = POSITION_HEADER_LOOKUP.get(normalizeHeader(header))
    if (field && !positionMapped[field]) {
      positionMapped[field] = header
      usedHeaders.add(header)
    }
  }
  if (!positionMapped.position_owner && Object.keys(positionMapped).some((field) => field !== 'position_owner')) {
    const sharedOwnerHeader = available.get(normalizeHeader('招聘负责人'))
    if (sharedOwnerHeader) positionMapped.position_owner = sharedOwnerHeader
  }

  return {
    mapping: mapped,
    position_mapping: positionMapped,
    unmapped_headers: headers.filter((header) => !usedHeaders.has(header))
  }
}

export function mapImportedRow(row, mapping, defaults = {}) {
  const candidate = {}
  for (const [field, header] of Object.entries(mapping)) candidate[field] = row[header]
  if (!candidate.source_system && defaults.source_system) candidate.source_system = defaults.source_system
  if (!candidate.source && defaults.source) candidate.source = defaults.source
  if (!candidate.owner && defaults.owner) candidate.owner = defaults.owner
  if (!candidate.stage && defaults.stage) candidate.stage = defaults.stage
  return candidate
}

export function mapImportedPosition(row, mapping, defaults = {}, candidate = {}) {
  const raw = {}
  for (const [field, header] of Object.entries(mapping ?? {})) raw[field] = row[header]

  const title = cleanString(raw.position_title, 200)
  const externalCode = cleanString(raw.position_external_code, 300)
  const sourceRecordId = cleanString(raw.position_source_record_id, 300)
  const department = cleanString(raw.position_department, 200)
  const location = cleanString(raw.position_location, 200)
  const owner = cleanString(raw.position_owner, 200)
  const hasPositionData = Boolean(title || externalCode || sourceRecordId || department || location || owner)
  if (!hasPositionData) return null

  return {
    title,
    external_code: externalCode,
    source_record_id: sourceRecordId,
    source_system: cleanString(
      raw.position_source_system || defaults.position_source_system || candidate.source_system || defaults.source_system || 'excel_import',
      120
    ),
    department,
    location,
    owner,
    headcount: 1,
    status: 'draft'
  }
}

export function changedFields(before, after) {
  const changed = []
  for (const field of CANDIDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(after, field)) continue
    const left = field === 'tags' ? JSON.stringify(before[field] ?? []) : before[field] ?? null
    const right = field === 'tags' ? JSON.stringify(after[field] ?? []) : after[field] ?? null
    if (left !== right) changed.push(field)
  }
  return changed
}
