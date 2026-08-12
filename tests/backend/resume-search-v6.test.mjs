import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import {
  normalizeResumeSearch,
  ResumeSearchError,
  searchCandidateResumes,
  searchCandidateResumesReadonly
} from '../../server/resume-search.js'
import { ReadonlyQueryError } from '../../server/readonly-query.js'

const databases = []

afterEach(() => {
  while (databases.length) databases.pop().close()
})

function anonymousDatabase() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}

function addSection(db, candidateId, sectionType, title, content) {
  const timestamp = new Date().toISOString()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO candidate_profile_sections(
      id, candidate_id, section_type, title, content, structured_data,
      sort_order, sensitivity, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 0, 'internal', ?, ?)
  `).run(id, candidateId, sectionType, title, content, timestamp, timestamp)
  return id
}

function addAttachment(db, candidateId, content) {
  const timestamp = new Date().toISOString()
  db.prepare(`
    INSERT INTO candidate_attachments(
      id, candidate_id, original_filename, storage_path, mime_type, file_size,
      sha256, attachment_type, parse_status, parser_version, extracted_text,
      source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resume', 'parsed', 'test-parser', ?, 'anonymous_test', ?, ?)
  `).run(
    randomUUID(), candidateId, 'anonymous-resume.pdf', `anonymous/${randomUUID()}.pdf`,
    'application/pdf', 128, randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    content, timestamp, timestamp
  )
}

test('FTS5 search aggregates concepts and evidence across a candidate without duplicate candidates', () => {
  const db = anonymousDatabase()
  const matching = insertCandidate(db, {
    name: 'Anonymous Unity Candidate',
    current_title: 'Unity3D Engineer',
    location: '上海',
    years_experience: 5
  })
  addSection(db, matching.id, 'project', 'Launch record', 'Delivered an overseas mobile project for global users.')
  addAttachment(db, matching.id, 'Unity rendering and performance optimization portfolio.')

  const partial = insertCandidate(db, {
    name: 'Anonymous Partial Candidate',
    current_title: 'Unity Engineer',
    location: '上海',
    years_experience: 8
  })
  addSection(db, partial.id, 'project', 'Domestic project', 'Delivered a local mobile application.')

  const result = searchCandidateResumes(db, {
    keywords: ['unity', 'overseas'],
    archived: 'exclude'
  })

  assert.equal(result.pagination.total, 1)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].candidate_id, matching.id)
  assert.equal(new Set(result.items.map((item) => item.candidate_id)).size, 1)
  assert.ok(result.items[0].score > 0)
  assert.ok(result.items[0].bm25_score < 0)
  assert.ok(result.items[0].matched_fields.includes('候选人主档'))
  assert.ok(result.items[0].matched_fields.includes('履历区块'))
  assert.ok(result.items[0].snippets.some((snippet) => /Unity/i.test(snippet)))
  assert.ok(result.items[0].snippets.some((snippet) => /overseas/i.test(snippet)))
  const overseasEvidence = result.items[0].evidence.find((item) => (
    item.field_path === 'candidate_profile_sections.content'
  ))
  assert.ok(overseasEvidence)
  assert.ok(overseasEvidence.matched_actual_terms.includes('overseas'))
  assert.ok(overseasEvidence.snippet.literal_matches.some((match) => match.actual_term === 'overseas'))
  assert.ok(overseasEvidence.snippet.highlights.some((highlight) => highlight.actual_terms.includes('overseas')))
  assert.ok(result.items[0].reasons.some((reason) => reason.includes('海外项目')))
})

test('natural-language query extracts years and location while archived scope stays explicit', () => {
  const db = anonymousDatabase()
  const active = insertCandidate(db, {
    name: 'Anonymous Active Candidate',
    current_title: 'Unity Engineer',
    location: '上海',
    years_experience: 4
  })
  addSection(db, active.id, 'project', 'Global project', 'Worked on an overseas game launch.')

  const tooJunior = insertCandidate(db, {
    name: 'Anonymous Junior Candidate',
    current_title: 'Unity Engineer',
    location: '上海',
    years_experience: 2
  })
  addSection(db, tooJunior.id, 'project', 'Global project', 'Worked on an overseas game launch.')

  const archived = insertCandidate(db, {
    name: 'Anonymous Archived Candidate',
    current_title: 'Unity Engineer',
    location: '上海',
    years_experience: 7,
    archived_at: new Date().toISOString()
  })
  addSection(db, archived.id, 'project', 'Global project', 'Worked on an overseas game launch.')

  const query = '帮我找有三年以上 Unity 经验、做过海外项目、目前在上海的人'
  const normalized = normalizeResumeSearch({ q: query, archived: 'exclude' })
  assert.equal(normalized.min_years, 3)
  assert.equal(normalized.location, '上海')

  const activeOnly = searchCandidateResumes(db, { q: query, archived: 'exclude' })
  assert.deepEqual(activeOnly.items.map((item) => item.candidate_id), [active.id])
  assert.equal(activeOnly.query.filters.min_years, 3)
  assert.equal(activeOnly.query.filters.location, '上海')

  const archivedOnly = searchCandidateResumes(db, { q: query, archived: 'only' })
  assert.deepEqual(archivedOnly.items.map((item) => item.candidate_id), [archived.id])
})

test('any-mode, structured filters and source filters remain candidate-scoped', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous Filtered Candidate',
    current_title: 'Platform Engineer',
    location: '杭州',
    years_experience: 6,
    stage: '筛选中'
  })
  addAttachment(db, candidate.id, 'Machine learning platform for international customers.')

  const missBySource = searchCandidateResumes(db, {
    keywords: ['machine learning', 'Unity'],
    match_mode: 'any',
    source_types: ['profile_section'],
    location: '杭州',
    min_years: 5
  })
  assert.equal(missBySource.pagination.total, 0)

  const hit = searchCandidateResumes(db, {
    keywords: ['machine learning', 'Unity'],
    match_mode: 'any',
    source_types: ['attachment'],
    location: '杭州',
    min_years: 5,
    stage: '筛选中'
  })
  assert.deepEqual(hit.items.map((item) => item.candidate_id), [candidate.id])
  assert.deepEqual(hit.items[0].matched_fields, ['附件简历'])
  assert.ok(hit.items[0].reasons.some((reason) => reason.includes('机器学习')))
})

test('exact resume fields distinguish document titles from content', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous Exact Field Candidate',
    current_title: 'Platform Engineer'
  })
  addSection(db, candidate.id, 'project', 'TitleOnlyMarkerV10', 'ContentOnlyMarkerV10')

  const titleHit = searchCandidateResumes(db, {
    q: 'TitleOnlyMarkerV10',
    fields: ['candidate_resume_documents.title']
  })
  assert.deepEqual(titleHit.items.map((item) => item.candidate_id), [candidate.id])
  assert.equal(titleHit.items[0].evidence[0].field_path, 'candidate_resume_documents.title')

  const titleMiss = searchCandidateResumes(db, {
    q: 'ContentOnlyMarkerV10',
    fields: ['title']
  })
  assert.equal(titleMiss.pagination.total, 0)

  const contentHit = searchCandidateResumes(db, {
    q: 'ContentOnlyMarkerV10',
    fields: ['content'],
    source_types: ['profile_section']
  })
  assert.deepEqual(contentHit.items.map((item) => item.candidate_id), [candidate.id])
  assert.equal(contentHit.items[0].evidence[0].field_path, 'candidate_profile_sections.content')
})

test('quoted q and phrases preserve exact FTS phrase semantics', () => {
  const db = anonymousDatabase()
  const exact = insertCandidate(db, {
    name: 'Anonymous Exact Phrase Candidate',
    current_title: 'distributed systems engineer'
  })
  insertCandidate(db, {
    name: 'Anonymous Separated Terms Candidate',
    current_title: 'distributed reliable systems engineer'
  })

  const quoted = searchCandidateResumes(db, { q: '"distributed systems"' })
  assert.deepEqual(quoted.items.map((item) => item.candidate_id), [exact.id])

  const explicit = searchCandidateResumes(db, { phrases: ['distributed systems'] })
  assert.deepEqual(explicit.items.map((item) => item.candidate_id), [exact.id])
})

test('position and talent-pool filters constrain otherwise equivalent resume matches', () => {
  const db = anonymousDatabase()
  const timestamp = new Date().toISOString()
  const scoped = insertCandidate(db, {
    name: 'Anonymous Scoped Candidate',
    current_title: 'ResumeScopeMarkerV10'
  })
  insertCandidate(db, {
    name: 'Anonymous Unscoped Candidate',
    current_title: 'ResumeScopeMarkerV10'
  })
  const positionId = randomUUID()
  const poolId = randomUUID()
  db.prepare(`
    INSERT INTO positions(id, title, headcount, status, tags, created_at, updated_at)
    VALUES (?, 'Anonymous scoped role', 1, 'open', '[]', ?, ?)
  `).run(positionId, timestamp, timestamp)
  db.prepare(`
    INSERT INTO talent_pools(id, name, color, created_at, updated_at)
    VALUES (?, ?, '#2563eb', ?, ?)
  `).run(poolId, `Anonymous scoped pool ${poolId}`, timestamp, timestamp)
  db.prepare(`INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, ?, ?)`)
    .run(scoped.id, positionId, timestamp)
  db.prepare(`INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, ?, ?)`)
    .run(scoped.id, poolId, timestamp)

  const byPosition = searchCandidateResumes(db, { q: 'ResumeScopeMarkerV10', position_id: positionId })
  assert.deepEqual(byPosition.items.map((item) => item.candidate_id), [scoped.id])
  const byPool = searchCandidateResumes(db, { q: 'ResumeScopeMarkerV10', talent_pool_id: poolId })
  assert.deepEqual(byPool.items.map((item) => item.candidate_id), [scoped.id])
})

test('pagination is stable, capped at 100 rows, and preserves total candidate count', () => {
  const db = anonymousDatabase()
  for (let index = 0; index < 23; index += 1) {
    insertCandidate(db, {
      name: `Anonymous Search Candidate ${String(index).padStart(2, '0')}`,
      current_title: 'TypeScript Engineer',
      years_experience: index % 10
    })
  }

  const first = searchCandidateResumes(db, { q: 'TypeScript', page: 1, page_size: 10 })
  const third = searchCandidateResumes(db, { q: 'TypeScript', page: 3, page_size: 10 })
  assert.equal(first.items.length, 10)
  assert.equal(first.pagination.total, 23)
  assert.equal(first.pagination.total_pages, 3)
  assert.equal(third.items.length, 3)
  assert.equal(third.pagination.total, 23)
  assert.equal(new Set([...first.items, ...third.items].map((item) => item.candidate_id)).size, 13)

  assert.throws(
    () => searchCandidateResumes(db, { q: 'TypeScript', page_size: 101 }),
    (error) => error instanceof ResumeSearchError && error.code === 'invalid_query'
  )
})

test('HTTP boolean query strings normalize without weakening validation', () => {
  const normalized = normalizeResumeSearch({
    q: 'TypeScript',
    fast: 'true',
    include_total: 'false'
  })
  assert.equal(normalized.fast, true)
  assert.equal(normalized.include_total, false)

  assert.throws(
    () => normalizeResumeSearch({ q: 'TypeScript', fast: 'yes' }),
    (error) => error instanceof ResumeSearchError && error.code === 'invalid_query'
  )
})

test('FTS input is quoted and a missing FTS5 index fails closed', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous Injection Candidate',
    current_title: 'Unity Engineer'
  })

  const result = searchCandidateResumes(db, { keywords: ['Unity" OR *'] })
  assert.equal(result.pagination.total, 0)

  db.exec('DROP TABLE candidate_resume_fts')
  assert.throws(
    () => searchCandidateResumes(db, { q: 'Unity' }),
    (error) => error instanceof ResumeSearchError && error.code === 'fts5_unavailable' && error.status === 503
  )
  assert.ok(candidate.id)
})

test('read-only worker timeouts preserve their status and safe audit details', async () => {
  const readonly = {
    async executeReadonlyQuery() {
      throw new ReadonlyQueryError('query_timeout', 'Read-only query exceeded its timeout.', {
        status: 408,
        audit: { execution_ms: 15_000, rows_returned: 0 }
      })
    }
  }

  await assert.rejects(
    searchCandidateResumesReadonly(readonly, { keywords: ['Anonymous'], fast: true }),
    (error) => error instanceof ResumeSearchError
      && error.code === 'query_timeout'
      && error.status === 408
      && error.details?.audit?.execution_ms === 15_000
  )
})
