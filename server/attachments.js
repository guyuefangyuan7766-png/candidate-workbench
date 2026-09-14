import {
  copyFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { lstat, readFile as readFileAsync } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { CANDIDATE_FIELDS } from './constants.js'
import { addActivity, now } from './database.js'
import { findDuplicate, getCandidate, insertCandidate } from './candidates.js'
import { synchronizeBusinessSearch } from './business-search.js'
import {
  extractDocxAvatarSuggestion,
  extractExplicitAvatarSuggestion,
  extractExplicitAvatarSensitiveValues,
  extractPdfAvatarSuggestion,
  extractXlsxAvatarSuggestions,
  hydrateAttachmentAvatarTransfer,
  materializePrivateAttachmentAvatar,
  projectAttachmentAvatarSuggestion,
  releaseAttachmentAvatarTransfer,
  releasePrivateAttachmentAvatar,
  sanitizeMaterializedAttachmentAvatar
} from './attachment-avatar.js'
import { parseAttachment, sanitizeOriginalFilename, validateAttachmentFile } from './attachment-parser.js'
import {
  HEADER_ALIASES,
  buildHeaderMapping,
  mapImportedRow,
  normalizeEmail,
  normalizePhone,
  sanitizeCandidateInput
} from './validation.js'

const PARSER_VERSION = 'local-resume-parser-v3'
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000
const DEFAULT_PARSE_CONCURRENCY = 2
const MAX_CONFIRM_RECORDS = 1000
const MAX_PROFILE_SECTIONS = 100
// Keep the wrapper aligned with the text adapter's bounded gateway request.
// Model suggestions remain optional, but a slow valid response must not be
// cut off by a shorter service-level race.
const ATTACHMENT_SUGGESTION_TIMEOUT_MS = 60_000
const ATTACHMENT_VISUAL_SUGGESTION_TIMEOUT_MS = 60_000
const ATTACHMENT_AVATAR_URL_PREFIX = 'attachment-avatar:'
const PARSE_FAILURE_MESSAGES = Object.freeze({
  attachment_empty: '附件中没有可确认的候选人记录',
  attachment_parse_failed: '附件内容提取失败，请确认文件完整且格式正确后重试',
  attachment_record_limit: `附件中的候选人记录超过 ${MAX_CONFIRM_RECORDS} 条限制`,
  attachment_staging_invalid: '附件隔离文件缺失或校验失败，请重新上传',
  docx_no_text: 'DOCX 中没有可提取的简历文本',
  docx_parse_failed: 'DOCX 已损坏、加密或无法提取文本',
  encrypted_office_unsupported: '不支持加密或带密码的 Office 文件',
  encrypted_pdf_unsupported: '不支持加密或带密码的 PDF',
  invalid_csv_encoding: 'CSV 必须使用有效的 UTF-8 编码',
  invalid_text_encoding: 'TXT 必须使用有效的 UTF-8 编码',
  invalid_office_package: 'Office 文件结构不完整或已损坏',
  invalid_zip: 'Office 文件结构不完整或已损坏',
  multipart_zip_unsupported: '不支持跨卷或分段 Office 文件',
  office_encrypted_or_invalid: '工作簿已加密、损坏或格式不正确',
  parse_interrupted: '附件解析因服务重启而中断，请重新上传',
  parse_timeout: '附件解析超时，请重试；若持续失败，请简化或拆分文件',
  parser_unavailable: '附件解析服务暂时不可用，请稍后重试',
  pdf_page_limit: 'PDF 页数超过解析限制',
  pdf_no_text: 'PDF 中没有可提取文本；扫描件和需要 OCR 的文件暂不支持',
  pdf_parse_failed: 'PDF 已损坏或无法提取文本',
  signature_mismatch: '文件内容与扩展名不匹配或文件已损坏',
  spreadsheet_column_limit: '工作表列数超过解析限制',
  spreadsheet_empty: '工作表中没有可读取的候选人数据',
  spreadsheet_row_limit: '工作表行数超过解析限制',
  unsupported_attachment_type: '不支持该附件格式',
  worksheet_limit: '工作簿中的工作表数量超过解析限制',
  xls_encrypted_or_invalid: '无法读取该 .xls；仅支持未加密的 Excel 97-2003 BIFF8 工作簿',
  xls_parse_failed: '解析 .xls 时发生错误',
  zip64_unsupported: '不支持 ZIP64 Office 文件，请缩小文件后重试',
  zip_compression_unsupported: 'Office 文件使用了不支持的压缩方式',
  zip_crc_mismatch: 'Office 文件内部 CRC 校验失败，文件可能已损坏',
  zip_duplicate_path: 'Office 文件包含重复的内部路径',
  zip_entry_limit: 'Office 文件内部条目数量超过解析限制',
  zip_entry_too_large: 'Office 文件包含超过解析限制的内容',
  zip_ratio_limit: 'Office 文件压缩比异常，已阻止解析',
  zip_size_mismatch: 'Office 文件内部大小校验失败，文件可能已损坏',
  zip_uncompressed_limit: 'Office 文件解压后超过 64MB 限制',
  unsafe_zip_path: 'Office 文件包含不安全的内部路径'
})
const RETRYABLE_PARSE_FAILURES = new Set([
  'attachment_parse_failed',
  'parse_interrupted',
  'parse_timeout',
  'parser_unavailable'
])
const ATTACHMENT_SUGGESTION_ERROR_CODES = new Set([
  'attachment_suggestion_not_configured',
  'attachment_suggestion_endpoint_invalid',
  'attachment_suggestion_endpoint_insecure',
  'attachment_suggestion_aborted',
  'attachment_suggestion_timeout',
  'attachment_suggestion_network_error',
  'attachment_suggestion_http_error',
  'attachment_suggestion_response_too_large',
  'attachment_suggestion_invalid_outer_json',
  'attachment_suggestion_invalid_inner_json',
  'attachment_suggestion_invalid_schema',
  'attachment_suggestion_unavailable'
])
const RETRYABLE_ATTACHMENT_SUGGESTION_ERRORS = new Set([
  'attachment_suggestion_aborted',
  'attachment_suggestion_timeout',
  'attachment_suggestion_network_error',
  'attachment_suggestion_response_too_large',
  'attachment_suggestion_unavailable'
])
const ATTACHMENT_VISUAL_ERROR_CODES = new Set([
  'visual_capability_disabled',
  'visual_capability_unknown',
  'visual_configuration_invalid',
  'visual_endpoint_invalid',
  'visual_endpoint_insecure',
  'visual_endpoint_blocked',
  'visual_endpoint_unapproved',
  'visual_endpoint_unavailable',
  'visual_unavailable',
  'visual_aborted',
  'visual_timeout',
  'visual_http_error',
  'visual_response_too_large',
  'visual_invalid_json',
  'visual_invalid_schema',
  'visual_pages_unavailable'
])
const RETRYABLE_ATTACHMENT_VISUAL_ERRORS = new Set([
  'visual_unavailable',
  'visual_aborted',
  'visual_timeout',
  'visual_http_error',
  'visual_response_too_large',
  'visual_endpoint_unavailable',
  'pdf_visual_render_timeout'
])
const ALLOWED_UPDATE_FIELDS = new Set([
  'name', 'phone', 'email', 'gender', 'birth_date', 'age',
  'current_company', 'current_title', 'location',
  'years_experience', 'years_experience_raw', 'education', 'highest_school', 'highest_major',
  'job_seeking_status', 'resume_updated_at', 'self_summary', 'source', 'owner',
  'tags', 'expected_salary', 'desired_titles', 'desired_locations',
  'employment_type', 'availability'
])
// These values live in candidate_preferences rather than candidates.  Keep
// them in the same suggestion contract so attachment confirmation cannot drop
// fields that the ordinary candidate form can edit.
const PREFERENCE_ONLY_FIELDS = new Set(['desired_locations', 'employment_type', 'availability'])
const FIELD_LIMITS = Object.freeze({
  name: 200,
  phone: 80,
  email: 320,
  gender: 40,
  birth_date: 80,
  age: 10,
  current_company: 300,
  current_title: 300,
  location: 200,
  years_experience: 1_000,
  education: 200,
  highest_school: 300,
  highest_major: 300,
  job_seeking_status: 200,
  resume_updated_at: 80,
  self_summary: 20_000,
  source: 200,
  owner: 200,
  expected_salary: 200,
  desired_titles: 4_000,
  desired_locations: 4_000,
  employment_type: 200,
  availability: 200
})
const ATTACHMENT_PREFERENCE_FIELD_ALIASES = Object.freeze({
  desired_titles: [
    'desired titles', 'desired_titles', 'intent position', 'desired position', 'target position',
    '意向岗位', '求职意向', '目标岗位', '应聘岗位', '期望职位', '期望岗位'
  ],
  desired_locations: [
    'desired locations', 'desired_locations', 'desired location', 'target location',
    '意向地点', '意向城市', '期望地点', '期望城市', '期望工作地点', '目标地点'
  ],
  employment_type: [
    'employment type', 'employment_type', 'work type', '工作性质', '雇佣类型', '就业类型'
  ],
  availability: [
    'availability', 'available date', 'available from',
    '到岗时间', '可入职时间', '期望到岗时间', '预计到岗时间'
  ]
})
const ATTACHMENT_FIELD_ALIASES = Object.freeze({
  highest_school: ['学校名称', '院校名称', '毕业院校', '毕业学校'],
  highest_major: ['专业名称', '所学专业'],
  current_company: ['现任公司', '当前任职公司'],
  current_title: ['现任职位', '当前任职职位'],
  job_seeking_status: [
    '当前求职状态', '在职状态', 'employment status', 'employment_status',
    'job status', 'job_status', '求职状态', '求职意向状态'
  ]
})
// The talent/profile API accepts canonical section types.  Historical parser
// aliases remain accepted as input and are normalized before persistence.
const RESUME_SECTION_DEFINITIONS = Object.freeze([
  Object.freeze({
    section_type: 'experience',
    title: '工作经历',
    aliases: ['工作经历', '工作经验', '职业经历', '任职经历', '工作履历', 'work experience', 'employment history', 'professional experience', 'experience']
  }),
  Object.freeze({
    section_type: 'project',
    title: '项目经历',
    aliases: ['项目经历', '项目经验', '项目实践', '项目履历', 'projects', 'project experience', 'project']
  }),
  Object.freeze({
    section_type: 'education',
    title: '教育经历',
    aliases: ['教育经历', '教育背景', '学历经历', '学习经历', '教育履历', 'education']
  }),
  Object.freeze({
    section_type: 'internship',
    title: '实习经历',
    aliases: ['实习经历', '实习经验', '实习履历', '实习', 'internship', 'intern experience']
  }),
  // self_summary is a scalar candidate field. The marker remains available to
  // scalar extraction and section-boundary detection, but never becomes a
  // public or persisted profile section.
  Object.freeze({
    section_type: 'self_summary',
    title: '自我评价',
    aliases: ['自我评价', '个人评价', '自我概述', '自我总结', '个人总结', 'self summary', 'summary']
  }),
  Object.freeze({
    section_type: 'skill',
    title: '技能',
    aliases: [
      '技能/荣誉', '技能与荣誉', '技能及荣誉', '专业技能', '技能清单', '核心技能', '技能',
      '相关技能', '技能证书', '技能与证书', '技能及证书', '技能/证书', '技能证书及荣誉',
      '荣誉证书', '证书/竞赛', '证书与竞赛', '证书及竞赛', '荣誉', '获奖经历',
      'skills', 'technical skills', 'skills and certificates', 'skills/certificates',
      'skills certificates', 'honors', 'awards', 'certificates', 'skill'
    ]
  }),
  Object.freeze({
    section_type: 'language',
    title: '语言能力',
    aliases: ['语言能力', '语言技能', '语言水平', '外语能力', '语言', 'language skills', 'languages', 'language']
  }),
  Object.freeze({
    section_type: 'campus',
    title: '校园经历',
    aliases: ['校园经历', '校园实践', '校内经历', '在校经历', 'campus experience', 'campus']
  }),
  Object.freeze({
    section_type: 'certificate',
    title: '证书',
    aliases: ['证书', '资格证书', 'certificate']
  }),
  Object.freeze({
    section_type: 'award',
    title: '奖励与荣誉',
    aliases: ['奖励与荣誉', '荣誉奖励', '获奖情况', 'award']
  }),
  Object.freeze({
    section_type: 'training',
    title: '培训经历',
    aliases: ['培训经历', '培训', 'training']
  }),
  Object.freeze({
    section_type: 'publication',
    title: '论文与作品',
    aliases: ['论文与作品', '论文与专利', '发表文章及专利', '发表论文及专利', '论文', '作品', 'publication', 'publications']
  }),
  Object.freeze({
    section_type: 'management',
    title: '管理经历',
    aliases: ['管理经历', '管理经验', 'management experience', 'management']
  }),
  Object.freeze({
    section_type: 'other',
    title: '附加信息',
    aliases: ['附加信息', '附加资料', '补充信息', '补充资料', '其他信息', '其他经历', 'additional information', 'additional info', 'other']
  })
])

const BOUNDARY_ONLY_LABELS = Object.freeze([
  '政治面貌', '民族', '籍贯', '婚姻状况'
])

const SECTION_TYPE_FAMILIES = Object.freeze({
  experience: new Set(['experience', 'work_experience']),
  project: new Set(['project', 'project_experience']),
  education: new Set(['education', 'education_experience']),
  internship: new Set(['internship']),
  skill: new Set(['skill', 'skills']),
  language: new Set(['language']),
  campus: new Set(['campus']),
  certificate: new Set(['certificate']),
  award: new Set(['award']),
  training: new Set(['training']),
  publication: new Set(['publication']),
  management: new Set(['management']),
  // self_summary/resume_summary are scalar legacy semantics and must never be
  // archived as a side effect of replacing an `other` (附加信息) section.
  other: new Set(['other'])
})

const SECTION_DEFINITION_BY_TYPE = new Map()
for (const definition of RESUME_SECTION_DEFINITIONS) {
  SECTION_DEFINITION_BY_TYPE.set(definition.section_type, definition)
  for (const alias of definition.aliases) {
    SECTION_DEFINITION_BY_TYPE.set(alias, definition)
    SECTION_DEFINITION_BY_TYPE.set(normalizeLabel(alias), definition)
  }
}

const SECTION_TYPE_ALIASES = Object.freeze({
  work_experience: 'experience',
  project_experience: 'project',
  education_experience: 'education',
  skills: 'skill',
  self_summary: 'other',
  resume_summary: 'other',
  additional: 'other',
  additional_information: 'other'
})
const CANONICAL_PROFILE_SECTION_TYPES = new Set([
  'education', 'experience', 'project', 'internship', 'skill', 'campus',
  'language', 'certificate', 'award', 'training', 'publication', 'management', 'other'
])

function canonicalSectionType(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (Object.prototype.hasOwnProperty.call(SECTION_TYPE_ALIASES, raw)) return SECTION_TYPE_ALIASES[raw]
  const definition = SECTION_DEFINITION_BY_TYPE.get(raw) ?? SECTION_DEFINITION_BY_TYPE.get(normalizeLabel(raw))
  return definition?.section_type ?? raw
}

function attachmentError(status, code, message, details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function publicParseFailure(error) {
  const requestedCode = typeof error?.code === 'string' ? error.code : ''
  const code = Object.prototype.hasOwnProperty.call(PARSE_FAILURE_MESSAGES, requestedCode)
    ? requestedCode
    : 'attachment_parse_failed'
  return {
    code,
    message: PARSE_FAILURE_MESSAGES[code],
    retryable: RETRYABLE_PARSE_FAILURES.has(code)
  }
}

function safeAttachmentSuggestionErrorCode(value) {
  const code = String(value ?? '')
  return ATTACHMENT_SUGGESTION_ERROR_CODES.has(code) ? code : 'attachment_suggestion_unavailable'
}

function attachmentSuggestionPipelineState(result, error) {
  if (result?.__attachment_timeout === true) {
    return {
      status: 'fallback',
      error_code: 'attachment_suggestion_timeout',
      retryable: true
    }
  }
  if (result?.status === 'ready' || Array.isArray(result?.records) && result?.status == null) {
    return {
      status: 'ready',
      ...(result?.schema_mode ? { schema_mode: String(result.schema_mode) === 'compat' ? 'compat' : String(result.schema_mode) === 'strict' ? 'strict' : 'unknown' } : { schema_mode: 'unknown' }),
      retryable: false
    }
  }
  if (result?.status === 'fallback') {
    const errorCode = safeAttachmentSuggestionErrorCode(result.error_code)
    return {
      status: 'fallback',
      error_code: errorCode,
      retryable: result.retryable === true || RETRYABLE_ATTACHMENT_SUGGESTION_ERRORS.has(errorCode),
      ...(result.schema_mode ? { schema_mode: String(result.schema_mode) === 'compat' ? 'compat' : String(result.schema_mode) === 'strict' ? 'strict' : 'unknown' } : {})
    }
  }
  if (error) {
    const errorCode = safeAttachmentSuggestionErrorCode(error.code)
    return {
      status: 'fallback',
      error_code: errorCode,
      retryable: error.retryable === true || RETRYABLE_ATTACHMENT_SUGGESTION_ERRORS.has(errorCode),
      ...(error.schema_mode ? { schema_mode: String(error.schema_mode) === 'compat' ? 'compat' : String(error.schema_mode) === 'strict' ? 'strict' : 'unknown' } : {})
    }
  }
  return {
    status: 'fallback',
    error_code: 'attachment_suggestion_unavailable',
    retryable: true
  }
}

function safeAttachmentVisualErrorCode(value) {
  const code = String(value ?? '')
  // PDF rendering errors are produced by the isolated parser and are already
  // stable, bounded identifiers. Keep only the known visual namespace here so
  // an injected provider cannot copy arbitrary exception text into the API.
  if (ATTACHMENT_VISUAL_ERROR_CODES.has(code) || [
    'pdf_visual_renderer_unavailable',
    'pdf_visual_render_timeout',
    'pdf_visual_dimensions_invalid',
    'pdf_visual_pixel_limit',
    'pdf_visual_total_pixel_limit',
    'pdf_visual_total_memory_limit',
    'pdf_visual_png_limit',
    'pdf_visual_total_png_limit',
    'pdf_visual_page_limit',
    'pdf_visual_render_failed'
  ].includes(code)) return code
  return 'visual_unavailable'
}

function safeAttachmentSchemaMode(value) {
  return value === 'compat' || value === 'strict' ? value : 'unknown'
}

function attachmentVisualPipelineState(result, error) {
  const candidate = result && typeof result === 'object' ? result : error
  // A provider may only claim readiness when it returned the contract's
  // records array.  Treat a bare `status: ready` as a schema failure instead
  // of allowing a false visual success to reach the preview UI.
  if (candidate?.status === 'ready' && !Array.isArray(candidate?.records)) {
    return {
      status: 'fallback',
      error_code: 'visual_invalid_schema',
      retryable: false,
      ...(candidate?.schema_mode === 'compat' || candidate?.schema_mode === 'strict'
        ? { schema_mode: candidate.schema_mode }
        : {})
    }
  }
  if ((candidate?.status === 'ready' && Array.isArray(candidate?.records)) ||
      (Array.isArray(candidate?.records) && candidate?.status == null)) {
    return {
      status: 'ready',
      schema_mode: safeAttachmentSchemaMode(candidate?.schema_mode),
      retryable: false
    }
  }
  const errorCode = safeAttachmentVisualErrorCode(candidate?.error_code ?? candidate?.code)
  return {
    status: 'fallback',
    error_code: errorCode,
    retryable: typeof candidate?.retryable === 'boolean'
      ? candidate.retryable
      : RETRYABLE_ATTACHMENT_VISUAL_ERRORS.has(errorCode),
    ...(candidate?.schema_mode === 'compat' || candidate?.schema_mode === 'strict'
      ? { schema_mode: candidate.schema_mode }
      : {})
  }
}

async function optionalSuggestionWithin(operation, timeoutMs = ATTACHMENT_SUGGESTION_TIMEOUT_MS, signal) {
  let timer
  let abortHandler
  const controller = new AbortController()
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ __attachment_timeout: true })
    }, timeoutMs)
    timer.unref()
  })
  const aborted = new Promise((resolve) => {
    if (!signal) return
    abortHandler = () => {
      controller.abort()
      resolve(null)
    }
    signal.addEventListener('abort', abortHandler, { once: true })
    if (signal.aborted) abortHandler()
  })
  const promise = typeof operation === 'function'
    ? Promise.resolve().then(() => operation(operationSignal))
    : Promise.resolve(operation)
  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    controller.abort()
    clearTimeout(timer)
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function cleanValue(value, maximum = 20_000) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\u0000/g, '').trim()
  return text ? text.slice(0, maximum) : null
}

function clearVisualPages(pages) {
  for (const page of Array.isArray(pages) ? pages : []) {
    try {
      if (page?.image instanceof Uint8Array) page.image.fill(0)
      else if (Buffer.isBuffer(page?.image)) page.image.fill(0)
    } catch {}
    if (page && typeof page === 'object') {
      page.image = new Uint8Array()
      page.text = ''
      page.text_spans = []
    }
  }
  if (Array.isArray(pages)) pages.length = 0
}

function normalizedEvidenceText(value) {
  return normalizeChineseSpacing(String(value ?? ''))
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function validNormalizedBox(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const box = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height)
  }
  if (!Object.values(box).every(Number.isFinite)) return null
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) return null
  if (box.x + box.width > 1.000001 || box.y + box.height > 1.000001) return null
  return box
}

function evidenceRefsForText(evidence, pages, preferredPage = null) {
  const text = cleanEvidenceSegment(evidence, 1_000)
  if (!text) return []
  const needle = normalizedEvidenceText(text)
  if (!needle) return []
  const candidates = (Array.isArray(pages) ? pages : [])
    .filter((page) => preferredPage == null || page?.page_number === preferredPage)
  for (const page of candidates) {
    const pageText = normalizedEvidenceText(page?.text)
    if (!pageText || !pageText.includes(needle)) continue
    const reference = { page: Number(page.page_number), text }
    const matchingSpan = (Array.isArray(page.text_spans) ? page.text_spans : []).find((span) => {
      const spanText = normalizedEvidenceText(span?.text)
      return spanText && needle === spanText
    })
    const bbox = validNormalizedBox(matchingSpan?.bbox)
    if (bbox) reference.bbox = bbox
    return [reference]
  }
  return [{ page: Number.isInteger(preferredPage) ? preferredPage : null, text }]
}

const PLACEHOLDER_VALUE_PATTERN = /^(?:[-\u2010\u2011\u2012\u2013\u2014\u2212]+|未填写|未填|未提供|未提取|未知|暂无|无|n\/a|na|null|none)$/iu

function isPlaceholderValue(value) {
  if (value === null || value === undefined) return true
  return PLACEHOLDER_VALUE_PATTERN.test(String(value).replace(/[\u00a0\u3000]/g, ' ').trim())
}

// PDF text extraction often inserts spaces between every Han character.  Do
// not remove every Han-to-Han space: spaces between real words (for example
// "示例大学 本科") carry meaning.  A space is removed only when both sides
// are singleton Han tokens, i.e. neither adjacent character belongs to a
// contiguous Han word.  This joins "张 三"/"数 据 分 析" while preserving
// ordinary multi-character word boundaries.
function normalizeChineseSpacing(value) {
  const text = String(value ?? '')
  const isHan = (character) => Boolean(character && /[\u3400-\u9fff]/u.test(character))
  return text.replace(/(?<=[\u3400-\u9fff])[ \t\u00a0\u3000]+(?=[\u3400-\u9fff])/gu, (spacing, offset, source) => {
    const previous = source[offset - 2] ?? ''
    const next = source[offset + spacing.length + 1] ?? ''
    return !isHan(previous) && !isHan(next) ? '' : spacing
  })
}

// Parser/OCR adapters occasionally append opaque tokens to a line.  Only
// remove tokens with strong noise signatures; ordinary alphanumeric IDs,
// emails, URLs and dates are deliberately left untouched.
function isLikelyAttachmentNoiseToken(value) {
  const token = String(value ?? '').trim().replace(/^[([<{]+|[\])}>.,;:，；。]+$/g, '')
  if (!token || token.length < 12) return false
  if (/^attachment-preview:/i.test(token) || /^source[-_](?:offset|record)/i.test(token)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return true
  // Known parser fragments have a long lower-case hex prefix, an upper-case
  // suffix, and often another opaque hyphen-delimited fragment.  Requiring this
  // exact shape avoids deleting ordinary external/business IDs such as
  // `abcDEF123456789012345678`.
  if (/^[0-9a-f]{12,}[A-Z]{1,8}(?:-[A-Za-z0-9]{8,})+[-~]*$/.test(token)) return true
  if (/^[0-9a-f]{12,}[A-Z]{1,8}$/.test(token)) return true
  // Some PDF exporters use an underscore after the short uppercase marker
  // (`...HN_...`) and then emit one long mixed-case fragment without hyphens.
  if (/^[0-9a-f]{12,}[A-Z]{1,8}_[A-Za-z0-9]{16,}[-~]*$/.test(token)) return true
  return false
}

function isStandaloneAttachmentNoiseLine(value) {
  return /^~+$/u.test(String(value ?? '').trim())
}

function isAttachmentNoiseOnlyLine(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  if (isStandaloneAttachmentNoiseLine(trimmed)) return true
  let sawOpaqueToken = false
  const remainder = trimmed.replace(/[A-Za-z0-9][A-Za-z0-9_~:-]{11,}/g, (token) => {
    if (!isLikelyAttachmentNoiseToken(token)) return token
    sawOpaqueToken = true
    return ''
  }).trim()
  return sawOpaqueToken && isStandaloneAttachmentNoiseLine(remainder)
}

// Opaque-looking identifiers are valid business data when the attachment
// explicitly labels them as such.  Keep this allow-list contextual and narrow
// so internal lineage labels such as source_record_id remain removable.
const EXPLICIT_IDENTIFIER_LABEL_PATTERN = /(?:(?:(?:候选人|应聘者|人才|业务|项目|合同|订单|工单|员工|证书|客户|外部)?(?:编号|编码|代码|单号|工号|学号|证书号))|(?:(?:候选人|应聘者|人才|业务|项目|合同|订单|工单|员工|证书|客户|外部)\s*id)|(?:(?:external|business|candidate|applicant|project|order|contract|employee|certificate|customer|reference)\s*(?:id|number|code|identifier)))\s*[:：#]?\s*$/iu

function hasExplicitIdentifierContext(value, offset) {
  const prefix = String(value ?? '').slice(Math.max(0, offset - 120), offset)
  return EXPLICIT_IDENTIFIER_LABEL_PATTERN.test(prefix)
}

function stripAttachmentNoise(value, maximum = 50_000) {
  const source = normalizeChineseSpacing(String(value ?? '').replace(/\u0000/g, ''))
  const lines = source.split(/\r?\n/)
  const seenLongLines = new Set()
  const cleanedLines = lines.flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return ['']
    if (isAttachmentNoiseOnlyLine(trimmed)) return []
    if (isLikelyAttachmentNoiseToken(trimmed)) return []
    const scrubbed = trimmed.replace(/[A-Za-z0-9][A-Za-z0-9_~:-]{11,}/g, (token, offset, whole) => {
      const previous = whole[offset - 1] ?? ''
      const next = whole[offset + token.length] ?? ''
      if (/^(?:attachment-preview:|source[-_](?:offset|record))/i.test(token)) return ''
      if (hasExplicitIdentifierContext(whole, offset)) return token
      if (previous === '@' || next === '@' || previous === '/' || next === '/' || next === '.') return token
      return isLikelyAttachmentNoiseToken(token) ? '' : token
    })
    // Preserve ordinary Latin/number spacing (for example "Senior Software
    // Engineer"). CJK-only spacing was normalized above; removing every
    // whitespace token here would silently change legitimate resume text.
    const cleaned = scrubbed.replace(/[ \t]{2,}/g, ' ').trim()
    // An opaque token can share a visual line with a standalone `~`. Once the
    // token is removed, re-check the residual line so the marker cannot leak
    // into public section content or evidence.
    if (isAttachmentNoiseOnlyLine(cleaned)) return []
    const repeatedKey = cleaned.replace(/\s+/g, ' ')
    if (repeatedKey.length >= 40 && seenLongLines.has(repeatedKey)) return []
    if (repeatedKey.length >= 40) seenLongLines.add(repeatedKey)
    return cleaned ? [cleaned] : []
  })
  return cleanValue(cleanedLines.join('\n'), maximum)
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.some((item) => nonEmpty(item))
  return value !== null && value !== undefined && String(value).trim() !== '' && !isPlaceholderValue(value)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function isMissingIdentityValue(value) {
  if (value === null || value === undefined) return true
  const text = String(value).trim()
  return text === '' || isPlaceholderValue(text)
}

function normalizedIdentityCandidates(values, normalizer) {
  const input = Array.isArray(values) ? values : [values]
  return unique(input
    .filter((value) => !isMissingIdentityValue(value))
    .map((value) => normalizer(value)))
}

function normalizedIdentity(identity = {}) {
  const phones = normalizedIdentityCandidates(
    identity.phone_candidates ?? identity.phones ?? identity.phone,
    normalizePhone
  )
  const emails = normalizedIdentityCandidates(
    identity.email_candidates ?? identity.emails ?? identity.email,
    normalizeEmail
  )
  return {
    phone: phones.length === 1 ? phones[0] : null,
    email: emails.length === 1 ? emails[0] : null,
    phone_candidates: phones.slice(0, 20),
    email_candidates: emails.slice(0, 20),
    ambiguous: phones.length > 1 || emails.length > 1
  }
}

function candidateView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    updated_at: row.updated_at
  }
}

function candidateCreationResponse(candidate) {
  if (!candidate) return candidate
  const response = { ...candidate }
  delete response.photo_url
  return response
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—–./\\:：()（）\[\]【】]+/g, '')
}

function findHeaderValue(values, aliases) {
  return findHeaderEntry(values, aliases)?.[1] ?? null
}

function findHeaderEntry(values, aliases) {
  const aliasesNormalized = new Set(aliases.map(normalizeHeader))
  for (const [header, value] of Object.entries(values ?? {})) {
    if (aliasesNormalized.has(normalizeHeader(header)) && nonEmpty(value)) return [header, value]
  }
  return null
}

function findPhysicalHeaderValues(values, aliases) {
  const aliasesNormalized = new Set(aliases.map(normalizeHeader))
  return Object.entries(values ?? {}).flatMap(([header, value]) => {
    // Spreadsheet workers preserve duplicate physical columns with `_2`,
    // `_3`, ... suffixes. Identity matching must inspect every such column.
    const physicalHeader = String(header).replace(/_\d+$/, '')
    return aliasesNormalized.has(normalizeHeader(physicalHeader)) && nonEmpty(value) ? [value] : []
  })
}

function extractTextIdentity(text, labeledData = extractLabeledCandidateData(text)) {
  const safeText = stripAttachmentNoise(text, 2_000_000) ?? ''
  const safeLabeledData = safeText && safeText !== String(text ?? '')
    ? extractLabeledCandidateData(safeText)
    : labeledData
  const labeledEmails = safeLabeledData.candidates.email
  const labeledPhones = safeLabeledData.candidates.phone
  const emails = safeLabeledData.identity_labels.email ? labeledEmails : emailCandidates(safeText)
  const phones = safeLabeledData.identity_labels.phone
    ? labeledPhones
    : phoneCandidates(safeText, { fallbackScan: true })
  return normalizedIdentity({ phone_candidates: phones, email_candidates: emails })
}

function looksLikeResumeDate(value) {
  const compact = String(value).replace(/\s/g, '')
  const yearRange = /^(?:19|20)\d{2}(?:[./-]\d{1,2}){0,2}[-–—~](?:19|20)\d{2}(?:[./-]\d{1,2}){0,2}$/
  const calendarDate = /^(?:19|20)\d{2}([./-])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])$/
  const compactDate = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/
  return yearRange.test(compact) || calendarDate.test(compact) || compactDate.test(compact)
}

function extractRowIdentity(values) {
  const phones = findPhysicalHeaderValues(
    values,
    ['phone', 'mobile', 'telephone', '手机号', '手机号码', '电话', '联系电话']
  )
  const emails = findPhysicalHeaderValues(
    values,
    ['email', 'e-mail', '邮箱', '电子邮箱', '邮箱地址']
  )
  return normalizedIdentity({ phone_candidates: phones, email_candidates: emails })
}

function normalizeLabel(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '')
    .replace(/\s+/g, ' ')
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
}

function labelRegex(value) {
  const source = String(value)
  if (/^[\u3400-\u9fff]+$/.test(source)) {
    return [...source].map((character) => escapeRegex(character)).join('\\s*')
  }
  return escapeRegex(source)
}

const LABEL_DESCRIPTORS = (() => {
  const descriptors = new Map()
  const descriptorFor = (alias) => {
    const key = normalizeLabel(alias)
    if (!descriptors.has(key)) descriptors.set(key, { alias, fields: new Set(), section: null })
    return descriptors.get(key)
  }
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) descriptorFor(alias).fields.add(field)
  }
  for (const [field, aliases] of Object.entries(ATTACHMENT_FIELD_ALIASES)) {
    for (const alias of aliases) descriptorFor(alias).fields.add(field)
  }
  for (const [field, aliases] of Object.entries(ATTACHMENT_PREFERENCE_FIELD_ALIASES)) {
    for (const alias of aliases) descriptorFor(alias).fields.add(field)
  }
  for (const alias of BOUNDARY_ONLY_LABELS) descriptorFor(alias)
  for (const definition of RESUME_SECTION_DEFINITIONS) {
    for (const alias of definition.aliases) descriptorFor(alias).section = definition
  }
  return descriptors
})()

const LABEL_PATTERN = [...LABEL_DESCRIPTORS.values()]
  .map((descriptor) => descriptor.alias)
  .sort((left, right) => right.length - left.length)
  .map(labelRegex)
  .join('|')
const SPACED_IDENTITY_LABEL_PATTERN = [...LABEL_DESCRIPTORS.entries()]
  .filter(([, descriptor]) => [...descriptor.fields].some((field) => field === 'phone' || field === 'email'))
  .map(([label]) => labelRegex(label))
  .sort((left, right) => right.length - left.length)
  .join('|')
const EMBEDDED_IDENTITY_LABEL_PATTERN = [...LABEL_DESCRIPTORS.entries()]
  .filter(([label, descriptor]) => (
    label.length >= 4
    && [...descriptor.fields].some((field) => field === 'phone' || field === 'email')
  ))
  .map(([label]) => labelRegex(label))
  .sort((left, right) => right.length - left.length)
  .join('|')
const SECTION_ALIAS_ENTRIES = RESUME_SECTION_DEFINITIONS
  .flatMap((definition) => definition.aliases.map((alias) => ({ alias, definition })))
  .sort((left, right) => right.alias.length - left.alias.length)
const SECTION_ALIAS_REGEX_ENTRIES = SECTION_ALIAS_ENTRIES.map((entry) => ({
  ...entry,
  matcher: new RegExp(`^(${labelRegex(entry.alias)})(?=$|[\\s:：])`, 'iu')
}))

function scanColonMarkers(text) {
  const source = String(text ?? '')
  const markers = []
  const collect = (matcher) => {
    let match
    while ((match = matcher.exec(source))) {
      const descriptor = LABEL_DESCRIPTORS.get(normalizeLabel(match[2]))
      if (!descriptor) continue
      markers.push({
        start: match.index + match[1].length,
        end: matcher.lastIndex,
        label: match[2],
        descriptor,
        inline: true
      })
    }
  }
  collect(new RegExp(`(^|[\\s|｜;；,，.．、。()（）\\[\\]【】])(${LABEL_PATTERN})\\s*[:：]\\s*`, 'gimu'))
  // PDF text commonly keeps this label contiguous while inserting spaces around nearby fields.
  collect(new RegExp(`(^|[^\\p{L}\\p{N}])(移动\\s*电\\s*话)\\s*[:：]\\s*`, 'gimu'))
  if (SPACED_IDENTITY_LABEL_PATTERN) {
    collect(new RegExp(`(^|[^\\p{L}\\p{N}])(${SPACED_IDENTITY_LABEL_PATTERN})\\s*[:：]\\s*`, 'gimu'))
  }
  if (EMBEDDED_IDENTITY_LABEL_PATTERN) {
    collect(new RegExp(`(^|.)(${EMBEDDED_IDENTITY_LABEL_PATTERN})\\s*[:：]\\s*`, 'gimu'))
  }
  // Some PDF text extractors concatenate adjacent labels without whitespace
  // (for example “姓名：张三邮箱：a@example.com”).  Recover any known label
  // followed by a colon; the value boundary logic below still limits it to the
  // current line/next marker.
  let embedded
  const embeddedMatcher = new RegExp(`(${LABEL_PATTERN})\\s*[:：]\\s*`, 'gimu')
  while ((embedded = embeddedMatcher.exec(source))) {
    const descriptor = LABEL_DESCRIPTORS.get(normalizeLabel(embedded[1]))
    if (!descriptor) continue
    // The generic matcher is needed for adjacent labels such as
    // “姓名：张三邮箱：...”, but short identity labels also occur inside
    // ordinary prose (for example “项目邮箱：...”).  When a short label is
    // immediately preceded by Han text, only accept it when the preceding
    // text looks like a value following a candidate-level label.  This keeps
    // the boundary recovery without manufacturing a second identity value.
    const previousCharacter = source[embedded.index - 1] ?? ''
    const compactAlias = normalizeLabel(embedded[1]).replace(/\s+/g, '')
    const identityField = [...descriptor.fields].some((field) => field === 'phone' || field === 'email')
    if (identityField && /[\u3400-\u9fff]/u.test(previousCharacter) && compactAlias.length <= 2) {
      const lineStart = source.lastIndexOf('\n', embedded.index - 1) + 1
      const prefix = source.slice(lineStart, embedded.index)
      const lastColon = Math.max(prefix.lastIndexOf(':'), prefix.lastIndexOf('：'))
      if (lastColon < 0) continue
      const precedingValue = prefix.slice(lastColon + 1).trim()
      if (!precedingValue || /[\s@,，;；|｜]/u.test(precedingValue)) continue
      const labelPrefix = prefix.slice(0, lastColon).trim()
      const followsSectionHeading = SECTION_ALIAS_ENTRIES.some((entry) => (
        labelPrefix.endsWith(entry.alias)
      ))
      if (followsSectionHeading) continue
    }
    markers.push({
      start: embedded.index,
      end: embeddedMatcher.lastIndex,
      label: embedded[1],
      descriptor,
      inline: true
    })
  }
  return markers
}

function scanStandaloneSectionMarkers(text) {
  const source = String(text ?? '')
  const markers = []
  const lineMatcher = /[^\r\n]+/g
  let lineMatch
  while ((lineMatch = lineMatcher.exec(source))) {
    const rawLine = lineMatch[0]
    const leading = rawLine.search(/\S/)
    if (leading < 0) continue
    const rawContent = rawLine.slice(leading).trimEnd()
    let headingPrefix = ''
    let headingRemainder = rawContent
    const headingPrefixPattern = /^(?:(?:#{1,6}|[\u2022•●▪◦*-])\s*|(?:\d+|[一二三四五六七八九十百]+)[、.．)）]\s*)/u
    for (let prefixCount = 0; prefixCount < 2; prefixCount += 1) {
      const prefix = headingPrefixPattern.exec(headingRemainder)?.[0]
      if (!prefix) break
      headingPrefix += prefix
      headingRemainder = headingRemainder.slice(prefix.length)
    }
    const contentOffset = leading + headingPrefix.length
    const content = rawContent.slice(headingPrefix.length)
    const trimmed = content.trim()
    const label = trimmed.replace(/\s*[:：]\s*$/, '')
    const descriptor = LABEL_DESCRIPTORS.get(normalizeLabel(label))
    if (descriptor?.section) {
      markers.push({
        start: lineMatch.index + contentOffset,
        // Keep the physical line start separately from the semantic label
        // start.  A numbered/Markdown heading's prefix (for example
        // "### 2. ") belongs to the heading, not to the preceding section.
        boundary_start: lineMatch.index + leading,
        end: lineMatch.index + rawLine.length,
        label,
        descriptor,
        inline: false
      })
      continue
    }

    let inlineHeading = null
    for (const entry of SECTION_ALIAS_REGEX_ENTRIES) {
      const match = entry.matcher.exec(content)
      if (match) {
        inlineHeading = { ...entry, matchedLength: match[0].length }
        break
      }
    }
    if (!inlineHeading) continue
    const separator = /^[ \t:：]+/.exec(content.slice(inlineHeading.matchedLength))?.[0] ?? ''
    markers.push({
      start: lineMatch.index + contentOffset,
      boundary_start: lineMatch.index + leading,
      end: lineMatch.index + contentOffset + inlineHeading.matchedLength + separator.length,
      label: inlineHeading.alias,
      descriptor: LABEL_DESCRIPTORS.get(normalizeLabel(inlineHeading.alias)),
      inline: true
    })
  }
  return markers
}

function markerBoundaryStart(marker) {
  return marker?.boundary_start ?? marker?.start ?? 0
}

// A number of exported resumes put a label on its own line and the value on
// the following line (without a colon).  Treat only known scalar labels as
// standalone boundaries; section headings are handled separately above.
function scanStandaloneFieldMarkers(text) {
  const source = String(text ?? '')
  const markers = []
  const lineMatcher = /[^\r\n]+/g
  let lineMatch
  while ((lineMatch = lineMatcher.exec(source))) {
    const rawLine = lineMatch[0]
    const leading = rawLine.search(/\S/)
    if (leading < 0) continue
    const trimmed = rawLine.trim().replace(/\s*[:：]\s*$/, '')
    const descriptor = LABEL_DESCRIPTORS.get(normalizeLabel(trimmed))
    // `自我评价` is represented as a scalar candidate field even when the
    // heading is on its own line. Other section-only headings remain section
    // boundaries and are handled by scanStandaloneSectionMarkers().
    if (descriptor?.section?.section_type === 'self_summary' && descriptor.fields.has('self_summary')) {
      markers.push({
        start: lineMatch.index + leading,
        end: lineMatch.index + rawLine.length,
        label: trimmed,
        descriptor,
        inline: false,
        standalone: true
      })
      continue
    }
    if (!descriptor || descriptor.section) continue
    // A standalone label must occupy the whole physical line.  This avoids
    // treating ordinary prose containing e.g. “专业” as a field marker.
    markers.push({
      start: lineMatch.index + leading,
      end: lineMatch.index + rawLine.length,
      label: trimmed,
      descriptor,
      inline: false,
      standalone: true
    })
  }
  return markers
}

function uniqueMarkers(markers) {
  const result = []
  for (const marker of markers.sort((left, right) => left.start - right.start || right.end - left.end)) {
    const previous = result.at(-1)
    if (previous && previous.start === marker.start) {
      const preferred = marker.end > previous.end ? marker : previous
      const boundaryStart = Math.min(markerBoundaryStart(previous), markerBoundaryStart(marker))
      result[result.length - 1] = boundaryStart < preferred.start
        ? { ...preferred, boundary_start: boundaryStart }
        : preferred
      continue
    }
    result.push(marker)
  }
  return result
}

function looksLikeYearsField(text, marker) {
  if (canonicalSectionType(marker.descriptor.section?.section_type) !== 'experience') return false
  if (!marker.descriptor.fields.has('years_experience')) return false
  const source = String(text ?? '')
  const lineEnd = source.indexOf('\n', marker.end)
  let tail
  if (marker.standalone) {
    const valueStart = lineEnd < 0 ? source.length : lineEnd + 1
    const valueEnd = source.indexOf('\n', valueStart)
    tail = source.slice(valueStart, valueEnd < 0 ? source.length : valueEnd).trim()
  } else {
    tail = source.slice(marker.end, lineEnd < 0 ? undefined : lineEnd).trim()
  }
  return /^\d+(?:\.\d+)?\s*(?:年|years?)?(?:以上)?$/i.test(tail)
}

function markerValueLine(text, marker) {
  const source = String(text ?? '')
  const lineEnd = source.indexOf('\n', marker.end)
  if (!marker.standalone) return source.slice(marker.end, lineEnd < 0 ? source.length : lineEnd).trim()
  const valueStart = lineEnd < 0 ? source.length : lineEnd + 1
  const valueEnd = source.indexOf('\n', valueStart)
  return source.slice(valueStart, valueEnd < 0 ? source.length : valueEnd).trim()
}

// Some aliases (Education/Experience) are also section headings.  When the
// heading carries a short scalar value, keep it as a profile-field marker and
// do not manufacture a履历 section from it.
function isScalarSectionMarker(text, marker) {
  const sectionType = canonicalSectionType(marker.descriptor.section?.section_type)
  const label = normalizeLabel(marker.label).replace(/\s+/g, '')
  const value = markerValueLine(text, marker)
  if (sectionType === 'experience' && label === 'experience') return looksLikeYearsField(text, marker)
  if (sectionType !== 'education' || !value || value.length > 80 || /[\n;；|｜]/u.test(value)) return false
  return new Set(['education', 'degree', 'highesteducation']).has(label)
}

function scanSectionMarkers(text) {
  return uniqueMarkers([
    ...scanColonMarkers(text).filter((marker) => marker.descriptor.section && !looksLikeYearsField(text, marker)),
    ...scanStandaloneSectionMarkers(text)
  ].filter((marker) => marker.descriptor.section && !isScalarSectionMarker(text, marker)))
}

function cleanExtractedSegment(value, maximum) {
  const text = String(value ?? '')
    .replace(/^[\s|｜;；,，]+/, '')
    .replace(/[\s|｜;；,，]+$/, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return text ? text.slice(0, maximum) : null
}

function cleanResumeSegment(value, maximum) {
  const segment = cleanExtractedSegment(normalizeChineseSpacing(value), maximum)
  if (!segment || isPlaceholderValue(segment)) return null
  return stripAttachmentNoise(segment, maximum)
}

// Evidence is user-facing, so opaque parser/lineage tokens must not leak into
// it.  Keep the prefix before a noise token instead of deleting characters in
// the middle; the returned fragment therefore remains an exact substring of
// the attachment source and can still be audited back to the original text.
function cleanEvidenceSegment(value, maximum = 1_000) {
  const source = String(value ?? '')
  const sourceLines = source.split(/\r?\n/u)
  const standaloneNoiseIndex = sourceLines.findIndex((line) => (
    isAttachmentNoiseOnlyLine(line) || isLikelyAttachmentNoiseToken(line)
  ))
  // Keep evidence as a contiguous source fragment. If a standalone noise line
  // interrupts a candidate value, stop before it instead of joining separated
  // source lines into evidence that cannot be audited literally.
  const boundedSource = standaloneNoiseIndex >= 0
    ? sourceLines.slice(0, standaloneNoiseIndex).join('\n')
    : source
  const matcher = /[A-Za-z0-9][A-Za-z0-9_~:-]{11,}/g
  let match
  while ((match = matcher.exec(boundedSource))) {
    const token = match[0]
    const lineageToken = /^(?:attachment-preview:|source[-_](?:offset|record))/i.test(token)
    if (lineageToken || (!hasExplicitIdentifierContext(boundedSource, match.index) && isLikelyAttachmentNoiseToken(token))) {
      return cleanExtractedSegment(boundedSource.slice(0, match.index), maximum)
    }
  }
  return cleanExtractedSegment(boundedSource, maximum)
}

const DOMESTIC_PHONE_PATTERN = /(?:\+?86|0086)?[\s().-]*1[3-9](?:[\s().-]*\d){9}(?!\d)/g
const GENERIC_PHONE_PATTERN = /(?:\+|00)(?:\d[\s().-]?){6,18}\d|(?:\d[\s().-]?){6,18}\d/g

function hasNumericPhoneSuffix(value) {
  const source = String(value ?? '').trim()
  const suffix = /\s+(\d{2,4})(?:\s*[A-Za-z\u3400-\u9fff]|\s*$)/.exec(source)
  if (!suffix) return false
  const prefix = source.slice(0, suffix.index).trim()
  if (!prefix) return false
  const normalizedPrefix = normalizePhone(prefix)
  return Boolean(normalizedPrefix && phoneCandidatesForPrefix(prefix, normalizedPrefix))
}

function phoneCandidatesForPrefix(prefix, normalizedPrefix) {
  const digits = String(prefix).replace(/\D/g, '')
  if (/^1[3-9]\d{9}$/.test(digits)) return normalizedPrefix
  if (/^(?:86|0086)1[3-9]\d{9}$/.test(digits)) return normalizedPrefix
  return null
}

function phoneCandidates(value, { fallbackScan = false } = {}) {
  const source = String(value ?? '')
  const matches = []
  const domesticMatches = [...source.matchAll(DOMESTIC_PHONE_PATTERN)]
  const covered = domesticMatches.map((match) => {
    matches.push(match[0])
    return [match.index ?? 0, (match.index ?? 0) + match[0].length]
  })
  // Remove already recognized domestic mobiles before scanning generic
  // international/landline forms; this prevents a trailing numeric field from
  // being concatenated into the mobile candidate.
  const remainder = [...source].map((character, index) => (
    covered.some(([start, end]) => index >= start && index < end) ? ' ' : character
  )).join('')
  matches.push(...(remainder.match(GENERIC_PHONE_PATTERN) ?? []))
  return unique(
    matches
      .filter((candidate) => !looksLikeResumeDate(candidate))
      .filter((candidate) => !hasNumericPhoneSuffix(candidate))
      .map((candidate) => ({ candidate, normalized: normalizePhone(candidate) }))
      .filter(({ candidate, normalized }) => {
        if (!normalized) return false
        const digits = String(candidate).replace(/\D/g, '')
        const domesticDigits = /^(?:86)(1[3-9]\d{9})$/.exec(digits)?.[1] ?? digits
        if (/^1[3-9]\d/.test(domesticDigits) && !/^1[3-9]\d{9}$/.test(domesticDigits)) return false
        if (!fallbackScan) return true
        if (/^\+861[3-9]\d{9}$/.test(normalized)) return true
        return /^(?:\+|00)/.test(candidate.trim()) && normalized.startsWith('+')
      })
      .map(({ normalized }) => normalized)
  )
}

function emailCandidates(value) {
  return unique(
    (String(value ?? '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])
      .map(normalizeEmail)
  )
}

// Contact values are handled separately from the generic candidate sanitizer.
// normalizePhone intentionally accepts punctuation and strips non-digits, which
// is useful for imports but would otherwise turn a model response such as
// "13800000000 专业：软件工程" into a valid phone number.  Model suggestions
// therefore must be an exact, single contact token.
function strictContactCandidate(field, rawValue) {
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return null
  const input = String(rawValue).replace(/\u0000/g, '').trim()
  if (!input) return null
  if (field === 'email') {
    if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(input)) return null
    return normalizeEmail(input)
  }
  if (field === 'phone') {
    // Keep the formatting accepted by normalizePhone, but reject labels,
    // whitespace-separated prose, and any second numeric token. A domestic
    // mobile must contain exactly 11 digits (or 86 + those 11 digits).
    if (!/^(?:(?:\+|00)?[0-9][0-9\s().-]{5,22}[0-9])$/.test(input)) return null
    const digits = input.replace(/\D/g, '')
    if (hasNumericPhoneSuffix(input)) return null
    if (/^1[3-9]/.test(digits) && !/^1[3-9]\d{9}$/.test(digits)) return null
    if (/^(?:\+?86|0086)/.test(input) && !/^(?:86|0086)1[3-9]\d{9}$/.test(digits)) return null
    const candidates = phoneCandidates(input)
    return candidates.length === 1 ? candidates[0] : null
  }
  return null
}

function contactCandidateRegex(field) {
  return field === 'email'
    ? /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
    : /(?:\+?86|0086)?[\s().-]*1[3-9](?:[\s().-]*\d){9}(?!\d)|(?:\+|00)(?:\d[\s().-]?){6,18}\d(?!\d)|(?:\d[\s().-]?){6,18}\d(?!\d)/g
}

// Return the smallest source fragment containing the contact label and token.
// It deliberately stops at the token end, so adjacent fields on the same line
// can never leak into evidence.
function contactEvidenceFromText(text, field, normalized, preferredEvidence = null) {
  if (!normalized) return null
  const sources = []
  if (typeof preferredEvidence === 'string' && preferredEvidence.trim()) sources.push(preferredEvidence)
  if (typeof text === 'string' && text.trim() && !sources.includes(text)) sources.push(text)
  for (const source of sources) {
    const matcher = contactCandidateRegex(field)
    let match
    while ((match = matcher.exec(source))) {
      const candidate = field === 'email' ? normalizeEmail(match[0]) : normalizePhone(match[0])
      if (candidate !== normalized) continue
      if (field === 'phone' && hasNumericPhoneSuffix(match[0])) continue
      const lineStart = source.lastIndexOf('\n', match.index - 1) + 1
      const lineEndOffset = source.indexOf('\n', match.index + match[0].length)
      const lineEnd = lineEndOffset < 0 ? source.length : lineEndOffset
      const line = source.slice(lineStart, lineEnd)
      const relativeMatchIndex = match.index - lineStart
      let start = lineStart
      // Prefer the nearest recognized label for this field on the same line.
      const lineMarkers = scanColonMarkers(line)
      const marker = lineMarkers
        .filter((item) => item.descriptor.fields.has(field) && item.end <= relativeMatchIndex)
        .at(-1)
      if (marker) start = lineStart + marker.start
      else if (!marker) start = lineStart + relativeMatchIndex
       const fragment = cleanEvidenceSegment(source.slice(start, match.index + match[0].length), 1_000)
      if (fragment) return fragment
    }
  }
  return null
}

function uniqueExtractedContact(field, rawValue) {
  const candidates = field === 'phone' ? phoneCandidates(rawValue) : emailCandidates(rawValue)
  return candidates.length === 1 ? candidates[0] : null
}

function normalizeExtractedField(field, rawValue) {
  const maximum = FIELD_LIMITS[field] ?? (field === 'tags' ? 20_000 : 300)
  const multiline = cleanResumeSegment(rawValue, maximum)
  if (!multiline) return null
  if (field === 'phone' || field === 'email') return uniqueExtractedContact(field, multiline)
  if (field === 'years_experience') return multiline
  if (field === 'tags' || field === 'desired_titles' || field === 'desired_locations') {
    const values = multiline
      .split(/[\n,，;；|｜/、·•]+/)
      .map((item) => item.replace(/^[-*–—]\s*/, '').replace(/\s+/g, ' ').trim())
      .filter((item) => item && !isPlaceholderValue(item) && !isLikelyAttachmentNoiseToken(item))
      .slice(0, field === 'tags' ? 50 : 20)
    return values.length ? values : null
  }
  const value = field === 'self_summary'
    ? multiline
    : multiline.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim()
  if (!value) return null
  if (field === 'name') {
    if (value.length > 80 || /[@]|(?:\+?\d[\d\s().-]{6,})/.test(value) || /[:：|｜;；]/.test(value)) return null
  }
  return cleanValue(value, maximum)
}

function sectionContainingMarker(sectionMarkers, marker) {
  for (const [index, sectionMarker] of sectionMarkers.entries()) {
    const next = sectionMarkers[index + 1]
    if (marker.start >= markerBoundaryStart(sectionMarker) && marker.start < (next ? markerBoundaryStart(next) : Number.POSITIVE_INFINITY)) {
      return sectionMarker
    }
  }
  return null
}

function fieldAllowedInsideSection(marker, field, sectionMarker) {
  if (!sectionMarker) return true
  if (field === 'phone' || field === 'email') return true
  const sectionType = sectionMarker.descriptor.section?.section_type
  if (field === 'self_summary') return sectionType === 'self_summary'
  if (
    canonicalSectionType(sectionType) === 'education' &&
    marker.start > sectionMarker.start &&
    ['education', 'highest_school', 'highest_major'].includes(field)
  ) return true
  // A skill heading doubles as the canonical `tags` field in many exports.
  // Keep both projections: the section preserves the resume text while the
  // profile tag field remains editable/searchable.
  if (marker.start === sectionMarker.start && canonicalSectionType(sectionType) === 'skill' && field === 'tags') return true
  if (marker.start === sectionMarker.start) return false

  const label = normalizeLabel(marker.label)
  if (field === 'current_company') return /^(?:当前公司|目前公司|现公司|current company)$/iu.test(label)
  if (field === 'current_title') return /^(?:当前职位|目前职位|现职位|current title)$/iu.test(label)
  if (field === 'highest_school') return /^(?:最高学历学校|最高学历院校|highest school)$/iu.test(label)
  if (field === 'highest_major') return /^(?:最高学历专业|highest major)$/iu.test(label)
  if (field === 'location') return /^(?:所在地|当前所在地|工作地点|location)$/iu.test(label)
  if (field === 'years_experience') return /^(?:工作年限|经验年限|years experience)$/iu.test(label)
  // These labels are unambiguously candidate-level even when a preceding
  // resume section happens to extend to the end of the document.
  return [
    'name', 'gender', 'birth_date', 'age', 'job_seeking_status', 'resume_updated_at',
    'desired_titles', 'desired_locations', 'employment_type', 'availability'
  ].includes(field)
}

function extractLabeledCandidateData(text) {
  const source = String(text ?? '')
  const colonMarkers = scanColonMarkers(source)
  const standaloneSectionMarkers = scanStandaloneSectionMarkers(source)
  const sectionMarkers = scanSectionMarkers(source)
  const standaloneFieldMarkers = scanStandaloneFieldMarkers(source)
  const boundaries = uniqueMarkers([...colonMarkers, ...standaloneSectionMarkers, ...standaloneFieldMarkers])
  const values = {}
  const evidence = {}
  const candidates = { phone: [], email: [] }
  const identityLabels = { phone: false, email: false }
  for (const marker of [...colonMarkers, ...standaloneFieldMarkers].sort((left, right) => left.start - right.start)) {
    const boundaryIndex = boundaries.findIndex((item) => item.start === marker.start)
    const next = boundaryIndex >= 0 ? boundaries[boundaryIndex + 1] : null
    // A standalone/Markdown section marker's semantic start begins after its
    // numbering prefix. Scalar values must stop at the physical line start so
    // that prefixes such as `### 2.` never leak into the preceding field.
    const nextBoundaryStart = next ? markerBoundaryStart(next) : source.length
    const lineEnd = source.indexOf('\n', marker.end)
    const identityField = [...marker.descriptor.fields].some((field) => field === 'phone' || field === 'email')
    const multilineField = [...marker.descriptor.fields].some((field) => field === 'self_summary')
    const valueStart = marker.standalone
      ? (lineEnd < 0 ? source.length : lineEnd + 1)
      : marker.end
    const valueLineEnd = marker.standalone
      ? source.indexOf('\n', valueStart)
      : lineEnd
    const scalarEnd = Math.min(
      nextBoundaryStart,
      marker.standalone
        ? (valueLineEnd < 0 ? source.length : valueLineEnd)
        : (lineEnd < 0 ? source.length : lineEnd)
    )
    const valueEnd = marker.standalone
      ? (multilineField
          ? nextBoundaryStart
          : Math.min(
              nextBoundaryStart,
              valueLineEnd < 0 ? source.length : valueLineEnd
            ))
      : (multilineField ? nextBoundaryStart : scalarEnd)
    const rawValue = source.slice(valueStart, Math.max(valueStart, valueEnd))
    const sameLine = source.slice(marker.end, lineEnd < 0 ? source.length : lineEnd)
    const nextColonOffset = identityField ? sameLine.search(/[:：]/) : -1
    const identityRawValue = source.slice(
      valueStart,
      marker.standalone
        ? valueEnd
        : Math.min(
            scalarEnd,
            lineEnd < 0 ? source.length : lineEnd,
            nextColonOffset >= 0 ? marker.end + nextColonOffset : source.length
          )
    )
    for (const field of marker.descriptor.fields) {
      if (field === 'phone' || field === 'email') identityLabels[field] = true
      if (field === 'phone') candidates.phone.push(...phoneCandidates(identityRawValue))
      if (field === 'email') candidates.email.push(...emailCandidates(identityRawValue))
      const containingSection = sectionContainingMarker(sectionMarkers, marker)
      if (!fieldAllowedInsideSection(marker, field, containingSection)) continue
      if (!ALLOWED_UPDATE_FIELDS.has(field) || Object.prototype.hasOwnProperty.call(values, field)) continue
      const value = field === 'phone' || field === 'email'
        ? normalizeExtractedField(field, identityRawValue)
        : normalizeExtractedField(field, rawValue)
      if (!nonEmpty(value)) continue
      values[field] = value
      evidence[field] = field === 'phone' || field === 'email'
        ? contactEvidenceFromText(source, field, value, source.slice(marker.start, Math.max(marker.start, scalarEnd)))
        : cleanEvidenceSegment(source.slice(marker.start, Math.max(marker.start, valueEnd)), 1000)
    }
  }
  return {
    values,
    evidence,
    identity_labels: identityLabels,
    candidates: {
      phone: unique(candidates.phone),
      email: unique(candidates.email)
    }
  }
}

function textCandidateValues(text, identity, labeledData = extractLabeledCandidateData(text)) {
  const values = {
    ...labeledData.values,
    phone: identity.phone,
    email: identity.email
  }
  if (!nonEmpty(values.years_experience)) {
    const years = String(text).match(/((?:\d+(?:\.\d+)?)\s*(?:年|years?)(?:\s*\d+\s*(?:个月|月))?\s*(?:以上)?)(?:工作经验|从业经验|开发经验|工作|从业|开发|经验|experience)/i)
    if (years) {
      values.years_experience = years[1]
      if (!labeledData.evidence.years_experience) labeledData.evidence.years_experience = years[0]
    }
  }
  return Object.fromEntries(Object.entries(values).filter(([, value]) => nonEmpty(value)))
}

function spreadsheetEvidence(header, value) {
  const rendered = cleanEvidenceSegment(`${String(header).trim()}: ${String(value ?? '').trim()}`, 1_000)
  return rendered && !isPlaceholderValue(value) ? rendered : null
}

const SPREADSHEET_SECTION_FIELD_PATTERNS = Object.freeze([
  ['internship', /^(?:实习(?:公司|单位|机构|职位|岗位|职务|时间|日期|内容|职责|描述)|internship(?:company|organization|role|position|period|date|description))$/i],
  ['education', /^(?:教育(?:院校|学校|专业|学位|学历|时间|内容)|院校名称|学校名称|专业名称|education(?:school|major|degree|period|description))$/i],
  ['experience', /^(?:工作(?:公司|单位|职位|岗位|职务|时间|内容|职责|描述)|work(?:company|role|position|period|description))$/i],
  ['project', /^(?:项目(?:名称|角色|时间|内容|职责|描述)|project(?:name|role|period|description))$/i],
  ['language', /^(?:语言(?:名称|等级|水平|证书|描述)|外语(?:名称|等级|水平)|language(?:name|level|certificate|description))$/i],
  ['skill', /^(?:技能(?:名称|等级|描述)|skill(?:name|level|description))$/i]
])

function spreadsheetSectionDefinition(header, value) {
  const withoutDuplicateSuffix = String(header ?? '').replace(/_\d+$/, '')
  const normalized = normalizeLabel(withoutDuplicateSuffix)
  const canonicalType = canonicalSectionType(withoutDuplicateSuffix)
  let definition = SECTION_DEFINITION_BY_TYPE.get(withoutDuplicateSuffix) ??
    SECTION_DEFINITION_BY_TYPE.get(normalized) ??
    SECTION_DEFINITION_BY_TYPE.get(canonicalType)
  if (!definition) {
    const compactHeader = normalizeHeader(withoutDuplicateSuffix)
    const matchedType = SPREADSHEET_SECTION_FIELD_PATTERNS.find(([, pattern]) => pattern.test(compactHeader))?.[0]
    if (matchedType) definition = SECTION_DEFINITION_BY_TYPE.get(matchedType)
  }
  if (!definition || definition.section_type === 'self_summary') return null
  const content = cleanResumeSegment(value, 50_000)
  if (!content) return null

  // `education` and `experience` are also common scalar spreadsheet headers.
  // A short degree or numeric year count should stay a candidate field rather
  // than becoming a misleading profile section.
  if (normalized === 'education' && !/[\r\n;；|｜]/.test(content) && content.length <= 20) return null
  if (normalized === 'experience' && /^\d+(?:\.\d+)?\s*(?:年|years?)?$/i.test(content)) return null
  return definition
}

function spreadsheetResumeSections(values) {
  const grouped = new Map()
  for (const [columnIndex, [header, rawValue]] of Object.entries(values ?? {}).entries()) {
    const definition = spreadsheetSectionDefinition(header, rawValue)
    if (!definition) continue
    const content = cleanResumeSegment(rawValue, 50_000)
    const evidence = spreadsheetEvidence(header, rawValue)
    if (!content || !evidence) continue
    if (!grouped.has(definition.section_type)) {
      grouped.set(definition.section_type, { definition, firstColumnIndex: columnIndex, entries: [] })
    }
    grouped.get(definition.section_type).entries.push({ header: String(header), content, evidence, columnIndex })
  }
  return [...grouped.values()]
    .sort((left, right) => left.firstColumnIndex - right.firstColumnIndex)
    .slice(0, 50)
    .map(({ definition, entries }, sourceOrder) => {
      const content = entries.length === 1
        ? entries[0].content
        : entries.map((entry) => `${entry.header}：${entry.content}`).join('\n')
      return {
        section_id: randomUUID(),
        section_type: definition.section_type,
        title: definition.title,
        content,
        structured_data: {
          parser: PARSER_VERSION,
          canonical_type: definition.section_type,
          source_order: sourceOrder,
          source_headers: entries.map((entry) => entry.header),
          source_column_indexes: entries.map((entry) => entry.columnIndex),
          source_fields: Object.fromEntries(entries.map((entry) => [entry.header, entry.content])),
          ...extractStructuredSectionFields(definition.section_type, content)
        },
        confidence: 'high',
        evidence: entries[0].evidence,
        default_selected: true
      }
    })
}

function spreadsheetRecordData(values) {
  const headers = Object.keys(values ?? {})
  const { mapping: baseMapping } = buildHeaderMapping(headers)
  const mapping = { ...baseMapping }
  for (const [field, aliases] of Object.entries(ATTACHMENT_FIELD_ALIASES)) {
    if (mapping[field]) continue
    const entry = findHeaderEntry(values, aliases)
    if (entry) mapping[field] = entry[0]
  }
  const preferenceEntries = Object.fromEntries(
    Object.entries(ATTACHMENT_PREFERENCE_FIELD_ALIASES)
      .map(([field, aliases]) => [field, findHeaderEntry(values, aliases)])
  )
  const preferenceValues = Object.fromEntries(
    Object.entries(preferenceEntries)
      .map(([field, entry]) => [field, normalizeExtractedField(field, entry?.[1])])
      .filter(([, value]) => nonEmpty(value))
  )
  const imported = {
    ...mapImportedRow(values, mapping),
    ...preferenceValues
  }
  const sourceValues = Object.fromEntries(
    Object.entries(imported)
      .filter(([field, value]) => ALLOWED_UPDATE_FIELDS.has(field) && nonEmpty(value))
  )
  const evidence = {}
  for (const [field, header] of Object.entries(mapping)) {
    if (!ALLOWED_UPDATE_FIELDS.has(field) || !nonEmpty(sourceValues[field])) continue
    const fragment = spreadsheetEvidence(header, values?.[header])
    if (fragment) evidence[field] = fragment
  }
  for (const [field, entry] of Object.entries(preferenceEntries)) {
    if (!entry || !nonEmpty(sourceValues[field])) continue
    const fragment = spreadsheetEvidence(entry[0], entry[1])
    if (fragment) evidence[field] = fragment
  }
  return {
    values: sourceValues,
    evidence,
    sections: spreadsheetResumeSections(values),
    corpus: Object.entries(values ?? {})
      .map(([header, value]) => spreadsheetEvidence(header, value))
      .filter(Boolean)
      .join('\n')
  }
}

function sectionTitle(type) {
  return {
    experience: '工作经历',
    work_experience: '工作经历',
    project: '项目经历',
    project_experience: '项目经历',
    education: '教育经历',
    education_experience: '教育经历',
    internship: '实习经历',
    self_summary: '自我评价',
    skill: '技能',
    skills: '技能/荣誉',
    language: '语言能力',
    campus: '校园经历',
    certificate: '证书',
    award: '奖励与荣誉',
    training: '培训经历',
    publication: '论文与作品',
    management: '管理经历',
    other: '附加信息',
    resume_summary: '简历正文'
  }[type] ?? type
}

function isScalarSummarySection(section) {
  const sectionType = String(section?.section_type ?? '').trim().toLowerCase()
  if (sectionType === 'self_summary' || sectionType === 'resume_summary') return true
  const rawStructured = section?.structured_data
  const structured = typeof rawStructured === 'string' ? parseJson(rawStructured, {}) : rawStructured
  const semanticType = String(structured?.semantic_type ?? '').trim().toLowerCase()
  return semanticType === 'self_summary' || semanticType === 'resume_summary'
}

function extractStructuredSectionFields(sectionType, content) {
  const source = String(content ?? '')
  const result = {}
  const aliases = {
    organization: ['实习公司', '公司名称', '公司', '机构名称', '机构', '单位名称', '单位', 'organization', 'company'],
    role: ['实习职位', '实习岗位', '职位名称', '职位', '岗位', '职务', 'role', 'position', 'title'],
    period: ['实习时间', '起止时间', '任职时间', '时间', '日期', 'period', 'date'],
    description: ['实习内容', '工作内容', '主要职责', '职责', '经历内容', '描述', 'description', 'responsibilities']
  }
  for (const [field, labels] of Object.entries(aliases)) {
    for (const label of labels) {
      const match = new RegExp(`(?:^|\\n|[;；|｜])\\s*${labelRegex(label)}\\s*[:：]\\s*([^\\n;；|｜]+)`, 'iu').exec(source)
      const value = match ? cleanResumeSegment(match[1], 5_000) : null
      if (value) {
        result[field] = value
        break
      }
    }
  }
  if (!result.period) {
    const range = source.match(/(?:19|20)\d{2}(?:[./-]\d{1,2})?\s*[-–—~至]\s*(?:(?:19|20)\d{2}(?:[./-]\d{1,2})?|至今|现在|present)/i)
    if (range) result.period = range[0].trim()
  }
  return sectionType === 'internship' || Object.keys(result).length ? result : {}
}

export function extractResumeSections(text) {
  const source = String(text ?? '')
  const markers = scanSectionMarkers(source)
  // Self-summary is the one intentionally multiline scalar.  Its section must
  // still stop at the next recognized field/section marker; otherwise a later
  // `意向岗位` or `期望薪资` line gets persisted as part of the summary.
  const fieldBoundaries = uniqueMarkers([
    ...scanColonMarkers(source),
    ...scanStandaloneFieldMarkers(source)
  ])
  const sections = []
  let sawSelfSummary = false
  for (const [index, marker] of markers.entries()) {
    const next = markers[index + 1]
    let boundary = next ? markerBoundaryStart(next) : source.length
    if (marker.descriptor.section?.section_type === 'self_summary') {
      const nextField = fieldBoundaries.find((candidate) => (
        candidate.start > marker.start && candidate.start < boundary
      ))
      if (nextField) boundary = nextField.start
    }
    const content = cleanResumeSegment(source.slice(marker.end, boundary), 50_000)
    if (!content) continue
    const definition = marker.descriptor.section
    const sectionType = definition.section_type
    if (sectionType === 'self_summary') {
      sawSelfSummary = true
      continue
    }
    sections.push({
      section_id: randomUUID(),
      section_type: sectionType,
      title: definition.title,
      content,
      structured_data: {
        parser: PARSER_VERSION,
        source_order: sections.length,
        source_heading: marker.label,
        canonical_type: canonicalSectionType(sectionType),
        source_offset: markerBoundaryStart(marker),
        ...extractStructuredSectionFields(sectionType, content)
      },
      confidence: marker.inline ? 'medium' : 'high',
      // Keep evidence as a literal fragment of the original attachment text.
       evidence: cleanEvidenceSegment(source.slice(markerBoundaryStart(marker), boundary), 1_000) ?? content.slice(0, 240),
      default_selected: true
    })
  }
  if (sections.length) return sections.slice(0, 50)
  if (sawSelfSummary) return []
  const fallback = cleanResumeSegment(source, 50_000)
  return fallback
    ? [{
        section_id: randomUUID(),
        section_type: 'other',
        title: '简历正文',
        content: fallback,
        structured_data: { parser: PARSER_VERSION, canonical_type: 'other', source_order: 0, fallback: true },
        confidence: 'low',
         evidence: cleanEvidenceSegment(source, 240) ?? fallback.slice(0, 240),
        default_selected: false
      }]
    : []
}

function queryIdentity(db, field, value) {
  if (!value) return []
  return db.prepare(`
    SELECT id, name, phone, email, updated_at, archived_at
    FROM candidates WHERE ${field} = ? ORDER BY id
  `).all(value)
}

export function matchCandidateIdentity(db, identity) {
  const normalized = normalizedIdentity(identity)
  if (normalized.ambiguous) {
    return { status: 'multiple_matches', reason: '附件中提取到多个手机号或邮箱，无法确定唯一身份' }
  }
  const phoneMatches = queryIdentity(db, 'phone', normalized.phone)
  const emailMatches = queryIdentity(db, 'email', normalized.email)
  if (phoneMatches.length > 1 || emailMatches.length > 1) {
    return { status: 'multiple_matches', reason: '手机号或邮箱命中多位候选人，已阻断自动定位' }
  }
  const phoneMatch = phoneMatches[0]
  const emailMatch = emailMatches[0]
  if (phoneMatch?.archived_at || emailMatch?.archived_at) {
    return { status: 'multiple_matches', reason: '身份字段命中已归档候选人，归档档案不能通过附件更新' }
  }
  if (phoneMatch && emailMatch && phoneMatch.id !== emailMatch.id) {
    return { status: 'identity_conflict', reason: '手机号与邮箱命中不同候选人，已阻断自动定位' }
  }
  if (phoneMatch && emailMatch) {
    return {
      status: 'high_confidence',
      candidate_id: phoneMatch.id,
      candidate: candidateView(phoneMatch),
      reason: '手机号与邮箱均精确命中同一候选人'
    }
  }
  const single = phoneMatch ?? emailMatch
  if (single) {
    return {
      status: 'single_identity',
      candidate_id: single.id,
      candidate: candidateView(single),
      reason: phoneMatch ? '手机号唯一精确命中，仍需用户确认' : '邮箱唯一精确命中，仍需用户确认'
    }
  }
  return {
    status: 'not_found',
    reason: normalized.phone || normalized.email
      ? '手机号和邮箱均未命中现有候选人，请手工选择或取消'
      : '未提取到可用手机号或邮箱，请手工选择或取消'
  }
}

function fieldConfidence(field, sourceValues) {
  if (['phone', 'email'].includes(field)) return 'high'
  if (Object.prototype.hasOwnProperty.call(sourceValues, field)) return 'medium'
  return 'low'
}

function candidateRawValue(candidate, field) {
  if (!candidate) return null
  if (field === 'tags') return Array.isArray(candidate.tags) ? candidate.tags : parseJson(candidate.tags, [])
  if (field === 'desired_titles' || field === 'desired_locations') {
    const value = candidate[field]
    return Array.isArray(value) ? value : parseJson(value, [])
  }
  if (PREFERENCE_ONLY_FIELDS.has(field)) return candidate[field] ?? null
  return candidate[field] ?? null
}

function sanitizeAttachmentPatch(input) {
  const candidateInput = Object.fromEntries(
    Object.entries(input ?? {}).filter(([field]) => !PREFERENCE_ONLY_FIELDS.has(field) && field !== 'desired_titles')
  )
  const result = sanitizeCandidateInput(candidateInput, { partial: true })
  const preferenceValues = {}
  for (const field of ['desired_titles', 'desired_locations']) {
    if (!Object.prototype.hasOwnProperty.call(input ?? {}, field)) continue
    const normalized = normalizeExtractedField(field, input[field])
    if (normalized) preferenceValues[field] = normalized
  }
  for (const field of ['employment_type', 'availability']) {
    if (!Object.prototype.hasOwnProperty.call(input ?? {}, field)) continue
    const normalized = normalizeExtractedField(field, input[field])
    if (normalized) preferenceValues[field] = normalized
  }
  return {
    ...result,
    value: {
      ...result.value,
      ...preferenceValues
    }
  }
}

function buildSuggestions(sourceValues, candidate, sourceEvidence = {}, provenance = {}) {
  const safeInput = Object.fromEntries(
    Object.entries(sourceValues).filter(([field, value]) => ALLOWED_UPDATE_FIELDS.has(field) && nonEmpty(value))
  )
  const { value } = sanitizeAttachmentPatch(safeInput)
  const suggestionValues = {
    ...value,
    ...(Object.prototype.hasOwnProperty.call(value, 'years_experience_raw')
      ? { years_experience: value.years_experience_raw }
      : {})
  }
  return Object.entries(suggestionValues)
    .filter(([field, suggested]) => field !== 'years_experience_raw' && ALLOWED_UPDATE_FIELDS.has(field) && nonEmpty(suggested))
    .flatMap(([field, suggested]) => {
      const current = candidateRawValue(candidate, field)
      const confidence = fieldConfidence(field, sourceValues)
      const evidence = field === 'phone' || field === 'email'
        ? contactEvidenceFromText(String(sourceEvidence[field] ?? ''), field, suggested)
        : cleanValue(sourceEvidence[field], 1000)
      if (!evidence) return []
      return [{
        field,
        value: suggested,
        confidence,
        evidence,
        source: provenance.source ?? 'deterministic_text',
        evidence_refs: evidenceRefsForText(evidence, provenance.pages),
        current_value: current,
        default_selected: !nonEmpty(current) && confidence !== 'low'
      }]
    })
}

function truncateAtKnownBoundary(value) {
  if (typeof value !== 'string') return value
  const markers = uniqueMarkers([...scanColonMarkers(value), ...scanStandaloneSectionMarkers(value)])
    .sort((left, right) => markerBoundaryStart(left) - markerBoundaryStart(right) || left.start - right.start)
  const boundary = markers[0]
  if (!boundary) return value
  const boundaryStart = markerBoundaryStart(boundary)
  if (boundaryStart > 0) return value.slice(0, boundaryStart)
  // Model gateways sometimes echo the label together with its value.  Strip
  // that leading label and stop at the next physical marker boundary. Scalar
  // values also remain limited to the same physical line, except for the
  // explicitly multiline self-summary field.
  const nextBoundary = markers
    .slice(1)
    .map(markerBoundaryStart)
    .find((start) => start >= boundary.end)
  const lineEnd = value.indexOf('\n', boundary.end)
  const end = boundary.descriptor?.fields?.has('self_summary')
    ? (nextBoundary ?? value.length)
    : Math.min(
        nextBoundary ?? value.length,
        lineEnd < 0 ? value.length : lineEnd
      )
  return value.slice(boundary.end, end)
}

function recordSourceCorpus(record) {
  return [
    String(record.source_corpus ?? ''),
    ...Object.values(record.source_values ?? {}).flatMap((value) => (
      Array.isArray(value) ? value.map(String) : [String(value ?? '')]
    )),
    ...(record.sections ?? []).map((section) => String(section.content ?? ''))
  ].filter(Boolean).join('\n')
}

function sourceEvidence(corpus, value, proposedEvidence) {
  const evidence = cleanEvidenceSegment(proposedEvidence, 1000)
  const needles = (Array.isArray(value) ? value : [value])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
  if (!needles.length) return null
  const evidenceText = normalizedEvidenceText(evidence)
  const normalizedNeedles = needles.map(normalizedEvidenceText).filter(Boolean)
  if (evidence && corpus.includes(evidence) && normalizedNeedles.every((needle) => evidenceText.includes(needle))) {
    return evidence
  }
  const occurrences = needles.map((needle) => ({ needle, index: corpus.indexOf(needle) }))
  if (occurrences.some(({ index }) => index < 0)) return null
  const first = Math.min(...occurrences.map(({ index }) => index))
  const last = Math.max(...occurrences.map(({ index, needle }) => index + needle.length))
  if (last - first > 840) return null
  const derived = cleanEvidenceSegment(
    corpus.slice(Math.max(0, first - 80), Math.min(corpus.length, last + 80)),
    1_000
  )
  const derivedText = normalizedEvidenceText(derived)
  return derived && normalizedNeedles.every((needle) => derivedText.includes(needle)) ? derived : null
}

function visualEvidence(item, pages, value, { requireCompleteValue = false } = {}) {
  const proposedRef = Array.isArray(item?.evidence_refs) ? item.evidence_refs[0] : null
  const pageNumber = Number.isInteger(item?.page) ? item.page : proposedRef?.page
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null
  const page = (Array.isArray(pages) ? pages : []).find((entry) => entry?.page_number === pageNumber)
  if (!page) return null
  const evidence = cleanEvidenceSegment(item.evidence ?? proposedRef?.text, 1_000)
  if (!evidence) return null
  const evidenceText = normalizedEvidenceText(evidence)
  const pageTextSource = String(page.text ?? '')
  const pageText = normalizedEvidenceText(pageTextSource)
  const values = (Array.isArray(value) ? value : [value])
    .map(normalizedEvidenceText)
    .filter(Boolean)
  const completeValueEvidence = values.length > 0 && values.every((entry) => evidenceText.includes(entry))
  const partialValueEvidence = values.some((entry) => entry.includes(evidenceText))
  if (!evidenceText || values.length === 0 || (!completeValueEvidence && !partialValueEvidence) ||
    (requireCompleteValue && !completeValueEvidence)) {
    return null
  }
  // A page containing only a short prefix cannot verify a longer model value.
  // Sections may still remain as explicit unverified review candidates, but
  // they cannot become default-selected or replace deterministic content.
  const textVerified = Boolean(completeValueEvidence && pageText && pageText.includes(evidenceText))
  const refs = evidenceRefsForText(evidence, pages, pageNumber)
  return {
    evidence,
    refs,
    textVerified,
    evidence_status: textVerified ? 'text_verified' : 'unverified',
    pageText: pageTextSource
  }
}

const VISUAL_STRUCTURED_FIELD_LIMITS = Object.freeze({
  organization: 300,
  role: 300,
  start_date: 80,
  end_date: 80,
  period: 160
})

function verifiedVisualStructuredData(item, visualProof) {
  // A visual-only snippet may be useful for manual review, but it cannot
  // establish a company/role/period relationship until the same evidence is
  // present in the PDF text layer. Ignore unknown keys and values that are not
  // literally auditable in that evidence; never copy model coordinates.
  if (!visualProof?.textVerified) return {}
  const raw = item?.structured_data
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const pageLines = String(visualProof.pageText ?? '')
    .split(/\r?\n/u)
    .map(normalizedEvidenceText)
    .filter(Boolean)
  const candidates = []
  for (const [field, maximum] of Object.entries(VISUAL_STRUCTURED_FIELD_LIMITS)) {
    const candidate = cleanResumeSegment(raw[field], maximum)
    if (!candidate) continue
    const normalized = normalizedEvidenceText(candidate)
    if (!normalized) continue
    candidates.push({ field, candidate, normalized })
  }
  const auditableCandidates = candidates.filter(({ normalized }) => pageLines.some((line) => line.includes(normalized)))
  if (!auditableCandidates.length) return {}
  const bindingLine = pageLines.find((line) => auditableCandidates.every(({ normalized }) => line.includes(normalized)))
  return bindingLine
    ? Object.fromEntries(auditableCandidates.map(({ field, candidate }) => [field, candidate]))
    : {}
}

const CURRENT_ROLE_MARKER_PATTERN = /(?:当前|现任|在职|至今|现在|\b(?:present|current|now)\b)/iu
const HISTORICAL_DATE_RANGE_PATTERN = /(?:19|20)\d{2}(?:(?:[./-]\d{1,2}){1,2}|年(?:\d{1,2}月(?:\d{1,2}日)?)?)?\s*[-\u2013\u2014~至]\s*(?:19|20)\d{2}(?:(?:[./-]\d{1,2}){1,2}|年(?:\d{1,2}月(?:\d{1,2}日)?)?)?/u

function visualCurrentRoleIsExplicit(field, evidence, value) {
  if (field !== 'current_company' && field !== 'current_title') return true
  const normalizedValue = normalizedEvidenceText(value)
  if (!normalizedValue) return false
  if (HISTORICAL_DATE_RANGE_PATTERN.test(String(evidence ?? ''))) return false
  const clauses = String(evidence ?? '')
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?:[;；。！？!?]+|(?<=\.)\s+(?=[A-Za-z]))/u))
    .map(normalizedEvidenceText)
    .filter(Boolean)
  return clauses.some((clause) => (
    clause.includes(normalizedValue) &&
    CURRENT_ROLE_MARKER_PATTERN.test(clause)
  ))
}

function channelConflict(existing, incoming, evidenceRefs, evidenceStatus) {
  return {
    code: 'channel_value_conflict',
    source: 'visual',
    existing_source: existing.source ?? 'deterministic_text',
    existing_value: existing.value,
    proposed_value: incoming,
    evidence_status: evidenceStatus,
    evidence_refs: evidenceRefs,
    message: '文本与视觉通道结果不一致，已保留文本结果并取消默认选择'
  }
}

function mergeModelSuggestions(baseRecord, modelRecord, options = {}) {
  if (!modelRecord || typeof modelRecord !== 'object') return baseRecord
  const source = options.source === 'visual' ? 'visual' : 'model_text'
  const pages = Array.isArray(options.pages) ? options.pages : []
  const visual = source === 'visual'
  const corpus = recordSourceCorpus(baseRecord)
  const suggestionsByField = new Map((baseRecord.suggestions ?? []).map((item) => [item.field, item]))
  if (Array.isArray(modelRecord.suggestions)) {
    for (const item of modelRecord.suggestions.slice(0, ALLOWED_UPDATE_FIELDS.size)) {
      if (!item || !ALLOWED_UPDATE_FIELDS.has(item.field) || !nonEmpty(item.value)) continue
      if (!['high', 'medium', 'low'].includes(item.confidence)) continue
      const contactField = item.field === 'phone' || item.field === 'email'
      // The visual channel may help with layout, but identity always comes
      // from deterministic text normalization and exact database matching.
      if (visual && contactField) continue
      if (contactField && (
        baseRecord.identity_candidates?.ambiguous === true ||
        baseRecord.match?.status === 'multiple_matches' ||
        baseRecord.match?.status === 'identity_conflict'
      )) continue
      // Contact model values must be a single token. Do not salvage a value
      // from prose, since that can silently choose the wrong candidate.
      const boundedValue = contactField
        ? strictContactCandidate(item.field, item.value)
        : ['tags', 'desired_titles', 'desired_locations'].includes(item.field) && Array.isArray(item.value)
          ? item.value
              .map((entry) => cleanResumeSegment(entry, 1_000))
              .filter((entry) => nonEmpty(entry) && !isLikelyAttachmentNoiseToken(entry))
          : cleanResumeSegment(truncateAtKnownBoundary(String(item.value)), FIELD_LIMITS[item.field] ?? 20_000)
      if (!nonEmpty(boundedValue)) continue
      const visualProof = visual ? visualEvidence(item, pages, boundedValue, { requireCompleteValue: true }) : null
      const evidence = visual
        ? visualProof?.evidence
        : contactField
          ? contactEvidenceFromText(corpus, item.field, boundedValue, item.evidence)
          : sourceEvidence(corpus, boundedValue, item.evidence)
      if (!evidence) continue
      if ((visual || source === 'model_text') && !visualCurrentRoleIsExplicit(item.field, evidence, boundedValue)) continue
      const { value, errors } = sanitizeAttachmentPatch({ [item.field]: boundedValue })
      const suggested = item.field === 'years_experience'
        ? value.years_experience_raw
        : value[item.field]
      if (errors.length || !nonEmpty(suggested)) continue
      const existing = suggestionsByField.get(item.field)
      if (existing) {
        if (!sameValue(item.field, existing.value, suggested)) {
          existing.default_selected = false
          existing.conflict = channelConflict(existing, suggested, visualProof?.refs ?? [], visualProof?.evidence_status)
        }
        continue
      }
      const current = baseRecord.current_values?.[item.field] ?? null
      suggestionsByField.set(item.field, {
        field: item.field,
        value: suggested,
        confidence: item.confidence,
        evidence,
        source,
        evidence_refs: visual ? visualProof.refs : evidenceRefsForText(evidence, pages),
        ...(visual ? { evidence_status: visualProof.evidence_status } : {}),
        current_value: current,
        default_selected: !nonEmpty(current) && item.confidence !== 'low' && (!visual || visualProof.textVerified)
      })
    }
  }
  const suggestions = [...suggestionsByField.values()]
  const baseSections = baseRecord.sections ?? []
  const verifiedModelSections = Array.isArray(modelRecord.sections)
    ? modelRecord.sections.flatMap((item) => {
        if (isScalarSummarySection(item)) return []
        const canonicalType = canonicalSectionType(item?.section_type)
        const definition = SECTION_DEFINITION_BY_TYPE.get(item?.section_type) ?? SECTION_DEFINITION_BY_TYPE.get(canonicalType)
        if (!definition || typeof item.content !== 'string' || !item.content.trim()) return []
        const bounded = cleanResumeSegment(truncateAtKnownBoundary(item.content), 50_000)
        if (!bounded) return []
        const visualProof = visual ? visualEvidence(item, pages, bounded) : null
        const sourceOffset = corpus.indexOf(bounded)
        if (visual ? !visualProof : sourceOffset < 0) return []
        return [{
          section_id: typeof item.section_id === 'string' ? item.section_id : randomUUID(),
          section_type: definition.section_type,
          title: definition.title,
          content: bounded,
          structured_data: {
            parser: PARSER_VERSION,
            ...(sourceOffset >= 0 ? { source_offset: sourceOffset } : {}),
            ...(visual ? { source_page: visualProof.refs[0]?.page } : {}),
            canonical_type: canonicalSectionType(definition.section_type),
            ...(visual ? verifiedVisualStructuredData(item, visualProof) : {})
          },
          confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'low',
          evidence: visual
            ? visualProof.evidence
            : sourceEvidence(corpus, bounded, item.evidence) ?? bounded.slice(0, 240),
          source,
          evidence_refs: visual ? visualProof.refs : evidenceRefsForText(item.evidence, pages),
          ...(visual ? { evidence_status: visualProof.evidence_status } : {}),
          default_selected: item.confidence !== 'low' && (!visual || visualProof.textVerified)
        }]
      }).slice(0, 50)
    : []
  const deterministicSections = baseSections.filter((section) => (
    !isScalarSummarySection(section) && section.structured_data?.fallback !== true
  ))
  let sections
  if (visual && verifiedModelSections.length) {
    // A visual-only (unverified) section is an additional review candidate,
    // never a replacement for deterministic text from the same canonical
    // section. Only page-text-verified sections may participate in the
    // existing visual boundary/conflict replacement flow.
    const verifiedVisualSections = verifiedModelSections.filter((section) => section.evidence_status === 'text_verified')
    const unverifiedVisualSections = verifiedModelSections.filter((section) => section.evidence_status !== 'text_verified')
    const consumedDeterministicIds = new Set()
    for (const section of verifiedVisualSections) {
      const sectionType = canonicalSectionType(section.section_type)
      const exact = deterministicSections.find((candidate) => (
        !consumedDeterministicIds.has(candidate.section_id) &&
        canonicalSectionType(candidate.section_type) === sectionType &&
        normalizedEvidenceText(candidate.content) === normalizedEvidenceText(section.content)
      ))
      if (exact) {
        consumedDeterministicIds.add(exact.section_id)
        section.source = 'merged'
        continue
      }
      const existing = deterministicSections.find((candidate) => canonicalSectionType(candidate.section_type) === sectionType)
      if (existing) {
        section.default_selected = false
        section.conflict = {
          code: 'visual_replaces_deterministic_section',
          source: 'visual',
          existing_source: existing.source ?? 'deterministic_text',
          existing_value: existing.content,
          proposed_value: section.content,
          evidence_status: section.evidence_status,
          evidence_refs: section.evidence_refs,
          message: '视觉通道建议调整该栏目边界，需人工核对后选择'
        }
      }
    }
    sections = [
      ...verifiedVisualSections,
      ...deterministicSections.filter((section) => !consumedDeterministicIds.has(section.section_id)),
      ...unverifiedVisualSections
    ]
  } else {
    sections = deterministicSections.length
      ? deterministicSections
      : (verifiedModelSections.length ? verifiedModelSections : baseSections.filter((section) => !isScalarSummarySection(section)))
    sections = sections.filter((section) => !isScalarSummarySection(section))
  }
  sections.sort((left, right) => {
    const leftOrder = Number(left.structured_data?.source_order)
    const rightOrder = Number(right.structured_data?.source_order)
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return leftOrder - rightOrder
    // Visual candidates intentionally precede deterministic sections in the
    // merge array. They carry page/evidence provenance rather than a text
    // offset, so a missing order must not push them to the end of the list.
    if (Number.isFinite(leftOrder) !== Number.isFinite(rightOrder)) return 0
    const leftOffset = Number(left.structured_data?.source_offset)
    const rightOffset = Number(right.structured_data?.source_offset)
    return (Number.isFinite(leftOffset) ? leftOffset : Number.MAX_SAFE_INTEGER) -
      (Number.isFinite(rightOffset) ? rightOffset : Number.MAX_SAFE_INTEGER)
  })
  sections.forEach((section, index) => {
    section.structured_data = { ...section.structured_data, source_order: index }
  })
  return { ...baseRecord, suggestions, sections }
}

function buildPreviewRecord(db, parsedRecord, index, format, requestedCandidateId, provenance = {}) {
  const values = parsedRecord?.values ?? {}
  const rawText = cleanValue(values.raw_text, 2_000_000)
  const labeledData = rawText ? extractLabeledCandidateData(rawText) : null
  const spreadsheetData = rawText ? null : spreadsheetRecordData(values)
  const identity = rawText ? extractTextIdentity(rawText, labeledData) : extractRowIdentity(values)
  const match = matchCandidateIdentity(db, identity)
  const requestedCandidate = requestedCandidateId
    ? db.prepare('SELECT * FROM candidates WHERE id = ?').get(requestedCandidateId)
    : null
  const suggestionCandidate = match.candidate_id
    ? db.prepare('SELECT * FROM candidates WHERE id = ?').get(match.candidate_id)
    : requestedCandidate
  const suggestionPreferences = suggestionCandidate
    ? db.prepare(`
        SELECT employment_status, desired_titles, desired_locations,
               employment_type, expected_salary, availability
        FROM candidate_preferences WHERE candidate_id = ?
      `).get(suggestionCandidate.id)
    : null
  const suggestionContext = suggestionCandidate
      ? {
        ...suggestionCandidate,
        job_seeking_status: suggestionPreferences?.employment_status ?? suggestionCandidate.job_seeking_status,
        expected_salary: suggestionPreferences?.expected_salary ?? suggestionCandidate.expected_salary,
        desired_titles: suggestionPreferences?.desired_titles ?? '[]',
        desired_locations: suggestionPreferences?.desired_locations ?? '[]',
        employment_type: suggestionPreferences?.employment_type ?? '',
        availability: suggestionPreferences?.availability ?? ''
      }
    : null
  const sections = (rawText ? extractResumeSections(rawText) : spreadsheetData.sections)
    .filter((section) => !isScalarSummarySection(section))
  const deterministicSource = rawText ? 'deterministic_text' : 'deterministic_table'
  for (const section of sections) {
    section.source = deterministicSource
    section.evidence_refs = evidenceRefsForText(section.evidence, provenance.pages)
  }
  const sourceValues = rawText
    ? textCandidateValues(rawText, identity, labeledData)
    : Object.fromEntries(Object.entries({
        ...spreadsheetData.values,
        phone: identity.phone,
        email: identity.email
      }).filter(([, value]) => nonEmpty(value)))
  const sourceEvidence = rawText
    ? {
        ...labeledData.evidence,
        phone: labeledData.evidence.phone ?? contactEvidenceFromText(rawText, 'phone', identity.phone),
        email: labeledData.evidence.email ?? contactEvidenceFromText(rawText, 'email', identity.email)
      }
    : spreadsheetData.evidence
  const suggestions = buildSuggestions(sourceValues, suggestionContext, sourceEvidence, {
    source: deterministicSource,
    pages: provenance.pages
  })
  return {
    record_id: randomUUID(),
    row_number: Number.isInteger(parsedRecord?.row_number) ? parsedRecord.row_number : index + 1,
    identity: { phone: identity.phone, email: identity.email },
    identity_candidates: {
      phones: identity.phone_candidates,
      emails: identity.email_candidates,
      ambiguous: identity.ambiguous
    },
    match,
    suggestions,
    sections,
    source_values: sourceValues,
    source_corpus: rawText ?? spreadsheetData.corpus,
    current_values: suggestionContext
      ? Object.fromEntries([...ALLOWED_UPDATE_FIELDS].map((field) => [field, candidateRawValue(suggestionContext, field)]))
      : {}
  }
}

function publicRecord(record) {
  return {
    record_id: record.record_id,
    row_number: record.row_number ?? null,
    identity: {
      phone: record.identity?.phone ?? '',
      email: record.identity?.email ?? ''
    },
    match: record.match,
    suggestions: record.suggestions ?? [],
    sections: (record.sections ?? []).filter((section) => !isScalarSummarySection(section)),
    avatar: record.avatar ?? { status: 'none', available: false, source: null, confidence: null, candidate_count: 0 }
  }
}

function redactAvatarValuesForModel(value, sensitiveValues = []) {
  let source = String(value ?? '')
  const secrets = [...new Set(sensitiveValues.map(String).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) source = source.replaceAll(secret, '[redacted]')
  return source
}

function redactAvatarValuesForStorage(value, sensitiveValues) {
  if (typeof value === 'string') return redactAvatarValuesForModel(value, sensitiveValues)
  if (Array.isArray(value)) {
    return value.map((item) => redactAvatarValuesForStorage(item, sensitiveValues))
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactAvatarValuesForStorage(item, sensitiveValues)])
  )
}

function preferredAvatarResult(explicit, embedded) {
  if (explicit?.status === 'ready' || explicit?.status === 'ambiguous') return explicit
  if (embedded?.status === 'ready' || embedded?.status === 'ambiguous') return embedded
  return explicit?.status === 'invalid' ? explicit : embedded ?? explicit
}

function publicAvatarProjection(result) {
  const projection = projectAttachmentAvatarSuggestion(result)
  // Embedded WebP is recognized but cannot be stripped of metadata without a
  // trusted decoder/re-encoder. Remote WebP URLs remain supported.
  if (
    projection.available && projection.content_type === 'image/webp' &&
    ['docx_embedded_image', 'pdf_embedded_image', 'xlsx_embedded_image'].includes(projection.source)
  ) {
    return { ...projection, status: 'invalid', available: false, confidence: null }
  }
  return projection
}

async function extractAttachmentAvatarResults(buffer, format, parsed) {
  const parsedRecords = Array.isArray(parsed?.records) ? parsed.records : []
  const explicit = parsedRecords.map((record) => extractExplicitAvatarSuggestion({
    text: record?.values?.raw_text ?? '',
    values: record?.values ?? {}
  }))
  let embedded = []
  try {
    if (format === 'pdf' && parsedRecords.length === 1) {
      embedded = [await extractPdfAvatarSuggestion(buffer)]
    } else if (format === 'docx' && parsedRecords.length === 1) {
      embedded = [await extractDocxAvatarSuggestion(buffer)]
    } else if (['xlsx', 'xlsm'].includes(format)) {
      const suggestions = await extractXlsxAvatarSuggestions(buffer)
      const byRow = new Map(suggestions.map((suggestion) => [
        `${suggestion.sheet_name}\u0000${suggestion.row_number}`,
        suggestion
      ]))
      embedded = parsedRecords.map((record) => byRow.get(
        `${parsed?.metadata?.sheet_name ?? ''}\u0000${record?.row_number ?? ''}`
      ))
    }
  } catch {
    // Avatar extraction is optional. A malformed or ambiguous image must not
    // make otherwise valid resume text unavailable.
  }
  return parsedRecords.map((_, index) => preferredAvatarResult(explicit[index], embedded[index]))
}

function releaseAvatarResult(result) {
  const references = new Set([
    result?.reference,
    ...(Array.isArray(result?.references) ? result.references : [])
  ].filter(Boolean))
  for (const reference of references) releasePrivateAttachmentAvatar(reference)
}

function assertInside(root, candidatePath) {
  const rootPath = resolve(root)
  const path = resolve(candidatePath)
  const relativePath = relative(rootPath, path)
  const within = relativePath !== ''
    && !isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
  if (!within) throw attachmentError(500, 'unsafe_storage_path', '附件存储路径不在受控目录内')
  return path
}

function attachmentExtension(format) {
  return `.${format}`
}

function attachmentRow(row) {
  return row ? {
    id: row.id,
    candidate_id: row.candidate_id,
    original_filename: sanitizeOriginalFilename(row.original_filename),
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    sha256: row.sha256,
    attachment_type: row.attachment_type,
    parse_status: row.parse_status,
    parser_version: row.parser_version,
    source: row.source,
    import_batch_id: row.import_batch_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    download_url: `/api/attachments/${encodeURIComponent(row.id)}/download`
  } : null
}

function safeJson(value) {
  return JSON.stringify(value ?? null)
}

function sameValue(field, left, right) {
  if (field === 'tags' || field === 'desired_titles' || field === 'desired_locations') {
    return safeJson(left ?? []) === safeJson(right ?? [])
  }
  return (left ?? null) === (right ?? null)
}

function mergeTags(current, incoming) {
  return unique([...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]).slice(0, 50)
}

function recordIdentity(record) {
  const phones = record.identity_candidates?.phones ?? (record.identity?.phone ? [record.identity.phone] : [])
  const emails = record.identity_candidates?.emails ?? (record.identity?.email ? [record.identity.email] : [])
  return normalizedIdentity({ phone_candidates: phones, email_candidates: emails })
}

function revalidateIdentity(db, record, candidateId) {
  const match = matchCandidateIdentity(db, recordIdentity(record))
  if (['identity_conflict', 'multiple_matches'].includes(match.status)) {
    throw attachmentError(409, match.status, match.reason, { record_id: record.record_id })
  }
  if (match.candidate_id && match.candidate_id !== candidateId) {
    throw attachmentError(409, 'identity_conflict', '身份字段已精确命中其他候选人，整批未更新', {
      record_id: record.record_id
    })
  }
}

function validateSelectedList(value, allowed, field) {
  if (!Array.isArray(value)) throw attachmentError(422, 'validation_error', `${field} 必须是数组`)
  const result = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !allowed.has(item) || result.includes(item)) {
      throw attachmentError(422, 'validation_error', `${field} 包含无效或重复值`, { field: `${field}.${index}` })
    }
    result.push(item)
  }
  return result
}

function sectionSignature(section) {
  return createHash('sha256')
    .update(`${canonicalSectionType(section.section_type) ?? ''}\u0000${cleanValue(section.title, 300) ?? ''}\u0000${cleanValue(section.content, 50_000) ?? ''}`, 'utf8')
    .digest('hex')
}

function existingSectionSignatures(db, candidateId) {
  return new Set(db.prepare(`
    SELECT section_type, title, content FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL
  `).all(candidateId).map(sectionSignature))
}

function semanticSectionTypes(sectionType) {
  const canonicalType = canonicalSectionType(sectionType)
  return SECTION_TYPE_FAMILIES[canonicalType] ?? new Set([canonicalType].filter(Boolean))
}

function isImportedSection(section) {
  if (nonEmpty(section.source_record_id)) return true
  const structured = parseJson(section.structured_data, {})
  return nonEmpty(structured?.attachment_id)
}

function updateCandidateFields(db, candidate, record, selectedFields, attachmentId, timestamp) {
  const suggestions = new Map((record.suggestions ?? []).map((item) => [item.field, item]))
  const rawPatch = {}
  for (const field of selectedFields) {
    const value = suggestions.get(field)?.value
    if (nonEmpty(value)) rawPatch[field] = value
  }
  const { value: sanitized, errors } = sanitizeAttachmentPatch(rawPatch)
  if (errors.length) throw attachmentError(422, 'validation_error', '附件建议字段格式无效', errors)

  const currentPreferences = db.prepare(`
    SELECT employment_status, desired_titles, desired_locations,
           employment_type, expected_salary, availability, raw_payload
    FROM candidate_preferences WHERE candidate_id = ?
  `).get(candidate.id)
  const current = {
    ...candidate,
    tags: parseJson(candidate.tags, []),
    desired_titles: parseJson(currentPreferences?.desired_titles, []),
    desired_locations: parseJson(currentPreferences?.desired_locations, []),
    employment_type: currentPreferences?.employment_type ?? null,
    availability: currentPreferences?.availability ?? null
  }
  // Older/manual candidates may have these values only on the main record.
  // Seed a newly-created preferences row from the effective displayed value
  // so updating an unrelated preference never clears an unselected field.
  const currentEmploymentStatus = currentPreferences?.employment_status ?? current.job_seeking_status ?? null
  const currentExpectedSalary = currentPreferences?.expected_salary ?? current.expected_salary ?? null
  const patch = {}
  for (const [field, suggested] of Object.entries(sanitized)) {
    const workYearsPairField = field === 'years_experience' || field === 'years_experience_raw'
    if (!ALLOWED_UPDATE_FIELDS.has(field) || (!nonEmpty(suggested) && !workYearsPairField)) continue
    patch[field] = field === 'tags'
      ? mergeTags(current.tags, suggested)
      : suggested
  }

  for (const field of ['phone', 'email']) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    const conflicts = queryIdentity(db, field, patch[field]).filter((row) => row.id !== candidate.id)
    if (conflicts.length) {
      throw attachmentError(409, 'identity_conflict', `${field === 'phone' ? '手机号' : '邮箱'}已属于其他候选人，整批未更新`, {
        record_id: record.record_id,
        field
      })
    }
  }

  const changed = Object.entries(patch).filter(([field, next]) => {
    if (field === 'expected_salary') {
      return !sameValue(field, current[field], next) || (
        currentPreferences && !sameValue(field, currentPreferences.expected_salary, next)
      )
    }
    if (field === 'job_seeking_status') {
      return !sameValue(field, current[field], next) || (
        currentPreferences && !sameValue('employment_status', currentPreferences.employment_status, next)
      )
    }
    return !sameValue(field, current[field], next)
  })
  if (!changed.length) return []
  const candidateChanges = changed.filter(([field]) => (
    !['desired_titles', 'desired_locations', 'employment_type', 'availability'].includes(field)
  ))
  if (candidateChanges.length) {
    const assignments = candidateChanges.map(([field]) => `${field} = ?`)
    assignments.push('updated_at = ?')
    db.prepare(`UPDATE candidates SET ${assignments.join(', ')} WHERE id = ?`).run(
      ...candidateChanges.map(([field, next]) => field === 'tags' ? JSON.stringify(next) : next),
      timestamp,
      candidate.id
    )
  }
  const employmentStatus = changed.find(([field]) => field === 'job_seeking_status')?.[1]
  const expectedSalary = changed.find(([field]) => field === 'expected_salary')?.[1]
  const desiredTitles = changed.find(([field]) => field === 'desired_titles')?.[1]
  const desiredLocations = changed.find(([field]) => field === 'desired_locations')?.[1]
  const employmentType = changed.find(([field]) => field === 'employment_type')?.[1]
  const availability = changed.find(([field]) => field === 'availability')?.[1]
  if (
    employmentStatus !== undefined || expectedSalary !== undefined || desiredTitles !== undefined ||
    desiredLocations !== undefined || employmentType !== undefined || availability !== undefined
  ) {
    const nextEmploymentStatus = employmentStatus ?? currentEmploymentStatus
    const nextExpectedSalary = expectedSalary ?? currentExpectedSalary
    const nextDesiredTitles = desiredTitles ?? current.desired_titles
    const nextDesiredLocations = desiredLocations ?? current.desired_locations
    const nextEmploymentType = employmentType ?? current.employment_type ?? null
    const nextAvailability = availability ?? current.availability ?? null
    const nextRawPayload = currentPreferences?.raw_payload ?? '{}'
    db.prepare(`
      INSERT INTO candidate_preferences(
        candidate_id, employment_status, desired_titles, desired_locations,
        employment_type, expected_salary, availability, raw_payload, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        employment_status = excluded.employment_status,
        desired_locations = excluded.desired_locations,
        employment_type = excluded.employment_type,
        expected_salary = excluded.expected_salary,
        desired_titles = excluded.desired_titles,
        availability = excluded.availability,
        raw_payload = excluded.raw_payload,
        updated_at = excluded.updated_at
    `).run(
      candidate.id,
      nextEmploymentStatus,
      JSON.stringify(nextDesiredTitles),
      JSON.stringify(nextDesiredLocations),
      nextEmploymentType,
      nextExpectedSalary,
      nextAvailability,
      nextRawPayload,
      timestamp
    )
  }
  const insertSource = db.prepare(`
    INSERT INTO candidate_field_sources(
      id, candidate_id, field_name, attachment_id, parser_version,
      previous_value, new_value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const [field, next] of changed) {
    const previous = field === 'job_seeking_status'
      ? currentEmploymentStatus
      : ['desired_titles', 'desired_locations', 'employment_type', 'availability'].includes(field)
        ? current[field]
        : field === 'expected_salary'
          ? currentExpectedSalary
          : current[field]
    insertSource.run(
      randomUUID(), candidate.id, field, attachmentId, PARSER_VERSION,
      safeJson(previous), safeJson(next), timestamp
    )
  }
  return changed.map(([field]) => field)
}

function applySections(db, candidateId, record, selectedSectionIds, attachmentId, timestamp, mergeMode, confirmReplace) {
  const selectedIds = new Set(selectedSectionIds)
  const selected = (record.sections ?? []).filter((section) => (
    selectedIds.has(section.section_id) && !isScalarSummarySection(section)
  ))
  if (!selected.length) return []
  if (mergeMode === 'replace') {
    if (!confirmReplace) throw attachmentError(422, 'replace_confirmation_required', '整体替换履历必须单独确认')
  }

  const normalizedSections = selected.flatMap((section, sourceIndex) => {
    const originalSectionType = cleanValue(section.section_type, 80)
    if (isScalarSummarySection(section)) return []
    const canonicalType = canonicalSectionType(originalSectionType)
    const normalized = {
      section_type: canonicalType,
      title: cleanValue(section.title, 300),
      content: cleanResumeSegment(section.content, 50_000),
      structured_data: section.structured_data && typeof section.structured_data === 'object'
        ? {
            ...section.structured_data,
            canonical_type: canonicalType,
            ...(originalSectionType && originalSectionType !== canonicalType
              ? { semantic_type: originalSectionType }
              : {})
          }
        : {},
      source_order: Number.isInteger(section.structured_data?.source_order)
        ? section.structured_data.source_order
        : sourceIndex
    }
    return normalized.section_type && CANONICAL_PROFILE_SECTION_TYPES.has(normalized.section_type) && normalized.content
      ? [normalized]
      : []
  }).sort((left, right) => left.source_order - right.source_order)
  if (!normalizedSections.length) return []

  const replacementTypes = new Set()
  for (const section of normalizedSections) {
    for (const type of semanticSectionTypes(section.section_type)) replacementTypes.add(type)
  }
  const activeSections = db.prepare(`
    SELECT id, section_type, title, content, structured_data, source_record_id, sort_order, created_at
    FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL
    ORDER BY sort_order, created_at, id
  `).all(candidateId)
  const desiredSignatures = new Set(normalizedSections.map(sectionSignature))
  const manualSignatures = new Set(activeSections
    .filter((section) => !isImportedSection(section))
    .map(sectionSignature))
  const retainedImportedBySignature = new Map()
  const archivedIds = []
  for (const section of activeSections) {
    if (!replacementTypes.has(section.section_type) || !isImportedSection(section)) continue
    const signature = sectionSignature(section)
    if (
      desiredSignatures.has(signature) &&
      !manualSignatures.has(signature) &&
      !retainedImportedBySignature.has(signature)
    ) {
      retainedImportedBySignature.set(signature, section.id)
      continue
    }
    archivedIds.push(section.id)
  }
  if (archivedIds.length) {
    const placeholders = archivedIds.map(() => '?').join(', ')
    db.prepare(`
      UPDATE candidate_profile_sections SET archived_at = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(timestamp, timestamp, ...archivedIds)
  }

  const signatures = existingSectionSignatures(db, candidateId)
  const inserted = []
  const appliedIds = []
  const appliedIdSet = new Set()
  const insert = db.prepare(`
    INSERT INTO candidate_profile_sections(
      id, candidate_id, section_type, title, content, structured_data, sort_order,
      sensitivity, source_record_id, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?, ?, NULL)
  `)
  for (const normalized of normalizedSections) {
    const signature = sectionSignature(normalized)
    const retainedId = retainedImportedBySignature.get(signature)
    if (retainedId) {
      if (!appliedIdSet.has(retainedId)) {
        appliedIdSet.add(retainedId)
        appliedIds.push(retainedId)
      }
      continue
    }
    if (signatures.has(signature)) continue
    signatures.add(signature)
    const id = randomUUID()
    insert.run(
      id, candidateId, normalized.section_type, normalized.title, normalized.content,
      JSON.stringify({
        ...normalized.structured_data,
        source_order: normalized.source_order,
        attachment_id: attachmentId,
        parser_version: PARSER_VERSION
      }),
      inserted.length, `attachment:${attachmentId}`, timestamp, timestamp
    )
    inserted.push(id)
    appliedIdSet.add(id)
    appliedIds.push(id)
  }

  const archivedSet = new Set(archivedIds)
  const survivorIds = activeSections.filter((section) => !archivedSet.has(section.id)).map((section) => section.id)
  const finalOrder = [...appliedIds, ...survivorIds.filter((id) => !appliedIdSet.has(id))]
  const reorder = db.prepare(`
    UPDATE candidate_profile_sections SET sort_order = ?, updated_at = ?
    WHERE id = ? AND candidate_id = ? AND archived_at IS NULL
  `)
  for (const [sortOrder, sectionId] of finalOrder.entries()) {
    reorder.run(sortOrder, timestamp, sectionId, candidateId)
  }
  return inserted
}

function normalizeAttachmentCreateSections(input, sourceRecordId) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    throw attachmentError(422, 'validation_error', 'profile_sections 必须是数组')
  }
  if (input.length > MAX_PROFILE_SECTIONS) {
    throw attachmentError(413, 'limit_exceeded', `单次最多保存 ${MAX_PROFILE_SECTIONS} 个资料区块`)
  }

  const normalized = []
  const signatures = new Set()
  for (const [index, section] of input.entries()) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw attachmentError(422, 'validation_error', `profile_sections.${index} 无效`)
    }
    const rawType = typeof section.section_type === 'string' ? section.section_type.trim() : ''
    if (!rawType) {
      throw attachmentError(422, 'validation_error', `profile_sections.${index}.section_type 无效`)
    }
    // Self summaries belong to candidates.self_summary. Older preview clients
    // may still send the semantic section, so ignore it instead of duplicating
    // the same text in a profile section.
    if (isScalarSummarySection({ section_type: rawType, structured_data: section.structured_data })) continue
    const sectionType = canonicalSectionType(rawType)
    if (!sectionType || !CANONICAL_PROFILE_SECTION_TYPES.has(sectionType)) {
      throw attachmentError(422, 'validation_error', `profile_sections.${index}.section_type 无效`)
    }

    if (section.title != null && typeof section.title !== 'string') {
      throw attachmentError(422, 'validation_error', `profile_sections.${index}.title 无效`)
    }
    if (section.content != null && typeof section.content !== 'string') {
      throw attachmentError(422, 'validation_error', `profile_sections.${index}.content 无效`)
    }
    if ((section.title?.length ?? 0) > 300 || (section.content?.length ?? 0) > 100_000) {
      throw attachmentError(422, 'validation_error', `profile_sections.${index} 文本超过限制`)
    }
    const title = cleanValue(section.title, 300) ?? sectionTitle(sectionType)
    const content = cleanExtractedSegment(section.content, 100_000)

    let structuredData = {}
    if (section.structured_data != null) {
      if (typeof section.structured_data !== 'object' || Array.isArray(section.structured_data)) {
        throw attachmentError(422, 'validation_error', `profile_sections.${index}.structured_data 必须是对象`)
      }
      let encoded
      try {
        encoded = JSON.stringify(section.structured_data)
      } catch {
        throw attachmentError(422, 'validation_error', `profile_sections.${index}.structured_data 无效`)
      }
      if (encoded.length > 200_000) {
        throw attachmentError(413, 'limit_exceeded', `profile_sections.${index}.structured_data 超过大小限制`)
      }
      structuredData = JSON.parse(encoded)
    }
    if (!content && Object.keys(structuredData).length === 0) continue

    const sensitivity = section.sensitivity == null
      ? 'internal'
      : String(section.sensitivity).trim().toLowerCase()
    if (!['public', 'internal', 'high'].includes(sensitivity)) {
      throw attachmentError(422, 'validation_error', `profile_sections.${index}.sensitivity 无效`)
    }
    const sortOrder = Number.isInteger(section.sort_order) && section.sort_order >= 0 && section.sort_order <= 10_000
      ? section.sort_order
      : index
    const canonicalStructuredData = rawType === sectionType
      ? structuredData
      : { ...structuredData, semantic_type: rawType }
    const signature = JSON.stringify([sectionType, title, content, canonicalStructuredData])
    if (signatures.has(signature)) continue
    signatures.add(signature)
    normalized.push({
      id: randomUUID(),
      section_type: sectionType,
      title,
      content,
      structured_data: canonicalStructuredData,
      sort_order: sortOrder,
      sensitivity,
      source_record_id: `${sourceRecordId}:profile-section:${normalized.length}`
    })
  }
  return normalized.sort((left, right) => left.sort_order - right.sort_order)
}

function insertAttachmentCreateSections(db, candidateId, sections, timestamp) {
  if (!sections.length) return
  const insert = db.prepare(`
    INSERT INTO candidate_profile_sections(
      id, candidate_id, section_type, title, content, structured_data,
      sort_order, sensitivity, source_record_id, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `)
  for (const [sortOrder, section] of sections.entries()) {
    insert.run(
      section.id,
      candidateId,
      section.section_type,
      section.title,
      section.content,
      JSON.stringify(section.structured_data),
      sortOrder,
      section.sensitivity,
      section.source_record_id,
      timestamp,
      timestamp
    )
  }
  addActivity(db, candidateId, 'profile_sections_updated', '更新人才资料区块', {
    section_count: sections.length,
    source: 'attachment_preview'
  })
}

export function createAttachmentService({
  db,
  rootDir,
  parser = parseAttachment,
  suggestionProvider,
  visualSuggestionProvider,
  previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
  clock = Date.now,
  removeRootOnClose = false,
  cleanupIntervalMs = 60_000,
  parseConcurrency = DEFAULT_PARSE_CONCURRENCY,
  visualSuggestionTimeoutMs = ATTACHMENT_VISUAL_SUGGESTION_TIMEOUT_MS
} = {}) {
  if (!db) throw new TypeError('db is required')
  if (!rootDir) throw new TypeError('rootDir is required')
  if (!Number.isInteger(previewTtlMs) || previewTtlMs < 1 || previewTtlMs > 60 * 60 * 1000) {
    throw new TypeError('previewTtlMs must be between 1 and 3600000')
  }
  if (!Number.isInteger(parseConcurrency) || parseConcurrency < 1 || parseConcurrency > 8) {
    throw new TypeError('parseConcurrency must be between 1 and 8')
  }
  if (!Number.isInteger(visualSuggestionTimeoutMs) || visualSuggestionTimeoutMs < 1 || visualSuggestionTimeoutMs > 5 * 60 * 1000) {
    throw new TypeError('visualSuggestionTimeoutMs must be between 1 and 300000')
  }
  const root = resolve(rootDir)
  const quarantineRoot = resolve(root, 'quarantine')
  const filesRoot = resolve(root, 'files')
  mkdirSync(quarantineRoot, { recursive: true })
  mkdirSync(filesRoot, { recursive: true })
  const rawTokens = new Map()
  const privateAvatarResults = new Map()
  const parseJobs = new Map()
  const parseQueue = []
  let activeParses = 0
  let closing = false
  let cancelScheduledParse = () => false

  const visualProviderStatus = () => {
    if (visualSuggestionProvider && typeof visualSuggestionProvider.status === 'function') {
      try { return visualSuggestionProvider.status() } catch {}
    }
    return null
  }

  const invokeVisualSuggestionProvider = (input, signal) => {
    if (typeof visualSuggestionProvider === 'function') return visualSuggestionProvider(input, { signal })
    if (visualSuggestionProvider && typeof visualSuggestionProvider.suggest === 'function') {
      return visualSuggestionProvider.suggest(input, { signal })
    }
    return null
  }

  const visualCapabilityEnabled = () => {
    if (!visualSuggestionProvider) return false
    if (visualSuggestionProvider.enabled === true) return true
    const status = visualProviderStatus()
    if (status) return status.status === 'enabled'
    // Explicitly injected in-process providers are already inside the fixed
    // attachment service boundary; their absence of a status method is not an
    // ambient capability grant.
    return typeof visualSuggestionProvider === 'function'
      || typeof visualSuggestionProvider.suggest === 'function'
  }

  const enqueueCleanup = (storagePath, reason, createdAt = now()) => {
    const id = randomUUID()
    db.prepare(`
      INSERT OR IGNORE INTO attachment_cleanup_jobs(
        id, storage_path, reason, attempts, last_error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 0, NULL, ?, ?, NULL)
    `).run(id, storagePath, reason, createdAt, createdAt)
    const job = db.prepare(`
      SELECT * FROM attachment_cleanup_jobs
      WHERE storage_path = ? AND completed_at IS NULL
      ORDER BY created_at, id LIMIT 1
    `).get(storagePath)
    if (!job) throw attachmentError(503, 'attachment_cleanup_enqueue_failed', '附件清理任务无法入队，请稍后重试')
    return job
  }

  const safeDeleteOrQueue = (storagePath, reason) => {
    if (!storagePath) return true
    try {
      const path = assertInside(root, storagePath)
      unlinkSync(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      enqueueCleanup(storagePath, reason)
      return false
    }
  }

  const readPreview = (id) => db.prepare('SELECT * FROM attachment_update_previews WHERE id = ?').get(id)

  const persistCreatedCandidateMatch = (previewId, recordId, candidate, updatedAt = new Date(clock()).toISOString()) => {
    if (!candidate?.id) throw attachmentError(409, 'candidate_not_found', '新建候选人状态不可用，请刷新后重试')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = readPreview(previewId)
      if (!row || row.parse_status !== 'parsed' || row.consumed_at) {
        throw attachmentError(409, 'attachment_preview_not_ready', '附件预览状态已变化，请刷新后重试')
      }
      const records = parseJson(row.records_json, [])
      const recordIndex = records.findIndex((item) => item.record_id === recordId)
      if (recordIndex < 0) throw attachmentError(422, 'validation_error', 'record_id 不属于当前附件预览')
      const currentMatch = records[recordIndex].match ?? {}
      if (currentMatch.resolution === 'created') {
        if (currentMatch.candidate_id === candidate.id) return true
        throw attachmentError(409, 'attachment_candidate_resolution_conflict', '附件记录已关联其他新建候选人')
      }
      if (currentMatch.status !== 'not_found') {
        throw attachmentError(409, 'attachment_candidate_create_blocked', '只有未匹配记录可以创建新候选人')
      }
      records[recordIndex] = {
        ...records[recordIndex],
        match: {
          ...currentMatch,
          candidate_id: candidate.id,
          candidate: candidateView(candidate),
          resolution: 'created',
          reason: '已从当前附件创建候选人，等待确认附件关联'
        },
        suggestions: (records[recordIndex].suggestions ?? []).map((suggestion) => ({
          ...suggestion,
          default_selected: false
        }))
      }
      const result = db.prepare(`
        UPDATE attachment_update_previews
        SET records_json = ?, updated_at = ?
        WHERE id = ? AND parse_status = 'parsed' AND consumed_at IS NULL AND records_json = ?
      `).run(JSON.stringify(records), updatedAt, previewId, row.records_json)
      if (result.changes === 1) return true
    }
    throw attachmentError(409, 'attachment_preview_state_changed', '附件预览状态已变化，请刷新后重试')
  }

  const assertPreviewAccess = (id, previewToken) => {
    const row = readPreview(id)
    if (!row) throw attachmentError(404, 'not_found', '附件预览不存在')
    if (typeof previewToken !== 'string' || tokenHash(previewToken) !== row.token_hash) {
      throw attachmentError(403, 'attachment_preview_token_invalid', '附件预览令牌无效')
    }
    return true
  }

  const releasePreviewAvatars = (id) => {
    const results = privateAvatarResults.get(id)
    if (!results) return
    for (const result of results.values()) releaseAvatarResult(result)
    privateAvatarResults.delete(id)
  }

  const releaseRecordAvatar = (previewId, recordId, result = null) => {
    const retained = privateAvatarResults.get(previewId)
    const retainedResult = retained?.get(recordId)
    if (result) releaseAvatarResult(result)
    if (retainedResult && retainedResult !== result) releaseAvatarResult(retainedResult)
    retained?.delete(recordId)
    if (retained?.size === 0) privateAvatarResults.delete(previewId)
  }

  const serializePreview = (row) => {
    if (!row) return null
    const storedRecords = parseJson(row.records_json, [])
    const records = (Array.isArray(storedRecords) ? storedRecords : []).map(publicRecord)
    const storedPipeline = Array.isArray(storedRecords) ? storedRecords[0]?._pipeline : null
    const pipeline = storedPipeline && typeof storedPipeline === 'object'
      ? storedPipeline
      : {
          text: { status: row.parse_status === 'parsed' ? 'ready' : row.parse_status, content_type: row.format },
          text_model: { status: suggestionProvider ? 'pending' : 'not_run' },
          visual: {
            status: row.format === 'pdf' ? 'not_run' : 'not_applicable',
            used_fallback: false
          },
          review_required: row.format === 'pdf'
        }
    // Only the token hash is durable. A client that crosses a service restart
    // must retain the raw token issued by createPreview.
    const previewToken = rawTokens.get(row.id) ?? ''
    return {
      preview_id: row.id,
      preview_token: previewToken,
      preview_token_reissued: Boolean(previewToken),
      status: row.parse_status === 'parsed' ? 'ready' : row.parse_status,
      parser_version: row.parser_version,
      pipeline,
      review_required: pipeline.review_required === true,
      expires_at: row.expires_at,
      file: {
        original_filename: sanitizeOriginalFilename(row.original_filename),
        mime_type: row.mime_type,
        file_size: Number(row.file_size),
        sha256: row.sha256,
        format: row.format
      },
      records,
      ...(row.parse_status === 'parsing' ? { poll_after_ms: 750 } : {}),
      ...(row.error_code ? {
        error_code: row.error_code,
        error: row.error_message,
        retryable: RETRYABLE_PARSE_FAILURES.has(row.error_code)
      } : {})
    }
  }

  const processCleanupJob = (job) => {
    const timestamp = now()
    try {
      const path = assertInside(root, job.storage_path)
      try { unlinkSync(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      db.prepare(`
        UPDATE attachment_cleanup_jobs
        SET attempts = attempts + 1, last_error = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND completed_at IS NULL
      `).run(timestamp, timestamp, job.id)
      return true
    } catch (error) {
      db.prepare(`
        UPDATE attachment_cleanup_jobs
        SET attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE id = ? AND completed_at IS NULL
      `).run(String(error?.code ?? error?.name ?? 'cleanup_failed').slice(0, 200), timestamp, job.id)
      return false
    }
  }

  const processCleanupJobs = ({ limit = 25 } = {}) => {
    const maximum = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25
    const jobs = db.prepare(`
      SELECT * FROM attachment_cleanup_jobs
      WHERE completed_at IS NULL ORDER BY created_at, id LIMIT ?
    `).all(maximum)
    let completed = 0
    let failed = 0
    for (const job of jobs) {
      if (processCleanupJob(job)) completed += 1
      else failed += 1
    }
    return { attempted: jobs.length, completed, failed }
  }

  const cleanupExpiredPreviews = () => {
    const timestamp = new Date(clock()).toISOString()
    const expired = db.prepare(`
      SELECT id, quarantine_path FROM attachment_update_previews
      WHERE parse_status IN ('parsing', 'parsed', 'failed') AND expires_at <= ?
    `).all(timestamp)
    for (const preview of expired) {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (preview.quarantine_path) enqueueCleanup(preview.quarantine_path, 'attachment_preview_expired', timestamp)
        db.prepare(`
          UPDATE attachment_update_previews
          SET parse_status = 'expired', quarantine_path = NULL,
              extracted_text = '', records_json = '[]',
              consumed_at = coalesce(consumed_at, ?), updated_at = ?
          WHERE id = ?
        `).run(timestamp, timestamp, preview.id)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        throw error
      }
      cancelScheduledParse(preview.id)
      rawTokens.delete(preview.id)
      releasePreviewAvatars(preview.id)
    }
    if (expired.length) processCleanupJobs({ limit: 100 })
    return expired.length
  }

  const recoverInterruptedPreviews = () => {
    const interrupted = db.prepare(`
      SELECT * FROM attachment_update_previews
      WHERE parse_status = 'parsing'
      ORDER BY created_at, id
    `).all()
    for (const preview of interrupted) {
      schedulePreviewParsing({
        id: preview.id,
        validated: {
          originalFilename: preview.original_filename,
          extension: attachmentExtension(preview.format),
          format: preview.format,
          mimeType: preview.mime_type,
          size: Number(preview.file_size),
          sha256: preview.sha256,
          packageInfo: null
        },
        requestedId: preview.requested_candidate_id,
        quarantinePath: preview.quarantine_path
      })
    }
    return interrupted.length
  }

  const runPreviewParsing = async ({ id, validated, requestedId, quarantinePath, buffer: suppliedBuffer, signal }) => {
    let avatarResults = []
    let avatarTransfers = []
    let visualPages = []
    try {
      const configuredVisualStatus = validated.format === 'pdf' ? visualProviderStatus() : null
      const visualEnabled = validated.format === 'pdf' && visualCapabilityEnabled()
      let buffer = suppliedBuffer
      if (!Buffer.isBuffer(buffer)) {
        if (!quarantinePath) {
          throw attachmentError(422, 'attachment_staging_invalid', '附件隔离文件路径缺失')
        }
        const safePath = assertInside(quarantineRoot, quarantinePath)
        const stagedStat = await lstat(safePath)
        if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
          throw attachmentError(422, 'attachment_staging_invalid', '附件隔离文件不是普通文件')
        }
        buffer = await readFileAsync(safePath)
      }
      if (
        buffer.length !== Number(validated.size) ||
        createHash('sha256').update(buffer).digest('hex') !== validated.sha256
      ) {
        throw attachmentError(422, 'attachment_staging_invalid', '附件隔离文件大小或内容校验失败')
      }
      const stagedFile = {
        originalname: validated.originalFilename,
        mimetype: validated.mimeType,
        buffer
      }
      const parsed = await parser(stagedFile, validated, undefined, {
        signal,
        renderVisualPages: visualEnabled,
        allowTextlessPdf: validated.format === 'pdf'
      })
      visualPages = Array.isArray(parsed?.visual_pages) ? parsed.visual_pages : []
      const visualEvidencePages = visualPages.map((page) => ({
        page_number: page?.page_number,
        width: page?.width,
        height: page?.height,
        pixel_count: page?.pixel_count,
        mime_type: page?.mime_type,
        text: String(page?.text ?? ''),
        text_spans: Array.isArray(page?.text_spans) ? page.text_spans : []
      }))
      const sensitiveAvatarValues = extractExplicitAvatarSensitiveValues({
        text: parsed.text,
        records: parsed.records
      })
      const durableExtractedText = redactAvatarValuesForModel(parsed.text, sensitiveAvatarValues)
      const durableParsedRecords = redactAvatarValuesForStorage(parsed.records ?? [], sensitiveAvatarValues)
      let records = durableParsedRecords.map((record, index) => (
        buildPreviewRecord(db, record, index, validated.format, requestedId, { pages: visualEvidencePages })
      ))
      if (!records.length) throw attachmentError(422, 'attachment_empty', '附件中没有可确认的候选人记录')
      if (records.length > MAX_CONFIRM_RECORDS) {
        throw attachmentError(413, 'attachment_record_limit', `附件最多支持 ${MAX_CONFIRM_RECORDS} 条候选人记录`)
      }
      const parserVisual = parsed?.metadata?.visual
      const pdfContentType = validated.format === 'pdf'
        ? String(parsed?.metadata?.pdf_content_type ?? 'text')
        : null
      const initialVisualError = !visualEnabled
        ? safeAttachmentVisualErrorCode(configuredVisualStatus?.error_code ?? 'visual_capability_disabled')
        : parserVisual?.status === 'fallback'
          ? safeAttachmentVisualErrorCode(parserVisual.error_code ?? 'visual_pages_unavailable')
          : visualPages.length ? null : 'visual_pages_unavailable'
      const pipeline = {
        text: {
          status: 'ready',
          content_type: pdfContentType ?? validated.format
        },
        text_model: suggestionProvider
          ? { status: 'pending' }
          : { status: 'not_run' },
        visual: validated.format === 'pdf'
          ? visualEnabled && visualPages.length
            ? {
                status: 'not_run',
                used_fallback: false,
                capability: configuredVisualStatus?.capability ?? 'image_input',
                ...(configuredVisualStatus?.schema_mode === 'compat' || configuredVisualStatus?.schema_mode === 'strict'
                  ? { schema_mode: configuredVisualStatus.schema_mode }
                  : {}),
                ...(configuredVisualStatus?.parser_version
                  ? { parser_version: String(configuredVisualStatus.parser_version).slice(0, 120) }
                  : {}),
                ...(configuredVisualStatus?.prompt_version
                  ? { prompt_version: String(configuredVisualStatus.prompt_version).slice(0, 120) }
                  : {})
              }
            : {
                status: 'fallback',
                used_fallback: true,
                capability: configuredVisualStatus?.capability ?? (visualEnabled ? 'image_input' : 'disabled'),
                ...(initialVisualError ? { error_code: initialVisualError } : {}),
                retryable: initialVisualError
                  ? RETRYABLE_ATTACHMENT_VISUAL_ERRORS.has(initialVisualError)
                  : false,
                ...(configuredVisualStatus?.schema_mode === 'compat' || configuredVisualStatus?.schema_mode === 'strict'
                  ? { schema_mode: configuredVisualStatus.schema_mode }
                  : {}),
                ...(configuredVisualStatus?.parser_version
                  ? { parser_version: String(configuredVisualStatus.parser_version).slice(0, 120) }
                  : {}),
                ...(configuredVisualStatus?.prompt_version
                  ? { prompt_version: String(configuredVisualStatus.prompt_version).slice(0, 120) }
                  : {})
              }
          : { status: 'not_applicable', used_fallback: false }
      }
      let visualRequest = null
      if (validated.format === 'pdf' && visualEnabled && visualPages.length > 0) {
        const configuredStatus = visualProviderStatus()
        const transientVisualInput = visualPages.map((page) => ({
          ...page,
          text_spans: Array.isArray(page.text_spans) ? page.text_spans : []
        }))
        visualRequest = (async () => {
          let proposed
          try {
            proposed = await optionalSuggestionWithin((suggestionSignal) => invokeVisualSuggestionProvider({
                format: validated.format,
                records: records.map(publicRecord),
                schema_version: 2,
                document: {
                  parser_version: PARSER_VERSION,
                  page_count: Number(parsed?.metadata?.page_count ?? 0),
                  pdf_content_type: parsed?.metadata?.pdf_content_type ?? null
                },
                visual_pages: transientVisualInput
              }, suggestionSignal), visualSuggestionTimeoutMs, signal)
            if (proposed?.__attachment_timeout === true) {
              proposed = { records: [], status: 'fallback', error_code: 'visual_timeout' }
            }
          } catch (error) {
            // Preserve the provider's stable channel outcome (code,
            // retryability, and schema mode) without exposing details.
            proposed = {
              records: [],
              ...attachmentVisualPipelineState(null, error)
            }
          } finally {
            clearVisualPages(transientVisualInput)
            clearVisualPages(visualPages)
            visualPages = []
          }
          return { proposed, configuredStatus }
        })()
      } else {
        clearVisualPages(visualPages)
        visualPages = []
      }

      const parserProvidedAvatarTransfers = Object.prototype.hasOwnProperty.call(parsed, 'avatar_transfers')
      let avatarProjections
      if (parserProvidedAvatarTransfers) {
        avatarTransfers = Array.isArray(parsed.avatar_transfers) ? parsed.avatar_transfers : []
        avatarProjections = (parsed.records ?? []).map((_, index) => (
          publicAvatarProjection(avatarTransfers[index]?.projection)
        ))
      } else {
        avatarResults = await extractAttachmentAvatarResults(buffer, validated.format, parsed)
        avatarProjections = avatarResults.map(publicAvatarProjection)
      }
      records.forEach((record, index) => {
        record.avatar = avatarProjections[index]
      })

      if (typeof suggestionProvider === 'function') {
        let textModelResult
        let textModelError
        try {
          textModelResult = await optionalSuggestionWithin((suggestionSignal) => suggestionProvider({
              format: validated.format,
              extracted_text: durableExtractedText,
              records: records.map(publicRecord),
              schema_version: 2,
              document: {
                parser_version: PARSER_VERSION,
                page_count: Number(parsed?.metadata?.page_count ?? 0),
                pdf_content_type: parsed?.metadata?.pdf_content_type ?? null
              }
            }, { signal: suggestionSignal }), ATTACHMENT_SUGGESTION_TIMEOUT_MS, signal)
          if (signal.aborted) {
            for (const result of avatarResults) releaseAvatarResult(result)
            for (const transfer of avatarTransfers) releaseAttachmentAvatarTransfer(transfer)
            clearVisualPages(visualPages)
            avatarResults = []
            avatarTransfers = []
            return
          }
          pipeline.text_model = attachmentSuggestionPipelineState(textModelResult)
          if (Array.isArray(textModelResult?.records)) {
            const knownRecordIds = new Set(records.map((record) => record.record_id))
            const byId = new Map(textModelResult.records
              .filter((record) => knownRecordIds.has(record?.record_id))
              .map((record) => [record.record_id, record]))
            records = records.map((record) => mergeModelSuggestions(record, byId.get(record.record_id), {
              source: 'model_text',
              pages: visualEvidencePages
            }))
          }
        } catch (error) {
          textModelError = error
          pipeline.text_model = attachmentSuggestionPipelineState(null, textModelError)
        }
      }
      if (visualRequest) {
        const { proposed, configuredStatus } = await visualRequest
        if (signal.aborted) {
          for (const result of avatarResults) releaseAvatarResult(result)
          for (const transfer of avatarTransfers) releaseAttachmentAvatarTransfer(transfer)
          avatarResults = []
          avatarTransfers = []
          return
        }
        if (Array.isArray(proposed?.records)) {
          const knownRecordIds = new Set(records.map((record) => record.record_id))
          const byId = new Map(proposed.records
            .filter((record) => knownRecordIds.has(record?.record_id))
            .map((record) => [record.record_id, record]))
          records = records.map((record) => mergeModelSuggestions(record, byId.get(record.record_id), {
            source: 'visual',
            pages: visualEvidencePages
          }))
        }
        const visualState = attachmentVisualPipelineState(proposed)
        const fallbackCode = visualState.status === 'fallback'
          ? visualState.error_code
          : null
          pipeline.visual = {
            status: visualState.status,
            used_fallback: visualState.status !== 'ready',
            capability: configuredStatus?.capability ?? 'image_input',
            ...(visualState.schema_mode || configuredStatus?.schema_mode
              ? { schema_mode: safeAttachmentSchemaMode(visualState.schema_mode ?? configuredStatus.schema_mode) }
              : {}),
            retryable: visualState.status === 'ready' ? false : visualState.retryable,
            ...(fallbackCode ? { error_code: String(fallbackCode).slice(0, 120) } : {}),
          ...(proposed?.parser_version ?? configuredStatus?.parser_version
            ? { parser_version: String(proposed?.parser_version ?? configuredStatus.parser_version).slice(0, 120) }
            : {}),
          ...(proposed?.prompt_version ?? configuredStatus?.prompt_version
            ? { prompt_version: String(proposed?.prompt_version ?? configuredStatus.prompt_version).slice(0, 120) }
            : {})
        }
      }
      // A searchable text PDF can remain usable when vision is unavailable,
      // but scanned/mixed content or any visual fallback must be surfaced as a
      // review-required result rather than looking fully complete.
      pipeline.review_required = pipeline.text_model.status === 'fallback' || (
        validated.format === 'pdf' && (
          pdfContentType !== 'text' || pipeline.visual.status !== 'ready'
        )
      )
      if (records[0]) records[0]._pipeline = pipeline
      const updatedAt = new Date(clock()).toISOString()
      db.prepare(`
        UPDATE attachment_update_previews
        SET parse_status = 'parsed', extracted_text = ?, records_json = ?,
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND parse_status = 'parsing'
      `).run(durableExtractedText, JSON.stringify(records), updatedAt, id)
      for (const result of avatarResults) releaseAvatarResult(result)
      for (const transfer of avatarTransfers) releaseAttachmentAvatarTransfer(transfer)
      clearVisualPages(visualPages)
      avatarResults = []
      avatarTransfers = []
      visualPages = []
    } catch (error) {
      for (const result of avatarResults) releaseAvatarResult(result)
      for (const transfer of avatarTransfers) releaseAttachmentAvatarTransfer(transfer)
      clearVisualPages(visualPages)
      if (signal?.aborted && closing) return
      const updatedAt = new Date(clock()).toISOString()
      const failure = publicParseFailure(error)
      const current = readPreview(id)
      if (current?.parse_status === 'parsing') {
        db.exec('BEGIN IMMEDIATE')
        try {
          if (current.quarantine_path) enqueueCleanup(current.quarantine_path, 'attachment_parse_failed', updatedAt)
          db.prepare(`
            UPDATE attachment_update_previews
            SET parse_status = 'failed', quarantine_path = NULL,
                error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND parse_status = 'parsing'
          `).run(failure.code, failure.message, updatedAt, id)
          db.exec('COMMIT')
        } catch (transactionError) {
          try { db.exec('ROLLBACK') } catch {}
          throw transactionError
        }
        processCleanupJobs({ limit: 100 })
        rawTokens.delete(id)
        releasePreviewAvatars(id)
      }
    }
  }

  const settleParseJob = (job) => {
    if (job.settled) return
    job.settled = true
    parseJobs.delete(job.id)
    job.resolve()
  }

  const drainParseQueue = () => {
    if (closing) return
    while (activeParses < parseConcurrency && parseQueue.length) {
      const job = parseQueue.shift()
      if (!job || job.settled) continue
      const preview = readPreview(job.id)
      if (!preview || preview.parse_status !== 'parsing') {
        settleParseJob(job)
        continue
      }
      activeParses += 1
      job.state = 'running'
      job.controller = new AbortController()
      const finish = () => {
        activeParses -= 1
        settleParseJob(job)
        drainParseQueue()
      }
      runPreviewParsing({ ...job.task, signal: job.controller.signal }).then(finish, finish)
    }
  }

  const schedulePreviewParsing = (task) => {
    let resolveJob
    const promise = new Promise((resolvePromise) => { resolveJob = resolvePromise })
    const job = {
      id: task.id,
      task,
      promise,
      resolve: resolveJob,
      state: 'queued',
      controller: null,
      settled: false
    }
    parseJobs.set(job.id, job)
    parseQueue.push(job)
    drainParseQueue()
    return promise
  }

  cancelScheduledParse = (id) => {
    const job = parseJobs.get(id)
    if (!job || job.settled) return false
    if (job.state === 'queued') settleParseJob(job)
    else job.controller?.abort()
    return true
  }

  cleanupExpiredPreviews()
  recoverInterruptedPreviews()

  const createPreview = ({ file, requestedCandidateId } = {}) => {
    if (closing) throw attachmentError(503, 'attachment_service_closing', '附件解析服务正在关闭，请稍后重试')
    cleanupExpiredPreviews()
    const requestedId = cleanValue(requestedCandidateId, 200)
    if (requestedId) {
      const candidate = db.prepare('SELECT id, archived_at FROM candidates WHERE id = ?').get(requestedId)
      if (!candidate) throw attachmentError(404, 'not_found', '候选人不存在')
      if (candidate.archived_at) throw attachmentError(409, 'candidate_archived', '已归档候选人不能上传或更新附件')
    }
    const validated = validateAttachmentFile(file)
    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const timestamp = new Date(clock()).toISOString()
    const expiresAt = new Date(clock() + previewTtlMs).toISOString()
    const quarantinePath = resolve(quarantineRoot, `${randomUUID()}${attachmentExtension(validated.format)}`)
    assertInside(quarantineRoot, quarantinePath)
    try {
      writeFileSync(quarantinePath, file.buffer, { flag: 'wx', mode: 0o600 })
    } catch (cause) {
      const error = attachmentError(503, 'attachment_upload_failed', '附件暂存失败，请稍后重试')
      error.cause = cause
      throw error
    }
    try {
      db.prepare(`
        INSERT INTO attachment_update_previews(
          id, token_hash, original_filename, quarantine_path, mime_type, file_size,
          sha256, format, parse_status, parser_version, extracted_text, records_json,
          requested_candidate_id, error_code, error_message, expires_at, consumed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'parsing', ?, '', '[]', ?, NULL, NULL, ?, NULL, ?, ?)
      `).run(
        id, tokenHash(token), validated.originalFilename, quarantinePath, validated.mimeType,
        validated.size, validated.sha256, validated.format, PARSER_VERSION, requestedId,
        expiresAt, timestamp, timestamp
      )
      rawTokens.set(id, token)
    } catch (error) {
      try { unlinkSync(quarantinePath) } catch {}
      const uploadError = attachmentError(503, 'attachment_upload_failed', '附件上传状态保存失败，请稍后重试')
      uploadError.cause = error
      throw uploadError
    }

    schedulePreviewParsing({ id, validated, requestedId, quarantinePath, buffer: file.buffer })
    return serializePreview(readPreview(id))
  }

  const waitForPreview = async (id) => {
    await parseJobs.get(id)?.promise
    return serializePreview(readPreview(id))
  }

  const getPreview = (id) => {
    cleanupExpiredPreviews()
    const row = readPreview(id)
    if (!row) throw attachmentError(404, 'not_found', '附件预览不存在')
    return serializePreview(row)
  }

  const cancelPreview = (id) => {
    cleanupExpiredPreviews()
    const row = readPreview(id)
    if (!row) throw attachmentError(404, 'not_found', '附件预览不存在')
    if (row.parse_status === 'expired') {
      throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
    }
    if (row.parse_status === 'confirmed') {
      throw attachmentError(409, 'attachment_preview_consumed', '已确认的附件预览不能取消')
    }
    const timestamp = new Date(clock()).toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      if (row.quarantine_path) enqueueCleanup(row.quarantine_path, 'attachment_preview_cancelled', timestamp)
      db.prepare(`
        UPDATE attachment_update_previews
        SET parse_status = 'cancelled', quarantine_path = NULL,
            extracted_text = '', records_json = '[]',
            consumed_at = coalesce(consumed_at, ?), updated_at = ? WHERE id = ?
      `).run(timestamp, timestamp, id)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    cancelScheduledParse(id)
    processCleanupJobs({ limit: 100 })
    rawTokens.delete(id)
    releasePreviewAvatars(id)
    return { cancelled: true, preview_id: id }
  }

  const recoverPreviewAvatarResult = async (preview, record) => {
    if (!preview.quarantine_path) {
      throw attachmentError(409, 'attachment_avatar_source_expired', '头像暂存文件已失效，请重新上传附件')
    }
    const safePath = assertInside(quarantineRoot, preview.quarantine_path)
    const stagedStat = await lstat(safePath)
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
      throw attachmentError(422, 'attachment_staging_invalid', '附件隔离文件不是普通文件')
    }
    const buffer = await readFileAsync(safePath)
    if (
      buffer.length !== Number(preview.file_size) ||
      createHash('sha256').update(buffer).digest('hex') !== preview.sha256
    ) {
      throw attachmentError(422, 'attachment_staging_invalid', '附件隔离文件大小或内容校验失败')
    }
    const stagedFile = {
      originalname: preview.original_filename,
      mimetype: preview.mime_type,
      buffer
    }
    const validated = validateAttachmentFile(stagedFile)
    if (validated.format !== preview.format || validated.sha256 !== preview.sha256) {
      throw attachmentError(422, 'attachment_staging_invalid', '附件隔离文件格式或内容校验失败')
    }
    const parsed = await parser(stagedFile, validated, undefined, {
      // Avatar recovery must preserve the same textless-PDF contract as the
      // initial preview parse. Scanned PDFs have no text layer, but their
      // embedded image can still be recovered deterministically.
      allowTextlessPdf: validated.format === 'pdf'
    })
    const parsedRecords = Array.isArray(parsed?.records) ? parsed.records : []
    const resultIndex = parsedRecords.findIndex((item, index) => (
      (Number.isInteger(item?.row_number) ? item.row_number : index + 1) === record.row_number
    ))
    const parserProvidedAvatarTransfers = Object.prototype.hasOwnProperty.call(parsed, 'avatar_transfers')
    const transfers = parserProvidedAvatarTransfers && Array.isArray(parsed.avatar_transfers)
      ? parsed.avatar_transfers
      : []
    let result = null
    try {
      if (parserProvidedAvatarTransfers) {
        if (resultIndex >= 0 && transfers[resultIndex]) {
          result = hydrateAttachmentAvatarTransfer(transfers[resultIndex])
        }
      } else {
        const results = await extractAttachmentAvatarResults(buffer, validated.format, parsed)
        result = resultIndex >= 0 ? results[resultIndex] : null
        results.forEach((item, index) => {
          if (index !== resultIndex) releaseAvatarResult(item)
        })
      }
      const projection = publicAvatarProjection(result)
      if (
        !projection.available || projection.source !== record.avatar?.source ||
        projection.content_type !== record.avatar?.content_type
      ) {
        releaseAvatarResult(result)
        throw attachmentError(409, 'attachment_avatar_changed', '头像解析结果已变化，请重新上传附件')
      }
      return result
    } finally {
      for (const transfer of transfers) releaseAttachmentAvatarTransfer(transfer)
    }
  }

  const privateAvatarForRecord = async (preview, record) => {
    const retained = privateAvatarResults.get(preview.id)?.get(record.record_id)
    if (retained) return retained
    const recovered = await recoverPreviewAvatarResult(preview, record)
    if (!privateAvatarResults.has(preview.id)) privateAvatarResults.set(preview.id, new Map())
    privateAvatarResults.get(preview.id).set(record.record_id, recovered)
    return recovered
  }

  const createCandidateFromPreview = async (id, input = {}, { authorizedBatch = false } = {}) => {
    cleanupExpiredPreviews()
    const preview = readPreview(id)
    if (!preview) throw attachmentError(404, 'not_found', '附件预览不存在')
    if (preview.parse_status === 'expired') {
      throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
    }
    if (preview.parse_status !== 'parsed' || preview.consumed_at) {
      throw attachmentError(409, 'attachment_preview_not_ready', '附件预览尚未就绪或已经使用')
    }
    if (preview.expires_at <= new Date(clock()).toISOString()) {
      cleanupExpiredPreviews()
      throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
    }
    if (!authorizedBatch && (typeof input.preview_token !== 'string' || tokenHash(input.preview_token) !== preview.token_hash)) {
      throw attachmentError(409, 'attachment_preview_invalid', '附件预览令牌无效')
    }
    const recordId = cleanValue(input.record_id, 200)
    const records = parseJson(preview.records_json, [])
    const record = records.find((item) => item.record_id === recordId)
    if (!record) throw attachmentError(422, 'validation_error', 'record_id 不属于当前附件预览')
    if (record.match?.status !== 'not_found') {
      throw attachmentError(409, 'attachment_candidate_create_blocked', '只有未匹配记录可以创建新候选人')
    }

    const sourceRecordId = `attachment-preview:${preview.id}:${record.record_id}`
    const existing = db.prepare(`
      SELECT id FROM candidates WHERE source_system = 'attachment_preview' AND source_record_id = ?
    `).get(sourceRecordId)
    if (existing) {
      const candidate = getCandidate(db, existing.id)
      persistCreatedCandidateMatch(preview.id, record.record_id, candidate)
      return candidateCreationResponse(candidate)
    }

    const freshMatch = matchCandidateIdentity(db, recordIdentity(record))
    if (freshMatch.status !== 'not_found') {
      throw attachmentError(409, freshMatch.status, '附件身份字段已匹配现有候选人，请刷新后选择已有候选人')
    }
    if (!input.candidate || typeof input.candidate !== 'object' || Array.isArray(input.candidate)) {
      throw attachmentError(422, 'validation_error', 'candidate 必须是对象')
    }
    const candidateInput = { ...input.candidate }
    for (const field of ['photo_url', 'source_system', 'source_record_id', 'import_batch_id']) delete candidateInput[field]
    const validStages = db.prepare('SELECT value FROM stages ORDER BY position, value').all().map((stage) => stage.value)
    const { value, errors } = sanitizeCandidateInput(candidateInput, { validStages })
    if (errors.length) throw attachmentError(422, 'validation_error', '候选人字段校验失败', errors)
    const profileSections = normalizeAttachmentCreateSections(input.profile_sections, sourceRecordId)

    let avatarResult = null
    let localAvatar = null
    let avatarId = null
    let avatarPath = null
    if (input.include_avatar !== false && record.avatar?.available) {
      try {
        avatarResult = await privateAvatarForRecord(preview, record)
        let materialized
        try {
          materialized = materializePrivateAttachmentAvatar(avatarResult.reference)
        } catch (error) {
          if (error?.code !== 'attachment_avatar_reference_invalid') throw error
          const recovered = await recoverPreviewAvatarResult(preview, record)
          privateAvatarResults.get(preview.id)?.set(record.record_id, recovered)
          avatarResult = recovered
          materialized = materializePrivateAttachmentAvatar(recovered.reference)
        }
        if (materialized.kind === 'remote_url') {
          value.photo_url = materialized.photo_url
        } else {
          localAvatar = sanitizeMaterializedAttachmentAvatar(materialized)
          avatarId = randomUUID()
          avatarPath = resolve(filesRoot, `${randomUUID()}.${localAvatar.extension}`)
          assertInside(filesRoot, avatarPath)
          value.photo_url = `${ATTACHMENT_AVATAR_URL_PREFIX}${avatarId}`
        }
      } catch (error) {
        releaseRecordAvatar(preview.id, record.record_id, avatarResult)
        throw error
      }
    }
    let avatarCommitted = false
    let transactionStarted = false
    try {
      value.source_system = 'attachment_preview'
      value.source_record_id = sourceRecordId
      value.import_batch_id = null
      const latestPreview = readPreview(id)
      if (latestPreview?.parse_status === 'expired') {
        throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
      }
      if (!latestPreview || latestPreview.parse_status !== 'parsed' || latestPreview.consumed_at) {
        throw attachmentError(409, 'attachment_preview_not_ready', '附件预览状态已变化，请刷新后重试')
      }
      if (latestPreview.expires_at <= new Date(clock()).toISOString()) {
        cleanupExpiredPreviews()
        throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
      }
      if (!authorizedBatch && (
        typeof input.preview_token !== 'string' || tokenHash(input.preview_token) !== latestPreview.token_hash
      )) {
        throw attachmentError(409, 'attachment_preview_invalid', '附件预览令牌无效')
      }
      const concurrentExisting = db.prepare(`
        SELECT id FROM candidates WHERE source_system = 'attachment_preview' AND source_record_id = ?
      `).get(sourceRecordId)
      if (concurrentExisting) {
        const candidate = getCandidate(db, concurrentExisting.id)
        persistCreatedCandidateMatch(preview.id, record.record_id, candidate)
        return candidateCreationResponse(candidate)
      }

      const latestMatch = matchCandidateIdentity(db, recordIdentity(record))
      if (latestMatch.status !== 'not_found') {
        throw attachmentError(409, latestMatch.status, '附件身份字段已匹配现有候选人，请刷新后选择已有候选人')
      }
      const duplicate = findDuplicate(db, value)
      if (duplicate) {
        throw attachmentError(409, 'candidate_duplicate', '发现可能重复的候选人，请选择已有候选人', duplicate)
      }

      const timestamp = new Date(clock()).toISOString()
      if (localAvatar && avatarPath) {
        writeFileSync(avatarPath, localAvatar.buffer, { flag: 'wx', mode: 0o600 })
      }

      let candidateId
      db.exec('BEGIN IMMEDIATE')
      transactionStarted = true
      const racedExisting = db.prepare(`
        SELECT id FROM candidates WHERE source_system = 'attachment_preview' AND source_record_id = ?
      `).get(sourceRecordId)
      if (racedExisting) {
        db.exec('ROLLBACK')
        transactionStarted = false
        const candidate = getCandidate(db, racedExisting.id)
        persistCreatedCandidateMatch(preview.id, record.record_id, candidate)
        return candidateCreationResponse(candidate)
      }
      const created = insertCandidate(db, {
        ...value,
        created_at: timestamp,
        updated_at: timestamp
      }, {
        activityType: 'candidate_created_from_attachment',
        activityMetadata: {
          preview_id: preview.id,
          record_id: record.record_id,
          avatar_imported: Boolean(value.photo_url)
        },
        hydrate: false
      })
      candidateId = created.id
      insertAttachmentCreateSections(db, candidateId, profileSections, timestamp)
      if (localAvatar && avatarId && avatarPath) {
        db.prepare(`
          INSERT INTO candidate_attachments(
            id, candidate_id, original_filename, storage_path, mime_type, file_size,
            sha256, attachment_type, parse_status, parser_version, extracted_text,
            source, import_batch_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'avatar', 'parsed', ?, '', 'attachment_parse', NULL, ?, ?)
        `).run(
          avatarId,
          candidateId,
          sanitizeOriginalFilename(`attachment-avatar.${localAvatar.extension}`),
          avatarPath,
          localAvatar.content_type,
          localAvatar.byte_length,
          localAvatar.sha256,
          PARSER_VERSION,
          timestamp,
          timestamp
        )
      }
      persistCreatedCandidateMatch(preview.id, record.record_id, getCandidate(db, candidateId), timestamp)
      synchronizeBusinessSearch(db)
      db.exec('COMMIT')
      transactionStarted = false
      avatarCommitted = true
      return candidateCreationResponse(getCandidate(db, candidateId))
    } catch (error) {
      if (transactionStarted) {
        try { db.exec('ROLLBACK') } catch {}
        transactionStarted = false
      }
      throw error
    } finally {
      try {
        releaseRecordAvatar(preview.id, record.record_id, avatarResult)
      } finally {
        if (localAvatar && avatarPath && !avatarCommitted) {
          safeDeleteOrQueue(avatarPath, 'attachment_candidate_create_rollback')
        }
      }
    }
  }

  const resolveCandidateAvatar = (candidateId, photoUrl) => {
    const prefix = ATTACHMENT_AVATAR_URL_PREFIX
    if (typeof photoUrl !== 'string' || !photoUrl.startsWith(prefix)) return null
    const avatarId = cleanValue(photoUrl.slice(prefix.length), 200)
    if (!avatarId) return null
    const row = db.prepare(`
      SELECT * FROM candidate_attachments
      WHERE id = ? AND candidate_id = ? AND attachment_type = 'avatar'
    `).get(avatarId, candidateId)
    if (!row) return null
    const path = assertInside(filesRoot, row.storage_path)
    if (!existsSync(path)) throw attachmentError(503, 'avatar_file_missing', '候选人头像文件暂不可用')
    if (!['image/jpeg', 'image/png'].includes(row.mime_type)) {
      throw attachmentError(422, 'avatar_file_invalid', '候选人头像文件类型无效')
    }
    return { path, mime_type: row.mime_type, file_size: Number(row.file_size) }
  }

  const confirmPreviewCore = (id, input = {}, { authorizedBatch = false, beforeCommit } = {}) => {
    cleanupExpiredPreviews()
    const preview = readPreview(id)
    if (!preview) throw attachmentError(404, 'not_found', '附件预览不存在')
    // Expiry cleanup marks the row consumed while erasing its staged payload.
    // Check the terminal reason before the generic replay guard so a caller
    // receives the actionable expiry code rather than a misleading replay.
    if (preview.parse_status === 'expired') {
      throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
    }
    if (preview.parse_status === 'confirmed' || preview.consumed_at) {
      throw attachmentError(409, 'attachment_preview_replayed', '附件预览令牌已使用，不能重复提交')
    }
    if (preview.parse_status !== 'parsed') {
      throw attachmentError(409, 'attachment_preview_not_ready', '附件尚未完成解析或已失效')
    }
    if (preview.expires_at <= new Date(clock()).toISOString()) {
      cleanupExpiredPreviews()
      throw attachmentError(409, 'attachment_preview_expired', '附件预览令牌已过期')
    }
    if (!authorizedBatch && (typeof input.preview_token !== 'string' || tokenHash(input.preview_token) !== preview.token_hash)) {
      throw attachmentError(409, 'attachment_preview_invalid', '附件预览令牌无效')
    }
    if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > MAX_CONFIRM_RECORDS) {
      throw attachmentError(422, 'validation_error', `records 必须包含 1 至 ${MAX_CONFIRM_RECORDS} 条记录`)
    }
    const storedRecords = parseJson(preview.records_json, [])
    const storedById = new Map(storedRecords.map((record) => [record.record_id, record]))
    const seenRecords = new Set()
    const seenCandidates = new Set()
    const confirmations = input.records.map((confirmation, index) => {
      if (!confirmation || typeof confirmation !== 'object') {
        throw attachmentError(422, 'validation_error', `records.${index} 必须是对象`)
      }
      const record = storedById.get(confirmation.record_id)
      if (!record || seenRecords.has(record.record_id)) {
        throw attachmentError(422, 'validation_error', 'records 包含未知或重复的 record_id')
      }
      seenRecords.add(record.record_id)
      const candidateId = cleanValue(confirmation.candidate_id, 200)
      if (!candidateId || seenCandidates.has(candidateId)) {
        throw attachmentError(422, 'validation_error', '同一附件预览中每位候选人只能确认一次')
      }
      seenCandidates.add(candidateId)
      const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId)
      if (!candidate) throw attachmentError(409, 'candidate_not_found', '候选人不存在，整批未更新')
      if (candidate.archived_at) throw attachmentError(409, 'candidate_archived', '已归档候选人不能通过附件更新，整批未更新')
      if (candidate.updated_at !== confirmation.expected_updated_at) {
        throw attachmentError(409, 'version_conflict', '候选人版本已变化，整批未更新', { candidate_id: candidateId })
      }
      revalidateIdentity(db, record, candidateId)
      const suggestionFields = new Set((record.suggestions ?? []).map((item) => item.field))
      const sectionIds = new Set((record.sections ?? [])
        .filter((item) => !isScalarSummarySection(item))
        .map((item) => item.section_id))
      const selectedFields = validateSelectedList(confirmation.selected_fields ?? [], suggestionFields, 'selected_fields')
      const selectedSections = validateSelectedList(confirmation.selected_sections ?? [], sectionIds, 'selected_sections')
      const mergeMode = confirmation.merge_mode ?? 'merge'
      if (!['merge', 'replace'].includes(mergeMode)) {
        throw attachmentError(422, 'validation_error', 'merge_mode 仅支持 merge 或 replace')
      }
      return { record, confirmation, candidate, candidateId, selectedFields, selectedSections, mergeMode }
    })

    const createdFiles = []
    const timestamp = new Date(clock()).toISOString()
    const results = []
    db.exec('BEGIN IMMEDIATE')
    try {
      const insertAttachment = db.prepare(`
        INSERT INTO candidate_attachments(
          id, candidate_id, original_filename, storage_path, mime_type, file_size,
          sha256, attachment_type, parse_status, parser_version, extracted_text,
          source, import_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resume', 'parsed', ?, ?, 'user_upload', NULL, ?, ?)
      `)
      for (const item of confirmations) {
        const latest = db.prepare('SELECT * FROM candidates WHERE id = ?').get(item.candidateId)
        if (!latest || latest.archived_at || latest.updated_at !== item.confirmation.expected_updated_at) {
          throw attachmentError(409, 'version_conflict', '候选人状态或版本已变化，整批未更新')
        }
        revalidateIdentity(db, item.record, item.candidateId)
        const duplicate = db.prepare(`
          SELECT * FROM candidate_attachments
          WHERE candidate_id = ? AND sha256 = ? AND attachment_type = 'resume'
        `).get(item.candidateId, preview.sha256)
        if (duplicate) {
          results.push({
            record_id: item.record.record_id,
            candidate_id: item.candidateId,
            attachment: attachmentRow(duplicate),
            duplicate: true,
            changed_fields: [],
            inserted_section_ids: []
          })
          continue
        }

        const attachmentId = randomUUID()
        const finalPath = resolve(filesRoot, `${randomUUID()}${attachmentExtension(preview.format)}`)
        assertInside(filesRoot, finalPath)
        copyFileSync(preview.quarantine_path, finalPath, fsConstants.COPYFILE_EXCL)
        createdFiles.push(finalPath)
        const size = statSync(finalPath).size
        if (Number(size) !== Number(preview.file_size)) {
          throw attachmentError(500, 'attachment_copy_mismatch', '附件安全复制后的大小校验失败')
        }
        insertAttachment.run(
          attachmentId, item.candidateId, preview.original_filename, finalPath,
          preview.mime_type, preview.file_size, preview.sha256, PARSER_VERSION,
          preview.extracted_text, timestamp, timestamp
        )
        const changedFields = updateCandidateFields(
          db, latest, item.record, item.selectedFields, attachmentId, timestamp
        )
        const insertedSectionIds = applySections(
          db, item.candidateId, item.record, item.selectedSections, attachmentId,
          timestamp, item.mergeMode, input.confirm_replace_sections === true
        )
        db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, item.candidateId)
        addActivity(db, item.candidateId, 'resume_attachment_confirmed', '确认更新并保存简历附件', {
          attachment_id: attachmentId,
          parser_version: PARSER_VERSION,
          changed_fields: changedFields,
          inserted_section_count: insertedSectionIds.length,
          merge_mode: item.mergeMode
        })
        const attachment = db.prepare('SELECT * FROM candidate_attachments WHERE id = ?').get(attachmentId)
        results.push({
          record_id: item.record.record_id,
          candidate_id: item.candidateId,
          attachment: attachmentRow(attachment),
          duplicate: false,
          changed_fields: changedFields,
          inserted_section_ids: insertedSectionIds
        })
      }
      db.prepare(`
        UPDATE attachment_update_previews
        SET parse_status = 'confirmed', quarantine_path = NULL,
            extracted_text = '', records_json = '[]',
            consumed_at = ?, updated_at = ?
        WHERE id = ? AND consumed_at IS NULL AND parse_status = 'parsed'
      `).run(timestamp, timestamp, id)
      if (preview.quarantine_path) {
        enqueueCleanup(preview.quarantine_path, 'attachment_preview_confirmed', timestamp)
      }
      const response = {
        preview_id: id,
        committed_records: results.length,
        attachment_ids: results.map((result) => result.attachment.id),
        attachments: results.map((result) => result.attachment),
        updated_candidate_ids: unique(results.filter((result) => !result.duplicate).map((result) => result.candidate_id)),
        duplicate_records: results.filter((result) => result.duplicate).length,
        records: results
      }
      if (typeof beforeCommit === 'function') {
        const hookResult = beforeCommit({ result: response, timestamp, preview })
        if (hookResult && typeof hookResult.then === 'function') {
          throw new TypeError('attachment confirmation beforeCommit hook must be synchronous')
        }
      }
      synchronizeBusinessSearch(db)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      for (const path of createdFiles) safeDeleteOrQueue(path, 'attachment_confirm_rollback')
      throw error
    }

    processCleanupJobs()
    rawTokens.delete(id)
    releasePreviewAvatars(id)
    return {
      preview_id: id,
      committed_records: results.length,
      attachment_ids: results.map((result) => result.attachment.id),
      attachments: results.map((result) => result.attachment),
      updated_candidate_ids: unique(results.filter((result) => !result.duplicate).map((result) => result.candidate_id)),
      duplicate_records: results.filter((result) => result.duplicate).length,
      records: results
    }
  }

  const confirmPreview = (id, input = {}) => confirmPreviewCore(id, input)

  const confirmPreviewForBatch = (id, input = {}, options = {}) => confirmPreviewCore(id, input, {
    authorizedBatch: true,
    beforeCommit: options.beforeCommit
  })

  const listCandidateAttachments = (candidateId) => {
    const candidate = db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidateId)
    if (!candidate) throw attachmentError(404, 'not_found', '候选人不存在')
    return db.prepare(`
      SELECT * FROM candidate_attachments
      WHERE candidate_id = ? AND attachment_type = 'resume'
      ORDER BY created_at DESC, id
    `).all(candidateId).map(attachmentRow)
  }

  const getAttachment = (id, { includeText = false } = {}) => {
    const row = db.prepare(`
      SELECT a.* FROM candidate_attachments a
      JOIN candidates c ON c.id = a.candidate_id
      WHERE a.id = ? AND a.attachment_type = 'resume'
    `).get(id)
    if (!row) throw attachmentError(404, 'not_found', '附件不存在')
    return includeText ? { ...attachmentRow(row), extracted_text: row.extracted_text } : attachmentRow(row)
  }

  const deleteAttachment = (id) => {
    const attachmentId = cleanValue(id, 200)
    if (!attachmentId) throw attachmentError(404, 'not_found', '附件不存在')
    const timestamp = new Date(clock()).toISOString()
    let row
    let cleanupJob
    db.exec('BEGIN IMMEDIATE')
    try {
      row = db.prepare(`
        SELECT a.*, c.archived_at AS candidate_archived_at
        FROM candidate_attachments a
        JOIN candidates c ON c.id = a.candidate_id
        WHERE a.id = ? AND a.attachment_type = 'resume'
      `).get(attachmentId)
      if (!row) throw attachmentError(404, 'not_found', '附件不存在')
      if (row.candidate_archived_at) {
        throw attachmentError(409, 'candidate_archived', '已归档候选人的附件不能删除')
      }
      const storagePath = assertInside(filesRoot, row.storage_path)
      const fieldSources = db.prepare(`
        SELECT field_name FROM candidate_field_sources
        WHERE attachment_id = ? ORDER BY created_at, id
      `).all(attachmentId)
      const retainedSectionCount = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM candidate_profile_sections
        WHERE candidate_id = ? AND source_record_id = ?
      `).get(row.candidate_id, `attachment:${attachmentId}`).count)
      cleanupJob = enqueueCleanup(storagePath, 'attachment_deleted', timestamp)
      const deleted = db.prepare('DELETE FROM candidate_attachments WHERE id = ?').run(attachmentId)
      if (Number(deleted.changes) !== 1) {
        throw attachmentError(409, 'attachment_delete_conflict', '附件状态已变化，请刷新后重试')
      }
      db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, row.candidate_id)
      addActivity(db, row.candidate_id, 'resume_attachment_deleted', '删除简历附件', {
        attachment_id: attachmentId,
        original_filename: sanitizeOriginalFilename(row.original_filename),
        sha256: row.sha256,
        field_names: unique(fieldSources.map((source) => source.field_name)),
        retained_profile_section_count: retainedSectionCount
      })
      synchronizeBusinessSearch(db)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }

    const physicalFileDeleted = processCleanupJob(cleanupJob)
    return {
      attachment_id: attachmentId,
      candidate_id: row.candidate_id,
      deleted: true,
      cleanup_queued: true,
      physical_file_deleted: physicalFileDeleted,
      cleanup_pending: !physicalFileDeleted
    }
  }

  const resolveDownload = (id) => {
    const row = db.prepare(`
      SELECT a.* FROM candidate_attachments a
      JOIN candidates c ON c.id = a.candidate_id
      WHERE a.id = ? AND a.attachment_type = 'resume'
    `).get(id)
    if (!row) throw attachmentError(404, 'not_found', '附件不存在')
    const path = assertInside(filesRoot, row.storage_path)
    if (!existsSync(path)) throw attachmentError(503, 'attachment_file_missing', '附件文件暂不可用，请稍后重试')
    return {
      path,
      filename: sanitizeOriginalFilename(basename(row.original_filename)),
      mime_type: row.mime_type,
      file_size: Number(row.file_size)
    }
  }

  const timer = setInterval(() => {
    try {
      cleanupExpiredPreviews()
      processCleanupJobs()
    } catch {
      // A later interval or an explicit maintenance call retries pending work.
    }
  }, cleanupIntervalMs)
  timer.unref()

  let closePromise = null
  const close = () => {
    if (closePromise) return closePromise
    closing = true
    clearInterval(timer)
    const pending = [...parseJobs.values()].map((job) => job.promise)
    for (const job of [...parseJobs.values()]) {
      if (job.state !== 'queued') job.controller?.abort()
      settleParseJob(job)
    }
    for (const id of [...privateAvatarResults.keys()]) releasePreviewAvatars(id)
    closePromise = Promise.allSettled(pending).then(() => {
      if (removeRootOnClose) {
        const resolvedRoot = resolve(root)
        if (resolvedRoot.length < 10 || resolvedRoot === resolve(process.cwd())) {
          throw new Error('Refusing to remove an unsafe attachment root')
        }
        rmSync(resolvedRoot, { recursive: true, force: true })
      }
    })
    return closePromise
  }

  return {
    root,
    quarantineRoot,
    filesRoot,
    createPreview,
    waitForPreview,
    getPreview,
    assertPreviewAccess,
    cancelPreview,
    createCandidateFromPreview,
    confirmPreview,
    confirmPreviewForBatch,
    listCandidateAttachments,
    getAttachment,
    deleteAttachment,
    resolveCandidateAvatar,
    resolveDownload,
    cleanupExpiredPreviews,
    processCleanupJobs,
    enqueueCleanup,
    close
  }
}

export const ATTACHMENT_SERVICE_LIMITS = Object.freeze({
  preview_ttl_ms: DEFAULT_PREVIEW_TTL_MS,
  parse_concurrency: DEFAULT_PARSE_CONCURRENCY,
  max_confirm_records: MAX_CONFIRM_RECORDS,
  parser_version: PARSER_VERSION
})

export { attachmentError }
