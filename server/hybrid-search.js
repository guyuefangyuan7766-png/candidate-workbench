import { performance } from 'node:perf_hooks'
import {
  businessSearchTermExpression,
  isBusinessSearchReady
} from './business-search.js'
import { readSearchDocuments } from './search-vector-store.js'
import { readSearchIdentities, redactSearchText } from './search-data-minimization.js'

export class HybridSearchError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.retryable = code === 'search_index_changed' || String(code).startsWith('search_vector_')
  }
}
const fail = (code, message, status = 400) => {
  throw new HybridSearchError(code, message, { status })
}
const SOURCES = ['candidate', 'profile_section', 'attachment']
const LABELS = {
  candidate: '候选人主档',
  attachment: '附件简历',
  project: '项目经历',
  work: '工作经历',
  experience: '工作经历',
  education: '教育经历',
  skill: '专业技能',
  skills: '专业技能'
}
// Only direct authored fields can establish ability. JSON snapshots and relation
// descriptions never enter this projection, even when the legacy FTS matches them.
const SELF_DOCS_BRANCH_CANDIDATE = `SELECT d.document_id, d.row_id, c.id candidate_id, 'candidate' source_type, c.id source_id,
    'candidate' section_type, '候选人主档' title,
    coalesce(c.current_title,'') || char(10) || coalesce(c.self_summary,'') || char(10) ||
    CASE WHEN json_valid(c.tags) AND json_type(c.tags)='array' THEN coalesce((SELECT group_concat(value,char(10)) FROM json_each(c.tags) WHERE type='text'),'') ELSE '' END content
  FROM candidate_resume_documents d JOIN candidates c ON d.source_type='candidate' AND d.candidate_id=c.id`
const SELF_DOCS_BRANCH_SECTION = `SELECT d.document_id,d.row_id,s.candidate_id,'profile_section',s.id,s.section_type,coalesce(s.title,''),coalesce(s.content,'')
  FROM candidate_resume_documents d JOIN candidate_profile_sections s ON d.source_type='profile_section' AND d.source_id=s.id
  WHERE s.archived_at IS NULL AND s.section_type IN ('education','education_experience','experience','work_experience','work','project','project_experience','internship','skill','skills')`
const SELF_DOCS_BRANCH_ATTACHMENT = `SELECT d.document_id,d.row_id,a.candidate_id,'attachment',a.id,'attachment',a.original_filename,a.extracted_text
  FROM candidate_resume_documents d JOIN candidate_attachments a ON d.source_type='attachment' AND d.source_id=a.id
  WHERE a.parse_status='parsed' AND a.attachment_type='resume'`
const SELF_DOCS_BRANCHES = [
  SELF_DOCS_BRANCH_CANDIDATE,
  SELF_DOCS_BRANCH_SECTION,
  SELF_DOCS_BRANCH_ATTACHMENT
]
const SELF_DOCS_SEARCH_SOURCES = [
  'candidates',
  'candidate_profile_sections',
  'candidate_attachments'
]
const EQUIVALENTS = new Map([
  ['unity', ['Unity', 'Unity3D', 'Unity 3D']],
  ['unreal', ['Unreal', 'UE4', 'UE5', '虚幻引擎']],
  ['后端工程师', ['后端工程师', '后端开发', '服务端开发', 'backend engineer']],
  ['数值策划', ['数值策划', '数值体系设计', '数值平衡设计', '成长曲线设计']]
])
function terms(node) {
  return node.match === 'concept'
    ? (EQUIVALENTS.get(node.text.toLowerCase()) ?? [node.text])
    : [node.text]
}
function leaves(nodes, output = []) {
  for (const n of nodes) {
    if (n.children) leaves(n.children, output)
    else if (n.kind === 'term') output.push(n)
  }
  return output
}
function planNodes(plan) {
  return [
    ...(plan?.must ?? []),
    ...(plan?.should ?? []),
    ...(plan?.must_not ?? [])
  ]
}
function hasSourceFilter(node) {
  if (!node || typeof node !== 'object') return false
  if (node.kind === 'filter') return node.field === 'source'
  if (node.kind === 'not') return hasSourceFilter(node.child)
  return (node.children ?? []).some(hasSourceFilter)
}
function selfDocsCte(predicate, parameters) {
  // The predicate is repeated per UNION branch, so its bindings are too.
  const body = SELF_DOCS_BRANCHES.map(
    (branch) =>
      `${branch}${branch.includes(' WHERE ') ? ' AND ' : ' WHERE '}${predicate}`
  ).join(' UNION ALL ')
  return {
    docs: `WITH self_docs AS (${body})`,
    body,
    parameters: SELF_DOCS_BRANCHES.flatMap(() => parameters),
    narrowed: true
  }
}
const SELF_DOCS_UNSCOPED = {
  docs: `WITH self_docs AS (${SELF_DOCS_BRANCHES.join(' UNION ALL ')})`,
  body: SELF_DOCS_BRANCHES.join(' UNION ALL '),
  parameters: [],
  narrowed: false
}
/**
 * SQLite materialises `self_docs` for every statement that references it, so an
 * unbounded CTE costs one full read of the resume corpus per statement — tens of
 * seconds once the corpus reaches hundreds of thousands of documents, multiplied
 * by every statement a single search issues. Narrowing the CTE to the candidates
 * that can still match keeps the exact same rows while making the materialisation
 * proportional to the hit set instead of the whole database.
 *
 * Two narrowings are proven equivalent to the surrounding predicates:
 *   - an explicit candidate list is already part of the caller's WHERE clause;
 *   - every term node carries its own inverted-index prefilter, so the union of
 *     those index hits is a superset of the rows that term predicate can accept.
 * A `source` filter reads `self_docs` without such a prefilter, so it disables
 * term narrowing. Parameters are ordered for the CTE, before the caller's own.
 */
function selfDocsScope(plan, options = {}, candidateIds = null) {
  // A request that already materialised its narrowed projection reuses it, so the
  // corpus is read once for the whole search instead of once per statement.
  if (options.selfDocsTable) {
    const scoped = Array.isArray(candidateIds) ? candidateIds : []
    return {
      docs: scoped.length
        ? `WITH self_docs AS (SELECT * FROM ${options.selfDocsTable} WHERE candidate_id IN (${scoped.map(() => '?').join(',')}))`
        : `WITH self_docs AS (SELECT * FROM ${options.selfDocsTable})`,
      body: null,
      parameters: [...scoped],
      narrowed: true
    }
  }
  const ids = Array.isArray(candidateIds) ? candidateIds : []
  if (ids.length)
    return selfDocsCte(
      `d.candidate_id IN (${ids.map(() => '?').join(',')})`,
      [...ids]
    )
  const nodes = leaves(planNodes(plan))
  if (!nodes.length || planNodes(plan).some(hasSourceFilter))
    return SELF_DOCS_UNSCOPED
  const parameters = []
  const parts = []
  for (const node of nodes)
    for (const term of terms(node)) {
      if (/\p{Script=Han}/u.test(term)) {
        // Without the business gram index the matching predicate is a plain
        // substring scan, so there is no index hit set to narrow with.
        if (!options.gramIndexReady) return SELF_DOCS_UNSCOPED
        parameters.push(
          `search_text : (${businessSearchTermExpression(term)})`,
          ...SELF_DOCS_SEARCH_SOURCES
        )
        parts.push(
          `SELECT sd.candidate_id AS candidate_id FROM search_documents_v2_fts
           JOIN search_documents_v2 sd ON sd.row_id = search_documents_v2_fts.rowid
           WHERE search_documents_v2_fts MATCH ?
             AND sd.source_table IN (${SELF_DOCS_SEARCH_SOURCES.map(() => '?').join(',')})`
        )
      } else {
        parameters.push(quoteFts(term))
        parts.push(
          `SELECT d2.candidate_id AS candidate_id FROM candidate_resume_fts
           JOIN candidate_resume_documents d2 ON d2.row_id = candidate_resume_fts.rowid
           WHERE candidate_resume_fts MATCH ?`
        )
      }
    }
  if (!parts.length) return SELF_DOCS_UNSCOPED
  return selfDocsCte(
    `d.candidate_id IN (${parts.join(' UNION ')})`,
    parameters
  )
}
// One request at a time reaches a given connection, so a short-lived temp table
// per connection is enough. Tables are dropped when the next request materialises
// its own scope, and otherwise when the worker closes its connection.
const SELF_DOCS_TABLES = new WeakMap()
let selfDocsTableSequence = 0
function materialiseSelfDocsScope(db, plan, options, candidateIds) {
  const scope = selfDocsScope(plan, options, candidateIds)
  if (!scope.narrowed || !scope.body) return scope
  try {
    for (const stale of SELF_DOCS_TABLES.get(db) ?? [])
      db.exec(`DROP TABLE IF EXISTS temp.${stale}`)
    const name = `self_docs_scope_${(selfDocsTableSequence += 1)}`
    db.prepare(`CREATE TEMP TABLE ${name} AS ${scope.body}`).run(...scope.parameters)
    db.exec(`CREATE INDEX temp.${name}_candidate ON ${name}(candidate_id)`)
    SELF_DOCS_TABLES.set(db, [name])
    return {
      docs: `WITH self_docs AS (SELECT * FROM temp.${name})`,
      body: null,
      parameters: [],
      narrowed: true,
      table: `temp.${name}`
    }
  } catch {
    // Temporary tables are unavailable (for example an in-memory test database),
    // so fall back to the inline projection.
    return scope
  }
}
const quoteFts = (text) => `"${text.replace(/"/g, '""')}"`
function textPredicate(node, params, options = {}) {
  const fields = options.fields?.length ? options.fields : ['title', 'content']
  const field = fields
    .map((x) => `coalesce(d.${x},'')`)
    .join(' || char(10) || ')
  const rawTerms = terms(node)
  const predicates = rawTerms.map((term) => {
    params.push(term)
    const literal = `instr(lower(${field}), lower(?)) > 0`
    if (/\p{Script=Han}/u.test(term)) {
      if (!options.gramIndexReady) return literal
      params.push(`search_text : (${businessSearchTermExpression(term)})`)
      return `(${literal} AND d.candidate_id IN (SELECT sd.candidate_id FROM search_documents_v2_fts JOIN search_documents_v2 sd ON sd.row_id=search_documents_v2_fts.rowid WHERE search_documents_v2_fts MATCH ? AND sd.source_table IN ('candidates','candidate_profile_sections','candidate_attachments')))`
    }
    params.push(
      `${fields.length === 1 ? `${fields[0]} : ` : ''}${quoteFts(term)}`
    )
    return `(${literal} AND d.row_id IN (SELECT rowid FROM candidate_resume_fts WHERE candidate_resume_fts MATCH ?))`
  })
  const source = options.sourceTypes?.length ? options.sourceTypes : SOURCES
  params.push(...source)
  return `(${predicates.join(' OR ')}) AND d.source_type IN (${source.map(() => '?').join(',')})`
}
function filter(node, params) {
  const { field, op, value } = node
  const operators = { eq: '=', gte: '>=', lte: '<=', gt: '>', lt: '<' }
  const columns = {
    years: 'years_experience',
    current_location: 'location',
    current_title: 'current_title',
    current_company: 'current_company',
    education: 'education',
    stage: 'stage'
  }
  if (field === 'source') {
    const values = Array.isArray(value) ? value : [value]
    params.push(...values)
    return `EXISTS (SELECT 1 FROM self_docs d WHERE d.candidate_id=c.id AND d.source_type IN (${values.map(() => '?').join(',')}))`
  }
  if (field === 'archived')
    return value === 'include'
      ? '1'
      : ['only', 'archived'].includes(value)
        ? 'c.archived_at IS NOT NULL'
        : 'c.archived_at IS NULL'
  if (field === 'position_id' || field === 'talent_pool_id') {
    const values = Array.isArray(value) ? value : [value]
    params.push(...values)
    return `EXISTS (SELECT 1 FROM ${field === 'position_id' ? 'candidate_positions' : 'candidate_talent_pools'} r WHERE r.candidate_id=c.id AND r.${field} IN (${values.map(() => '?').join(',')}))`
  }
  if (field === 'desired_location') {
    params.push(value)
    return `EXISTS (SELECT 1 FROM candidate_preferences p, json_each(p.desired_locations) j WHERE p.candidate_id=c.id AND replace(lower(j.value),'市','')=replace(lower(?),'市',''))`
  }
  if (!columns[field])
    fail('unsupported_search_filter', '存在无法执行的筛选条件')
  if (op === 'in') {
    const values = Array.isArray(value) ? value : [value]
    params.push(...values)
    return `c.${columns[field]} IN (${values.map(() => '?').join(',')})`
  }
  params.push(value)
  if (field === 'current_location' && op === 'eq')
    return "replace(lower(c.location),'市','')=replace(lower(?),'市','')"
  if (!operators[op]) fail('unsupported_search_filter', '筛选操作无效')
  return `c.${columns[field]} ${operators[op]} ?`
}
function expression(node, params, options) {
  if (node.kind === 'filter') return filter(node, params)
  if (node.kind === 'term' && node.evidence_scope !== 'self') {
    if (!['linked_position', 'talent_pool'].includes(node.evidence_scope))
      fail('invalid_search_plan', '证据范围无效')
    const position = node.evidence_scope === 'linked_position'
    params.push(node.text)
    return `EXISTS (SELECT 1 FROM ${position ? 'candidate_positions' : 'candidate_talent_pools'} r JOIN ${position ? 'positions' : 'talent_pools'} p ON p.id=r.${position ? 'position_id' : 'talent_pool_id'} WHERE r.candidate_id=c.id AND instr(lower(coalesce(p.${position ? 'title' : 'name'},'')||char(10)||coalesce(p.description,'')),lower(?))>0)`
  }
  if (node.kind === 'term')
    return `(CASE WHEN EXISTS (SELECT 1 FROM self_docs available WHERE available.candidate_id=c.id AND trim(available.content) <> '') THEN EXISTS (SELECT 1 FROM self_docs d WHERE d.candidate_id=c.id AND ${textPredicate(node, params, options)}) ELSE NULL END)`
  if (node.kind === 'not')
    return `(NOT (${expression(node.child, params, options)}))`
  if (!['all', 'any'].includes(node.kind))
    fail('invalid_search_plan', '查询表达式无效')
  if (
    node.scope === 'record' &&
    node.children.every((n) => n.kind === 'term')
  ) {
    return `EXISTS (SELECT 1 FROM self_docs d WHERE d.candidate_id=c.id AND (${node.children.map((n) => `(${textPredicate(n, params, options)})`).join(node.kind === 'all' ? ' AND ' : ' OR ')}))`
  }
  if (node.scope === 'record')
    fail('unsupported_search_scope', '复杂的同记录约束尚不能执行')
  return `(${node.children.map((n) => expression(n, params, options)).join(node.kind === 'all' ? ' AND ' : ' OR ')})`
}
export function compileCandidateWhere(plan, options = {}) {
  const parameters = []
  const clauses = []
  for (const n of plan.must) clauses.push(expression(n, parameters, options))
  for (const n of plan.must_not)
    clauses.push(`NOT (${expression(n, parameters, options)})`)
  if (plan.minimum_should_match) {
    const parts = plan.should.map(
      (n) => `CASE WHEN ${expression(n, parameters, options)} THEN 1 ELSE 0 END`
    )
    clauses.push(`(${parts.join('+')}) >= ${plan.minimum_should_match}`)
  }
  if (options.candidateIds?.length) {
    parameters.push(...options.candidateIds)
    clauses.push(`c.id IN (${options.candidateIds.map(() => '?').join(',')})`)
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    parameters
  }
}
const FIELD_LABELS = {
  years: '工作年限',
  current_location: '当前所在地',
  desired_location: '意向地点',
  archived: '归档范围',
  position_id: '关联职位',
  talent_pool_id: '人才库',
  source: '证据来源',
  education: '学历',
  current_title: '最近职位',
  current_company: '最近公司',
  stage: '候选人阶段'
}
function label(n) {
  if (n.kind === 'term') return n.text
  if (n.kind === 'not') return `排除 ${label(n.child)}`
  if (n.kind === 'filter') {
    const value =
      n.field === 'archived'
        ? { include: '全部', exclude: '未归档', only: '已归档' }[n.value]
        : n.field === 'source'
          ? (Array.isArray(n.value) ? n.value : [n.value])
              .map(
                (v) =>
                  ({
                    candidate: '候选人主档',
                    profile_section: '履历区块',
                    attachment: '附件简历'
                  })[v] ?? v
              )
              .join('、')
          : n.value
    return `${FIELD_LABELS[n.field] ?? n.field} ${{ eq: ':', gte: '≥', lte: '≤', gt: '>', lt: '<', in: ':' }[n.op]} ${String(value)}`
  }
  return n.children.map(label).join(n.kind === 'any' ? ' 或 ' : ' 且 ')
}
export function conditionSummary(plan) {
  return [
    ['must', 'required'],
    ['should', 'preferred'],
    ['must_not', 'excluded'],
    ['unresolved', 'unresolved']
  ].flatMap(([key, kind]) =>
    plan[key].map((n, i) => ({
      id: `${key}-${i}`,
      text: key === 'unresolved' ? n.text : label(n),
      kind
    }))
  )
}
function evidenceFor(db, ids, plan, options) {
  const result = new Map(ids.map((id) => [id, []]))
  if (!ids.length) return result
  for (const node of leaves([...plan.must, ...plan.should])) {
    if (node.evidence_scope !== 'self') {
      const position = node.evidence_scope === 'linked_position'
      const table = position ? 'positions' : 'talent_pools'
      const relation = position
        ? 'candidate_positions'
        : 'candidate_talent_pools'
      const key = position ? 'position_id' : 'talent_pool_id'
      const rows = db
        .prepare(
          `WITH matched AS (SELECT r.candidate_id,p.id,p.${position ? 'title' : 'name'} title,coalesce(p.description,'') description,row_number() OVER(PARTITION BY r.candidate_id ORDER BY p.id) evidence_rank FROM ${relation} r JOIN ${table} p ON p.id=r.${key} WHERE r.candidate_id IN (${ids.map(() => '?').join(',')}) AND instr(lower(coalesce(p.${position ? 'title' : 'name'},'')||char(10)||coalesce(p.description,'')),lower(?))>0) SELECT * FROM matched WHERE evidence_rank<=5`
        )
        .all(...ids, node.text)
      for (const row of rows) {
        const list = result.get(row.candidate_id)
        if (
          list.length >= 5 ||
          list.some((e) => e.document_id === `${table}:${row.id}`)
        )
          continue
        const titleMatch = row.title
          .toLowerCase()
          .includes(node.text.toLowerCase())
        const content = titleMatch ? row.title : row.description
        const at = content.toLowerCase().indexOf(node.text.toLowerCase())
        const start = Math.max(0, at - 100)
        const end = Math.min(content.length, at + node.text.length + 200)
        list.push({
          document_id: `${table}:${row.id}`,
          candidate_id: row.candidate_id,
          entity_type: node.evidence_scope,
          entity_id: row.id,
          source_table: table,
          source_row_id: row.id,
          field_path: titleMatch ? 'title' : 'description',
          title: row.title,
          source_label: position ? '关联职位' : '人才库分组',
          ownership: 'related',
          match_kind: 'relationship',
          score: 0,
          matched_terms: [node.text],
          matched_actual_terms: [node.text],
          snippet: {
            text: content.slice(start, end),
            highlights: [
              { start: at - start, end: at - start + node.text.length }
            ],
            matches: [],
            prefix_ellipsis: start > 0,
            suffix_ellipsis: end < content.length
          }
        })
      }
      continue
    }
    const params = []
    const predicate = textPredicate(node, params, options)
    const scope = selfDocsScope(plan, options, ids)
    const rows = db
      .prepare(
        `${scope.docs}, matched_docs AS (SELECT d.*,row_number() OVER(PARTITION BY candidate_id ORDER BY document_id) evidence_rank FROM self_docs d WHERE ${predicate} AND candidate_id IN (${ids.map(() => '?').join(',')})) SELECT * FROM matched_docs WHERE evidence_rank<=5 ORDER BY document_id`
      )
      .all(...scope.parameters, ...params, ...ids)
    for (const row of rows) {
      const list = result.get(row.candidate_id)
      if (
        list.length >= 5 ||
        list.some((e) => e.document_id === row.document_id)
      )
        continue
      const actual =
        terms(node).find((t) =>
          `${row.title}\n${row.content}`.toLowerCase().includes(t.toLowerCase())
        ) ?? node.text
      const titleMatch = !row.content
        .toLowerCase()
        .includes(actual.toLowerCase())
      const content = titleMatch ? row.title : row.content
      const at = Math.max(
        0,
        content.toLowerCase().indexOf(actual.toLowerCase())
      )
      const start = Math.max(0, at - 100)
      const end = Math.min(
        content.length,
        Math.max(at + actual.length + 200, start + 300)
      )
      const text = content.slice(start, end)
      const sourceTable = {
        candidate: 'candidates',
        profile_section: 'candidate_profile_sections',
        attachment: 'candidate_attachments'
      }[row.source_type]
      list.push({
        document_id: row.document_id,
        candidate_id: row.candidate_id,
        entity_type: row.source_type,
        entity_id: row.source_id,
        source_table: sourceTable,
        source_row_id: row.source_id,
        field_path: titleMatch
          ? 'title'
          : row.source_type === 'candidate'
            ? 'current_title+self_summary+tags'
            : row.source_type === 'attachment'
              ? 'extracted_text'
              : 'content',
        title: row.title,
        source_label: LABELS[row.section_type] ?? '履历区块',
        ownership: 'self',
        match_kind:
          actual.toLowerCase() === node.text.toLowerCase()
            ? 'exact'
            : 'equivalent',
        score: 0,
        matched_terms: [node.text],
        matched_actual_terms: [actual],
        char_start: start,
        char_end: end,
        snippet: {
          text,
          highlights: [{ start: at - start, end: at - start + actual.length }],
          matches: [],
          prefix_ellipsis: start > 0,
          suffix_ellipsis: end < content.length
        }
      })
    }
  }
  const semanticRows = (options.vectorEvidence ?? []).filter((row) =>
    result.has(row.candidate_id)
  )
  if (semanticRows.length) {
    const documents = new Map(
      readSearchDocuments(db, {
        documentIds: [...new Set(semanticRows.map((row) => row.document_id))]
      }).map((doc) => [doc.document_id, doc])
    )
    for (const row of semanticRows) {
      const doc = documents.get(row.document_id)
      const list = result.get(row.candidate_id)
      if (
        !doc ||
        doc.candidate_id !== row.candidate_id ||
        doc.source_hash !== row.source_hash ||
        list.length >= 5 ||
        list.some(
          (e) =>
            e.entity_type === doc.source_type &&
            e.source_row_id === doc.source_id
        )
      )
        continue
      const start = Number.isInteger(row.start) ? Math.max(0, row.start) : 0
      const end = Math.min(
        doc.content.length,
        Number.isInteger(row.end) ? row.end : start + 600,
        start + 600
      )
      if (end <= start) continue
      list.push({
        document_id: doc.document_id,
        candidate_id: doc.candidate_id,
        entity_type: doc.source_type,
        entity_id: doc.source_id,
        source_table: {
          candidate: 'candidates',
          profile_section: 'candidate_profile_sections',
          attachment: 'candidate_attachments'
        }[doc.source_type],
        source_row_id: doc.source_id,
        field_path: doc.field,
        title:
          doc.source_type === 'candidate'
            ? '候选人主档'
            : doc.source_type === 'attachment'
              ? '附件简历'
              : doc.title,
        source_label: {
          candidate: '候选人主档',
          profile_section: '履历区块',
          attachment: '附件简历'
        }[doc.source_type],
        ownership: 'self',
        match_kind: 'semantic',
        score: 0,
        matched_terms: [],
        matched_actual_terms: [],
        char_start: start,
        char_end: end,
        snippet: {
          text: doc.content.slice(start, end),
          highlights: [],
          matches: [],
          prefix_ellipsis: start > 0,
          suffix_ellipsis: end < doc.content.length
        }
      })
    }
  }
  return result
}
function fuse(lexical, vector) {
  const scores = new Map()
  for (const list of [lexical, vector])
    [...new Set(list)].forEach((id, i) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1))
    )
  return [...scores.keys()].sort(
    (a, b) => scores.get(b) - scores.get(a) || a.localeCompare(b)
  )
}

// 未解析的自由文本（规则与模型都没能映射成结构化条件）以前只作为「未执行条件」
// 返回全库，用户看到的是与关键词无关的整库列表。这里把这类文本按本地关键词召回
// 执行：每个条件取「能命中的最长前缀」，多个条件按交集收敛，无命中即空结果。
function ambiguousKeywords(plan) {
  const seen = new Set()
  const keywords = []
  for (const item of plan.unresolved ?? []) {
    if (item?.reason !== 'ambiguous' || typeof item.text !== 'string') continue
    const text = item.text.trim()
    if (!text || text.length > 80 || seen.has(text)) continue
    seen.add(text)
    keywords.push(text)
  }
  return keywords
}
function keywordProbes(text) {
  const probes = [text]
  if (/^[\p{Script=Han}]+$/u.test(text) && text.length > 2)
    for (let length = text.length - 1; length >= 2; length -= 1) probes.push(text.slice(0, length))
  return probes
}
// Unresolved free text has no structured predicate, so its literal scan is bounded
// by the same inverted index the structured terms use. The index hit set is a
// superset of the literal matches, so the `instr` check below still decides them.
function keywordSelfDocsScope(probe, options = {}) {
  try {
    if (/\p{Script=Han}/u.test(probe)) {
      if (!options.gramIndexReady) return SELF_DOCS_UNSCOPED
      return selfDocsCte(
        `d.candidate_id IN (SELECT sd.candidate_id FROM search_documents_v2_fts
           JOIN search_documents_v2 sd ON sd.row_id = search_documents_v2_fts.rowid
           WHERE search_documents_v2_fts MATCH ?
             AND sd.source_table IN (${SELF_DOCS_SEARCH_SOURCES.map(() => '?').join(',')}))`,
        [
          `search_text : (${businessSearchTermExpression(probe)})`,
          ...SELF_DOCS_SEARCH_SOURCES
        ]
      )
    }
    return selfDocsCte(
      `d.row_id IN (SELECT rowid FROM candidate_resume_fts WHERE candidate_resume_fts MATCH ?)`,
      [quoteFts(probe)]
    )
  } catch {
    return SELF_DOCS_UNSCOPED
  }
}
function recallKeywordCandidates(db, keywords, options = {}) {
  const perCondition = keywords.map(() => new Map())
  let index = -1
  for (const text of keywords) {
    index += 1
    for (const probe of keywordProbes(text)) {
      const scope = keywordSelfDocsScope(probe, options)
      const rows = db
        .prepare(
          `${scope.docs} SELECT d.candidate_id candidate_id, coalesce(d.title,'') title, coalesce(d.content,'') content
           FROM self_docs d
           WHERE instr(lower(coalesce(d.content,'') || char(10) || coalesce(d.title,'')), lower(?)) > 0
           LIMIT 2000`
        )
        .all(...scope.parameters, probe)
      if (!rows.length) continue
      // 最长命中前缀一旦成立，更短的同义前缀只会带来噪声（产品设计 不该匹配产品经理）。
      for (const row of rows) {
        const target = row.content || row.title
        const at = target.toLowerCase().indexOf(probe.toLowerCase())
        perCondition[index].set(row.candidate_id, {
          probe,
          title: row.title,
          content: target,
          at: at < 0 ? 0 : at
        })
      }
      break
    }
  }
  if (perCondition.some(map => map.size === 0)) return new Map()
  const result = new Map()
  for (const [candidateId, hit] of perCondition[0]) {
    if (!perCondition.every(map => map.has(candidateId))) continue
    const hits = perCondition.map(map => map.get(candidateId))
    result.set(candidateId, {
      score: hits.reduce((sum, item) => sum + item.probe.length, 0),
      hits
    })
  }
  return result
}
function keywordEvidence(candidateId, recall) {
  return recall.hits.map((hit, index) => {
    const start = Math.max(0, hit.at - 40)
    const end = Math.min(hit.content.length, hit.at + hit.probe.length + 60)
    return {
      document_id: `keyword:${candidateId}:${index}`,
      candidate_id: candidateId,
      entity_type: 'candidate',
      entity_id: candidateId,
      source_table: 'candidates',
      source_row_id: candidateId,
      field_path: 'keyword',
      title: hit.title || '候选人主档',
      source_label: hit.title ? '履历区块' : '候选人主档',
      ownership: 'self',
      match_kind: 'keyword',
      score: 0,
      matched_terms: [hit.probe],
      matched_actual_terms: [hit.probe],
      snippet: {
        text: hit.content.slice(start, end),
        highlights: [],
        matches: [],
        prefix_ellipsis: start > 0,
        suffix_ellipsis: end < hit.content.length
      }
    }
  })
}

async function recallValidatedVectors(db, { plan, options, vectorStore, vector, qualification, signal, check }) {
  const started = performance.now()
  const sourceBudget = 12800
  const accepted = new Map()
  const seenFacts = new Set()
  const eligibility = new Map()
  let stale = false
  const stats = { mode: 'exact', approximate: false, bounded: false, iterations: 0, inspected_facts: 0, validated_source_rows: 0, accepted_candidates: 0, stop_reason: 'exhausted' }
  const expired = () => performance.now() - started >= 5000
  const validate = async facts => {
    for (let offset = 0; offset < facts.length; offset += 400) {
      check()
      if (expired()) { stats.stop_reason = 'time_budget'; stats.bounded = true; return }
      const batch = facts.slice(offset, offset + 400)
      const unknown = [...new Set(batch.map(row => row.candidate_id))].filter(id => !eligibility.has(id))
      const allowed = unknown.filter(id => !options.candidateIds.length || options.candidateIds.includes(id))
      for (const id of unknown) eligibility.set(id, false)
      if (allowed.length) {
        const where = compileCandidateWhere(plan, { ...options, candidateIds: allowed })
        const scope = selfDocsScope(plan, options, allowed)
        for (const row of db.prepare(`${scope.docs} SELECT c.id FROM candidates c ${where.where}`).all(...scope.parameters, ...where.parameters)) eligibility.set(row.id, true)
      }
      const eligibleFacts = batch.filter(row => eligibility.get(row.candidate_id))
      if (!eligibleFacts.length) continue
      const scores = new Map(eligibleFacts.map(row => [row.key, row]))
      let after = ''
      do {
        check()
        const remaining = sourceBudget - stats.validated_source_rows
        if (remaining <= 0 || expired()) { stats.stop_reason = remaining <= 0 ? 'source_budget' : 'time_budget'; stats.bounded = true; return }
        const page = await vectorStore.readFactChunks(eligibleFacts.map(row => row.key), { sourceTypes: options.sourceTypes.length ? options.sourceTypes : undefined, after, limit: Math.min(400, remaining) })
        check()
        if (page.rows.length > Math.min(400, remaining)) fail('search_vector_source_budget', '语义来源超过读取预算')
        stats.validated_source_rows += page.rows.length
        const ids = [...new Set(page.rows.map(row => row.document_id))]
        const docs = new Map(readSearchDocuments(db, { documentIds: ids }).map(doc => [doc.document_id, doc]))
        for (const row of page.rows) {
          const fact = scores.get(row.fact_key)
          const doc = docs.get(row.document_id)
          if (!doc || doc.source_hash !== row.source_hash) { stale = true; continue }
          if (!fact || fact.candidate_id !== row.candidate_id || doc.candidate_id !== row.candidate_id || doc.source_type !== row.source_type || (options.sourceTypes.length && !options.sourceTypes.includes(row.source_type)) || !Number.isInteger(row.start) || !Number.isInteger(row.end) || row.start < 0 || row.end <= row.start || row.end > doc.content.length) continue
          const previous = accepted.get(row.candidate_id)
          if (!previous || fact.score > previous.score || (fact.score === previous.score && row.document_id < previous.document_id)) accepted.set(row.candidate_id, { ...row, score: fact.score })
        }
        if (page.next && page.next === after) fail('search_vector_source_budget', '语义来源游标未前进')
        after = page.next
      } while (after)
      // Finish this fact batch before choosing a candidate's best live source.
      if (accepted.size >= 200) { stats.stop_reason = 'target'; return }
    }
  }
  let exact = null
  if (qualification.length <= 10000) {
    try { exact = await vectorStore.searchQualifiedFacts(vector, { candidateIds: qualification.map(row => row.id), sourceTypes: options.sourceTypes.length ? options.sourceTypes : undefined, signal }) }
    catch (error) { if (error.code !== 'search_vector_filter_budget') throw error }
  }
  check()
  if (exact) { stats.inspected_facts = exact.inspected_facts; await validate(exact.facts) }
  else {
    stats.mode = 'ann'; stats.approximate = true; stats.bounded = true
    const maximum = Math.min(6400, vectorStore.status().max_ann_vectors ?? 6400)
    for (let limit = Math.min(400, maximum); stats.iterations < 5;) {
      check()
      if (expired()) { stats.stop_reason = 'time_budget'; break }
      const found = await vectorStore.searchAnn(vector, { limit, sourceTypes: options.sourceTypes.length ? options.sourceTypes : undefined, signal })
      check()
      stats.iterations += 1; stats.inspected_facts += found.inspected_facts
      if (found.inspected_facts > limit || stats.inspected_facts > 12400) fail('search_vector_filter_budget', '语义召回超过读取预算')
      const fresh = found.facts.filter(row => { if (seenFacts.has(row.key)) return false; seenFacts.add(row.key); return true })
      await validate(fresh)
      if (['target', 'source_budget', 'time_budget'].includes(stats.stop_reason)) break
      if (found.index_vectors <= limit) { stats.stop_reason = 'exhausted'; break }
      if (limit === maximum) { stats.stop_reason = 'budget'; break }
      limit = Math.min(maximum, limit * 2)
    }
  }
  const rows = [...accepted.values()].sort((a, b) => b.score - a.score || a.candidate_id.localeCompare(b.candidate_id)).slice(0, 200)
  stats.accepted_candidates = rows.length
  return { rows, stats, stale }
}

export async function hybridSearch(
  db,
  {
    plan,
    query = '',
    page = 1,
    page_size: pageSize = 20,
    vectorStore = null,
    queryVector = null,
    embedTexts = null,
    rerankDocuments = null,
    signal,
    snapshot = null,
    fields = [],
    sourceTypes = [],
    candidateIds = [],
    includeTotal = true,
    evidenceLimit = 5
  } = {}
) {
  const started = performance.now()
  const check = () => {
    if (signal?.aborted) fail('search_cancelled', '检索已取消', 499)
  }
  check()
  const options = {
    fields,
    sourceTypes,
    candidateIds,
    gramIndexReady: isBusinessSearchReady(db),
    vectorEvidence: snapshot?.vectorEvidence ?? []
  }
  const compiled = compileCandidateWhere(plan, options)
  const scope = materialiseSelfDocsScope(db, plan, options, candidateIds)
  if (scope.table) options.selfDocsTable = scope.table
  // Qualification is evaluated over every candidate before the recall windows.
  const total = Number(
    db
      .prepare(`${scope.docs} SELECT count(*) n FROM candidates c ${compiled.where}`)
      .get(...scope.parameters, ...compiled.parameters).n
  )
  const degradation = []
  let head = snapshot?.head ?? []
  let vectorRows = []
  let vectorCompleteness = null
  let reranked = false
  if (!snapshot) {
    const rankParams = []
    const rankTerms = [...plan.should, ...plan.must].map(
      (n) => `CASE WHEN ${expression(n, rankParams, options)} THEN 1 ELSE 0 END`
    )
    const recallTerms = leaves([...plan.must, ...plan.should]).flatMap(terms)
    const lexicalCte =
      options.gramIndexReady && recallTerms.length
        ? `, lexical_scores AS MATERIALIZED (
      SELECT sd.candidate_id,bm25(search_documents_v2_fts) lexical_rank
      FROM search_documents_v2_fts JOIN search_documents_v2 sd ON sd.row_id=search_documents_v2_fts.rowid
      WHERE search_documents_v2_fts MATCH ? AND sd.field_path IN ('candidates.current_title','candidates.self_summary','candidates.tags','candidate_profile_sections.content','candidate_profile_sections.title','candidate_attachments.extracted_text')
    )`
        : ''
    const ranked = db
      .prepare(
        `${scope.docs}${lexicalCte} SELECT c.id candidate_id FROM candidates c ${compiled.where} ORDER BY ${rankTerms.length ? `(${rankTerms.join('+')}) DESC,` : ''}${lexicalCte ? 'coalesce((SELECT min(lexical_rank) FROM lexical_scores ls WHERE ls.candidate_id=c.id),0),' : ''} c.id LIMIT 200`
      )
      .all(
        ...scope.parameters,
        ...(lexicalCte
          ? [
              `search_text : (${recallTerms.map(businessSearchTermExpression).join(' OR ')})`
            ]
          : []),
        ...compiled.parameters,
        ...rankParams
      )
    const lexical = ranked.map((r) => r.candidate_id)
    if (
      vectorStore &&
      (queryVector || embedTexts) &&
      query &&
      (!fields.length || fields.includes('content'))
    ) {
      try {
        const vector =
          queryVector ??
          (
            await embedTexts([query], {
              signal,
              dimensions: vectorStore.status().dimensions
            })
          )[0]
        check()
        // Keep sparse qualification exact; wide sets use ANN and complete local
        // condition/provenance validation within explicit work budgets.
        const qualification = db
          .prepare(
            `${scope.docs} SELECT c.id FROM candidates c ${compiled.where} ORDER BY c.id LIMIT 10001`
          )
          .all(...scope.parameters, ...compiled.parameters)
        if (typeof vectorStore.searchQualifiedFacts === 'function') {
          const recalled = await recallValidatedVectors(db, { plan, options, vectorStore, vector, qualification, signal, check })
          vectorRows = recalled.rows
          vectorCompleteness = recalled.stats
          if (recalled.stale) degradation.push({ code: 'vector_stale_sources', message: '部分语义索引已过期，已采用最新履历检索', stage: 'embedding' })
        } else {
          if (qualification.length > 10000)
            fail('search_vector_filter_budget', '候选集合超过本轮语义预算')
          const raw = await vectorStore.search(vector, {
            k: 400,
            signal,
            candidateIds: qualification.map((r) => r.id),
            ...(sourceTypes.length ? { sourceTypes } : {})
          })
          check()
          if (raw.length) {
            const allowedVectorIds = raw.map(row => row.candidate_id).filter(id => !candidateIds.length || candidateIds.includes(id))
            const vectorFilter = compileCandidateWhere(plan, {
              ...options,
              candidateIds: allowedVectorIds
            })
            const vectorScope = selfDocsScope(plan, options, allowedVectorIds)
            const qualified = new Set(
              allowedVectorIds.length ? db
                .prepare(
                  `${vectorScope.docs} SELECT c.id FROM candidates c ${vectorFilter.where}`
                )
                .all(...vectorScope.parameters, ...vectorFilter.parameters)
                .map((r) => r.id) : []
            )
            const liveDocs = new Map(
              readSearchDocuments(db, {
                documentIds: [...new Set(raw.map((row) => row.document_id))]
              }).map((doc) => [doc.document_id, doc])
            )
            vectorRows = raw
              .filter(
                (row) =>
                  qualified.has(row.candidate_id) &&
                  liveDocs.get(row.document_id)?.candidate_id ===
                    row.candidate_id &&
                  liveDocs.get(row.document_id)?.source_hash ===
                    row.source_hash &&
                  (!sourceTypes.length || sourceTypes.includes(row.source_type))
              )
              .slice(0, 200)
            if (
              raw.some(
                (row) =>
                  !liveDocs.has(row.document_id) ||
                  liveDocs.get(row.document_id)?.source_hash !== row.source_hash
              )
            )
              degradation.push({
                code: 'vector_stale_sources',
                message: '部分语义索引已过期，已采用最新履历检索',
                stage: 'embedding'
              })
          }
        }
      } catch (error) {
        check()
        degradation.push({
          code: 'vector_unavailable',
          message: '语义召回不可用，已使用本地检索',
          stage: 'embedding'
        })
      }
    } else
      degradation.push({
        code:
          fields.length && !fields.includes('content')
            ? 'vector_title_scope'
            : 'vector_not_ready',
        message:
          fields.length && !fields.includes('content')
            ? '标题范围使用关键词检索'
            : '语义索引未启用，当前使用本地检索',
        stage: 'embedding'
      })
    options.vectorEvidence = vectorRows.map(
      ({ candidate_id, document_id, source_hash, start, end }) => ({
        candidate_id,
        document_id,
        source_hash,
        start,
        end
      })
    )
    head = fuse(
      lexical,
      vectorRows.map((r) => r.candidate_id)
    ).slice(0, 400)
    if (rerankDocuments && head.length) {
      try {
        const ids = head.slice(0, 50)
        const ev = evidenceFor(db, ids, plan, options)
        const sourceTables = { candidate: 'candidates', profile_section: 'candidate_profile_sections', attachment: 'candidate_attachments' }
        const evidenceIds = [...new Set(ids.flatMap(id => (ev.get(id) ?? []).filter(row => row.ownership === 'self').map(row => row.document_id)))]
        // Re-read the approved outbound projection immediately before sending.
        // Local evidence intentionally has a wider viewing scope (e.g. high
        // sensitivity and archived records) and is not an outbound allowlist.
        const allowed = new Map(readSearchDocuments(db, { documentIds: evidenceIds }).map(doc => [doc.document_id, doc]))
        const profileIds = [...allowed.values()].filter(doc => doc.source_type === 'candidate').map(doc => doc.candidate_id)
        const profileText = new Map(profileIds.length ? db.prepare(`SELECT id,current_title,self_summary,tags FROM candidates WHERE archived_at IS NULL AND id IN (${profileIds.map(() => '?').join(',')})`).all(...profileIds).map(row => {
          let tags = []
          try { const value = JSON.parse(row.tags ?? '[]'); if (Array.isArray(value)) tags = value.filter(item => typeof item === 'string') } catch {}
          return [row.id, [row.current_title ?? '', row.self_summary ?? '', tags.join('\n')].join('\n')]
        }) : [])
        const evidenceSource = (row, doc) => row.field_path === 'title' ? doc.title
          : doc.source_type === 'candidate' && row.field_path === 'current_title+self_summary+tags' ? profileText.get(doc.candidate_id) ?? ''
            : doc.content
        const identities = readSearchIdentities(db, ids)
        const packets = ids.map(id => ({ id, text: (ev.get(id) ?? [])
            .filter(row => {
              const doc = allowed.get(row.document_id)
              if (!doc || row.ownership !== 'self' || doc.candidate_id !== id || row.candidate_id !== id || doc.source_type !== row.entity_type || doc.source_id !== row.source_row_id || sourceTables[doc.source_type] !== row.source_table) return false
              // Use current projection text, never a snippet from a broader or
              // stale local source. Profile projections can have different offsets.
              const source = evidenceSource(row, doc)
              return typeof row.snippet?.text === 'string' && row.snippet.text.trim() && source.includes(row.snippet.text)
            })
            .slice(0, 3)
            .map(row => {
              const doc = allowed.get(row.document_id)
              const source = evidenceSource(row, doc)
              const start = source.indexOf(row.snippet.text)
              const redacted = redactSearchText(source, { identities: identities.get(id) ?? [], preserveLength: true })
              return redacted.slice(start, start + row.snippet.text.length)
            }).join('\n').slice(0, 1800) })).filter(packet => packet.text.trim())
        if (packets.length !== ids.length) degradation.push({ code: 'rerank_source_scope', message: '部分结果无允许外发的本人材料，已保留其本地排序', stage: 'rerank' })
        if (packets.length) {
          const output = await rerankDocuments(query, packets.map(packet => packet.text), {
            topN: packets.length,
            signal
          })
          check()
          if (
            output.length !== packets.length ||
            new Set(output.map((r) => r.index)).size !== packets.length ||
            output.some(
              (r) =>
                !Number.isInteger(r.index) || r.index < 0 || r.index >= packets.length
            )
          )
            throw new Error('invalid rerank')
          const eligible = new Set(packets.map(packet => packet.id))
          const ranked = output.map(row => packets[row.index].id)
          let next = 0
          head = [...ids.map(id => eligible.has(id) ? ranked[next++] : id), ...head.slice(50)]
          reranked = true
        }
      } catch (error) {
        check()
        degradation.push({
          code: 'rerank_unavailable',
          message: '重排暂不可用，已保留本地和语义排序',
          stage: 'rerank'
        })
      }
    }
  }
  const offset = (page - 1) * pageSize
  // D1：未解析的自由文本按本地关键词执行；无真实命中时返回空结果，不做整库补齐。
  const keywords = ambiguousKeywords(plan)
  const recall = keywords.length ? recallKeywordCandidates(db, keywords, options) : null
  if (recall) {
    const scoped = head.filter((id) => recall.has(id))
    scoped.sort((a, b) => recall.get(b).score - recall.get(a).score || a.localeCompare(b))
    head = scoped
  }
  const selected = head.slice(offset, offset + pageSize)
  const padded = []
  if (selected.length < pageSize && head.length > 0) {
    const tailWhere = `${compiled.where || 'WHERE 1'}${head.length ? ` AND c.id NOT IN (${head.map(() => '?').join(',')})` : ''}`
    const tail = db
      .prepare(
        `${scope.docs} SELECT c.id FROM candidates c ${tailWhere} ORDER BY c.id LIMIT ? OFFSET ?`
      )
      .all(
        ...scope.parameters,
        ...compiled.parameters,
        ...head,
        pageSize - selected.length,
        Math.max(0, offset - head.length)
      )
    padded.push(...tail.map((r) => r.id))
    selected.push(...padded)
  }
  const padding = new Set(padded)
  const rows = selected.length
    ? db
        .prepare(
          `SELECT id candidate_id,name,current_title,current_company FROM candidates WHERE id IN (${selected.map(() => '?').join(',')})`
        )
        .all(...selected)
    : []
  const ev = evidenceFor(db, selected, plan, options)
  const byId = new Map(rows.map((r) => [r.candidate_id, r]))
  const items = selected.map((id) => {
    const recallHit = recall?.get(id)
    const matched = (ev.get(id) ?? []).slice(0, evidenceLimit)
    const evidence = recallHit ? [...keywordEvidence(id, recallHit), ...matched].slice(0, evidenceLimit) : matched
    const isPadding = padding.has(id)
    return {
      ...byId.get(id),
      score: null,
      matched_fields: [...new Set(evidence.filter((e) => e.match_kind !== 'keyword').map((e) => e.source_label))],
      matched_terms: [...new Set(evidence.flatMap((e) => e.matched_terms))],
      evidence,
      snippets: evidence.map((e) => e.snippet.text),
      reasons: isPadding
        ? ['仅用于补足分页，不代表命中']
        : recallHit
          ? ['本地关键词命中']
          : evidence.some((e) => e.ownership === 'self')
            ? ['本人履历证据']
            : evidence.length
              ? ['关联关系命中，不代表本人能力']
              : ['满足已执行的结构化条件'],
      condition_status: isPadding ? 'padding' : plan.unresolved.length ? 'partial' : 'matched'
    }
  })
  const complete = snapshot?.completeness ?? {
    conditions: plan.unresolved.length ? 'partial' : 'complete',
    retrieval: vectorStore ? 'bounded' : 'complete',
    ranking: reranked ? 'hybrid_reranked' : vectorRows.length ? 'rrf' : 'fts',
    ...(vectorCompleteness ? { vector: vectorCompleteness } : {})
  }
  const degraded = snapshot?.degradation ?? degradation
  // 关键词范围下的真实命中数（补齐项只保证分页长度，不计入总数）。
  const effectiveTotal = recall ? head.length : total
  check()
  return {
    items,
    pagination: {
      page,
      page_size: pageSize,
      total: includeTotal ? effectiveTotal : null,
      total_pages: includeTotal ? Math.ceil(effectiveTotal / pageSize) : null,
      has_more: page * pageSize < effectiveTotal,
      next_cursor: null
    },
    condition_summary: conditionSummary(plan),
    completeness: complete,
    degradation: degraded,
    performance: {
      duration_ms: performance.now() - started,
      candidate_count: total,
      vector_candidates: vectorRows.length
    },
    _snapshot: {
      head,
      completeness: complete,
      degradation: degraded,
      vectorEvidence: options.vectorEvidence
    }
  }
}
