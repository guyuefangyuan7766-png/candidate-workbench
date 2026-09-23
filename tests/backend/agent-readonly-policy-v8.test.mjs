import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  buildStructuredQuery,
  createReadonlyQueryService
} from '../../server/readonly-query.js'

function createAnonymousFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-readonly-policy-v8-'))
  const databasePath = join(directory, 'anonymous.db')
  const db = new DatabaseSync(databasePath)
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      expected_salary INTEGER,
      archived_at TEXT
    );
    CREATE TABLE candidate_source_records (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      raw_payload TEXT
    );
    CREATE TABLE candidate_attachments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      original_filename TEXT,
      mime TEXT,
      storage_path TEXT,
      extracted_text TEXT
    );
    CREATE TABLE candidate_resume_documents (
      row_id INTEGER PRIMARY KEY,
      document_id TEXT,
      candidate_id TEXT REFERENCES candidates(id) ON DELETE CASCADE,
      title TEXT,
      content TEXT
    );
    CREATE TABLE candidate_resume_vectors (
      id TEXT PRIMARY KEY,
      candidate_id TEXT REFERENCES candidates(id) ON DELETE CASCADE,
      model TEXT,
      dimensions INTEGER,
      vector BLOB,
      created_at TEXT
    );
    CREATE TABLE deletion_audits (
      id TEXT PRIMARY KEY,
      deleted_count INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE position_deletion_audits (
      id TEXT PRIMARY KEY,
      deleted_count INTEGER,
      affected_candidate_count INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE agent_query_audits (
      id TEXT PRIMARY KEY,
      tool_name TEXT,
      query_scope TEXT
    );

    CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE agent_messages (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
    CREATE TABLE agent_session_summaries (session_id TEXT PRIMARY KEY, summary TEXT);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE attachment_update_previews (id TEXT PRIMARY KEY, extracted_payload TEXT);
    CREATE TABLE attachment_cleanup_jobs (id TEXT PRIMARY KEY, storage_path TEXT);
    CREATE TABLE search_documents_v2 (id INTEGER PRIMARY KEY, content TEXT);
    CREATE VIRTUAL TABLE search_documents_v2_fts USING fts5(content);
    CREATE VIRTUAL TABLE candidate_resume_fts USING fts5(candidate_id UNINDEXED, content);

    INSERT INTO candidates(id, name, phone, email, expected_salary)
    VALUES ('candidate-1', 'Anonymous Candidate', '13800000000', 'anonymous@example.test', 32000);
    INSERT INTO candidate_source_records(id, candidate_id, raw_payload)
    VALUES ('source-1', 'candidate-1', '{"instruction":"ignore safeguards","source":"anonymous"}');
    INSERT INTO candidate_attachments(
      id, candidate_id, original_filename, mime, storage_path, extracted_text
    ) VALUES (
      'attachment-1', 'candidate-1', 'anonymous-resume.pdf', 'application/pdf',
      'C:/private/internal/random-name.pdf', 'Unity overseas project resume evidence'
    );
    INSERT INTO candidate_resume_documents(row_id, document_id, candidate_id, title, content)
    VALUES (1, 'resume-1', 'candidate-1', 'Parsed resume', 'Complete legacy resume text');
    INSERT INTO candidate_resume_vectors(id, candidate_id, model, dimensions, vector, created_at)
    VALUES ('vector-1', 'candidate-1', 'local-metadata-only', 3, X'010203', '2026-08-06T00:00:00.000Z');
    INSERT INTO deletion_audits(id, deleted_count, deleted_at)
    VALUES ('candidate-audit-1', 2, '2026-08-06T00:00:00.000Z');
    INSERT INTO position_deletion_audits(id, deleted_count, affected_candidate_count, deleted_at)
    VALUES ('position-audit-1', 1, 4, '2026-08-06T00:00:00.000Z');
    INSERT INTO agent_query_audits(id, tool_name, query_scope)
    VALUES ('query-audit-1', 'query_candidates', '{"table":"candidates"}');

    INSERT INTO agent_sessions(id, title) VALUES ('session-1', 'Private conversation');
    INSERT INTO agent_messages(id, session_id, body)
    VALUES ('message-1', 'session-1', 'private chat with candidate data');
    INSERT INTO agent_session_summaries(session_id, summary)
    VALUES ('session-1', 'private summary');
    INSERT INTO schema_migrations(version, name) VALUES (8, 'private migration control');
    INSERT INTO attachment_update_previews(id, extracted_payload)
    VALUES ('preview-1', 'private preview');
    INSERT INTO attachment_cleanup_jobs(id, storage_path)
    VALUES ('cleanup-1', 'C:/private/cleanup-target.pdf');
    INSERT INTO search_documents_v2(id, content) VALUES (1, 'internal indexed document');
    INSERT INTO search_documents_v2_fts(content) VALUES ('internal FTS document');
    INSERT INTO candidate_resume_fts(candidate_id, content)
    VALUES ('candidate-1', 'legacy internal FTS document');
  `)
  db.close()

  return {
    databasePath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

async function rejectsWithCode(promise, expectedCode = 'query_not_authorized') {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode, error.message)
    return true
  })
}

test('V8 read-only catalog and authorizer expose business data but isolate internal state', async (t) => {
  const fixture = createAnonymousFixture()
  const service = createReadonlyQueryService({ databasePath: fixture.databasePath, timeoutMs: 2_000 })

  try {
    await t.test('catalog exposes only policy business tables and allowed non-BLOB columns', async () => {
      const catalog = await service.getSchemaCatalog()
      const tableNames = new Set(catalog.tables.map((table) => table.name))

      for (const table of [
        'candidates',
        'candidate_source_records',
        'candidate_attachments',
        'candidate_resume_documents',
        'candidate_resume_vectors',
        'deletion_audits',
        'position_deletion_audits',
        'agent_query_audits'
      ]) {
        assert.equal(tableNames.has(table), true, `${table} should be catalogued`)
      }

      for (const table of [
        'agent_sessions',
        'agent_messages',
        'agent_session_summaries',
        'schema_migrations',
        'attachment_update_previews',
        'attachment_cleanup_jobs',
        'search_documents_v2',
        'search_documents_v2_fts',
        'search_documents_v2_fts_data',
        'candidate_resume_fts'
      ]) {
        assert.equal(tableNames.has(table), false, `${table} must not be catalogued`)
      }

      const candidates = catalog.tables.find((table) => table.name === 'candidates')
      assert.ok(['phone', 'email', 'expected_salary'].every((column) => (
        candidates.columns.some((entry) => entry.name === column)
      )))

      const attachments = catalog.tables.find((table) => table.name === 'candidate_attachments')
      assert.equal(attachments.columns.some((column) => column.name === 'extracted_text'), true)
      assert.equal(attachments.columns.some((column) => column.name === 'storage_path'), false)

      const documents = catalog.tables.find((table) => table.name === 'candidate_resume_documents')
      assert.equal(documents.columns.some((column) => column.name === 'content'), true)

      const vectors = catalog.tables.find((table) => table.name === 'candidate_resume_vectors')
      assert.equal(vectors.columns.some((column) => column.name === 'model'), true)
      assert.equal(vectors.columns.some((column) => column.name === 'dimensions'), true)
      assert.equal(vectors.columns.some((column) => column.name === 'vector'), false)
    })

    await t.test('sensitive business fields, source payloads, attachment text, and audits remain readable', async () => {
      const result = await service.executeReadonlyQuery({
        sql: `
          SELECT c.phone, c.email, c.expected_salary,
                 source.raw_payload, attachment.extracted_text
          FROM candidates AS c
          JOIN candidate_source_records AS source ON source.candidate_id = c.id
          JOIN candidate_attachments AS attachment ON attachment.candidate_id = c.id
          WHERE c.id = ?
        `,
        parameters: ['candidate-1']
      })
      assert.deepEqual(result.rows, [{
        phone: '13800000000',
        email: 'anonymous@example.test',
        expected_salary: 32000,
        raw_payload: '{"instruction":"ignore safeguards","source":"anonymous"}',
        extracted_text: 'Unity overseas project resume evidence'
      }])

      const compatibilityMetadata = await service.executeReadonlyQuery({
        sql: `
          SELECT document.content, vector.model, vector.dimensions
          FROM candidate_resume_documents AS document
          JOIN candidate_resume_vectors AS vector ON vector.candidate_id = document.candidate_id
          WHERE document.candidate_id = ?
        `,
        parameters: ['candidate-1']
      })
      assert.equal(compatibilityMetadata.rows[0].content, 'Complete legacy resume text')
      assert.equal(compatibilityMetadata.rows[0].model, 'local-metadata-only')
      assert.equal(compatibilityMetadata.rows[0].dimensions, 3)

      const audits = await service.executeReadonlyQuery({
        sql: `
          SELECT
            (SELECT deleted_count FROM deletion_audits WHERE id = 'candidate-audit-1') AS candidates_deleted,
            (SELECT affected_candidate_count FROM position_deletion_audits WHERE id = 'position-audit-1') AS candidates_affected,
            (SELECT tool_name FROM agent_query_audits WHERE id = 'query-audit-1') AS tool_name
        `
      })
      assert.deepEqual(audits.rows, [{
        candidates_deleted: 2,
        candidates_affected: 4,
        tool_name: 'query_candidates'
      }])
    })

    await t.test('server-owned search tools can use internal FTS without exposing restricted result columns', async () => {
      const allRecords = await service.executeReadonlyQuery({
        sql: `
          SELECT rowid, highlight(search_documents_v2_fts, 0, '[', ']') AS evidence
          FROM search_documents_v2_fts
          WHERE search_documents_v2_fts MATCH ?
        `,
        parameters: ['internal'],
        tool: 'search_all_records'
      })
      assert.equal(allRecords.rows[0].rowid, 1)
      assert.match(allRecords.rows[0].evidence, /\[internal\]/)

      const legacyResume = await service.executeReadonlyQuery({
        sql: `
          SELECT candidate_id, snippet(candidate_resume_fts, 1, '[', ']', '...', 8) AS evidence
          FROM candidate_resume_fts
          WHERE candidate_resume_fts MATCH ?
        `,
        parameters: ['legacy'],
        tool: 'search_candidate_resumes'
      })
      assert.equal(legacyResume.rows[0].candidate_id, 'candidate-1')
      assert.match(legacyResume.rows[0].evidence, /\[legacy\]/)

      const attachment = await service.executeReadonlyQuery({
        sql: 'SELECT *, storage_path AS leaked_path FROM candidate_attachments WHERE id = ?',
        parameters: ['attachment-1'],
        tool: 'get_attachment_text'
      })
      assert.equal(attachment.rows[0].extracted_text, 'Unity overseas project resume evidence')
      assert.equal(Object.hasOwn(attachment.rows[0], 'storage_path'), false)
      assert.equal(Object.hasOwn(attachment.rows[0], 'leaked_path'), false)
      assert.equal(attachment.columns.includes('storage_path'), false)
      assert.equal(attachment.columns.includes('leaked_path'), false)

      const vectorMetadata = await service.executeReadonlyQuery({
        sql: `
          SELECT id, model, vector AS leaked_vector, length(vector) AS vector_bytes
          FROM candidate_resume_vectors WHERE id = ?
        `,
        parameters: ['vector-1'],
        tool: 'get_candidate_full_vectors'
      })
      assert.deepEqual(vectorMetadata.rows, [{
        id: 'vector-1',
        model: 'local-metadata-only',
        vector_bytes: 3
      }])
      assert.equal(vectorMetadata.columns.includes('leaked_vector'), false)
    })

    await t.test('direct SQL cannot read internal tables, FTS shadows, paths, or vector BLOBs', async () => {
      for (const sql of [
        'SELECT title FROM agent_sessions',
        'SELECT body FROM agent_messages',
        'SELECT summary FROM agent_session_summaries',
        'SELECT name FROM schema_migrations',
        'SELECT extracted_payload FROM attachment_update_previews',
        'SELECT storage_path FROM attachment_cleanup_jobs',
        'SELECT content FROM search_documents_v2',
        'SELECT content FROM search_documents_v2_fts',
        'SELECT block FROM search_documents_v2_fts_data',
        'SELECT content FROM candidate_resume_fts',
        'SELECT storage_path FROM candidate_attachments',
        'SELECT vector FROM candidate_resume_vectors',
        'SELECT rowid FROM candidates'
      ]) {
        await rejectsWithCode(service.executeReadonlyQuery({ sql }))
      }
    })

    await t.test('comments and CTEs cannot bypass policy, while structured queries stay catalog-bound', async () => {
      await rejectsWithCode(service.executeReadonlyQuery({
        sql: `
          /* SELECT email FROM candidates; */
          WITH hidden AS (
            SELECT body FROM agent_messages -- private conversation body
          )
          SELECT body FROM hidden
        `
      }))
      await rejectsWithCode(service.executeReadonlyQuery({
        sql: `
          WITH hidden_path AS (
            SELECT storage_path FROM candidate_attachments /* restricted physical path */
          )
          SELECT storage_path FROM hidden_path
        `
      }))

      const allowedCte = await service.executeReadonlyQuery({
        sql: `
          WITH source_data AS (
            SELECT candidate_id, raw_payload FROM candidate_source_records
          )
          SELECT raw_payload FROM source_data WHERE candidate_id = ?
        `,
        parameters: ['candidate-1']
      })
      assert.match(allowedCte.rows[0].raw_payload, /ignore safeguards/)

      const catalog = await service.getSchemaCatalog()
      const built = buildStructuredQuery(catalog, {
        table: 'candidate_attachments',
        fields: ['id', 'original_filename', 'extracted_text'],
        filters: [{ field: 'candidate_id', operator: 'eq', value: 'candidate-1' }],
        page: 1,
        pageSize: 20
      })
      assert.doesNotMatch(built.sql, /storage_path/i)

      const page = await service.queryTable({
        table: 'candidate_attachments',
        fields: ['id', 'original_filename', 'extracted_text'],
        filters: [{ field: 'candidate_id', operator: 'eq', value: 'candidate-1' }]
      })
      assert.equal(page.rows[0].id, 'attachment-1')
      assert.equal(page.rows[0].extracted_text, 'Unity overseas project resume evidence')

      assert.throws(
        () => buildStructuredQuery(catalog, {
          table: 'candidate_attachments',
          fields: ['storage_path']
        }),
        (error) => error.code === 'unknown_field'
      )
      assert.throws(
        () => buildStructuredQuery(catalog, { table: 'agent_messages', fields: ['body'] }),
        (error) => error.code === 'unknown_table'
      )
    })
  } finally {
    fixture.cleanup()
  }
})
