import test from 'node:test'
import assert from 'node:assert/strict'

import { parseRuleQueryPlan, parseQueryPlan, validateQueryPlan } from '../../server/search-query-plan.js'
const leaves = (node) => node.children ? node.children.flatMap(leaves) : node.child ? leaves(node.child) : [node]
const terms = (plan) => plan.must.flatMap(leaves).filter(x => x.kind === 'term').map(x => x.text)
const filters = (plan) => plan.must.flatMap(leaves).filter(x => x.kind === 'filter')

test('natural Chinese requirements retain role and discipline without broadening to game development', () => {
  assert.equal(typeof parseRuleQueryPlan, 'function')
  const plan = parseRuleQueryPlan({ q: '上海 游戏策划 战斗系统' })
  assert.deepEqual(terms(plan), ['游戏策划', '战斗系统'])
  assert.ok(filters(plan).some(x => x.field === 'current_location' && x.value === '上海'))
  assert.deepEqual(terms(parseRuleQueryPlan('找熟悉数值策划的人')), ['数值策划'])
})

test('year bounds preserve inclusive and exclusive limits including zero', () => {
  for (const [q, expected] of [
    ['找3到5年经验的后端工程师', [['gte', 3], ['lte', 5]]],
    ['找3年以下经验的后端工程师', [['lte', 3]]],
    ['不足3年经验的后端工程师', [['lt', 3]]],
    ['超过3年经验的后端工程师', [['gt', 3]]],
    ['0年以上后端工程师', [['gte', 0]]],
  ]) {
    const plan = parseRuleQueryPlan(q)
    assert.deepEqual(filters(plan).filter(x => x.field === 'years').map(x => [x.op, x.value]), expected, q)
    assert.deepEqual(terms(plan), ['后端工程师'], q)
  }
  assert.throws(() => parseRuleQueryPlan({ q: '后端', min_years: 5, max_years: 3 }), { code: 'invalid_query' })
})

test('OR and exclusions remain executable boolean constraints', () => {
  const either = parseRuleQueryPlan('Unity 或 Unreal')
  assert.equal(either.must[0].kind, 'any')
  assert.deepEqual(either.must[0].children.map(x => x.text), ['Unity', 'Unreal'])
  const excluded = parseRuleQueryPlan('Unity 不要外包')
  assert.deepEqual(terms(excluded), ['Unity'])
  assert.equal(excluded.must_not[0].text, '外包')
  const nested = parseRuleQueryPlan('(Unity AND NOT 外包) OR Unreal')
  assert.equal(nested.must_not.length, 0)
  assert.equal(nested.must[0].kind, 'any')
  assert.equal(nested.must[0].children[0].kind, 'all')
  assert.equal(nested.must[0].children[0].children[1].kind, 'not')
})

test('location inside OR stays within its branch, desired location remains separate', () => {
  const plan = parseRuleQueryPlan('(上海 Unity) 或 (北京 Unreal)')
  assert.equal(plan.must[0].kind, 'any')
  assert.deepEqual(plan.must[0].children.map(branch => leaves(branch).find(x => x.field === 'current_location').value), ['上海', '北京'])
  assert.equal(filters(parseRuleQueryPlan('意向上海 后端工程师'))[0].field, 'desired_location')
})

test('exact phrases use original UTF-16 spans; explicit fields and UI filters take priority', () => {
  const query = '上海 "战斗 系统"'
  const plan = parseRuleQueryPlan({ q: query, filters: { location: '北京', max_years: 3 }, fields: ['content'] })
  const phrase = plan.must.flatMap(leaves).find(x => x.kind === 'term')
  assert.equal(phrase.match, 'exact')
  assert.equal(query.slice(...phrase.span), phrase.text)
  assert.ok(filters(plan).some(x => x.field === 'current_location' && x.value === '北京'))
  assert.ok(!filters(plan).some(x => x.value === '上海'))
  assert.deepEqual(plan.metadata.fields, ['content'])
  assert.ok(plan.metadata.warnings.includes('explicit_filter_override'))
})

test('legacy keyword, phrase, source and relation filters have compatible semantics', () => {
  const plan = parseRuleQueryPlan({ keywords: ['Unity', 'Unreal'], match_mode: 'any', phrases: ['战斗 系统'], archived: 'exclude', position_id: 'p-1', pool_id: 'pool-1', source_types: ['attachment'] })
  assert.equal(plan.must[0].kind, 'any')
  assert.equal(plan.must[1].match, 'exact')
  assert.deepEqual(Object.fromEntries(filters(plan).map(x => [x.field, x.value])), { archived: 'exclude', position_id: 'p-1', talent_pool_id: 'pool-1', source: ['attachment'] })
})

test('preferences and unsupported specialized years never silently become hard qualifications', () => {
  const preferred = parseRuleQueryPlan('后端工程师 最好熟悉Redis')
  assert.deepEqual(terms(preferred), ['后端工程师'])
  assert.equal(preferred.should[0].text, 'Redis')
  const specialized = parseRuleQueryPlan('Unity开发经验3年以上')
  assert.ok(specialized.unresolved.some(x => x.impact === 'required'))
  assert.ok(!filters(specialized).some(x => x.field === 'years'))
})

test('schema and semantic validation reject SQL, invented spans, overlong and deep plans', () => {
  const clean = { version: 1, must: [{ kind: 'term', text: 'Unity', match: 'concept', evidence_scope: 'self', span: [0, 5] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  assert.doesNotThrow(() => validateQueryPlan(clean, { query: 'Unity' }))
  assert.throws(() => validateQueryPlan({ ...clean, sql: 'SELECT 1' }, { query: 'Unity' }), { code: 'invalid_search_plan' })
  assert.throws(() => validateQueryPlan({ ...clean, must: [{ ...clean.must[0], text: 'Unreal' }] }, { query: 'Unity' }), { code: 'invalid_search_plan' })
  assert.throws(() => validateQueryPlan({ ...clean, must: Array.from({ length: 33 }, () => clean.must[0]) }, { query: 'Unity' }), { code: 'invalid_search_plan' })
  let deep = clean.must[0]
  for (let index = 0; index < 5; index++) deep = { kind: 'not', child: deep }
  assert.throws(() => validateQueryPlan({ ...clean, must: [deep] }, { query: 'Unity' }), { code: 'invalid_search_plan' })
})

test('model planner validates useful plans and deterministic fallback conserves excluded conditions', async () => {
  const q = 'Unity 不要外包'
  const { metadata, ...valid } = parseRuleQueryPlan(q)
  const modelPlan = await parseQueryPlan(q, { planner: async () => valid })
  assert.equal(modelPlan.metadata.source, 'model')
  for (const planner of [async () => ({ ...valid, must_not: [] }), async () => ({ ...valid, sql: 'SELECT 1' }), async () => { throw new Error('secret gateway body') }]) {
    const plan = await parseQueryPlan(q, { planner })
    assert.equal(plan.metadata.source, 'rules')
    assert.equal(plan.must_not[0].text, '外包')
    assert.ok(!JSON.stringify(plan).includes('secret gateway'))
  }
})

test('cancelled planning does not turn into successful fallback', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(parseQueryPlan('Unity', { signal: controller.signal }), { code: 'search_cancelled' })
})

test('unspaced Chinese boolean operators retain OR and local exclusions with full-query spans', () => {
  const q = '(Unity不要外包)或Unreal'
  const plan = parseRuleQueryPlan(q)
  assert.equal(plan.must[0].kind, 'any')
  assert.equal(plan.must_not.length, 0)
  assert.equal(plan.must[0].children[0].children[1].kind, 'not')
  for (const leaf of plan.must.flatMap(leaves)) assert.equal(q.slice(...leaf.span), leaf.text)
  assert.deepEqual(parseRuleQueryPlan('Unity或Unreal').must[0].children.map(x => x.text), ['Unity', 'Unreal'])
})

test('unrecognized natural-language conditions remain unresolved instead of becoming silent hard filters', () => {
  const plan = parseRuleQueryPlan('后端工程师 气质很好')
  assert.deepEqual(terms(plan), ['后端工程师'])
  assert.ok(plan.unresolved.some(x => x.text === '气质很好' && x.impact === 'required'))
  const ambiguousEither = parseRuleQueryPlan('Unity或很有灵气')
  assert.ok(!ambiguousEither.must.some(x => x.text === 'Unity'))
  assert.ok(ambiguousEither.unresolved.length > 0)
})

test('Ajv contract validation rejects missing properties, nested extras, malformed unresolved and numeric filters', () => {
  const { metadata, ...valid } = parseRuleQueryPlan('Unity')
  const missing = structuredClone(valid)
  delete missing.must[0].evidence_scope
  for (const plan of [missing, { ...valid, metadata: {} }, { ...valid, must: [{ ...valid.must[0], sql: 'SELECT 1' }] }, { ...valid, unresolved: [{ text: '', span: [0, 0], reason: 'ambiguous', impact: 'required' }] }, { ...valid, must: [{ kind: 'filter', field: 'years', op: 'eq', value: 'NULL', span: [0, 5] }] }]) {
    assert.throws(() => validateQueryPlan(plan, { query: 'Unity' }), { code: 'invalid_search_plan' })
  }
  assert.throws(() => validateQueryPlan({ ...valid, must: [{ ...valid.must[0], span: [0, 0] }] }, { query: 'Unity' }), { code: 'invalid_search_plan' })
})

test('model cannot move exclusion to positive, mandatory OR to should or weaken inclusive year bounds', async () => {
  for (const [q, alter] of [
    ['Unity 不要外包', plan => { plan.must.push(...plan.must_not); plan.must_not = [] }],
    ['Unity或Unreal', plan => { plan.should = plan.must; plan.must = [] }],
    ['Unity或Unreal', plan => { plan.must[0].kind = 'all' }],
    ['找3到5年经验的后端工程师', plan => { plan.must.find(x => x.field === 'years' && x.op === 'lte').value = 8 }],
    ['(Unity AND NOT 外包) OR Unreal', plan => { const branch = plan.must[0].children[0]; plan.must_not.push(branch.children.pop().child) }],
  ]) {
    const { metadata, ...unsafe } = parseRuleQueryPlan(q)
    alter(unsafe)
    const result = await parseQueryPlan(q, { planner: async () => unsafe })
    assert.equal(result.metadata.source, 'rules', q)
    assert.ok(result.metadata.warnings.some(code => ['model_plan_constraints_changed', 'model_planning_unavailable'].includes(code)), q)
  }
})

test('valid model concepts can resolve rule ambiguity while explicit UI filters are applied by the server', async () => {
  const q = '上海 找精通概率分布的人'
  const proposed = {
    version: 1,
    must: [
      { kind: 'filter', field: 'current_location', op: 'eq', value: '上海', span: [0, 2] },
      { kind: 'term', text: '概率分布', match: 'concept', evidence_scope: 'self', span: [6, 10] },
    ], should: [], minimum_should_match: 0, must_not: [], unresolved: [],
  }
  const plan = await parseQueryPlan({ q, location: '北京', min_years: 3, fields: ['content'] }, { planner: async () => proposed })
  assert.equal(plan.metadata.source, 'model')
  assert.ok(filters(plan).some(x => x.field === 'current_location' && x.value === '北京'))
  assert.ok(!filters(plan).some(x => x.value === '上海'))
  assert.ok(filters(plan).some(x => x.field === 'years' && x.op === 'gte' && x.value === 3))
  assert.deepEqual(terms(plan), ['概率分布'])
  assert.deepEqual(plan.metadata.fields, ['content'])
})

test('model plans must account for remaining substantive Chinese words', async () => {
  const q = 'Unity 气质很好'
  const invalid = { version: 1, must: [{ kind: 'term', text: 'Unity', match: 'concept', evidence_scope: 'self', span: [0, 5] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  const result = await parseQueryPlan(q, { planner: async () => invalid })
  assert.equal(result.metadata.source, 'rules')
  assert.ok(result.unresolved.some(x => x.text === '气质很好'))
})

test('model cannot add invented numeric, location or relationship qualifications with fabricated source spans', () => {
  for (const [query, node] of [
    ['3年以上', { kind: 'filter', field: 'years', op: 'gte', value: 8, span: [0, 4] }],
    ['上海', { kind: 'filter', field: 'current_location', op: 'eq', value: '北京', span: [0, 2] }],
    ['关联某职位', { kind: 'filter', field: 'position_id', op: 'eq', value: 'invented-id', span: [0, 5] }],
    ['精通概率分布', { kind: 'term', text: '概率分布', match: 'concept', evidence_scope: 'linked_position', span: [2, 6] }],
  ]) {
    const plan = { version: 1, must: [node], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
    assert.throws(() => validateQueryPlan(plan, { query }), { code: 'invalid_search_plan' })
  }
})

test('nested explicit location override retains the remaining OR qualifications and records the override', async () => {
  const q = '(上海 Unity)或(北京 Unreal)'
  const { metadata, ...model } = parseRuleQueryPlan(q)
  const result = await parseQueryPlan({ q, location: '广州' }, { planner: async () => model })
  assert.equal(result.metadata.source, 'model')
  assert.equal(result.must[0].kind, 'any')
  assert.deepEqual(result.must[0].children.map(x => x.text), ['Unity', 'Unreal'])
  assert.deepEqual(filters(result).map(x => x.value), ['广州'])
})

test('overriding a complete OR branch does not accidentally add the other branch as a must', () => {
  const plan = parseRuleQueryPlan({ q: '上海或Unity', location: '北京' })
  assert.deepEqual(terms(plan), [])
  assert.deepEqual(filters(plan).map(x => [x.field, x.value]), [['current_location', '北京']])
})

test('same-project requirements retain record scope and reject candidate-scope model broadening', async () => {
  const q = '同一项目 Unity AND Unreal'
  const plan = parseRuleQueryPlan(q)
  assert.equal(plan.must[0].scope, 'record')
  const { metadata, ...model } = structuredClone(plan)
  model.must[0].scope = 'candidate'
  const rejected = await parseQueryPlan(q, { planner: async () => model })
  assert.equal(rejected.metadata.source, 'rules')
})

test('model cannot harden a preference or move a hard condition into a mandatory should collection', async () => {
  const q = 'Unity 最好熟悉Redis'
  const { metadata, ...model } = parseRuleQueryPlan(q)
  model.must.push(...model.should)
  model.should = []
  assert.equal((await parseQueryPlan(q, { planner: async () => model })).metadata.source, 'rules')
})

test('a model may resolve a full role phrase instead of a partial rule dictionary guess', async () => {
  const q = '找后端架构师'
  assert.deepEqual(terms(parseRuleQueryPlan(q)), [])
  const model = { version: 1, must: [{ kind: 'term', text: '后端架构师', match: 'concept', evidence_scope: 'self', span: [1, 6] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  const result = await parseQueryPlan(q, { planner: async () => model })
  assert.equal(result.metadata.source, 'model')
  assert.deepEqual(terms(result), ['后端架构师'])
})

test('a structured location list may represent the same mandatory OR without changing semantics', async () => {
  const q = '上海或北京'
  const proposed = {
    version: 1,
    must: [{ kind: 'filter', field: 'current_location', op: 'in', value: ['上海', '北京'], span: [0, 5] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [],
  }
  const result = await parseQueryPlan(q, { planner: async () => proposed })
  assert.equal(result.metadata.source, 'model')
})

test('numeric spans may identify the number when validated operator preserves the complete stated bound', async () => {
  const q = '找3年以下经验的后端工程师'
  const model = { version: 1, must: [{ kind: 'filter', field: 'years', op: 'lte', value: 3, span: [1, 2] }, { kind: 'term', text: '后端工程师', match: 'concept', evidence_scope: 'self', span: [8, 13] }], should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
  assert.equal((await parseQueryPlan(q, { planner: async () => model })).metadata.source, 'model')
})

test('legacy explicit stage remains a mandatory string filter in rules, model results and model failure', async () => {
  const query = 'Unity'
  const { metadata, ...model } = parseRuleQueryPlan(query)
  for (const input of [{ q: query, stage: '面试中' }, { q: query, filters: { stage: '面试中' } }]) {
    const plans = [parseRuleQueryPlan(input), await parseQueryPlan(input, { planner: async () => model }), await parseQueryPlan(input, { planner: async () => { throw new Error('anonymous failure') } })]
    for (const plan of plans) {
      assert.ok(filters(plan).some(node => node.field === 'stage' && node.op === 'eq' && node.value === '面试中'))
      assert.equal(plan.unresolved.some(node => node.text === '面试中'), false)
    }
  }
  for (const stage of [123, ['面试中'], 'x'.repeat(81)]) assert.throws(() => parseRuleQueryPlan({ q: query, stage }), { code: 'invalid_query' })
})

const novelPlan = (query, build) => {
  const term = text => ({ kind: 'term', text, match: 'concept', evidence_scope: 'self', span: [query.indexOf(text), query.indexOf(text) + text.length] })
  const all = (...children) => ({ kind: 'all', scope: 'candidate', children })
  const any = (...children) => ({ kind: 'any', scope: 'candidate', children })
  const not = child => ({ kind: 'not', child })
  return { version: 1, must: [], should: [], minimum_should_match: 0, must_not: [], unresolved: [], ...build(term, all, any, not) }
}

test('unknown terms cannot lose Boolean, exclusion, preference or same-record semantics', async () => {
  const cases = [
    ['可观测性 OR 链路追踪', t => ({ must: [t('可观测性'), t('链路追踪')] })],
    ['可观测性 AND 链路追踪', (t, _all, any) => ({ must: [any(t('可观测性'), t('链路追踪'))] })],
    ['NOT 可观测性', t => ({ must: [t('可观测性')] })],
    ['(可观测性 AND NOT 链路追踪) OR 日志治理', (t, _all, any) => ({ must: [any(t('可观测性'), t('日志治理'))], must_not: [t('链路追踪')] })],
    ['同一项目 可观测性 AND 链路追踪', t => ({ must: [t('可观测性'), t('链路追踪')] })],
    ['同一项目 可观测性 AND 链路追踪', (t, _all, any) => ({ must: [{ ...any(t('可观测性'), t('链路追踪')), scope: 'record' }] })],
    ['可观测性 最好链路追踪', t => ({ must: [t('可观测性'), t('链路追踪')] })],
    ['可观测性 OR 链路追踪', t => ({ must: [t('可观测性 OR 链路追踪')] })],
    ['可观测性 OR 链路追踪', t => ({ must: [t('可观测性')], unresolved: [{ text: '链路追踪', span: [8,12], reason: 'ambiguous', impact: 'required' }] })],
    ['NOT 可观测性', () => ({ unresolved: [{ text: '可观测性', span: [4,8], reason: 'ambiguous', impact: 'required' }] })],
    ['可观测性 OR 链路追踪', () => ({ must: ['可观测性', '链路追踪'].map((value, index) => ({ kind: 'filter', field: 'current_title', op: 'eq', value, span: index ? [8,12] : [0,4] })) })],
    ['Unity 最好(可观测性 OR 链路追踪)', t => ({ must: [t('Unity')], should: [t('可观测性'), t('链路追踪')] })],
  ]
  for (const [query, build] of cases) {
    const proposed = novelPlan(query, build)
    validateQueryPlan(proposed, { query })
    const result = await parseQueryPlan(query, { planner: async () => proposed })
    assert.equal(result.metadata.source, 'rules', query)
    assert.ok(result.metadata.warnings.includes('model_plan_constraints_changed'), query)
  }
})

test('valid unknown Boolean and same-record plans pass without weakening known conditions', async () => {
  for (const [query, build] of [
    ['可观测性 OR 链路追踪', (t, _all, any) => ({ must: [any(t('可观测性'), t('链路追踪'))] })],
    ['可观测性 AND 链路追踪', t => ({ must: [t('可观测性'), t('链路追踪')] })],
    ['NOT 可观测性', t => ({ must_not: [t('可观测性')] })],
    ['(可观测性 AND NOT 链路追踪) OR 日志治理', (t, all, any, not) => ({ must: [any(all(t('可观测性'), not(t('链路追踪'))), t('日志治理'))] })],
    ['同一项目 可观测性 AND 链路追踪', (t, all) => ({ must: [{ ...all(t('链路追踪'), t('可观测性')), scope: 'record' }] })],
    ['同一项目 可观测性 OR 链路追踪', (t, _all, any) => ({ must: [{ ...any(t('可观测性'), t('链路追踪')), scope: 'record' }] })],
    ['可观测性 最好链路追踪', t => ({ must: [t('可观测性')], should: [t('链路追踪')] })],
    ['(可观测性 OR 链路追踪) AND NOT 外包', (t, _all, any) => ({ must: [any(t('可观测性'), t('链路追踪'))], must_not: [t('外包')] })],
    ['同一项目 Unity AND 链路追踪', (t, all) => ({ must: [{ ...all(t('Unity'), t('链路追踪')), scope: 'record' }] })],
    ['NOT (可观测性 OR 链路追踪)', t => ({ must_not: [t('可观测性'), t('链路追踪')] })],
    ['Unity 最好(可观测性 OR 链路追踪)', (t, _all, any) => ({ must: [t('Unity')], should: [any(t('可观测性'), t('链路追踪'))] })],
  ]) {
    const proposed = novelPlan(query, build)
    const result = await parseQueryPlan(query, { planner: async () => proposed })
    assert.equal(result.metadata.source, 'model', query)
  }
})

test('validated unknown concepts preserve filler substrings inside their original spans', async () => {
  for (const query of ['工作流编排', '工作流编排 OR 可观测性']) {
    const model = novelPlan(query, (t, _all, any) => ({ must: query.includes('OR') ? [any(t('工作流编排'), t('可观测性'))] : [t('工作流编排')] }))
    const result = await parseQueryPlan(query, { planner: async () => model })
    assert.equal(result.metadata.source, 'model')
  }
})

test('explicit current-title labels support source-backed filters without converting bare concepts into title filters', async () => {
  const query = '当前职务：平台架构师'
  const model = novelPlan(query, () => ({ must: [{ kind: 'filter', field: 'current_title', op: 'eq', value: '平台架构师', span: [0,10] }] }))
  assert.equal((await parseQueryPlan(query, { planner: async () => model })).metadata.source, 'model')
  const bare = '平台架构师'
  const invalid = novelPlan(bare, () => ({ must: [{ kind: 'filter', field: 'current_title', op: 'eq', value: bare, span: [0,5] }] }))
  assert.equal((await parseQueryPlan(bare, { planner: async () => invalid })).metadata.source, 'rules')
})

test('a current-title label inside a quoted phrase remains exact text rather than an extra hard filter', async () => {
  const query = '"负责 当前职务：平台架构师"'
  const phrase = query.slice(1, -1)
  const proposed = novelPlan(query, () => ({ must: [{ kind: 'term', text: phrase, match: 'exact', evidence_scope: 'self', span: [1, query.length-1] }] }))
  const rules = parseRuleQueryPlan(query)
  assert.equal(rules.must.length, 1)
  assert.equal(rules.must[0].kind, 'term')
  assert.equal(rules.must[0].match, 'exact')
  assert.equal((await parseQueryPlan(query, { planner: async () => proposed })).metadata.source, 'model')
})
