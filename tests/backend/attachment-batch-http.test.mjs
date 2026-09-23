import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { join } from 'node:path'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'

async function responseJson(response) {
  const body = await response.json()
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`)
  return body
}

async function pollBatch(url, batchId, token) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const batch = await responseJson(await fetch(`${url}/api/attachment-batches/${encodeURIComponent(batchId)}`, {
      headers: { 'X-Attachment-Batch-Token': token }
    }))
    if (!['queued', 'processing'].includes(batch.status)) return batch
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('attachment batch polling did not reach a stable state')
}

test('HTTP batch upload persists directory paths, confirms one item, and stably replays confirmation', async () => {
  const app = createApp({ databasePath: ':memory:', attachmentSuggestionProvider: null })
  const candidate = insertCandidate(app.locals.db, {
    id: 'http-batch-candidate',
    name: 'Anonymous HTTP batch',
    email: 'http-batch@example.test'
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  const token = 'anonymous-http-batch-token-000001'
  const uploadKey = 'anonymous-http-batch-upload'
  try {
    const form = new FormData()
    form.append('candidate_id', candidate.id)
    form.append(
      'files',
      new Blob(['name,email\nAnonymous HTTP batch,http-batch@example.test\n'], { type: 'text/csv' }),
      'directory/resume.csv'
    )
    form.append(
      'files',
      new Blob(['name,email\nAnonymous sibling,sibling@example.test\n'], { type: 'text/csv' }),
      'directory/sibling.csv'
    )
    const createdResponse = await fetch(`${url}/api/attachment-batches`, {
      method: 'POST',
      headers: {
        'X-Attachment-Batch-Token': token,
        'Idempotency-Key': uploadKey
      },
      body: form
    })
    assert.equal(createdResponse.status, 202)
    const created = await createdResponse.json()
    assert.equal(created.batch_token, token)
    assert.equal(createdResponse.headers.get('location'), `/api/attachment-batches/${created.batch_id}`)
    const ready = await pollBatch(url, created.batch_id, token)
    assert.equal(ready.summary.awaiting_confirmation, 2)
    assert.equal(ready.items.some((item) => item.archive_path === 'directory/resume.csv'), true)

    const item = ready.items.find((entry) => entry.original_filename === 'resume.csv')
    const record = item.preview.records[0]
    const input = {
      records: [{
        record_id: record.record_id,
        candidate_id: candidate.id,
        expected_updated_at: app.locals.db.prepare('SELECT updated_at FROM candidates WHERE id = ?').get(candidate.id).updated_at,
        selected_fields: [],
        selected_sections: [],
        merge_mode: 'merge'
      }]
    }
    const confirmHeaders = {
      'Content-Type': 'application/json',
      'X-Attachment-Batch-Token': token,
      'Idempotency-Key': 'anonymous-http-confirm-item'
    }
    const first = await responseJson(await fetch(
      `${url}/api/attachment-batches/${created.batch_id}/items/${item.item_id}/confirm`,
      { method: 'POST', headers: confirmHeaders, body: JSON.stringify(input) }
    ))
    const replay = await responseJson(await fetch(
      `${url}/api/attachment-batches/${created.batch_id}/items/${item.item_id}/confirm`,
      { method: 'POST', headers: confirmHeaders, body: JSON.stringify(input) }
    ))
    assert.deepEqual(replay.confirmation, first.confirmation)
    assert.equal(app.locals.db.prepare('SELECT count(*) AS count FROM candidate_attachments').get().count, 1)
    assert.equal(app.locals.db.prepare(`
      SELECT count(*) AS count FROM activities WHERE type = 'resume_attachment_confirmed'
    `).get().count, 1)
    assert.deepEqual(await readdir(join(app.locals.attachmentBatches.root, '..', 'batch-multipart')), [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
})

test('HTTP batch upload enforces aggregate bytes while streaming and cleans multipart files', async () => {
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null,
    attachmentBatchLimits: {
      maxBatchUploadBytes: 1_024,
      maxAttachmentBytes: 2_048,
      maxArchiveBytes: 2_048
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const form = new FormData()
    form.append('files', new Blob(['A'.repeat(700)], { type: 'text/csv' }), 'one.csv')
    form.append('files', new Blob(['B'.repeat(700)], { type: 'text/csv' }), 'two.csv')
    const response = await fetch(`${url}/api/attachment-batches`, {
      method: 'POST',
      headers: {
        'X-Attachment-Batch-Token': 'anonymous-stream-limit-token-0001',
        'Idempotency-Key': 'anonymous-stream-limit-key'
      },
      body: form
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'attachment_batch_size_limit')
    assert.equal(body.error.details.max_batch_upload_bytes, 1_024)
    assert.deepEqual(await readdir(join(app.locals.attachmentBatches.root, '..', 'batch-multipart')), [])
    assert.equal(app.locals.db.prepare('SELECT count(*) AS count FROM attachment_import_batches').get().count, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
})

test('HTTP batch upload applies the ordinary attachment limit before a non-ZIP file finishes staging', async () => {
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null,
    attachmentBatchLimits: {
      maxBatchUploadBytes: 4_096,
      maxAttachmentBytes: 1_024,
      maxArchiveBytes: 2_048
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const form = new FormData()
    form.append('files', new Blob(['A'.repeat(1_500)], { type: 'text/csv' }), 'ordinary.csv')
    const response = await fetch(`${url}/api/attachment-batches`, {
      method: 'POST',
      headers: {
        'X-Attachment-Batch-Token': 'anonymous-file-limit-token-00001',
        'Idempotency-Key': 'anonymous-file-limit-key'
      },
      body: form
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'file_too_large')
    assert.equal(body.error.details.max_file_size_bytes, 1_024)
    assert.equal(body.error.details.archive, false)
    assert.deepEqual(await readdir(join(app.locals.attachmentBatches.root, '..', 'batch-multipart')), [])
    assert.equal(app.locals.db.prepare('SELECT count(*) AS count FROM attachment_import_batches').get().count, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
})

test('HTTP batch upload rejects an oversized declared request before multipart files are created', async () => {
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null,
    attachmentBatchLimits: {
      maxUploadFiles: 1,
      maxBatchUploadBytes: 1_024,
      maxAttachmentBytes: 128 * 1_024,
      maxArchiveBytes: 128 * 1_024
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const form = new FormData()
    form.append('files', new Blob(['Z'.repeat(80 * 1_024)], { type: 'application/zip' }), 'large.zip')
    const response = await fetch(`${url}/api/attachment-batches`, {
      method: 'POST',
      headers: {
        'X-Attachment-Batch-Token': 'anonymous-declared-limit-token-01',
        'Idempotency-Key': 'anonymous-declared-limit-key'
      },
      body: form
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'attachment_batch_size_limit')
    assert.deepEqual(await readdir(join(app.locals.attachmentBatches.root, '..', 'batch-multipart')), [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
})

test('application close does not deadlock when a batch parser ignores abort', async () => {
  let parserStarted
  const started = new Promise((resolve) => { parserStarted = resolve })
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null,
    attachmentParser: () => new Promise(() => parserStarted())
  })
  await app.locals.attachmentBatches.createBatch({
    files: [{
      originalname: 'stuck.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from('name,email\nAnonymous stuck,stuck@example.test\n')
    }],
    batchToken: 'anonymous-close-order-token-0001',
    idempotencyKey: 'anonymous-close-order-key'
  })
  await started
  let closeTimer
  try {
    await Promise.race([
      app.closeDatabase(),
      new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('application close deadlocked')), 2_000)
      })
    ])
  } finally {
    clearTimeout(closeTimer)
  }
  assert.throws(() => app.locals.db.prepare('SELECT 1'), /closed|not open/i)
})
