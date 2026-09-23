const DEFAULT_MAX_RECORDS = 100
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024

export const ATTACHMENT_SUGGESTION_FIELDS = Object.freeze([
  'name', 'gender', 'birth_date', 'age',
  'current_company', 'current_title', 'location', 'years_experience',
  'education', 'highest_school', 'highest_major', 'job_seeking_status',
  'resume_updated_at', 'self_summary', 'source', 'owner', 'tags',
  'expected_salary', 'desired_titles', 'desired_locations',
  'employment_type', 'availability'
])

export const ATTACHMENT_SECTION_TYPES = Object.freeze([
  'experience', 'project', 'education', 'internship', 'skill', 'language',
  'campus', 'certificate', 'award', 'training', 'publication', 'management', 'other'
])

const FIELD_SET = new Set(ATTACHMENT_SUGGESTION_FIELDS)
const SECTION_TYPE_SET = new Set(ATTACHMENT_SECTION_TYPES)
const CONFIDENCE_SET = new Set(['low', 'medium', 'high'])
const STRUCTURED_SECTION_FIELDS = Object.freeze({
  organization: 300,
  role: 300,
  start_date: 80,
  end_date: 80,
  period: 160
})
const STRUCTURED_SECTION_FIELD_NAMES = Object.keys(STRUCTURED_SECTION_FIELDS)

function strictObject(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required }
}

const VALUE_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'string', minLength: 1, maxLength: 8_000 },
    { type: 'number' },
    { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 300 } }
  ]
})

const STRUCTURED_SECTION_SCHEMA = strictObject(Object.fromEntries(
  Object.entries(STRUCTURED_SECTION_FIELDS).map(([field, maxLength]) => [
    field,
    { anyOf: [{ type: 'string', minLength: 1, maxLength }, { type: 'null' }] }
  ])
))

function responseSchema(channel) {
  const visual = channel === 'visual'
  const suggestionProperties = {
    field: { type: 'string', enum: ATTACHMENT_SUGGESTION_FIELDS },
    value: VALUE_SCHEMA,
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    ...(visual ? { page: { type: 'integer', minimum: 1 } } : {}),
    evidence: { type: 'string', minLength: 1, maxLength: 1_000 },
    ...(!visual ? { default_selected: { type: 'boolean' } } : {})
  }
  const sectionProperties = {
    section_type: { type: 'string', enum: ATTACHMENT_SECTION_TYPES },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    content: { type: 'string', minLength: 1, maxLength: 50_000 },
    ...(visual ? { structured_data: STRUCTURED_SECTION_SCHEMA } : {}),
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    ...(visual ? { page: { type: 'integer', minimum: 1 } } : {}),
    evidence: { type: 'string', minLength: 1, maxLength: 1_000 },
    ...(!visual ? { default_selected: { type: 'boolean' } } : {})
  }
  return strictObject({
    records: {
      type: 'array',
      maxItems: DEFAULT_MAX_RECORDS,
      items: strictObject({
        record_id: { type: 'string', minLength: 1, maxLength: 200 },
        suggestions: { type: 'array', maxItems: ATTACHMENT_SUGGESTION_FIELDS.length, items: strictObject(suggestionProperties) },
        sections: { type: 'array', maxItems: 50, items: strictObject(sectionProperties) }
      })
    }
  })
}

export const ATTACHMENT_TEXT_RESPONSE_SCHEMA = Object.freeze(responseSchema('text'))
export const ATTACHMENT_VISUAL_RESPONSE_SCHEMA = Object.freeze(responseSchema('visual'))

export function attachmentSchemaMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'compat' ? 'compat' : 'strict'
}

export function attachmentResponseFormat(name, schema, mode) {
  return {
    type: 'json_schema',
    json_schema: { name, strict: mode !== 'compat', schema }
  }
}

function contractError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export async function boundedAttachmentResponseJson(response, maximumBytes = DEFAULT_MAX_RESPONSE_BYTES, signal) {
  if (signal?.aborted) throw signal.reason ?? contractError('request_aborted')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw contractError('response_too_large')
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw contractError('response_too_large')
    try { return JSON.parse(text) } catch { throw contractError('invalid_outer_json') }
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? contractError('request_aborted')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) throw contractError('response_too_large')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? contractError('request_aborted')
    throw error
  } finally {
    try { await reader.cancel() } catch {}
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) } catch { throw contractError('invalid_outer_json') }
}

function hasOnlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function nonEmptyString(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function normalizedValue(value) {
  if (nonEmptyString(value, 8_000)) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every((item) => nonEmptyString(item, 300))) {
    return value.map((item) => item.trim())
  }
  return undefined
}

function comparableEvidenceText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '')
}

function evidenceSupportsValue(field, value, evidence) {
  const evidenceText = comparableEvidenceText(evidence)
  if (!evidenceText) return false
  if (field === 'self_summary' && typeof value === 'string') {
    const summary = comparableEvidenceText(value)
    return evidenceText.length >= 4 && (summary.includes(evidenceText) || evidenceText.includes(summary))
  }
  const values = Array.isArray(value) ? value : [value]
  return values.every((entry) => {
    const candidate = comparableEvidenceText(entry)
    return candidate && evidenceText.includes(candidate)
  })
}

function evidenceSupportsSection(content, evidence) {
  const contentText = comparableEvidenceText(content)
  const evidenceText = comparableEvidenceText(evidence)
  return evidenceText.length >= 4 && (contentText.includes(evidenceText) || evidenceText.includes(contentText))
}

function currentRoleEvidence(value, evidence) {
  if (typeof value !== 'string') return false
  const clauses = String(evidence).split(/[\n\r;；]+/u)
  return clauses.some((clause) => {
    if (!clause.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase())) return false
    const current = /(?:\bcurrent(?:ly)?\b|\bpresent\b|\bnow\b|当前|目前|现任|在职|至今)/iu.test(clause)
    const closedRange = /(?:19|20)\d{2}(?:\D{0,8})(?:-|–|—|至|到)(?:\D{0,8})(?:19|20)\d{2}/u.test(clause)
    return current && !closedRange
  })
}

function normalizeStructuredData(value) {
  if (!hasOnlyKeys(value, STRUCTURED_SECTION_FIELD_NAMES) ||
    !STRUCTURED_SECTION_FIELD_NAMES.every((field) => Object.hasOwn(value, field))) return null
  const normalized = {}
  for (const field of STRUCTURED_SECTION_FIELD_NAMES) {
    if (value[field] === null) continue
    if (!nonEmptyString(value[field], STRUCTURED_SECTION_FIELDS[field])) return null
    normalized[field] = value[field].trim()
  }
  return normalized
}

export function validateAttachmentModelResponse(payload, options = {}) {
  const channel = options.channel === 'visual' ? 'visual' : 'text'
  const visual = channel === 'visual'
  const knownRecordIds = options.knownRecordIds instanceof Set ? options.knownRecordIds : new Set(options.knownRecordIds ?? [])
  const pageNumbers = options.pageNumbers instanceof Set ? options.pageNumbers : new Set(options.pageNumbers ?? [])
  const maxRecords = Math.min(DEFAULT_MAX_RECORDS, Number(options.maxRecords) || DEFAULT_MAX_RECORDS)
  if (!hasOnlyKeys(payload, ['records']) || !Array.isArray(payload.records) || payload.records.length > maxRecords) {
    throw contractError('invalid_schema')
  }
  const records = []
  const seenRecords = new Set()
  for (const record of payload.records) {
    if (!hasOnlyKeys(record, ['record_id', 'suggestions', 'sections']) || !nonEmptyString(record.record_id, 200) ||
      !knownRecordIds.has(record.record_id) || seenRecords.has(record.record_id) ||
      !Array.isArray(record.suggestions) || record.suggestions.length > ATTACHMENT_SUGGESTION_FIELDS.length ||
      !Array.isArray(record.sections) || record.sections.length > 50) throw contractError('invalid_schema')
    seenRecords.add(record.record_id)
    const fields = new Set()
    const suggestions = record.suggestions.map((item) => {
      const keys = visual
        ? ['field', 'value', 'confidence', 'page', 'evidence']
        : ['field', 'value', 'confidence', 'evidence', 'default_selected']
      const value = normalizedValue(item?.value)
      if (!hasOnlyKeys(item, keys) || !FIELD_SET.has(item.field) || fields.has(item.field) || value === undefined ||
        !CONFIDENCE_SET.has(item.confidence) || !nonEmptyString(item.evidence, 1_000) ||
        !evidenceSupportsValue(item.field, value, item.evidence) ||
        (visual && (!Number.isInteger(item.page) || !pageNumbers.has(item.page))) ||
        (!visual && (typeof item.default_selected !== 'boolean' || (item.confidence === 'low' && item.default_selected))) ||
        (['current_company', 'current_title'].includes(item.field) && !currentRoleEvidence(value, item.evidence))) {
        throw contractError('invalid_schema')
      }
      fields.add(item.field)
      return visual ? {
        field: item.field, value, confidence: item.confidence, source: 'visual',
        evidence_refs: [{ page: item.page, text: item.evidence.trim() }]
      } : {
        field: item.field, value, confidence: item.confidence,
        evidence: item.evidence.trim(), default_selected: item.default_selected
      }
    })
    const sections = record.sections.map((item) => {
      const keys = visual
        ? ['section_type', 'title', 'content', 'structured_data', 'confidence', 'page', 'evidence']
        : ['section_type', 'title', 'content', 'confidence', 'evidence', 'default_selected']
      if (!hasOnlyKeys(item, keys) || !SECTION_TYPE_SET.has(item.section_type) || !nonEmptyString(item.title, 300) ||
        !nonEmptyString(item.content, 50_000) || !CONFIDENCE_SET.has(item.confidence) ||
        !nonEmptyString(item.evidence, 1_000) || !evidenceSupportsSection(item.content, item.evidence) ||
        (visual && (!Number.isInteger(item.page) || !pageNumbers.has(item.page))) ||
        (!visual && typeof item.default_selected !== 'boolean')) throw contractError('invalid_schema')
      if (visual) {
        const structuredData = normalizeStructuredData(item.structured_data)
        if (!structuredData || !Object.values(structuredData).every((value) => (
          comparableEvidenceText(item.evidence).includes(comparableEvidenceText(value))
        ))) throw contractError('invalid_schema')
        return {
          section_type: item.section_type, title: item.title.trim(), content: item.content.trim(),
          structured_data: structuredData, confidence: item.confidence, source: 'visual',
          evidence_refs: [{ page: item.page, text: item.evidence.trim() }]
        }
      }
      return {
        section_type: item.section_type, title: item.title.trim(), content: item.content.trim(),
        confidence: item.confidence, evidence: item.evidence.trim(), default_selected: item.default_selected
      }
    })
    records.push({ record_id: record.record_id, suggestions, sections })
  }
  return records
}

export function attachmentModelResult(records, schemaMode, extra = {}) {
  // Keep protocol status fields owned by the adapter.  Metadata supplied by a
  // caller (parser/prompt versions, etc.) must not be able to relabel a
  // validated result as a fallback or as strict when compat was used.
  return {
    ...extra,
    records,
    status: 'ready',
    schema_mode: attachmentSchemaMode(schemaMode),
    retryable: false
  }
}

export function attachmentModelFailure(errorCode, schemaMode, retryable) {
  return {
    records: [],
    status: 'fallback',
    schema_mode: attachmentSchemaMode(schemaMode),
    error_code: errorCode,
    retryable: retryable === true
  }
}

export const ATTACHMENT_MODEL_CONTRACT_LIMITS = Object.freeze({
  maxRecords: DEFAULT_MAX_RECORDS,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES
})
