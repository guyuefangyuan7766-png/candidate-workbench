import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import JSZip from 'jszip'
import { createAttachmentBatchService } from '../../server/attachment-batches.js'
import { parseAttachment, validateAttachmentFile } from '../../server/attachment-parser.js'
import { createAttachmentService } from '../../server/attachments.js'
import { openDatabase } from '../../server/database.js'

const resources = []

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()
    try { await resource.batches.close() } catch {}
    try { await resource.attachments.close() } catch {}
    try { resource.db.close() } catch {}
    try { rmSync(resource.root, { recursive: true, force: true }) } catch {}
  }
})

function fixture(batchOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-batch-security-'))
  const db = openDatabase(':memory:')
  const attachments = createAttachmentService({ db, rootDir: root, cleanupIntervalMs: 60 * 60 * 1000 })
  const batches = createAttachmentBatchService({
    db,
    attachmentService: attachments,
    rootDir: join(root, 'batches'),
    ...batchOptions
  })
  const resource = { root, db, attachments, batches }
  resources.push(resource)
  return resource
}

async function zipFile(entries, options = {}) {
  const archive = new JSZip()
  for (const entry of entries) archive.file(entry.name, entry.content, entry.options)
  return Buffer.from(await archive.generateAsync({
    type: 'nodebuffer',
    compression: options.compression ?? 'STORE',
    platform: options.platform ?? 'DOS'
  }))
}

async function officeDocx(extraEntries = []) {
  return zipFile([
    {
      name: '[Content_Types].xml',
      content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    },
    {
      name: 'word/document.xml',
      content: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Anonymous secure Office resume content</w:t></w:r></w:p></w:body></w:document>'
    },
    ...extraEntries
  ])
}

function replaceAscii(buffer, before, after) {
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after))
  const result = Buffer.from(buffer)
  const needle = Buffer.from(before, 'ascii')
  const replacement = Buffer.from(after, 'ascii')
  let offset = 0
  let replacements = 0
  while ((offset = result.indexOf(needle, offset)) >= 0) {
    replacement.copy(result, offset)
    offset += replacement.length
    replacements += 1
  }
  assert.equal(replacements >= 2, true)
  return result
}

function setEncryptedFlags(buffer) {
  const result = Buffer.from(buffer)
  const local = result.indexOf(Buffer.from('504b0304', 'hex'))
  const central = result.indexOf(Buffer.from('504b0102', 'hex'))
  assert.equal(local >= 0 && central >= 0, true)
  result.writeUInt16LE(result.readUInt16LE(local + 6) | 1, local + 6)
  result.writeUInt16LE(result.readUInt16LE(central + 8) | 1, central + 8)
  return result
}

function corruptStoredPayload(buffer) {
  const result = Buffer.from(buffer)
  const local = result.indexOf(Buffer.from('504b0304', 'hex'))
  assert.equal(local >= 0, true)
  const filenameLength = result.readUInt16LE(local + 26)
  const extraLength = result.readUInt16LE(local + 28)
  const dataStart = local + 30 + filenameLength + extraLength
  result[dataStart] ^= 0xff
  return result
}

function mutateCompressionMethod(buffer, method) {
  const result = Buffer.from(buffer)
  const local = result.indexOf(Buffer.from('504b0304', 'hex'))
  const central = result.indexOf(Buffer.from('504b0102', 'hex'))
  result.writeUInt16LE(method, local + 8)
  result.writeUInt16LE(method, central + 10)
  return result
}

function mismatchLocalFilename(buffer, replacement) {
  const result = Buffer.from(buffer)
  const local = result.indexOf(Buffer.from('504b0304', 'hex'))
  const filenameLength = result.readUInt16LE(local + 26)
  assert.equal(Buffer.byteLength(replacement), filenameLength)
  Buffer.from(replacement, 'ascii').copy(result, local + 30)
  return result
}

function forceZip64Count(buffer) {
  const result = Buffer.from(buffer)
  const eocd = result.lastIndexOf(Buffer.from('504b0506', 'hex'))
  assert.equal(eocd >= 0, true)
  result.writeUInt16LE(0xffff, eocd + 8)
  result.writeUInt16LE(0xffff, eocd + 10)
  return result
}

async function failedArchive(batches, bytes, suffix) {
  const token = `anonymous-security-token-${suffix}-00000000`
  const created = await batches.createBatch({
    files: [{ originalname: `${suffix}.zip`, mimetype: 'application/zip', buffer: bytes }],
    batchToken: token,
    idempotencyKey: `anonymous-security-key-${suffix}`
  })
  await batches.waitForIdle()
  const batch = batches.getBatch(created.batch_id, { batchToken: token })
  assert.equal(batch.items.length, 1)
  assert.equal(batch.items[0].status, 'failed')
  return { batch, item: batch.items[0] }
}

test('ZIP boundary rejects traversal, normalized duplicates, symlinks, encryption, and bad CRC', async () => {
  const { db, batches } = fixture()

  const normalPath = await zipFile([{ name: 'aa/x.csv', content: 'name\nAnonymous\n' }])
  const traversal = replaceAscii(normalPath, 'aa/x.csv', '../x.csv')
  assert.equal((await failedArchive(batches, traversal, 'traversal')).item.error.code, 'zip_unsafe_path')

  const duplicate = await zipFile([
    { name: 'Resume.csv', content: 'name\nFirst\n' },
    { name: 'resume.csv', content: 'name\nSecond\n' }
  ])
  assert.equal((await failedArchive(batches, duplicate, 'duplicate')).item.error.code, 'zip_duplicate_path')

  const symlink = await zipFile([{
    name: 'link.csv',
    content: 'target.csv',
    options: { unixPermissions: 0o120777 }
  }], { platform: 'UNIX' })
  assert.equal((await failedArchive(batches, symlink, 'symlink')).item.error.code, 'zip_symlink_unsupported')

  const plain = await zipFile([{ name: 'plain.csv', content: 'name\nPlain\n' }])
  assert.equal((await failedArchive(batches, setEncryptedFlags(plain), 'encrypted')).item.error.code, 'zip_encrypted')
  assert.equal((await failedArchive(batches, corruptStoredPayload(plain), 'crc')).item.error.code, 'zip_crc_mismatch')

  assert.equal(db.prepare(`
    SELECT count(*) AS count FROM attachment_import_items
    WHERE status = 'failed' AND staging_path IS NOT NULL
  `).get().count, 0)
  assert.equal(db.prepare(`
    SELECT count(*) AS count FROM attachment_cleanup_jobs WHERE completed_at IS NULL
  `).get().count, 0)
})

test('ZIP declared resource limits reject excessive ratios and entry counts', async () => {
  const ratioFixture = fixture({ limits: { maxCompressionRatio: 2 } })
  const compressed = await zipFile([{
    name: 'ratio.csv',
    content: `name,summary\nAnonymous,${'A'.repeat(100_000)}\n`
  }], { compression: 'DEFLATE' })
  assert.equal((await failedArchive(ratioFixture.batches, compressed, 'ratio')).item.error.code, 'zip_ratio_limit_exceeded')

  const countFixture = fixture({ limits: { maxExtractedFiles: 2 } })
  const tooMany = await zipFile([
    { name: 'one.csv', content: 'name\nOne\n' },
    { name: 'two.csv', content: 'name\nTwo\n' },
    { name: 'three.csv', content: 'name\nThree\n' }
  ])
  assert.equal((await failedArchive(countFixture.batches, tooMany, 'count')).item.error.code, 'zip_entry_limit_exceeded')
})

test('ZIP boundary rejects header mismatch, unsupported methods, ZIP64 markers, and trailing data', async () => {
  const { batches } = fixture()
  const plain = await zipFile([{ name: 'safe.csv', content: 'name\nSafe\n' }])
  assert.equal(
    (await failedArchive(batches, mismatchLocalFilename(plain, 'evil.csv'), 'header-name')).item.error.code,
    'zip_header_mismatch'
  )
  assert.equal(
    (await failedArchive(batches, mutateCompressionMethod(plain, 99), 'method')).item.error.code,
    'zip_compression_unsupported'
  )
  assert.equal(
    (await failedArchive(batches, forceZip64Count(plain), 'zip64')).item.error.code,
    'zip64_unsupported'
  )
  assert.equal(
    (await failedArchive(batches, Buffer.concat([plain, Buffer.from([0])]), 'trailing')).item.error.code,
    'zip_invalid'
  )
})

test('batch capability token and idempotency fingerprint reject unauthorized or conflicting replays', async () => {
  const { batches } = fixture()
  const token = 'anonymous-auth-token-000000000001'
  const key = 'anonymous-auth-key'
  const firstFile = { originalname: 'first.csv', mimetype: 'text/csv', buffer: Buffer.from('name\nFirst\n') }
  const created = await batches.createBatch({ files: [firstFile], batchToken: token, idempotencyKey: key })

  assert.throws(
    () => batches.getBatch(created.batch_id, { batchToken: 'anonymous-wrong-token-000000001' }),
    (error) => error.status === 403 && error.code === 'attachment_batch_token_invalid'
  )
  await assert.rejects(
    batches.createBatch({
      files: [{ originalname: 'second.csv', mimetype: 'text/csv', buffer: Buffer.from('name\nSecond\n') }],
      batchToken: token,
      idempotencyKey: key
    }),
    (error) => error.status === 409 && error.code === 'attachment_batch_idempotency_conflict'
  )
  await assert.rejects(
    batches.createBatch({ files: [firstFile], batchToken: 'anonymous-other-token-00000001', idempotencyKey: key }),
    (error) => error.status === 409 && error.code === 'attachment_batch_token_conflict'
  )
})

test('Office container preflight rejects normalized duplicates and Worker rejects CRC corruption', async () => {
  const duplicate = await officeDocx([{
    name: 'WORD/document.xml',
    content: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
  }])
  assert.throws(
    () => validateAttachmentFile({
      originalname: 'duplicate.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: duplicate
    }),
    (error) => error.code === 'zip_duplicate_path'
  )

  const valid = await officeDocx()
  const corrupted = corruptStoredPayload(valid)
  const file = {
    originalname: 'crc.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: corrupted
  }
  const validated = validateAttachmentFile(file)
  await assert.rejects(
    parseAttachment(file, validated),
    (error) => error.code === 'zip_crc_mismatch'
  )
})
