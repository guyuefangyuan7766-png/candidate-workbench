import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import { normalizeResumeSearch } from '../../server/resume-search.js'
import {
  BUSINESS_SEARCH_INTERNALS,
  BusinessSearchError,
  backfillBusinessSearch,
  buildAllRecordEvidencePlan,
  buildAllRecordsPlans,
  buildBusinessCandidatePlans,
  buildBusinessCandidateEvidencePlan,
  compactBusinessSearchFts,
  explainBusinessSearchStaleCleanup,
  flushBusinessSearchDirty,
  getBusinessSearchFieldCatalog,
  getBusinessSearchCoverage,
  assertBusinessSearchReady,
  isBusinessSearchReady,
  isBusinessSearchFtsCompact,
  isInternalSearchSchemaObject,
  isInternalSearchTool,
  isReadonlyBusinessColumn,
  isReadonlyBusinessTable,
  isRestrictedResultColumn,
  migrateBusinessSearch,
  queueBusinessSearchBackfill,
  searchAllRecords,
  searchBusinessCandidates
} from '../../server/business-search.js'

const databases = []

afterEach(() => {
  while (databases.length) databases.pop().close()
})

function anonymousDatabase() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}

function addIndexedDocument(db, {
  documentId,
  entityType,
  entityId,
  candidateId = null,
  sourceTable,
  sourceRowId = documentId,
  fieldPath,
  content,
  searchText = content,
  archivedAt = null
}) {
  const timestamp = now()
  const normalized = content.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
  db.prepare(`
    INSERT INTO search_documents_v2(
      document_id, entity_type, entity_id, candidate_id,
      source_table, source_row_id, field_path,
      segment_index, segment_count, char_start, char_end,
      title, content, normalized_content, search_text,
      archived_at, source_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    documentId,
    entityType,
    entityId,
    candidateId,
    sourceTable,
    sourceRowId,
    fieldPath,
    Array.from(content).length,
    fieldPath,
    content,
    normalized,
    searchText,
    archivedAt,
    timestamp,
    timestamp,
    timestamp
  )
}

function now() {
  return new Date().toISOString()
}

function addSourceRecord(db, candidateId, rawPayload, sourceRecordId = randomUUID()) {
  const timestamp = now()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO candidate_source_records(
      id, candidate_id, source_system, source_record_id, record_type,
      source_name, source_timestamp, raw_payload, sensitivity, created_at, updated_at
    ) VALUES (?, ?, 'anonymous-test', ?, 'candidate', 'Anonymous fixture', ?, ?, 'high', ?, ?)
  `).run(id, candidateId, sourceRecordId, timestamp, JSON.stringify(rawPayload), timestamp, timestamp)
  return id
}

function addAttachment(db, candidateId, { storagePath, extractedText }) {
  const timestamp = now()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO candidate_attachments(
      id, candidate_id, original_filename, storage_path, mime_type, file_size,
      sha256, attachment_type, parse_status, parser_version, extracted_text,
      source, created_at, updated_at
    ) VALUES (?, ?, 'anonymous-resume.pdf', ?, 'application/pdf', 256, ?,
      'resume', 'parsed', 'anonymous-parser', ?, 'anonymous_test', ?, ?)
  `).run(
    id,
    candidateId,
    storagePath,
    randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    extractedText,
    timestamp,
    timestamp
  )
  return id
}

function addPositionAndPool(db, candidateId, marker) {
  const timestamp = now()
  const positionId = randomUUID()
  const poolId = randomUUID()
  db.prepare(`
    INSERT INTO positions(
      id, title, department, location, owner, headcount, status, description,
      tags, created_at, updated_at, archived_at
    ) VALUES (?, 'Anonymous role', 'Engineering', 'Remote', 'Anonymous owner', 1,
      'open', ?, '[]', ?, ?, NULL)
  `).run(positionId, `${marker} position evidence`, timestamp, timestamp)
  db.prepare(`
    INSERT INTO talent_pools(
      id, name, description, color, source_system, source_record_id,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, '#2563eb', NULL, NULL, ?, ?, NULL)
  `).run(poolId, `Anonymous pool ${poolId}`, `${marker} talent pool evidence`, timestamp, timestamp)
  db.prepare(`INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, ?, ?)`)
    .run(candidateId, positionId, timestamp)
  db.prepare(`INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, ?, ?)`)
    .run(candidateId, poolId, timestamp)
  return { positionId, poolId }
}

test('V8 business search migration is additive, idempotent and preserves the legacy resume FTS', () => {
  const db = anonymousDatabase()
  const legacySql = db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'candidate_resume_fts'`).get().sql
  const candidateColumns = db.prepare(`PRAGMA table_xinfo(candidates)`).all().map((column) => column.name)

  assert.deepEqual(migrateBusinessSearch(db), { version: 8, migrated: true })
  assert.deepEqual(migrateBusinessSearch(db), { version: 8, migrated: true })

  for (const table of Object.values(BUSINESS_SEARCH_INTERNALS)) {
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = ?`).get(table), `${table} must exist`)
  }
  assert.equal(db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'candidate_resume_fts'`).get().sql, legacySql)
  assert.deepEqual(db.prepare(`PRAGMA table_xinfo(candidates)`).all().map((column) => column.name), candidateColumns)
})

test('backfill indexes searchable business fields including numbers, dates, external IDs and nested raw payload paths', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous Full Field Candidate',
    phone: '13800000017',
    email: 'anonymous17@example.test',
    birth_date: '1988-04-17',
    age: 38,
    expected_salary: '42000 CNY',
    source_system: 'anonymous-test',
    source_record_id: 'APPLICANT-ANON-017'
  })
  const sourceId = addSourceRecord(db, candidate.id, {
    identity: { legacy_code: 'NESTED-CODE-771' },
    skills: ['Unity', 'TypeScript'],
    availability: null
  })

  const result = backfillBusinessSearch(db, { batchSize: 25 })
  assert.equal(result.coverage.status, 'ready')
  assert.equal(isBusinessSearchReady(db), true)
  const phoneCoverage = result.coverage.fields.find((field) => field.field_path === 'candidates.phone')
  assert.deepEqual(
    {
      source_value_rows: phoneCoverage.source_value_rows,
      indexed_rows: phoneCoverage.indexed_rows,
      status: phoneCoverage.status
    },
    { source_value_rows: 1, indexed_rows: 1, status: 'ready' }
  )
  assert.equal(result.coverage.totals.field_count, result.coverage.totals.ready_field_count)

  const candidateFields = new Map(db.prepare(`
    SELECT field_path, content FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table = 'candidates' AND source_row_id = ?
  `).all(candidate.id).map((row) => [row.field_path, row.content]))
  assert.equal(candidateFields.get('candidates.phone'), '13800000017')
  assert.equal(candidateFields.get('candidates.email'), 'anonymous17@example.test')
  assert.equal(candidateFields.get('candidates.birth_date'), '1988-04-17')
  assert.equal(candidateFields.get('candidates.age'), '38')
  assert.equal(candidateFields.get('candidates.source_record_id'), 'APPLICANT-ANON-017')

  const nested = db.prepare(`
    SELECT content FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table = 'candidate_source_records' AND source_row_id = ?
      AND field_path = 'candidate_source_records.raw_payload.identity.legacy_code'
  `).get(sourceId)
  assert.equal(nested.content, 'NESTED-CODE-771')

  const sensitiveHit = searchBusinessCandidates(db, normalizeResumeSearch({ keywords: ['13800000017'] }))
  assert.deepEqual(sensitiveHit.items.map((item) => item.candidate_id), [candidate.id])
  assert.equal(sensitiveHit.items[0].evidence[0].field_path, 'candidates.phone')
  assert.equal(sensitiveHit.items[0].evidence[0].snippet.text, '13800000017')

  const nestedHit = searchAllRecords(db, { keywords: ['NESTED-CODE-771'] })
  assert.ok(nestedHit.items.some((item) => item.entity_type === 'candidate_source_record' && item.entity_id === sourceId))
  assert.ok(nestedHit.items.flatMap((item) => item.evidence).some((item) => (
    item.field_path === 'candidate_source_records.raw_payload.identity.legacy_code' &&
    item.matched_terms.includes('NESTED-CODE-771')
  )))
})

test('compact policy omits technical columns and deduplicates equivalent JSON leaves without losing exact structured search', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous compact candidate',
    current_title: 'ExactStructuredMarkerV8',
    source_system: 'anonymous-test',
    source_record_id: 'VISIBLE-SOURCE-ID-V8'
  })
  const sourceId = addSourceRecord(db, candidate.id, {
    a_primary_status: 'RepeatedJsonMarkerV8',
    source_system: 'anonymous-test',
    status_history: ['RepeatedJsonMarkerV8', 'RepeatedJsonMarkerV8'],
    z_duplicate_status: 'RepeatedJsonMarkerV8'
  })

  const backfill = backfillBusinessSearch(db, { batchSize: 25 })
  assert.equal(backfill.coverage.status, 'ready')
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM search_documents_v2
    WHERE field_path IN ('candidates.id', 'candidates.created_at', 'candidates.updated_at')
  `).get().count), 0)
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM search_documents_v2
    WHERE source_table = 'candidate_source_records' AND source_row_id = ?
      AND normalized_content = 'repeatedjsonmarkerv8'
  `).get(sourceId).count), 1)
  assert.equal(db.prepare(`
    SELECT field_path FROM search_documents_v2
    WHERE source_table = 'candidate_source_records' AND source_row_id = ?
      AND normalized_content = 'repeatedjsonmarkerv8'
  `).get(sourceId).field_path, 'candidate_source_records.raw_payload.a_primary_status')
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM search_documents_v2
    WHERE source_table = 'candidate_source_records' AND source_row_id = ?
      AND field_path = 'candidate_source_records.raw_payload.source_system'
  `).get(sourceId).count), 0)

  const exact = searchAllRecords(db, {
    keywords: ['VISIBLE-SOURCE-ID-V8'],
    field_path: 'candidates.source_record_id'
  })
  assert.deepEqual(exact.items.map((item) => item.entity_id), [candidate.id])
  const repeated = searchAllRecords(db, { keywords: ['RepeatedJsonMarkerV8'] })
  assert.ok(repeated.items.flatMap((item) => item.evidence).some((item) => (
    item.field_path === 'candidate_source_records.raw_payload.a_primary_status'
  )))
})

test('single-field refresh writes only changed postings and replay is a no-op', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous diff candidate',
    current_title: 'BeforeDiffMarkerV8',
    phone: '13800000019'
  })
  backfillBusinessSearch(db)
  const firstCount = Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2').get().count)

  db.prepare('UPDATE candidates SET current_title = ? WHERE id = ?').run('AfterDiffMarkerV8', candidate.id)
  const refreshed = flushBusinessSearchDirty(db, { limit: 10 })
  assert.equal(refreshed.written_documents, 1)
  assert.equal(refreshed.removed_documents, 0)
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2').get().count), firstCount)

  const replay = backfillBusinessSearch(db, { batchSize: 25 })
  assert.equal(replay.written_documents, 0)
  assert.equal(replay.removed_documents, 0)
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2').get().count), firstCount)
})

test('bounded queue resumes from its durable keyset cursor and replay stays stable', () => {
  const db = anonymousDatabase()
  const timestamp = now()
  const insert = db.prepare(`
    INSERT INTO candidates(id, name, stage, tags, created_at, updated_at)
    VALUES (?, ?, '新候选人', '[]', ?, ?)
  `)
  for (let index = 1; index <= 5; index += 1) {
    const id = `resume-cursor-${String(index).padStart(3, '0')}`
    insert.run(id, `Anonymous resume cursor ${index}`, timestamp, timestamp)
  }
  db.exec(`DELETE FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`)
  const queueFirst = db.prepare(`
    INSERT INTO ${BUSINESS_SEARCH_INTERNALS.dirtyTable}(
      source_table, source_row_id, reason, queued_at, attempts, last_error
    ) VALUES ('candidates', ?, 'backfill', ?, 0, NULL)
  `)
  queueFirst.run('resume-cursor-001', timestamp)
  queueFirst.run('resume-cursor-002', timestamp)
  db.prepare(`
    UPDATE ${BUSINESS_SEARCH_INTERNALS.checkpointTable}
    SET status = 'queued', queue_table = 'candidates', queue_cursor = ?,
        queued_rows = 2, processed_rows = 0, started_at = ?, updated_at = ?
    WHERE scope = 'full'
  `).run(JSON.stringify(['resume-cursor-002']), timestamp, timestamp)

  const queued = queueBusinessSearchBackfill(db, { batchSize: 2 })
  const candidateQueue = db.prepare(`
    SELECT source_row_id FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}
    WHERE source_table = 'candidates' AND source_row_id LIKE 'resume-cursor-%'
    ORDER BY source_row_id
  `).all().map((row) => row.source_row_id)
  assert.deepEqual(candidateQueue, [1, 2, 3, 4, 5].map((index) => `resume-cursor-${String(index).padStart(3, '0')}`))
  assert.ok(queued.queued_rows >= 5)
  assert.deepEqual({ ...db.prepare(`
    SELECT queue_table, queue_cursor FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable}
    WHERE scope = 'full'
  `).get() }, { queue_table: null, queue_cursor: null })

  while (flushBusinessSearchDirty(db, { limit: 2 }).remaining_rows > 0) {}
  const firstCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count)
  const replay = backfillBusinessSearch(db, { batchSize: 2 })
  assert.equal(replay.written_documents, 0)
  assert.equal(replay.removed_documents, 0)
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count), firstCount)
})

test('full backfill purges legacy documents for non-searchable relation tables', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, { name: 'Anonymous compatibility cleanup candidate' })
  const { positionId, poolId } = addPositionAndPool(db, candidate.id, 'CompatibilityCleanupMarkerV8')
  const positionRowId = JSON.stringify([candidate.id, positionId])
  const poolRowId = JSON.stringify([candidate.id, poolId])
  const timestamp = now()

  // These rows model the field-level relation documents produced by an older
  // searchable policy.  Current policies intentionally keep the relations
  // readable in business tables but do not index them.
  for (let index = 0; index < 5; index += 1) {
    addIndexedDocument(db, {
      documentId: `legacy-candidate-position-${index}`,
      entityType: 'candidate_position',
      entityId: positionId,
      candidateId: candidate.id,
      sourceTable: 'candidate_positions',
      sourceRowId: positionRowId,
      fieldPath: `candidate_positions.legacy_${index}`,
      content: `legacy relation position ${index}`
    })
    addIndexedDocument(db, {
      documentId: `legacy-candidate-pool-${index}`,
      entityType: 'candidate_talent_pool',
      entityId: poolId,
      candidateId: candidate.id,
      sourceTable: 'candidate_talent_pools',
      sourceRowId: poolRowId,
      fieldPath: `candidate_talent_pools.legacy_${index}`,
      content: `legacy relation pool ${index}`
    })
  }
  db.prepare(`
    INSERT INTO ${BUSINESS_SEARCH_INTERNALS.dirtyTable}(
      source_table, source_row_id, reason, queued_at, attempts, last_error
    ) VALUES (?, ?, 'legacy', ?, 0, NULL), (?, ?, 'legacy', ?, 0, NULL)
  `).run('candidate_positions', positionRowId, timestamp, 'candidate_talent_pools', poolRowId, timestamp)

  const before = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count)
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table IN ('candidate_positions', 'candidate_talent_pools')
  `).get().count), 10)
  const queued = queueBusinessSearchBackfill(db, { batchSize: 2 })

  assert.equal(queued.non_searchable_documents_deleted, 10)
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table IN ('candidate_positions', 'candidate_talent_pools')
  `).get().count), 0)
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.ftsTable} f
    JOIN ${BUSINESS_SEARCH_INTERNALS.documentsTable} d ON d.row_id = f.rowid
    WHERE d.source_table IN ('candidate_positions', 'candidate_talent_pools')
  `).get().count), 0)
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}
    WHERE source_table IN ('candidate_positions', 'candidate_talent_pools')
  `).get().count), 0)

  while (flushBusinessSearchDirty(db, { limit: 2 }).remaining_rows > 0) {}
  const firstCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count)
  const checkpoint = db.prepare(`
    SELECT status, document_count, queue_table, queue_cursor
    FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable} WHERE scope = 'full'
  `).get()
  assert.equal(Number(checkpoint.document_count), firstCount)
  assert.deepEqual({ queue_table: checkpoint.queue_table, queue_cursor: checkpoint.queue_cursor }, {
    queue_table: null,
    queue_cursor: null
  })

  const replay = backfillBusinessSearch(db, { batchSize: 2 })
  assert.equal(replay.written_documents, 0)
  assert.equal(replay.removed_documents, 0)
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count), firstCount)
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.ftsTable}`).get().count), firstCount)
})

test('stale cleanup probes business rows through primary and composite indexes', () => {
  const db = anonymousDatabase()
  const details = (sourceTable) => explainBusinessSearchStaleCleanup(db, sourceTable)
    .map((row) => String(row.detail ?? '')).join('\n')
  const single = details('candidates')
  assert.match(single, /SEARCH source USING .*\(id=\?\)/)
  assert.doesNotMatch(single, /SCAN source|USE TEMP B-TREE/)

  const composite = details('candidate_positions')
  assert.match(composite, /SEARCH source USING .*\(candidate_id=\? AND position_id=\?\)/)
  assert.doesNotMatch(composite, /SCAN source|USE TEMP B-TREE/)
})

test('legacy metadata-copy FTS compacts in resumable bounded batches', () => {
  const db = anonymousDatabase()
  insertCandidate(db, { name: 'Anonymous compact FTS candidate', current_title: 'CompactFtsMarkerV8' })
  backfillBusinessSearch(db)
  const expected = Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2').get().count)

  db.exec(`
    DROP TRIGGER search_documents_v2_ai;
    DROP TRIGGER search_documents_v2_au;
    DROP TRIGGER search_documents_v2_ad;
    DROP TABLE search_documents_v2_fts;
    CREATE VIRTUAL TABLE search_documents_v2_fts USING fts5(
      document_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED,
      candidate_id UNINDEXED, source_table UNINDEXED, source_row_id UNINDEXED,
      field_path UNINDEXED, title, search_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    INSERT INTO search_documents_v2_fts(
      rowid, document_id, entity_type, entity_id, candidate_id,
      source_table, source_row_id, field_path, title, search_text
    ) SELECT row_id, document_id, entity_type, entity_id, candidate_id,
      source_table, source_row_id, field_path, title, search_text
      FROM search_documents_v2;
  `)
  assert.equal(isBusinessSearchFtsCompact(db), false)
  const partial = compactBusinessSearchFts(db, { batchSize: 2, maxBatches: 1 })
  assert.equal(partial.status, 'indexing')
  assert.equal(partial.processed_rows, 2)
  assert.equal(partial.remaining_rows, expected - 2)

  let completed
  do {
    completed = compactBusinessSearchFts(db, { batchSize: 7, maxBatches: 1 })
  } while (completed.status !== 'ready')
  assert.equal(isBusinessSearchFtsCompact(db), true)
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2_fts').get().count), expected)
  assert.ok(searchAllRecords(db, { keywords: ['CompactFtsMarkerV8'] }).items.length > 0)

  const replay = compactBusinessSearchFts(db, { batchSize: 2, maxBatches: 1 })
  assert.equal(replay.already_compact, true)
  assert.equal(replay.processed_rows, 0)
})

test('long JSON values are deterministically segmented without truncation and backfill is idempotent', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, { name: 'Anonymous Long Resume Candidate' })
  const biography = `${'界'.repeat(8_250)} terminal-anchor-v8`
  const sourceId = addSourceRecord(db, candidate.id, { profile: { biography } })

  backfillBusinessSearch(db, { batchSize: 50 })
  const segments = db.prepare(`
    SELECT document_id, segment_index, segment_count, char_start, char_end, content
    FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table = 'candidate_source_records' AND source_row_id = ?
      AND field_path = 'candidate_source_records.raw_payload.profile.biography'
    ORDER BY segment_index
  `).all(sourceId)
  assert.equal(segments.length, 3)
  assert.deepEqual(segments.map((segment) => Number(segment.segment_index)), [0, 1, 2])
  assert.deepEqual(segments.map((segment) => Number(segment.char_start)), [0, 4_000, 8_000])
  assert.ok(segments.every((segment) => Number(segment.segment_count) === 3))
  assert.equal(segments.map((segment) => segment.content).join(''), biography)
  assert.equal(Number(segments.at(-1).char_end), Array.from(biography).length)

  const firstIds = segments.map((segment) => segment.document_id)
  const firstCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count)
  const second = backfillBusinessSearch(db, { batchSize: 50 })
  const secondIds = db.prepare(`
    SELECT document_id FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table = 'candidate_source_records' AND source_row_id = ?
      AND field_path = 'candidate_source_records.raw_payload.profile.biography'
    ORDER BY segment_index
  `).all(sourceId).map((row) => row.document_id)
  assert.equal(second.coverage.status, 'ready')
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count), firstCount)
  assert.deepEqual(secondIds, firstIds)

  const hit = searchAllRecords(db, { keywords: ['terminal-anchor-v8'] })
  assert.ok(hit.items.some((item) => item.entity_id === sourceId))
  assert.ok(hit.items.flatMap((item) => item.evidence).some((item) => item.segment.index === 2))
})

test('dirty triggers fail search closed, then flush atomically refreshes updates and deletes', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous Mutable Candidate',
    current_title: 'BeforeMarkerV8'
  })
  backfillBusinessSearch(db)
  const checkpointDocumentCount = () => Number(db.prepare(`
    SELECT document_count FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable} WHERE scope = 'full'
  `).get().document_count)
  const actualDocumentCount = () => Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
  `).get().count)
  assert.equal(checkpointDocumentCount(), actualDocumentCount())

  db.prepare(`UPDATE candidates SET current_title = 'AfterMarkerV8', updated_at = ? WHERE id = ?`)
    .run(now(), candidate.id)
  assert.equal(isBusinessSearchReady(db), false)
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`).get().count), 1)
  assert.throws(
    () => searchAllRecords(db, { keywords: ['AfterMarkerV8'] }),
    (error) => error instanceof BusinessSearchError && error.code === 'search_index_not_ready' && error.status === 503
  )

  const updated = flushBusinessSearchDirty(db, { limit: 20 })
  assert.equal(updated.remaining_rows, 0)
  assert.equal(updated.coverage.status, 'ready')
  assert.equal(checkpointDocumentCount(), actualDocumentCount())
  assert.equal(searchAllRecords(db, { keywords: ['BeforeMarkerV8'] }).pagination.total, 0)
  assert.ok(searchAllRecords(db, { keywords: ['AfterMarkerV8'] }).items.some((item) => item.entity_id === candidate.id))

  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(candidate.id)
  assert.equal(isBusinessSearchReady(db), false)
  const deleted = flushBusinessSearchDirty(db, { limit: 100 })
  assert.equal(deleted.remaining_rows, 0)
  assert.equal(deleted.coverage.status, 'ready')
  assert.equal(checkpointDocumentCount(), actualDocumentCount())
  assert.equal(searchAllRecords(db, { keywords: ['AfterMarkerV8'] }).pagination.total, 0)
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable} WHERE candidate_id = ?
  `).get(candidate.id).count), 0)
})

test('checkpoint coverage remains pending for partial batches and reports the exact completed batch count', () => {
  const db = anonymousDatabase()
  for (let index = 0; index < 4; index += 1) {
    insertCandidate(db, { name: `Anonymous Batch Candidate ${index}`, current_title: 'BatchMarkerV8' })
  }

  const partial = backfillBusinessSearch(db, { batchSize: 1, maxBatches: 1 })
  assert.equal(partial.batches, 1)
  assert.equal(partial.processed_rows, 1)
  assert.equal(partial.coverage.status, 'pending')
  assert.equal(isBusinessSearchReady(db), false)

  while (flushBusinessSearchDirty(db, { limit: 10 }).remaining_rows > 0) {}
  const coverage = getBusinessSearchCoverage(db)
  assert.equal(coverage.status, 'ready')
  assert.equal(coverage.totals.source_rows, coverage.totals.indexed_rows)
  assert.equal(isBusinessSearchReady(db), true)
})

test('position and talent-pool hits map to one deduplicated candidate with structured evidence', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, { name: 'Anonymous Related Candidate' })
  const marker = 'GlobexSignalV8'
  const { positionId, poolId } = addPositionAndPool(db, candidate.id, marker)
  backfillBusinessSearch(db)

  const result = searchBusinessCandidates(db, normalizeResumeSearch({
    keywords: [marker],
    evidence_limit: 5
  }))
  assert.equal(result.pagination.total, 1)
  assert.deepEqual(result.items.map((item) => item.candidate_id), [candidate.id])
  assert.equal(new Set(result.items.map((item) => item.candidate_id)).size, 1)
  assert.ok(result.items[0].matched_fields.includes('关联职位'))
  assert.ok(result.items[0].matched_fields.includes('关联人才库'))
  assert.ok(result.items[0].evidence.every((item) => (
    item.document_id && item.field_path && item.snippet && Array.isArray(item.matched_terms)
  )))
  assert.ok(result.items[0].evidence.some((item) => item.entity_id === positionId))
  assert.ok(result.items[0].evidence.some((item) => item.entity_id === poolId))
  assert.ok(result.items[0].evidence.every((item) => item.matched_terms.includes(marker)))
  assert.ok(result.items[0].evidence.every((item) => item.snippet.highlights.length > 0))

  const allRecords = searchAllRecords(db, { keywords: [marker], page_size: 1 })
  assert.equal(allRecords.pagination.total, 2)
  assert.equal(allRecords.pagination.total_pages, 2)
  assert.equal(allRecords.items.length, 1)
})

test('evidence returns every literal term and merges overlapping expanded-term intervals', () => {
  const db = anonymousDatabase()
  const candidate = insertCandidate(db, {
    name: 'Anonymous Highlight Candidate',
    current_title: 'Unity3D and Unity 3D delivery'
  })
  backfillBusinessSearch(db)

  const result = searchBusinessCandidates(db, normalizeResumeSearch({ keywords: ['Unity'] }))
  const evidence = result.items[0].evidence.find((item) => item.field_path === 'candidates.current_title')
  assert.equal(result.items[0].candidate_id, candidate.id)
  assert.deepEqual(evidence.matched_terms, ['Unity'])
  assert.ok(evidence.matched_actual_terms.includes('unity'))
  assert.ok(evidence.matched_actual_terms.includes('unity3d'))
  assert.ok(evidence.matched_actual_terms.includes('unity 3d'))
  assert.equal(evidence.has_expanded_matches, true)
  assert.equal(evidence.snippet.omitted_match_count, 0)
  assert.equal(evidence.snippet.source_match_count, evidence.snippet.literal_matches.length)
  assert.ok(evidence.snippet.literal_matches.every((match) => (
    match.concept_label === 'Unity' && match.actual_term && typeof match.expanded === 'boolean'
  )))
  assert.ok(evidence.snippet.highlights.some((highlight) => (
    highlight.actual_terms.includes('unity') && highlight.actual_terms.includes('unity3d') && highlight.expanded
  )))
  for (let index = 1; index < evidence.snippet.highlights.length; index += 1) {
    assert.ok(evidence.snippet.highlights[index - 1].end <= evidence.snippet.highlights[index].start)
  }
})

test('all-record filters cover field paths, archive scope and candidate, position and pool relations', () => {
  const db = anonymousDatabase()
  const active = insertCandidate(db, {
    name: 'Anonymous Active Relation Candidate',
    current_title: 'RelationFilterMarkerV8'
  })
  const archived = insertCandidate(db, {
    name: 'Anonymous Archived Relation Candidate',
    current_title: 'RelationFilterMarkerV8',
    archived_at: now()
  })
  const activeRelations = addPositionAndPool(db, active.id, 'ActiveRelationMarkerV8')
  addPositionAndPool(db, archived.id, 'ArchivedRelationMarkerV8')
  backfillBusinessSearch(db)

  const fieldOnly = searchAllRecords(db, {
    keywords: ['RelationFilterMarkerV8'],
    field_path: 'candidates.current_title',
    archived: 'exclude'
  })
  assert.deepEqual(fieldOnly.items.map((item) => item.entity_id), [active.id])
  assert.ok(fieldOnly.items.flatMap((item) => item.evidence).every((item) => item.field_path === 'candidates.current_title'))

  const archivedOnly = searchAllRecords(db, {
    keywords: ['RelationFilterMarkerV8'],
    field_path_prefixes: ['candidates.current_'],
    archived: 'only'
  })
  assert.deepEqual(archivedOnly.items.map((item) => item.entity_id), [archived.id])

  const candidateRelation = searchAllRecords(db, {
    keywords: ['ActiveRelationMarkerV8'],
    candidate_id: active.id
  })
  assert.equal(candidateRelation.pagination.total, 2)
  assert.ok(candidateRelation.items.every((item) => ['position', 'talent_pool'].includes(item.entity_type)))

  const positionRelation = searchAllRecords(db, {
    keywords: ['Anonymous'],
    position_id: activeRelations.positionId,
    archived: 'exclude',
    page_size: 100
  })
  assert.ok(positionRelation.items.some((item) => item.entity_type === 'candidate' && item.entity_id === active.id))
  assert.ok(positionRelation.items.some((item) => item.entity_type === 'position' && item.entity_id === activeRelations.positionId))

  const poolRelation = searchAllRecords(db, {
    keywords: ['Anonymous'],
    talent_pool_id: activeRelations.poolId,
    archived: 'exclude',
    page_size: 100
  })
  assert.ok(poolRelation.items.some((item) => item.entity_type === 'candidate' && item.entity_id === active.id))
  assert.ok(poolRelation.items.some((item) => item.entity_type === 'talent_pool' && item.entity_id === activeRelations.poolId))
})

test('catalog policy excludes previews, cleanup state, FTS shadows, BLOBs and physical attachment paths', () => {
  const db = anonymousDatabase()
  db.exec(`
    ALTER TABLE candidates ADD COLUMN anonymous_dynamic_v8 TEXT;
    ALTER TABLE candidates ADD COLUMN anonymous_blob_v8 BLOB;
  `)
  const candidate = insertCandidate(db, { name: 'Anonymous Attachment Candidate' })
  db.prepare(`UPDATE candidates SET anonymous_dynamic_v8 = ?, anonymous_blob_v8 = ? WHERE id = ?`)
    .run('DYNAMIC-CATALOG-MARKER-V8', Buffer.from('BLOB-CATALOG-MARKER-V8'), candidate.id)
  const attachmentId = addAttachment(db, candidate.id, {
    storagePath: 'private/STORAGE-ONLY-MARKER-V8/resume.pdf',
    extractedText: 'VISIBLE-RESUME-MARKER-V8'
  })
  backfillBusinessSearch(db)

  assert.equal(isReadonlyBusinessTable('candidates'), true)
  assert.equal(isReadonlyBusinessTable('attachment_update_previews'), false)
  assert.equal(isReadonlyBusinessTable('attachment_cleanup_jobs'), false)
  assert.equal(isReadonlyBusinessColumn('candidate_attachments', 'extracted_text', 'TEXT'), true)
  assert.equal(isReadonlyBusinessColumn('candidate_attachments', 'storage_path', 'TEXT'), false)
  assert.equal(isReadonlyBusinessColumn('candidate_resume_vectors', 'vector', 'BLOB'), false)
  assert.equal(isInternalSearchSchemaObject('search_documents_v2_fts_data'), true)
  assert.equal(isInternalSearchTool('business_search_flush'), true)
  assert.equal(isRestrictedResultColumn('get_attachment_text', 'storage_path'), true)

  const catalog = getBusinessSearchFieldCatalog(db)
  const candidateCatalog = catalog.tables.find((table) => table.table === 'candidates')
  assert.equal(candidateCatalog.columns.find((column) => column.name === 'anonymous_dynamic_v8').indexed, true)
  assert.equal(candidateCatalog.columns.find((column) => column.name === 'anonymous_blob_v8').indexed, false)
  assert.equal(candidateCatalog.columns.find((column) => column.name === 'anonymous_blob_v8').exclusion_reason, 'blob_column')
  assert.ok(catalog.unclassified_tables.includes('attachment_update_previews'))
  assert.ok(catalog.unclassified_tables.includes('attachment_cleanup_jobs'))
  assert.ok(!catalog.schema_tables.some((table) => table.startsWith('search_documents_v2_fts_')))

  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
    WHERE source_table = 'candidate_attachments' AND field_path = 'candidate_attachments.storage_path'
  `).get().count), 0)
  assert.equal(searchAllRecords(db, { keywords: ['STORAGE-ONLY-MARKER-V8'] }).pagination.total, 0)
  assert.ok(searchAllRecords(db, { keywords: ['DYNAMIC-CATALOG-MARKER-V8'] }).items.some((item) => item.entity_id === candidate.id))
  assert.equal(searchAllRecords(db, { keywords: ['BLOB-CATALOG-MARKER-V8'] }).pagination.total, 0)
  const visible = searchAllRecords(db, { keywords: ['VISIBLE-RESUME-MARKER-V8'] })
  assert.ok(visible.items.some((item) => item.entity_type === 'candidate_attachment' && item.entity_id === attachmentId))
})

test('fast Top-K search omits the exact window count and exposes has_more', () => {
  const db = anonymousDatabase()
  for (let index = 0; index < 5; index += 1) {
    insertCandidate(db, {
      name: `Anonymous Fast Candidate ${index}`,
      current_title: 'FAST-TOP-K-MARKER-V8'
    })
  }
  backfillBusinessSearch(db)

  const allPlan = buildAllRecordsPlans({
    keywords: ['FAST-TOP-K-MARKER-V8'],
    fast: true,
    page_size: 2
  })
  assert.doesNotMatch(allPlan.page.sql, /COUNT\(\*\)\s+OVER/i)
  assert.match(allPlan.page.sql, /LIMIT \? OFFSET \?/i)
  assert.match(allPlan.page.sql, /ORDER BY f\.rowid ASC\s+LIMIT \?/i)
  assert.doesNotMatch(allPlan.page.sql, /ORDER BY bm25_rank ASC\s+LIMIT \?/i)
  const allEvidencePlan = buildAllRecordEvidencePlan(allPlan.search, allPlan.expression, [
    { entity_type: 'candidate', entity_id: 'anonymous-fast-evidence' }
  ])
  assert.match(allEvidencePlan.sql, /bounded_fts_hits AS MATERIALIZED/i)
  assert.match(allEvidencePlan.sql, /ORDER BY f\.rowid ASC\s+LIMIT \?/i)
  assert.doesNotMatch(allEvidencePlan.sql, /rowid IN \(SELECT row_id FROM scoped_entity_documents\)/i)
  assert.ok(allEvidencePlan.parameters.includes(8_000))
  const all = searchAllRecords(db, {
    keywords: ['FAST-TOP-K-MARKER-V8'],
    fast: true,
    page_size: 2
  })
  assert.equal(all.items.length, 2)
  assert.equal(all.pagination.total, null)
  assert.equal(all.pagination.total_pages, null)
  assert.equal(all.pagination.has_more, true)

  const candidate = searchBusinessCandidates(db, normalizeResumeSearch({
    keywords: ['FAST-TOP-K-MARKER-V8'],
    fast: true,
    page_size: 2,
    source_types: ['candidate']
  }))
  const candidatePlan = buildBusinessCandidatePlans(normalizeResumeSearch({
    keywords: ['FAST-TOP-K-MARKER-V8'],
    fast: true,
    page_size: 2,
    source_types: ['candidate']
  }))
  assert.match(candidatePlan.page.sql, /indexed_document\.source_table IN/i)
  assert.match(candidatePlan.page.sql, /JOIN search_documents_v2 indexed_document ON indexed_document\.row_id = f\.rowid/i)
  assert.match(candidatePlan.page.sql, /ORDER BY f\.rowid ASC LIMIT \?/i)
  assert.doesNotMatch(candidatePlan.page.sql, /ORDER BY bm25_rank ASC LIMIT \?/i)
  assert.doesNotMatch(candidatePlan.page.sql, /ORDER BY bm25_rank ASC,\s*(?:d\.)?row_id/i)
  assert.equal(candidatePlan.page.parameters.filter((value) => value === 2_000).length, 1)
  assert.equal(candidatePlan.page.parameters.includes(10_000), false)
  const unfilteredCandidatePlan = buildBusinessCandidatePlans(normalizeResumeSearch({
    keywords: ['FAST-TOP-K-MARKER-V8'],
    fast: true,
    page_size: 2
  }))
  assert.equal(unfilteredCandidatePlan.page.parameters.includes(10_000), true)
  assert.equal(candidate.items.length, 2)
  assert.equal(candidate.pagination.total, null)
  assert.equal(candidate.pagination.total_pages, null)
  assert.equal(candidate.pagination.has_more, true)

  const repeatedCandidate = searchBusinessCandidates(db, normalizeResumeSearch({
    keywords: ['FAST-TOP-K-MARKER-V8'],
    fast: true,
    page_size: 2,
    source_types: ['candidate']
  }))
  assert.deepEqual(
    repeatedCandidate.items.map((item) => [item.candidate_id, item.bm25_score, item.evidence[0]?.document_id]),
    candidate.items.map((item) => [item.candidate_id, item.bm25_score, item.evidence[0]?.document_id])
  )

  const evidencePlan = buildBusinessCandidateEvidencePlan(
    normalizeResumeSearch({ keywords: ['FAST-TOP-K-MARKER-V8'], fast: true, page_size: 2, source_types: ['candidate'] }),
    candidate.items.map((item) => item.candidate_id),
  )
  assert.ok(evidencePlan)
  assert.match(evidencePlan.sql, /search_documents_v2_fts/i)
  assert.match(evidencePlan.sql, /FROM candidate_documents cd/i)
  assert.doesNotMatch(evidencePlan.sql, /instr\(d\.normalized_content/i)
  // Fast evidence bounds the FTS posting window before joining the visible
  // candidate scope; exact evidence retains the scoped rowid predicate.
  assert.match(evidencePlan.sql, /candidate_concept_0_fts_hits[\s\S]*LIMIT \?/i)
  assert.doesNotMatch(evidencePlan.sql, /search_documents_v2_fts\.rowid IN \(SELECT row_id FROM scoped_candidate_documents\)/i)
  assert.match(evidencePlan.sql, /d\.source_table IN/i)

  const exactEvidencePlan = buildBusinessCandidateEvidencePlan(
    normalizeResumeSearch({ keywords: ['FAST-TOP-K-MARKER-V8'], page_size: 2, source_types: ['candidate'] }),
    candidate.items.map((item) => item.candidate_id),
  )
  assert.match(exactEvidencePlan.sql, /search_documents_v2_fts\.rowid IN \(SELECT row_id FROM scoped_candidate_documents\)/i)
})

test('fast all-record scopes are applied before the bounded FTS window and deep pages recover exactly', () => {
  const db = anonymousDatabase()
  migrateBusinessSearch(db)
  backfillBusinessSearch(db)
  for (let index = 0; index < 2_000; index += 1) {
    const id = `AnonymousFastScope${index}`
    addIndexedDocument(db, {
      documentId: `fast-scope-candidate-${index}`,
      entityType: 'candidate',
      entityId: id,
      sourceTable: 'candidates',
      sourceRowId: id,
      fieldPath: 'candidates.name',
      content: 'FAST-SCOPE-MARKER-V8'
    })
  }
  addIndexedDocument(db, {
    documentId: 'fast-scope-note',
    entityType: 'candidate_note',
    entityId: 'fast-scope-note',
    sourceTable: 'notes',
    fieldPath: 'notes.content',
    content: 'FAST-SCOPE-MARKER-V8'
  })

  const filtered = searchAllRecords(db, {
    keywords: ['FAST-SCOPE-MARKER-V8'],
    fast: true,
    source_tables: ['notes'],
    page_size: 1
  })
  assert.deepEqual(filtered.items.map((item) => item.entity_id), ['fast-scope-note'])

  const deep = searchAllRecords(db, {
    keywords: ['FAST-SCOPE-MARKER-V8'],
    fast: true,
    page: 101,
    page_size: 20
  })
  // Exact fallback repairs the bounded Top-K page without changing the fast
  // request's no-total response contract.
  assert.equal(deep.pagination.total, null)
  assert.equal(deep.pagination.total_pages, null)
  assert.equal(deep.items.length, 1)
  assert.equal(deep.pagination.has_more, false)
})

test('scoped evidence preserves FTS token, CJK n-gram and diacritic semantics', () => {
  const db = anonymousDatabase()
  migrateBusinessSearch(db)
  backfillBusinessSearch(db)
  const candidate = insertCandidate(db, { name: 'Anonymous FTS Evidence Candidate' })
  backfillBusinessSearch(db)
  addIndexedDocument(db, {
    documentId: 'fts-evidence-substring',
    entityType: 'candidate',
    entityId: candidate.id,
    candidateId: candidate.id,
    sourceTable: 'candidates',
    sourceRowId: `${candidate.id}-substring`,
    fieldPath: 'candidates.anonymous_fts_metadata',
    content: 'metadata'
  })
  addIndexedDocument(db, {
    documentId: 'fts-evidence-token',
    entityType: 'candidate',
    entityId: candidate.id,
    candidateId: candidate.id,
    sourceTable: 'candidates',
    sourceRowId: `${candidate.id}-token`,
    fieldPath: 'candidates.anonymous_fts_data',
    content: 'data'
  })

  const allToken = searchAllRecords(db, { keywords: ['data'], evidence_limit: 1 })
  assert.equal(allToken.items[0].evidence[0].snippet.text, 'data')
  const candidateToken = searchBusinessCandidates(db, normalizeResumeSearch({ keywords: ['data'], evidence_limit: 1 }))
  assert.equal(candidateToken.items[0].evidence[0].snippet.text, 'data')

  addIndexedDocument(db, {
    documentId: 'fts-evidence-cjk',
    entityType: 'candidate_note',
    entityId: 'fts-evidence-cjk',
    sourceTable: 'notes',
    fieldPath: 'notes.content',
    content: '中华人 华人民 人民共 民共和 共和国'
  })
  const cjk = searchAllRecords(db, { keywords: ['中华人民共和国'], evidence_limit: 1 })
  assert.equal(cjk.items.length, 1)
  assert.ok(cjk.items[0].matched_terms.includes('中华人民共和国'))
  assert.ok(cjk.items[0].evidence[0].snippet.highlights.length > 0)

  addIndexedDocument(db, {
    documentId: 'fts-evidence-diacritic',
    entityType: 'candidate_note',
    entityId: 'fts-evidence-diacritic',
    sourceTable: 'notes',
    fieldPath: 'notes.content',
    content: 'résumé'
  })
  const diacritic = searchAllRecords(db, { keywords: ['resume'], evidence_limit: 1 })
  assert.equal(diacritic.items.length, 1)
  assert.ok(diacritic.items[0].matched_terms.includes('resume'))
})

test('ready guard fails fast while an anonymous index is still building', () => {
  const db = anonymousDatabase()
  migrateBusinessSearch(db)
  insertCandidate(db, { name: 'Anonymous Ready Candidate' })
  backfillBusinessSearch(db)
  insertCandidate(db, { name: 'Anonymous Pending Candidate' })
  const dirtyBefore = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`).get().count)
  assert.ok(dirtyBefore > 0)
  assert.throws(
    () => assertBusinessSearchReady(db),
    (error) => error instanceof BusinessSearchError
      && error.code === 'fts_index_building'
      && error.status === 503
  )
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`).get().count), dirtyBefore)
})
