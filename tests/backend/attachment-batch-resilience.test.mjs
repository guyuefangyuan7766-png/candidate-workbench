import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAttachmentBatchService } from '../../server/attachment-batches.js'
import { createAttachmentService } from '../../server/attachments.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

function csvFile(filename = 'resume.csv') {
  return {
    originalname: filename,
    mimetype: 'text/csv',
    buffer: Buffer.from(`name,email\nAnonymous ${filename},${filename}@example.test\n`, 'utf8')
  }
}

function controlledParser() {
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  let calls = 0
  let aborts = 0
  const parser = (_file, _validated, _limits, { signal } = {}) => new Promise((resolve, reject) => {
    calls += 1
    startedResolve()
    const onAbort = () => {
      aborts += 1
      const error = new Error('controlled parser aborted')
      error.code = 'parse_aborted'
      reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  return { parser, started, stats: () => ({ calls, aborts }) }
}

test('batch cancellation aborts active parsing, cancels siblings, and durably cleans staging files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-batch-cancel-'))
  const db = openDatabase(':memory:')
  const controlled = controlledParser()
  const attachments = createAttachmentService({
    db,
    rootDir: root,
    parser: controlled.parser,
    suggestionProvider: null,
    parseConcurrency: 1,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  const batches = createAttachmentBatchService({
    db,
    attachmentService: attachments,
    rootDir: join(root, 'batches'),
    processingConcurrency: 1
  })
  try {
    const token = 'anonymous-cancel-token-0000000001'
    const created = await batches.createBatch({
      files: [csvFile('one.csv'), csvFile('two.csv')],
      batchToken: token,
      idempotencyKey: 'anonymous-cancel-batch'
    })
    await controlled.started
    const cancelled = batches.cancelBatch(created.batch_id, { batchToken: token })
    assert.equal(cancelled.status, 'cancelled')
    await batches.waitForIdle()
    const persisted = batches.getBatch(created.batch_id, { batchToken: token })
    assert.equal(persisted.status, 'cancelled')
    assert.equal(persisted.items.every((item) => item.status === 'cancelled'), true)
    assert.equal(controlled.stats().aborts, 1)
    assert.deepEqual(await readdir(batches.incomingRoot), [])
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM attachment_cleanup_jobs WHERE completed_at IS NULL
    `).get().count, 0)

    const replay = batches.cancelBatch(created.batch_id, { batchToken: token })
    assert.equal(replay.status, 'cancelled')
  } finally {
    await batches.close()
    await attachments.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('parsing items and previews resume from the same SQLite file after service restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-batch-restart-'))
  const databasePath = join(root, 'recruitment-copy.db')
  const token = 'anonymous-restart-token-000000001'
  const controlled = controlledParser()
  let db = openDatabase(databasePath)
  let attachments = createAttachmentService({
    db,
    rootDir: join(root, 'attachments'),
    parser: controlled.parser,
    suggestionProvider: null,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  let batches = createAttachmentBatchService({
    db,
    attachmentService: attachments,
    rootDir: join(root, 'attachments', 'batches')
  })
  try {
    const created = await batches.createBatch({
      files: [csvFile('restart.csv')],
      batchToken: token,
      idempotencyKey: 'anonymous-restart-batch'
    })
    await controlled.started
    const before = db.prepare(`
      SELECT status, staging_path, preview_id FROM attachment_import_items WHERE batch_id = ?
    `).get(created.batch_id)
    assert.equal(before.status, 'parsing')
    assert.equal(existsSync(before.staging_path), true)
    assert.equal(Boolean(before.preview_id), true)

    await attachments.close()
    await batches.waitForIdle()
    await batches.close()
    assert.deepEqual(controlled.stats(), { calls: 1, aborts: 1 })
    assert.equal(db.prepare(`
      SELECT parse_status FROM attachment_update_previews WHERE id = ?
    `).get(before.preview_id).parse_status, 'parsing')
    db.close()

    db = openDatabase(databasePath)
    attachments = createAttachmentService({
      db,
      rootDir: join(root, 'attachments'),
      cleanupIntervalMs: 60 * 60 * 1000
    })
    batches = createAttachmentBatchService({
      db,
      attachmentService: attachments,
      rootDir: join(root, 'attachments', 'batches')
    })
    await batches.waitForIdle()
    const recovered = batches.getBatch(created.batch_id, { batchToken: token })
    assert.equal(recovered.items.length, 1)
    assert.equal(recovered.items[0].status, 'awaiting_confirmation')
    assert.equal(recovered.items[0].preview_id, before.preview_id)
    assert.equal(db.prepare('SELECT count(*) AS count FROM attachment_update_previews').get().count, 1)
    assert.equal(db.prepare('SELECT count(*) AS count FROM attachment_import_items').get().count, 1)
  } finally {
    try { await batches.close() } catch {}
    try { await attachments.close() } catch {}
    try { db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('confirmed item result replays across a database restart without duplicate business writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-confirm-restart-'))
  const databasePath = join(root, 'recruitment-copy.db')
  const attachmentRoot = join(root, 'attachments')
  const token = 'anonymous-confirm-restart-token-001'
  const itemKey = 'anonymous-confirm-restart-item'
  let db = openDatabase(databasePath)
  let attachments = createAttachmentService({ db, rootDir: attachmentRoot, cleanupIntervalMs: 60 * 60 * 1000 })
  let batches = createAttachmentBatchService({ db, attachmentService: attachments })
  try {
    const candidate = insertCandidate(db, {
      id: 'confirm-restart-candidate',
      name: 'Anonymous confirm restart',
      email: 'confirm-restart@example.test'
    })
    const created = await batches.createBatch({
      files: [{
        originalname: 'confirm-restart.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('name,email\nAnonymous confirm restart,confirm-restart@example.test\n')
      }],
      requestedCandidateId: candidate.id,
      batchToken: token,
      idempotencyKey: 'anonymous-confirm-restart-batch'
    })
    await batches.waitForIdle()
    const ready = batches.getBatch(created.batch_id, { batchToken: token })
    const item = ready.items[0]
    const input = {
      records: [{
        record_id: item.preview.records[0].record_id,
        candidate_id: candidate.id,
        expected_updated_at: db.prepare('SELECT updated_at FROM candidates WHERE id = ?').get(candidate.id).updated_at,
        selected_fields: [],
        selected_sections: [],
        merge_mode: 'merge'
      }]
    }
    const first = await batches.confirmItem(created.batch_id, item.item_id, input, {
      batchToken: token,
      idempotencyKey: itemKey
    })
    await Promise.all([attachments.close(), batches.close()])
    db.close()

    db = openDatabase(databasePath)
    attachments = createAttachmentService({ db, rootDir: attachmentRoot, cleanupIntervalMs: 60 * 60 * 1000 })
    batches = createAttachmentBatchService({ db, attachmentService: attachments })
    const replay = await batches.confirmItem(created.batch_id, item.item_id, input, {
      batchToken: token,
      idempotencyKey: itemKey
    })
    assert.deepEqual(replay.confirmation, first.confirmation)
    assert.equal(db.prepare('SELECT count(*) AS count FROM candidate_attachments').get().count, 1)
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM activities WHERE type = 'resume_attachment_confirmed'
    `).get().count, 1)
    assert.equal(db.prepare(`
      SELECT status FROM attachment_import_items WHERE id = ?
    `).get(item.item_id).status, 'confirmed')
  } finally {
    try { await Promise.all([attachments.close(), batches.close()]) } catch {}
    try { db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})
