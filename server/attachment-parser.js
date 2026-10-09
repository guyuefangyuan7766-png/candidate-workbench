import { createHash, randomUUID } from 'node:crypto'
import { extname, basename } from 'node:path'
import { Worker } from 'node:worker_threads'
import { inspectSecureZipBuffer } from './secure-zip-buffer.js'

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 15 * 1024 * 1024,
  maxPdfPages: 200,
  maxWorksheets: 20,
  maxSpreadsheetRows: 1000,
  maxSpreadsheetColumns: 200,
  maxZipEntries: 2000,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxZipEntryBytes: 32 * 1024 * 1024,
  maxZipCompressionRatio: 200,
  maxZipFilenameBytes: 4_096,
  maxZipCentralDirectoryBytes: 4 * 1024 * 1024,
  maxExtractedText: 2_000_000,
  parseTimeoutMs: 60_000,
  // Visual pages are transient model input, never regular parser output.
  maxVisualPdfPages: 12,
  visualRenderScale: 1.5,
  maxVisualPageWidth: 2_048,
  maxVisualPageHeight: 2_048,
  maxVisualPagePixels: 3_000_000,
  maxVisualTotalPixels: 18_000_000,
  maxVisualTotalRasterBytes: 64 * 1024 * 1024,
  maxVisualPagePngBytes: 4 * 1024 * 1024,
  maxVisualTotalPngBytes: 24 * 1024 * 1024,
  maxVisualTextSpans: 5_000,
  maxVisualPageTextCharacters: 8_000,
  maxVisualTextSpanCharacters: 1_000,
  visualRenderPageTimeoutMs: 8_000,
  visualRenderTimeoutMs: 30_000
})

// These limits cover the deterministic PDF worker and its outer wall-clock
// guard. Internal callers may lower them, but cannot expand the reviewed
// parser envelope.
export const ATTACHMENT_HARD_LIMITS = Object.freeze({
  maxPdfPages: ATTACHMENT_LIMITS.maxPdfPages,
  parseTimeoutMs: ATTACHMENT_LIMITS.parseTimeoutMs
})

// Visual rendering is an outbound-input boundary as well as a parser option.
// Keep an immutable ceiling separate from the defaults so internal callers can
// lower a budget for a constrained job, but cannot expand the reviewed memory,
// image, page, or wall-clock envelope.
export const ATTACHMENT_VISUAL_HARD_LIMITS = Object.freeze({
  maxVisualPdfPages: 12,
  visualRenderScale: 1.5,
  maxVisualPageWidth: 2_048,
  maxVisualPageHeight: 2_048,
  maxVisualPagePixels: 3_000_000,
  maxVisualTotalPixels: 18_000_000,
  maxVisualTotalRasterBytes: 64 * 1024 * 1024,
  maxVisualPagePngBytes: 4 * 1024 * 1024,
  maxVisualTotalPngBytes: 24 * 1024 * 1024,
  maxVisualTextSpans: 5_000,
  maxVisualPageTextCharacters: 8_000,
  maxVisualTextSpanCharacters: 1_000,
  visualRenderPageTimeoutMs: 8_000,
  visualRenderTimeoutMs: 30_000
})

const VISUAL_LIMIT_RULES = Object.freeze({
  maxVisualPdfPages: { integer: true, minimum: 1 },
  visualRenderScale: { integer: false, minimum: 0.1 },
  maxVisualPageWidth: { integer: true, minimum: 1 },
  maxVisualPageHeight: { integer: true, minimum: 1 },
  maxVisualPagePixels: { integer: true, minimum: 1 },
  maxVisualTotalPixels: { integer: true, minimum: 1 },
  maxVisualTotalRasterBytes: { integer: true, minimum: 1 },
  maxVisualPagePngBytes: { integer: true, minimum: 1 },
  maxVisualTotalPngBytes: { integer: true, minimum: 1 },
  maxVisualTextSpans: { integer: true, minimum: 1 },
  maxVisualPageTextCharacters: { integer: true, minimum: 1 },
  maxVisualTextSpanCharacters: { integer: true, minimum: 1 },
  visualRenderPageTimeoutMs: { integer: true, minimum: 1 },
  visualRenderTimeoutMs: { integer: true, minimum: 1 }
})

const GENERAL_LIMIT_RULES = Object.freeze({
  maxPdfPages: { integer: true, minimum: 1 },
  parseTimeoutMs: { integer: true, minimum: 1 }
})

function boundedAttachmentVisualLimit(value, fallback, maximum, { integer, minimum }) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum) return fallback
  return Math.min(integer ? Math.floor(number) : number, maximum)
}

export function normalizeAttachmentLimits(limits = ATTACHMENT_LIMITS) {
  const source = limits && typeof limits === 'object' ? limits : ATTACHMENT_LIMITS
  const normalized = { ...ATTACHMENT_LIMITS, ...source }
  for (const [key, rule] of Object.entries(GENERAL_LIMIT_RULES)) {
    normalized[key] = boundedAttachmentVisualLimit(
      source[key],
      ATTACHMENT_LIMITS[key],
      ATTACHMENT_HARD_LIMITS[key],
      rule
    )
  }
  for (const [key, rule] of Object.entries(VISUAL_LIMIT_RULES)) {
    normalized[key] = boundedAttachmentVisualLimit(
      source[key],
      ATTACHMENT_LIMITS[key],
      ATTACHMENT_VISUAL_HARD_LIMITS[key],
      rule
    )
  }
  return normalized
}

export function getRemainingVisualTimeoutMs(
  pageTimeoutMs,
  totalTimeoutMs,
  startedAt,
  currentTime = Date.now(),
  pageStartedAt
) {
  return Math.max(0, Math.min(
    pageStartedAt === undefined ? pageTimeoutMs : pageTimeoutMs - (currentTime - pageStartedAt),
    totalTimeoutMs - (currentTime - startedAt)
  ))
}

const FORMAT_MIME_TYPES = Object.freeze({
  pdf: new Set(['application/pdf', 'application/octet-stream']),
  docx: new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream'
  ]),
  xlsx: new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream'
  ]),
  xlsm: new Set([
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream'
  ]),
  xls: new Set(['application/vnd.ms-excel', 'application/octet-stream']),
  csv: new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream']),
  txt: new Set(['text/plain', 'application/octet-stream'])
})

const EXTENSION_FORMAT = Object.freeze({
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsm',
  '.xls': 'xls',
  '.csv': 'csv',
  '.txt': 'txt'
})

function attachmentError(status, code, message, details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function normalizeMime(value) {
  return String(value ?? 'application/octet-stream').split(';', 1)[0].trim().toLowerCase()
}

function sanitizeFilenameText(value) {
  const original = basename(String(value ?? 'resume')).normalize('NFC')
  const cleaned = original
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]+/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  const fallback = cleaned || 'resume'
  if (fallback.length <= 180) return fallback
  const extension = extname(fallback).slice(0, 20)
  return `${fallback.slice(0, Math.max(1, 180 - extension.length))}${extension}`
}

export function recoverLegacyOriginalFilename(value) {
  const original = String(value ?? '')
  const codePoints = [...original]
  if (!/[\u0080-\u009f]/.test(original) || codePoints.some((character) => character.codePointAt(0) > 0xff)) {
    return original
  }

  const latin1Bytes = Buffer.from(original, 'latin1')
  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(latin1Bytes)
  } catch {
    return original
  }
  if (
    !decoded
    || decoded === original
    || /[\u0000-\u001f\u007f-\u009f\ufffd]/.test(decoded)
    || !Buffer.from(decoded, 'utf8').equals(latin1Bytes)
    || extname(decoded).toLowerCase() !== extname(original).toLowerCase()
    || sanitizeFilenameText(decoded) !== decoded
  ) {
    return original
  }
  return decoded
}

export function sanitizeOriginalFilename(value) {
  return sanitizeFilenameText(recoverLegacyOriginalFilename(value))
}

function inspectZip(buffer, limits = ATTACHMENT_LIMITS) {
  return inspectSecureZipBuffer(buffer, limits)
}

function assertMime(format, mimeType) {
  if (!FORMAT_MIME_TYPES[format].has(mimeType)) {
    throw attachmentError(415, 'mime_mismatch', `文件 MIME 类型 ${mimeType || '未知'} 与扩展名不匹配`)
  }
}

export function validateAttachmentFile(file, limits = ATTACHMENT_LIMITS) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw attachmentError(400, 'file_required', '请使用 multipart/form-data 的 file 字段上传文件')
  }
  if (file.buffer.length === 0) throw attachmentError(422, 'empty_file', '不能上传空文件')
  if (file.buffer.length > limits.maxFileBytes) {
    throw attachmentError(413, 'file_too_large', '单个简历附件不能超过 15MB')
  }

  const originalFilename = sanitizeOriginalFilename(file.originalname)
  const extension = extname(originalFilename).toLowerCase()
  if (extension === '.doc') {
    throw attachmentError(415, 'legacy_doc_unsupported', '暂不支持旧版 .doc，请另存为未加密 .docx 后重试')
  }
  const format = EXTENSION_FORMAT[extension]
  if (!format) {
    throw attachmentError(415, 'unsupported_attachment_type', '仅支持 PDF、DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV 和 TXT')
  }
  const mimeType = normalizeMime(file.mimetype)
  assertMime(format, mimeType)

  const buffer = file.buffer
  let packageInfo = null
  if (format === 'pdf') {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw attachmentError(422, 'signature_mismatch', '文件不是有效的文本型 PDF，请勿仅修改扩展名')
    }
  } else if (format === 'xls') {
    const oleSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    if (buffer.length < oleSignature.length || !buffer.subarray(0, oleSignature.length).equals(oleSignature)) {
      throw attachmentError(422, 'signature_mismatch', '文件不是有效的 Excel 97-2003 BIFF8 .xls')
    }
  } else if (format === 'csv' || format === 'txt') {
    const invalidEncodingCode = format === 'txt' ? 'invalid_text_encoding' : 'invalid_csv_encoding'
    const formatLabel = format.toUpperCase()
    if (buffer.includes(0)) throw attachmentError(422, invalidEncodingCode, `${formatLabel} 必须是 UTF-8 文本，不能包含二进制空字符`)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw attachmentError(422, invalidEncodingCode, `${formatLabel} 必须使用有效的 UTF-8 编码`)
    }
  } else {
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      const oleSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
      const looksEncrypted = buffer.length >= oleSignature.length && buffer.subarray(0, oleSignature.length).equals(oleSignature)
      throw attachmentError(
        422,
        looksEncrypted ? 'encrypted_office_unsupported' : 'signature_mismatch',
        looksEncrypted ? '不支持加密或带密码的 Office 文件' : 'Office 文件签名与扩展名不匹配'
      )
    }
    packageInfo = inspectZip(buffer, limits)
    const names = new Set(packageInfo.names)
    if (!names.has('[content_types].xml')) {
      throw attachmentError(422, 'invalid_office_package', 'Office 文件缺少内容类型清单')
    }
    if (format === 'docx' && !names.has('word/document.xml')) {
      throw attachmentError(422, 'signature_mismatch', 'ZIP 容器不是有效的 DOCX 文档')
    }
    if (['xlsx', 'xlsm'].includes(format) && !names.has('xl/workbook.xml')) {
      throw attachmentError(422, 'signature_mismatch', 'ZIP 容器不是有效的 Excel 工作簿')
    }
    const containsMacro = packageInfo.names.some((name) => name.endsWith('/vbaproject.bin') || name === 'vbaproject.bin')
    if (format !== 'xlsm' && containsMacro) {
      throw attachmentError(422, 'macro_mismatch', '该文件包含 Office 宏，只允许以 .xlsm 只读解析')
    }
  }

  return {
    originalFilename,
    extension,
    format,
    mimeType,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    packageInfo
  }
}

export function parseAttachment(file, validated, limits = ATTACHMENT_LIMITS, options = {}) {
  const effectiveLimits = normalizeAttachmentLimits(limits)
  const signal = options?.signal
  const testVisualStageDelays = process.env.NODE_TEST_CONTEXT
    ? options?.testVisualStageDelays
    : undefined
  if (signal?.aborted) {
    return Promise.reject(attachmentError(499, 'parse_aborted', '附件解析已取消'))
  }
  const transferable = file.buffer.buffer.slice(
    file.buffer.byteOffset,
    file.buffer.byteOffset + file.buffer.byteLength
  )
  return new Promise((resolve, reject) => {
    let worker
    let timer
    let settled = false
    let abortHandler
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (abortHandler) signal?.removeEventListener('abort', abortHandler)
      callback(value)
    }
    try {
      worker = new Worker(new URL('./attachment-parser-worker.js', import.meta.url), {
        workerData: {
          buffer: transferable,
          format: validated.format,
          limits: effectiveLimits,
          renderVisualPages: options?.renderVisualPages === true,
          allowTextlessPdf: options?.allowTextlessPdf === true,
          skipAvatarExtraction: options?.skipAvatarExtraction === true,
          testVisualStageDelays
        },
        transferList: [transferable],
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 64,
          codeRangeSizeMb: 32,
          // 4 MB 栈在畸形/深层 PDF 上会栈溢出成原生 0xC0000005（并发下更容易命中）；
          // 8 MB 对单进程内存影响很小，换来解析稳定性。
          stackSizeMb: 8
        },
        // Parser workers do not need host debug/test flags. An empty allowlist
        // also prevents Node-only flags that are invalid inside Worker threads.
        execArgv: [],
        name: `resume-parser-${randomUUID()}`
      })
    } catch {
      reject(attachmentError(503, 'parser_unavailable', '附件解析服务暂时不可用，请稍后重试'))
      return
    }

    abortHandler = () => {
      worker.terminate().catch(() => {})
      finish(reject, attachmentError(499, 'parse_aborted', '附件解析已取消'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
    if (signal?.aborted) {
      abortHandler()
      return
    }

    timer = setTimeout(() => {
      worker.terminate().catch(() => {})
      finish(reject, attachmentError(504, 'parse_timeout', '附件解析超时，请重试；若持续失败，请简化或拆分文件'))
    }, effectiveLimits.parseTimeoutMs)
    timer.unref()

    worker.once('message', (message) => {
      // 结果已经拿到，但 worker 里可能还有未收尾的原生编码/字体释放动作。
      // 立即 terminate() 会在这些原生调用中途拆线程，实测并发下会出现
      // 0xC0000005（ACCESS_VIOLATION，进程级崩溃，try/catch 拦不住）。
      // 这里给一个宽限期让它自己退出；只有迟迟不退才强制终止。
      const shutdownGrace = setTimeout(() => {
        worker.terminate().catch(() => {})
      }, 2000)
      shutdownGrace.unref?.()
      worker.once('exit', () => clearTimeout(shutdownGrace))
      if (message?.ok) {
        const result = message.result
        const avatarTransfers = Array.isArray(result?.avatar_transfers) ? result.avatar_transfers : []
        const visualPageTransfers = Array.isArray(result?.visual_page_transfers) ? result.visual_page_transfers : []
        if (result && typeof result === 'object') {
          delete result.avatar_transfers
          delete result.visual_page_transfers
          Object.defineProperty(result, 'avatar_transfers', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: avatarTransfers
          })
          if (options?.renderVisualPages === true) {
            const visualPages = visualPageTransfers.map((page) => ({
              page_number: page.page_number,
              width: page.width,
              height: page.height,
              pixel_count: page.pixel_count,
              mime_type: 'image/png',
              image: new Uint8Array(page.image_buffer),
              text: page.text,
              text_spans: Array.isArray(page.text_spans) ? page.text_spans : []
            }))
            Object.defineProperty(result, 'visual_pages', {
              configurable: false,
              enumerable: false,
              writable: false,
              value: visualPages
            })
          }
        }
        finish(resolve, result)
      }
      else {
        const details = message?.error?.details
        finish(reject, attachmentError(
          message?.error?.status ?? 422,
          message?.error?.code ?? 'attachment_parse_failed',
          message?.error?.message ?? '附件解析失败',
          details
        ))
      }
    })
    worker.once('error', (cause) => {
      finish(reject, attachmentError(503, 'parser_unavailable', '附件解析服务异常终止，请重试', {
        parser_error: cause?.name ?? 'Error'
      }))
    })
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, attachmentError(503, 'parser_unavailable', '附件解析服务异常终止，请重试'))
    })
  })
}

export { attachmentError }
