import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { deflateSync } from 'node:zlib'
import {
  ATTACHMENT_LIMITS,
  parseAttachment,
  validateAttachmentFile
} from '../../server/attachment-parser.js'
import { createAttachmentService } from '../../server/attachments.js'
import { openDatabase } from '../../server/database.js'

const resources = []

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()
    try { await resource.service?.close() } catch {}
    try { resource.db?.close() } catch {}
    try { rmSync(resource.root, { recursive: true, force: true }) } catch {}
  }
})

function pdfLiteral(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function pdfFile(pages, name = 'anonymous-visual-lifecycle.pdf') {
  const pageObjectIds = pages.map((_, index) => 3 + index * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  ]
  for (const lines of pages) {
    const content = lines.length
      ? [
          'BT',
          '/F1 12 Tf',
          '72 720 Td',
          ...lines.map((line, index) => `${index ? '0 -18 Td ' : ''}(${pdfLiteral(line)}) Tj`),
          'ET'
        ].join('\n')
      : 'q\n0 0 100 100 re f\nQ'
    const pageObjectId = objects.length + 1
    const contentObjectId = pageObjectId + 1
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pages.length * 2 + 3} 0 R >> >> /Contents ${contentObjectId} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, 'ascii'))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output, 'ascii')
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return {
    originalname: name,
    mimetype: 'application/pdf',
    buffer: Buffer.from(output, 'ascii')
  }
}

function imageOnlyPdfFile(name = 'anonymous-image-only.pdf') {
  const width = 160
  const height = 200
  const pixels = Buffer.alloc(width * height * 3)
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 84
    pixels[offset + 1] = 112
    pixels[offset + 2] = 136
  }
  const compressed = deflateSync(pixels)
  const content = Buffer.from([
    'q',
    `${width} 0 0 ${height} 72 500 cm`,
    '/Im1 Do',
    'Q'
  ].join('\n'), 'ascii')
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>', 'ascii'),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`, 'ascii'),
      compressed,
      Buffer.from('\nendstream', 'ascii')
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii')
    ])
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
    originalname: name,
    mimetype: 'application/pdf',
    buffer: Buffer.concat(chunks)
  }
}

function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'attachment-visual-lifecycle-'))
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

test('visual-only page and pixel limits degrade to complete deterministic PDF text', async () => {
  const file = pdfFile([
    ['Anonymous profile page one with searchable text'],
    ['Anonymous profile page two with searchable text']
  ])
  const pageLimited = await parseAttachment(
    file,
    validateAttachmentFile(file),
    { ...ATTACHMENT_LIMITS, maxVisualPdfPages: 1 },
    { renderVisualPages: true, allowTextlessPdf: true }
  )

  assert.match(pageLimited.text, /page one/)
  assert.match(pageLimited.text, /page two/)
  assert.equal(pageLimited.metadata.visual.status, 'fallback')
  assert.equal(pageLimited.metadata.visual.error_code, 'pdf_visual_page_limit')
  assert.equal(pageLimited.visual_pages.length, 0)

  const pixelLimited = await parseAttachment(
    pdfFile([['Anonymous profile remains searchable after visual pixel fallback']]),
    validateAttachmentFile(pdfFile([['Anonymous profile remains searchable after visual pixel fallback']])),
    { ...ATTACHMENT_LIMITS, maxVisualTotalPixels: 100 },
    { renderVisualPages: true, allowTextlessPdf: true }
  )
  assert.match(pixelLimited.text, /remains searchable/)
  assert.equal(pixelLimited.metadata.visual.status, 'fallback')
  assert.equal(pixelLimited.metadata.visual.error_code, 'pdf_visual_total_pixel_limit')
  assert.equal(pixelLimited.visual_pages.length, 0)
})

test('renderer failures keep a retryable visual channel when capability is enabled', async () => {
  const parser = async () => ({
    text: 'Email: renderer-timeout@example.test\nAnonymous searchable profile',
    records: [{
      row_number: 1,
      values: { raw_text: 'Email: renderer-timeout@example.test\nAnonymous searchable profile' }
    }],
    metadata: {
      page_count: 1,
      pdf_content_type: 'text',
      visual: {
        status: 'fallback',
        error_code: 'pdf_visual_render_timeout',
        rendered_page_count: 0
      }
    },
    visual_pages: []
  })
  const visualSuggestionProvider = {
    status: () => ({ capability: 'image_input', status: 'enabled', schema_mode: 'strict' }),
    suggest: async () => ({ records: [], status: 'ready', schema_mode: 'strict' })
  }
  const { service } = createFixture({ parser, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic renderer timeout']], 'anonymous-renderer-timeout.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.visual.status, 'fallback')
  assert.equal(preview.pipeline.visual.error_code, 'pdf_visual_render_timeout')
  assert.equal(preview.pipeline.visual.retryable, true)
})

test('textless PDF can produce an attachment-only parsed record when explicitly allowed', async () => {
  const file = pdfFile([[]], 'anonymous-scan.pdf')
  await assert.rejects(
    parseAttachment(file, validateAttachmentFile(file)),
    (error) => error?.code === 'pdf_no_text'
  )

  const parsed = await parseAttachment(
    file,
    validateAttachmentFile(file),
    ATTACHMENT_LIMITS,
    { allowTextlessPdf: true }
  )
  assert.equal(parsed.metadata.pdf_content_type, 'scanned')
  assert.equal(parsed.text, '')
  assert.equal(parsed.records.length, 1)
})

test('image-only PDF avatar recovery remains textless-safe after service restart', async () => {
  const fixture = createFixture({ suggestionProvider: null, visualSuggestionProvider: null })
  const pending = fixture.service.createPreview({ file: imageOnlyPdfFile() })
  const preview = await fixture.service.waitForPreview(pending.preview_id)
  const record = preview.records[0]

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.text.content_type, 'scanned')
  assert.equal(record.match.status, 'not_found')
  assert.equal(record.avatar.available, true)
  assert.equal(record.avatar.source, 'pdf_embedded_image')

  await fixture.service.close()
  fixture.service = createAttachmentService({
    db: fixture.db,
    rootDir: fixture.root,
    suggestionProvider: null,
    visualSuggestionProvider: null,
    cleanupIntervalMs: 60 * 60 * 1000
  })

  const created = await fixture.service.createCandidateFromPreview(preview.preview_id, {
    preview_token: preview.preview_token,
    record_id: record.record_id,
    candidate: { name: 'Anonymous scanned candidate' }
  })

  assert.match(fixture.db.prepare('SELECT photo_url FROM candidates WHERE id = ?').get(created.id).photo_url, /^attachment-avatar:/)
  assert.equal(fixture.db.prepare(`
    SELECT COUNT(*) AS count FROM candidate_attachments
    WHERE candidate_id = ? AND attachment_type = 'avatar'
  `).get(created.id).count, 1)
})

test('disabled visual capability skips page rendering and returns a safe scanned fallback preview', async () => {
  let parserOptions
  let visualCalls = 0
  const disabledVisualProvider = {
    enabled: false,
    status: () => ({
      capability: 'disabled',
      status: 'disabled',
      error_code: 'visual_capability_disabled',
      parser_version: 'anonymous-visual-v1',
      prompt_version: 'anonymous-prompt-v1'
    }),
    suggest: async () => {
      visualCalls += 1
      return { records: [], status: 'fallback', error_code: 'visual_capability_disabled' }
    }
  }
  const parser = async (file, validated, limits, options) => {
    parserOptions = options
    return parseAttachment(file, validated, limits, options)
  }
  const { service } = createFixture({ parser, visualSuggestionProvider: disabledVisualProvider })
  const pending = service.createPreview({ file: pdfFile([[]], 'anonymous-disabled-scan.pdf') })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(parserOptions.renderVisualPages, false)
  assert.equal(parserOptions.allowTextlessPdf, true)
  assert.equal(visualCalls, 0)
  assert.deepEqual(preview.pipeline.text, { status: 'ready', content_type: 'scanned' })
  assert.equal(preview.pipeline.visual.used_fallback, true)
  assert.equal(preview.pipeline.visual.capability, 'disabled')
  assert.equal(preview.pipeline.visual.error_code, 'visual_capability_disabled')
  assert.equal(preview.pipeline.visual.parser_version, 'anonymous-visual-v1')
  assert.equal(preview.pipeline.visual.prompt_version, 'anonymous-prompt-v1')
  assert.equal(preview.records.length, 1)
})

test('untrusted visual provider status codes are normalized before entering the preview API', async () => {
  const visualSuggestionProvider = {
    enabled: false,
    status: () => ({
      capability: 'disabled',
      status: 'disabled',
      error_code: 'gateway-private-status-detail'
    }),
    suggest: async () => ({ records: [], status: 'fallback', error_code: 'gateway-private-status-detail' })
  }
  const { service } = createFixture({ visualSuggestionProvider })
  const pending = service.createPreview({
    file: imageOnlyPdfFile('anonymous-status-code.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.pipeline.visual.error_code, 'visual_unavailable')
  assert.equal(preview.pipeline.review_required, true)
  assert.doesNotMatch(JSON.stringify(preview), /gateway-private-status-detail/)
})

test('raster memory fallback keeps its stable parser error code in the preview pipeline', async () => {
  let visualCalls = 0
  const visualSuggestionProvider = () => {
    visualCalls += 1
    return { records: [], status: 'ready' }
  }
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled' })
  const parser = async () => ({
    text: 'Email: raster-limit@example.test\nAnonymous searchable profile',
    records: [{
      row_number: 1,
      values: { raw_text: 'Email: raster-limit@example.test\nAnonymous searchable profile' }
    }],
    metadata: {
      page_count: 2,
      pdf_content_type: 'text',
      visual: { status: 'fallback', error_code: 'pdf_visual_total_memory_limit' }
    },
    visual_pages: []
  })
  const { service } = createFixture({ parser, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic raster fallback']], 'anonymous-raster-fallback.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.visual.status, 'fallback')
  assert.equal(preview.pipeline.visual.error_code, 'pdf_visual_total_memory_limit')
  assert.equal(preview.pipeline.review_required, true)
  assert.equal(visualCalls, 0)
})

test('service timeout aborts the visual provider and clears transient page bytes', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  let providerSignal
  let providerStartedResolve
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve })
  const visualSuggestionProvider = async (_input, { signal }) => {
    providerSignal = signal
    providerStartedResolve()
    return new Promise(() => {})
  }
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled' })
  const parser = async () => {
    const parsed = {
      text: 'Name: Anonymous Candidate\nCurrent role: Example Analyst',
      records: [{
        row_number: 1,
        values: { raw_text: 'Name: Anonymous Candidate\nCurrent role: Example Analyst' }
      }],
      metadata: {
        page_count: 1,
        pdf_content_type: 'text',
        visual: { status: 'ready', rendered_page_count: 1 }
      }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image,
        text: parsed.text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({
    parser,
    visualSuggestionProvider,
    visualSuggestionTimeoutMs: 20
  })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic validation only']], 'anonymous-timeout.pdf')
  })
  await providerStarted
  const result = await Promise.race([
    service.waitForPreview(pending.preview_id),
    new Promise((resolve) => setTimeout(() => resolve('deadline'), 300))
  ])

  assert.notEqual(result, 'deadline', 'visual provider did not respect the configured service timeout')
  assert.equal(result.status, 'ready')
  assert.equal(result.pipeline.visual.error_code, 'visual_timeout')
  assert.equal(providerSignal.aborted, true)
  assert.equal(image.every((byte) => byte === 0), true)
})

test('visual page bytes are released before the independent text model request starts', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  let visualSawImage = false
  let textSawReleasedImage = false
  const text = 'Email: release-before-text@example.test\nAnonymous searchable profile'
  const visualSuggestionProvider = ({ visual_pages: pages }) => {
    visualSawImage = pages[0]?.image === image && image.some((byte) => byte !== 0)
    return { records: [], status: 'ready' }
  }
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled' })
  const suggestionProvider = () => {
    textSawReleasedImage = image.every((byte) => byte === 0)
    return { records: [], status: 'ready' }
  }
  const parser = async () => {
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image,
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, suggestionProvider, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic visual lifecycle']], 'anonymous-release-before-text.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.visual.status, 'ready')
  assert.equal(preview.pipeline.text_model.status, 'ready')
  assert.equal(visualSawImage, true, 'visual request must receive the original PNG bytes')
  assert.equal(textSawReleasedImage, true, 'PNG bytes must not survive into the text model request')
})

test('visual provider exceptions return a stable fallback without failing deterministic preview', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const visualSuggestionProvider = () => {
    throw new Error('untrusted gateway details must not reach the preview')
  }
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled' })
  const parser = async () => {
    const text = 'Email: provider-error@example.test\nProject Experience:\nAnonymous delivery'
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image,
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic validation only']], 'anonymous-provider-error.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.visual.status, 'fallback')
  assert.equal(preview.pipeline.visual.error_code, 'visual_unavailable')
  assert.equal(preview.records[0].identity.email, 'provider-error@example.test')
  assert.equal(image.every((byte) => byte === 0), true)
  assert.doesNotMatch(JSON.stringify(preview), /untrusted gateway details/)
})

test('visual provider exceptions preserve stable channel code, retryability, and schema mode', async () => {
  const visualSuggestionProvider = () => {
    const error = new Error('private gateway detail must stay out of the preview')
    error.code = 'visual_timeout'
    error.retryable = true
    error.schema_mode = 'compat'
    throw error
  }
  visualSuggestionProvider.status = () => ({
    capability: 'image_input',
    status: 'enabled',
    schema_mode: 'compat'
  })
  const parser = async () => {
    const text = 'Email: visual-channel-timeout@example.test\nAnonymous searchable profile'
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic visual error boundary']], 'anonymous-visual-error-boundary.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.visual.status, 'fallback')
  assert.equal(preview.pipeline.visual.error_code, 'visual_timeout')
  assert.equal(preview.pipeline.visual.retryable, true)
  assert.equal(preview.pipeline.visual.schema_mode, 'compat')
  assert.equal(preview.pipeline.review_required, true)
  assert.equal(preview.review_required, true)
  assert.doesNotMatch(JSON.stringify(preview), /private gateway detail/)
})

test('visual fallback preserves an explicit non-retryable provider decision', async () => {
  const visualSuggestionProvider = () => ({
    records: [],
    status: 'fallback',
    error_code: 'visual_http_error',
    retryable: false,
    schema_mode: 'strict'
  })
  visualSuggestionProvider.status = () => ({
    capability: 'image_input',
    status: 'enabled',
    schema_mode: 'strict'
  })
  const parser = async () => {
    const text = 'Email: visual-http-client-error@example.test\nAnonymous searchable profile'
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic non-retryable visual error']], 'anonymous-visual-http-400.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.pipeline.visual.error_code, 'visual_http_error')
  assert.equal(preview.pipeline.visual.retryable, false)
  assert.equal(preview.pipeline.visual.schema_mode, 'strict')
})

test('visual ready status without a validated records array is downgraded to schema failure', async () => {
  const visualSuggestionProvider = () => ({ status: 'ready' })
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled', schema_mode: 'strict' })
  const parser = async () => {
    const text = 'Email: visual-ready-without-records@example.test\nAnonymous searchable profile'
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic invalid visual result']], 'anonymous-visual-ready-invalid.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.pipeline.visual.status, 'fallback')
  assert.equal(preview.pipeline.visual.error_code, 'visual_invalid_schema')
  assert.equal(preview.pipeline.visual.retryable, false)
})

test('scanned and mixed PDFs expose explicit review_required when visual coverage is unavailable', async () => {
  const { service } = createFixture({ visualSuggestionProvider: null })
  const scannedPending = service.createPreview({ file: imageOnlyPdfFile('anonymous-review-scan.pdf') })
  const mixedPending = service.createPreview({
    file: pdfFile([
      ['Anonymous searchable page with contact@example.test'],
      []
    ], 'anonymous-review-mixed.pdf')
  })
  const [scanned, mixed] = await Promise.all([
    service.waitForPreview(scannedPending.preview_id),
    service.waitForPreview(mixedPending.preview_id)
  ])

  assert.equal(scanned.status, 'ready')
  assert.equal(scanned.pipeline.text.content_type, 'scanned')
  assert.equal(scanned.pipeline.visual.status, 'fallback')
  assert.equal(scanned.pipeline.review_required, true)
  assert.equal(scanned.review_required, true)
  assert.equal(mixed.status, 'ready')
  assert.equal(mixed.pipeline.text.content_type, 'mixed')
  assert.equal(mixed.pipeline.visual.status, 'fallback')
  assert.equal(mixed.pipeline.review_required, true)
  assert.equal(mixed.review_required, true)
})

test('text suggestion exceptions preserve a ready deterministic preview and let visual parsing report independently', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const text = 'Email: text-failure@example.test\nProject Experience:\nAnonymous delivery'
  const suggestionProvider = () => {
    throw new Error('synthetic text suggestion failure')
  }
  const visualSuggestionProvider = () => ({ records: [], status: 'ready' })
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled' })
  const parser = async () => {
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image,
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, suggestionProvider, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic validation only']], 'anonymous-text-provider-error.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.records[0].identity.email, 'text-failure@example.test')
  assert.equal(preview.pipeline.text_model.status, 'fallback')
  assert.equal(preview.pipeline.text_model.error_code, 'attachment_suggestion_unavailable')
  assert.equal(preview.pipeline.text_model.retryable, true)
  assert.equal(preview.pipeline.visual.status, 'ready')
  assert.equal(preview.pipeline.review_required, true)
  assert.equal(preview.review_required, true)
  assert.equal(image.every((byte) => byte === 0), true)
  assert.doesNotMatch(JSON.stringify(preview), /synthetic text suggestion failure/)
})

test('text model failures are visible as an independent retryable pipeline channel', async () => {
  const text = 'Email: text-channel-status@example.test\nProject Experience:\nAnonymous delivery'
  const suggestionProvider = () => {
    const error = new Error('gateway details must stay private')
    error.code = 'attachment_suggestion_timeout'
    error.retryable = true
    error.schema_mode = 'strict'
    throw error
  }
  const { service } = createFixture({ suggestionProvider, visualSuggestionProvider: null })
  const pending = service.createPreview({
    file: pdfFile([[text]], 'anonymous-text-channel-status.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.text.status, 'ready')
  assert.equal(preview.pipeline.text_model.status, 'fallback')
  assert.equal(preview.pipeline.text_model.error_code, 'attachment_suggestion_timeout')
  assert.equal(preview.pipeline.text_model.retryable, true)
  assert.equal(preview.pipeline.text_model.schema_mode, 'strict')
  assert.equal(preview.pipeline.review_required, true)
  assert.equal(preview.review_required, true)
  assert.doesNotMatch(JSON.stringify(preview), /gateway details must stay private/)
})

test('text suggestions that finish within the adapter budget are not cut off by the attachment wrapper', async () => {
  const suggestionProvider = () => new Promise((resolve) => {
    setTimeout(() => resolve({ records: [], status: 'ready', schema_mode: 'strict' }), 6_000)
  })
  const { service } = createFixture({ suggestionProvider, visualSuggestionProvider: null })
  const pending = service.createPreview({
    file: pdfFile([['Email: delayed-text@example.test']], 'anonymous-delayed-text.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.pipeline.text_model.status, 'ready')
  assert.equal(preview.pipeline.text_model.schema_mode, 'strict')
})

test('text model endpoint policy failures remain explicit and non-retryable', async () => {
  const suggestionProvider = () => {
    const error = new Error('private endpoint details must stay out of the preview')
    error.code = 'attachment_suggestion_endpoint_insecure'
    error.retryable = false
    error.schema_mode = 'strict'
    throw error
  }
  const { service } = createFixture({ suggestionProvider, visualSuggestionProvider: null })
  const pending = service.createPreview({
    file: pdfFile([['Email: endpoint-policy@example.test']], 'anonymous-text-endpoint-policy.pdf')
  })
  const preview = await service.waitForPreview(pending.preview_id)

  assert.equal(preview.pipeline.text_model.status, 'fallback')
  assert.equal(preview.pipeline.text_model.error_code, 'attachment_suggestion_endpoint_insecure')
  assert.equal(preview.pipeline.text_model.retryable, false)
  assert.equal(preview.pipeline.text_model.schema_mode, 'strict')
  assert.doesNotMatch(JSON.stringify(preview), /private endpoint details/)
})

test('aborting during text suggestions releases transient visual page bytes', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const text = 'Email: text-abort@example.test\nAnonymous deterministic content'
  let textSuggestionStartedResolve
  const textSuggestionStarted = new Promise((resolve) => { textSuggestionStartedResolve = resolve })
  let observedSignal
  const suggestionProvider = (_input, { signal }) => {
    observedSignal = signal
    textSuggestionStartedResolve()
    return new Promise(() => {})
  }
  const visualSuggestionProvider = () => ({ records: [], status: 'ready' })
  visualSuggestionProvider.status = () => ({ capability: 'image_input', status: 'enabled' })
  const parser = async () => {
    const parsed = {
      text,
      records: [{ row_number: 1, values: { raw_text: text } }],
      metadata: { page_count: 1, pdf_content_type: 'text' }
    }
    Object.defineProperty(parsed, 'visual_pages', {
      enumerable: false,
      value: [{
        page_number: 1,
        width: 1,
        height: 1,
        pixel_count: 1,
        mime_type: 'image/png',
        image,
        text,
        text_spans: []
      }]
    })
    return parsed
  }
  const { service } = createFixture({ parser, suggestionProvider, visualSuggestionProvider })
  const pending = service.createPreview({
    file: pdfFile([['Synthetic validation only']], 'anonymous-text-abort.pdf')
  })
  await textSuggestionStarted
  service.cancelPreview(pending.preview_id)
  const preview = await service.waitForPreview(pending.preview_id)

  assert.ok(observedSignal, 'text suggestion provider receives an abort signal')
  assert.equal(preview.status, 'cancelled')
  assert.equal(image.every((byte) => byte === 0), true)
})
