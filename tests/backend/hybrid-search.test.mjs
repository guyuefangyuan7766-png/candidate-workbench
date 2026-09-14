import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../server/database.js'
import { insertCandidate } from '../../server/candidates.js'
import { hybridSearch } from '../../server/hybrid-search.js'
import { parseRuleQueryPlan } from '../../server/search-query-plan.js'
import { readSearchDocuments, createVectorStore, chunkResumeDocument } from '../../server/search-vector-store.js'

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
function plan(must, extra = {}) {
  return {
    version: 1,
    must,
    should: [],
    minimum_should_match: 0,
    must_not: [],
    unresolved: [],
    metadata: { source: 'rules', warnings: [] },
    ...extra
  }
}
const term = (text, match = 'exact', scope = 'self') => ({
  kind: 'term',
  text,
  match,
  evidence_scope: scope,
  span: [0, text.length]
})

test('hard candidate conditions are applied before evidence window and preserve a match after old FTS window', async () => {
  const database = db()
  let target
  for (let i = 0; i < 20; i++) {
    const candidate = insertCandidate(database, {
      name: `Anonymous ${i}`,
      current_title: i === 19 ? '后端工程师' : '后端工程师'
    })
    section(
      database,
      candidate.id,
      '经历',
      i === 19 ? 'Unity 后端战斗系统' : '后端接口开发'
    )
    if (i === 19) target = candidate
  }
  const result = await hybridSearch(database, {
    plan: plan([term('Unity'), term('战斗系统')]),
    query: 'Unity 战斗系统',
    page: 1,
    page_size: 20
  })
  assert.ok(result.items.some((item) => item.candidate_id === target.id))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].condition_status, 'matched')
})

test('related position text cannot satisfy a candidate skill condition', async () => {
  const database = db()
  const candidate = insertCandidate(database, {
    name: 'Anonymous Related Only',
    current_title: '后端工程师'
  })
  const position = insertCandidate(database, {
    name: 'Anonymous Other',
    current_title: '战斗系统'
  })
  void position
  const positionId = randomUUID()
  const now = new Date().toISOString()
  database
    .prepare(
      `INSERT INTO positions(id,title,description,department,location,owner,headcount,status,tags,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,1,'draft','[]',?,?,NULL)`
    )
    .run(
      positionId,
      '战斗系统职位',
      '要求 Unity 战斗系统',
      '研发',
      '上海',
      '匿名负责人',
      now,
      now
    )
  database
    .prepare(
      'INSERT INTO candidate_positions(candidate_id,position_id,created_at) VALUES(?,?,?)'
    )
    .run(candidate.id, positionId, now)
  const result = await hybridSearch(database, {
    plan: plan([term('Unity')]),
    query: 'Unity',
    page: 1,
    page_size: 20
  })
  assert.equal(result.items.length, 0)
})

test('excluded evidence removes candidates regardless of vector similarity', async () => {
  const database = db()
  const candidate = insertCandidate(database, {
    name: 'Anonymous Outsourcing',
    current_title: 'Unity 工程师'
  })
  section(database, candidate.id, '经历', 'Unity 外包项目')
  const result = await hybridSearch(database, {
    plan: plan([term('Unity')], { must_not: [term('外包')] }),
    query: 'Unity 不要外包',
    page: 1,
    page_size: 20,
    vectorStore: {
      search: async () => [
        { candidate_id: candidate.id, chunk_id: 'x', score: 0.99 }
      ]
    },
    queryVector: [1, 0]
  })
  assert.equal(result.items.length, 0)
})

test('cross-record intersection stays candidate scoped and returns business evidence ownership', async () => {
  const database = db()
  const candidate = insertCandidate(database, {
    name: 'Anonymous Cross Record',
    current_title: '后端工程师'
  })
  section(database, candidate.id, '经历', '负责 Unity 运行时')
  section(database, candidate.id, '项目', '实现 战斗系统')
  const result = await hybridSearch(database, {
    plan: plan([term('Unity'), term('战斗系统')]),
    query: 'Unity 战斗系统',
    page: 1,
    page_size: 20
  })
  assert.equal(result.items.length, 1)
  assert.equal(
    result.items[0].evidence.every((e) => e.ownership === 'self'),
    true
  )
  assert.ok(result.items[0].evidence.some((e) => e.source_label === '项目经历'))
})

test('a candidate after 10000 source documents is still qualified before Top-K', async () => {
  const database = db()
  const noise = insertCandidate(database, {
    name: '匿名干扰',
    current_title: 'Unity'
  })
  const target = insertCandidate(database, {
    name: '匿名目标',
    current_title: 'Unity'
  })
  database
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10020) INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) SELECT 'noise-'||i,?,'project','项目','Unity unrelated','2026-09-10','2026-09-10' FROM n`
    )
    .run(noise.id)
  section(database, target.id, '目标项目', 'Unity 战斗系统')
  const result = await hybridSearch(database, {
    plan: plan([term('Unity'), term('战斗系统')]),
    query: 'Unity 战斗系统'
  })
  assert.deepEqual(
    result.items.map((x) => x.candidate_id),
    [target.id]
  )
})

test('same-record scope, local NOT and year null semantics survive execution', async () => {
  const database = db()
  const one = insertCandidate(database, {
    name: '匿名跨记录',
    current_title: '开发工程师'
  })
  section(database, one.id, '经历', 'Unity')
  section(database, one.id, '项目', 'Unreal')
  const p = plan([
    { kind: 'all', scope: 'record', children: [term('Unity'), term('Unreal')] }
  ])
  assert.equal(
    (await hybridSearch(database, { plan: p, query: '同一项目 Unity Unreal' }))
      .items.length,
    0
  )
  const unknown = insertCandidate(database, {
    name: '匿名未知',
    current_title: '后端工程师'
  })
  void unknown
  const result = await hybridSearch(database, {
    plan: parseRuleQueryPlan('找3年以下经验的后端工程师'),
    query: '找3年以下经验的后端工程师'
  })
  assert.equal(result.items.length, 0)
  const branch = await hybridSearch(database, {
    plan: parseRuleQueryPlan('(Unity AND NOT 外包) OR Unreal'),
    query: '(Unity AND NOT 外包) OR Unreal'
  })
  assert.ok(branch.items.some((i) => i.candidate_id === one.id))
})

test('rerank operates before pagination and rejects a response that omits candidates', async () => {
  const database = db()
  for (let i = 0; i < 8; i++)
    insertCandidate(database, {
      name: `匿名排序 ${i}`,
      current_title: 'Unity 工程师'
    })
  let budget = 0
  const result = await hybridSearch(database, {
    plan: plan([term('Unity')]),
    query: 'Unity',
    page_size: 2,
    rerankDocuments: async (_q, documents) => {
      budget = documents.length
      return documents.map((_, index) => ({
        index: documents.length - index - 1,
        relevance_score: 1
      }))
    }
  })
  assert.equal(budget, 8)
  assert.equal(result.items.length, 2)
  const invalid = await hybridSearch(database, {
    plan: plan([term('Unity')]),
    query: 'Unity',
    page_size: 2,
    rerankDocuments: async () => []
  })
  assert.equal(invalid.items.length, 2)
  assert.ok(invalid.degradation.some((d) => d.stage === 'rerank'))
})

test('JSON relationship snapshots and archived sections never supply ability evidence', async () => {
  const database = db()
  const c = insertCandidate(database, {
    name: '匿名伪命中',
    current_title: '开发工程师'
  })
  const now = '2026-09-10'
  database
    .prepare(
      `INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,structured_data,created_at,updated_at) VALUES('fake',?,'project','项目','普通开发','{"position":{"requirement":"Unity"}}',?,?)`
    )
    .run(c.id, now, now)
  assert.equal(
    (
      await hybridSearch(database, {
        plan: plan([term('Unity')]),
        query: 'Unity'
      })
    ).items.length,
    0
  )
  database
    .prepare(
      "UPDATE candidate_profile_sections SET content='Unity',archived_at=? WHERE id='fake'"
    )
    .run(now)
  assert.equal(
    (
      await hybridSearch(database, {
        plan: plan([term('Unity')]),
        query: 'Unity'
      })
    ).items.length,
    0
  )
})

test('semantic-only own experience reaches rerank and paged evidence while source filters apply before vector scoring', async () => {
  const database = db()
  const candidate = insertCandidate(database, {
    name: '匿名语义',
    current_title: '设计师'
  })
  section(
    database,
    candidate.id,
    '项目',
    'Designed player progression and economy balance'
  )
  const doc = readSearchDocuments(database, {
    candidateIds: [candidate.id]
  }).find((d) => d.source_type === 'profile_section')
  let sent = []
  let filters
  const p = plan([], { should: [term('数值策划', 'concept')] })
  const args = {
    plan: p,
    query: '优先数值策划',
    sourceTypes: ['profile_section'],
    queryVector: [1, 0],
    vectorStore: {
      search: async (_vector, options) => {
        filters = options
        return [{ ...doc, start: 0, end: doc.content.length, score: 0.9 }]
      }
    }
  }
  const result = await hybridSearch(database, {
    ...args,
    rerankDocuments: async (_q, documents) => {
      sent = documents
      return documents.map((_, index) => ({ index, relevance_score: 1 }))
    }
  })
  assert.deepEqual(filters.sourceTypes, ['profile_section'])
  assert.ok(sent[0].includes('player progression'))
  assert.equal(result.items[0].evidence[0].ownership, 'self')
  assert.equal(result.items[0].evidence[0].match_kind, 'semantic')
  const again = await hybridSearch(database, {
    ...args,
    snapshot: result._snapshot
  })
  assert.deepEqual(again.items[0].evidence, result.items[0].evidence)
  database
    .prepare('UPDATE candidate_profile_sections SET content=? WHERE id=?')
    .run('New unrelated content', doc.source_id)
  assert.equal(
    (await hybridSearch(database, { ...args, snapshot: result._snapshot }))
      .items[0].evidence.length,
    0
  )
  assert.equal(
    (
      await hybridSearch(database, {
        ...args,
        plan: plan([term('数值策划', 'concept')])
      })
    ).items.length,
    0,
    'Vector cannot establish a hard skill condition'
  )
})

test('own string skill tags qualify while nested relationship objects do not', async () => {
  const database = db()
  const c = insertCandidate(database, {
    name: '匿名标签',
    current_title: 'Engineer',
    tags: ['Unity']
  })
  assert.deepEqual(
    (
      await hybridSearch(database, {
        plan: plan([term('Unity')]),
        query: 'Unity'
      })
    ).items.map((i) => i.candidate_id),
    [c.id]
  )
  database
    .prepare('UPDATE candidates SET tags=? WHERE id=?')
    .run('[{"linked_position":"Unreal"}]', c.id)
  assert.equal(
    (
      await hybridSearch(database, {
        plan: plan([term('Unreal')]),
        query: 'Unreal'
      })
    ).items.length,
    0
  )
})

test('deep pages cross the 400-candidate fusion window without omissions or duplicates', async () => {
  const database = db()
  const insert = database.prepare("INSERT INTO candidates(id,name,current_title,created_at,updated_at) VALUES(?,'匿名深分页','Unity','2026-09-10','2026-09-10')")
  const ids = Array.from({ length: 530 }, (_, i) => `anonymous-page-${String(i).padStart(4, '0')}`)
  database.exec('BEGIN')
  for (const id of ids) insert.run(id)
  database.exec('COMMIT')
  const vectorRows = readSearchDocuments(database, { candidateIds: ids.slice(200, 400) })
  const args = { plan: plan([term('Unity')]), query: 'Unity', page_size: 37, queryVector: [1, 0], vectorStore: { search: async () => vectorRows } }
  const first = await hybridSearch(database, args)
  assert.equal(first._snapshot.head.length, 400)
  const seen = first.items.map(item => item.candidate_id)
  for (let page = 2; page <= first.pagination.total_pages; page++) {
    const result = await hybridSearch(database, { ...args, page, snapshot: first._snapshot })
    seen.push(...result.items.map(item => item.candidate_id))
  }
  assert.equal(seen.length, 530)
  assert.deepEqual([...new Set(seen)].sort(), ids)
})

test('wide qualified populations expand bounded ANN and recheck hard conditions', async () => {
  const database = db()
  const insert = database.prepare("INSERT INTO candidates(id,name,current_title,years_experience,created_at,updated_at) VALUES(?,'Anonymous','Engineer',5,'v1','v1')")
  database.exec('BEGIN')
  for (let n = 0; n < 10002; n++) insert.run(`wide-${String(n).padStart(6, '0')}`)
  database.exec('COMMIT')
  database.prepare("UPDATE candidates SET years_experience=0 WHERE id='wide-000000'").run()
  section(database, 'wide-010001', 'Skills', 'Anonymous engine development')
  const doc = readSearchDocuments(database, { candidateIds: ['wide-010001'] }).find(row => row.source_type === 'profile_section')
  const windows = []
  const store = {
    status: () => ({ max_ann_vectors: 6400 }),
    searchQualifiedFacts: () => { throw new Error('Wide populations must use ANN') },
    searchAnn: (_q, { limit }) => {
      windows.push(limit)
      return { approximate: true, index_vectors: 20000, inspected_facts: limit, facts: limit === 400
        ? [{ key: 1, candidate_id: 'wide-000000', score: 1 }]
        : [{ key: 1, candidate_id: 'wide-000000', score: 1 }, { key: 2, candidate_id: doc.candidate_id, score: 0.9 }] }
    },
    readFactChunks: keys => ({ rows: keys.includes(2) ? [{ ...doc, fact_key: 2, start: 0, end: doc.content.length }] : [], next: null })
  }
  const result = await hybridSearch(database, { plan: plan([{ kind: 'filter', field: 'years', op: 'gte', value: 3 }]), query: 'engine development', queryVector: [1, 0], vectorStore: store, sourceTypes: ['profile_section'] })
  assert.equal(result.performance.vector_candidates, 1)
  assert.ok(result.items.some(row => row.candidate_id === doc.candidate_id))
  assert.equal(result.items.some(row => row.candidate_id === 'wide-000000'), false)
  assert.deepEqual(windows, [400, 800, 1600, 3200, 6400])
  assert.equal(result.completeness.vector.approximate, true)
  assert.equal(result.completeness.vector.stop_reason, 'budget')
  assert.equal(result.completeness.vector.inspected_facts, 12400)
})

test('reranking removes candidate identity literals while retaining original local evidence', async () => {
  const database = db()
  const candidate = insertCandidate(database, { name: 'IdentitySecret', phone: '13812345678', email: 'identity@example.test', current_title: 'Engineer' })
  section(database, candidate.id, 'Skills', 'Unity work by IdentitySecret contact 13812345678 identity@example.test')
  let sent
  const result = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', rerankDocuments: async (_q, docs) => { sent = docs.join('\n'); return docs.map((_, index) => ({ index, relevance_score: 1 })) } })
  assert.equal(/IdentitySecret|13812345678|identity@example.test/u.test(sent), false)
  assert.ok(result.items[0].evidence.some(row => row.snippet.text.includes('IdentitySecret')))
})

test('rerank outbound whitelist excludes high sensitivity and archived people while retaining local evidence and eligible ranking', async () => {
  const database = db()
  const sensitive = insertCandidate(database, { name: 'Anonymous sensitive', current_title: 'Engineer' })
  section(database, sensitive.id, 'Sensitive', 'Unity synthetic-high-sensitive-marker')
  database.prepare("UPDATE candidate_profile_sections SET sensitivity='high' WHERE candidate_id=?").run(sensitive.id)
  const archived = insertCandidate(database, { name: 'Anonymous archived', current_title: 'Unity synthetic-archived-marker' })
  database.prepare("UPDATE candidates SET archived_at='2026-09-10' WHERE id=?").run(archived.id)
  const allowed = insertCandidate(database, { name: 'Anonymous allowed', current_title: 'Unity synthetic-allowed-marker' })
  const another = insertCandidate(database, { name: 'Anonymous second allowed', current_title: 'Unity synthetic-second-allowed-marker' })
  const local = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity' })
  let sent = []
  const result = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', rerankDocuments: async (_q, docs) => {
    sent = docs
    return docs.map((_, index) => ({ index: docs.length - 1 - index, relevance_score: 1 }))
  } })
  assert.equal(sent.length, 2)
  assert.ok(sent.some(text => text.includes('synthetic-allowed-marker')))
  assert.ok(!sent.join('\n').includes('synthetic-high-sensitive-marker'))
  assert.ok(!sent.join('\n').includes('synthetic-archived-marker'))
  assert.equal(result.items.length, 4)
  assert.ok(result.items.find(item => item.candidate_id === sensitive.id).evidence.some(item => item.snippet.text.includes('synthetic-high-sensitive-marker')))
  assert.ok(result.items.some(item => item.candidate_id === allowed.id))
  const allowedIds = new Set([allowed.id, another.id])
  const reordered = local.items.filter(item => allowedIds.has(item.candidate_id)).map(item => item.candidate_id).reverse()
  assert.deepEqual(result.items.map(item => item.candidate_id), local.items.map(item => allowedIds.has(item.candidate_id) ? reordered.shift() : item.candidate_id))
  const secondPage = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', page: 2, page_size: 2, snapshot: result._snapshot })
  assert.deepEqual(secondPage.items.map(item => item.candidate_id), result.items.slice(2).map(item => item.candidate_id))
  assert.equal(new Set([...result.items.slice(0,2), ...secondPage.items].map(item => item.candidate_id)).size, 4)
  assert.ok(result.degradation.some(item => item.code === 'rerank_source_scope'))
})

test('linked job text stays local and is never substituted for missing allowed self evidence in rerank', async () => {
  const database = db()
  const candidate = insertCandidate(database, { name: 'Anonymous relation', current_title: 'Engineer' })
  const positionId = randomUUID(); const now = new Date().toISOString()
  database.prepare("INSERT INTO positions(id,title,description,department,location,owner,headcount,status,tags,created_at,updated_at) VALUES(?,?,?,'','','',1,'draft','[]',?,?)").run(positionId, 'Unity role', 'Unity synthetic-linked-jd-marker', now, now)
  database.prepare('INSERT INTO candidate_positions(candidate_id,position_id,created_at) VALUES(?,?,?)').run(candidate.id, positionId, now)
  let calls = 0
  const result = await hybridSearch(database, { plan: plan([term('Unity', 'exact', 'linked_position')]), query: 'Unity', rerankDocuments: async () => { calls++; return [] } })
  assert.equal(result.items.length, 1)
  assert.ok(result.items[0].evidence.some(row => row.ownership === 'related'))
  assert.equal(calls, 0)
  assert.ok(result.degradation.some(row => row.code === 'rerank_source_scope'))
})

test('identity redaction precedes excerpt slicing so a clipped phone tail cannot escape outbound masking', async () => {
  const database = db()
  const candidate = insertCandidate(database, { name: 'Anonymous boundary', phone: '13800138000', current_title: 'Engineer', self_summary: 'x'.repeat(100)+'13800138000'+'x'.repeat(92)+' Unity' })
  let sent = ''
  const result = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', rerankDocuments: async (_query, docs) => { sent = docs.join('\n'); return docs.map((_, index) => ({ index, relevance_score: 1 })) } })
  assert.ok(sent.includes('Unity'))
  assert.ok(!sent.includes('0138000'))
  assert.ok(result.items[0].evidence.some(row => row.snippet.text.includes('0138000')))
  assert.equal(result.items[0].candidate_id, candidate.id)
})

test('an allowed profile with a current company retains its lexical evidence projection for rerank', async () => {
  const database = db()
  insertCandidate(database, { name: 'Anonymous company', current_title: 'Developer', current_company: 'Synthetic Company', self_summary: 'Unity engineer' })
  let sent = []
  const result = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', rerankDocuments: async (_query, docs) => { sent = docs; return docs.map((_, index) => ({ index, relevance_score: 1 })) } })
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('Unity engineer'))
  assert.equal(result.completeness.ranking, 'hybrid_reranked')
})

test('attachment filenames alone are local title evidence and never become outbound resume text', async () => {
  const database = db()
  const candidate = insertCandidate(database, { name: 'Anonymous file', current_title: 'Engineer' })
  database.prepare('INSERT INTO candidate_attachments(id,candidate_id,original_filename,storage_path,mime_type,file_size,sha256,parse_status,parser_version,extracted_text,attachment_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), candidate.id, 'Unity synthetic-filename-marker.pdf', 'anonymous.pdf', 'application/pdf', 1, 'a'.repeat(64), 'parsed', 'anonymous', 'General resume without the queried skill', 'resume', '2026-09-10', '2026-09-10')
  let calls = 0
  const result = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', fields: ['title'], rerankDocuments: async () => { calls++; return [] } })
  assert.equal(result.items.length, 1)
  assert.equal(calls, 0)
  assert.ok(result.degradation.some(row => row.code === 'rerank_source_scope'))
})

test('all candidates without allowed outbound evidence keep local order and never send empty rerank documents', async () => {
  const database = db()
  const candidate = insertCandidate(database, { name: 'Anonymous high only', current_title: 'Engineer' })
  section(database, candidate.id, 'Sensitive', 'Unity synthetic-high-only-marker')
  database.prepare("UPDATE candidate_profile_sections SET sensitivity='high' WHERE candidate_id=?").run(candidate.id)
  let calls = 0
  const result = await hybridSearch(database, { plan: plan([term('Unity')]), query: 'Unity', rerankDocuments: async () => { calls++; return [] } })
  assert.equal(calls, 0)
  assert.equal(result.items[0].candidate_id, candidate.id)
  assert.notEqual(result.completeness.ranking, 'hybrid_reranked')
  assert.ok(result.degradation.some(item => item.code === 'rerank_source_scope'))
})

test('fact-overflow falls back to ANN, rejects excluded and stale sources, and retains duplicate live provenance', async () => {
  const database = db()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anonymous-hybrid-ann-'))
  const store = createVectorStore({ directory, dimensions: 2, model: 'stub', autoCommit: false, maxExactVectors: 1 })
  try {
    const good = insertCandidate(database, { name: 'Anonymous Good', current_title: 'Engineer', years_experience: 5 })
    const blocked = insertCandidate(database, { name: 'Anonymous Blocked', current_title: 'Blocked', years_experience: 5 })
    section(database, good.id, 'Skills', 'Anonymous first engine evidence')
    section(database, good.id, 'Skills', 'Anonymous second engine evidence')
    section(database, blocked.id, 'Skills', 'Anonymous excluded engine evidence')
    const docs = readSearchDocuments(database, { candidateIds: [good.id, blocked.id] }).filter(row => row.source_type === 'profile_section')
    const chunks = docs.flatMap(doc => chunkResumeDocument(doc))
    const goodChunk = chunks.find(row => row.candidate_id === good.id)
    chunks.unshift({ ...goodChunk, id: '000-stale', document_id: 'section:missing', source_hash: 'outdated' })
    store.upsertChunks(chunks, chunks.map(() => [1, 0]))
    const p = plan([{ kind: 'filter', field: 'years', op: 'gte', value: 3 }], { must_not: [{ kind: 'filter', field: 'current_title', op: 'eq', value: 'Blocked' }] })
    const result = await hybridSearch(database, { plan: p, query: 'engine work', queryVector: [1, 0], vectorStore: store, sourceTypes: ['profile_section'] })
    assert.equal(result.completeness.vector.mode, 'ann')
    assert.equal(result.performance.vector_candidates, 1)
    assert.equal(result.items.some(row => row.candidate_id === blocked.id), false)
    assert.ok(result.items.find(row => row.candidate_id === good.id).evidence.some(row => row.match_kind === 'semantic'))
    assert.ok(result.degradation.some(row => row.code === 'vector_stale_sources'))
    const snapshot = result._snapshot
    const again = await hybridSearch(database, { plan: p, query: 'engine work', queryVector: [1, 0], vectorStore: store, sourceTypes: ['profile_section'], snapshot })
    assert.deepEqual(again.completeness, result.completeness)
    assert.deepEqual(again.items, result.items)
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('duplicate provenance cannot exceed the cumulative source budget', async () => {
  const database = db()
  const candidate = insertCandidate(database, { name: 'Anonymous', current_title: 'Engineer' })
  section(database, candidate.id, 'Skills', 'Anonymous software work')
  const doc = readSearchDocuments(database, { candidateIds: [candidate.id] }).find(row => row.source_type === 'profile_section')
  let readRows = 0
  const store = {
    searchQualifiedFacts: () => ({ facts: [{ key: 1, candidate_id: candidate.id, score: 1 }], inspected_facts: 1 }),
    readFactChunks: (_keys, { limit }) => {
      const rows = Array.from({ length: limit }, () => ({ ...doc, id: `row:${readRows++}`, fact_key: 1, start: 0, end: doc.content.length }))
      return { rows, next: `after:${readRows}` }
    }
  }
  const result = await hybridSearch(database, { plan: plan([]), query: 'software', queryVector: [1, 0], vectorStore: store })
  assert.equal(readRows, 12800)
  assert.equal(result.completeness.vector.stop_reason, 'source_budget')
  assert.equal(result.completeness.vector.bounded, true)
  assert.equal(result.performance.vector_candidates, 1)
})

test('an empty intersection with explicit candidate ids cannot admit a vector result', async () => {
  const database = db()
  const allowed = insertCandidate(database, { name: 'Anonymous allowed', current_title: 'Engineer' })
  const outside = insertCandidate(database, { name: 'Anonymous outside', current_title: 'Engineer' })
  section(database, outside.id, 'Skills', 'Anonymous software work')
  const doc = readSearchDocuments(database, { candidateIds: [outside.id] }).find(row => row.source_type === 'profile_section')
  const result = await hybridSearch(database, { plan: plan([]), query: 'software', queryVector: [1, 0], candidateIds: [allowed.id], vectorStore: { search: () => [{ ...doc, start: 0, end: doc.content.length, score: 1 }] } })
  assert.equal(result.performance.vector_candidates, 0)
  assert.equal(result.items.some(row => row.candidate_id === outside.id), false)
})

test('cancellation during ANN prevents provenance and reranking work', async () => {
  const database = db()
  insertCandidate(database, { name: 'Anonymous', current_title: 'Engineer' })
  const controller = new AbortController()
  let rerankCalls = 0
  let sourceCalls = 0
  const store = {
    status: () => ({ max_ann_vectors: 6400 }),
    searchQualifiedFacts: () => { const error = new Error('budget'); error.code = 'search_vector_filter_budget'; throw error },
    searchAnn: () => { controller.abort(); return { facts: [], inspected_facts: 0, index_vectors: 0 } },
    readFactChunks: () => { sourceCalls++; return { rows: [], next: null } }
  }
  await assert.rejects(() => hybridSearch(database, { plan: plan([]), query: 'software', queryVector: [1, 0], vectorStore: store, signal: controller.signal, rerankDocuments: async () => { rerankCalls++; return [] } }), { code: 'search_cancelled' })
  assert.equal(sourceCalls, 0)
  assert.equal(rerankCalls, 0)
})
