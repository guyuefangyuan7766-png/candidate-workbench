import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import JSZip from 'jszip'
import { createAttachmentBatchService } from '../../server/attachment-batches.js'
import { createAttachmentService } from '../../server/attachments.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

const resources = []

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()
    try { await resource.batches?.close() } catch {}
    try { await resource.attachments?.close() } catch {}
    try { resource.db?.close() } catch {}
    try { rmSync(resource.root, { recursive: true, force: true }) } catch {}
  }
})

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-attachment-batches-'))
  const db = openDatabase(options.databasePath ?? ':memory:')
  const attachments = createAttachmentService({
    db,
    rootDir: root,
    cleanupIntervalMs: 60 * 60 * 1000,
    ...(options.attachmentOptions ?? {})
  })
  const batches = createAttachmentBatchService({
    db,
    attachmentService: attachments,
    rootDir: join(root, 'batches'),
    ...(options.batchOptions ?? {})
  })
  const resource = { root, db, attachments, batches }
  resources.push(resource)
  return resource
}

function csvFile(name, email, filename = `${name}.csv`) {
  return {
    originalname: filename,
    mimetype: 'text/csv',
    buffer: Buffer.from(`name,email\n${name},${email}\n`, 'utf8')
  }
}

async function docxBuffer(text = 'Anonymous Office container resume') {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  archive.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`)
  archive.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`)
  return Buffer.from(await archive.generateAsync({ type: 'nodebuffer' }))
}

function batchOptions(token = 'anonymous-batch-token-0000000001', key = 'anonymous-batch-key') {
  return { batchToken: token, idempotencyKey: key }
}

function getBatch(service, created, token = created.batch_token) {
  return service.getBatch(created.batch_id, { batchToken: token })
}

function candidate(db, id, email) {
  return insertCandidate(db, { id, name: `Anonymous ${id}`, email })
}

function confirmationFor(item, db, candidateId) {
  const record = item.preview.records[0]
  const current = db.prepare('SELECT updated_at FROM candidates WHERE id = ?').get(candidateId)
  return {
    records: [{
      record_id: record.record_id,
      candidate_id: candidateId,
      expected_updated_at: current.updated_at,
      selected_fields: [],
      selected_sections: [],
      merge_mode: 'merge'
    }]
  }
}

test('multi-file batches persist progress and idempotent creation returns the original batch', async () => {
  const { db, batches } = fixture()
  candidate(db, 'multi-a', 'multi-a@example.test')
  candidate(db, 'multi-b', 'multi-b@example.test')
  const files = [
    csvFile('Anonymous multi a', 'multi-a@example.test', 'a.csv'),
    csvFile('Anonymous multi b', 'multi-b@example.test', 'b.csv')
  ]
  const options = batchOptions()
  const created = await batches.createBatch({ files, ...options })
  assert.equal(created.batch_id.length > 10, true)
  assert.equal(created.items.length, 2)
  await batches.waitForIdle()

  const ready = getBatch(batches, created)
  assert.equal(ready.status, 'awaiting_confirmation')
  assert.equal(ready.summary.total, 2)
  assert.equal(ready.summary.awaiting_confirmation, 2)
  assert.equal(ready.items.every((item) => item.status === 'awaiting_confirmation'), true)

  const replayed = await batches.createBatch({ files, ...options })
  assert.equal(replayed.batch_id, created.batch_id)
  assert.equal(db.prepare('SELECT count(*) AS count FROM attachment_import_batches').get().count, 1)
  assert.equal(db.prepare('SELECT count(*) AS count FROM attachment_import_items').get().count, 2)
})

test('per-item confirmation is transactionally replayable without duplicate attachments or activities', async () => {
  const { db, batches } = fixture()
  candidate(db, 'confirm-one', 'confirm-one@example.test')
  const created = await batches.createBatch({
    files: [csvFile('Anonymous confirm', 'confirm-one@example.test')],
    ...batchOptions('anonymous-confirm-token-0000001', 'anonymous-confirm-batch')
  })
  await batches.waitForIdle()
  const ready = getBatch(batches, created)
  const item = ready.items[0]
  const input = confirmationFor(item, db, 'confirm-one')
  const options = {
    batchToken: created.batch_token,
    idempotencyKey: 'anonymous-confirm-item-key'
  }
  const first = await batches.confirmItem(created.batch_id, item.item_id, input, options)
  const replay = await batches.confirmItem(created.batch_id, item.item_id, input, options)

  assert.deepEqual(replay.confirmation, first.confirmation)
  assert.equal(replay.item.status, 'confirmed')
  assert.equal(db.prepare('SELECT count(*) AS count FROM candidate_attachments').get().count, 1)
  assert.equal(db.prepare(`
    SELECT count(*) AS count FROM activities
    WHERE candidate_id = ? AND type = 'resume_attachment_confirmed'
  `).get('confirm-one').count, 1)
  assert.equal(existsSync(db.prepare(`
    SELECT storage_path FROM candidate_attachments WHERE candidate_id = ?
  `).get('confirm-one').storage_path), true)

  await assert.rejects(
    batches.confirmItem(created.batch_id, item.item_id, { ...input, confirm_replace_sections: true }, options),
    (error) => error.code === 'attachment_confirmation_idempotency_conflict'
  )
})

test('item confirmation state and candidate business writes roll back as one transaction', async () => {
  const { db, batches } = fixture()
  candidate(db, 'atomic-confirm', 'atomic-confirm@example.test')
  const created = await batches.createBatch({
    files: [csvFile('Anonymous atomic', 'atomic-confirm@example.test')],
    ...batchOptions('anonymous-atomic-token-00000001', 'anonymous-atomic-batch')
  })
  await batches.waitForIdle()
  const item = getBatch(batches, created).items[0]
  const input = confirmationFor(item, db, 'atomic-confirm')
  db.exec(`
    CREATE TRIGGER fail_attachment_item_confirmation
    BEFORE UPDATE OF status ON attachment_import_items
    WHEN new.id = '${item.item_id}' AND new.status = 'confirmed'
    BEGIN
      SELECT RAISE(ABORT, 'forced batch item failure');
    END;
  `)
  await assert.rejects(
    batches.confirmItem(created.batch_id, item.item_id, input, {
      batchToken: created.batch_token,
      idempotencyKey: 'anonymous-atomic-confirm'
    }),
    /forced batch item failure/
  )
  assert.equal(db.prepare('SELECT count(*) AS count FROM candidate_attachments').get().count, 0)
  assert.equal(db.prepare(`
    SELECT count(*) AS count FROM activities WHERE type = 'resume_attachment_confirmed'
  `).get().count, 0)
  assert.equal(db.prepare(`
    SELECT status FROM attachment_import_items WHERE id = ?
  `).get(item.item_id).status, 'awaiting_confirmation')
  assert.equal(db.prepare(`
    SELECT parse_status FROM attachment_update_previews WHERE id = ?
  `).get(item.preview_id).parse_status, 'parsed')

  db.exec('DROP TRIGGER fail_attachment_item_confirmation')
  const confirmed = await batches.confirmItem(created.batch_id, item.item_id, input, {
    batchToken: created.batch_token,
    idempotencyKey: 'anonymous-atomic-confirm'
  })
  assert.equal(confirmed.item.status, 'confirmed')
})

test('unsupported files fail independently while a valid sibling remains confirmable and skippable', async () => {
  const { batches } = fixture()
  const created = await batches.createBatch({
    files: [
      csvFile('Anonymous valid sibling', 'valid-sibling@example.test', 'valid.csv'),
      { originalname: 'unsupported.txt', mimetype: 'text/plain', buffer: Buffer.from('unsupported') }
    ],
    ...batchOptions('anonymous-isolation-token-00001', 'anonymous-isolation-batch')
  })
  await batches.waitForIdle()
  const result = getBatch(batches, created)
  const valid = result.items.find((item) => item.original_filename === 'valid.csv')
  const failed = result.items.find((item) => item.original_filename === 'unsupported.txt')
  assert.equal(valid.status, 'awaiting_confirmation')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'unsupported_attachment_type')
  assert.equal(failed.error.retryable, false)

  const skipped = batches.skipItem(created.batch_id, valid.item_id, { batchToken: created.batch_token })
  assert.equal(skipped.status, 'skipped')
  assert.equal(getBatch(batches, created).status, 'completed_with_errors')
})

test('retryable parser failures reuse the durable batch source and eventually reach confirmation', async () => {
  let calls = 0
  const parser = async () => {
    calls += 1
    if (calls === 1) {
      const error = new Error('temporary parser outage')
      error.code = 'parser_unavailable'
      throw error
    }
    return {
      text: 'name: Anonymous retry',
      records: [{ row_number: 2, values: { name: 'Anonymous retry', email: 'retry@example.test' } }],
      metadata: {}
    }
  }
  const { batches } = fixture({ attachmentOptions: { parser, suggestionProvider: null } })
  const created = await batches.createBatch({
    files: [csvFile('Anonymous retry', 'retry@example.test')],
    ...batchOptions('anonymous-retry-token-0000001', 'anonymous-retry-batch')
  })
  await batches.waitForIdle()
  const failed = getBatch(batches, created).items[0]
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'parser_unavailable')
  assert.equal(failed.error.retryable, true)

  const retried = batches.retryItem(created.batch_id, failed.item_id, { batchToken: created.batch_token })
  assert.equal(['queued', 'identifying'].includes(retried.status), true)
  await batches.waitForIdle()
  assert.equal(getBatch(batches, created).items[0].status, 'awaiting_confirmation')
  assert.equal(calls, 2)
})

test('safe ZIP expansion creates independent items and rejects nested archives without blocking siblings', async () => {
  const inner = new JSZip()
  inner.file('inner.csv', 'name,email\nNested,nested@example.test\n')
  const innerBytes = await inner.generateAsync({ type: 'nodebuffer' })
  const archive = new JSZip()
  archive.file('folder/valid.csv', 'name,email\nZIP valid,zip-valid@example.test\n')
  archive.file('folder/nested.zip', innerBytes)
  const zipBytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const { batches } = fixture()
  const created = await batches.createBatch({
    files: [{ originalname: 'batch.zip', mimetype: 'application/zip', buffer: zipBytes }],
    ...batchOptions('anonymous-zip-token-000000001', 'anonymous-zip-batch')
  })
  await batches.waitForIdle()
  const result = getBatch(batches, created)
  const valid = result.items.find((item) => item.original_filename === 'valid.csv')
  const nested = result.items.find((item) => item.original_filename === 'nested.zip')
  const container = result.items.find((item) => item.kind === 'archive')
  assert.equal(container.status, 'skipped')
  assert.equal(container.error.code, 'archive_expanded')
  assert.equal(valid.status, 'awaiting_confirmation')
  assert.equal(nested.status, 'failed')
  assert.equal(nested.error.code, 'nested_archive_unsupported')
})

test('Office ZIP containers inside an uploaded ZIP remain supported without recursive generic extraction', async () => {
  const archive = new JSZip()
  archive.file('office/resume.docx', await docxBuffer())
  const zipBytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  const { batches } = fixture()
  const created = await batches.createBatch({
    files: [{ originalname: 'office-batch.zip', mimetype: 'application/zip', buffer: zipBytes }],
    ...batchOptions('anonymous-office-token-0000001', 'anonymous-office-batch')
  })
  await batches.waitForIdle()
  const result = getBatch(batches, created)
  const office = result.items.find((item) => item.original_filename === 'resume.docx')
  assert.equal(office.status, 'awaiting_confirmation')
  assert.equal(office.file.format, 'docx')
})
