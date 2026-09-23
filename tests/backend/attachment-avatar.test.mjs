import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  attachmentAvatarModelContext,
  extractDocxAvatarCandidates,
  extractDocxAvatarSuggestion,
  extractExplicitAvatarSuggestion,
  extractPdfAvatarCandidates,
  extractPdfAvatarSuggestion,
  extractXlsxAvatarCandidates,
  extractXlsxAvatarSuggestions,
  inspectAttachmentAvatarImage,
  materializePrivateAttachmentAvatar,
  projectAttachmentAvatarSuggestion,
  releasePrivateAttachmentAvatar,
  sanitizeMaterializedAttachmentAvatar,
  selectDocxAvatarCandidate,
  selectPdfAvatarCandidate,
  selectXlsxRowAvatarCandidate
} from '../../server/attachment-avatar.js'

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  typeBuffer.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 8 + data.length)
  return output
}

function pngImage(width, height, rgba = [62, 102, 184, 255]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rowLength = 1 + width * 4
  const pixels = Buffer.alloc(rowLength * height)
  for (let row = 0; row < height; row += 1) {
    const start = row * rowLength
    pixels[start] = 0
    for (let column = 0; column < width; column += 1) {
      const offset = start + 1 + column * 4
      pixels[offset] = rgba[0]
      pixels[offset + 1] = rgba[1]
      pixels[offset + 2] = rgba[2]
      pixels[offset + 3] = rgba[3]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND')
  ])
}

function pdfWithRawImages(images) {
  const imageObjects = images.map((image) => {
    const [red, green, blue] = image.rgb ?? [62, 102, 184]
    const pixels = Buffer.alloc(image.width * image.height * 3)
    for (let offset = 0; offset < pixels.length; offset += 3) {
      pixels[offset] = red
      pixels[offset + 1] = green
      pixels[offset + 2] = blue
    }
    const compressed = deflateSync(pixels)
    return Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`, 'ascii'),
      compressed,
      Buffer.from('\nendstream', 'ascii')
    ])
  })
  const content = Buffer.from(images.map((image, index) => (
    `q ${image.width} 0 0 ${image.height} ${40 + index * 220} ${600 - index * 180} cm /Im${index + 1} Do Q`
  )).join('\n'), 'ascii')
  const contentObjectId = 4 + imageObjects.length
  const xObjects = imageObjects.map((_, index) => `/Im${index + 1} ${4 + index} 0 R`).join(' ')
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << ${xObjects} >> >> /Contents ${contentObjectId} 0 R >>`, 'ascii'),
    ...imageObjects,
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
  return Buffer.concat(chunks)
}

function pngImageWithPrivateMetadata(width, height) {
  const image = pngImage(width, height)
  return Buffer.concat([
    image.subarray(0, 33),
    pngChunk('tEXt', Buffer.from('Comment\0private-note')),
    pngChunk('eXIf', Buffer.from('private-exif-location')),
    image.subarray(33)
  ])
}

function jpegSegment(marker, payload) {
  const output = Buffer.alloc(payload.length + 4)
  output[0] = 0xff
  output[1] = marker
  output.writeUInt16BE(payload.length + 2, 2)
  payload.copy(output, 4)
  return output
}

function jpegImageWithPrivateMetadata(width, height) {
  const frame = Buffer.alloc(15)
  frame[0] = 8
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  frame[5] = 3
  frame.set([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1], 6)
  const scan = Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0', 'ascii')),
    jpegSegment(0xe1, Buffer.from('private-exif-gps')),
    jpegSegment(0xe2, Buffer.from('private-icc-profile')),
    jpegSegment(0xfe, Buffer.from('private-comment')),
    jpegSegment(0xc0, frame),
    jpegSegment(0xda, scan),
    Buffer.from([0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44]),
    Buffer.from([0xff, 0xd9])
  ])
}

function webpLosslessImage(width, height) {
  const payload = Buffer.alloc(5)
  payload[0] = 0x2f
  payload.writeUInt32LE((width - 1) | (height - 1) << 14, 1)
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2))
  chunk.write('VP8L', 0, 'ascii')
  chunk.writeUInt32LE(payload.length, 4)
  payload.copy(chunk, 8)
  const output = Buffer.alloc(12 + chunk.length)
  output.write('RIFF', 0, 'ascii')
  output.writeUInt32LE(output.length - 8, 4)
  output.write('WEBP', 8, 'ascii')
  chunk.copy(output, 12)
  return output
}

function xmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function drawingXml(image, index) {
  const id = index + 1
  return `<w:p><w:r><w:drawing><wp:inline>
    <wp:extent cx="1200000" cy="1500000"/>
    <wp:docPr id="${id}" name="Image ${id}" descr="${xmlText(image.altText ?? '')}"/>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <pic:pic><pic:nvPicPr/><pic:blipFill><a:blip r:embed="rIdImage${id}"/></pic:blipFill><pic:spPr/></pic:pic>
    </a:graphicData></a:graphic>
  </wp:inline></w:drawing></w:r></w:p>`
}

async function docxWithImages(images) {
  const archive = new JSZip()
  const extensions = new Map(images.map((image) => [image.extension ?? 'png', image.contentType ?? 'image/png']))
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      ${[...extensions].map(([extension, contentType]) => `<Default Extension="${extension}" ContentType="${contentType}"/>`).join('')}
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  archive.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`)
  archive.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <w:body>
        <w:p><w:r><w:t>Anonymous candidate resume with enough text for parsing</w:t></w:r></w:p>
        ${images.map(drawingXml).join('')}
        <w:sectPr/>
      </w:body>
    </w:document>`)
  archive.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${images.map((image, index) => `<Relationship Id="rIdImage${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.${image.extension ?? 'png'}"/>`).join('')}
    </Relationships>`)
  images.forEach((image, index) => {
    archive.file(`word/media/image${index + 1}.${image.extension ?? 'png'}`, image.buffer)
  })
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function xlsxWithImages(rows) {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Candidates')
  worksheet.addRow(['姓名', '证件照'])
  for (const row of rows) {
    worksheet.addRow([row.name, ''])
    for (const image of row.images ?? []) {
      const imageId = workbook.addImage({
        buffer: image.buffer,
        extension: image.extension ?? 'png'
      })
      worksheet.addImage(imageId, {
        tl: { col: 1, row: worksheet.rowCount - 1 },
        ext: { width: image.displayWidth ?? 120, height: image.displayHeight ?? 150 }
      })
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

test('explicit attachment avatar URLs require labels and remain private until commit', () => {
  const secretUrl = 'https://images.example.test/candidates/photo.jpg?signature=private-value'
  const result = extractExplicitAvatarSuggestion({
    text: `姓名：匿名候选人\n头像地址：${secretUrl}`
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.source, 'explicit_url')
  assert.equal(Object.keys(result).includes('reference'), false)
  assert.equal(JSON.stringify(result).includes(secretUrl), false)
  assert.equal(JSON.stringify(result).includes('private-value'), false)
  assert.deepEqual(projectAttachmentAvatarSuggestion(result), {
    status: 'ready',
    available: true,
    source: 'explicit_url',
    confidence: 'high',
    candidate_count: 1
  })
  assert.deepEqual(materializePrivateAttachmentAvatar(result.reference), {
    kind: 'remote_url',
    photo_url: secretUrl
  })
  assert.equal(attachmentAvatarModelContext(result), null)

  const unlabeled = extractExplicitAvatarSuggestion({ text: `作品集：${secretUrl}` })
  assert.equal(unlabeled.status, 'none')
  assert.equal(JSON.stringify(unlabeled).includes(secretUrl), false)
})

test('explicit attachment avatar extraction handles spreadsheet aliases and ambiguity safely', () => {
  const fromRow = extractExplicitAvatarSuggestion({
    values: { 姓名: '匿名候选人', 证件照: 'http://images.example.test/photo.webp?token=row-secret' }
  })
  assert.equal(fromRow.status, 'ready')
  assert.equal(materializePrivateAttachmentAvatar(fromRow.reference).photo_url, 'http://images.example.test/photo.webp?token=row-secret')

  const ambiguous = extractExplicitAvatarSuggestion({
    records: [
      { values: { photo_url: 'https://images.example.test/a.png?token=first' } },
      { values: { avatar_url: 'https://images.example.test/b.png?token=second' } }
    ]
  })
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.candidate_count, 2)
  assert.equal(JSON.stringify(ambiguous).includes('token='), false)

  const invalid = extractExplicitAvatarSuggestion({ values: { photo_url: 'data:image/png;base64,PRIVATE' } })
  assert.equal(invalid.status, 'invalid')
  assert.equal(JSON.stringify(invalid).includes('PRIVATE'), false)
})

test('image inspection rejects corrupt, mismatched, and oversized image inputs', () => {
  const image = pngImage(160, 200)
  const inspected = inspectAttachmentAvatarImage(image, 'image/png')
  assert.equal(inspected.width, 160)
  assert.equal(inspected.height, 200)
  assert.equal(inspected.content_type, 'image/png')

  const corrupt = Buffer.from(image)
  corrupt[corrupt.length - 1] ^= 0xff
  assert.equal(inspectAttachmentAvatarImage(corrupt, 'image/png'), null)
  assert.equal(inspectAttachmentAvatarImage(image, 'image/jpeg'), null)
  assert.equal(inspectAttachmentAvatarImage(image, 'image/png', { maxPixels: 1_000 }), null)
})

test('DOCX avatar extraction selects a labeled portrait without serializing its bytes', async () => {
  const logo = pngImage(320, 80, [20, 20, 20, 255])
  const portrait = pngImage(160, 200, [122, 76, 62, 255])
  const docx = await docxWithImages([
    { buffer: logo, altText: 'Company logo' },
    { buffer: portrait, altText: '候选人证件照' }
  ])

  const result = await extractDocxAvatarSuggestion(docx)
  assert.equal(result.status, 'ready')
  assert.equal(result.confidence, 'high')
  assert.equal(Object.keys(result).includes('reference'), false)
  assert.equal(JSON.stringify(result).includes(portrait.toString('base64')), false)
  assert.deepEqual(projectAttachmentAvatarSuggestion(result), {
    status: 'ready',
    available: true,
    source: 'docx_embedded_image',
    confidence: 'high',
    candidate_count: 2,
    content_type: 'image/png',
    width: 160,
    height: 200,
    requires_transcoding: true
  })

  const privateAvatar = materializePrivateAttachmentAvatar(result.reference)
  assert.equal(privateAvatar.kind, 'embedded_image')
  assert.equal(privateAvatar.requires_transcoding, true)
  assert.equal(privateAvatar.buffer.equals(portrait), true)
  privateAvatar.buffer.fill(0)
  assert.equal(materializePrivateAttachmentAvatar(result.reference).buffer.equals(portrait), true)

  assert.equal(releasePrivateAttachmentAvatar(result.reference), true)
  assert.throws(
    () => materializePrivateAttachmentAvatar(result.reference),
    (error) => error?.code === 'attachment_avatar_reference_invalid'
  )
})

test('DOCX extraction leaves equally plausible unlabeled portraits ambiguous', async () => {
  const first = pngImage(160, 200, [20, 80, 140, 255])
  const second = pngImage(160, 200, [140, 80, 20, 255])
  const docx = await docxWithImages([
    { buffer: first, altText: '' },
    { buffer: second, altText: '' }
  ])
  const candidates = await extractDocxAvatarCandidates(docx)
  assert.equal(candidates.length, 2)
  assert.equal(JSON.stringify(candidates).includes(first.toString('base64')), false)

  const selected = selectDocxAvatarCandidate(candidates)
  assert.equal(selected.status, 'ambiguous')
  assert.equal(selected.eligible_candidate_count, 2)
  assert.equal(projectAttachmentAvatarSuggestion(selected).available, false)
})

test('DOCX extraction ignores embedded payloads whose declared and actual image types differ', async () => {
  const docx = await docxWithImages([
    {
      buffer: pngImage(160, 200),
      extension: 'jpg',
      contentType: 'image/jpeg',
      altText: 'Candidate photo'
    }
  ])
  const result = await extractDocxAvatarSuggestion(docx)
  assert.equal(result.status, 'none')
  assert.equal(result.candidate_count, 0)
})

test('PDF avatar extraction re-encodes a first-page portrait without exposing decoded pixels', async () => {
  const pdf = pdfWithRawImages([
    { width: 320, height: 80, rgb: [20, 20, 20] },
    { width: 160, height: 200, rgb: [122, 76, 62] }
  ])

  const result = await extractPdfAvatarSuggestion(pdf)
  assert.equal(result.status, 'ready')
  assert.equal(result.confidence, 'medium')
  assert.equal(Object.keys(result).includes('reference'), false)
  assert.equal(JSON.stringify(result).includes(Buffer.alloc(160 * 200 * 3, 122).toString('base64')), false)
  assert.deepEqual(projectAttachmentAvatarSuggestion(result), {
    status: 'ready',
    available: true,
    source: 'pdf_embedded_image',
    confidence: 'medium',
    candidate_count: 2,
    content_type: 'image/png',
    width: 160,
    height: 200,
    requires_transcoding: true
  })

  const materialized = materializePrivateAttachmentAvatar(result.reference)
  assert.equal(materialized.kind, 'embedded_image')
  assert.equal(inspectAttachmentAvatarImage(materialized.buffer, 'image/png').width, 160)
  const sanitized = sanitizeMaterializedAttachmentAvatar(materialized)
  assert.equal(sanitized.metadata_stripped, true)
  assert.equal(sanitized.content_type, 'image/png')
})

test('PDF extraction refuses to guess between equally plausible portraits', async () => {
  const pdf = pdfWithRawImages([
    { width: 160, height: 200, rgb: [30, 90, 150] },
    { width: 160, height: 200, rgb: [150, 90, 30] }
  ])
  const candidates = await extractPdfAvatarCandidates(pdf)
  assert.equal(candidates.length, 2)
  assert.equal(candidates.every((candidate) => candidate.source === 'pdf_embedded_image'), true)

  const selected = selectPdfAvatarCandidate(candidates)
  assert.equal(selected.status, 'ambiguous')
  assert.equal(selected.candidate_count, 2)
  assert.equal(projectAttachmentAvatarSuggestion(selected).available, false)
})

test('XLSX embedded avatars are mapped to candidate rows and kept private', async () => {
  const portrait = pngImage(160, 200, [92, 62, 132, 255])
  const logo = pngImage(320, 80, [10, 10, 10, 255])
  const workbook = await xlsxWithImages([
    { name: 'Candidate A', images: [{ buffer: portrait }] },
    { name: 'Candidate B', images: [{ buffer: logo }] }
  ])

  const candidates = await extractXlsxAvatarCandidates(workbook)
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].sheet_name, 'Candidates')
  assert.equal(candidates[0].row_number, 2)
  assert.equal(candidates[0].column_number, 2)
  assert.equal(candidates[0].avatar_label_hint, true)
  assert.equal(candidates[1].row_number, 3)
  assert.equal(candidates[1].eligible, false)
  assert.equal(JSON.stringify(candidates).includes(portrait.toString('base64')), false)

  const firstRow = selectXlsxRowAvatarCandidate(candidates, { sheetName: 'Candidates', rowNumber: 2 })
  assert.equal(firstRow.status, 'ready')
  assert.equal(firstRow.confidence, 'high')
  assert.equal(materializePrivateAttachmentAvatar(firstRow.reference).buffer.equals(portrait), true)
  assert.deepEqual(projectAttachmentAvatarSuggestion(firstRow), {
    status: 'ready',
    available: true,
    source: 'xlsx_embedded_image',
    confidence: 'high',
    candidate_count: 1,
    content_type: 'image/png',
    width: 160,
    height: 200,
    requires_transcoding: true,
    sheet_name: 'Candidates',
    row_number: 2
  })

  const suggestions = await extractXlsxAvatarSuggestions(workbook)
  assert.equal(suggestions.length, 2)
  assert.equal(suggestions.find((item) => item.row_number === 2).status, 'ready')
  assert.equal(suggestions.find((item) => item.row_number === 3).status, 'none')
  assert.equal(JSON.stringify(suggestions).includes(portrait.toString('base64')), false)
})

test('XLSX row mapping does not choose between equally plausible embedded avatars', async () => {
  const workbook = await xlsxWithImages([{
    name: 'Candidate A',
    images: [
      { buffer: pngImage(160, 200, [30, 90, 150, 255]) },
      { buffer: pngImage(160, 200, [150, 90, 30, 255]) }
    ]
  }])
  const suggestions = await extractXlsxAvatarSuggestions(workbook)
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].status, 'ambiguous')
  assert.equal(suggestions[0].candidate_count, 2)
  assert.equal(projectAttachmentAvatarSuggestion(suggestions[0]).available, false)
})

test('embedded PNG sanitization removes text and EXIF chunks before storage', () => {
  const image = pngImageWithPrivateMetadata(160, 200)
  assert.ok(image.includes(Buffer.from('private-note')))
  assert.ok(image.includes(Buffer.from('private-exif-location')))

  const sanitized = sanitizeMaterializedAttachmentAvatar({
    kind: 'embedded_image',
    buffer: image,
    content_type: 'image/png'
  })
  assert.equal(sanitized.kind, 'sanitized_embedded_image')
  assert.equal(sanitized.metadata_stripped, true)
  assert.equal(sanitized.requires_transcoding, false)
  assert.equal(sanitized.width, 160)
  assert.equal(sanitized.height, 200)
  assert.equal(sanitized.buffer.includes(Buffer.from('private-note')), false)
  assert.equal(sanitized.buffer.includes(Buffer.from('private-exif-location')), false)
  assert.equal(inspectAttachmentAvatarImage(sanitized.buffer, sanitized.content_type).sha256, sanitized.sha256)
})

test('embedded JPEG sanitization removes APP1 through APP15 and comments before storage', () => {
  const image = jpegImageWithPrivateMetadata(160, 200)
  assert.ok(image.includes(Buffer.from('private-exif-gps')))
  assert.ok(image.includes(Buffer.from('private-icc-profile')))
  assert.ok(image.includes(Buffer.from('private-comment')))

  const sanitized = sanitizeMaterializedAttachmentAvatar({
    kind: 'embedded_image',
    buffer: image,
    content_type: 'image/jpeg'
  })
  assert.equal(sanitized.width, 160)
  assert.equal(sanitized.height, 200)
  assert.equal(sanitized.buffer.includes(Buffer.from('private-exif-gps')), false)
  assert.equal(sanitized.buffer.includes(Buffer.from('private-icc-profile')), false)
  assert.equal(sanitized.buffer.includes(Buffer.from('private-comment')), false)
  assert.equal(inspectAttachmentAvatarImage(sanitized.buffer, sanitized.content_type).sha256, sanitized.sha256)
})

test('embedded WebP extraction is validated but storage sanitization is refused without a transcoder', () => {
  const image = webpLosslessImage(160, 200)
  assert.equal(inspectAttachmentAvatarImage(image, 'image/webp').width, 160)
  assert.throws(
    () => sanitizeMaterializedAttachmentAvatar({
      kind: 'embedded_image',
      buffer: image,
      content_type: 'image/webp'
    }),
    (error) => error?.code === 'attachment_avatar_webp_transcoding_required' && error?.status === 415
  )
})
