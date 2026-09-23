import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import ExcelJS from 'exceljs'
import mammothModule from 'mammoth'
import { getDocument, ImageKind, OPS, PasswordException } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { inspectSecureZipBuffer } from './secure-zip-buffer.js'
import { normalizePhotoUrl } from './validation.js'

const mammoth = mammothModule.default ?? mammothModule

export const ATTACHMENT_AVATAR_LIMITS = Object.freeze({
  maxDocumentBytes: 15 * 1024 * 1024,
  maxImages: 64,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalImageBytes: 12 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxPdfPages: 1,
  maxWorksheets: 20,
  maxSpreadsheetRows: 1_000,
  minWidth: 96,
  minHeight: 96,
  minAspectRatio: 0.55,
  maxAspectRatio: 1.35,
  maxZipEntries: 2_000,
  maxZipEntryBytes: 32 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxZipCompressionRatio: 200,
  maxZipFilenameBytes: 4_096,
  maxZipCentralDirectoryBytes: 4 * 1024 * 1024
})

const PRIVATE_AVATARS = new WeakMap()
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const PDF_OBJECT_WAIT_MS = 2_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

const EXPLICIT_AVATAR_LABELS = Object.freeze([
  'photo_url', 'photo url', 'avatar_url', 'avatar url', 'profile photo url', 'headshot url',
  '证件照', '头像', '头像地址', '照片', '照片地址', '头像 URL', '照片 URL'
])

function avatarError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function boundedNumber(value, fallback, { minimum = 0, integer = true } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum) return fallback
  return integer ? Math.floor(number) : number
}

function normalizedLimits(options = {}) {
  const source = { ...ATTACHMENT_AVATAR_LIMITS, ...(options?.limits ?? options) }
  return {
    maxDocumentBytes: boundedNumber(source.maxDocumentBytes, ATTACHMENT_AVATAR_LIMITS.maxDocumentBytes, { minimum: 1 }),
    maxImages: boundedNumber(source.maxImages, ATTACHMENT_AVATAR_LIMITS.maxImages, { minimum: 1 }),
    maxImageBytes: boundedNumber(source.maxImageBytes, ATTACHMENT_AVATAR_LIMITS.maxImageBytes, { minimum: 1 }),
    maxTotalImageBytes: boundedNumber(source.maxTotalImageBytes, ATTACHMENT_AVATAR_LIMITS.maxTotalImageBytes, { minimum: 1 }),
    maxPixels: boundedNumber(source.maxPixels, ATTACHMENT_AVATAR_LIMITS.maxPixels, { minimum: 1 }),
    maxPdfPages: boundedNumber(source.maxPdfPages, ATTACHMENT_AVATAR_LIMITS.maxPdfPages, { minimum: 1 }),
    maxWorksheets: boundedNumber(source.maxWorksheets, ATTACHMENT_AVATAR_LIMITS.maxWorksheets, { minimum: 1 }),
    maxSpreadsheetRows: boundedNumber(source.maxSpreadsheetRows, ATTACHMENT_AVATAR_LIMITS.maxSpreadsheetRows, { minimum: 1 }),
    minWidth: boundedNumber(source.minWidth, ATTACHMENT_AVATAR_LIMITS.minWidth, { minimum: 1 }),
    minHeight: boundedNumber(source.minHeight, ATTACHMENT_AVATAR_LIMITS.minHeight, { minimum: 1 }),
    minAspectRatio: boundedNumber(source.minAspectRatio, ATTACHMENT_AVATAR_LIMITS.minAspectRatio, { minimum: 0.01, integer: false }),
    maxAspectRatio: boundedNumber(source.maxAspectRatio, ATTACHMENT_AVATAR_LIMITS.maxAspectRatio, { minimum: 0.01, integer: false }),
    maxZipEntries: boundedNumber(source.maxZipEntries, ATTACHMENT_AVATAR_LIMITS.maxZipEntries, { minimum: 1 }),
    maxZipEntryBytes: boundedNumber(source.maxZipEntryBytes, ATTACHMENT_AVATAR_LIMITS.maxZipEntryBytes, { minimum: 1 }),
    maxUncompressedBytes: boundedNumber(source.maxUncompressedBytes, ATTACHMENT_AVATAR_LIMITS.maxUncompressedBytes, { minimum: 1 }),
    maxZipCompressionRatio: boundedNumber(source.maxZipCompressionRatio, ATTACHMENT_AVATAR_LIMITS.maxZipCompressionRatio, { minimum: 1 }),
    maxZipFilenameBytes: boundedNumber(source.maxZipFilenameBytes, ATTACHMENT_AVATAR_LIMITS.maxZipFilenameBytes, { minimum: 1 }),
    maxZipCentralDirectoryBytes: boundedNumber(source.maxZipCentralDirectoryBytes, ATTACHMENT_AVATAR_LIMITS.maxZipCentralDirectoryBytes, { minimum: 1 })
  }
}

function normalizeAvatarLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[_-]+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/\s+/g, ' ')
}

const EXPLICIT_AVATAR_LABEL_KEYS = new Set(EXPLICIT_AVATAR_LABELS.map(normalizeAvatarLabel))

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
}

const EXPLICIT_TEXT_LABEL_PATTERN = EXPLICIT_AVATAR_LABELS
  .map(escapeRegex)
  .sort((left, right) => right.length - left.length)
  .join('|')

function contentTypeForExtension(extension) {
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function extensionForContentType(contentType) {
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  return 'jpg'
}

function normalizeContentType(value) {
  const contentType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  return contentType === 'image/jpg' ? 'image/jpeg' : contentType
}

function registerPrivateAvatar(metadata, secret) {
  const reference = Object.freeze({
    kind: 'attachment_avatar_reference',
    ...metadata
  })
  PRIVATE_AVATARS.set(reference, secret)
  return reference
}

function attachmentAvatarResult(status, visible = {}, hidden = {}) {
  const result = { status, ...visible }
  for (const [key, value] of Object.entries(hidden)) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      writable: false,
      value
    })
  }
  return Object.freeze(result)
}

function trimUrlPunctuation(value) {
  return String(value ?? '').replace(/[\]\[(){}<>，。；;、！？!?]+$/u, '')
}

function explicitUrlTokens(value) {
  const tokens = String(value ?? '').match(/https?:\/\/[^\s<>"']+/giu) ?? []
  const urls = []
  for (const token of tokens) {
    const candidates = [token, trimUrlPunctuation(token)]
    for (const candidate of candidates) {
      const normalized = normalizePhotoUrl(candidate)
      if (normalized) {
        urls.push(normalized)
        break
      }
    }
  }
  return urls
}

function collectLabeledTextValues(text) {
  const source = String(text ?? '')
  if (!source.trim()) return []
  const matcher = new RegExp(
    `(?:^|[\\r\\n|｜;；])\\s*(?:${EXPLICIT_TEXT_LABEL_PATTERN})\\s*[:：=]\\s*([^\\r\\n|｜;；]+)`,
    'gimu'
  )
  return [...source.matchAll(matcher)].map((match) => match[1])
}

function collectLabeledRecordValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return []
  const labeled = []
  for (const [header, value] of Object.entries(values)) {
    if (EXPLICIT_AVATAR_LABEL_KEYS.has(normalizeAvatarLabel(header))) labeled.push(value)
  }
  return labeled
}

function remoteAvatarReference(photoUrl) {
  const extension = new URL(photoUrl).pathname.match(/\.(jpe?g|png|webp)$/i)?.[1]?.toLowerCase() ?? 'jpg'
  const normalizedExtension = extension === 'jpeg' ? 'jpg' : extension
  return registerPrivateAvatar({
    source: 'explicit_url',
    content_type: contentTypeForExtension(normalizedExtension),
    extension: normalizedExtension,
    byte_length: null,
    width: null,
    height: null,
    requires_transcoding: false
  }, {
    kind: 'remote_url',
    photo_url: photoUrl
  })
}

export function extractExplicitAvatarUrls(input = {}) {
  const source = typeof input === 'string' ? { text: input } : (input ?? {})
  const labeledValues = [
    ...collectLabeledTextValues(source.text),
    ...collectLabeledRecordValues(source.values),
    ...(Array.isArray(source.records)
      ? source.records.flatMap((record) => collectLabeledRecordValues(record?.values ?? record))
      : [])
  ]
  return Object.freeze([...new Set(labeledValues.flatMap(explicitUrlTokens))])
}

export function extractExplicitAvatarSensitiveValues(input = {}) {
  const source = typeof input === 'string' ? { text: input } : (input ?? {})
  const labeledValues = [
    ...collectLabeledTextValues(source.text),
    ...collectLabeledRecordValues(source.values),
    ...(Array.isArray(source.records)
      ? source.records.flatMap((record) => collectLabeledRecordValues(record?.values ?? record))
      : [])
  ]
  const sensitive = []
  for (const value of labeledValues) {
    const text = String(value ?? '').trim()
    if (!text) continue
    sensitive.push(text)
    sensitive.push(...(text.match(/(?:https?:\/\/|data:image\/)[^\s<>"']+/giu) ?? []).map(trimUrlPunctuation))
  }
  return Object.freeze([...new Set(sensitive.filter(Boolean))])
}

export function extractExplicitAvatarSuggestion(input = {}) {
  const source = typeof input === 'string' ? { text: input } : (input ?? {})
  const labeledValues = [
    ...collectLabeledTextValues(source.text),
    ...collectLabeledRecordValues(source.values),
    ...(Array.isArray(source.records)
      ? source.records.flatMap((record) => collectLabeledRecordValues(record?.values ?? record))
      : [])
  ]
  const urls = extractExplicitAvatarUrls(source)
  if (urls.length === 0) {
    return attachmentAvatarResult(labeledValues.length ? 'invalid' : 'none', {
      source: 'explicit_url',
      candidate_count: 0,
      rejected_count: labeledValues.length
    })
  }
  if (urls.length > 1) {
    return attachmentAvatarResult('ambiguous', {
      source: 'explicit_url',
      candidate_count: urls.length,
      rejected_count: Math.max(0, labeledValues.length - urls.length)
    })
  }
  const reference = remoteAvatarReference(urls[0])
  return attachmentAvatarResult('ready', {
    source: 'explicit_url',
    confidence: 'high',
    candidate_count: 1,
    rejected_count: Math.max(0, labeledValues.length - 1)
  }, { reference })
}

function inspectPng(buffer) {
  if (buffer.length < 45 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null
  let cursor = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let sawHeader = false
  let sawImageData = false
  let sawEnd = false
  let chunkCount = 0
  while (cursor < buffer.length) {
    if (cursor + 12 > buffer.length || chunkCount >= 10_000) return null
    const length = buffer.readUInt32BE(cursor)
    const dataStart = cursor + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (dataEnd < dataStart || chunkEnd > buffer.length) return null
    const typeBuffer = buffer.subarray(cursor + 4, cursor + 8)
    const type = typeBuffer.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) return null
    if ((typeBuffer[0] & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return null
    const expectedCrc = buffer.readUInt32BE(dataEnd)
    const actualCrc = crc32(Buffer.concat([typeBuffer, buffer.subarray(dataStart, dataEnd)])) >>> 0
    if (actualCrc !== expectedCrc) return null
    if (chunkCount === 0 && (type !== 'IHDR' || length !== 13)) return null
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) return null
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      const bitDepth = buffer[dataStart + 8]
      const colorType = buffer[dataStart + 9]
      const validDepths = {
        0: new Set([1, 2, 4, 8, 16]),
        2: new Set([8, 16]),
        3: new Set([1, 2, 4, 8]),
        4: new Set([8, 16]),
        6: new Set([8, 16])
      }
      if (
        !validDepths[colorType]?.has(bitDepth) ||
        buffer[dataStart + 10] !== 0 || buffer[dataStart + 11] !== 0 ||
        ![0, 1].includes(buffer[dataStart + 12])
      ) return null
      sawHeader = true
    } else if (type === 'IDAT') {
      sawImageData = true
    } else if (type === 'IEND') {
      if (length !== 0) return null
      sawEnd = true
      cursor = chunkEnd
      break
    }
    cursor = chunkEnd
    chunkCount += 1
  }
  if (!sawHeader || !sawImageData || !sawEnd || cursor !== buffer.length) return null
  return { content_type: 'image/png', width, height }
}

function inspectJpeg(buffer) {
  if (buffer.length < 14 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let cursor = 2
  let width = 0
  let height = 0
  let sawScan = false
  while (cursor < buffer.length - 2) {
    while (cursor < buffer.length && buffer[cursor] === 0xff) cursor += 1
    if (cursor >= buffer.length) return null
    const marker = buffer[cursor]
    cursor += 1
    if (marker === 0xd9) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    if (cursor + 2 > buffer.length) return null
    const segmentLength = buffer.readUInt16BE(cursor)
    if (segmentLength < 2 || cursor + segmentLength > buffer.length) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return null
      height = buffer.readUInt16BE(cursor + 3)
      width = buffer.readUInt16BE(cursor + 5)
    }
    if (marker === 0xda) {
      sawScan = true
      break
    }
    cursor += segmentLength
  }
  if (!width || !height || !sawScan) return null
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null
  return { content_type: 'image/jpeg', width, height }
}

function inspectWebp(buffer) {
  if (
    buffer.length < 26 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) return null
  let cursor = 12
  let dimensions = null
  let sawVisualPayload = false
  while (cursor < buffer.length) {
    if (cursor + 8 > buffer.length) return null
    const type = buffer.subarray(cursor, cursor + 4).toString('ascii')
    const length = buffer.readUInt32LE(cursor + 4)
    const dataStart = cursor + 8
    const dataEnd = dataStart + length
    if (dataEnd < dataStart || dataEnd > buffer.length) return null
    if (type === 'VP8X' && length >= 10) {
      dimensions = {
        width: 1 + buffer.readUIntLE(dataStart + 4, 3),
        height: 1 + buffer.readUIntLE(dataStart + 7, 3)
      }
    } else if (type === 'VP8L' && length >= 5 && buffer[dataStart] === 0x2f) {
      sawVisualPayload = true
      const bits = buffer.readUInt32LE(dataStart + 1)
      dimensions = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff)
      }
    } else if (
      type === 'VP8 ' && length >= 10 &&
      buffer[dataStart + 3] === 0x9d && buffer[dataStart + 4] === 0x01 && buffer[dataStart + 5] === 0x2a
    ) {
      sawVisualPayload = true
      dimensions = {
        width: buffer.readUInt16LE(dataStart + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataStart + 8) & 0x3fff
      }
    }
    cursor = dataEnd + (length % 2)
  }
  if (cursor !== buffer.length || !dimensions || !sawVisualPayload) return null
  return { content_type: 'image/webp', ...dimensions }
}

export function inspectAttachmentAvatarImage(value, declaredContentType, options = {}) {
  const limits = normalizedLimits(options)
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? [])
  if (!buffer.length || buffer.length > limits.maxImageBytes) return null
  const declared = normalizeContentType(declaredContentType)
  if (!SUPPORTED_IMAGE_TYPES.has(declared)) return null
  const inspected = inspectPng(buffer) ?? inspectJpeg(buffer) ?? inspectWebp(buffer)
  if (!inspected || inspected.content_type !== declared) return null
  if (
    inspected.width < 1 || inspected.height < 1 ||
    inspected.width * inspected.height > limits.maxPixels
  ) return null
  return Object.freeze({
    ...inspected,
    extension: extensionForContentType(inspected.content_type),
    byte_length: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex')
  })
}

function hasAvatarLabelHint(value) {
  const text = normalizeAvatarLabel(value)
  return Boolean(text && /(?:avatar|profile photo|headshot|证件照|头像|照片)/iu.test(text))
}

function avatarSelectionScore(metadata, limits, index, labelHint) {
  const area = metadata.width * metadata.height
  const minimumArea = limits.minWidth * limits.minHeight
  const ratio = metadata.width / metadata.height
  const areaScore = Math.min(42, Math.log2(Math.max(1, area / minimumArea) + 1) * 13)
  const aspectScore = Math.max(0, 32 - Math.abs(ratio - 0.8) * 42)
  const labelScore = labelHint ? 80 : 0
  const orderScore = Math.max(0, 6 - index * 0.5)
  return Math.round((areaScore + aspectScore + labelScore + orderScore) * 100) / 100
}

function embeddedAvatarReference(buffer, metadata, limits, index, labelHint, {
  source = 'docx_embedded_image',
  sheetName = null,
  rowNumber = null,
  columnNumber = null,
  pageNumber = null
} = {}) {
  const aspectRatio = metadata.width / metadata.height
  const eligible = (
    metadata.width >= limits.minWidth && metadata.height >= limits.minHeight &&
    aspectRatio >= limits.minAspectRatio && aspectRatio <= limits.maxAspectRatio
  )
  return registerPrivateAvatar({
    source,
    content_type: metadata.content_type,
    extension: metadata.extension,
    byte_length: metadata.byte_length,
    width: metadata.width,
    height: metadata.height,
    sha256: metadata.sha256,
    requires_transcoding: true,
    eligible,
    avatar_label_hint: labelHint,
    selection_score: avatarSelectionScore(metadata, limits, index, labelHint),
    document_order: index,
    sheet_name: sheetName,
    row_number: rowNumber,
    column_number: columnNumber,
    page_number: pageNumber
  }, {
    kind: 'embedded_image',
    buffer: Buffer.from(buffer),
    content_type: metadata.content_type,
    extension: metadata.extension,
    requires_transcoding: true
  })
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

function pdfImageAsPng(image, limits) {
  const width = Number(image?.width)
  const height = Number(image?.height)
  const data = image?.data
  if (
    !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 ||
    width * height > limits.maxPixels || !ArrayBuffer.isView(data)
  ) return null

  const channels = image.kind === ImageKind.RGB_24BPP
    ? 3
    : image.kind === ImageKind.RGBA_32BPP ? 4 : 0
  const expectedBytes = width * height * channels
  if (!channels || data.byteLength !== expectedBytes || expectedBytes > limits.maxTotalImageBytes) return null

  const rowBytes = width * channels
  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * height)
  const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  for (let row = 0; row < height; row += 1) {
    const target = row * (rowBytes + 1)
    scanlines[target] = 0
    pixels.copy(scanlines, target + 1, row * rowBytes, (row + 1) * rowBytes)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  const output = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND')
  ])
  if (output.length > limits.maxImageBytes) return null
  return output
}

async function pdfOperatorImage(page, operation, args) {
  if (operation === OPS.paintInlineImageXObject) return args?.[0] ?? null
  if (![OPS.paintImageXObject, OPS.paintImageXObjectRepeat].includes(operation)) return null
  const objectId = args?.[0]
  if (typeof objectId !== 'string') return null
  const store = objectId.startsWith('g_') ? page.commonObjs : page.objs
  if (store.has(objectId)) return store.get(objectId)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      resolve(null)
    }, PDF_OBJECT_WAIT_MS)
    timer.unref()
    store.get(objectId, (image) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(image)
    })
  })
}

export async function extractPdfAvatarCandidates(value, options = {}) {
  const limits = normalizedLimits(options)
  if (!Buffer.isBuffer(value)) throw avatarError(400, 'pdf_buffer_required', 'PDF avatar extraction requires a Buffer')
  if (!value.length) throw avatarError(422, 'pdf_empty', 'PDF avatar extraction received an empty document')
  if (value.length > limits.maxDocumentBytes) {
    throw avatarError(413, 'pdf_too_large', 'PDF exceeds the avatar extraction size limit')
  }

  const references = []
  let loadingTask
  try {
    const maxDecodedPixels = Math.max(1, Math.min(
      limits.maxPixels,
      Math.floor(limits.maxTotalImageBytes / 4)
    ))
    loadingTask = getDocument({
      data: new Uint8Array(value),
      enableScripting: false,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: maxDecodedPixels,
      verbosity: 0
    })
    const pdf = await loadingTask.promise
    const seenImages = new Set()
    let totalDecodedBytes = 0
    let documentOrder = 0
    const pageLimit = Math.min(pdf.numPages, limits.maxPdfPages)
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const operatorList = await page.getOperatorList()
      for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        const image = await pdfOperatorImage(page, operatorList.fnArray[index], operatorList.argsArray[index])
        if (!image) continue
        documentOrder += 1
        if (documentOrder > limits.maxImages) {
          throw avatarError(413, 'pdf_avatar_image_limit', 'PDF contains too many embedded images')
        }
        const decodedBytes = Number(image.data?.byteLength ?? 0)
        totalDecodedBytes += decodedBytes
        if (totalDecodedBytes > limits.maxTotalImageBytes) {
          throw avatarError(413, 'pdf_avatar_bytes_limit', 'PDF decoded images exceed the avatar extraction limit')
        }
        const imageBuffer = pdfImageAsPng(image, limits)
        if (!imageBuffer) continue
        const metadata = inspectAttachmentAvatarImage(imageBuffer, 'image/png', { limits })
        if (!metadata || seenImages.has(metadata.sha256)) continue
        seenImages.add(metadata.sha256)
        references.push(embeddedAvatarReference(
          imageBuffer,
          metadata,
          limits,
          documentOrder - 1,
          false,
          { source: 'pdf_embedded_image', pageNumber }
        ))
      }
      page.cleanup()
    }
    return Object.freeze(references)
  } catch (cause) {
    for (const reference of references) releasePrivateAttachmentAvatar(reference)
    if (cause instanceof PasswordException || cause?.name === 'PasswordException') {
      throw avatarError(422, 'pdf_avatar_encrypted', 'Encrypted PDFs cannot be inspected for avatars')
    }
    if (cause?.code && cause?.status) throw cause
    throw avatarError(422, 'pdf_avatar_parse_failed', 'PDF embedded images could not be parsed safely')
  } finally {
    try { await loadingTask?.destroy() } catch {}
  }
}

export async function extractDocxAvatarCandidates(value, options = {}) {
  const limits = normalizedLimits(options)
  if (!Buffer.isBuffer(value)) throw avatarError(400, 'docx_buffer_required', 'DOCX avatar extraction requires a Buffer')
  if (!value.length) throw avatarError(422, 'docx_empty', 'DOCX avatar extraction received an empty document')
  if (value.length > limits.maxDocumentBytes) {
    throw avatarError(413, 'docx_too_large', 'DOCX exceeds the avatar extraction size limit')
  }
  const packageInfo = inspectSecureZipBuffer(value, {
    maxZipEntries: limits.maxZipEntries,
    maxZipEntryBytes: limits.maxZipEntryBytes,
    maxUncompressedBytes: limits.maxUncompressedBytes,
    maxZipCompressionRatio: limits.maxZipCompressionRatio,
    maxZipFilenameBytes: limits.maxZipFilenameBytes,
    maxZipCentralDirectoryBytes: limits.maxZipCentralDirectoryBytes
  }, { verifyPayload: true })
  if (!packageInfo.names.includes('word/document.xml')) {
    throw avatarError(422, 'docx_invalid_package', 'Office package is not a DOCX document')
  }

  const references = []
  let seenImages = 0
  let totalImageBytes = 0
  let limitExceeded = null
  const convertImage = mammoth.images.imgElement(async (image) => {
    seenImages += 1
    if (seenImages > limits.maxImages) {
      limitExceeded = avatarError(413, 'docx_avatar_image_limit', 'DOCX contains too many embedded images')
      return { src: 'about:blank' }
    }
    const contentType = normalizeContentType(image?.contentType)
    if (!SUPPORTED_IMAGE_TYPES.has(contentType)) return { src: 'about:blank' }
    const imageBuffer = await image.read()
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length > limits.maxImageBytes) return { src: 'about:blank' }
    totalImageBytes += imageBuffer.length
    if (totalImageBytes > limits.maxTotalImageBytes) {
      limitExceeded = avatarError(413, 'docx_avatar_bytes_limit', 'DOCX embedded images exceed the avatar extraction limit')
      return { src: 'about:blank' }
    }
    const metadata = inspectAttachmentAvatarImage(imageBuffer, contentType, { limits })
    if (!metadata) return { src: 'about:blank' }
    references.push(embeddedAvatarReference(
      imageBuffer,
      metadata,
      limits,
      seenImages - 1,
      hasAvatarLabelHint(image?.altText)
    ))
    return { src: 'about:blank' }
  })

  try {
    await mammoth.convertToHtml(
      { buffer: value },
      { convertImage, externalFileAccess: false }
    )
  } catch (cause) {
    if (cause?.code && cause?.status) throw cause
    throw avatarError(422, 'docx_avatar_parse_failed', 'DOCX embedded images could not be parsed safely')
  }
  if (limitExceeded) throw limitExceeded
  return Object.freeze(references)
}

function spreadsheetCellText(value) {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  if ('result' in value) return spreadsheetCellText(value.result)
  if (Array.isArray(value.richText)) return value.richText.map((part) => part?.text ?? '').join('')
  if ('text' in value) return String(value.text ?? '')
  return ''
}

function spreadsheetImageContentType(extension) {
  const normalized = String(extension ?? '').trim().toLowerCase()
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg'
  if (normalized === 'png') return 'image/png'
  if (normalized === 'webp') return 'image/webp'
  return null
}

export async function extractXlsxAvatarCandidates(value, options = {}) {
  const limits = normalizedLimits(options)
  if (!Buffer.isBuffer(value)) throw avatarError(400, 'xlsx_buffer_required', 'XLSX avatar extraction requires a Buffer')
  if (!value.length) throw avatarError(422, 'xlsx_empty', 'XLSX avatar extraction received an empty workbook')
  if (value.length > limits.maxDocumentBytes) {
    throw avatarError(413, 'xlsx_too_large', 'XLSX exceeds the avatar extraction size limit')
  }
  const packageInfo = inspectSecureZipBuffer(value, {
    maxZipEntries: limits.maxZipEntries,
    maxZipEntryBytes: limits.maxZipEntryBytes,
    maxUncompressedBytes: limits.maxUncompressedBytes,
    maxZipCompressionRatio: limits.maxZipCompressionRatio,
    maxZipFilenameBytes: limits.maxZipFilenameBytes,
    maxZipCentralDirectoryBytes: limits.maxZipCentralDirectoryBytes
  }, { verifyPayload: true })
  if (!packageInfo.names.includes('xl/workbook.xml')) {
    throw avatarError(422, 'xlsx_invalid_package', 'Office package is not an XLSX workbook')
  }

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(value)
  } catch {
    throw avatarError(422, 'xlsx_avatar_parse_failed', 'XLSX embedded images could not be parsed safely')
  }
  if (workbook.worksheets.length > limits.maxWorksheets) {
    throw avatarError(413, 'xlsx_worksheet_limit', 'XLSX contains too many worksheets')
  }

  const references = []
  let seenImages = 0
  let totalImageBytes = 0
  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount - 1 > limits.maxSpreadsheetRows) {
      throw avatarError(413, 'xlsx_row_limit', 'XLSX contains too many candidate rows')
    }
    for (const image of worksheet.getImages()) {
      seenImages += 1
      if (seenImages > limits.maxImages) {
        throw avatarError(413, 'xlsx_avatar_image_limit', 'XLSX contains too many embedded images')
      }
      const rowNumber = Number(image?.range?.tl?.nativeRow) + 1
      const columnNumber = Number(image?.range?.tl?.nativeCol) + 1
      if (
        !Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > limits.maxSpreadsheetRows + 1 ||
        !Number.isInteger(columnNumber) || columnNumber < 1
      ) continue
      const medium = workbook.getImage(image.imageId)
      const contentType = spreadsheetImageContentType(medium?.extension)
      if (!contentType || !Buffer.isBuffer(medium?.buffer)) continue
      if (medium.buffer.length > limits.maxImageBytes) continue
      totalImageBytes += medium.buffer.length
      if (totalImageBytes > limits.maxTotalImageBytes) {
        throw avatarError(413, 'xlsx_avatar_bytes_limit', 'XLSX embedded images exceed the avatar extraction limit')
      }
      const metadata = inspectAttachmentAvatarImage(medium.buffer, contentType, { limits })
      if (!metadata) continue
      const header = spreadsheetCellText(worksheet.getRow(1).getCell(columnNumber).value)
      references.push(embeddedAvatarReference(
        medium.buffer,
        metadata,
        limits,
        seenImages - 1,
        EXPLICIT_AVATAR_LABEL_KEYS.has(normalizeAvatarLabel(header)),
        {
          source: 'xlsx_embedded_image',
          sheetName: worksheet.name,
          rowNumber,
          columnNumber
        }
      ))
    }
  }
  return Object.freeze(references)
}

function selectEmbeddedAvatarCandidate(references, sourceName, visible = {}) {
  const source = Array.isArray(references) ? references : []
  const eligible = source
    .filter((reference) => (
      reference?.kind === 'attachment_avatar_reference' &&
      reference.source === sourceName &&
      reference.eligible === true
    ))
    .sort((left, right) => (
      right.selection_score - left.selection_score ||
      right.width * right.height - left.width * left.height ||
      left.document_order - right.document_order
    ))
  if (!eligible.length) {
    return attachmentAvatarResult('none', {
      source: sourceName,
      candidate_count: source.length,
      eligible_candidate_count: 0,
      ...visible
    }, { references: source })
  }

  const best = eligible[0]
  const second = eligible[1]
  const scoreGap = second ? best.selection_score - second.selection_score : Number.POSITIVE_INFINITY
  const bothLabeled = Boolean(second && best.avatar_label_hint && second.avatar_label_hint)
  const unlabeledClosePair = Boolean(second && !best.avatar_label_hint && scoreGap < 15)
  if (bothLabeled && scoreGap < 20 || unlabeledClosePair) {
    return attachmentAvatarResult('ambiguous', {
      source: sourceName,
      candidate_count: source.length,
      eligible_candidate_count: eligible.length,
      ...visible
    }, { references: source })
  }

  const confidence = best.avatar_label_hint ? 'high' : second ? 'medium' : 'medium'
  return attachmentAvatarResult('ready', {
    source: sourceName,
    confidence,
    candidate_count: source.length,
    eligible_candidate_count: eligible.length,
    ...visible
  }, { reference: best, references: source })
}

export function selectDocxAvatarCandidate(references) {
  return selectEmbeddedAvatarCandidate(references, 'docx_embedded_image')
}

export function selectPdfAvatarCandidate(references) {
  return selectEmbeddedAvatarCandidate(references, 'pdf_embedded_image')
}

export function selectXlsxRowAvatarCandidate(references, { sheetName, rowNumber } = {}) {
  const rowReferences = (Array.isArray(references) ? references : []).filter((reference) => (
    reference?.source === 'xlsx_embedded_image' &&
    reference.sheet_name === sheetName &&
    reference.row_number === rowNumber
  ))
  return selectEmbeddedAvatarCandidate(rowReferences, 'xlsx_embedded_image', {
    sheet_name: sheetName ?? null,
    row_number: Number.isInteger(rowNumber) ? rowNumber : null
  })
}

export async function extractXlsxAvatarSuggestions(buffer, options = {}) {
  const references = await extractXlsxAvatarCandidates(buffer, options)
  const rows = new Map()
  for (const reference of references) {
    const key = `${reference.sheet_name}\u0000${reference.row_number}`
    if (!rows.has(key)) rows.set(key, { sheetName: reference.sheet_name, rowNumber: reference.row_number })
  }
  return Object.freeze([...rows.values()].map(({ sheetName, rowNumber }) => (
    selectXlsxRowAvatarCandidate(references, { sheetName, rowNumber })
  )))
}

export async function extractDocxAvatarSuggestion(buffer, options = {}) {
  const references = await extractDocxAvatarCandidates(buffer, options)
  return selectDocxAvatarCandidate(references, options)
}

export async function extractPdfAvatarSuggestion(buffer, options = {}) {
  const references = await extractPdfAvatarCandidates(buffer, options)
  return selectPdfAvatarCandidate(references, options)
}

function preferredAttachmentAvatarResult(explicit, embedded) {
  if (explicit?.status === 'ready' || explicit?.status === 'ambiguous') return explicit
  if (embedded?.status === 'ready' || embedded?.status === 'ambiguous') return embedded
  return explicit?.status === 'invalid' ? explicit : embedded ?? explicit
}

export async function extractAttachmentAvatarResults(buffer, format, parsed) {
  const records = Array.isArray(parsed?.records) ? parsed.records : []
  const explicit = records.map((record) => extractExplicitAvatarSuggestion({
    text: record?.values?.raw_text ?? '',
    values: record?.values ?? {}
  }))
  let embedded = []
  if (format === 'pdf' && records.length === 1) {
    embedded = [await extractPdfAvatarSuggestion(buffer)]
  } else if (format === 'docx' && records.length === 1) {
    embedded = [await extractDocxAvatarSuggestion(buffer)]
  } else if (['xlsx', 'xlsm'].includes(format)) {
    const suggestions = await extractXlsxAvatarSuggestions(buffer)
    const byRow = new Map(suggestions.map((suggestion) => [
      `${suggestion.sheet_name}\u0000${suggestion.row_number}`,
      suggestion
    ]))
    embedded = records.map((record) => byRow.get(
      `${parsed?.metadata?.sheet_name ?? ''}\u0000${record?.row_number ?? ''}`
    ))
  }
  return records.map((_, index) => preferredAttachmentAvatarResult(explicit[index], embedded[index]))
}

function releaseAttachmentAvatarResult(result) {
  const references = new Set([
    result?.reference,
    ...(Array.isArray(result?.references) ? result.references : [])
  ].filter(Boolean))
  for (const reference of references) releasePrivateAttachmentAvatar(reference)
}

export function serializeAttachmentAvatarResult(result) {
  const projection = projectAttachmentAvatarSuggestion(result)
  let secret = null
  try {
    if (projection.available && result?.reference) {
      const materialized = materializePrivateAttachmentAvatar(result.reference)
      secret = materialized.kind === 'remote_url'
        ? { kind: materialized.kind, photo_url: materialized.photo_url }
        : {
            kind: materialized.kind,
            buffer: Buffer.from(materialized.buffer),
            content_type: materialized.content_type,
            extension: materialized.extension
          }
    }
    return { projection, secret }
  } finally {
    releaseAttachmentAvatarResult(result)
  }
}

function transferredBuffer(value) {
  if (!ArrayBuffer.isView(value)) return null
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

export function hydrateAttachmentAvatarTransfer(transfer) {
  const projection = projectAttachmentAvatarSuggestion(transfer?.projection)
  if (!projection.available || !transfer?.secret) {
    const { status, ...visible } = projection
    return attachmentAvatarResult(status, visible)
  }

  let reference
  if (transfer.secret.kind === 'remote_url' && projection.source === 'explicit_url') {
    const photoUrl = normalizePhotoUrl(transfer.secret.photo_url)
    if (!photoUrl) throw avatarError(422, 'attachment_avatar_transfer_invalid', 'Transferred avatar URL is invalid')
    reference = remoteAvatarReference(photoUrl)
  } else if (
    transfer.secret.kind === 'embedded_image' &&
    ['docx_embedded_image', 'pdf_embedded_image', 'xlsx_embedded_image'].includes(projection.source)
  ) {
    const sourceBuffer = transferredBuffer(transfer.secret.buffer)
    const metadata = sourceBuffer
      ? inspectAttachmentAvatarImage(sourceBuffer, transfer.secret.content_type)
      : null
    if (
      !metadata || metadata.content_type !== projection.content_type ||
      metadata.width !== projection.width || metadata.height !== projection.height
    ) {
      throw avatarError(422, 'attachment_avatar_transfer_invalid', 'Transferred embedded avatar is invalid')
    }
    reference = registerPrivateAvatar({
      source: projection.source,
      content_type: metadata.content_type,
      extension: metadata.extension,
      byte_length: metadata.byte_length,
      width: metadata.width,
      height: metadata.height,
      sha256: metadata.sha256,
      requires_transcoding: true,
      eligible: true,
      avatar_label_hint: false,
      selection_score: 0,
      document_order: 0,
      sheet_name: projection.sheet_name ?? null,
      row_number: projection.row_number ?? null
    }, {
      kind: 'embedded_image',
      buffer: Buffer.from(sourceBuffer),
      content_type: metadata.content_type,
      extension: metadata.extension,
      requires_transcoding: true
    })
  } else {
    throw avatarError(422, 'attachment_avatar_transfer_invalid', 'Transferred avatar source is invalid')
  }

  const { status, ...visible } = projection
  return attachmentAvatarResult(status, visible, { reference })
}

export function releaseAttachmentAvatarTransfer(transfer) {
  const buffer = transferredBuffer(transfer?.secret?.buffer)
  if (buffer) buffer.fill(0)
  if (transfer?.secret?.kind === 'remote_url') {
    try { transfer.secret.photo_url = '' } catch {}
  }
}

export function projectAttachmentAvatarSuggestion(input) {
  const status = ['ready', 'ambiguous', 'invalid', 'none'].includes(input?.status) ? input.status : 'none'
  const reference = input?.reference
  const source = input?.source ?? reference?.source ?? null
  const projection = {
    status,
    available: status === 'ready',
    source,
    confidence: status === 'ready' ? input?.confidence ?? null : null,
    candidate_count: Number.isInteger(input?.candidate_count) ? input.candidate_count : 0
  }
  if (status === 'ready' && ['docx_embedded_image', 'pdf_embedded_image', 'xlsx_embedded_image'].includes(source)) {
    projection.content_type = reference?.content_type ?? input?.content_type
    projection.width = reference?.width ?? input?.width
    projection.height = reference?.height ?? input?.height
    projection.requires_transcoding = true
  }
  if (source === 'xlsx_embedded_image') {
    projection.sheet_name = input.sheet_name ?? null
    projection.row_number = Number.isInteger(input.row_number) ? input.row_number : null
  }
  return Object.freeze(projection)
}

// Avatar inputs are intentionally omitted from external suggestion-model context.
export function attachmentAvatarModelContext() {
  return null
}

export function materializePrivateAttachmentAvatar(reference) {
  const secret = PRIVATE_AVATARS.get(reference)
  if (!secret) throw avatarError(400, 'attachment_avatar_reference_invalid', 'Attachment avatar reference is invalid or expired')
  if (secret.kind === 'remote_url') {
    return Object.freeze({ kind: secret.kind, photo_url: secret.photo_url })
  }
  return Object.freeze({
    kind: secret.kind,
    buffer: Buffer.from(secret.buffer),
    content_type: secret.content_type,
    extension: secret.extension,
    requires_transcoding: true
  })
}

function sanitizePngAvatar(buffer) {
  const safeChunks = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])
  const output = [buffer.subarray(0, PNG_SIGNATURE.length)]
  let cursor = PNG_SIGNATURE.length
  while (cursor < buffer.length) {
    if (cursor + 12 > buffer.length) return null
    const length = buffer.readUInt32BE(cursor)
    const chunkEnd = cursor + 12 + length
    if (chunkEnd < cursor || chunkEnd > buffer.length) return null
    const type = buffer.subarray(cursor + 4, cursor + 8).toString('ascii')
    if (safeChunks.has(type)) output.push(buffer.subarray(cursor, chunkEnd))
    cursor = chunkEnd
  }
  return cursor === buffer.length ? Buffer.concat(output) : null
}

function sanitizeJpegAvatar(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  const output = [buffer.subarray(0, 2)]
  let cursor = 2
  let segmentCount = 0
  while (cursor < buffer.length) {
    if (buffer[cursor] !== 0xff || segmentCount >= 100_000) return null
    const markerStart = cursor
    while (cursor < buffer.length && buffer[cursor] === 0xff) cursor += 1
    if (cursor >= buffer.length) return null
    const marker = buffer[cursor]
    cursor += 1
    segmentCount += 1
    if (marker === 0x00) return null
    if (marker === 0xd9) {
      output.push(buffer.subarray(markerStart, cursor))
      return cursor === buffer.length ? Buffer.concat(output) : null
    }
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) {
      output.push(buffer.subarray(markerStart, cursor))
      continue
    }
    if (cursor + 2 > buffer.length) return null
    const segmentLength = buffer.readUInt16BE(cursor)
    const segmentEnd = cursor + segmentLength
    if (segmentLength < 2 || segmentEnd > buffer.length) return null
    const sensitiveMetadata = marker >= 0xe1 && marker <= 0xef || marker === 0xfe
    if (!sensitiveMetadata) output.push(buffer.subarray(markerStart, segmentEnd))
    cursor = segmentEnd
    if (marker !== 0xda) continue

    const scanStart = cursor
    let scanCursor = cursor
    let foundNextMarker = false
    while (scanCursor < buffer.length) {
      const markerOffset = buffer.indexOf(0xff, scanCursor)
      if (markerOffset < 0 || markerOffset + 1 >= buffer.length) return null
      let codeOffset = markerOffset + 1
      while (codeOffset < buffer.length && buffer[codeOffset] === 0xff) codeOffset += 1
      if (codeOffset >= buffer.length) return null
      const code = buffer[codeOffset]
      if (code === 0x00 || code === 0x01 || code >= 0xd0 && code <= 0xd7) {
        scanCursor = codeOffset + 1
        continue
      }
      output.push(buffer.subarray(scanStart, markerOffset))
      cursor = markerOffset
      foundNextMarker = true
      break
    }
    if (!foundNextMarker) return null
  }
  return null
}

export function sanitizeMaterializedAttachmentAvatar(input, options = {}) {
  let materialized = input
  if (PRIVATE_AVATARS.has(input)) materialized = materializePrivateAttachmentAvatar(input)
  else if (input?.reference && PRIVATE_AVATARS.has(input.reference)) {
    materialized = materializePrivateAttachmentAvatar(input.reference)
  }
  if (materialized?.kind !== 'embedded_image' || !Buffer.isBuffer(materialized.buffer)) {
    throw avatarError(400, 'attachment_avatar_not_embedded', 'Only embedded attachment avatars can be sanitized for storage')
  }
  const limits = normalizedLimits(options)
  const inspected = inspectAttachmentAvatarImage(materialized.buffer, materialized.content_type, { limits })
  if (!inspected) {
    throw avatarError(422, 'attachment_avatar_image_invalid', 'Embedded attachment avatar is invalid')
  }
  if (inspected.content_type === 'image/webp') {
    throw avatarError(
      415,
      'attachment_avatar_webp_transcoding_required',
      'Embedded WebP avatars require a trusted decode-and-reencode pipeline before storage'
    )
  }
  const sanitized = inspected.content_type === 'image/png'
    ? sanitizePngAvatar(materialized.buffer)
    : sanitizeJpegAvatar(materialized.buffer)
  const verified = sanitized
    ? inspectAttachmentAvatarImage(sanitized, inspected.content_type, { limits })
    : null
  if (
    !verified || verified.width !== inspected.width || verified.height !== inspected.height ||
    verified.content_type !== inspected.content_type
  ) {
    throw avatarError(422, 'attachment_avatar_sanitize_failed', 'Embedded attachment avatar could not be sanitized safely')
  }
  return Object.freeze({
    kind: 'sanitized_embedded_image',
    buffer: Buffer.from(sanitized),
    content_type: verified.content_type,
    extension: verified.extension,
    width: verified.width,
    height: verified.height,
    byte_length: sanitized.length,
    sha256: createHash('sha256').update(sanitized).digest('hex'),
    metadata_stripped: true,
    requires_transcoding: false
  })
}

export function releasePrivateAttachmentAvatar(reference) {
  const secret = PRIVATE_AVATARS.get(reference)
  if (!secret) return false
  if (Buffer.isBuffer(secret.buffer)) secret.buffer.fill(0)
  return PRIVATE_AVATARS.delete(reference)
}
