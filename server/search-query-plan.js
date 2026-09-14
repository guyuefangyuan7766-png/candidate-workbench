import fs from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'

export const searchQueryPlanSchema = JSON.parse(fs.readFileSync(new URL('./search-query-plan.schema.json', import.meta.url), 'utf8'))
const validateSchema = new Ajv2020({ strict: true, allErrors: false, validateFormats: false }).compile(searchQueryPlanSchema)
const MAX_NODES = 32
const MAX_DEPTH = 4
const MAX_QUERY_LENGTH = 500
const CITIES = ['上海', '北京', '深圳', '广州', '杭州', '成都', '南京', '苏州', '武汉', '西安', '重庆', '天津']
const KNOWN_TERMS = [
  '游戏策划', '战斗系统', '战斗策划', '后端工程师', '前端工程师', '后端开发', '前端开发',
  '数值策划', '数值体系', '成长曲线', '游戏开发', '机器学习', '人工智能', '后端', '前端',
  'Unity3D', 'Unity', 'Unreal', 'Redis', 'Python', 'JavaScript', 'TypeScript', 'Java', 'Golang',
  'React', 'Node.js', 'C++', 'C#', 'SQL', '外包', '数据库', '系统设计', '分布式', '高并发',
].sort((a, b) => b.length - a.length)
const FILLER = /(?:请帮我|帮我|请找|寻找|找|请|候选人|的人|人员|熟悉|精通|擅长|了解|具有|具备|拥有|需要|要求|经验的|经验|工作年限|总工作|工作|的|年限不限|经验不限|不限|至少|最多)/gu
const clone = value => structuredClone(value)
const normalized = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim()
const scalarKey = value => normalized(value).toLocaleLowerCase('en-US')
class SearchPlanError extends Error {
  constructor(code, message) { super(message); this.name = 'SearchPlanError'; this.code = code; this.status = 400 }
}
function fail(code, message) { throw new SearchPlanError(code, message) }
function cancelled(signal) { if (signal?.aborted) fail('search_cancelled', '查询已取消') }
const emptyPlan = () => ({ version: 1, must: [], should: [], minimum_should_match: 0, must_not: [], unresolved: [] })
const group = (kind, children, scope = 'candidate') => children.length === 0 ? null : children.length === 1 ? children[0] : { kind, scope, children }
const term = (text, span, match = 'concept') => ({ kind: 'term', text, match, evidence_scope: 'self', span })
const filter = (field, op, value, span = [0, 0]) => ({ kind: 'filter', field, op, value, span })
function leaves(node) { return node.children ? node.children.flatMap(leaves) : node.child ? leaves(node.child) : [node] }
function trimSegment(text, offset) {
  const left = text.length - text.trimStart().length
  return { text: text.trim(), offset: offset + left }
}
function splitBoolean(text, offset, kind) {
  const result = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (/["“”]/u.test(text[i])) { quoted = !quoted; continue }
    if (quoted) continue
    if (text[i] === '(' || text[i] === '（') { depth++; continue }
    if (text[i] === ')' || text[i] === '）') { depth--; continue }
    if (depth !== 0) continue
    const tail = text.slice(i)
    const chinese = kind === 'any' ? /^(?:或者|或)/u.exec(tail) : /^(?:并且|而且|且)/u.exec(tail)
    const english = kind === 'any' ? /^OR\b/iu.exec(tail) : /^AND\b/iu.exec(tail)
    const match = chinese ?? ((i === 0 || !/[A-Za-z0-9_]/u.test(text[i - 1])) ? english : null)
    if (!match) continue
    result.push(trimSegment(text.slice(start, i), offset + start))
    start = i + match[0].length
    i = start - 1
  }
  if (!result.length) return [trimSegment(text, offset)]
  result.push(trimSegment(text.slice(start), offset + start))
  return result
}
function wrapsWholeExpression(text) {
  if (!/^[（(]/u.test(text) || !/[）)]$/u.test(text)) return false
  let depth = 0
  let quote = false
  for (let i = 0; i < text.length; i++) {
    if (/["“”]/u.test(text[i])) quote = !quote
    if (quote) continue
    if (/[（(]/u.test(text[i])) depth++
    if (/[）)]/u.test(text[i])) depth--
    if (depth === 0 && i < text.length - 1) return false
  }
  return depth === 0
}
function appendUnresolved(state, text, span, impact = 'required', reason = 'ambiguous') {
  if (!text.trim()) return
  for (let start = 0; start < text.length; start += 80) {
    state.unresolved.push({ text: text.slice(start, start + 80), span: [span[0] + start, Math.min(span[1], span[0] + start + 80)], reason, impact })
  }
}
function parseAtomic(text, offset, state, impact) {
  const chars = text.split('')
  const nodes = []
  const erase = (start, end) => { for (let index = start; index < end; index++) chars[index] = ' ' }
  const available = () => chars.join('')
  for (const match of text.matchAll(/["“]([^"”]+)["”]/gu)) {
    if (match[1].length > 80) fail('invalid_query', '精确短语过长')
    nodes.push(term(match[1], [offset + match.index + 1, offset + match.index + 1 + match[1].length], 'exact'))
    erase(match.index, match.index + match[0].length)
  }
  // A labelled current job is a structured constraint; a bare role/concept is
  // still evidence in authored history. Stop the value at explicit separators.
  for (const match of available().matchAll(/(?:^|[\s,，;；])(?:当前职务|当前职位|当前岗位)\s*[:：]\s*([^\s,，。;；()（）"“”]+)/gu)) {
    const start = match.index + (match[0].length - match[0].trimStart().length)
    nodes.push(filter('current_title', 'eq', match[1], [offset + start, offset + match.index + match[0].length]))
    erase(match.index, match.index + match[0].length)
  }
  const specialized = /(?:Unity|Unreal|Java|Python|前端|后端|开发|技能|岗位|专项)\s*(?:开发)?\s*(?:经验|年限)\s*\d/iu.test(available())
  const yearPatterns = [
    { re: /(\d+(?:\.\d+)?)\s*(?:到|至|-|~)\s*(\d+(?:\.\d+)?)\s*年/gu, build: m => [['gte', Number(m[1])], ['lte', Number(m[2])]] },
    { re: /(?:不足|少于|不到)\s*(\d+(?:\.\d+)?)\s*年/gu, build: m => [['lt', Number(m[1])]] },
    { re: /(?:超过|多于)\s*(\d+(?:\.\d+)?)\s*年/gu, build: m => [['gt', Number(m[1])]] },
    { re: /(?:至少|不低于)\s*(\d+(?:\.\d+)?)\s*年/gu, build: m => [['gte', Number(m[1])]] },
    { re: /(?:最多|至多|不超过)\s*(\d+(?:\.\d+)?)\s*年/gu, build: m => [['lte', Number(m[1])]] },
    { re: /(\d+(?:\.\d+)?)\s*年(?:以下|以内)/gu, build: m => [['lte', Number(m[1])]] },
    { re: /(\d+(?:\.\d+)?)\s*年(?:以上|起)/gu, build: m => [['gte', Number(m[1])]] },
  ]
  for (const { re, build } of yearPatterns) {
    for (const match of available().matchAll(re)) {
      const span = [offset + match.index, offset + match.index + match[0].length]
      if (specialized) appendUnresolved(state, match[0], span, impact, 'unsupported')
      else {
        const bounds = build(match)
        if (bounds.some(([, value]) => value > 80) || (bounds.length === 2 && bounds[0][1] > bounds[1][1])) fail('invalid_query', '经验年限范围无效')
        nodes.push(...bounds.map(([op, value]) => filter('years', op, value, span)))
      }
      erase(match.index, match.index + match[0].length)
    }
  }
  const cities = CITIES.join('|')
  const locationPattern = new RegExp(`(?:(意向|期望|希望)(?:地点|城市)?\\s*|(?:当前所在地|当前地点|当前|所在地|位于|在)\\s*)?(${cities})(?:市)?`, 'gu')
  for (const match of available().matchAll(locationPattern)) {
    nodes.push(filter(match[1] ? 'desired_location' : 'current_location', 'eq', match[2], [offset + match.index, offset + match.index + match[0].length]))
    erase(match.index, match.index + match[0].length)
  }
  const exclusion = /(?:不要|不含|排除|不能有|NOT\b)\s*/iu.exec(available())
  if (exclusion) {
    const negativeOffset = exclusion.index + exclusion[0].length
    const excludedText = text.slice(negativeOffset).trim()
    const excludedStart = text.indexOf(excludedText, negativeOffset)
    if (excludedText && excludedText.length <= 80 && !/[()（）]/u.test(excludedText)) {
      nodes.push({ kind: 'not', child: term(excludedText, [offset + excludedStart, offset + excludedStart + excludedText.length]) })
    } else appendUnresolved(state, text.slice(exclusion.index), [offset + exclusion.index, offset + text.length], 'excluded')
    erase(exclusion.index, text.length)
  }
  // Source-validated model vocabulary is matched only inside this already
  // parsed Boolean segment, before filler stripping can damage 工作流/经验设计.
  for (const supplied of state.extraTerms ?? []) {
    const escaped = supplied.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    for (const match of available().matchAll(new RegExp(escaped, 'gu'))) {
      nodes.push(term(match[0], [offset + match.index, offset + match.index + match[0].length]))
      erase(match.index, match.index + match[0].length)
    }
  }
  for (const match of available().matchAll(FILLER)) erase(match.index, match.index + match[0].length)
  for (const known of KNOWN_TERMS) {
    const escaped = known.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const latin = /^[A-Za-z]/u.test(known)
    const pattern = new RegExp(latin ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped, 'giu')
    for (const match of available().matchAll(pattern)) {
      if (!latin) {
        const current = available()
        const before = current[match.index - 1] ?? ''
        const after = current[match.index + match[0].length] ?? ''
        if (/[\p{Script=Han}]/u.test(before) || /[\p{Script=Han}]/u.test(after)) continue
      }
      nodes.push(term(match[0], [offset + match.index, offset + match.index + match[0].length]))
      erase(match.index, match.index + match[0].length)
    }
  }
  for (const match of available().matchAll(/[^\s,，。;；:：()（）]+/gu)) appendUnresolved(state, match[0], [offset + match.index, offset + match.index + match[0].length], impact)
  nodes.sort((a, b) => (a.span ?? a.child?.span)[0] - (b.span ?? b.child?.span)[0])
  return group('all', nodes)
}
function parseExpression(raw, offset, state, impact = 'required', depth = 1) {
  if (depth > MAX_DEPTH + 2) fail('invalid_query', '查询条件嵌套过深')
  const { text, offset: start } = trimSegment(raw, offset)
  if (!text) return null
  const recordScope = /^同一(?:项目|任职|记录|段经历)\s*/u.exec(text)
  if (recordScope) {
    const child = parseExpression(text.slice(recordScope[0].length), start + recordScope[0].length, state, impact, depth + 1)
    if (!child) return null
    return child.kind === 'all' || child.kind === 'any' ? { ...child, scope: 'record' } : { kind: 'all', scope: 'record', children: [child] }
  }
  if (wrapsWholeExpression(text)) return parseExpression(text.slice(1, -1), start + 1, state, impact, depth)
  for (const kind of ['any', 'all']) {
    const parts = splitBoolean(text, start, kind)
    if (parts.length < 2) continue
    const before = state.unresolved.length
    const children = parts.map(part => parseExpression(part.text, part.offset, state, impact, depth + 1))
    if (kind === 'any' && (children.some(child => !child) || state.unresolved.length !== before)) {
      state.unresolved.splice(before)
      appendUnresolved(state, text, [start, start + text.length], impact)
      return null
    }
    return group(kind, children.filter(Boolean))
  }
  const negative = /^(?:NOT\b|不要|排除|不含)\s*/iu.exec(text)
  if (negative) {
    const before = state.unresolved.length
    const child = parseExpression(text.slice(negative[0].length), start + negative[0].length, state, 'excluded', depth + 1)
    if (state.unresolved.length > before || !child) return null
    return { kind: 'not', child }
  }
  return parseAtomic(text, start, state, impact)
}
function validateSpan(node, query, { allowSyntheticSpans, requireText = false }) {
  const [start, end] = node.span
  if (end < start || end > query.length) fail('invalid_search_plan', '条件位置超出查询范围')
  if (start === end) {
    if (!allowSyntheticSpans || start !== 0) fail('invalid_search_plan', '条件必须包含原文位置')
    return
  }
  if (requireText && query.slice(start, end) !== node.text) fail('invalid_search_plan', '条件原文位置不一致')
}
export function validateQueryPlan(plan, { query = '', allowSyntheticSpans = false } = {}) {
  if (!validateSchema(plan)) fail('invalid_search_plan', '查询计划未通过 JSON Schema 校验')
  if (plan.minimum_should_match > plan.should.length) fail('invalid_search_plan', '偏好条件数量无效')
  let count = 0
  function visit(node, depth) {
    if (++count > MAX_NODES || depth > MAX_DEPTH) fail('invalid_search_plan', '查询计划超过执行预算')
    if (node.children) { node.children.forEach(child => visit(child, depth + 1)); return }
    if (node.child) { visit(node.child, depth + 1); return }
    validateSpan(node, query, { allowSyntheticSpans, requireText: node.kind === 'term' })
    if (node.kind === 'term') {
      if (!node.text.trim()) fail('invalid_search_plan', '查询术语不能为空')
      if (node.evidence_scope !== 'self' && !/(?:关联|所属|职位|人才库|分组)/u.test(query.slice(Math.max(0, node.span[0] - 8), node.span[1]))) fail('invalid_search_plan', '能力条件不能使用关联信息证据')
      return
    }
    if (node.field === 'years') {
      if (typeof node.value !== 'number' || !Number.isFinite(node.value) || node.value < 0 || node.value > 80 || node.op === 'in') fail('invalid_search_plan', '年限条件无效')
    } else if (node.field === 'archived') {
      if (node.op !== 'eq' || !['include', 'exclude', 'only'].includes(node.value)) fail('invalid_search_plan', '归档条件无效')
    } else if (node.field === 'stage') {
      if (node.op !== 'eq' || typeof node.value !== 'string' || !node.value.trim() || node.value.length > 80) fail('invalid_search_plan', '候选人阶段条件无效')
    } else if (node.op === 'in') {
      if (!Array.isArray(node.value) || !node.value.length || node.value.some(value => !value.trim())) fail('invalid_search_plan', '列表条件无效')
    } else if (node.op !== 'eq' || typeof node.value !== 'string' || !node.value.trim()) fail('invalid_search_plan', '业务条件无效')
    if (!allowSyntheticSpans || node.span[0] !== node.span[1]) {
      const source = query.slice(...node.span)
      if (node.field === 'years') {
        if (!(source.match(/\d+(?:\.\d+)?/gu) ?? []).some(value => Number(value) === node.value)) fail('invalid_search_plan', '年限值必须来自原文')
      } else if (node.field !== 'archived' && node.field !== 'source') {
        const values = Array.isArray(node.value) ? node.value : [node.value]
        if (values.some(value => !scalarKey(source).includes(scalarKey(value)))) fail('invalid_search_plan', '业务条件值必须来自原文')
      }
    }
  }
  for (const node of [...plan.must, ...plan.should, ...plan.must_not]) visit(node, 1)
  for (const item of plan.unresolved) validateSpan(item, query, { allowSyntheticSpans, requireText: true })
  return plan
}
function parseInput(input) {
  if (typeof input === 'string') input = { q: input }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_query', '查询输入无效')
  const raw = input.q ?? input.query ?? ''
  if (typeof raw !== 'string' || raw.length > MAX_QUERY_LENGTH) fail('invalid_query', '查询长度无效')
  const explicit = { ...(input.filters ?? {}), ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'filters' && value !== undefined)) }
  return { query: raw, explicit }
}
function stringList(value, field, maximum = 16) {
  if (value === undefined || value === null || value === '') return []
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!entries || entries.length > maximum || entries.some(item => typeof item !== 'string' || !item.trim() || item.length > 80)) fail('invalid_query', `${field} 无效`)
  return [...new Set(entries.map(item => item.trim()))]
}
function explicitConditions(explicit, query) {
  const filters = []
  function numeric(...names) {
    const key = names.find(name => explicit[name] !== undefined && explicit[name] !== null && explicit[name] !== '')
    if (!key) return undefined
    const value = Number(explicit[key])
    if (!Number.isFinite(value) || value < 0 || value > 80) fail('invalid_query', '经验年限范围无效')
    return value
  }
  const min = numeric('min_years', 'minYears', 'min')
  const max = numeric('max_years', 'maxYears', 'max')
  if (min !== undefined && max !== undefined && min > max) fail('invalid_query', '经验年限范围无效')
  if (min !== undefined) filters.push(filter('years', 'gte', min))
  if (max !== undefined) filters.push(filter('years', 'lte', max))
  for (const [field, keys] of [
    ['current_location', ['location']], ['desired_location', ['desired_location']],
    ['position_id', ['position_id', 'position']], ['talent_pool_id', ['pool_id', 'talent_pool_id', 'pool']],
    ['education', ['education']], ['current_company', ['current_company']], ['current_title', ['current_title']], ['stage', ['stage']],
  ]) {
    const key = keys.find(name => explicit[name] !== undefined && explicit[name] !== null && explicit[name] !== '')
    if (!key) continue
    if (typeof explicit[key] !== 'string' || explicit[key].length > (field === 'stage' ? 80 : 200)) fail('invalid_query', `${key} 无效`)
    filters.push(filter(field, 'eq', normalized(explicit[key])))
  }
  const archived = explicit.archived ?? (explicit.include_archived === false ? 'exclude' : undefined)
  if (archived !== undefined) {
    if (!['include', 'exclude', 'only'].includes(archived)) fail('invalid_query', '归档条件无效')
    filters.push(filter('archived', 'eq', archived))
  }
  const sources = stringList(explicit.source_types, 'source_types', 3)
  if (sources.some(source => !['candidate', 'profile_section', 'attachment'].includes(source))) fail('invalid_query', '履历来源无效')
  if (sources.length) filters.push(filter('source', 'in', sources))
  const fieldAliases = new Map([['title','title'],['content','content'],['candidate_resume_documents.title','title'],['candidate_resume_documents.content','content']])
  const fields = stringList(explicit.fields, 'fields', 2).map(field => { if (!fieldAliases.has(field)) fail('invalid_query', '检索字段无效'); return fieldAliases.get(field) })
  const span = text => { const at = query.indexOf(text); return at === -1 ? [0, 0] : [at, at + text.length] }
  const keywords = stringList(explicit.keywords, 'keywords').map(text => term(text, span(text)))
  const phrases = stringList(explicit.phrases, 'phrases').map(text => term(text, span(text), 'exact'))
  if (explicit.match_mode !== undefined && !['all', 'any'].includes(explicit.match_mode)) fail('invalid_query', '关键词匹配模式无效')
  return { filters, terms: [...(keywords.length ? [group(explicit.match_mode === 'any' ? 'any' : 'all', keywords)] : []), ...phrases], fields, explicit }
}
function removeOverridden(node, explicitFilters, warnings) {
  if (node.children) {
    const mapped = node.children.map(child => removeOverridden(child, explicitFilters, warnings))
    if (node.kind === 'any' && mapped.some(child => !child)) return null
    const children = mapped.filter(Boolean)
    if (node.scope === 'record' && children.length) return { ...node, children }
    return group(node.kind, children, node.scope)
  }
  if (node.child) {
    const child = removeOverridden(node.child, explicitFilters, warnings)
    return child ? { kind: 'not', child } : null
  }
  if (node.kind !== 'filter') return node
  const overrides = explicitFilters.some(item => item.field === node.field && (item.field !== 'years' || ((['gt', 'gte'].includes(item.op) && ['gt', 'gte'].includes(node.op)) || (['lt', 'lte'].includes(item.op) && ['lt', 'lte'].includes(node.op)))))
  if (overrides) { warnings.push('explicit_filter_override'); return null }
  return node
}
function applyExplicit(natural, conditions, query, source, extraWarnings = []) {
  const warnings = [...extraWarnings]
  const plan = clone(natural)
  for (const key of ['must', 'should', 'must_not']) plan[key] = plan[key].map(node => removeOverridden(node, conditions.filters, warnings)).filter(Boolean)
  plan.must.push(...clone(conditions.terms), ...clone(conditions.filters))
  validateQueryPlan(plan, { query, allowSyntheticSpans: true })
  return { ...plan, metadata: { source, warnings: [...new Set(warnings)], query, schemaVersion: 1, ...(conditions.fields.length ? { fields: conditions.fields } : {}) } }
}
function naturalRules(query, extraTerms = []) {
  const plan = emptyPlan()
  const preference = /(?:最好|偏好|优先|加分项)\s*/u.exec(query)
  const main = preference ? query.slice(0, preference.index) : query
  const state = { unresolved: plan.unresolved, extraTerms: [...new Set(extraTerms)].sort((a, b) => b.length - a.length) }
  const node = parseExpression(main, 0, state)
  for (const child of node?.kind === 'all' && node.scope === 'candidate' ? node.children : node ? [node] : []) {
    if (child.kind === 'not') plan.must_not.push(child.child)
    else plan.must.push(child)
  }
  if (preference) {
    const start = preference.index + preference[0].length
    const preferred = parseExpression(query.slice(start), start, state, 'preference')
    if (preferred) plan.should.push(preferred)
  }
  return plan
}
export function parseRuleQueryPlan(input) {
  const { query, explicit } = parseInput(input)
  const conditions = explicitConditions(explicit, query)
  if (!query.trim() && !conditions.filters.length && !conditions.terms.length) fail('invalid_query', '查询不能为空')
  return applyExplicit(naturalRules(query), conditions, query, 'rules')
}
function atomKey(node) {
  if (node.kind === 'term') return `term:${node.evidence_scope}:${node.match}:${scalarKey(node.text)}`
  return `filter:${node.field}:${node.op}:${JSON.stringify(node.value)}`
}
function canonicalDnf(plan, protectedAtoms) {
  const limit = 256
  const canonicalClauses = clauses => {
    const normalized = clauses.map(clause => [...new Set(clause)].sort())
    const unique = [...new Map(normalized.map(clause => [JSON.stringify(clause), clause])).values()]
    return JSON.stringify(unique.filter(clause => !unique.some(other => other.length < clause.length && other.every(key => clause.includes(key)))).map(clause => JSON.stringify(clause)).sort())
  }
  const product = (left, right) => {
    if (left.length * right.length > limit) fail('invalid_search_plan', '布尔条件组合超过预算')
    return left.flatMap(a => right.map(b => [...new Set([...a, ...b])])).filter(clause => !clause.some(key => clause.includes(key.startsWith('!') ? key.slice(1) : `!${key}`)))
  }
  const visit = (node, negated = false) => {
    if (node.kind === 'not') return visit(node.child, !negated)
    if (node.kind === 'filter' && node.op === 'in') {
      const choices = node.value.map(value => visit({ ...node, op: 'eq', value }, negated))
      return negated ? choices.reduce(product, [[]]) : choices.flat()
    }
    if (node.children) {
      if (node.scope === 'record') {
        // Record membership wraps its own Boolean expression. Negating that
        // membership is different from moving NOT inside the record quantifier.
        const lists = node.children.map(child => visit(child))
        const expression = canonicalClauses(node.kind === 'all' ? lists.reduce(product, [[]]) : lists.flat())
        if (expression === canonicalClauses([[]])) return [[]]
        return [[`${negated ? '!' : ''}record:${expression}`]]
      }
      const conjunctive = (node.kind === 'all') !== negated
      const lists = node.children.map(child => visit(child, negated))
      return conjunctive ? lists.reduce(product, [[]]) : lists.flat()
    }
    const key = atomKey(node)
    // Project the model expression onto deterministic conditions. Unrecognized
    // rule vocabulary must not stop the model from resolving a new concept.
    return protectedAtoms.has(key) ? [[`${negated ? '!' : ''}${key}`]] : [[]]
  }
  const required = [...plan.must.map(node => visit(node)), ...plan.must_not.map(node => visit(node, true))]
  if (plan.minimum_should_match > 0) fail('invalid_search_plan', '不能将必要条件移入偏好条件')
  return canonicalClauses(required.reduce(product, [[]]))
}
function ensureConstraints(model, rules) {
  const atoms = new Set([...rules.must, ...rules.must_not].flatMap(leaves).map(atomKey))
  if (canonicalDnf(model, atoms) !== canonicalDnf(rules, atoms)) fail('model_plan_constraints_changed', '模型改变了确定条件或布尔作用域')
  const preferences = new Set(rules.should.flatMap(leaves).map(atomKey))
  if ([...model.must, ...model.must_not].flatMap(leaves).some(node => preferences.has(atomKey(node)) && !atoms.has(atomKey(node)))) fail('model_plan_constraints_changed', '模型不能把偏好变为必要条件')
}
function ensureResolvedLogic(model, query, rules) {
  const modelLeaves = [...model.must, ...model.should, ...model.must_not].flatMap(leaves)
  // Only source-validated vocabulary comes from the model. Reconstruct AND/OR,
  // NOT, preferences and record scope exclusively from the original query.
  const resolved = naturalRules(query, modelLeaves.filter(node => node.kind === 'term').map(node => node.text))
  const recognizedTerms = new Set([...resolved.must, ...resolved.should, ...resolved.must_not].flatMap(leaves).filter(node => node.kind === 'term').map(atomKey))
  if (modelLeaves.some(node => node.kind === 'term' && !recognizedTerms.has(atomKey(node)))) fail('model_plan_constraints_changed', '模型术语跨越或遗漏了原文逻辑条件')
  const expandFilter = node => node.op === 'in' ? node.value.map(value => ({ ...node, op: 'eq', value })) : [node]
  const recognizedFilters = new Set([...resolved.must, ...resolved.should, ...resolved.must_not].flatMap(leaves).filter(node => node.kind === 'filter').flatMap(expandFilter).map(atomKey))
  if (modelLeaves.filter(node => node.kind === 'filter').flatMap(expandFilter).some(node => !recognizedFilters.has(atomKey(node)))) fail('model_plan_constraints_changed', '模型创建了原文未确定的业务过滤条件')
  ensureConstraints(model, resolved)
  const preferences = new Set(resolved.should.flatMap(leaves).map(atomKey))
  const preferencePlan = plan => ({ must: plan.should, must_not: [], minimum_should_match: 0 })
  if (canonicalDnf(preferencePlan(model), preferences) !== canonicalDnf(preferencePlan(resolved), preferences)) fail('model_plan_constraints_changed', '模型改变了偏好条件的布尔作用域')
  // A partially understood OR/NOT branch cannot be detached and advertised as
  // an independent required/preferred condition. Preserve its unresolved scope.
  for (const item of model.unresolved) {
    if (![...rules.unresolved, ...resolved.unresolved].some(source => source.text === item.text && source.impact === item.impact && source.span[0] === item.span[0] && source.span[1] === item.span[1])) fail('model_plan_constraints_changed', '模型改变了未解析条件的作用域')
  }
}
function ensureCoverage(model, query, rules) {
  const consumed = query.split('')
  const nodes = [...model.must, ...model.should, ...model.must_not].flatMap(leaves)
  for (const node of [...nodes, ...model.unresolved]) for (let index = node.span[0]; index < node.span[1]; index++) consumed[index] = ' '
  const modelFilters = new Set(nodes.filter(node => node.kind === 'filter').map(atomKey))
  for (const node of [...rules.must, ...rules.must_not].flatMap(leaves)) {
    if (node.kind !== 'filter' || !modelFilters.has(atomKey(node))) continue
    for (let index = node.span[0]; index < node.span[1]; index++) consumed[index] = ' '
  }
  const leftover = consumed.join('').replace(FILLER, ' ').replace(/(?:同一(?:项目|任职|记录|段经历)|最好|偏好|优先|加分项|不要|不含|排除|或者|或|并且|而且|且|AND\b|OR\b|NOT\b)/giu, ' ').replace(/[\s,，。;；:：()（）"“”]+/gu, '')
  if (leftover) fail('model_plan_conditions_omitted', '模型遗漏了未解析条件')
}
export async function parseQueryPlan(input, { planner, signal } = {}) {
  cancelled(signal)
  const { query, explicit } = parseInput(input)
  const conditions = explicitConditions(explicit, query)
  const natural = naturalRules(query)
  const rules = parseRuleQueryPlan(input)
  if (typeof planner !== 'function' || !query.trim()) return rules
  try {
    const proposed = await planner(query, searchQueryPlanSchema, { signal })
    cancelled(signal)
    const model = clone(proposed)
    validateQueryPlan(model, { query })
    ensureConstraints(model, natural)
    ensureResolvedLogic(model, query, natural)
    ensureCoverage(model, query, natural)
    return applyExplicit(model, conditions, query, 'model')
  } catch (error) {
    cancelled(signal)
    if (error?.code === 'search_cancelled') throw error
    const warning = ['model_plan_constraints_changed', 'model_plan_conditions_omitted'].includes(error?.code) ? error.code : 'model_planning_unavailable'
    return { ...rules, metadata: { ...rules.metadata, warnings: [...rules.metadata.warnings, warning] } }
  }
}
