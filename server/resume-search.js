import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  buildBusinessCandidateEvidencePlan,
  buildBusinessCandidatePlans,
  mapBusinessCandidateResults
} from './business-search.js'
import { ReadonlyQueryError } from './readonly-query.js'

const MAX_QUERY_LENGTH = 500
const MAX_KEYWORDS = 16
const MAX_KEYWORD_LENGTH = 80
const MAX_PAGE = 10_000
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20
const MAX_EVIDENCE_PER_CANDIDATE = 3
const MAX_CURSOR_LENGTH = 2_048
const RESUME_CURSOR_VERSION = 1
const RESUME_INDEX_TABLE = 'candidate_resume_fts'
const RESUME_DOCUMENT_TABLE = 'candidate_resume_documents'
const RESUME_FTS_DOCSIZE_TABLE = 'candidate_resume_fts_docsize'
const RESUME_INDEX_TRIGGERS = [
  'candidate_resume_documents_ai',
  'candidate_resume_documents_au',
  'candidate_resume_documents_ad'
]

const SYNONYM_GROUPS = [
  { key: 'unity', label: 'Unity', terms: ['unity', 'unity3d', 'unity 3d', 'Unity 引擎'] },
  { key: 'overseas', label: '海外项目', terms: ['海外', '出海', '国际项目', 'overseas', 'international', 'global project'] },
  { key: 'game', label: '游戏开发', terms: ['游戏', '游戏开发', 'game', 'gaming'] },
  { key: 'frontend', label: '前端', terms: ['前端', 'frontend', 'front end', 'web ui'] },
  { key: 'backend', label: '后端', terms: ['后端', 'backend', 'back end', 'server side'] },
  { key: 'machine_learning', label: '机器学习', terms: ['机器学习', 'machine learning', 'ml'] },
  { key: 'artificial_intelligence', label: '人工智能', terms: ['人工智能', 'artificial intelligence', 'ai'] },
  { key: 'shanghai', label: '上海', terms: ['上海', '上海市', 'shanghai'], location: '上海' },
  { key: 'beijing', label: '北京', terms: ['北京', '北京市', 'beijing'], location: '北京' },
  { key: 'shenzhen', label: '深圳', terms: ['深圳', '深圳市', 'shenzhen'], location: '深圳' },
  { key: 'guangzhou', label: '广州', terms: ['广州', '广州市', 'guangzhou'], location: '广州' },
  { key: 'hangzhou', label: '杭州', terms: ['杭州', '杭州市', 'hangzhou'], location: '杭州' }
]

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'candidate', 'candidates', 'current', 'currently', 'experience',
  'find', 'for', 'has', 'have', 'having', 'in', 'least', 'located', 'more', 'of', 'or',
  'people', 'person', 'project', 'resume', 'than', 'the', 'three', 'to', 'who', 'with',
  'work', 'worked', 'year', 'years'
])

export class ResumeSearchError extends Error {
  constructor(code, message, { status = 400, details, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ResumeSearchError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, options) {
  throw new ResumeSearchError(code, message, options)
}

function scalar(input, ...names) {
  for (const name of names) {
    const value = input?.[name]
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) return value.length === 1 ? value[0] : value
      return value
    }
  }
  return undefined
}

function boundedInteger(input, names, fallback, maximum) {
  const value = scalar(input, ...names)
  if (value === undefined) return fallback
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) fail('invalid_query', `${names[0]} 必须是正整数`)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail('invalid_query', `${names[0]} 必须在 1 至 ${maximum} 之间`)
  }
  return parsed
}

function boundedNumber(input, names, minimum, maximum) {
  const value = scalar(input, ...names)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    fail('invalid_query', `${names[0]} 必须在 ${minimum} 至 ${maximum} 之间`)
  }
  return parsed
}

function boundedText(input, names, maximum, { required = false } = {}) {
  const value = scalar(input, ...names)
  if (value === undefined) {
    if (required) fail('invalid_query', `${names[0]} 不能为空`)
    return undefined
  }
  if (typeof value !== 'string') fail('invalid_query', `${names[0]} 必须是文本`)
  const text = value.trim().replace(/\s+/g, ' ')
  if (!text && required) fail('invalid_query', `${names[0]} 不能为空`)
  if (text.length > maximum) fail('invalid_query', `${names[0]} 不能超过 ${maximum} 个字符`)
  return text || undefined
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined
  if (value === true || value === false) return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  fail('invalid_query', `${field} must be boolean`)
}

function normalizeArchived(input) {
  const explicit = scalar(input, 'archived')
  if (explicit === undefined && scalar(input, 'include_archived') === false) return 'exclude'
  const value = String(explicit ?? 'include').toLowerCase()
  if (!['include', 'exclude', 'only'].includes(value)) {
    fail('invalid_query', 'archived 仅支持 include、exclude 或 only')
  }
  return value
}

function normalizeStringList(value, field, { maximum = 100, itemMaximum = 200, allowed } = {}) {
  if (value === undefined || value === null || value === '') return []
  const values = Array.isArray(value) ? value : String(value).split(',')
  if (values.length > maximum) fail('limit_exceeded', `${field} 最多包含 ${maximum} 项`, { status: 413 })
  const output = []
  for (const raw of values) {
    if (typeof raw !== 'string') fail('invalid_query', `${field} 必须是文本数组`)
    const item = raw.trim()
    if (!item || item.length > itemMaximum) fail('invalid_query', `${field} 包含无效值`)
    if (allowed && !allowed.has(item)) fail('invalid_query', `${field} 包含不支持的值：${item}`)
    if (!output.includes(item)) output.push(item)
  }
  return output
}

function normalizeSearchFields(value) {
  const aliases = new Map([
    ['title', 'title'],
    ['content', 'content'],
    ['candidate_resume_documents.title', 'title'],
    ['candidate_resume_documents.content', 'content']
  ])
  const values = normalizeStringList(value, 'fields', { maximum: 2, itemMaximum: 100 })
  return values.map((field) => {
    const normalized = aliases.get(field)
    if (!normalized) fail('invalid_query', `fields 包含不支持的字段：${field}`)
    return normalized
  }).filter((field, index, fields) => fields.indexOf(field) === index)
}

function normalizedForMatching(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function containsAlias(normalizedQuery, alias) {
  const normalizedAlias = normalizedForMatching(alias)
  if (/^[a-z0-9][a-z0-9 +#.-]*$/i.test(normalizedAlias)) {
    const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalizedQuery)
  }
  return normalizedQuery.includes(normalizedAlias)
}

function synonymGroupFor(value) {
  const normalized = normalizedForMatching(value)
  return SYNONYM_GROUPS.find((group) => group.terms.some((term) => normalized === normalizedForMatching(term)))
}

function standaloneConcept(value) {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > MAX_KEYWORD_LENGTH) return null
  return { key: `term:${normalizedForMatching(normalized)}`, label: normalized, terms: [normalized] }
}

function conceptsFromExplicitKeywords(keywords) {
  const values = normalizeStringList(keywords, 'keywords', {
    maximum: MAX_KEYWORDS,
    itemMaximum: MAX_KEYWORD_LENGTH
  })
  return values.map((value) => synonymGroupFor(value) ?? standaloneConcept(value)).filter(Boolean)
}

function conceptsFromExplicitPhrases(phrases) {
  const values = normalizeStringList(phrases, 'phrases', {
    maximum: MAX_KEYWORDS,
    itemMaximum: MAX_KEYWORD_LENGTH
  })
  return values.map(standaloneConcept).filter(Boolean)
}

function conceptsFromNaturalQuery(query) {
  const quotedPhrases = []
  const unquotedQuery = query.replace(/["“]([^"”]{1,80})["”]/gu, (_match, phrase) => {
    const concept = standaloneConcept(phrase)
    if (concept) quotedPhrases.push(concept)
    return ' '
  })
  const normalized = normalizedForMatching(unquotedQuery)
  const concepts = SYNONYM_GROUPS.filter((group) => group.terms.some((term) => containsAlias(normalized, term)))
  const representedAliases = new Set(concepts.flatMap((group) => group.terms.map(normalizedForMatching)))
  const words = unquotedQuery.normalize('NFKC').match(/[A-Za-z][A-Za-z0-9+#.-]{1,49}/g) ?? []
  for (const word of words) {
    const key = normalizedForMatching(word)
    if (ENGLISH_STOP_WORDS.has(key)) continue
    if (representedAliases.has(key)) continue
    concepts.push(synonymGroupFor(word) ?? standaloneConcept(word))
  }

  // `unicode61` does not perform language-model token extraction. Keep an exact
  // Chinese phrase only when no known concept was found, so conversational
  // prefixes do not become mandatory FTS terms.
  if (concepts.length === 0) {
    const chineseSegments = unquotedQuery.normalize('NFKC').match(/[\p{Script=Han}]{2,40}/gu) ?? []
    for (const segment of chineseSegments) concepts.push(standaloneConcept(segment))
  }
  return [...quotedPhrases, ...concepts].filter(Boolean)
}

function deduplicateConcepts(concepts) {
  const seen = new Set()
  const result = []
  for (const concept of concepts) {
    if (!concept || seen.has(concept.key)) continue
    seen.add(concept.key)
    const terms = [...new Set(concept.terms.map((term) => term.normalize('NFKC').trim()).filter(Boolean))]
      .slice(0, 12)
    if (terms.length) result.push({ ...concept, terms })
    if (result.length >= MAX_KEYWORDS) break
  }
  return result
}

function inferMinimumYears(query) {
  if (!query) return undefined
  const patterns = [
    /(?:至少|不低于|不少于|超过|有)?\s*(\d{1,2}(?:\.\d+)?)\s*年(?:以上)?/u,
    /(?:at\s+least|more\s+than|over)?\s*(\d{1,2}(?:\.\d+)?)\s*\+?\s*years?/i
  ]
  for (const pattern of patterns) {
    const match = query.match(pattern)
    if (match) return Number(match[1])
  }
  const chineseMatch = query.match(/([零一二三四五六七八九十两]{1,3})\s*年(?:以上)?/u)
  if (chineseMatch) {
    const digits = new Map([
      ['零', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
      ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
    ])
    const value = chineseMatch[1].includes('十')
      ? (() => {
          const [tens, ones] = chineseMatch[1].split('十')
          return (tens ? digits.get(tens) : 1) * 10 + (ones ? digits.get(ones) : 0)
        })()
      : digits.get(chineseMatch[1])
    if (Number.isFinite(value) && value >= 0 && value <= 80) return value
  }
  return undefined
}

function inferLocation(query, concepts) {
  if (!query) return undefined
  const locationGroups = concepts.filter((concept) => concept.location)
  if (locationGroups.length !== 1) return undefined
  const group = locationGroups[0]
  const normalized = normalizedForMatching(query)
  const explicitContext = group.terms.some((term) => {
    const value = normalizedForMatching(term)
    return normalized.includes(`在${value}`) || normalized.includes(`位于${value}`) ||
      normalized.includes(`location ${value}`) || normalized.includes(`located in ${value}`)
  })
  return explicitContext ? group.location : undefined
}

function ftsPhrase(term) {
  const cleaned = term
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/"/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
  if (!cleaned) fail('invalid_query', '关键词不能只包含控制字符或引号')
  return `"${cleaned}"`
}

function conceptExpression(concept) {
  const terms = concept.terms.map(ftsPhrase)
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`
}

function resumeConceptExpression(search, concept) {
  const expression = conceptExpression(concept)
  if (!search.fields.length) return expression
  const scoped = search.fields.map((field) => `${field} : ${expression}`)
  return scoped.length === 1 ? scoped[0] : `(${scoped.join(' OR ')})`
}

export function normalizeResumeSearch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_query', '检索参数必须是对象')
  const query = boundedText(input, ['q', 'query'], MAX_QUERY_LENGTH)
  const explicitKeywords = input.keywords === undefined ? [] : conceptsFromExplicitKeywords(input.keywords)
  const explicitPhrases = input.phrases === undefined ? [] : conceptsFromExplicitPhrases(input.phrases)
  const explicitConcepts = [...explicitKeywords, ...explicitPhrases]
  const concepts = deduplicateConcepts(explicitConcepts.length ? explicitConcepts : conceptsFromNaturalQuery(query ?? ''))
  if (!concepts.length) fail('invalid_query', '请提供至少一个有效的履历关键词')

  const matchMode = String(scalar(input, 'match_mode', 'matchMode') ?? 'all').toLowerCase()
  if (!['all', 'any'].includes(matchMode)) fail('invalid_query', 'match_mode 仅支持 all 或 any')
  const includeTotalValue = optionalBoolean(input.include_total ?? input.includeTotal, 'include_total')
  const fastValue = optionalBoolean(input.fast, 'fast')
  if (fastValue === true && includeTotalValue === true) {
    fail('invalid_query', 'fast cannot be combined with include_total=true')
  }
  const sourceTypes = normalizeStringList(input.source_types ?? input.sourceTypes, 'source_types', {
    maximum: 3,
    itemMaximum: 30,
    allowed: new Set(['candidate', 'profile_section', 'attachment'])
  })
  const page = boundedInteger(input, ['page'], 1, MAX_PAGE)
  const pageSize = boundedInteger(input, ['page_size', 'pageSize', 'limit'], DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const cursor = boundedText(input, ['cursor'], MAX_CURSOR_LENGTH)
  if (cursor && scalar(input, 'page') !== undefined && page !== 1) {
    fail('invalid_query', 'cursor cannot be combined with page greater than 1')
  }
  const explicitMinYears = boundedNumber(input, ['min_years', 'minYears'], 0, 80)
  const minYears = explicitMinYears ?? inferMinimumYears(query)
  const maxYears = boundedNumber(input, ['max_years', 'maxYears'], 0, 80)
  if (minYears !== undefined && maxYears !== undefined && minYears > maxYears) {
    fail('invalid_query', 'min_years 不能大于 max_years')
  }
  const explicitLocation = boundedText(input, ['location'], 200)

  return {
    query,
    concepts,
    match_mode: matchMode,
    include_total: includeTotalValue === undefined ? fastValue !== true : includeTotalValue,
    fast: fastValue === true || includeTotalValue === false,
    archived: normalizeArchived(input),
    location: explicitLocation ?? inferLocation(query, concepts),
    min_years: minYears,
    max_years: maxYears,
    stage: boundedText(input, ['stage'], 80),
    position_id: boundedText(input, ['position_id', 'positionId'], 200),
    talent_pool_id: boundedText(input, ['talent_pool_id', 'pool_id', 'talentPoolId'], 200),
    candidate_ids: normalizeStringList(input.candidate_ids ?? input.candidateIds, 'candidate_ids', {
      maximum: 100,
      itemMaximum: 200
    }),
    source_types: sourceTypes,
    fields: normalizeSearchFields(input.fields ?? input.field_paths ?? input.fieldPaths),
    cursor,
    page,
    page_size: pageSize,
    evidence_limit: boundedInteger(input, ['evidence_limit', 'evidenceLimit'], MAX_EVIDENCE_PER_CANDIDATE, 5)
  }
}

function escapeLike(value) {
  return value.replace(/[!%_]/g, (character) => `!${character}`)
}

function candidateFilters(search, parameters) {
  const clauses = []
  if (search.archived === 'exclude') clauses.push('c.archived_at IS NULL')
  if (search.archived === 'only') clauses.push('c.archived_at IS NOT NULL')
  if (search.location) {
    clauses.push("lower(coalesce(c.location, '')) LIKE lower(?) ESCAPE '!'")
    parameters.push(`%${escapeLike(search.location)}%`)
  }
  if (search.min_years !== undefined) {
    clauses.push('c.years_experience >= ?')
    parameters.push(search.min_years)
  }
  if (search.max_years !== undefined) {
    clauses.push('c.years_experience <= ?')
    parameters.push(search.max_years)
  }
  if (search.stage) {
    clauses.push('c.stage = ?')
    parameters.push(search.stage)
  }
  if (search.position_id) {
    clauses.push('EXISTS (SELECT 1 FROM candidate_positions cp WHERE cp.candidate_id = c.id AND cp.position_id = ?)')
    parameters.push(search.position_id)
  }
  if (search.talent_pool_id) {
    clauses.push('EXISTS (SELECT 1 FROM candidate_talent_pools ctp WHERE ctp.candidate_id = c.id AND ctp.talent_pool_id = ?)')
    parameters.push(search.talent_pool_id)
  }
  if (search.candidate_ids.length) {
    clauses.push(`c.id IN (${search.candidate_ids.map(() => '?').join(', ')})`)
    parameters.push(...search.candidate_ids)
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

function conceptCtes(search, parameters) {
  const sourceClause = search.source_types.length
    ? ` AND candidate_resume_fts.source_type IN (${search.source_types.map(() => '?').join(', ')})`
    : ''
  const selects = search.concepts.map((concept, index) => {
    parameters.push(resumeConceptExpression(search, concept))
    if (search.source_types.length) parameters.push(...search.source_types)
    return `
      SELECT candidate_id, ${index} AS concept_index,
        MIN(rank) AS concept_rank
      FROM candidate_resume_fts
      WHERE candidate_resume_fts MATCH ?
        AND rank MATCH 'bm25(0.0, 0.0, 0.0, 4.0, 1.0)'${sourceClause}
      GROUP BY candidate_id`
  })
  const requiredConcepts = search.match_mode === 'all' ? search.concepts.length : 1
  return `
    concept_hits AS (${selects.join('\n      UNION ALL\n')}),
    candidate_matches AS (
      SELECT candidate_id, SUM(concept_rank) AS bm25_rank,
        COUNT(DISTINCT concept_index) AS concept_count,
        GROUP_CONCAT(concept_index) AS matched_concepts
      FROM concept_hits
      GROUP BY candidate_id
      HAVING COUNT(DISTINCT concept_index) >= ${requiredConcepts}
    )`
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table))
}

export function getResumeSearchStatus(db) {
  if (!db || typeof db.prepare !== 'function') {
    fail('invalid_database', '需要有效的 SQLite 数据库连接', { status: 500 })
  }
  try {
    const ftsSql = db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
    `).get(RESUME_INDEX_TABLE)?.sql ?? ''
    const available = tableExists(db, RESUME_DOCUMENT_TABLE) &&
      tableExists(db, RESUME_INDEX_TABLE) &&
      tableExists(db, RESUME_FTS_DOCSIZE_TABLE) &&
      /\bfts5\s*\(/i.test(ftsSql)
    if (!available) {
      return {
        state: 'unavailable',
        ready: false,
        available: false,
        progress: null,
        remaining: null,
        processed: null,
        queued: null,
        document_count: null,
        updated_at: null,
        retry_after_ms: 2_000,
        search_index: RESUME_INDEX_TABLE,
        error: {
          code: 'fts5_unavailable',
          message: '候选人履历 FTS5 索引不可用。'
        }
      }
    }

    const source = db.prepare(`
      SELECT COUNT(*) AS count, MIN(row_id) AS minimum, MAX(row_id) AS maximum
      FROM ${RESUME_DOCUMENT_TABLE}
    `).get()
    const indexed = db.prepare(`
      SELECT COUNT(*) AS count, MIN(id) AS minimum, MAX(id) AS maximum
      FROM ${RESUME_FTS_DOCSIZE_TABLE}
    `).get()
    const triggerRows = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (${RESUME_INDEX_TRIGGERS.map(() => '?').join(', ')})
    `).all(...RESUME_INDEX_TRIGGERS)
    const sourceCount = Number(source.count ?? 0)
    const indexedCount = Number(indexed.count ?? 0)
    const boundariesMatch = sourceCount === 0
      ? indexedCount === 0
      : Number(source.minimum) === Number(indexed.minimum) && Number(source.maximum) === Number(indexed.maximum)
    const triggersReady = triggerRows.length === RESUME_INDEX_TRIGGERS.length
    const ready = sourceCount === indexedCount && boundariesMatch && triggersReady
    const remaining = Math.abs(sourceCount - indexedCount)
    const progress = ready || sourceCount === 0
      ? 1
      : Number(Math.min(0.999999, indexedCount / sourceCount).toFixed(6))
    const state = ready ? 'ready' : triggersReady ? 'indexing' : 'failed'
    return {
      state,
      ready,
      available: true,
      progress,
      remaining,
      processed: indexedCount,
      queued: sourceCount,
      document_count: sourceCount,
      indexed_document_count: indexedCount,
      updated_at: null,
      retry_after_ms: ready ? null : 2_000,
      search_index: RESUME_INDEX_TABLE,
      error: ready
        ? null
        : {
            code: triggersReady ? 'resume_search_index_mismatch' : 'resume_search_triggers_missing',
            message: triggersReady
              ? '候选人履历索引与源文档数量或边界不一致。'
              : '候选人履历增量索引触发器不完整。'
          }
    }
  } catch (error) {
    if (error instanceof ResumeSearchError) throw error
    fail('fts5_unavailable', '候选人履历 FTS5 索引状态检查失败', {
      status: 503,
      cause: error
    })
  }
}

function assertResumeSearchReady(db) {
  const status = getResumeSearchStatus(db)
  if (!status.available) {
    fail('fts5_unavailable', '候选人履历 FTS5 索引不可用，无法执行全文检索', {
      status: 503,
      details: status
    })
  }
  if (!status.ready) {
    fail('search_index_not_ready', '候选人履历索引尚未就绪，请稍后重试', {
      status: 503,
      details: status
    })
  }
  return status
}

function resumeSearchFingerprint(search) {
  return createHash('sha256').update(JSON.stringify({
    concepts: search.concepts.map((concept) => ({ label: concept.label, terms: [...concept.terms] })),
    match_mode: search.match_mode,
    archived: search.archived,
    location: search.location ?? null,
    min_years: search.min_years ?? null,
    max_years: search.max_years ?? null,
    stage: search.stage ?? null,
    position_id: search.position_id ?? null,
    talent_pool_id: search.talent_pool_id ?? null,
    candidate_ids: [...search.candidate_ids],
    source_types: [...search.source_types],
    fields: [...search.fields],
    page_size: search.page_size
  })).digest('hex')
}

function decodeResumeCursor(value, search) {
  if (!value) return null
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('invalid_cursor', '履历检索游标无效')
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    fail('invalid_cursor', '履历检索游标无效')
  }
  if (
    parsed?.v !== RESUME_CURSOR_VERSION ||
    parsed.q !== resumeSearchFingerprint(search) ||
    !Number.isSafeInteger(parsed.p) || parsed.p < 1 || parsed.p > MAX_PAGE ||
    !Number.isSafeInteger(parsed.cc) || parsed.cc < 1 ||
    !Number.isFinite(parsed.r) ||
    typeof parsed.u !== 'string' || !parsed.u || parsed.u.length > 100 ||
    typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 200
  ) {
    fail('invalid_cursor', '履历检索游标与当前查询不匹配')
  }
  return parsed
}

function encodeResumeCursor(search, row, page) {
  if (!row || !Number.isFinite(Number(row.bm25_rank))) return null
  return Buffer.from(JSON.stringify({
    v: RESUME_CURSOR_VERSION,
    q: resumeSearchFingerprint(search),
    p: page,
    cc: Number(row.concept_count),
    r: Number(row.bm25_rank),
    u: String(row.sort_updated_at),
    id: String(row.candidate_id)
  }), 'utf8').toString('base64url')
}

function resumeCursorFilter(cursor, parameters) {
  if (!cursor) return ''
  parameters.push(
    cursor.cc,
    cursor.cc, cursor.r,
    cursor.cc, cursor.r, cursor.u,
    cursor.cc, cursor.r, cursor.u, cursor.id
  )
  return `(
    cm.concept_count < ? OR
    (cm.concept_count = ? AND cm.bm25_rank > ?) OR
    (cm.concept_count = ? AND cm.bm25_rank = ? AND c.updated_at < ?) OR
    (cm.concept_count = ? AND cm.bm25_rank = ? AND c.updated_at = ? AND c.id > ?)
  )`
}

function pageQuery(search) {
  if (search.cursor && search.include_total) {
    fail('invalid_cursor', '游标分页必须使用 include_total=false')
  }
  const parameters = []
  const ctes = conceptCtes(search, parameters)
  const filters = candidateFilters(search, parameters)
  const cursor = decodeResumeCursor(search.cursor, search)
  const cursorFilter = resumeCursorFilter(cursor, parameters)
  const where = cursorFilter
    ? filters ? `${filters} AND ${cursorFilter}` : `WHERE ${cursorFilter}`
    : filters
  parameters.push(search.include_total ? search.page_size : search.page_size + 1)
  if (!cursor) parameters.push((search.page - 1) * search.page_size)
  const totalColumn = search.include_total ? ', COUNT(*) OVER () AS total' : ''
  return {
    sql: `
      WITH ${ctes}
      SELECT cm.candidate_id, c.name, cm.bm25_rank, cm.concept_count,
        cm.matched_concepts, c.updated_at AS sort_updated_at${totalColumn}
      FROM candidate_matches cm
      JOIN candidates c ON c.id = cm.candidate_id
      ${where}
      ORDER BY cm.concept_count DESC, cm.bm25_rank ASC, c.updated_at DESC, c.id ASC
      LIMIT ?${cursor ? '' : ' OFFSET ?'}
    `,
    parameters,
    result_page: cursor ? cursor.p + 1 : search.page
  }
}

function countQuery(search) {
  const parameters = []
  const ctes = conceptCtes(search, parameters)
  const filters = candidateFilters(search, parameters)
  return {
    sql: `
    WITH ${ctes}
    SELECT COUNT(*) AS total
    FROM candidate_matches cm
    JOIN candidates c ON c.id = cm.candidate_id
    ${filters}
  `,
    parameters
  }
}

function countRows(db, search) {
  const query = countQuery(search)
  return Number(db.prepare(query.sql).get(...query.parameters).total)
}

export function buildResumeSearchPlans(input = {}) {
  const search = Array.isArray(input?.concepts) ? input : normalizeResumeSearch(input)
  return {
    search,
    page: pageQuery(search),
    count: countQuery(search)
  }
}

function evidenceQuery(search, candidateIds) {
  if (!candidateIds.length) return null
  const broadExpression = search.concepts.map((concept) => resumeConceptExpression(search, concept)).join(' OR ')
  const sourceClause = search.source_types.length
    ? ` AND candidate_resume_fts.source_type IN (${search.source_types.map(() => '?').join(', ')})`
    : ''
  const candidatePlaceholders = candidateIds.map(() => '?').join(', ')
  const fieldPath = search.fields.length === 1 && search.fields[0] === 'title'
    ? "'candidate_resume_documents.title'"
    : `CASE candidate_resume_fts.source_type
        WHEN 'profile_section' THEN 'candidate_profile_sections.content'
        WHEN 'attachment' THEN 'candidate_attachments.extracted_text'
        ELSE 'candidate_resume_documents.content'
      END`
  const boundedContent = search.fields.length === 1 && search.fields[0] === 'title'
    ? "substr(coalesce(d.title, ''), 1, 1000)"
    : "trim(substr(coalesce(d.title, ''), 1, 500) || char(10) || snippet(candidate_resume_fts, 4, '', '', ' ... ', 64))"
  return {
    sql: `
    WITH document_hits AS (
      SELECT candidate_resume_fts.candidate_id AS mapped_candidate_id,
        candidate_resume_fts.candidate_id, candidate_resume_fts.document_id,
        CASE candidate_resume_fts.source_type
          WHEN 'profile_section' THEN 'profile_section'
          WHEN 'attachment' THEN 'candidate_attachment'
          ELSE 'candidate'
        END AS entity_type,
        coalesce(d.source_id, candidate_resume_fts.candidate_id) AS entity_id,
        CASE candidate_resume_fts.source_type
          WHEN 'profile_section' THEN 'candidate_profile_sections'
          WHEN 'attachment' THEN 'candidate_attachments'
          ELSE 'candidates'
        END AS source_table,
        coalesce(d.source_id, candidate_resume_fts.candidate_id) AS source_row_id,
        ${fieldPath} AS field_path, d.title,
        ${boundedContent} AS content,
        0 AS segment_index, 1 AS segment_count, 0 AS char_start,
        rank AS bm25_rank,
        candidate_resume_fts.source_type
      FROM candidate_resume_fts
      JOIN candidate_resume_documents d
        ON d.document_id = candidate_resume_fts.document_id
      WHERE candidate_resume_fts MATCH ?
        AND rank MATCH 'bm25(0.0, 0.0, 0.0, 4.0, 1.0)'${sourceClause}
        AND candidate_resume_fts.candidate_id IN (${candidatePlaceholders})
    ),
    ranked_hits AS (
      SELECT document_hits.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate_id
          ORDER BY bm25_rank ASC, document_id ASC
        ) AS evidence_rank
      FROM document_hits
    )
    SELECT ranked_hits.*, length(content) AS char_end FROM ranked_hits
    WHERE evidence_rank <= ?
    ORDER BY mapped_candidate_id, evidence_rank
  `,
    parameters: [
      broadExpression,
      ...search.source_types,
      ...candidateIds,
      search.evidence_limit
    ]
  }
}

function translateSqliteError(error) {
  if (error instanceof ResumeSearchError) throw error
  if (error instanceof ReadonlyQueryError) {
    fail(error.code ?? 'readonly_query_failed', error.message, {
      status: Number(error.status) || 500,
      details: {
        ...(error.details && typeof error.details === 'object' ? error.details : {}),
        ...(error.audit && typeof error.audit === 'object' ? { audit: error.audit } : {})
      },
      cause: error
    })
  }
  if (error?.name === 'BusinessSearchError') {
    if (error.code === 'business_search_unavailable') {
      fail('fts5_unavailable', '候选人全字段 FTS5 索引不可用，无法执行全文检索', {
        status: 503,
        cause: error
      })
    }
    fail(error.code ?? 'resume_search_failed', error.message, {
      status: Number(error.status) || 500,
      details: error.details,
      cause: error
    })
  }
  const message = String(error?.message ?? '')
  if (/no such (?:table|module):\s*(?:candidate_resume_fts|fts5)/i.test(message)) {
    fail('fts5_unavailable', '候选人履历 FTS5 索引不可用，无法执行全文检索', {
      status: 503,
      cause: error
    })
  }
  fail('resume_search_failed', '候选人履历检索失败', { status: 500, cause: error })
}

export function searchCandidateResumes(db, input = {}) {
  return searchCandidateResumesIndexed(db, input)
}

export function searchCandidateResumesIndexed(db, input = {}, { defaultFast = false } = {}) {
  if (!db || typeof db.prepare !== 'function') fail('invalid_database', '需要有效的 SQLite 数据库连接', { status: 500 })
  const searchStarted = performance.now()
  const effectiveInput = defaultFast && input && typeof input === 'object' && !Array.isArray(input) &&
    input.fast === undefined && input.include_total === undefined && input.includeTotal === undefined
    ? { ...input, fast: true }
    : input
  const search = normalizeResumeSearch(effectiveInput)
  try {
    const statusStarted = performance.now()
    const index = assertResumeSearchReady(db)
    const indexStatusMs = performance.now() - statusStarted

    const planningStarted = performance.now()
    const pagePlan = pageQuery(search)
    const planningMs = performance.now() - planningStarted

    const pageStarted = performance.now()
    const rawRows = db.prepare(pagePlan.sql).all(...pagePlan.parameters)
    const pageMs = performance.now() - pageStarted
    const rows = rawRows.slice(0, search.page_size)

    const countStarted = performance.now()
    let total = search.include_total ? Number(rawRows[0]?.total ?? 0) : null
    if (search.include_total && !rows.length && search.page > 1) total = countRows(db, search)
    const countMs = performance.now() - countStarted

    const evidencePlan = evidenceQuery(search, rows.map((row) => row.candidate_id))
    const evidenceStarted = performance.now()
    const evidence = evidencePlan
      ? db.prepare(evidencePlan.sql).all(...evidencePlan.parameters)
      : []
    const evidenceMs = performance.now() - evidenceStarted

    const resultPage = pagePlan.result_page
    const hasMore = search.include_total
      ? total > resultPage * search.page_size
      : rawRows.length > search.page_size
    const nextCursor = hasMore && rows.length
      ? encodeResumeCursor(search, rows.at(-1), resultPage)
      : null
    const mappingStarted = performance.now()
    const items = mapBusinessCandidateResults(search, rows, evidence)
    const mappingMs = performance.now() - mappingStarted

    return {
      items,
      pagination: {
        page: resultPage,
        page_size: search.page_size,
        total,
        total_pages: total === null ? null : Math.ceil(total / search.page_size),
        has_more: hasMore,
        next_cursor: nextCursor
      },
      query: {
        terms: search.concepts.map((concept) => ({ label: concept.label, terms: [...concept.terms] })),
        match_mode: search.match_mode,
        filters: {
          archived: search.archived,
          location: search.location ?? null,
          min_years: search.min_years ?? null,
          max_years: search.max_years ?? null,
          stage: search.stage ?? null,
          position_id: search.position_id ?? null,
          talent_pool_id: search.talent_pool_id ?? null,
          source_types: [...search.source_types],
          fields: [...search.fields]
        }
      },
      context: {
        candidate_limit: search.page_size,
        evidence_per_candidate: search.evidence_limit,
        database_scope: 'all_matching_candidates',
        search_index: RESUME_INDEX_TABLE
      },
      index,
      performance: {
        index_status_ms: Number(indexStatusMs.toFixed(1)),
        planning_ms: Number(planningMs.toFixed(1)),
        page_ms: Number(pageMs.toFixed(1)),
        count_ms: Number(countMs.toFixed(1)),
        evidence_ms: Number(evidenceMs.toFixed(1)),
        mapping_ms: Number(mappingMs.toFixed(1)),
        total_ms: Number((performance.now() - searchStarted).toFixed(1))
      }
    }
  } catch (error) {
    return translateSqliteError(error)
  }
}

export async function searchCandidateResumesReadonly(readonlyService, input = {}) {
  if (!readonlyService || typeof readonlyService.executeReadonlyQuery !== 'function') {
    fail('invalid_database', '需要有效的独立只读查询服务', { status: 500 })
  }
  const readonlyInput = { ...input }
  if (
    readonlyInput.include_total === undefined
    && readonlyInput.includeTotal === undefined
    && readonlyInput.fast === undefined
  ) {
    readonlyInput.include_total = false
  }
  const search = normalizeResumeSearch(readonlyInput)
  // Keep evidence within the normal 100-row tool ceiling. The caller can page
  // for more candidates instead of expanding a single model context.
  search.page_size = Math.min(search.page_size, 50)
  search.evidence_limit = Math.min(search.evidence_limit, Math.max(1, Math.floor(100 / search.page_size)))
  try {
    const plans = buildBusinessCandidatePlans(search)
    const pageResult = await readonlyService.executeReadonlyQuery({
      ...plans.page,
      maxRows: Math.min(100, search.page_size + 1),
      maxBytes: 400_000,
      tool: 'search_candidate_resumes'
    })
    const rawRows = pageResult.rows
    const rows = rawRows.slice(0, search.page_size)
    let total = search.include_total ? Number(rawRows[0]?.total ?? 0) : null
    if (search.include_total && !rows.length && search.page > 1) {
      const firstPagePlan = buildBusinessCandidatePlans({ ...search, page: 1, page_size: 1 }).page
      const countResult = await readonlyService.executeReadonlyQuery({
        ...firstPagePlan,
        maxRows: 1,
        maxBytes: 32_768,
        tool: 'search_candidate_resumes_count'
      })
      total = Number(countResult.rows[0]?.total ?? 0)
    }
    const evidencePlan = buildBusinessCandidateEvidencePlan(plans.search, rows.map((row) => row.candidate_id))
    const evidenceResult = evidencePlan
      ? (await readonlyService.executeReadonlyQuery({
          ...evidencePlan,
          maxRows: Math.min(100, search.page_size * search.evidence_limit),
          maxBytes: 500_000,
          tool: 'search_candidate_resume_evidence'
        }))
      : { rows: [], worker_peak_rss_bytes: 0 }
    const evidence = evidenceResult.rows
    return {
      items: mapBusinessCandidateResults(plans.search, rows, evidence),
      pagination: {
        page: search.page,
        page_size: search.page_size,
        total,
        total_pages: total === null ? null : Math.ceil(total / search.page_size),
        has_more: Boolean(
          pageResult.has_more
          || rawRows.length > search.page_size
          || (search.fast && rows.length >= search.page_size)
          || (search.include_total && total > search.page * search.page_size)
        ),
        next_cursor: null
      },
      query: {
        terms: search.concepts.map((concept) => ({ label: concept.label, terms: [...concept.terms] })),
        match_mode: search.match_mode,
        filters: {
          archived: search.archived,
          location: search.location ?? null,
          min_years: search.min_years ?? null,
          max_years: search.max_years ?? null,
          stage: search.stage ?? null,
          position_id: search.position_id ?? null,
          talent_pool_id: search.talent_pool_id ?? null,
          source_types: [...search.source_types]
        }
      },
      context: {
        candidate_limit: search.page_size,
        evidence_per_candidate: search.evidence_limit,
        database_scope: 'all_matching_candidates',
        search_index: 'business_v2'
      },
      performance: {
        worker_peak_rss_bytes: Math.max(
          Number(pageResult.worker_peak_rss_bytes) || 0,
          Number(evidenceResult.worker_peak_rss_bytes) || 0
        )
      }
    }
  } catch (error) {
    return translateSqliteError(error)
  }
}
