import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../server/database.js'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'
import {
  HybridSearchService,
  normalizeHybridInput
} from '../../server/hybrid-search-service.js'
import { randomUUID } from 'node:crypto'
import {
  createVectorStore,
  readSearchDocuments,
  chunkResumeDocument
} from '../../server/search-vector-store.js'

test('POST and GET share candidate-level conditions; option lists paginate independently', async () => {
  const app = createApp({ databasePath: ':memory:' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${server.address().port}`
  const db = app.locals.db
  const search = async (body, method = 'POST') => {
    const r = await fetch(
      `${url}/api/resume-search${method === 'GET' ? `?${new URLSearchParams(body)}` : ''}`,
      {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            }
          : {})
      }
    )
    return { status: r.status, body: await r.json() }
  }
  try {
    insertCandidate(db, {
      name: '匿名甲',
      current_title: '后端工程师',
      years_experience: 2,
      location: '上海'
    })
    const expected = insertCandidate(db, {
      name: '匿名乙',
      current_title: '后端工程师',
      years_experience: 4,
      location: '上海'
    })
    insertCandidate(db, {
      name: '匿名丙',
      current_title: '后端工程师',
      years_experience: 6,
      location: '上海'
    })
    for (const method of ['POST', 'GET']) {
      const r = await search({ q: '找3到5年经验的后端工程师' }, method)
      assert.equal(r.status, 200)
      assert.deepEqual(
        r.body.items.map((i) => i.candidate_id),
        [expected.id]
      )
    }
    const now = new Date().toISOString()
    for (let i = 0; i < 105; i++)
      db.prepare(
        "INSERT INTO talent_pools(id,name,description,color,created_at,updated_at) VALUES(?,?,'','#111111',?,?)"
      ).run(randomUUID(), `匿名分组 ${i}`, now, now)
    const options = await fetch(
      `${url}/api/resume-search/options?kind=talent_pool&page=2&page_size=100`
    ).then((r) => r.json())
    assert.equal(options.items.length, 5)
    assert.equal(options.pagination.total, 105)
    const invalid = await search({ q: 'Unity', plan: { sql: 'SELECT 1' } })
    assert.equal(invalid.status, 400)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    await app.closeDatabase()
  }
})

test('worker pages remain stable and expire after evidence or filter index changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anonymous-hybrid-'))
  const file = join(dir, 'test.db')
  const db = openDatabase(file)
  const service = new HybridSearchService({ databasePath: file })
  try {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      insertCandidate(db, { name: `匿名 ${i}`, current_title: 'Unity 工程师' })
    )
    const first = await service.search({ q: 'Unity', page_size: 2 })
    const second = await service.search({
      q: 'Unity',
      page_size: 2,
      cursor: first.pagination.next_cursor
    })
    assert.equal(second.pagination.page, 2)
    assert.equal(
      new Set([...first.items, ...second.items].map((x) => x.candidate_id))
        .size,
      4
    )
    assert.deepEqual(
      (
        await service.search({
          q: 'Unity',
          page_size: 2,
          cursor: first.pagination.next_cursor
        })
      ).items,
      second.items
    )
    const back = await service.search({
      q: 'Unity',
      page_size: 2,
      cursor: first.pagination.current_cursor
    })
    assert.deepEqual(back.items, first.items)
    assert.equal(
      back.degradation.filter((d) => d.stage === 'planning').length,
      1
    )
    db.prepare('UPDATE candidates SET current_title=? WHERE id=?').run(
      'Unreal 工程师',
      candidates[0].id
    )
    await assert.rejects(
      service.search({
        q: 'Unity',
        page_size: 2,
        cursor: second.pagination.next_cursor
      }),
      { code: 'search_cursor_stale' }
    )
  } finally {
    await service.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy filter aliases and archived false retain their original hard constraints', async () => {
  const db = openDatabase(':memory:')
  const service = new HybridSearchService({ db })
  try {
    insertCandidate(db, {
      name: '匿名在职',
      current_title: '后端工程师',
      years_experience: 4
    })
    const archived = insertCandidate(db, {
      name: '匿名归档',
      current_title: '后端工程师',
      years_experience: 4
    })
    db.prepare("UPDATE candidates SET archived_at='2026-09-10' WHERE id=?").run(
      archived.id
    )
    const response = await service.search({
      q: '后端工程师',
      minYears: 3,
      maxYears: 5,
      include_archived: 'false',
      fieldPaths: 'candidate_resume_documents.content',
      pageSize: 1
    })
    assert.equal(response.pagination.total, 1)
    assert.equal(response.pagination.page_size, 1)
    assert.ok(response.items.every((i) => i.candidate_id !== archived.id))
    assert.equal(
      normalizeHybridInput({ q: 'Unity', fields: '' }).fields.length,
      0
    )
    assert.throws(() => normalizeHybridInput({ q: 'Unity', filters: [] }), {
      code: 'invalid_query'
    })
  } finally {
    await service.close()
    db.close()
  }
})

test('field and source filters apply to both evidence and qualification', async () => {
  const db = openDatabase(':memory:')
  const service = new HybridSearchService({ db })
  try {
    const c = insertCandidate(db, {
      name: '匿名来源',
      current_title: '后端工程师'
    })
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) VALUES(?,?,'project','Unity 项目','负责战斗系统',?,?)"
    ).run(randomUUID(), c.id, now, now)
    const title = await service.search({
      q: 'Unity',
      fields: ['title'],
      source_types: ['profile_section']
    })
    assert.equal(title.items.length, 1)
    assert.equal(
      (await service.search({ q: 'Unity', fields: ['content'] })).items.length,
      0
    )
    assert.equal(
      (await service.search({ q: 'Unity', source_types: ['attachment'] })).items
        .length,
      0
    )
  } finally {
    await service.close()
    db.close()
  }
})

test('stage and evidence count remain effective business filters', async () => {
  const db = openDatabase(':memory:')
  const service = new HybridSearchService({ db })
  try {
    const c = insertCandidate(db, {
      name: '匿名阶段',
      current_title: 'Unity 工程师'
    })
    insertCandidate(db, { name: '匿名其他阶段', current_title: 'Unity 工程师' })
    db.prepare('UPDATE candidates SET stage=? WHERE id=?').run('面试中', c.id)
    db.prepare(
      "INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) VALUES('stage-proof',?,'project','项目','Unity 战斗系统','2026-09-10','2026-09-10')"
    ).run(c.id)
    const r = await service.search({
      q: 'Unity',
      stage: '面试中',
      evidence_limit: 1
    })
    assert.deepEqual(
      r.items.map((i) => i.candidate_id),
      [c.id]
    )
    assert.equal(r.items[0].evidence.length, 1)
  } finally {
    await service.close()
    db.close()
  }
})

test('same dimensions cannot mix different embedding models', async () => {
  const db = openDatabase(':memory:')
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-model-space-'))
  let writer
  const services = []
  try {
    const c = insertCandidate(db, {
      name: '匿名向量空间',
      current_title: 'Unity 工程师'
    })
    const doc = readSearchDocuments(db, { candidateIds: [c.id] })[0]
    const chunks = chunkResumeDocument(doc)
    writer = createVectorStore({
      directory,
      model: 'anonymous-model-v2',
      dimensions: 1024
    })
    writer.upsertChunks(
      chunks,
      chunks.map(() =>
        Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
      )
    )
    writer.close()
    writer = null
    let embeds = 0
    const adapters = {
      configured: { planner: false, embedding: true, rerank: false },
      embedTexts: async () => {
        embeds++
        return [Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))]
      }
    }
    const make = (model) => {
      const s = new HybridSearchService({
        db,
        vectorDirectory: directory,
        remoteEnabled: true,
        modelConfig: { embeddingModel: model },
        adapters
      })
      services.push(s)
      return s
    }
    const mismatch = await make('text-embedding-v4').search({ q: 'Unity' })
    assert.equal(embeds, 0)
    assert.ok(mismatch.degradation.some((d) => d.code === 'vector_not_ready'))
    const matching = await make('anonymous-model-v2').search({ q: 'Unity' })
    assert.equal(embeds, 1)
    assert.equal(matching.performance.vector_candidates, 1)
  } finally {
    writer?.close()
    for (const s of services) await s.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('agent vector capability follows live hybrid status without treating configuration as readiness', async () => {
  let ready = false
  const service = { status: () => ({ model: { remote_enabled: true, embedding: true }, vector: { available: ready, loaded: ready, current: true } }), close: async () => {} }
  const app = createApp({ databasePath: ':memory:', hybridSearchService: service })
  try {
    assert.equal(app.locals.agent.status().vector_search.enabled, false)
    ready = true
    assert.equal(app.locals.agent.status().vector_search.enabled, true)
    assert.equal(app.locals.agent.status().vector_search.reason, null)
  } finally { await app.closeDatabase() }
})
