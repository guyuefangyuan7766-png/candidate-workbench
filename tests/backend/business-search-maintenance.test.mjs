import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase, withTransaction } from '../../server/database.js'
import { backfillBusinessSearch } from '../../server/business-search.js'
import { BusinessSearchMaintenanceService } from '../../server/business-search-maintenance.js'

test('file-backed search recovery runs one bounded worker batch and persists the terminal result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-search-maintenance-'))
  const databasePath = join(directory, 'anonymous.db')
  let db
  try {
    db = openDatabase(databasePath)
    const candidate = insertCandidate(db, {
      name: 'Anonymous worker candidate',
      current_title: 'BeforeWorkerMarkerV8'
    })
    backfillBusinessSearch(db)
    db.prepare('UPDATE candidates SET current_title = ? WHERE id = ?').run('AfterWorkerMarkerV8', candidate.id)
    db.close()
    db = null

    // Production startup opts out of synchronous FTS recovery.
    db = openDatabase(databasePath, { synchronizeSearch: false })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 1)
    db.close()
    db = null

    const service = new BusinessSearchMaintenanceService({
      databasePath,
      batchSize: 1,
      autoStart: false
    })
    const result = await service.runOnce()
    assert.equal(result.ok, true)
    assert.equal(result.result.processed_rows, 1)
    assert.equal(result.result.remaining_rows, 0)
    assert.equal(result.result.written_documents, 1)
    await service.close()

    db = openDatabase(databasePath, { synchronizeSearch: false })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 0)
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM search_documents_v2_fts f
      JOIN search_documents_v2 d ON d.row_id = f.rowid
      WHERE search_documents_v2_fts MATCH 'AfterWorkerMarkerV8'
    `).get().count), 1)
  } finally {
    try { db?.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('background-policy transactions leave dirty search work for the isolated worker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-search-policy-'))
  const databasePath = join(directory, 'anonymous.db')
  let db
  try {
    db = openDatabase(databasePath)
    const candidate = insertCandidate(db, {
      name: 'Anonymous deferred candidate',
      current_title: 'DeferredBeforeMarkerV8'
    })
    backfillBusinessSearch(db)
    db.close()

    db = openDatabase(databasePath, { synchronizeSearch: false })
    withTransaction(db, () => {
      db.prepare('UPDATE candidates SET current_title = ? WHERE id = ?')
        .run('DeferredAfterMarkerV8', candidate.id)
    })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 1)
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count FROM search_documents_v2
      WHERE source_table = 'candidates' AND source_row_id = ? AND content = 'DeferredBeforeMarkerV8'
    `).get(candidate.id).count), 1)
  } finally {
    try { db?.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed checkpoint before its first queue cursor resumes in the isolated worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-search-queue-recovery-'))
  const databasePath = join(directory, 'anonymous.db')
  let db
  let service
  try {
    db = openDatabase(databasePath)
    insertCandidate(db, {
      name: 'Anonymous queue recovery candidate',
      current_title: 'QueueRecoveryMarkerV8'
    })
    backfillBusinessSearch(db)
    db.prepare(`
      UPDATE search_index_checkpoints_v2
      SET status = 'failed', queue_table = NULL, queue_cursor = NULL,
          queued_rows = 0, processed_rows = 0, error_code = 'simulated_queue_failure',
          completed_at = NULL, updated_at = ?
      WHERE scope = 'full'
    `).run(new Date().toISOString())
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 0)
    db.close()
    db = null

    service = new BusinessSearchMaintenanceService({
      databasePath,
      batchSize: 1,
      autoStart: false
    })
    const first = await service.runOnce()
    assert.equal(first.ok, true)
    assert.equal(first.result.processed_rows, 1)
    assert.ok(first.result.remaining_rows > 0)

    // The worker had to restart queueing before flushing. Continue bounded
    // worker turns until all rows reach the normal ready state.
    let current = first
    for (let attempt = 0; attempt < 100 && Number(current.result?.remaining_rows ?? 0) > 0; attempt += 1) {
      current = await service.runOnce()
      assert.equal(current.ok, true)
    }
    assert.equal(Number(current.result?.remaining_rows ?? 0), 0)
    await service.close()
    service = null

    db = openDatabase(databasePath, { synchronizeSearch: false })
    const checkpoint = db.prepare(`
      SELECT status, queue_table, queue_cursor, error_code
      FROM search_index_checkpoints_v2 WHERE scope = 'full'
    `).get()
    assert.deepEqual({ ...checkpoint }, {
      status: 'ready',
      queue_table: null,
      queue_cursor: null,
      error_code: null
    })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 0)
  } finally {
    try { await service?.close() } catch {}
    try { db?.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed checkpoint after a durable queue cursor resumes in the isolated worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-search-cursor-recovery-'))
  const databasePath = join(directory, 'anonymous.db')
  let db
  let service
  try {
    db = openDatabase(databasePath)
    insertCandidate(db, {
      name: 'Anonymous cursor recovery candidate',
      current_title: 'CursorRecoveryMarkerV8'
    })
    backfillBusinessSearch(db)
    db.prepare(`
      UPDATE search_index_checkpoints_v2
      SET status = 'failed', queue_table = 'candidates', queue_cursor = '__cleanup__',
          queued_rows = 0, processed_rows = 0, error_code = 'simulated_cursor_failure',
          completed_at = NULL, updated_at = ?
      WHERE scope = 'full'
    `).run(new Date().toISOString())
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 0)
    db.close()
    db = null

    service = new BusinessSearchMaintenanceService({
      databasePath,
      batchSize: 1,
      autoStart: false
    })
    let current = await service.runOnce()
    assert.equal(current.ok, true)
    assert.equal(current.result.processed_rows, 1)
    assert.ok(current.result.remaining_rows > 0)

    for (let attempt = 0; attempt < 100 && Number(current.result?.remaining_rows ?? 0) > 0; attempt += 1) {
      current = await service.runOnce()
      assert.equal(current.ok, true)
    }
    assert.equal(Number(current.result?.remaining_rows ?? 0), 0)
    await service.close()
    service = null

    db = openDatabase(databasePath, { synchronizeSearch: false })
    const checkpoint = db.prepare(`
      SELECT status, queue_table, queue_cursor, error_code
      FROM search_index_checkpoints_v2 WHERE scope = 'full'
    `).get()
    assert.deepEqual({ ...checkpoint }, {
      status: 'ready',
      queue_table: null,
      queue_cursor: null,
      error_code: null
    })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count), 0)
  } finally {
    try { await service?.close() } catch {}
    try { db?.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('synchronous transaction search refresh consumes at most one bounded batch', () => {
  const db = openDatabase(':memory:')
  try {
    for (let index = 0; index < 70; index += 1) {
      insertCandidate(db, {
        name: `Anonymous queued candidate ${index}`,
        current_title: 'BoundedTransactionMarkerV8'
      })
    }
    const before = Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count)
    assert.ok(before > 100)
    withTransaction(db, () => true)
    const after = Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count)
    assert.equal(after, before - 100)
  } finally {
    db.close()
  }
})
