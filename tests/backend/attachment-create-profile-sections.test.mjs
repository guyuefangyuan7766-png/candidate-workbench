import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createAttachmentBatchService } from '../../server/attachment-batches.js'
import { createAttachmentService } from '../../server/attachments.js'
import { openDatabase, getCandidate } from '../../server/database.js'

const resources = []

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()
    try { await resource.batches?.close() } catch {}
    try { await resource.service?.close() } catch {}
    try { resource.db?.close() } catch {}
    try { rmSync(resource.root, { recursive: true, force: true }) } catch {}
  }
})

function resumeParser(file) {
  const text = file.buffer.toString('utf8')
  return {
    text,
    records: [{ row_number: 2, values: { raw_text: text } }],
    metadata: { row_count: 1 }
  }
}

function fixture({ databasePath = ':memory:', batches = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-create-sections-'))
  const db = openDatabase(databasePath)
  const service = createAttachmentService({
    db,
    rootDir: root,
    parser: resumeParser,
    suggestionProvider: null,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  const batchService = batches
    ? createAttachmentBatchService({
        db,
        attachmentService: service,
        rootDir: join(root, 'batches'),
        cleanupIntervalMs: 60 * 60 * 1000
      })
    : null
  const resource = { root, db, service, batches: batchService }
  resources.push(resource)
  return resource
}

function textFile(text, filename = 'resume.txt') {
  return {
    originalname: filename,
    mimetype: 'text/plain',
    buffer: Buffer.from(text, 'utf8')
  }
}

async function readyPreview(service, file = textFile('Name: attachment candidate')) {
  const pending = service.createPreview({ file })
  assert.equal(pending.status, 'parsing')
  const preview = await service.waitForPreview(pending.preview_id)
  assert.equal(preview.status, 'ready')
  return preview
}

const sectionDrafts = [
  {
    section_type: 'education',
    title: 'Education',
    content: 'Example University | Computer Science | 2019-2023',
    structured_data: { school: 'Example University', major: 'Computer Science' },
    sort_order: 0
  },
  {
    section_type: 'internship',
    title: 'Internship',
    content: 'Example Labs | Data Intern | 2022-06 to 2022-09\nBuilt a reporting pipeline.',
    structured_data: { organization: 'Example Labs', role: 'Data Intern', start_date: '2022-06', end_date: '2022-09' },
    sort_order: 1
  },
  {
    section_type: 'language',
    title: 'Languages',
    content: 'English - CET-6',
    structured_data: { language: 'English', level: 'CET-6' },
    sort_order: 2
  }
]

function injectPreviewSections(db, previewId, drafts = sectionDrafts) {
  const row = db.prepare('SELECT records_json, updated_at FROM attachment_update_previews WHERE id = ?').get(previewId)
  assert.ok(row)
  const records = JSON.parse(row.records_json)
  assert.equal(records.length, 1)
  records[0].sections = drafts.map((draft, index) => ({
    section_id: `preview-section-${index + 1}`,
    ...draft,
    confidence: 'high',
    evidence: draft.content,
    default_selected: true
  }))
  db.prepare(`
    UPDATE attachment_update_previews SET records_json = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(records), row.updated_at, previewId)
  return records[0]
}

function sectionPayload() {
  // The create endpoint receives a user-confirmed draft, not the internal preview IDs.
  return sectionDrafts.map(({ section_type, title, content, structured_data, sort_order }) => ({
    section_type,
    title,
    content,
    structured_data,
    sort_order
  }))
}

function sectionRows(db, candidateId) {
  return db.prepare(`
    SELECT section_type, title, content, structured_data, sort_order, source_record_id
    FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL
    ORDER BY sort_order, created_at, id
  `).all(candidateId)
}

function assertPersistedSections(db, candidateId) {
  const rows = sectionRows(db, candidateId)
  assert.deepEqual(rows.map((row) => row.section_type), ['education', 'internship', 'language'])
  assert.deepEqual(rows.map((row) => row.content), sectionDrafts.map((section) => section.content))
  assert.ok(rows.every((row) => typeof row.source_record_id === 'string' && row.source_record_id.startsWith('attachment')))
  const hydrated = getCandidate(db, candidateId)
  assert.deepEqual(
    hydrated.profile_sections.map((section) => section.section_type),
    ['education', 'internship', 'language']
  )
  assert.deepEqual(
    hydrated.profile_sections.map((section) => section.content),
    sectionDrafts.map((section) => section.content)
  )
  return rows
}

test('single-file creation persists profile sections and rejects a client-supplied external source ID', async () => {
  const { db, service } = fixture()
  const preview = await readyPreview(service, textFile('Name: Single file created candidate\nNo applicant number'))
  const record = injectPreviewSections(db, preview.preview_id)
  const sourceRecordId = `attachment-preview:${preview.preview_id}:${record.record_id}`
  const created = await service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: {
      name: 'Single file created candidate',
      // The attachment service owns its idempotency bloodline; a client cannot
      // replace it with a purported external candidate number.
      source_system: 'manual',
      source_record_id: '6a52b9a5e86aa56c1HN'
    },
    profile_sections: sectionPayload()
  })

  assert.equal(created.source_system, 'attachment_preview')
  assert.equal(created.source_record_id, sourceRecordId)
  assertPersistedSections(db, created.id)

  const replay = await service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: {
      name: 'Single file created candidate',
      source_record_id: 'a-different-client-value'
    },
    profile_sections: sectionPayload()
  })
  assert.equal(replay.id, created.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ?').get(created.id).count, 3)
})

test('attachment creation normalizes legacy additional-information section aliases', async () => {
  const { db, service } = fixture()
  const preview = await readyPreview(service, textFile('Name: Legacy section candidate'))
  const record = injectPreviewSections(db, preview.preview_id, [{
    section_type: 'additional_information',
    title: 'Additional information',
    content: 'Available immediately',
    structured_data: {},
    sort_order: 0
  }])
  const created = await service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: { name: 'Legacy section candidate' },
    profile_sections: [{
      section_type: 'additional_information',
      title: 'Additional information',
      content: 'Available immediately'
    }]
  })

  const stored = sectionRows(db, created.id)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].section_type, 'other')
  assert.equal(JSON.parse(stored[0].structured_data).semantic_type, 'additional_information')

  const confirmed = service.confirmPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    records: [{
      record_id: record.record_id,
      candidate_id: created.id,
      expected_updated_at: created.updated_at,
      selected_fields: [],
      selected_sections: [record.sections[0].section_id],
      merge_mode: 'merge'
    }]
  })
  assert.deepEqual(confirmed.records[0].inserted_section_ids, [])
  const active = sectionRows(db, created.id)
  assert.equal(active.length, 1)
  assert.equal(active[0].section_type, 'other')
  assert.equal(JSON.parse(active[0].structured_data).semantic_type, 'additional_information')
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ?
  `).get(created.id).count, 1)
})

test('invalid profile sections roll back attachment candidate creation and leave the preview retryable', async () => {
  const { db, service } = fixture()
  const preview = await readyPreview(service, textFile('Name: Atomic attachment candidate'))
  const record = injectPreviewSections(db, preview.preview_id)
  const baseInput = {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: { name: 'Atomic attachment candidate' }
  }

  await assert.rejects(
    service.createCandidateFromPreview(preview.preview_id, {
      ...baseInput,
      profile_sections: [
        ...sectionPayload(),
        { section_type: 'not_a_profile_type', title: 'Invalid', content: 'Must not persist' }
      ]
    }),
    (error) => error?.status === 422 && error?.code === 'validation_error'
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections').get().count, 0)
  assert.equal(service.getPreview(preview.preview_id).status, 'ready')

  const retried = await service.createCandidateFromPreview(preview.preview_id, {
    ...baseInput,
    profile_sections: sectionPayload()
  })
  assertPersistedSections(db, retried.id)
})

test('batch candidate creation persists profile sections, survives candidate reload, and is idempotent before confirmation', async () => {
  const databaseRoot = mkdtempSync(join(tmpdir(), 'candidate-workbench-create-sections-db-'))
  const databasePath = join(databaseRoot, 'candidates.sqlite')
  resources.push({ root: databaseRoot })
  const { root, db, service, batches } = fixture({ databasePath, batches: true })
  const createdBatch = await batches.createBatch({
    files: [textFile('Name: Batch created candidate\nNo applicant number', 'batch-created.txt')],
    batchToken: 'create-sections-batch-token-0001',
    idempotencyKey: 'create-sections-batch-key'
  })
  await batches.waitForIdle()
  const item = batches.getBatch(createdBatch.batch_id, { batchToken: createdBatch.batch_token }).items[0]
  const record = injectPreviewSections(db, item.preview_id)
  const input = {
    record_id: record.record_id,
    candidate: { name: 'Batch created candidate', source_record_id: 'attachment-preview-fake-client-id' },
    profile_sections: sectionPayload()
  }

  const first = await batches.createCandidateForItem(
    createdBatch.batch_id,
    item.item_id,
    input,
    { batchToken: createdBatch.batch_token }
  )
  const replay = await batches.createCandidateForItem(
    createdBatch.batch_id,
    item.item_id,
    input,
    { batchToken: createdBatch.batch_token }
  )
  assert.equal(replay.id, first.id)
  assert.equal(first.source_system, 'attachment_preview')
  assert.match(first.source_record_id, /^attachment-preview:/)
  assertPersistedSections(db, first.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ?').get(first.id).count, 3)

  // Confirming the resume after creation must not duplicate the already persisted sections.
  const current = db.prepare('SELECT updated_at FROM candidates WHERE id = ?').get(first.id)
  const latestItem = batches.getItem(createdBatch.batch_id, item.item_id, { batchToken: createdBatch.batch_token })
  const confirmed = await batches.confirmItem(
    createdBatch.batch_id,
    item.item_id,
    {
      records: [{
        record_id: record.record_id,
        candidate_id: first.id,
        expected_updated_at: current.updated_at,
        selected_fields: [],
        selected_sections: latestItem.preview.records[0].sections.map((section) => section.section_id),
        merge_mode: 'merge'
      }]
    },
    {
      batchToken: createdBatch.batch_token,
      idempotencyKey: 'create-sections-confirm-key'
    }
  )
  assert.equal(confirmed.item.status, 'confirmed')
  assert.deepEqual(confirmed.confirmation.records[0].inserted_section_ids, [])
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_attachments WHERE candidate_id = ?').get(first.id).count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ? AND archived_at IS NULL').get(first.id).count, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ?').get(first.id).count, 3)

  // Re-open the file-backed database and read the candidate as a fresh process would.
  await batches.close()
  await service.close()
  db.close()
  const reopenedDb = openDatabase(databasePath)
  const reopenedService = createAttachmentService({
    db: reopenedDb,
    rootDir: root,
    parser: resumeParser,
    suggestionProvider: null,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  resources.push({ root, db: reopenedDb, service: reopenedService })
  const reloaded = getCandidate(reopenedDb, first.id)
  assert.deepEqual(reloaded.profile_sections.map((section) => section.section_type), ['education', 'internship', 'language'])
  assert.equal(reloaded.source_record_id, first.source_record_id)
})
