import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_STAGES } from '../../server/constants.js'
import { synchronizeBusinessSearch } from '../../server/business-search.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type IN ('table', 'view') AND name = ?
  `).get(name))
}

function schemaObjectExists(db, type, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?
  `).get(type, name))
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
}

function migrationSnapshot(db) {
  const checkpoint = db.prepare(`
    SELECT status, queued_rows, processed_rows, document_count
    FROM search_index_checkpoints_v2 WHERE scope = 'full'
  `).get()
  return {
    versions: db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      .map((row) => Number(row.version)),
    resume_documents: count(db, 'candidate_resume_documents'),
    resume_fts: count(db, 'candidate_resume_fts'),
    resume_max_updated_at: db.prepare(`
      SELECT MAX(updated_at) AS value FROM candidate_resume_documents
    `).get().value,
    dirty_rows: count(db, 'search_index_dirty_v2'),
    checkpoint: checkpoint && {
      status: checkpoint.status,
      queued_rows: Number(checkpoint.queued_rows),
      processed_rows: Number(checkpoint.processed_rows),
      document_count: Number(checkpoint.document_count)
    },
    stage_documents: db.prepare(`
      SELECT document_id, row_id, updated_at
      FROM search_documents_v2
      WHERE source_table = 'stages'
      ORDER BY document_id
    `).all().map((row) => ({
      document_id: row.document_id,
      row_id: Number(row.row_id),
      updated_at: row.updated_at
    }))
  }
}

function probeCounts(db) {
  return Object.fromEntries(db.prepare(`
    SELECT kind, updates FROM migration_idempotence_probe ORDER BY kind
  `).all().map((row) => [row.kind, Number(row.updates)]))
}

test('V10 migration is idempotent for legacy resume FTS, attachment batches, and unchanged stages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-v9-migration-'))
  const databasePath = join(directory, 'anonymous.db')
  let db

  try {
    db = openDatabase(databasePath)
    const candidate = insertCandidate(db, {
      id: 'anonymous-migration-candidate',
      name: 'Anonymous migration candidate',
      email: 'anonymous-migration@example.test'
    })
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO candidate_profile_sections(
        id, candidate_id, section_type, title, content, structured_data,
        sort_order, sensitivity, source_record_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, 'work_experience', ?, ?, '{}', 0, 'internal', NULL, ?, ?, NULL)
    `).run(
      'anonymous-migration-section',
      candidate.id,
      'Anonymous work',
      'Anonymous experience',
      timestamp,
      timestamp
    )
    synchronizeBusinessSearch(db)

    // Simulate a pre-V6 ledger whose source rows exist but whose legacy resume
    // documents still need the first migration backfill.
    db.prepare('DELETE FROM schema_migrations WHERE version = 6').run()
    db.prepare('DELETE FROM candidate_resume_documents').run()
    assert.equal(count(db, 'candidate_resume_documents'), 0)
    assert.equal(count(db, 'candidate_resume_fts'), 0)
    db.close()

    db = openDatabase(databasePath)
    const firstBackfill = migrationSnapshot(db)
    assert.deepEqual(firstBackfill.versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.equal(firstBackfill.resume_documents, 2)
    assert.equal(firstBackfill.resume_fts, 2)
    assert.equal(firstBackfill.dirty_rows, 0)
    assert.equal(firstBackfill.checkpoint.status, 'ready')

    // Schema repair remains active even when the V6 data backfill is skipped.
    db.exec('DROP INDEX candidate_resume_documents_candidate_idx; DROP TRIGGER candidate_resume_documents_au;')

    db.exec(`
      CREATE TABLE migration_idempotence_probe (
        kind TEXT PRIMARY KEY,
        updates INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO migration_idempotence_probe(kind) VALUES ('resume'), ('stage');
      CREATE TRIGGER migration_probe_resume_update
      AFTER UPDATE ON candidate_resume_documents BEGIN
        UPDATE migration_idempotence_probe
        SET updates = updates + 1 WHERE kind = 'resume';
      END;
      CREATE TRIGGER migration_probe_stage_update
      AFTER UPDATE ON stages BEGIN
        UPDATE migration_idempotence_probe
        SET updates = updates + 1 WHERE kind = 'stage';
      END;
    `)
    db.close()

    db = openDatabase(databasePath)
    const secondOpen = migrationSnapshot(db)
    assert.deepEqual(secondOpen.versions, firstBackfill.versions)
    assert.equal(secondOpen.resume_documents, firstBackfill.resume_documents)
    assert.equal(secondOpen.resume_fts, firstBackfill.resume_fts)
    assert.equal(secondOpen.resume_max_updated_at, firstBackfill.resume_max_updated_at)
    assert.equal(secondOpen.dirty_rows, 0)
    assert.deepEqual(secondOpen.checkpoint, firstBackfill.checkpoint)
    assert.deepEqual(secondOpen.stage_documents, firstBackfill.stage_documents)
    assert.deepEqual(probeCounts(db), { resume: 0, stage: 0 })
    assert.equal(schemaObjectExists(db, 'index', 'candidate_resume_documents_candidate_idx'), true)
    assert.equal(schemaObjectExists(db, 'trigger', 'candidate_resume_documents_au'), true)

    assert.equal(tableExists(db, 'agent_tasks'), true)
    assert.equal(tableExists(db, 'attachment_import_batches'), true)
    assert.equal(tableExists(db, 'attachment_import_items'), true)
    const auditColumns = new Set(db.prepare('PRAGMA table_info(agent_query_audits)').all().map((row) => row.name))
    for (const column of ['trace_id', 'task_id', 'phase']) assert.equal(auditColumns.has(column), true, column)
    for (const index of [
      'agent_tasks_session_status_idx',
      'agent_tasks_heartbeat_idx',
      'agent_tasks_created_idx',
      'agent_query_audits_task_idx',
      'candidates_stage_id_v9_idx',
      'candidates_import_batch_id_v9_idx',
      'candidates_stage_archived_id_v10_idx',
      'candidates_archived_source_v10_idx',
      'candidates_archived_education_v10_idx',
      'candidates_archived_job_status_v10_idx',
      'attachment_import_batches_idempotency_idx',
      'attachment_import_items_batch_idx',
      'attachment_import_items_work_idx'
    ]) {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(index) !== undefined,
        true,
        index
      )
    }

    const offer = DEFAULT_STAGES.find((stage) => stage.value === 'Offer')
    assert.ok(offer)
    db.prepare('UPDATE stages SET label = ? WHERE value = ?').run('Offer changed', offer.value)
    db.prepare("UPDATE migration_idempotence_probe SET updates = 0 WHERE kind IN ('resume', 'stage')").run()
    db.close()

    db = openDatabase(databasePath)
    const thirdOpen = migrationSnapshot(db)
    assert.equal(db.prepare('SELECT label FROM stages WHERE value = ?').get(offer.value).label, offer.label)
    assert.equal(thirdOpen.dirty_rows, 0)
    assert.equal(thirdOpen.resume_documents, firstBackfill.resume_documents)
    assert.equal(thirdOpen.resume_fts, firstBackfill.resume_fts)
    assert.equal(probeCounts(db).resume, 0)
    assert.ok(probeCounts(db).stage >= 1)
  } finally {
    if (db?.open) db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
