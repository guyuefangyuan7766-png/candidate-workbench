import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../../server/database.js'
import { insertCandidate } from '../../server/candidates.js'
import { hybridSearch } from '../../server/hybrid-search.js'

const dbs = []
afterEach(() => {
  while (dbs.length) dbs.pop().close()
})
function db() {
  const value = openDatabase(':memory:')
  dbs.push(value)
  return value
}
function section(database, candidateId, title, content) {
  const now = new Date().toISOString()
  database
    .prepare(
      `INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,structured_data,sort_order,sensitivity,created_at,updated_at) VALUES(?,?,?,?,?,'{}',0,'internal',?,?)`
    )
    .run(randomUUID(), candidateId, 'project', title, content, now, now)
}
function keywordPlan(text) {
  return {
    version: 1,
    must: [],
    should: [],
    minimum_should_match: 0,
    must_not: [],
    unresolved: [{ text, span: [0, text.length], reason: 'ambiguous', impact: 'required' }],
    metadata: { source: 'rules', warnings: [] }
  }
}

test('an unrelated keyword returns zero rows instead of the whole library', async () => {
  const database = db()
  for (let index = 0; index < 5; index += 1)
    insertCandidate(database, { name: `匿名候选人 ${index}`, current_title: '后端工程师' })

  const result = await hybridSearch(database, {
    plan: keywordPlan('zzzz不存在的关键词qqq'),
    query: 'zzzz不存在的关键词qqq',
    page: 1,
    page_size: 20
  })

  assert.equal(result.items.length, 0)
  assert.equal(result.pagination.total, 0)
  assert.equal(result.pagination.has_more, false)
})

test('a keyword hit carries self evidence, a null score and no partial-match claim', async () => {
  const database = db()
  const target = insertCandidate(database, { name: '匿名命中甲', current_title: '产品设计师' })
  section(database, target.id, '产品项目', '负责产品设计与体验走查')
  insertCandidate(database, { name: '匿名未命中乙', current_title: '后端工程师' })

  const result = await hybridSearch(database, {
    plan: keywordPlan('产品设计'),
    query: '产品设计',
    page: 1,
    page_size: 20
  })

  const hit = result.items.find((item) => item.candidate_id === target.id)
  assert.ok(hit, '关键词命中项缺失')
  assert.notEqual(hit.condition_status, 'padding')
  assert.ok(hit.evidence.length > 0, '命中项证据为空')
  assert.ok(hit.evidence.every((item) => item.ownership === 'self'))
  assert.equal(hit.score, null)
  assert.ok(hit.reasons.includes('本地关键词命中'))
})

test('padding rows are labelled, never claim a hit, and stay out of the real total', async () => {
  const database = db()
  const target = insertCandidate(database, { name: '匿名命中丙', current_title: '产品设计师' })
  section(database, target.id, '产品项目', '负责产品设计与体验走查')
  for (let index = 0; index < 4; index += 1)
    insertCandidate(database, { name: `匿名填充 ${index}`, current_title: '后端工程师' })

  const result = await hybridSearch(database, {
    plan: keywordPlan('产品设计'),
    query: '产品设计',
    page: 1,
    page_size: 20
  })

  assert.equal(result.items[0].candidate_id, target.id)
  assert.equal(result.pagination.total, 1)
  assert.equal(result.pagination.total_pages, 1)
  const padding = result.items.filter((item) => item.condition_status === 'padding')
  assert.ok(padding.length > 0, '缺少补齐项')
  assert.ok(padding.every((item) => item.reasons.includes('仅用于补足分页，不代表命中')))
  assert.ok(padding.every((item) => item.evidence.length === 0))
  assert.ok(padding.every((item) => item.score === null))
})

test('structured conditions keep their previous scope without keyword narrowing', async () => {
  const database = db()
  insertCandidate(database, { name: '匿名上海甲', current_title: '产品设计师', location: '上海' })
  insertCandidate(database, { name: '匿名北京乙', current_title: '产品设计师', location: '北京' })

  const plan = {
    version: 1,
    must: [{ kind: 'filter', field: 'current_location', op: 'eq', value: '上海', span: [0, 2] }],
    should: [],
    minimum_should_match: 0,
    must_not: [],
    unresolved: [],
    metadata: { source: 'rules', warnings: [] }
  }
  const result = await hybridSearch(database, { plan, query: '上海', page: 1, page_size: 20 })

  assert.equal(result.pagination.total, 1)
  assert.deepEqual(result.items.map((item) => item.name), ['匿名上海甲'])
  assert.equal(result.items[0].condition_status, 'matched')
})
