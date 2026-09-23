import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { crc32, deflateSync, gunzipSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  ATTACHMENT_LIMITS,
  parseAttachment,
  validateAttachmentFile
} from '../../server/attachment-parser.js'
import { createApp } from '../../server/app.js'
import { createAttachmentService, matchCandidateIdentity } from '../../server/attachments.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import {
  commitCandidateDeletion,
  DeletionPreviewStore,
  previewCandidateDeletion
} from '../../server/deletions.js'
import { normalizePhone } from '../../server/validation.js'

const resources = []

// Anonymous BIFF8 workbook from xls-reader's MIT-licensed sample corpus.
const XLS_FIXTURE_GZIP_BASE64 = 'H4sIAAAAAAAEAO1YTUhUURT+7psZnTF/ZkwDDeQhZGWCRJs2Oqmj1kIzE7II6tnMQqwZmSbQFmXZ0CooWhVtDFvUwmrTnwW1CFoESi2CINBaCkFQ0EJ9nXPeGxttBGehobxvuOfee+793rnvnnN/5k1OBKZGHpdPYwnq4cK86UNOmk5R8qUqflC7aXIxlXspmQ7WFXxecmSOB+MF73PZh+zvaWh45H5DEvhK6Tj60R6LRvQ1RKOMwVA8hjrlptjTcIdSIcpkXMUiT4ncLPKh9H0pcp9oromso75T6hgmgu3Ve+047tYqpa2QpMJT4XwWzW6U4h3H8cXryurrQUO81zi9URoq3PkYBfm6NRKNxLlehHvIA0Kh2ra22qOEKZRQHIzil6kDP1ML/rXu6NdWr0D634v1ucvovaTNpPeRc5fqb2puYAjmScXRn0QBBt3c4kHXYH/kbJIWzA3Z9/PQGYmGDb2ld8CYxX6OGkm00Tef6U1EookIEbuMAYOykJEwNgGNDe1NB/Vu/XBtgwtoCjUSoSMeC59LxHKkrocOULTB2nj8izaeAlmO+STDKJJyQBalnyzO3v/xoa2nI3hCNENy2FhH0jZ+HZi4xAwiF0qLvBEdYkC1MHaJvCxP3SrlcpEl9NqUV3WU2oWWYelzRVqryM4ewcfg9rTyDionZw49q0h+C+6k8ljr9PmSsU/BEVTSlIfFGQrDqFE16vYtxvNgKlf25vVFZNk/G5lX89tjNy2PqSLM8QolBERaNZ4dtVDT7LlitsrAVsLm+XhF9pWwxxVvpA+EzTwtA08TntvmWT55oXislW81m+dawvNoXtHx+JjlEtZ3Om4CmHGztXqtGE/40bRV/8VaxIW2INdrXKiMceFJ872W0fc8kxe0PNv3V+8qywvI5AUHDhw4cODAwQaGdV2wLsp8XeJrBF8U+O7F33XmKM3/528UDlYPnYjRL0H/EJsRpTyOwaziZws8KvUstUJO6nsh4whZj6MPPTKOvqxsM+jKrNLfZ8VEf9amlkPW9uezGecq2/8DycqEggAWAAA='

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()
    try { await resource.service?.close() } catch {}
    try { resource.db?.close() } catch {}
    try { rmSync(resource.root, { recursive: true, force: true }) } catch {}
  }
})

function createAnonymousFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-attachments-v6-'))
  const db = openDatabase(':memory:')
  const service = createAttachmentService({
    db,
    rootDir: root,
    cleanupIntervalMs: 60 * 60 * 1000,
    ...options
  })
  const resource = { root, db, service }
  resources.push(resource)
  return resource
}

function addCandidate(db, id, values = {}) {
  return insertCandidate(db, {
    id,
    name: `Anonymous ${id}`,
    ...values
  })
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvFile(rows, {
  filename = 'anonymous-resumes.csv',
  headers = ['name', 'phone', 'email', 'current_company', 'location', 'self_summary']
} = {}) {
  const lines = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]
    .map((row) => row.map(csvCell).join(','))
  return {
    originalname: filename,
    mimetype: 'text/csv',
    buffer: Buffer.from(`${lines.join('\n')}\n`, 'utf8')
  }
}

async function xlsxFile(rows, {
  filename = 'anonymous-resumes.xlsx',
  headers = ['name', 'phone', 'email', 'current_company', 'location']
} = {}) {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Anonymous resumes')
  worksheet.addRow(headers)
  for (const row of rows) worksheet.addRow(headers.map((header) => row[header] ?? ''))
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  return {
    originalname: filename,
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer
  }
}

function xmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function docxFile(text = 'Anonymous DOCX resume with local parser evidence') {
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
      <w:body><w:p><w:r><w:t>${xmlText(text)}</w:t></w:r></w:p><w:sectPr/></w:body>
    </w:document>`)
  return {
    originalname: 'anonymous-resume.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  }
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  typeBuffer.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 8 + data.length)
  return output
}

function attachmentAvatarPng(width = 160, height = 200, privateMarker = '') {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rowLength = 1 + width * 4
  const pixels = Buffer.alloc(rowLength * height)
  for (let row = 0; row < height; row += 1) {
    const start = row * rowLength
    for (let column = 0; column < width; column += 1) {
      const offset = start + 1 + column * 4
      pixels[offset] = 92
      pixels[offset + 1] = 68
      pixels[offset + 2] = 132
      pixels[offset + 3] = 255
    }
  }
  const metadata = privateMarker
    ? [pngChunk('tEXt', Buffer.from(`Comment\0${privateMarker}`, 'utf8'))]
    : []
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    ...metadata,
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND')
  ])
}

async function docxFileWithAvatar(text, imageBuffer) {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  archive.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`)
  archive.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdAvatar" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/avatar.png"/>
    </Relationships>`)
  archive.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <w:body>
        <w:p><w:r><w:t>${xmlText(text)}</w:t></w:r></w:p>
        <w:p><w:r><w:drawing><wp:inline>
          <wp:extent cx="1200000" cy="1500000"/>
          <wp:docPr id="1" name="Candidate avatar" descr="候选人证件照"/>
          <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic><pic:nvPicPr/><pic:blipFill><a:blip r:embed="rIdAvatar"/></pic:blipFill><pic:spPr/></pic:pic>
          </a:graphicData></a:graphic>
        </wp:inline></w:drawing></w:r></w:p>
        <w:sectPr/>
      </w:body>
    </w:document>`)
  archive.file('word/media/avatar.png', imageBuffer)
  return {
    originalname: 'anonymous-avatar-resume.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  }
}

function pdfLiteral(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function pdfFile(text = 'Anonymous PDF resume with local parser evidence', { encrypted = false } = {}) {
  const content = text
    ? `BT\n/F1 12 Tf\n72 720 Td\n(${pdfLiteral(text)}) Tj\nET`
    : 'q\n0 0 100 100 re S\nQ'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  if (encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4
      /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> >>`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  const encryptionTrailer = encrypted
    ? ` /Encrypt 6 0 R /ID [<${'01'.repeat(16)}><${'01'.repeat(16)}>]`
    : ''
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionTrailer} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return {
    originalname: 'anonymous-resume.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from(pdf, 'ascii')
  }
}

function pdfFileWithAvatar(text = 'Name: PDF avatar candidate\nEmail: pdf.avatar@example.test') {
  const width = 160
  const height = 200
  const pixels = Buffer.alloc(width * height * 3)
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 92
    pixels[offset + 1] = 68
    pixels[offset + 2] = 132
  }
  const compressed = deflateSync(pixels)
  const textCommands = String(text).split(/\r?\n/).map((line, index) => (
    `${index ? '0 -18 Td\n' : ''}(${pdfLiteral(line)}) Tj`
  )).join('\n')
  const content = Buffer.from([
    'BT',
    '/F1 12 Tf',
    '72 740 Td',
    textCommands,
    'ET',
    'q',
    `${width} 0 0 ${height} 72 500 cm`,
    '/Im1 Do',
    'Q'
  ].join('\n'), 'ascii')
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>', 'ascii'),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`, 'ascii'),
      compressed,
      Buffer.from('\nendstream', 'ascii')
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii')
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')
  ]
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')]
  const offsets = [0]
  let byteLength = chunks[0].length
  objects.forEach((body, index) => {
    offsets.push(byteLength)
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'ascii'),
      body,
      Buffer.from('\nendobj\n', 'ascii')
    ])
    chunks.push(object)
    byteLength += object.length
  })
  const xrefOffset = byteLength
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'ascii'))
  return {
    originalname: 'anonymous-avatar-resume.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.concat(chunks)
  }
}

async function xlsmFile(rows) {
  const source = await xlsxFile(rows)
  const archive = await JSZip.loadAsync(source.buffer)
  const contentTypesEntry = archive.file('[Content_Types].xml')
  const contentTypes = await contentTypesEntry.async('string')
  archive.file('xl/vbaProject.bin', Buffer.from('ANONYMOUS_VBA_SENTINEL_MUST_NOT_EXECUTE', 'ascii'))
  archive.file(
    '[Content_Types].xml',
    contentTypes.replace(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
    ).replace(
      '</Types>',
      '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'
    )
  )
  return {
    originalname: 'anonymous-resumes.xlsm',
    mimetype: 'application/vnd.ms-excel.sheet.macroenabled.12',
    buffer: await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  }
}

function xlsFile() {
  return {
    originalname: 'anonymous-resumes.xls',
    mimetype: 'application/vnd.ms-excel',
    buffer: gunzipSync(Buffer.from(XLS_FIXTURE_GZIP_BASE64, 'base64'))
  }
}

async function parseFixture(file, limits = ATTACHMENT_LIMITS) {
  const validated = validateAttachmentFile(file, limits)
  return {
    validated,
    parsed: await parseAttachment(file, validated, limits)
  }
}

function confirmationFor(preview, candidateId, overrides = {}) {
  const record = preview.records[0]
  const candidate = record.match.candidate
  return {
    preview_token: preview.preview_token,
    records: [{
      record_id: record.record_id,
      candidate_id: candidateId,
      expected_updated_at: candidate?.updated_at,
      selected_fields: [],
      selected_sections: [],
      merge_mode: 'merge',
      ...overrides
    }]
  }
}

function captureError(callback) {
  try {
    callback()
  } catch (error) {
    return error
  }
  assert.fail('Expected callback to throw')
}

async function createReadyPreview(service, input) {
  const pending = service.createPreview(input)
  assert.equal(pending.status, 'parsing')
  assert.equal(pending.records.length, 0)
  assert.ok(pending.preview_id)
  assert.ok(pending.preview_token)
  const preview = await service.waitForPreview(pending.preview_id)
  assert.equal(preview.status, 'ready')
  return preview
}

function parsedCsvResult(values = {}) {
  const row = {
    name: 'Anonymous background candidate',
    phone: '',
    email: '',
    current_company: '',
    location: '',
    self_summary: '',
    ...values
  }
  return {
    text: Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(' | '),
    records: [{ row_number: 2, values: row }],
    metadata: { row_count: 1 }
  }
}

function createControlledParser() {
  const running = new Set()
  let started = 0
  let completed = 0
  let aborted = 0
  let maxActive = 0
  const parser = (file, validated, limits, { signal } = {}) => new Promise((resolve, reject) => {
    started += 1
    let settled = false
    const entry = {
      filename: file.originalname,
      release() {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        running.delete(entry)
        completed += 1
        resolve(parsedCsvResult({ name: `Parsed ${file.originalname}` }))
      }
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      running.delete(entry)
      aborted += 1
      const error = new Error('controlled parser aborted')
      error.code = 'parse_aborted'
      reject(error)
    }
    running.add(entry)
    maxActive = Math.max(maxActive, running.size)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  return {
    parser,
    running,
    releaseAll() {
      for (const entry of [...running]) entry.release()
    },
    stats() {
      return { started, completed, aborted, active: running.size, maxActive }
    }
  }
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('attachment parser scheduler bounds concurrency and advances queued work without a queue timeout', async () => {
  const controlled = createControlledParser()
  const { service } = createAnonymousFixture({
    parser: controlled.parser,
    suggestionProvider: null,
    parseConcurrency: 2
  })
  const pending = Array.from({ length: 5 }, (_, index) => service.createPreview({
    file: csvFile([{ name: `Queued candidate ${index}` }], { filename: `queued-${index}.csv` })
  }))
  const completions = pending.map((preview) => service.waitForPreview(preview.preview_id))

  assert.deepEqual(controlled.stats(), { started: 2, completed: 0, aborted: 0, active: 2, maxActive: 2 })
  controlled.releaseAll()
  await nextTurn()
  assert.deepEqual(controlled.stats(), { started: 4, completed: 2, aborted: 0, active: 2, maxActive: 2 })
  controlled.releaseAll()
  await nextTurn()
  assert.deepEqual(controlled.stats(), { started: 5, completed: 4, aborted: 0, active: 1, maxActive: 2 })
  controlled.releaseAll()

  const ready = await Promise.all(completions)
  assert.equal(ready.every((preview) => preview.status === 'ready'), true)
  assert.deepEqual(controlled.stats(), { started: 5, completed: 5, aborted: 0, active: 0, maxActive: 2 })
})

test('cancelling previews skips queued parsing and aborts running parsing', async () => {
  const controlled = createControlledParser()
  const { service } = createAnonymousFixture({
    parser: controlled.parser,
    suggestionProvider: null,
    parseConcurrency: 1
  })
  const running = service.createPreview({
    file: csvFile([{ name: 'Running cancellation' }], { filename: 'running-cancel.csv' })
  })
  const queued = service.createPreview({
    file: csvFile([{ name: 'Queued cancellation' }], { filename: 'queued-cancel.csv' })
  })
  const runningDone = service.waitForPreview(running.preview_id)
  const queuedDone = service.waitForPreview(queued.preview_id)
  assert.equal(controlled.stats().started, 1)

  service.cancelPreview(queued.preview_id)
  assert.equal((await queuedDone).status, 'cancelled')
  assert.equal(controlled.stats().started, 1)

  service.cancelPreview(running.preview_id)
  assert.equal((await runningDone).status, 'cancelled')
  assert.deepEqual(controlled.stats(), { started: 1, completed: 0, aborted: 1, active: 0, maxActive: 1 })
})

test('expiry aborts running parsing, skips queued parsing, and preserves expired terminal states', async () => {
  let currentTime = Date.parse('2026-08-07T00:00:00.000Z')
  const controlled = createControlledParser()
  const { service } = createAnonymousFixture({
    parser: controlled.parser,
    suggestionProvider: null,
    parseConcurrency: 1,
    previewTtlMs: 1_000,
    clock: () => currentTime
  })
  const first = service.createPreview({
    file: csvFile([{ name: 'Running expiry' }], { filename: 'running-expiry.csv' })
  })
  const second = service.createPreview({
    file: csvFile([{ name: 'Queued expiry' }], { filename: 'queued-expiry.csv' })
  })
  const firstDone = service.waitForPreview(first.preview_id)
  const secondDone = service.waitForPreview(second.preview_id)
  currentTime += 1_000

  assert.equal(service.cleanupExpiredPreviews(), 2)
  assert.equal((await firstDone).status, 'expired')
  assert.equal((await secondDone).status, 'expired')
  assert.deepEqual(controlled.stats(), { started: 1, completed: 0, aborted: 1, active: 0, maxActive: 1 })
})

test('service close aborts in-memory work while preserving durable parsing rows for restart recovery', async () => {
  const controlled = createControlledParser()
  const fixture = createAnonymousFixture({
    parser: controlled.parser,
    suggestionProvider: null,
    parseConcurrency: 1
  })
  const { db, root } = fixture
  const service = fixture.service
  const first = service.createPreview({
    file: csvFile([{ name: 'Running close' }], { filename: 'running-close.csv' })
  })
  const second = service.createPreview({
    file: csvFile([{ name: 'Queued close' }], { filename: 'queued-close.csv' })
  })

  await service.close()
  for (const previewId of [first.preview_id, second.preview_id]) {
    const durable = service.getPreview(previewId)
    assert.equal(durable.status, 'parsing')
    const path = db.prepare('SELECT quarantine_path FROM attachment_update_previews WHERE id = ?').get(previewId).quarantine_path
    assert.equal(existsSync(path), true)
  }
  assert.deepEqual(controlled.stats(), { started: 1, completed: 0, aborted: 1, active: 0, maxActive: 1 })

  const restarted = createAttachmentService({
    db,
    rootDir: root,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  fixture.service = restarted
  const recovered = await Promise.all([
    restarted.waitForPreview(first.preview_id),
    restarted.waitForPreview(second.preview_id)
  ])
  assert.equal(recovered.every((preview) => preview.status === 'ready'), true)
})

test('preview creation returns parsing immediately and reaches a persisted ready terminal state', async () => {
  let finishParsing
  const parser = () => new Promise((resolve) => { finishParsing = resolve })
  const { db, service } = createAnonymousFixture({ parser, suggestionProvider: null })
  const pending = service.createPreview({
    file: csvFile([{ name: 'Anonymous background candidate' }])
  })

  assert.equal(pending.status, 'parsing')
  assert.equal(pending.poll_after_ms, 750)
  assert.equal(db.prepare(`
    SELECT parse_status FROM attachment_update_previews WHERE id = ?
  `).get(pending.preview_id).parse_status, 'parsing')

  finishParsing(parsedCsvResult())
  const ready = await service.waitForPreview(pending.preview_id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.records.length, 1)
  assert.equal(ready.error_code, undefined)
})

test('background parse failures persist stable safe reasons and always reach failed', async () => {
  const known = new Error('sensitive parser detail C:\\private\\resume.pdf')
  known.code = 'pdf_parse_failed'
  const unknown = new Error('sensitive unknown failure C:\\private\\worker.log')
  unknown.code = 'unexpected_internal_parser_error'
  const failures = [known, unknown]
  const { db, service } = createAnonymousFixture({
    parser: async () => { throw failures.shift() },
    suggestionProvider: null
  })

  const knownPending = service.createPreview({
    file: csvFile([{ name: 'Known parse failure' }], { filename: 'known-failure.csv' })
  })
  const knownFailed = await service.waitForPreview(knownPending.preview_id)
  assert.equal(knownFailed.status, 'failed')
  assert.equal(knownFailed.error_code, 'pdf_parse_failed')
  assert.equal(knownFailed.error, 'PDF 已损坏或无法提取文本')
  assert.equal(knownFailed.retryable, false)
  assert.equal(knownFailed.error.includes('C:\\private'), false)

  const unknownPending = service.createPreview({
    file: csvFile([{ name: 'Unknown parse failure' }], { filename: 'unknown-failure.csv' })
  })
  const unknownFailed = await service.waitForPreview(unknownPending.preview_id)
  assert.equal(unknownFailed.status, 'failed')
  assert.equal(unknownFailed.error_code, 'attachment_parse_failed')
  assert.equal(unknownFailed.error, '附件内容提取失败，请确认文件完整且格式正确后重试')
  assert.equal(unknownFailed.retryable, true)
  assert.equal(unknownFailed.error.includes('C:\\private'), false)
  assert.deepEqual(db.prepare(`
    SELECT parse_status, quarantine_path FROM attachment_update_previews
    WHERE id IN (?, ?) ORDER BY id
  `).all(knownPending.preview_id, unknownPending.preview_id).map((row) => ({ ...row })), [
    { parse_status: 'failed', quarantine_path: null },
    { parse_status: 'failed', quarantine_path: null }
  ])
})

test('service startup rejects and cleans a corrupted interrupted staging file', async () => {
  const { root, db } = createAnonymousFixture()
  const previewId = randomUUID()
  const quarantinePath = join(root, 'quarantine', `${randomUUID()}.csv`)
  writeFileSync(quarantinePath, 'x', { flag: 'wx' })
  const timestamp = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  db.prepare(`
    INSERT INTO attachment_update_previews(
      id, token_hash, original_filename, quarantine_path, mime_type, file_size,
      sha256, format, parse_status, parser_version, extracted_text, records_json,
      requested_candidate_id, error_code, error_message, expires_at, consumed_at,
      created_at, updated_at
    ) VALUES (?, ?, 'interrupted.csv', ?, 'text/csv', 1, ?, 'csv', 'parsing',
      'anonymous-test-parser', '', '[]', NULL, NULL, NULL, ?, NULL, ?, ?)
  `).run(previewId, '0'.repeat(64), quarantinePath, '1'.repeat(64), expiresAt, timestamp, timestamp)

  const recovered = createAttachmentService({
    db,
    rootDir: root,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  try {
    const failed = await recovered.waitForPreview(previewId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error_code, 'attachment_staging_invalid')
    assert.equal(failed.error, '附件隔离文件缺失或校验失败，请重新上传')
    assert.equal(failed.retryable, false)
    assert.equal(existsSync(quarantinePath), false)
  } finally {
    await recovered.close()
  }
})

test('a ready preview remains confirmable across service restart when the client retains its token', async () => {
  const fixture = createAnonymousFixture()
  const candidate = addCandidate(fixture.db, 'ready-restart', {
    phone: normalizePhone('13800000031'),
    email: 'ready.restart@example.test'
  })
  const pending = fixture.service.createPreview({
    file: csvFile([{
      name: candidate.name,
      phone: '13800000031',
      email: 'ready.restart@example.test'
    }], { filename: 'ready-restart.csv' })
  })
  const issuedToken = pending.preview_token
  const ready = await fixture.service.waitForPreview(pending.preview_id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.preview_token_reissued, true)

  await fixture.service.close()
  const restarted = createAttachmentService({
    db: fixture.db,
    rootDir: fixture.root,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  fixture.service = restarted
  const recovered = restarted.getPreview(pending.preview_id)
  assert.equal(recovered.status, 'ready')
  assert.equal(recovered.preview_token, '')
  assert.equal(recovered.preview_token_reissued, false)

  const input = confirmationFor(recovered, candidate.id)
  input.preview_token = issuedToken
  const result = restarted.confirmPreview(recovered.preview_id, input)
  assert.equal(result.committed_records, 1)
})

test('HTTP preview creation returns 202 before a slow parser completes and GET exposes the terminal result', async () => {
  let finishParsing = () => {}
  const parser = () => new Promise((resolve) => {
    finishParsing = () => resolve(parsedCsvResult())
  })
  const app = createApp({
    databasePath: ':memory:',
    attachmentParser: parser,
    attachmentSuggestionProvider: null
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  try {
    const form = new FormData()
    form.append('file', new Blob([
      'name,phone,email,current_company,location,self_summary\nAnonymous background candidate,,,,,\n'
    ], { type: 'text/csv' }), 'background.csv')
    const response = await Promise.race([
      fetch(`${url}/api/attachments/previews`, { method: 'POST', body: form }),
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('preview creation did not return before parsing completed')), 2_000)
        timer.unref()
      })
    ])
    assert.equal(response.status, 202)
    assert.equal(response.headers.get('retry-after'), '1')
    const pending = await response.json()
    assert.equal(pending.status, 'parsing')
    assert.equal(response.headers.get('location'), `/api/attachments/previews/${pending.preview_id}`)

    finishParsing()
    await app.locals.attachments.waitForPreview(pending.preview_id)
    const unauthorizedResponse = await fetch(`${url}/api/attachments/previews/${pending.preview_id}`)
    assert.equal(unauthorizedResponse.status, 403)
    const completedResponse = await fetch(`${url}/api/attachments/previews/${pending.preview_id}`, {
      headers: { 'X-Attachment-Preview-Token': pending.preview_token }
    })
    assert.equal(completedResponse.status, 200)
    assert.equal(completedResponse.headers.get('cache-control'), 'private, no-store')
    const completed = await completedResponse.json()
    assert.equal(completed.status, 'ready')
    assert.equal(completed.records.length, 1)
  } finally {
    finishParsing()
    server.close()
    await once(server, 'close')
    await app.closeDatabase()
  }
})

test('HTTP candidate creation stores a sanitized DOCX avatar and serves it only through the avatar endpoint', async () => {
  const privateMarker = 'PRIVATE_AVATAR_METADATA_MUST_BE_STRIPPED'
  const sourceImage = attachmentAvatarPng(160, 200, privateMarker)
  const file = await docxFileWithAvatar([
    'Name: Avatar attachment candidate',
    'Email: avatar.attachment@example.test',
    'Current company: Attachment Studio'
  ].join('\n'), sourceImage)
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  try {
    const pending = app.locals.attachments.createPreview({ file })
    const preview = await app.locals.attachments.waitForPreview(pending.preview_id)
    const record = preview.records[0]
    assert.equal(record.match.status, 'not_found')
    assert.deepEqual(record.avatar, {
      status: 'ready',
      available: true,
      source: 'docx_embedded_image',
      confidence: 'high',
      candidate_count: 1,
      content_type: 'image/png',
      width: 160,
      height: 200,
      requires_transcoding: true
    })
    const publicPreview = JSON.stringify(preview)
    assert.equal(publicPreview.includes(privateMarker), false)
    assert.equal(publicPreview.includes(sourceImage.toString('base64')), false)

    const createInput = {
      preview_token: preview.preview_token,
      record_id: record.record_id,
      candidate: {
        name: 'Avatar attachment candidate',
        email: 'avatar.attachment@example.test',
        current_company: 'Attachment Studio'
      }
    }
    const createdResponse = await fetch(`${url}/api/attachments/previews/${preview.preview_id}/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createInput)
    })
    assert.equal(createdResponse.status, 201)
    assert.match(createdResponse.headers.get('cache-control'), /no-store/)
    const created = await createdResponse.json()
    assert.equal(created.has_photo, true)
    assert.equal(JSON.stringify(created).includes(privateMarker), false)

    const replayResponse = await fetch(`${url}/api/attachments/previews/${preview.preview_id}/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createInput)
    })
    assert.equal(replayResponse.status, 201)
    assert.equal((await replayResponse.json()).id, created.id)

    const storedCandidate = app.locals.db.prepare(`
      SELECT photo_url FROM candidates WHERE id = ?
    `).get(created.id)
    assert.match(storedCandidate.photo_url, /^attachment-avatar:/)
    const avatar = app.locals.db.prepare(`
      SELECT * FROM candidate_attachments
      WHERE candidate_id = ? AND attachment_type = 'avatar'
    `).get(created.id)
    assert.ok(avatar)
    assert.equal(avatar.mime_type, 'image/png')
    assert.equal(existsSync(avatar.storage_path), true)
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM candidate_attachments
      WHERE candidate_id = ? AND attachment_type = 'avatar'
    `).get(created.id).count, 1)

    const detailResponse = await fetch(`${url}/api/candidates/${created.id}`)
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json()
    assert.equal(detail.has_photo, true)
    assert.equal(Object.hasOwn(detail, 'photo_url'), false)

    const avatarResponse = await fetch(`${url}/api/candidates/${created.id}/avatar`)
    assert.equal(avatarResponse.status, 200)
    assert.equal(avatarResponse.headers.get('content-type'), 'image/png')
    assert.equal(avatarResponse.headers.get('content-disposition'), 'inline')
    assert.equal(avatarResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(avatarResponse.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    assert.match(avatarResponse.headers.get('cache-control'), /private/)
    const storedImage = Buffer.from(await avatarResponse.arrayBuffer())
    assert.equal(storedImage.length, avatar.file_size)
    assert.equal(storedImage.includes(Buffer.from(privateMarker)), false)
    assert.equal(storedImage.equals(sourceImage), false)

    const attachmentListResponse = await fetch(`${url}/api/candidates/${created.id}/attachments`)
    assert.equal(attachmentListResponse.status, 200)
    const attachmentList = await attachmentListResponse.json()
    assert.deepEqual(attachmentList.items, [])

    const genericAttachmentResponse = await fetch(`${url}/api/attachments/${avatar.id}/text`)
    assert.equal(genericAttachmentResponse.status, 404)
  } finally {
    server.close()
    await once(server, 'close')
    await app.closeDatabase()
  }
})

test('HTTP PDF upload creates a candidate with its first-page embedded portrait', async () => {
  const file = pdfFileWithAvatar()
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  try {
    const form = new FormData()
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
    const uploadResponse = await fetch(`${url}/api/attachments/previews`, {
      method: 'POST',
      body: form
    })
    assert.equal(uploadResponse.status, 202)
    const pending = await uploadResponse.json()
    const preview = await app.locals.attachments.waitForPreview(pending.preview_id)
    const record = preview.records[0]
    assert.equal(record.match.status, 'not_found')
    assert.deepEqual(record.avatar, {
      status: 'ready',
      available: true,
      source: 'pdf_embedded_image',
      confidence: 'medium',
      candidate_count: 1,
      content_type: 'image/png',
      width: 160,
      height: 200,
      requires_transcoding: true
    })

    const createResponse = await fetch(`${url}/api/attachments/previews/${preview.preview_id}/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preview_token: pending.preview_token,
        record_id: record.record_id,
        candidate: {
          name: 'PDF avatar candidate',
          email: 'pdf.avatar@example.test'
        }
      })
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    assert.equal(created.has_photo, true)
    assert.equal(Object.hasOwn(created, 'photo_url'), false)

    const avatarResponse = await fetch(`${url}/api/candidates/${created.id}/avatar`)
    assert.equal(avatarResponse.status, 200)
    assert.equal(avatarResponse.headers.get('content-type'), 'image/png')
    const storedImage = Buffer.from(await avatarResponse.arrayBuffer())
    assert.equal(storedImage.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true)
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM candidate_attachments
      WHERE candidate_id = ? AND attachment_type = 'avatar'
    `).get(created.id).count, 1)
  } finally {
    server.close()
    await once(server, 'close')
    await app.closeDatabase()
  }
})

test('HTTP candidate creation never returns an explicit signed avatar URL', async () => {
  const secretUrl = 'https://images.example.test/avatar.png?signature=http-response-secret'
  const app = createApp({
    databasePath: ':memory:',
    attachmentSuggestionProvider: null
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  try {
    const pending = app.locals.attachments.createPreview({
      file: csvFile([{
        name: 'Remote avatar response candidate',
        email: 'remote.avatar.response@example.test',
        photo_url: secretUrl
      }], {
        filename: 'remote-avatar-response.csv',
        headers: ['name', 'email', 'photo_url']
      })
    })
    const preview = await app.locals.attachments.waitForPreview(pending.preview_id)
    const input = {
      preview_token: preview.preview_token,
      record_id: preview.records[0].record_id,
      candidate: {
        name: 'Remote avatar response candidate',
        email: 'remote.avatar.response@example.test'
      }
    }

    let candidateId
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${url}/api/attachments/previews/${preview.preview_id}/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
      assert.equal(response.status, 201)
      assert.match(response.headers.get('cache-control'), /no-store/)
      const candidate = await response.json()
      candidateId ??= candidate.id
      assert.equal(candidate.id, candidateId)
      assert.equal(candidate.has_photo, true)
      assert.equal(Object.hasOwn(candidate, 'photo_url'), false)
      assert.equal(JSON.stringify(candidate).includes('http-response-secret'), false)
    }

    assert.equal(app.locals.db.prepare(`
      SELECT photo_url FROM candidates WHERE id = ?
    `).get(candidateId).photo_url, secretUrl)
  } finally {
    server.close()
    await once(server, 'close')
    await app.closeDatabase()
  }
})

test('default attachment Worker honors AbortSignal while parsing', async () => {
  const file = csvFile([{ name: 'Abortable worker candidate' }], { filename: 'abortable-worker.csv' })
  const validated = validateAttachmentFile(file)
  const controller = new AbortController()
  const parsing = parseAttachment(file, validated, ATTACHMENT_LIMITS, { signal: controller.signal })
  controller.abort()
  await assert.rejects(parsing, (error) => {
    assert.equal(error.code, 'parse_aborted')
    return true
  })
})

test('local parser extracts anonymous PDF, DOCX, XLSM, BIFF8 XLS, UTF-8 CSV, and TXT fixtures', async () => {
  const pdf = await parseFixture(pdfFile())
  assert.equal(pdf.validated.format, 'pdf')
  assert.match(pdf.parsed.text, /Anonymous PDF resume with local parser evidence/)
  assert.equal(pdf.parsed.metadata.page_count, 1)
  assert.equal(pdf.parsed.records.length, 1)

  const docx = await parseFixture(await docxFile())
  assert.equal(docx.validated.format, 'docx')
  assert.match(docx.parsed.text, /Anonymous DOCX resume with local parser evidence/)
  assert.equal(docx.parsed.records.length, 1)

  const xlsm = await parseFixture(await xlsmFile([{
    name: 'Anonymous XLSM Candidate',
    phone: '13800000101',
    email: 'anonymous.xlsm@example.test',
    current_company: 'Anonymous Workbook Studio',
    location: 'Shanghai'
  }]))
  assert.equal(xlsm.validated.format, 'xlsm')
  assert.equal(xlsm.parsed.metadata.row_count, 1)
  assert.equal(xlsm.parsed.records[0].values.email, 'anonymous.xlsm@example.test')
  assert.match(xlsm.parsed.text, /Anonymous Workbook Studio/)
  assert.equal(xlsm.parsed.text.includes('ANONYMOUS_VBA_SENTINEL_MUST_NOT_EXECUTE'), false)

  const xls = await parseFixture(xlsFile())
  assert.equal(xls.validated.format, 'xls')
  assert.deepEqual(xls.parsed.metadata.headers, ['Emitente', 'Taxa', 'Data'])
  assert.equal(xls.parsed.metadata.row_count, 3)
  assert.match(xls.parsed.text, /Emitente:/)

  const csv = await parseFixture(csvFile([{
    name: 'Anonymous UTF-8 Candidate',
    phone: '13800000102',
    email: 'anonymous.csv@example.test',
    current_company: 'UTF-8 Studio',
    location: '上海',
    self_summary: 'UTF-8 resume evidence'
  }]))
  assert.equal(csv.validated.format, 'csv')
  assert.equal(csv.parsed.metadata.row_count, 1)
  assert.equal(csv.parsed.records[0].values.location, '上海')
  assert.match(csv.parsed.text, /UTF-8 resume evidence/)

  const txt = await parseFixture({
    originalname: 'anonymous-resume.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('姓名：匿名候选人\n手机：未提取\n邮箱：anonymous.txt@example.test', 'utf8')
  })
  assert.equal(txt.validated.format, 'txt')
  assert.equal(txt.parsed.records.length, 1)
  assert.match(txt.parsed.text, /anonymous\.txt@example\.test/)
})

test('DOCX, XLSX, CSV, and TXT previews keep deterministic pipeline routing', async () => {
  const { service } = createAnonymousFixture({
    suggestionProvider: null,
    visualSuggestionProvider: null
  })
  const files = [
    await docxFile('Name: Anonymous DOCX Pipeline\nEmail: docx.pipeline@example.test\nWork Experience: Example Studio'),
    await xlsxFile([{
      name: 'Anonymous XLSX Pipeline',
      email: 'xlsx.pipeline@example.test',
      current_company: 'Example Workbook Studio'
    }], { filename: 'anonymous-pipeline.xlsx' }),
    csvFile([{
      name: 'Anonymous CSV Pipeline',
      email: 'csv.pipeline@example.test',
      current_company: 'Example CSV Studio'
    }], { filename: 'anonymous-pipeline.csv' }),
    {
      originalname: 'anonymous-pipeline.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('Name: Anonymous TXT Pipeline\nEmail: txt.pipeline@example.test\nProject Experience: Example delivery', 'utf8')
    }
  ]

  for (const file of files) {
    const preview = await createReadyPreview(service, { file })
    assert.equal(preview.pipeline.text.status, 'ready', file.originalname)
    assert.equal(preview.pipeline.text.content_type, preview.file.format, file.originalname)
    assert.deepEqual(preview.pipeline.text_model, { status: 'not_run' }, file.originalname)
    assert.deepEqual(preview.pipeline.visual, {
      status: 'not_applicable',
      used_fallback: false
    }, file.originalname)
    assert.equal(preview.pipeline.review_required, false, file.originalname)
    assert.equal(preview.review_required, false, file.originalname)
    assert.equal(preview.records.length > 0, true, file.originalname)
  }
})

test('attachment validation and workers safely reject spoofed, damaged, textless, encrypted, and oversized files', async () => {
  const workbook = await xlsxFile([{ name: 'Spoofed workbook' }])
  const spoofed = captureError(() => validateAttachmentFile({
    ...workbook,
    originalname: 'renamed-workbook.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }))
  assert.equal(spoofed.status, 422)
  assert.equal(spoofed.code, 'signature_mismatch')

  const mimeMismatch = captureError(() => validateAttachmentFile({
    ...pdfFile(),
    mimetype: 'text/plain'
  }))
  assert.equal(mimeMismatch.status, 415)
  assert.equal(mimeMismatch.code, 'mime_mismatch')

  const damagedPdf = {
    originalname: 'damaged.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nthis is not a complete PDF', 'ascii')
  }
  await assert.rejects(parseFixture(damagedPdf), (error) => {
    assert.equal(error.status, 422)
    assert.equal(error.code, 'pdf_parse_failed')
    return true
  })

  await assert.rejects(parseFixture(pdfFile('')), (error) => {
    assert.equal(error.status, 422)
    assert.equal(error.code, 'pdf_no_text')
    return true
  })

  await assert.rejects(parseFixture(pdfFile('Encrypted anonymous PDF resume', { encrypted: true })), (error) => {
    assert.equal(error.status, 422)
    assert.equal(error.code, 'encrypted_pdf_unsupported')
    return true
  })

  const oleContainer = Buffer.alloc(512)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(oleContainer)
  const encryptedOffice = captureError(() => validateAttachmentFile({
    originalname: 'password-protected.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: oleContainer
  }))
  assert.equal(encryptedOffice.status, 422)
  assert.equal(encryptedOffice.code, 'encrypted_office_unsupported')

  await assert.rejects(parseFixture({
    originalname: 'damaged.xls',
    mimetype: 'application/vnd.ms-excel',
    buffer: oleContainer
  }), (error) => {
    assert.equal(error.status, 422)
    assert.equal(error.code, 'xls_encrypted_or_invalid')
    return true
  })

  const invalidUtf8 = captureError(() => validateAttachmentFile({
    originalname: 'invalid-utf8.csv',
    mimetype: 'text/csv',
    buffer: Buffer.from([0xff, 0xfe, 0xfd])
  }))
  assert.equal(invalidUtf8.status, 422)
  assert.equal(invalidUtf8.code, 'invalid_csv_encoding')

  const invalidTxt = captureError(() => validateAttachmentFile({
    originalname: 'invalid-utf8.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from([0xff, 0xfe, 0xfd])
  }))
  assert.equal(invalidTxt.status, 422)
  assert.equal(invalidTxt.code, 'invalid_text_encoding')

  const oversized = captureError(() => validateAttachmentFile({
    originalname: 'oversized.csv',
    mimetype: 'text/csv',
    buffer: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1, 0x61)
  }))
  assert.equal(oversized.status, 413)
  assert.equal(oversized.code, 'file_too_large')
})

test('CSV preview applies phone/email identity rules without writing candidate data', async () => {
  const { db, service } = createAnonymousFixture()
  addCandidate(db, 'email-only', { email: 'email.only@example.test' })
  addCandidate(db, 'phone-only', { phone: normalizePhone('13800000001') })
  addCandidate(db, 'both', {
    phone: normalizePhone('13800000002'),
    email: 'both@example.test'
  })
  addCandidate(db, 'conflict-phone', {
    phone: normalizePhone('13800000003'),
    email: 'conflict.phone@example.test'
  })
  addCandidate(db, 'conflict-email', {
    phone: normalizePhone('13800000004'),
    email: 'conflict.email@example.test'
  })
  addCandidate(db, 'duplicate-one', { email: 'duplicate@example.test' })
  addCandidate(db, 'duplicate-two', { email: 'duplicate@example.test' })

  const before = db.prepare(`
    SELECT COUNT(*) AS candidates,
           (SELECT COUNT(*) FROM candidate_attachments) AS attachments,
           (SELECT COUNT(*) FROM candidate_field_sources) AS field_sources
    FROM candidates
  `).get()
  const preview = await createReadyPreview(service, {
    file: csvFile([
      { name: 'Email only row', email: ' EMAIL.ONLY@EXAMPLE.TEST ' },
      { name: 'Phone only row', phone: '138 0000 0001' },
      { name: 'Both row', phone: '+86 138 0000 0002', email: 'both@example.test' },
      { name: 'Conflict row', phone: '13800000003', email: 'conflict.email@example.test' },
      { name: 'Duplicate row', email: 'duplicate@example.test' },
      { name: 'Missing row', phone: '13800000999', email: 'missing@example.test' }
    ])
  })

  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.records.map((record) => record.match.status), [
    'single_identity',
    'single_identity',
    'high_confidence',
    'identity_conflict',
    'multiple_matches',
    'not_found'
  ])
  assert.deepEqual(preview.records.slice(0, 3).map((record) => record.match.candidate_id), [
    'email-only',
    'phone-only',
    'both'
  ])
  assert.deepEqual(preview.records[0].identity, { phone: '', email: 'email.only@example.test' })
  assert.deepEqual(preview.records[1].identity, { phone: '+8613800000001', email: '' })
  assert.deepEqual(preview.records[2].identity, {
    phone: '+8613800000002',
    email: 'both@example.test'
  })

  const after = db.prepare(`
    SELECT COUNT(*) AS candidates,
           (SELECT COUNT(*) FROM candidate_attachments) AS attachments,
           (SELECT COUNT(*) FROM candidate_field_sources) AS field_sources
    FROM candidates
  `).get()
  assert.deepEqual({ ...after }, { ...before }, 'preview must not mutate candidate or attachment records')
  assert.equal(db.prepare(`SELECT parse_status FROM attachment_update_previews WHERE id = ?`).get(preview.preview_id).parse_status, 'parsed')
})

test('attachment identity ignores display placeholders before validation, deduplication, and ambiguity checks', () => {
  const { db } = createAnonymousFixture()
  addCandidate(db, 'placeholder-phone', { phone: normalizePhone('13800000061') })
  addCandidate(db, 'placeholder-email', { email: 'placeholder@example.test' })

  const phone = matchCandidateIdentity(db, {
    phone_candidates: ['未提取', '  ', '138 0000 0061', '13800000061'],
    email_candidates: [],
    ambiguous: true
  })
  assert.equal(phone.status, 'single_identity')
  assert.equal(phone.candidate_id, 'placeholder-phone')

  const email = matchCandidateIdentity(db, {
    phone_candidates: [],
    email_candidates: ['未提取', 'PLACEHOLDER@EXAMPLE.TEST', 'placeholder@example.test'],
    ambiguous: true
  })
  assert.equal(email.status, 'single_identity')
  assert.equal(email.candidate_id, 'placeholder-email')

  const missing = matchCandidateIdentity(db, {
    phone_candidates: ['未提取', ' '],
    email_candidates: ['未提取'],
    ambiguous: true
  })
  assert.equal(missing.status, 'not_found')
  assert.match(missing.reason, /未提取到可用手机号或邮箱/)

  const ambiguousPhone = matchCandidateIdentity(db, {
    phone_candidates: ['13800000061', '13900000061'],
    email_candidates: []
  })
  assert.equal(ambiguousPhone.status, 'multiple_matches')

  const ambiguousEmail = matchCandidateIdentity(db, {
    phone_candidates: [],
    email_candidates: ['first@example.test', 'second@example.test']
  })
  assert.equal(ambiguousEmail.status, 'multiple_matches')
})

test('attachment identity drops placeholders even when scalar phone/email fields carry "未提取" or null', () => {
  const { db } = createAnonymousFixture()
  addCandidate(db, 'scalar-phone', { phone: normalizePhone('13800000061'), email: 'scalar@example.test' })

  // scalar phone/email field carries a placeholder string while candidates list is empty
  const scalar = matchCandidateIdentity(db, {
    phone: '未提取',
    email: '未提取',
    phone_candidates: ['138 0000 0061'],
    email_candidates: ['Scalar@Example.Test']
  })
  assert.equal(scalar.status, 'high_confidence')
  assert.equal(scalar.candidate_id, 'scalar-phone')

  // explicit nulls / undefined / empty scalars stay missing
  const nullish = matchCandidateIdentity(db, {
    phone: null,
    email: undefined,
    phone_candidates: [null, ''],
    email_candidates: [null, '  ']
  })
  assert.equal(nullish.status, 'not_found')
  assert.match(nullish.reason, /未提取到可用手机号或邮箱/)

  // placeholder mixed with whitespace inside candidates arrays
  const mixedPhone = matchCandidateIdentity(db, {
    phone_candidates: ['未提取', '138 0000 0061', '  未提取  '],
    email_candidates: ['scalar@example.test']
  })
  assert.equal(mixedPhone.status, 'high_confidence')
  assert.equal(mixedPhone.candidate_id, 'scalar-phone')
})

test('text resume identity ignores employment dates while retaining domestic and international phones', async () => {
  const parser = async (file) => {
    const text = file.buffer.toString('utf8')
    return {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: {}
    }
  }
  const { db, service } = createAnonymousFixture({ parser })
  addCandidate(db, 'dated-domestic', { phone: normalizePhone('138 0000 0032') })
  addCandidate(db, 'dated-international', { phone: normalizePhone('+44 20 7946 0958') })

  const domestic = await createReadyPreview(service, {
    file: {
      originalname: 'dated-domestic.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from('姓名：测试甲\n手机：138 0000 0032\n工作经历：2018-2020、2020-2024', 'utf8')
    }
  })
  assert.equal(domestic.records[0].match.status, 'single_identity')
  assert.equal(domestic.records[0].match.candidate_id, 'dated-domestic')
  assert.deepEqual(domestic.records[0].identity, { phone: '+8613800000032', email: '' })

  const international = await createReadyPreview(service, {
    file: {
      originalname: 'dated-international.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from('Name: Test B\nPhone: +44 20 7946 0958\nExperience: 2016-2019 and 2019-2025', 'utf8')
    }
  })
  assert.equal(international.records[0].match.status, 'single_identity')
  assert.equal(international.records[0].match.candidate_id, 'dated-international')
  assert.deepEqual(international.records[0].identity, { phone: '+442079460958', email: '' })

  const datesOnly = await createReadyPreview(service, {
    file: {
      originalname: 'dates-only.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from('姓名：测试丙\n出生日期：1990-01-02\n工作经历：2018-2020、2020-2024', 'utf8')
    }
  })
  assert.equal(datesOnly.records[0].match.status, 'not_found')
  assert.deepEqual(datesOnly.records[0].identity, { phone: '', email: '' })
})

test('text resume identity treats placeholder labels as missing and rejects numeric resume noise', async () => {
  const parser = async (file) => {
    const text = file.buffer.toString('utf8')
    return {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: {}
    }
  }
  const { db, service } = createAnonymousFixture({ parser })
  addCandidate(db, 'placeholder-email-match', { email: 'placeholder.match@example.test' })
  addCandidate(db, 'scalar-phone', { phone: normalizePhone('13800000061'), email: 'scalar@example.test' })

  const labeledPlaceholder = await createReadyPreview(service, {
    file: {
      originalname: 'placeholder-label.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '姓名：匿名候选人',
        '手机：未提取',
        '邮箱：placeholder.match@example.test',
        '项目经历：2021.09-2022.08，UE 4.26，版本 4.23，序号 123456789'
      ].join('\n'), 'utf8')
    }
  })
  assert.equal(labeledPlaceholder.records[0].match.status, 'single_identity')
  assert.equal(labeledPlaceholder.records[0].match.candidate_id, 'placeholder-email-match')
  assert.equal(Object.hasOwn(labeledPlaceholder.records[0], 'identity_candidates'), false)
  assert.deepEqual(labeledPlaceholder.records[0].identity, {
    phone: '',
    email: 'placeholder.match@example.test'
  })

  const spacedLabels = await createReadyPreview(service, {
    file: {
      originalname: 'spaced-placeholder-label.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '姓名：匿名候选人',
        '手 机：未提取',
        '邮\n箱：placeholder.match@example.test',
        '项目经历：2021.09-2022.08，版本 4.26，序号 123456789'
      ].join('\n'), 'utf8')
    }
  })
  assert.equal(spacedLabels.records[0].match.status, 'single_identity')
  assert.equal(spacedLabels.records[0].match.candidate_id, 'placeholder-email-match')
  assert.deepEqual(spacedLabels.records[0].identity, {
    phone: '',
    email: 'placeholder.match@example.test'
  })

  const pdfInlineLabels = await createReadyPreview(service, {
    file: {
      originalname: 'pdf-inline-labels.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '姓名：匿名候选人 性 别：男 移动电话：13800000061',
        '专 业：软件工程 电 子 邮 箱：scalar@example.test',
        '项目经历：https://example.test/article/13900000061'
      ].join('\n'), 'utf8')
    }
  })
  assert.equal(pdfInlineLabels.records[0].match.status, 'high_confidence')
  assert.equal(pdfInlineLabels.records[0].match.candidate_id, 'scalar-phone')
  assert.deepEqual(pdfInlineLabels.records[0].identity, {
    phone: '+8613800000061',
    email: 'scalar@example.test'
  })

  const bodyEmailNoise = await createReadyPreview(service, {
    file: {
      originalname: 'body-email-noise.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '姓名：匿名候选人',
        '手机：未提取',
        '邮箱：placeholder.match@example.test',
        '项目经历：联系项目邮箱 project.contact@example.test，版本 4.26，序号 123456789'
      ].join('\n'), 'utf8')
    }
  })
  assert.equal(bodyEmailNoise.records[0].match.status, 'single_identity')
  assert.equal(bodyEmailNoise.records[0].match.candidate_id, 'placeholder-email-match')
  assert.deepEqual(bodyEmailNoise.records[0].identity, {
    phone: '',
    email: 'placeholder.match@example.test'
  })

  const ordinaryEmailPhrase = await createReadyPreview(service, {
    file: {
      originalname: 'ordinary-email-phrase.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '姓名：匿名候选人',
        '手机：未提取',
        '邮箱：placeholder.match@example.test',
        '项目邮箱：project.contact@example.test，版本 4.26'
      ].join('\n'), 'utf8')
    }
  })
  assert.equal(ordinaryEmailPhrase.records[0].match.status, 'single_identity')
  assert.equal(ordinaryEmailPhrase.records[0].match.candidate_id, 'placeholder-email-match')

  const singleLineBodyEmail = await createReadyPreview(service, {
    file: {
      originalname: 'single-line-body-email.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('姓名：匿名候选人 手机：未提取 邮箱：placeholder.match@example.test 项目邮箱：project.contact@example.test 版本：4.26', 'utf8')
    }
  })
  assert.equal(singleLineBodyEmail.records[0].match.status, 'single_identity')
  assert.equal(singleLineBodyEmail.records[0].match.candidate_id, 'placeholder-email-match')

  const unlabeledNoise = await createReadyPreview(service, {
    file: {
      originalname: 'unlabeled-noise.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        'Anonymous resume placeholder.match@example.test',
        'Project 2021.09-2022.08; engine 4.26; build 123456789; sequence 1234-5678-9012'
      ].join('\n'), 'utf8')
    }
  })
  assert.equal(unlabeledNoise.records[0].match.status, 'single_identity')
  assert.equal(unlabeledNoise.records[0].match.candidate_id, 'placeholder-email-match')
  assert.deepEqual(unlabeledNoise.records[0].identity, {
    phone: '',
    email: 'placeholder.match@example.test'
  })

  const allMissing = await createReadyPreview(service, {
    file: {
      originalname: 'all-placeholder.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('姓名：匿名候选人\n手机：未提取\n邮箱：未提取', 'utf8')
    }
  })
  assert.equal(allMissing.records[0].match.status, 'not_found')
  assert.deepEqual(allMissing.records[0].identity, { phone: '', email: '' })

  const realAmbiguity = await createReadyPreview(service, {
    file: {
      originalname: 'two-real-phones.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('姓名：匿名候选人\n手机：13800000061、13900000061', 'utf8')
    }
  })
  assert.equal(realAmbiguity.records[0].match.status, 'multiple_matches')
})

test('text resume fields and sections use shared boundaries and preserve source order', async () => {
  const resumeText = [
    '姓名：匿名候选人 意向岗位:数据分析 邮箱：boundary.resume@example.test 当前公司:匿名数据公司 当前职位：数据分析师',
    '自我评价：善于从真实数据中验证结论 技能/荣誉：SQL；Python',
    '• 匿名数据竞赛一等奖',
    '工作经历：2024.01-2025.01 匿名科技 数据分析师',
    '负责项目指标分析，正文中的教育和技能只是普通词语。',
    '项目经历：匿名增长分析项目',
    '建立可复核的数据看板。',
    '教育经历  匿名大学 统计学 本科'
  ].join('\n')
  const parser = async () => ({
    text: resumeText,
    records: [{ row_number: 1, values: { raw_text: resumeText } }],
    metadata: {}
  })
  const { db, service } = createAnonymousFixture({ parser, suggestionProvider: null })
  addCandidate(db, 'boundary-candidate', { email: 'boundary.resume@example.test' })
  const preview = await createReadyPreview(service, {
    file: csvFile([{ name: 'Boundary source' }], { filename: 'boundary-source.csv' })
  })
  const record = preview.records[0]
  const suggestions = Object.fromEntries(record.suggestions.map((item) => [item.field, item]))

  assert.equal(record.match.status, 'single_identity')
  assert.equal(suggestions.name.value, '匿名候选人')
  assert.deepEqual(suggestions.desired_titles.value, ['数据分析'])
  assert.equal(suggestions.current_company.value, '匿名数据公司')
  assert.equal(suggestions.current_title.value, '数据分析师')
  assert.equal(suggestions.self_summary.value, '善于从真实数据中验证结论')
  assert.equal(suggestions.name.evidence.includes('意向岗位'), false)
  assert.equal(suggestions.self_summary.evidence.includes('技能/荣誉'), false)
  assert.deepEqual(record.sections.map((section) => section.section_type), [
    'skill',
    'experience',
    'project',
    'education'
  ])
  assert.deepEqual(record.sections.map((section) => section.structured_data.source_order), [0, 1, 2, 3])
  assert.match(record.sections[0].content, /匿名数据竞赛一等奖/)
  assert.equal(record.sections[0].content.includes('工作经历'), false)
  assert.match(record.sections[1].content, /正文中的教育和技能只是普通词语/)
  assert.equal(record.sections[1].content.includes('项目经历'), false)
  assert.equal(record.sections[0].default_selected, true)
})

test('confirmation replaces selected imported section families, preserves manual and unselected sections, and is idempotent', async () => {
  const resumeText = [
    '邮箱：ordered.resume@example.test 意向岗位：数据分析师',
    '教育经历：匿名大学 统计学 本科',
    '技能/荣誉：SQL；Python；匿名竞赛一等奖',
    '工作经历：匿名科技 数据分析师',
    '项目经历：本次未选择的匿名项目',
    '自我评价：以真实证据为依据完成分析'
  ].join('\n')
  const parser = async () => ({
    text: resumeText,
    records: [{ row_number: 1, values: { raw_text: resumeText } }],
    metadata: {}
  })
  const { db, service } = createAnonymousFixture({ parser, suggestionProvider: null })
  const candidate = addCandidate(db, 'ordered-candidate', {
    email: 'ordered.resume@example.test',
    self_summary: '旧自我评价'
  })
  const timestamp = new Date().toISOString()
  const insertSection = db.prepare(`
    INSERT INTO candidate_profile_sections(
      id, candidate_id, section_type, title, content, structured_data, sort_order,
      sensitivity, source_record_id, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?, ?, NULL)
  `)
  insertSection.run(
    'old-imported-experience', candidate.id, 'experience', '旧导入工作经历', '旧导入工作内容',
    JSON.stringify({ parser: 'old-import' }), 0, 'source:old-import', timestamp, timestamp
  )
  insertSection.run(
    'manual-work-section', candidate.id, 'work_experience', '手工补充工作经历', '必须保留的手工内容',
    '{}', 1, null, timestamp, timestamp
  )
  insertSection.run(
    'manual-parser-metadata-section', candidate.id, 'work_experience', '手工结构化工作经历', '带本地编辑器元数据的手工内容',
    JSON.stringify({ parser: 'manual-editor' }), 2, null, timestamp, timestamp
  )
  insertSection.run(
    'unselected-project-section', candidate.id, 'project_experience', '旧项目经历', '未选择更新的项目内容',
    JSON.stringify({ parser: 'old-import' }), 3, 'source:old-import', timestamp, timestamp
  )

  const preview = await createReadyPreview(service, {
    file: csvFile([{ name: 'Ordered source' }], { filename: 'ordered-source.csv' })
  })
  const record = preview.records[0]
  const selectedSections = record.sections
    .filter((section) => section.section_type !== 'project')
    .map((section) => section.section_id)
  const result = service.confirmPreview(preview.preview_id, confirmationFor(preview, candidate.id, {
    selected_fields: ['desired_titles', 'self_summary'],
    selected_sections: selectedSections,
    merge_mode: 'merge'
  }))
  assert.equal(result.records[0].inserted_section_ids.length, 3)

  const active = db.prepare(`
    SELECT id, section_type, title, content, sort_order, source_record_id, structured_data
    FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL
    ORDER BY sort_order, created_at, id
  `).all(candidate.id)
  assert.deepEqual(active.slice(0, 3).map((section) => section.section_type), [
    'education', 'skill', 'experience'
  ])
  assert.deepEqual(active.map((section) => section.sort_order), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(active.slice(3).map((section) => section.id), [
    'manual-work-section', 'manual-parser-metadata-section', 'unselected-project-section'
  ])
  assert.equal(db.prepare(`
    SELECT archived_at IS NOT NULL AS archived FROM candidate_profile_sections WHERE id = ?
  `).get('old-imported-experience').archived, 1)
  assert.equal(db.prepare(`
    SELECT archived_at FROM candidate_profile_sections WHERE id = ?
  `).get('manual-work-section').archived_at, null)
  assert.equal(db.prepare(`
    SELECT archived_at FROM candidate_profile_sections WHERE id = ?
  `).get('manual-parser-metadata-section').archived_at, null)
  assert.equal(db.prepare(`
    SELECT archived_at FROM candidate_profile_sections WHERE id = ?
  `).get('unselected-project-section').archived_at, null)

  const summary = db.prepare(`SELECT self_summary FROM candidates WHERE id = ?`).get(candidate.id).self_summary
  const summarySection = active.find((section) => section.section_type === 'self_summary')
  assert.equal(summary, '以真实证据为依据完成分析')
  assert.equal(summarySection, undefined)
  assert.deepEqual(JSON.parse(db.prepare(`
    SELECT desired_titles FROM candidate_preferences WHERE candidate_id = ?
  `).get(candidate.id).desired_titles), ['数据分析师'])

  const repeatedPreview = await createReadyPreview(service, {
    file: csvFile([{ name: 'Ordered source' }], { filename: 'ordered-source-again.csv' })
  })
  const repeatedRecord = repeatedPreview.records[0]
  const repeated = service.confirmPreview(repeatedPreview.preview_id, confirmationFor(
    repeatedPreview,
    candidate.id,
    {
      selected_fields: [],
      selected_sections: repeatedRecord.sections
        .filter((section) => section.section_type !== 'project')
        .map((section) => section.section_id),
      merge_mode: 'merge'
    }
  ))
  assert.equal(repeated.records[0].duplicate, true)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL
  `).get(candidate.id).count, 6)
})

test('desired title updates preserve unrelated preferences and audit exact previous and new arrays', async () => {
  const resumeText = '邮箱：preference.audit@example.test 意向岗位：数据分析师、商业分析师'
  const parser = async () => ({
    text: resumeText,
    records: [{ row_number: 1, values: { raw_text: resumeText } }],
    metadata: {}
  })
  const { db, service } = createAnonymousFixture({ parser, suggestionProvider: null })
  const candidate = addCandidate(db, 'preference-audit', {
    email: 'preference.audit@example.test',
    expected_salary: '25K'
  })
  db.prepare(`
    INSERT INTO candidate_preferences(
      candidate_id, employment_status, desired_titles, desired_locations,
      employment_type, expected_salary, availability, raw_payload, updated_at
    ) VALUES (?, 'available', ?, ?, 'full_time', '25K', 'two_weeks', ?, ?)
  `).run(
    candidate.id,
    JSON.stringify(['旧岗位']),
    JSON.stringify(['杭州']),
    JSON.stringify({ retained: true }),
    candidate.updated_at
  )

  const preview = await createReadyPreview(service, {
    file: csvFile([{ name: 'Preference audit source' }], { filename: 'preference-audit.csv' })
  })
  const result = service.confirmPreview(preview.preview_id, confirmationFor(preview, candidate.id, {
    selected_fields: ['desired_titles'],
    selected_sections: []
  }))
  assert.deepEqual(result.records[0].changed_fields, ['desired_titles'])

  const preference = db.prepare(`
    SELECT employment_status, desired_titles, desired_locations, employment_type,
           expected_salary, availability, raw_payload
    FROM candidate_preferences WHERE candidate_id = ?
  `).get(candidate.id)
  assert.deepEqual({
    ...preference,
    desired_titles: JSON.parse(preference.desired_titles),
    desired_locations: JSON.parse(preference.desired_locations),
    raw_payload: JSON.parse(preference.raw_payload)
  }, {
    employment_status: 'available',
    desired_titles: ['数据分析师', '商业分析师'],
    desired_locations: ['杭州'],
    employment_type: 'full_time',
    expected_salary: '25K',
    availability: 'two_weeks',
    raw_payload: { retained: true }
  })
  const source = db.prepare(`
    SELECT previous_value, new_value FROM candidate_field_sources
    WHERE candidate_id = ? AND field_name = 'desired_titles'
  `).get(candidate.id)
  assert.deepEqual(JSON.parse(source.previous_value), ['旧岗位'])
  assert.deepEqual(JSON.parse(source.new_value), ['数据分析师', '商业分析师'])
})

test('desired title, attachment, provenance, and section changes roll back together after a later section failure', async () => {
  const resumeText = [
    '邮箱：preference.rollback@example.test 意向岗位：新岗位',
    '工作经历：本次事务不得保存的工作内容'
  ].join('\n')
  const parser = async () => ({
    text: resumeText,
    records: [{ row_number: 1, values: { raw_text: resumeText } }],
    metadata: {}
  })
  const { db, service } = createAnonymousFixture({ parser, suggestionProvider: null })
  const candidate = addCandidate(db, 'preference-rollback', {
    email: 'preference.rollback@example.test'
  })
  db.prepare(`
    INSERT INTO candidate_preferences(candidate_id, desired_titles, updated_at)
    VALUES (?, ?, ?)
  `).run(candidate.id, JSON.stringify(['旧岗位']), candidate.updated_at)
  const preview = await createReadyPreview(service, {
    file: csvFile([{ name: 'Preference rollback source' }], { filename: 'preference-rollback.csv' })
  })
  const record = preview.records[0]
  const error = captureError(() => service.confirmPreview(preview.preview_id, confirmationFor(
    preview,
    candidate.id,
    {
      selected_fields: ['desired_titles'],
      selected_sections: record.sections.map((section) => section.section_id),
      merge_mode: 'replace'
    }
  )))
  assert.equal(error.status, 422)
  assert.equal(error.code, 'replace_confirmation_required')
  assert.deepEqual(JSON.parse(db.prepare(`
    SELECT desired_titles FROM candidate_preferences WHERE candidate_id = ?
  `).get(candidate.id).desired_titles), ['旧岗位'])
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_attachments`).get().count, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_field_sources`).get().count, 0)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ?
  `).get(candidate.id).count, 0)
  assert.equal(db.prepare(`
    SELECT parse_status FROM attachment_update_previews WHERE id = ?
  `).get(preview.preview_id).parse_status, 'parsed')
})

test('unmatched records can be confirmed against a manually selected or newly created candidate', async () => {
  const { db, service } = createAnonymousFixture()
  const existing = addCandidate(db, 'manual-existing', { current_company: 'Existing Studio' })
  const manualPreview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Manual selection source',
      phone: '13800000888',
      email: 'unmatched.manual@example.test',
      self_summary: 'Manual selection attachment'
    }], { filename: 'manual-selection.csv' })
  })
  assert.equal(manualPreview.records[0].match.status, 'not_found')

  const manualResult = service.confirmPreview(manualPreview.preview_id, confirmationFor(
    manualPreview,
    existing.id,
    { expected_updated_at: existing.updated_at }
  ))
  assert.equal(manualResult.records[0].candidate_id, existing.id)
  assert.equal(manualResult.records[0].duplicate, false)

  const createPreview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'New candidate from attachment',
      self_summary: 'New candidate attachment'
    }], { filename: 'create-candidate.csv' })
  })
  assert.equal(createPreview.records[0].match.status, 'not_found')
  const created = addCandidate(db, 'created-after-preview', { name: 'New candidate from attachment' })
  const createResult = service.confirmPreview(createPreview.preview_id, confirmationFor(
    createPreview,
    created.id,
    { expected_updated_at: created.updated_at }
  ))
  assert.equal(createResult.records[0].candidate_id, created.id)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_attachments WHERE candidate_id IN (?, ?)
  `).get(existing.id, created.id).count, 2)
})

test('an unmatched preview creates one candidate idempotently and can then attach the resume', async () => {
  const { db, service } = createAnonymousFixture({ suggestionProvider: null })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Created from unmatched attachment',
      phone: '13800000771',
      email: 'created.unmatched@example.test',
      current_company: 'Attachment Studio',
      self_summary: 'Created candidate resume evidence'
    }], { filename: 'create-unmatched-candidate.csv' })
  })
  const record = preview.records[0]
  assert.equal(record.match.status, 'not_found')
  const input = {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: {
      name: 'Created from unmatched attachment',
      phone: '13800000771',
      email: 'created.unmatched@example.test',
      current_company: 'Attachment Studio'
    }
  }

  const created = await service.createCandidateFromPreview(preview.preview_id, input)
  assert.equal(created.name, input.candidate.name)
  assert.equal(created.phone, '+8613800000771')
  assert.equal(created.email, input.candidate.email)
  assert.equal(created.source_system, 'attachment_preview')
  assert.equal(created.source_record_id, `attachment-preview:${preview.preview_id}:${record.record_id}`)

  const recovered = service.getPreview(preview.preview_id)
  assert.equal(recovered.records[0].match.status, 'not_found')
  assert.equal(recovered.records[0].match.resolution, 'created')
  assert.equal(recovered.records[0].match.candidate_id, created.id)
  assert.equal(recovered.records[0].match.candidate.id, created.id)
  assert.equal(recovered.records[0].suggestions.every((suggestion) => suggestion.default_selected === false), true)

  const replay = await service.createCandidateFromPreview(preview.preview_id, input)
  assert.equal(replay.id, created.id)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 1)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM activities
    WHERE candidate_id = ? AND type = 'candidate_created_from_attachment'
  `).get(created.id).count, 1)
  assert.equal(db.prepare(`
    SELECT parse_status FROM attachment_update_previews WHERE id = ?
  `).get(preview.preview_id).parse_status, 'parsed')

  const confirmed = service.confirmPreview(preview.preview_id, confirmationFor(recovered, created.id, {
    expected_updated_at: created.updated_at
  }))
  assert.equal(confirmed.records[0].candidate_id, created.id)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_attachments
    WHERE candidate_id = ? AND attachment_type = 'resume'
  `).get(created.id).count, 1)
})

test('concurrent avatar candidate creation converges without duplicate rows or orphan files', async () => {
  const { db, service, root } = createAnonymousFixture({ suggestionProvider: null })
  const file = await docxFileWithAvatar([
    'Name: Concurrent avatar candidate',
    'Email: concurrent.avatar@example.test'
  ].join('\n'), attachmentAvatarPng())
  const preview = await createReadyPreview(service, { file })
  const record = preview.records[0]
  assert.equal(record.match.status, 'not_found')
  assert.equal(record.avatar.available, true)
  const input = {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: {
      name: 'Concurrent avatar candidate',
      email: 'concurrent.avatar@example.test'
    }
  }

  const [first, second] = await Promise.all([
    service.createCandidateFromPreview(preview.preview_id, input),
    service.createCandidateFromPreview(preview.preview_id, input)
  ])
  assert.equal(second.id, first.id)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 1)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_attachments
    WHERE candidate_id = ? AND attachment_type = 'avatar'
  `).get(first.id).count, 1)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM activities
    WHERE candidate_id = ? AND type = 'candidate_created_from_attachment'
  `).get(first.id).count, 1)
  assert.equal(readdirSync(join(root, 'files')).length, 1)
})

test('avatar candidate creation cleans the staged file when BEGIN IMMEDIATE fails', async () => {
  const { db, service, root } = createAnonymousFixture({ suggestionProvider: null })
  const file = await docxFileWithAvatar([
    'Name: Begin failure avatar candidate',
    'Email: begin.failure.avatar@example.test'
  ].join('\n'), attachmentAvatarPng())
  const preview = await createReadyPreview(service, { file })
  const record = preview.records[0]
  assert.equal(record.match.status, 'not_found')
  assert.equal(record.avatar.available, true)

  const originalExec = db.exec
  let beginFailed = false
  db.exec = function injectedBeginFailure(sql) {
    if (!beginFailed && String(sql).trim().toUpperCase() === 'BEGIN IMMEDIATE') {
      beginFailed = true
      assert.equal(readdirSync(join(root, 'files')).length, 1, 'avatar must be staged before BEGIN')
      const error = new Error('injected BEGIN IMMEDIATE failure')
      error.code = 'SQLITE_BUSY'
      throw error
    }
    return originalExec.call(this, sql)
  }

  try {
    await assert.rejects(
      service.createCandidateFromPreview(preview.preview_id, {
        preview_token: preview.preview_token,
        record_id: record.record_id,
        candidate: {
          name: 'Begin failure avatar candidate',
          email: 'begin.failure.avatar@example.test'
        }
      }),
      (error) => error?.code === 'SQLITE_BUSY'
    )
  } finally {
    db.exec = originalExec
  }

  assert.equal(beginFailed, true)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_attachments`).get().count, 0)
  assert.equal(readdirSync(join(root, 'files')).length, 0)

  const retried = await service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: {
      name: 'Begin failure avatar candidate',
      email: 'begin.failure.avatar@example.test'
    }
  })
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_attachments
    WHERE candidate_id = ? AND attachment_type = 'avatar'
  `).get(retried.id).count, 1)
  assert.equal(readdirSync(join(root, 'files')).length, 1)
})

test('avatar candidate rollback queues durable cleanup when physical removal fails', async () => {
  const { db, service, root } = createAnonymousFixture({ suggestionProvider: null })
  const file = await docxFileWithAvatar([
    'Name: Queued cleanup avatar candidate',
    'Email: queued.cleanup.avatar@example.test'
  ].join('\n'), attachmentAvatarPng())
  const preview = await createReadyPreview(service, { file })
  const record = preview.records[0]
  assert.equal(record.avatar.available, true)

  const originalExec = db.exec
  let blockedAvatarPath = null
  db.exec = function injectedBeginAndUnlinkFailure(sql) {
    if (!blockedAvatarPath && String(sql).trim().toUpperCase() === 'BEGIN IMMEDIATE') {
      const [stagedAvatar] = readdirSync(join(root, 'files'))
      blockedAvatarPath = join(root, 'files', stagedAvatar)
      rmSync(blockedAvatarPath, { force: true })
      mkdirSync(blockedAvatarPath)
      const error = new Error('injected BEGIN IMMEDIATE failure')
      error.code = 'SQLITE_BUSY'
      throw error
    }
    return originalExec.call(this, sql)
  }

  try {
    await assert.rejects(
      service.createCandidateFromPreview(preview.preview_id, {
        preview_token: preview.preview_token,
        record_id: record.record_id,
        candidate: {
          name: 'Queued cleanup avatar candidate',
          email: 'queued.cleanup.avatar@example.test'
        }
      }),
      (error) => error?.code === 'SQLITE_BUSY'
    )
  } finally {
    db.exec = originalExec
  }

  assert.ok(blockedAvatarPath)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 0)
  const pending = db.prepare(`
    SELECT * FROM attachment_cleanup_jobs
    WHERE storage_path = ? AND completed_at IS NULL
  `).get(blockedAvatarPath)
  assert.ok(pending)
  assert.equal(pending.reason, 'attachment_candidate_create_rollback')

  rmSync(blockedAvatarPath, { recursive: true, force: true })
  assert.deepEqual(service.processCleanupJobs(), { attempted: 1, completed: 1, failed: 0 })
  assert.ok(db.prepare(`
    SELECT completed_at FROM attachment_cleanup_jobs WHERE id = ?
  `).get(pending.id).completed_at)
})

test('candidate creation is blocked when the preview identity starts matching later', async () => {
  const { db, service } = createAnonymousFixture({ suggestionProvider: null })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Late identity match',
      email: 'late.identity@example.test'
    }], { filename: 'late-identity-match.csv' })
  })
  const record = preview.records[0]
  assert.equal(record.match.status, 'not_found')
  const existing = addCandidate(db, 'late-identity-existing', {
    name: 'Existing candidate added after preview',
    email: 'late.identity@example.test'
  })

  await assert.rejects(
    service.createCandidateFromPreview(preview.preview_id, {
      preview_token: preview.preview_token,
      record_id: record.record_id,
      candidate: {
        name: 'Must not be created',
        email: 'late.identity@example.test'
      }
    }),
    (error) => error?.status === 409 && error?.code === 'single_identity'
  )
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 1)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM activities WHERE type = 'candidate_created_from_attachment'
  `).get().count, 0)
  assert.equal(db.prepare(`SELECT id FROM candidates`).get().id, existing.id)
})

test('candidate creation revalidates preview expiry after asynchronous avatar recovery', async () => {
  let clockMs = Date.parse('2026-08-14T10:00:00.000Z')
  let parserCalls = 0
  let finishRecovery
  const recoveryGate = new Promise((resolve) => { finishRecovery = resolve })
  const rawText = [
    'Name: Expiring avatar candidate',
    'photo_url: https://images.example.test/avatar.png?signature=expiring-secret',
    'Professional profile with enough text for attachment parsing'
  ].join('\n')
  const parser = async () => {
    parserCalls += 1
    if (parserCalls === 2) await recoveryGate
    return {
      text: rawText,
      records: [{ row_number: 1, values: { raw_text: rawText } }],
      metadata: {}
    }
  }
  const { db, service } = createAnonymousFixture({
    parser,
    clock: () => clockMs,
    previewTtlMs: 1_000,
    suggestionProvider: null
  })
  const preview = await createReadyPreview(service, {
    file: {
      originalname: 'expiring-avatar.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from(rawText, 'utf8')
    }
  })
  assert.equal(preview.records[0].avatar.available, true)

  const creating = service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: preview.records[0].record_id,
    candidate: { name: 'Must not survive expiry' }
  })
  while (parserCalls < 2) await new Promise((resolve) => setImmediate(resolve))
  clockMs += 2_000
  finishRecovery()

  await assert.rejects(creating, (error) => error?.code === 'attachment_preview_expired')
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 0)
  assert.equal(db.prepare(`
    SELECT parse_status FROM attachment_update_previews WHERE id = ?
  `).get(preview.preview_id).parse_status, 'expired')
})

test('public previews and suggestion-model context never expose attachment avatar secrets', async () => {
  let modelPayload = null
  const { db, service } = createAnonymousFixture({
    suggestionProvider: async (payload) => {
      modelPayload = payload
      return { records: [] }
    }
  })
  const secretUrl = 'https://images.example.test/candidates/avatar.png?signature=private-avatar-value'
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Avatar privacy candidate',
      email: 'avatar.privacy@example.test',
      photo_url: secretUrl,
      portfolio: secretUrl
    }], {
      filename: 'avatar-privacy.csv',
      headers: ['name', 'email', 'photo_url', 'portfolio']
    })
  })

  assert.deepEqual(preview.records[0].avatar, {
    status: 'ready',
    available: true,
    source: 'explicit_url',
    confidence: 'high',
    candidate_count: 1
  })
  for (const publicValue of [preview, service.getPreview(preview.preview_id), modelPayload]) {
    const serialized = JSON.stringify(publicValue)
    assert.equal(serialized.includes(secretUrl), false)
    assert.equal(serialized.includes('private-avatar-value'), false)
  }
  assert.match(modelPayload.extracted_text, /photo_url: \[redacted\]/)
  assert.match(modelPayload.extracted_text, /portfolio: \[redacted\]/)
  assert.equal(JSON.stringify(preview.records[0]).includes('photo_url'), false)
  const durablePreview = db.prepare(`
    SELECT parse_status, extracted_text, records_json
    FROM attachment_update_previews WHERE id = ?
  `).get(preview.preview_id)
  assert.equal(durablePreview.parse_status, 'parsed')
  for (const durableValue of [durablePreview.extracted_text, durablePreview.records_json]) {
    assert.equal(durableValue.includes(secretUrl), false)
    assert.equal(durableValue.includes('private-avatar-value'), false)
  }

  const created = await service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: preview.records[0].record_id,
    candidate: {
      name: 'Avatar privacy candidate',
      email: 'avatar.privacy@example.test'
    }
  })
  const confirmed = service.confirmPreview(preview.preview_id, confirmationFor(preview, created.id, {
    expected_updated_at: created.updated_at
  }))
  const attachment = db.prepare(`
    SELECT extracted_text FROM candidate_attachments WHERE id = ?
  `).get(confirmed.attachment_ids[0])
  const searchDocument = db.prepare(`
    SELECT content FROM candidate_resume_documents WHERE document_id = ?
  `).get(`attachment:${confirmed.attachment_ids[0]}`)
  const searchIndex = db.prepare(`
    SELECT content FROM candidate_resume_fts WHERE document_id = ?
  `).get(`attachment:${confirmed.attachment_ids[0]}`)
  for (const durableValue of [attachment.extracted_text, searchDocument.content, searchIndex.content]) {
    assert.equal(durableValue.includes(secretUrl), false)
    assert.equal(durableValue.includes('private-avatar-value'), false)
  }
})

test('invalid labeled avatar URLs are still redacted from model and durable text', async () => {
  let modelPayload = null
  const { db, service } = createAnonymousFixture({
    suggestionProvider: async (payload) => {
      modelPayload = payload
      return { records: [] }
    }
  })
  const secretUrl = 'https://images.example.test/private/avatar?signature=invalid-avatar-secret'
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Invalid avatar privacy candidate',
      photo_url: secretUrl,
      portfolio: secretUrl
    }], {
      filename: 'invalid-avatar-privacy.csv',
      headers: ['name', 'photo_url', 'portfolio']
    })
  })

  assert.equal(preview.records[0].avatar.status, 'invalid')
  const durable = db.prepare(`
    SELECT extracted_text, records_json FROM attachment_update_previews WHERE id = ?
  `).get(preview.preview_id)
  for (const value of [JSON.stringify(preview), JSON.stringify(modelPayload), durable.extracted_text, durable.records_json]) {
    assert.equal(value.includes(secretUrl), false)
    assert.equal(value.includes('invalid-avatar-secret'), false)
  }
})

test('TXT avatar secrets repeated under non-avatar labels are globally redacted', async () => {
  let modelPayload = null
  const { db, service } = createAnonymousFixture({
    suggestionProvider: async (payload) => {
      modelPayload = payload
      return { records: [] }
    }
  })
  const secretUrl = 'https://images.example.test/candidates/avatar.png?signature=txt-private-avatar-value'
  const preview = await createReadyPreview(service, {
    file: {
      originalname: 'avatar-portfolio.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        'Name: TXT avatar privacy candidate',
        'Email: txt.avatar.privacy@example.test',
        `avatar_url: ${secretUrl}`,
        `portfolio: ${secretUrl}`
      ].join('\n'), 'utf8')
    }
  })

  assert.equal(preview.records[0].avatar.available, true)
  assert.equal(preview.records[0].avatar.source, 'explicit_url')
  assert.match(modelPayload.extracted_text, /avatar_url: \[redacted\]/)
  assert.match(modelPayload.extracted_text, /portfolio: \[redacted\]/)
  for (const value of [
    JSON.stringify(modelPayload),
    JSON.stringify(preview),
    ...Object.values(db.prepare(`
      SELECT extracted_text, records_json FROM attachment_update_previews WHERE id = ?
    `).get(preview.preview_id))
  ]) {
    assert.equal(String(value).includes(secretUrl), false)
    assert.equal(String(value).includes('txt-private-avatar-value'), false)
  }
})

test('explicit URL avatars are recovered by reparsing quarantine after service restart', async () => {
  const fixture = createAnonymousFixture({ suggestionProvider: null })
  const secretUrl = 'https://images.example.test/candidates/restart-avatar.png?signature=restart-private-value'
  const preview = await createReadyPreview(fixture.service, {
    file: csvFile([{
      name: 'Restart avatar candidate',
      email: 'restart.avatar@example.test',
      photo_url: secretUrl
    }], {
      filename: 'restart-avatar.csv',
      headers: ['name', 'email', 'photo_url']
    })
  })
  const issuedToken = preview.preview_token
  const recordId = preview.records[0].record_id
  assert.equal(preview.records[0].avatar.available, true)
  await fixture.service.close()

  const restarted = createAttachmentService({
    db: fixture.db,
    rootDir: fixture.root,
    suggestionProvider: null,
    cleanupIntervalMs: 60 * 60 * 1000
  })
  fixture.service = restarted
  const recoveredPreview = restarted.getPreview(preview.preview_id)
  assert.equal(recoveredPreview.status, 'ready')
  assert.equal(recoveredPreview.preview_token, '')

  const created = await restarted.createCandidateFromPreview(preview.preview_id, {
    preview_token: issuedToken,
    record_id: recordId,
    candidate: {
      name: 'Restart avatar candidate',
      email: 'restart.avatar@example.test'
    }
  })
  assert.equal(fixture.db.prepare(`
    SELECT photo_url FROM candidates WHERE id = ?
  `).get(created.id).photo_url, secretUrl)
})

test('CSV confirmation writes only selected non-empty fields, provenance, attachment, and FTS text', async () => {
  const { db, service } = createAnonymousFixture()
  const candidate = addCandidate(db, 'csv-confirm', {
    phone: normalizePhone('13800000010'),
    email: 'csv.confirm@example.test',
    current_company: null,
    location: 'Existing location',
    self_summary: 'Existing summary'
  })
  const file = csvFile([{
    name: candidate.name,
    phone: '13800000010',
    email: 'CSV.CONFIRM@EXAMPLE.TEST',
    current_company: 'Updated Studio',
    location: '',
    self_summary: ''
  }])
  const preview = await createReadyPreview(service, { file })
  const record = preview.records[0]
  assert.equal(record.match.status, 'high_confidence')
  assert.ok(record.suggestions.some((suggestion) => suggestion.field === 'current_company'))
  assert.equal(record.suggestions.some((suggestion) => suggestion.field === 'location' && suggestion.value === ''), false)
  assert.equal(db.prepare(`SELECT current_company FROM candidates WHERE id = ?`).get(candidate.id).current_company, null)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_attachments`).get().count, 0)

  const result = service.confirmPreview(preview.preview_id, confirmationFor(preview, candidate.id, {
    selected_fields: ['current_company']
  }))
  assert.equal(result.committed_records, 1)
  assert.equal(result.records[0].duplicate, false)
  assert.deepEqual(result.records[0].changed_fields, ['current_company'])
  const confirmedPreview = db.prepare(`
    SELECT parse_status, extracted_text, records_json FROM attachment_update_previews WHERE id = ?
  `).get(preview.preview_id)
  assert.deepEqual({ ...confirmedPreview }, {
    parse_status: 'confirmed',
    extracted_text: '',
    records_json: '[]'
  })

  const updated = db.prepare(`
    SELECT current_company, location, self_summary FROM candidates WHERE id = ?
  `).get(candidate.id)
  assert.deepEqual({ ...updated }, {
    current_company: 'Updated Studio',
    location: 'Existing location',
    self_summary: 'Existing summary'
  })
  const attachment = db.prepare(`SELECT * FROM candidate_attachments WHERE candidate_id = ?`).get(candidate.id)
  assert.ok(attachment)
  assert.equal(attachment.original_filename, 'anonymous-resumes.csv')
  assert.equal(attachment.sha256, preview.file.sha256)
  assert.match(attachment.extracted_text, /Updated Studio/)
  assert.equal(existsSync(attachment.storage_path), true)

  const source = db.prepare(`SELECT * FROM candidate_field_sources WHERE candidate_id = ?`).get(candidate.id)
  assert.equal(source.field_name, 'current_company')
  assert.equal(source.attachment_id, attachment.id)
  assert.equal(JSON.parse(source.previous_value), null)
  assert.equal(JSON.parse(source.new_value), 'Updated Studio')
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_resume_documents
    WHERE document_id = ? AND content LIKE '%Updated Studio%'
  `).get(`attachment:${attachment.id}`).count, 1)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_resume_fts
    WHERE document_id = ? AND candidate_resume_fts MATCH 'Updated'
  `).get(`attachment:${attachment.id}`).count, 1)
})

test('attachment salary updates keep candidate preferences synchronized', async () => {
  const { db, service } = createAnonymousFixture()
  const candidate = addCandidate(db, 'salary-sync', {
    phone: normalizePhone('13800000033'),
    email: 'salary.sync@example.test',
    expected_salary: '20K'
  })
  db.prepare(`
    INSERT INTO candidate_preferences(candidate_id, expected_salary, updated_at)
    VALUES (?, ?, ?)
  `).run(candidate.id, '20K', candidate.updated_at)
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: candidate.name,
      phone: '13800000033',
      email: 'salary.sync@example.test',
      expected_salary: '30K'
    }], {
      filename: 'salary-sync.csv',
      headers: ['name', 'phone', 'email', 'expected_salary']
    })
  })
  const result = service.confirmPreview(preview.preview_id, confirmationFor(preview, candidate.id, {
    selected_fields: ['expected_salary']
  }))
  assert.deepEqual(result.records[0].changed_fields, ['expected_salary'])
  assert.deepEqual({ ...db.prepare(`
    SELECT c.expected_salary AS candidate_salary,
           p.expected_salary AS preference_salary
    FROM candidates c
    JOIN candidate_preferences p ON p.candidate_id = c.id
    WHERE c.id = ?
  `).get(candidate.id) }, {
    candidate_salary: '30K',
    preference_salary: '30K'
  })
  const source = db.prepare(`
    SELECT previous_value, new_value FROM candidate_field_sources
    WHERE candidate_id = ? AND field_name = 'expected_salary'
  `).get(candidate.id)
  assert.equal(JSON.parse(source.previous_value), '20K')
  assert.equal(JSON.parse(source.new_value), '30K')
})

test('cancelled and expired previews erase staged resume text and structured records', async () => {
  let currentTime = Date.parse('2026-08-05T00:00:00.000Z')
  const { db, service } = createAnonymousFixture({
    clock: () => currentTime,
    previewTtlMs: 1_000
  })
  const cancelledPreview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Anonymous Cancelled Preview',
      email: 'cancelled.preview@example.test',
      self_summary: 'Sensitive staged cancelled resume text'
    }], { filename: 'cancelled-preview.csv' })
  })
  const cancelledBefore = db.prepare(`
    SELECT quarantine_path, extracted_text, records_json
    FROM attachment_update_previews WHERE id = ?
  `).get(cancelledPreview.preview_id)
  assert.equal(existsSync(cancelledBefore.quarantine_path), true)
  assert.match(cancelledBefore.extracted_text, /Sensitive staged cancelled resume text/)
  assert.notEqual(cancelledBefore.records_json, '[]')
  assert.deepEqual(service.cancelPreview(cancelledPreview.preview_id), {
    cancelled: true,
    preview_id: cancelledPreview.preview_id
  })
  const cancelledAfter = db.prepare(`
    SELECT parse_status, quarantine_path, extracted_text, records_json, consumed_at
    FROM attachment_update_previews WHERE id = ?
  `).get(cancelledPreview.preview_id)
  assert.equal(cancelledAfter.parse_status, 'cancelled')
  assert.equal(cancelledAfter.quarantine_path, null)
  assert.equal(cancelledAfter.extracted_text, '')
  assert.equal(cancelledAfter.records_json, '[]')
  assert.ok(cancelledAfter.consumed_at)
  assert.equal(existsSync(cancelledBefore.quarantine_path), false)

  const expiredPreview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Anonymous Expired Preview',
      email: 'expired.preview@example.test',
      self_summary: 'Sensitive staged expired resume text'
    }], { filename: 'expired-preview.csv' })
  })
  const expiredBefore = db.prepare(`
    SELECT quarantine_path, extracted_text, records_json
    FROM attachment_update_previews WHERE id = ?
  `).get(expiredPreview.preview_id)
  assert.equal(existsSync(expiredBefore.quarantine_path), true)
  assert.match(expiredBefore.extracted_text, /Sensitive staged expired resume text/)
  assert.notEqual(expiredBefore.records_json, '[]')
  currentTime += 1_000
  assert.equal(service.cleanupExpiredPreviews(), 1)
  const expiredAfter = db.prepare(`
    SELECT parse_status, quarantine_path, extracted_text, records_json, consumed_at
    FROM attachment_update_previews WHERE id = ?
  `).get(expiredPreview.preview_id)
  assert.equal(expiredAfter.parse_status, 'expired')
  assert.equal(expiredAfter.quarantine_path, null)
  assert.equal(expiredAfter.extracted_text, '')
  assert.equal(expiredAfter.records_json, '[]')
  assert.ok(expiredAfter.consumed_at)
  assert.equal(existsSync(expiredBefore.quarantine_path), false)
})

test('confirming an expired preview reports expiry instead of replay after cleanup', async () => {
  let currentTime = Date.parse('2026-08-05T00:00:00.000Z')
  const { service } = createAnonymousFixture({
    clock: () => currentTime,
    previewTtlMs: 1_000
  })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Anonymous Confirm Expired',
      email: 'confirm.expired@example.test'
    }], { filename: 'confirm-expired.csv' })
  })
  currentTime += 1_000

  assert.throws(
    () => service.confirmPreview(preview.preview_id, {
      preview_token: preview.preview_token,
      records: [{
        record_id: preview.records[0].record_id,
        candidate_id: 'missing-candidate',
        expected_updated_at: '',
        selected_fields: [],
        selected_sections: [],
        merge_mode: 'merge'
      }]
    }),
    (error) => error?.code === 'attachment_preview_expired'
  )
})

test('cancelling an expired preview reports expiry and leaves the expired terminal state', async () => {
  let currentTime = Date.parse('2026-08-05T00:00:00.000Z')
  const { db, service } = createAnonymousFixture({
    clock: () => currentTime,
    previewTtlMs: 1_000
  })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Anonymous Cancel Expired',
      email: 'cancel.expired@example.test'
    }], { filename: 'cancel-expired.csv' })
  })
  currentTime += 1_000

  assert.throws(
    () => service.cancelPreview(preview.preview_id),
    (error) => error?.code === 'attachment_preview_expired'
  )
  assert.equal(db.prepare('SELECT parse_status FROM attachment_update_previews WHERE id = ?').get(preview.preview_id).parse_status, 'expired')
})

test('creating a candidate from an expired preview reports expiry after cleanup', async () => {
  let currentTime = Date.parse('2026-08-05T00:00:00.000Z')
  const { service } = createAnonymousFixture({
    clock: () => currentTime,
    previewTtlMs: 1_000
  })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: 'Anonymous Create Expired',
      email: 'create.expired@example.test'
    }], { filename: 'create-expired.csv' })
  })
  currentTime += 1_000

  await assert.rejects(
    service.createCandidateFromPreview(preview.preview_id, {
      preview_token: preview.preview_token,
      record_id: preview.records[0].record_id,
      candidate: { name: 'Anonymous Create Expired' }
    }),
    (error) => error?.code === 'attachment_preview_expired'
  )
})

test('XLSX preview and confirmation use the real local parser and preserve sanitized filenames', async () => {
  const { db, service } = createAnonymousFixture()
  const candidate = addCandidate(db, 'xlsx-confirm', {
    phone: normalizePhone('13800000020'),
    email: 'xlsx.confirm@example.test',
    current_company: null,
    location: 'Hangzhou'
  })
  const file = await xlsxFile([{
    name: candidate.name,
    phone: '13800000020',
    email: 'xlsx.confirm@example.test',
    current_company: 'Workbook Studio',
    location: ''
  }], { filename: '../anonymous-workbook.xlsx' })

  const preview = await createReadyPreview(service, { file })
  assert.equal(preview.file.format, 'xlsx')
  assert.equal(preview.file.original_filename, 'anonymous-workbook.xlsx')
  assert.equal(preview.records[0].match.status, 'high_confidence')
  assert.ok(preview.records[0].suggestions.some((item) => item.field === 'current_company' && item.value === 'Workbook Studio'))
  const result = service.confirmPreview(preview.preview_id, confirmationFor(preview, candidate.id, {
    selected_fields: ['current_company']
  }))

  assert.equal(result.records[0].duplicate, false)
  const updated = db.prepare(`SELECT current_company, location FROM candidates WHERE id = ?`).get(candidate.id)
  assert.deepEqual({ ...updated }, { current_company: 'Workbook Studio', location: 'Hangzhou' })
  const attachment = db.prepare(`SELECT * FROM candidate_attachments WHERE candidate_id = ?`).get(candidate.id)
  assert.equal(attachment.mime_type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.match(attachment.extracted_text, /Workbook Studio/)
  assert.equal(existsSync(attachment.storage_path), true)
})

test('candidate version changes abort confirmation without partial writes', async () => {
  const { db, service } = createAnonymousFixture()
  const candidate = addCandidate(db, 'version-conflict', {
    phone: normalizePhone('13800000030'),
    email: 'version.conflict@example.test',
    current_company: null
  })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: candidate.name,
      phone: '13800000030',
      email: 'version.conflict@example.test',
      current_company: 'Must Not Persist'
    }])
  })
  db.prepare(`UPDATE candidates SET updated_at = ? WHERE id = ?`).run('2099-01-01T00:00:00.000Z', candidate.id)

  const error = captureError(() => service.confirmPreview(
    preview.preview_id,
    confirmationFor(preview, candidate.id, { selected_fields: ['current_company'] })
  ))
  assert.equal(error.status, 409)
  assert.equal(error.code, 'version_conflict')
  assert.equal(db.prepare(`SELECT current_company FROM candidates WHERE id = ?`).get(candidate.id).current_company, null)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_attachments`).get().count, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_field_sources`).get().count, 0)
  assert.equal(db.prepare(`SELECT parse_status FROM attachment_update_previews WHERE id = ?`).get(preview.preview_id).parse_status, 'parsed')
})

test('preview tokens reject replay and repeated SHA-256 submissions stay idempotent', async () => {
  const { db, service } = createAnonymousFixture()
  const candidate = addCandidate(db, 'sha-idempotent', {
    phone: normalizePhone('13800000040'),
    email: 'sha.idempotent@example.test',
    current_company: null
  })
  const file = csvFile([{
    name: candidate.name,
    phone: '13800000040',
    email: 'sha.idempotent@example.test',
    current_company: 'Idempotent Studio'
  }])
  const firstPreview = await createReadyPreview(service, { file })
  const firstInput = confirmationFor(firstPreview, candidate.id, { selected_fields: ['current_company'] })
  const first = service.confirmPreview(firstPreview.preview_id, firstInput)
  assert.equal(first.duplicate_records, 0)

  const replay = captureError(() => service.confirmPreview(firstPreview.preview_id, firstInput))
  assert.equal(replay.status, 409)
  assert.equal(replay.code, 'attachment_preview_replayed')

  const activityCount = db.prepare(`SELECT COUNT(*) AS count FROM activities WHERE candidate_id = ?`).get(candidate.id).count
  const fieldSourceCount = db.prepare(`SELECT COUNT(*) AS count FROM candidate_field_sources WHERE candidate_id = ?`).get(candidate.id).count
  const secondPreview = await createReadyPreview(service, { file })
  const currentVersion = db.prepare(`SELECT updated_at FROM candidates WHERE id = ?`).get(candidate.id).updated_at
  const second = service.confirmPreview(secondPreview.preview_id, {
    preview_token: secondPreview.preview_token,
    records: [{
      record_id: secondPreview.records[0].record_id,
      candidate_id: candidate.id,
      expected_updated_at: currentVersion,
      selected_fields: ['current_company'],
      selected_sections: [],
      merge_mode: 'merge'
    }]
  })

  assert.equal(second.duplicate_records, 1)
  assert.equal(second.records[0].duplicate, true)
  assert.equal(second.records[0].attachment.id, first.records[0].attachment.id)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_attachments WHERE candidate_id = ?`).get(candidate.id).count, 1)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_field_sources WHERE candidate_id = ?`).get(candidate.id).count, fieldSourceCount)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM activities WHERE candidate_id = ?`).get(candidate.id).count, activityCount)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_resume_documents
    WHERE candidate_id = ? AND source_type = 'attachment'
  `).get(candidate.id).count, 1)
})

test('visual fallback keeps confirmable text preview and clears transient page data', async () => {
  const visualBytes = Buffer.from('synthetic visual page bytes', 'utf8')
  const parser = async () => {
    const text = 'Email: visual-fallback@example.test\nWork Experience:\nAnonymous Studio - Analyst - current'
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image: new Uint8Array(visualBytes),
        text,
        text_spans: []
      }],
      enumerable: false
    })
    return parsed
  }
  const { db, service } = createAnonymousFixture({
    parser,
    visualSuggestionProvider: {
      status: () => ({ capability: 'image_input', status: 'enabled' }),
      suggest: async () => ({
        records: [],
        status: 'fallback',
        error_code: 'visual_timeout'
      })
    }
  })
  const preview = await createReadyPreview(service, {
    file: pdfFile('Synthetic parser input', { filename: 'visual-fallback.pdf' })
  })
  assert.equal(preview.pipeline.visual.status, 'fallback')
  assert.equal(preview.pipeline.visual.error_code, 'visual_timeout')
  assert.equal(preview.records[0].identity.email, 'visual-fallback@example.test')
  const stored = db.prepare('SELECT extracted_text, records_json FROM attachment_update_previews WHERE id = ?')
    .get(preview.preview_id)
  assert.match(stored.extracted_text, /visual-fallback@example\.test/)
  assert.doesNotMatch(stored.records_json, /synthetic visual page bytes|image\/png|visual_pages/)
})

test('candidate deletion cascades attachment/FTS/vector rows and queued cleanup removes the physical file', async () => {
  const { db, service } = createAnonymousFixture()
  const candidate = addCandidate(db, 'delete-attachment', {
    phone: normalizePhone('13800000050'),
    email: 'delete.attachment@example.test'
  })
  const preview = await createReadyPreview(service, {
    file: csvFile([{
      name: candidate.name,
      phone: '13800000050',
      email: 'delete.attachment@example.test',
      self_summary: 'Unity overseas resume evidence'
    }])
  })
  const confirmed = service.confirmPreview(
    preview.preview_id,
    confirmationFor(preview, candidate.id)
  )
  const attachmentId = confirmed.attachment_ids[0]
  const attachment = db.prepare(`SELECT * FROM candidate_attachments WHERE id = ?`).get(attachmentId)
  const document = db.prepare(`
    SELECT * FROM candidate_resume_documents WHERE document_id = ?
  `).get(`attachment:${attachmentId}`)
  assert.ok(document)
  assert.equal(existsSync(attachment.storage_path), true)
  const timestamp = new Date().toISOString()
  db.prepare(`
    INSERT INTO candidate_resume_vectors(
      id, candidate_id, document_id, chunk_index, provider, model,
      dimensions, vector, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 'anonymous-test', 'anonymous-vector', 1, ?, ?, ?)
  `).run(randomUUID(), candidate.id, document.document_id, Buffer.from([0]), timestamp, timestamp)

  db.prepare(`UPDATE candidates SET archived_at = ?, updated_at = ? WHERE id = ?`)
    .run(timestamp, timestamp, candidate.id)
  const deletionStore = new DeletionPreviewStore()
  const deletionPreview = previewCandidateDeletion(db, { candidate_ids: [candidate.id] }, deletionStore)
  const deletion = commitCandidateDeletion(db, {
    preview_token: deletionPreview.preview_token
  }, deletionStore)
  assert.equal(deletion.deleted_count, 1)
  assert.equal(deletion.attachment_cleanup_queued_count, 1)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_attachments`).get().count, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_resume_documents WHERE candidate_id = ?`).get(candidate.id).count, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_resume_fts WHERE candidate_id = ?`).get(candidate.id).count, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidate_resume_vectors WHERE candidate_id = ?`).get(candidate.id).count, 0)
  assert.equal(existsSync(attachment.storage_path), true, 'database deletion must leave physical deletion to the retryable queue')

  const pending = db.prepare(`SELECT * FROM attachment_cleanup_jobs WHERE storage_path = ?`).get(attachment.storage_path)
  assert.ok(pending)
  assert.equal(pending.completed_at, null)
  const cleanup = service.processCleanupJobs()
  assert.deepEqual(cleanup, { attempted: 1, completed: 1, failed: 0 })
  assert.equal(existsSync(attachment.storage_path), false)
  const completed = db.prepare(`SELECT * FROM attachment_cleanup_jobs WHERE id = ?`).get(pending.id)
  assert.equal(completed.attempts, 1)
  assert.ok(completed.completed_at)
})

test('failed physical cleanup remains retryable and succeeds on a later pass', () => {
  const { db, service, root } = createAnonymousFixture()
  const retryPath = join(root, 'files', 'retry-target')
  mkdirSync(retryPath)
  service.enqueueCleanup(retryPath, 'anonymous_retry_test')

  assert.deepEqual(service.processCleanupJobs(), { attempted: 1, completed: 0, failed: 1 })
  const failed = db.prepare(`SELECT * FROM attachment_cleanup_jobs WHERE storage_path = ?`).get(retryPath)
  assert.equal(failed.attempts, 1)
  assert.equal(failed.completed_at, null)
  assert.ok(failed.last_error)

  rmSync(retryPath, { recursive: true, force: true })
  writeFileSync(retryPath, 'anonymous cleanup payload', { flag: 'wx' })
  assert.deepEqual(service.processCleanupJobs(), { attempted: 1, completed: 1, failed: 0 })
  const completed = db.prepare(`SELECT * FROM attachment_cleanup_jobs WHERE id = ?`).get(failed.id)
  assert.equal(completed.attempts, 2)
  assert.equal(completed.last_error, null)
  assert.ok(completed.completed_at)
  assert.equal(existsSync(retryPath), false)
})

test('contact suggestions keep same-line adjacent fields out of value and evidence', async () => {
  const parser = async (file) => {
    const text = file.buffer.toString('utf8')
    return {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: {}
    }
  }
  const { service } = createAnonymousFixture({ parser, suggestionProvider: null })
  const preview = await createReadyPreview(service, {
    file: {
      originalname: 'same-line-contact-fields.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '姓名：匿名候选人',
        '手机号：17788859606 专业：软件工程',
        '电子邮箱：455786463@qq.com 身高：170cm 67kg'
      ].join('\n'), 'utf8')
    }
  })

  const suggestions = Object.fromEntries(
    preview.records[0].suggestions.map((item) => [item.field, item])
  )
  assert.equal(suggestions.phone.value, '+8617788859606')
  assert.equal(suggestions.email.value, '455786463@qq.com')
  assert.doesNotMatch(suggestions.phone.value, /专业|软件工程|手机号|[:：]/)
  assert.doesNotMatch(suggestions.email.value, /身高|体重|职位|电子邮箱|[:：]/)
  assert.match(suggestions.phone.evidence, /17788859606/)
  assert.match(suggestions.email.evidence, /455786463@qq\.com/)
  assert.doesNotMatch(suggestions.phone.evidence, /专业|软件工程|电子邮箱|身高|体重/)
  assert.doesNotMatch(suggestions.email.evidence, /手机号|专业|身高|体重|67kg/)

  const numericSuffix = await createReadyPreview(service, {
    file: {
      originalname: 'numeric-suffix-contact.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('Phone: 17700000001 170\\nEmail: numeric.suffix@example.test', 'utf8')
    }
  })
  const numericPhone = numericSuffix.records[0].suggestions.find((item) => item.field === 'phone')
  assert.ok(numericPhone)
  assert.equal(numericPhone.value, '+8617700000001')
  assert.doesNotMatch(numericPhone.value, /170$/)
})

test('model contact suggestions with adjacent text never create contact updates', async () => {
  let modelRecord
  const parser = async () => ({
    text: 'anonymous spreadsheet row',
    records: [{
      row_number: 2,
      values: {
        name: 'Anonymous model row',
        self_summary: '联系方式：17788859606 专业：软件工程；备用手机号：18888888888；电子邮箱：one@example.test 身高：170cm；备用邮箱：two@example.test'
      }
    }],
    metadata: {}
  })
  const suggestionProvider = async (payload) => {
    modelRecord = payload.records[0]
    return {
      records: [{
        record_id: modelRecord.record_id,
        suggestions: [
          {
            field: 'phone',
            value: '17788859606 专业：软件工程',
            confidence: 'high',
            evidence: '联系方式：17788859606 专业：软件工程',
            default_selected: true
          },
          {
            field: 'email',
            value: 'one@example.test 身高：170cm',
            confidence: 'high',
            evidence: '电子邮箱：one@example.test 身高：170cm',
            default_selected: true
          }
        ]
      }]
    }
  }
  const { service } = createAnonymousFixture({ parser, suggestionProvider })
  const preview = await createReadyPreview(service, {
    file: csvFile([{ name: 'Model row' }], { filename: 'model-contact-noise.csv' })
  })
  const record = preview.records[0]
  assert.ok(modelRecord?.record_id)
  assert.equal(record.suggestions.some((item) => item.field === 'phone'), false)
  assert.equal(record.suggestions.some((item) => item.field === 'email'), false)
})

test('ambiguous contacts do not create automatic contact suggestions', async () => {
  let modelRecord
  const parser = async (file) => {
    const text = file.buffer.toString('utf8')
    return {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: {}
    }
  }
  const suggestionProvider = async (payload) => {
    modelRecord = payload.records[0]
    return {
      records: [{
        record_id: modelRecord.record_id,
        suggestions: [
          {
            field: 'phone',
            value: '17788859606',
            confidence: 'high',
            evidence: '手机号：17788859606',
            default_selected: true
          },
          {
            field: 'email',
            value: 'one@example.test',
            confidence: 'high',
            evidence: '电子邮箱：one@example.test',
            default_selected: true
          }
        ]
      }]
    }
  }
  const { service } = createAnonymousFixture({ parser, suggestionProvider })
  const preview = await createReadyPreview(service, {
    file: {
      originalname: 'ambiguous-contact-fields.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from([
        '手机号：17788859606；手机号：18888888888',
        '电子邮箱：one@example.test；电子邮箱：two@example.test'
      ].join('\n'), 'utf8')
    }
  })
  const record = preview.records[0]
  assert.ok(modelRecord?.record_id)
  assert.equal(record.match.status, 'multiple_matches')
  assert.equal(record.suggestions.some((item) => item.field === 'phone'), false)
  assert.equal(record.suggestions.some((item) => item.field === 'email'), false)
})
