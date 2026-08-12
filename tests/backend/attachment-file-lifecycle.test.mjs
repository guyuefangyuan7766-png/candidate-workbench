import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../server/app.js'
import {
  recoverLegacyOriginalFilename,
  sanitizeOriginalFilename
} from '../../server/attachment-parser.js'
import { createAttachmentService } from '../../server/attachments.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import { normalizePhone } from '../../server/validation.js'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function addCandidate(db, id, values = {}) {
  return insertCandidate(db, {
    id,
    name: `Anonymous ${id}`,
    ...values
  })
}

async function json(response) {
  const payload = await response.json()
  return { response, payload }
}

test('original filename recovery is strict, reversible, and preserves legitimate names', () => {
  const expected = '【数据分析】匿名候选人 [实习] 简历.csv'
  const mojibake = Buffer.from(expected, 'utf8').toString('latin1')
  assert.match(mojibake, /[\u0080-\u009f]/)
  assert.equal(recoverLegacyOriginalFilename(mojibake), expected)
  assert.equal(sanitizeOriginalFilename(mojibake), expected)

  assert.equal(recoverLegacyOriginalFilename('Resume (final) [1].csv'), 'Resume (final) [1].csv')
  assert.equal(recoverLegacyOriginalFilename('Résumé.csv'), 'Résumé.csv')
  assert.equal(sanitizeOriginalFilename('简历：张三（终版）［分析］.pdf'), '简历：张三（终版）［分析］.pdf')
  const ambiguousWithoutControlSignal = Buffer.from('人.csv', 'utf8').toString('latin1')
  assert.equal(recoverLegacyOriginalFilename(ambiguousWithoutControlSignal), ambiguousWithoutControlSignal)
  assert.equal(recoverLegacyOriginalFilename(`broken-\u0080.csv`), `broken-\u0080.csv`)
  assert.equal(sanitizeOriginalFilename(`broken-\u0080.csv`), 'broken-_.csv')
  assert.equal(sanitizeOriginalFilename('../unsafe\u0000/name.csv'), 'name.csv')
})

test('UTF-8 multipart filenames survive preview, storage, listing and download; deletion is transactional and idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-file-lifecycle-'))
  const expectedFilename = '【数据分析】匿名候选人 [实习] 简历.csv'
  const candidatePhone = normalizePhone('13800000661')
  const candidateEmail = 'attachment.lifecycle@example.test'
  const csvBytes = Buffer.from([
    'name,phone,email,self_summary',
    `Anonymous lifecycle,13800000661,${candidateEmail},Verified summary`
  ].join('\n'), 'utf8')
  let parserFilename = ''
  const app = createApp({
    databasePath: ':memory:',
    attachmentRoot: root,
    attachmentSuggestionProvider: null,
    attachmentParser: async (file) => {
      parserFilename = file.originalname
      return {
        text: csvBytes.toString('utf8'),
        records: [{
          row_number: 2,
          values: {
            name: 'Anonymous lifecycle',
            phone: candidatePhone,
            email: candidateEmail,
            self_summary: 'Verified summary'
          }
        }],
        metadata: { row_count: 1 }
      }
    }
  })
  const candidate = addCandidate(app.locals.db, 'attachment-lifecycle', {
    phone: candidatePhone,
    email: candidateEmail,
    self_summary: 'Previous summary'
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  try {
    const form = new FormData()
    form.append('file', new Blob([csvBytes], { type: 'text/csv' }), expectedFilename)
    form.append('candidate_id', candidate.id)
    const pendingResult = await json(await fetch(`${baseUrl}/api/attachments/previews`, {
      method: 'POST',
      body: form
    }))
    assert.equal(pendingResult.response.status, 202)
    assert.equal(pendingResult.payload.file.original_filename, expectedFilename)

    const ready = await app.locals.attachments.waitForPreview(pendingResult.payload.preview_id)
    assert.equal(ready.status, 'ready')
    assert.equal(parserFilename, expectedFilename)
    assert.equal(ready.file.original_filename, expectedFilename)
    const record = ready.records[0]
    assert.equal(record.match.candidate_id, candidate.id)
    const confirmedResult = await json(await fetch(
      `${baseUrl}/api/attachments/previews/${encodeURIComponent(ready.preview_id)}/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preview_token: ready.preview_token,
          records: [{
            record_id: record.record_id,
            candidate_id: candidate.id,
            expected_updated_at: candidate.updated_at,
            selected_fields: ['self_summary'],
            selected_sections: [],
            merge_mode: 'merge'
          }]
        })
      }
    ))
    assert.equal(confirmedResult.response.status, 201)
    const attachmentId = confirmedResult.payload.attachment_ids[0]
    const attachment = app.locals.db.prepare('SELECT * FROM candidate_attachments WHERE id = ?').get(attachmentId)
    assert.equal(attachment.original_filename, expectedFilename)
    assert.equal(existsSync(attachment.storage_path), true)

    const listedResult = await json(await fetch(`${baseUrl}/api/candidates/${candidate.id}/attachments`))
    assert.equal(listedResult.payload.items[0].original_filename, expectedFilename)
    const firstDownload = await fetch(`${baseUrl}/api/attachments/${attachmentId}/download`)
    assert.equal(firstDownload.status, 200)
    assert.deepEqual(Buffer.from(await firstDownload.arrayBuffer()), csvBytes)
    const firstDisposition = firstDownload.headers.get('content-disposition') ?? ''
    const firstExtendedName = /filename\*=UTF-8''([^;]+)/i.exec(firstDisposition)
    assert.match(firstDisposition, /filename="/i)
    assert.ok(firstExtendedName)
    assert.equal(decodeURIComponent(firstExtendedName[1]), expectedFilename)

    const historicalMojibake = Buffer.from(expectedFilename, 'utf8').toString('latin1')
    app.locals.db.prepare('UPDATE candidate_attachments SET original_filename = ? WHERE id = ?')
      .run(historicalMojibake, attachmentId)
    const historicalList = await json(await fetch(`${baseUrl}/api/candidates/${candidate.id}/attachments`))
    assert.equal(historicalList.payload.items[0].original_filename, expectedFilename)
    assert.equal(
      app.locals.db.prepare('SELECT original_filename FROM candidate_attachments WHERE id = ?').get(attachmentId).original_filename,
      historicalMojibake,
      'historical compatibility must not guess by mutating stored data'
    )
    const historicalDownload = await fetch(`${baseUrl}/api/attachments/${attachmentId}/download`)
    const historicalDisposition = historicalDownload.headers.get('content-disposition') ?? ''
    const historicalExtendedName = /filename\*=UTF-8''([^;]+)/i.exec(historicalDisposition)
    assert.ok(historicalExtendedName)
    assert.equal(decodeURIComponent(historicalExtendedName[1]), expectedFilename)

    const timestamp = new Date().toISOString()
    app.locals.db.prepare(`
      INSERT INTO candidate_profile_sections(
        id, candidate_id, section_type, title, content, structured_data, sort_order,
        sensitivity, source_record_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, 'self_summary', '自我评价', ?, ?, 0, 'internal', ?, ?, ?, NULL)
    `).run(
      'retained-attachment-section', candidate.id, 'Verified summary',
      JSON.stringify({ attachment_id: attachmentId }), `attachment:${attachmentId}`, timestamp, timestamp
    )
    app.locals.db.prepare(`
      INSERT INTO candidate_resume_vectors(
        id, candidate_id, document_id, chunk_index, provider, model,
        dimensions, vector, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'anonymous-test', 'anonymous-vector', 1, ?, ?, ?)
    `).run(
      randomUUID(), candidate.id, `attachment:${attachmentId}`, Buffer.from([0]), timestamp, timestamp
    )

    const secondId = randomUUID()
    const secondPath = join(root, 'files', `${randomUUID()}.csv`)
    const secondBytes = Buffer.from('second anonymous attachment', 'utf8')
    writeFileSync(secondPath, secondBytes, { flag: 'wx' })
    app.locals.db.prepare(`
      INSERT INTO candidate_attachments(
        id, candidate_id, original_filename, storage_path, mime_type, file_size,
        sha256, attachment_type, parse_status, parser_version, extracted_text,
        source, import_batch_id, created_at, updated_at
      ) VALUES (?, ?, 'other-resume.csv', ?, 'text/csv', ?, ?, 'resume', 'parsed',
        'anonymous-parser', 'second anonymous attachment', 'user_upload', NULL, ?, ?)
    `).run(secondId, candidate.id, secondPath, secondBytes.length, sha256(secondBytes), timestamp, timestamp)

    const blockedDelete = await json(await fetch(`${baseUrl}/api/attachments/${attachmentId}`, {
      method: 'DELETE',
      headers: { origin: 'https://untrusted.example.test' }
    }))
    assert.equal(blockedDelete.response.status, 403)
    assert.equal(blockedDelete.payload.error.code, 'origin_not_allowed')
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_attachments WHERE id = ?').get(attachmentId).count, 1)

    const deletedResult = await json(await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { method: 'DELETE' }))
    assert.equal(deletedResult.response.status, 200)
    assert.deepEqual({
      attachment_id: deletedResult.payload.attachment_id,
      candidate_id: deletedResult.payload.candidate_id,
      deleted: deletedResult.payload.deleted,
      cleanup_queued: deletedResult.payload.cleanup_queued,
      physical_file_deleted: deletedResult.payload.physical_file_deleted,
      cleanup_pending: deletedResult.payload.cleanup_pending
    }, {
      attachment_id: attachmentId,
      candidate_id: candidate.id,
      deleted: true,
      cleanup_queued: true,
      physical_file_deleted: true,
      cleanup_pending: false
    })
    assert.equal(existsSync(attachment.storage_path), false)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_attachments WHERE id = ?').get(attachmentId).count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_field_sources WHERE attachment_id = ?').get(attachmentId).count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_resume_documents WHERE document_id = ?').get(`attachment:${attachmentId}`).count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_resume_fts WHERE document_id = ?').get(`attachment:${attachmentId}`).count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_resume_vectors WHERE document_id = ?').get(`attachment:${attachmentId}`).count, 0)
    assert.equal(app.locals.db.prepare('SELECT self_summary FROM candidates WHERE id = ?').get(candidate.id).self_summary, 'Verified summary')
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE id = ? AND archived_at IS NULL').get('retained-attachment-section').count, 1)
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE candidate_id = ? AND type = 'resume_attachment_deleted'
    `).get(candidate.id).count, 1)
    const completedCleanup = app.locals.db.prepare(`
      SELECT * FROM attachment_cleanup_jobs WHERE storage_path = ?
    `).get(attachment.storage_path)
    assert.ok(completedCleanup.completed_at)

    const remainingList = await json(await fetch(`${baseUrl}/api/candidates/${candidate.id}/attachments`))
    assert.deepEqual(remainingList.payload.items.map((item) => item.id), [secondId])
    assert.equal(existsSync(secondPath), true)
    assert.equal((await fetch(`${baseUrl}/api/attachments/${secondId}/download`)).status, 200)

    const repeatedDelete = await json(await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { method: 'DELETE' }))
    assert.equal(repeatedDelete.response.status, 404)
    assert.equal(repeatedDelete.payload.error.code, 'not_found')
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE candidate_id = ? AND type = 'resume_attachment_deleted'
    `).get(candidate.id).count, 1)
  } finally {
    server.close()
    await once(server, 'close')
    await app.closeDatabase()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed physical attachment deletion remains queued and succeeds on retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-file-cleanup-'))
  const db = openDatabase(':memory:')
  const service = createAttachmentService({
    db,
    rootDir: root,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  try {
    const candidate = addCandidate(db, 'attachment-cleanup-retry')
    const attachmentId = randomUUID()
    const storagePath = join(root, 'files', `${randomUUID()}.csv`)
    mkdirSync(storagePath)
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO candidate_attachments(
        id, candidate_id, original_filename, storage_path, mime_type, file_size,
        sha256, attachment_type, parse_status, parser_version, extracted_text,
        source, import_batch_id, created_at, updated_at
      ) VALUES (?, ?, 'retry-cleanup.csv', ?, 'text/csv', 1, ?, 'resume', 'parsed',
        'anonymous-parser', 'retry cleanup evidence', 'user_upload', NULL, ?, ?)
    `).run(attachmentId, candidate.id, storagePath, sha256('x'), timestamp, timestamp)

    const deleted = service.deleteAttachment(attachmentId)
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.physical_file_deleted, false)
    assert.equal(deleted.cleanup_pending, true)
    assert.equal(existsSync(storagePath), true)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_attachments WHERE id = ?').get(attachmentId).count, 0)
    const pending = db.prepare('SELECT * FROM attachment_cleanup_jobs WHERE storage_path = ?').get(storagePath)
    assert.equal(pending.completed_at, null)
    assert.equal(pending.attempts, 1)
    assert.ok(pending.last_error)

    rmSync(storagePath, { recursive: true, force: true })
    writeFileSync(storagePath, 'x', { flag: 'wx' })
    assert.deepEqual(service.processCleanupJobs(), { attempted: 1, completed: 1, failed: 0 })
    assert.equal(existsSync(storagePath), false)
    assert.ok(db.prepare('SELECT completed_at FROM attachment_cleanup_jobs WHERE id = ?').get(pending.id).completed_at)
  } finally {
    await service.close()
    if (db.open) db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('attachment deletion rejects the storage root itself without committing metadata changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-file-boundary-'))
  const db = openDatabase(':memory:')
  const service = createAttachmentService({
    db,
    rootDir: root,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  try {
    const candidate = addCandidate(db, 'attachment-storage-boundary')
    const attachmentId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO candidate_attachments(
        id, candidate_id, original_filename, storage_path, mime_type, file_size,
        sha256, attachment_type, parse_status, parser_version, extracted_text,
        source, import_batch_id, created_at, updated_at
      ) VALUES (?, ?, 'unsafe-root.csv', ?, 'text/csv', 1, ?, 'resume', 'parsed',
        'anonymous-parser', 'boundary evidence', 'user_upload', NULL, ?, ?)
    `).run(attachmentId, candidate.id, service.filesRoot, sha256('x'), timestamp, timestamp)

    assert.throws(
      () => service.deleteAttachment(attachmentId),
      (error) => error?.code === 'unsafe_storage_path'
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_attachments WHERE id = ?').get(attachmentId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup_jobs').get().count, 0)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE candidate_id = ? AND type = 'resume_attachment_deleted'
    `).get(candidate.id).count, 0)
  } finally {
    await service.close()
    if (db.open) db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
