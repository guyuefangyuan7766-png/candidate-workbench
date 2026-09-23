import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import {
  commitCandidateDeletion,
  commitPositionDeletion,
  DeletionPreviewStore,
  previewCandidateDeletion,
  previewPositionDeletion
} from '../../server/deletions.js'

const databases = new Set()
const BASE_TIME = '2026-08-05T00:00:00.000Z'

afterEach(() => {
  for (const db of databases) db.close()
  databases.clear()
})

function createAnonymousDatabase() {
  const db = new DatabaseSync(':memory:')
  databases.add(db)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE import_batches (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL
    );
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      import_batch_id TEXT,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY(import_batch_id) REFERENCES import_batches(id)
    );
    CREATE TABLE positions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE talent_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE candidate_positions (
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      PRIMARY KEY(candidate_id, position_id)
    );
    CREATE TABLE candidate_talent_pools (
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      talent_pool_id TEXT NOT NULL REFERENCES talent_pools(id) ON DELETE CASCADE,
      PRIMARY KEY(candidate_id, talent_pool_id)
    );
    CREATE TABLE candidate_profile_sections (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      content TEXT
    );
    CREATE TABLE candidate_preferences (
      candidate_id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
      expected_salary TEXT
    );
    CREATE TABLE candidate_source_records (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      raw_payload TEXT NOT NULL
    );
    CREATE TABLE candidate_assessments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      position_id TEXT REFERENCES positions(id) ON DELETE SET NULL,
      conclusion TEXT
    );
    CREATE TABLE candidate_consents (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      agreement_name TEXT
    );
    CREATE TABLE candidate_position_sources (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      raw_payload TEXT NOT NULL
    );
    CREATE TABLE candidate_attachments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      storage_path TEXT NOT NULL,
      extracted_text TEXT
    );
    CREATE TABLE attachment_cleanup_jobs (
      id TEXT PRIMARY KEY,
      storage_path TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE deletion_audits (
      id TEXT PRIMARY KEY,
      candidate_id_hash TEXT NOT NULL CHECK(length(candidate_id_hash) = 64),
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE position_deletion_audits (
      id TEXT PRIMARY KEY,
      position_id_hash TEXT NOT NULL CHECK(length(position_id_hash) = 64),
      affected_candidate_count INTEGER NOT NULL,
      deleted_at TEXT NOT NULL
    );
  `)
  return db
}

function insertCandidate(db, id, { archived = false, updatedAt = BASE_TIME } = {}) {
  db.prepare(`
    INSERT INTO candidates(id, name, phone, email, updated_at, archived_at)
    VALUES (?, ?, '13800000000', ?, ?, ?)
  `).run(id, `Anonymous ${id}`, `${id}@example.test`, updatedAt, archived ? updatedAt : null)
}

function insertPosition(db, id, { archived = false, updatedAt = BASE_TIME } = {}) {
  db.prepare(`
    INSERT INTO positions(id, title, updated_at, archived_at) VALUES (?, ?, ?, ?)
  `).run(id, `Anonymous ${id}`, updatedAt, archived ? updatedAt : null)
}

function rowCount(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
}

function captureError(callback) {
  try {
    callback()
  } catch (error) {
    return error
  }
  assert.fail('Expected callback to throw')
}

test('candidate preview limits targets and rejects missing or active candidates with 409', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  insertCandidate(db, 'active-candidate')

  const activeError = captureError(() => previewCandidateDeletion(db, {
    candidate_ids: ['active-candidate']
  }, store))
  assert.equal(activeError.status, 409)
  assert.equal(activeError.code, 'candidate_not_archived')
  assert.deepEqual(activeError.details.not_archived_ids, ['active-candidate'])

  const missingError = captureError(() => previewCandidateDeletion(db, {
    candidate_ids: ['missing-candidate']
  }, store))
  assert.equal(missingError.status, 409)
  assert.equal(missingError.code, 'candidate_not_found')

  const limitError = captureError(() => previewCandidateDeletion(db, {
    candidate_ids: Array.from({ length: 101 }, (_, index) => `candidate-${index}`)
  }, store))
  assert.equal(limitError.status, 413)
  assert.equal(limitError.code, 'limit_exceeded')
})

test('candidate commit cascades owned data, queues files, preserves shared rows and rejects replay', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  db.prepare(`INSERT INTO import_batches(id, filename) VALUES ('shared-batch', 'anonymous.csv')`).run()
  db.prepare(`INSERT INTO talent_pools(id, name) VALUES ('shared-pool', 'Shared pool')`).run()
  insertPosition(db, 'shared-position')
  insertCandidate(db, 'candidate-delete-one', { archived: true })
  insertCandidate(db, 'candidate-survivor')
  db.prepare(`UPDATE candidates SET import_batch_id = 'shared-batch' WHERE id = 'candidate-delete-one'`).run()

  const ownedRows = [
    [`INSERT INTO notes(id, candidate_id, content) VALUES ('owned-note', 'candidate-delete-one', 'private')`],
    [`INSERT INTO activities(id, candidate_id, type, description, metadata, created_at)
      VALUES ('owned-activity', 'candidate-delete-one', 'test', 'private', '{}', ?)` , BASE_TIME],
    [`INSERT INTO candidate_positions(candidate_id, position_id) VALUES ('candidate-delete-one', 'shared-position')`],
    [`INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id) VALUES ('candidate-delete-one', 'shared-pool')`],
    [`INSERT INTO candidate_profile_sections(id, candidate_id, content) VALUES ('owned-profile', 'candidate-delete-one', 'private')`],
    [`INSERT INTO candidate_preferences(candidate_id, expected_salary) VALUES ('candidate-delete-one', 'private')`],
    [`INSERT INTO candidate_source_records(id, candidate_id, raw_payload)
      VALUES ('owned-source', 'candidate-delete-one', '{"private":true}')`],
    [`INSERT INTO candidate_assessments(id, candidate_id, position_id, conclusion)
      VALUES ('owned-assessment', 'candidate-delete-one', 'shared-position', 'private')`],
    [`INSERT INTO candidate_consents(id, candidate_id, agreement_name)
      VALUES ('owned-consent', 'candidate-delete-one', 'private')`],
    [`INSERT INTO candidate_position_sources(id, candidate_id, position_id, raw_payload)
      VALUES ('owned-application', 'candidate-delete-one', 'shared-position', '{"private":true}')`],
    [`INSERT INTO candidate_attachments(id, candidate_id, storage_path, extracted_text)
      VALUES ('owned-attachment', 'candidate-delete-one', 'quarantine/random-resume.pdf', 'private resume')`]
  ]
  for (const [sql, parameter] of ownedRows) db.prepare(sql).run(...(parameter ? [parameter] : []))

  const preview = previewCandidateDeletion(db, {
    candidate_ids: ['candidate-delete-one', 'candidate-delete-one']
  }, store)
  assert.equal(preview.candidate_count, 1)
  assert.equal(preview.impact.attachment_count, 1)
  assert.equal(preview.impact.position_relation_count, 1)
  assert.equal(preview.impact.talent_pool_relation_count, 1)
  assert.match(preview.impact.boundary, /北森/)

  const result = commitCandidateDeletion(db, { preview_token: preview.preview_token }, store)
  assert.equal(result.deleted_count, 1)
  assert.equal(result.attachment_cleanup_queued_count, 1)
  assert.equal(result.candidate_id, 'candidate-delete-one')
  assert.equal(rowCount(db, 'candidates'), 1)
  for (const table of [
    'notes',
    'activities',
    'candidate_positions',
    'candidate_talent_pools',
    'candidate_profile_sections',
    'candidate_preferences',
    'candidate_source_records',
    'candidate_assessments',
    'candidate_consents',
    'candidate_position_sources',
    'candidate_attachments'
  ]) assert.equal(rowCount(db, table), 0, `${table} must be deleted by cascade`)
  assert.equal(rowCount(db, 'positions'), 1)
  assert.equal(rowCount(db, 'talent_pools'), 1)
  assert.equal(rowCount(db, 'import_batches'), 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

  const cleanup = db.prepare('SELECT * FROM attachment_cleanup_jobs').get()
  assert.equal(cleanup.storage_path, 'quarantine/random-resume.pdf')
  assert.equal(cleanup.reason, 'candidate_permanent_delete')
  const audit = db.prepare('SELECT * FROM deletion_audits').get()
  assert.match(audit.candidate_id_hash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(audit).includes('candidate-delete-one'), false)

  const replayError = captureError(() => commitCandidateDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(replayError.status, 409)
  assert.equal(replayError.code, 'deletion_preview_replayed')
})

test('candidate batch version conflict rolls back every deletion and consumes the token', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  insertCandidate(db, 'candidate-atomic-one', { archived: true })
  insertCandidate(db, 'candidate-atomic-two', { archived: true })
  const preview = previewCandidateDeletion(db, {
    candidate_ids: ['candidate-atomic-two', 'candidate-atomic-one']
  }, store)
  db.prepare(`UPDATE candidates SET updated_at = '2026-08-05T00:01:00.000Z' WHERE id = 'candidate-atomic-two'`).run()

  const conflict = captureError(() => commitCandidateDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'version_conflict')
  assert.deepEqual(conflict.details.version_conflict_ids, ['candidate-atomic-two'])
  assert.equal(rowCount(db, 'candidates'), 2)
  assert.equal(rowCount(db, 'deletion_audits'), 0)
  assert.equal(rowCount(db, 'attachment_cleanup_jobs'), 0)

  const replay = captureError(() => commitCandidateDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(replay.code, 'deletion_preview_replayed')
})

test('candidate deletion rolls back when an attachment cannot enter a recoverable cleanup queue', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  insertCandidate(db, 'candidate-cleanup-guard', { archived: true })
  db.prepare(`
    INSERT INTO candidate_attachments(id, candidate_id, storage_path, extracted_text)
    VALUES ('cleanup-guard-attachment', 'candidate-cleanup-guard', 'stored/cleanup-guard.pdf', 'private')
  `).run()
  const preview = previewCandidateDeletion(db, {
    candidate_ids: ['candidate-cleanup-guard']
  }, store)
  db.exec('DROP TABLE attachment_cleanup_jobs')

  const unavailable = captureError(() => commitCandidateDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.code, 'attachment_cleanup_unavailable')
  assert.equal(rowCount(db, 'candidates'), 1)
  assert.equal(rowCount(db, 'candidate_attachments'), 1)
  assert.equal(rowCount(db, 'deletion_audits'), 0)
})

test('expired candidate deletion token cannot be committed', () => {
  const db = createAnonymousDatabase()
  let currentTime = Date.parse(BASE_TIME)
  const store = new DeletionPreviewStore({ ttlMs: 1_000, clock: () => currentTime })
  insertCandidate(db, 'candidate-expired-token', { archived: true })
  const preview = previewCandidateDeletion(db, { candidate_ids: ['candidate-expired-token'] }, store)
  currentTime += 1_000

  const expired = captureError(() => commitCandidateDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(expired.status, 409)
  assert.equal(expired.code, 'deletion_preview_expired')
  assert.equal(rowCount(db, 'candidates'), 1)
})

test('position batch delete preserves candidates and their records while removing position-owned relations', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  insertCandidate(db, 'position-candidate-one')
  insertCandidate(db, 'position-candidate-two')
  insertCandidate(db, 'position-candidate-assessment-only')
  insertPosition(db, 'archived-position-one', { archived: true })
  insertPosition(db, 'archived-position-two', { archived: true })
  insertPosition(db, 'active-position')
  db.exec(`
    INSERT INTO notes(id, candidate_id, content)
      VALUES ('preserved-note', 'position-candidate-one', 'candidate-owned');
    INSERT INTO candidate_attachments(id, candidate_id, storage_path, extracted_text)
      VALUES ('preserved-attachment', 'position-candidate-one', 'stored/resume.pdf', 'candidate-owned');
    INSERT INTO candidate_positions(candidate_id, position_id)
      VALUES ('position-candidate-one', 'archived-position-one');
    INSERT INTO candidate_positions(candidate_id, position_id)
      VALUES ('position-candidate-one', 'archived-position-two');
    INSERT INTO candidate_positions(candidate_id, position_id)
      VALUES ('position-candidate-two', 'archived-position-two');
    INSERT INTO candidate_position_sources(id, candidate_id, position_id, raw_payload)
      VALUES ('source-relation', 'position-candidate-two', 'archived-position-one', '{}');
    INSERT INTO candidate_assessments(id, candidate_id, position_id, conclusion)
      VALUES ('preserved-assessment', 'position-candidate-one', 'archived-position-one', 'candidate-owned');
    INSERT INTO candidate_assessments(id, candidate_id, position_id, conclusion)
      VALUES ('assessment-only-relation', 'position-candidate-assessment-only', 'archived-position-one', 'candidate-owned');
  `)

  const activeError = captureError(() => previewPositionDeletion(db, {
    position_ids: ['active-position']
  }, store))
  assert.equal(activeError.status, 409)
  assert.equal(activeError.code, 'position_not_archived')

  const preview = previewPositionDeletion(db, {
    position_ids: ['archived-position-two', 'archived-position-one']
  }, store)
  assert.equal(preview.position_count, 2)
  assert.equal(preview.affected_candidate_count, 3)
  assert.match(preview.impact.boundary, /北森/)
  const result = commitPositionDeletion(db, { preview_token: preview.preview_token }, store)
  assert.equal(result.deleted_count, 2)
  assert.equal(result.affected_candidate_count, 3)
  assert.equal(result.candidate_activity_count, 3)
  assert.equal(rowCount(db, 'positions'), 1)
  assert.equal(rowCount(db, 'candidates'), 3)
  assert.equal(rowCount(db, 'notes'), 1)
  assert.equal(rowCount(db, 'candidate_attachments'), 1)
  assert.equal(rowCount(db, 'candidate_positions'), 0)
  assert.equal(rowCount(db, 'candidate_position_sources'), 0)
  const assessments = db.prepare(`SELECT position_id, conclusion FROM candidate_assessments ORDER BY id`).all()
  assert.deepEqual(assessments.map((assessment) => ({ ...assessment })), [
    { position_id: null, conclusion: 'candidate-owned' },
    { position_id: null, conclusion: 'candidate-owned' }
  ])

  const activities = db.prepare(`
    SELECT candidate_id, type, description, metadata FROM activities ORDER BY candidate_id
  `).all()
  assert.equal(activities.length, 3)
  for (const activity of activities) {
    assert.equal(activity.type, 'position_permanently_deleted')
    assert.equal(activity.description, '关联职位已永久删除')
    const metadata = JSON.parse(activity.metadata)
    assert.ok(metadata.position_count >= 1)
    assert.ok(metadata.position_id_hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    assert.equal(activity.metadata.includes('archived-position'), false)
  }

  const audits = db.prepare('SELECT * FROM position_deletion_audits ORDER BY id').all()
  assert.equal(audits.length, 2)
  assert.deepEqual(audits.map((audit) => audit.affected_candidate_count).sort(), [2, 3])
  for (const audit of audits) {
    assert.match(audit.position_id_hash, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(audit).includes('archived-position'), false)
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

  const replay = captureError(() => commitPositionDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(replay.code, 'deletion_preview_replayed')
})

test('position batch conflict is atomic and candidate activities roll back', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  insertCandidate(db, 'position-atomic-candidate')
  insertPosition(db, 'position-atomic-one', { archived: true })
  insertPosition(db, 'position-atomic-two', { archived: true })
  db.exec(`
    INSERT INTO candidate_positions(candidate_id, position_id)
      VALUES ('position-atomic-candidate', 'position-atomic-one');
    INSERT INTO candidate_positions(candidate_id, position_id)
      VALUES ('position-atomic-candidate', 'position-atomic-two');
  `)
  const preview = previewPositionDeletion(db, {
    position_ids: ['position-atomic-one', 'position-atomic-two']
  }, store)
  db.prepare(`UPDATE positions SET archived_at = NULL WHERE id = 'position-atomic-two'`).run()

  const conflict = captureError(() => commitPositionDeletion(db, {
    preview_token: preview.preview_token
  }, store))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'position_not_archived')
  assert.equal(rowCount(db, 'positions'), 2)
  assert.equal(rowCount(db, 'candidate_positions'), 2)
  assert.equal(rowCount(db, 'activities'), 0)
  assert.equal(rowCount(db, 'position_deletion_audits'), 0)
})

test('single-object commit targets must match the candidate or position preview snapshot', () => {
  const db = createAnonymousDatabase()
  const store = new DeletionPreviewStore()
  insertCandidate(db, 'candidate-route-binding', { archived: true })
  insertPosition(db, 'position-route-binding', { archived: true })

  const candidatePreview = previewCandidateDeletion(db, {
    candidate_ids: ['candidate-route-binding']
  }, store)
  const candidateMismatch = captureError(() => commitCandidateDeletion(db, {
    preview_token: candidatePreview.preview_token,
    candidate_ids: ['different-candidate']
  }, store))
  assert.equal(candidateMismatch.code, 'deletion_preview_target_mismatch')
  assert.equal(rowCount(db, 'candidates'), 1)

  const positionPreview = previewPositionDeletion(db, {
    position_ids: ['position-route-binding']
  }, store)
  const positionMismatch = captureError(() => commitPositionDeletion(db, {
    preview_token: positionPreview.preview_token,
    position_ids: ['different-position']
  }, store))
  assert.equal(positionMismatch.code, 'deletion_preview_target_mismatch')
  assert.equal(rowCount(db, 'positions'), 1)
})
