import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

export const IMPORT_RESOURCE_LIMITS = Object.freeze({
  maxWorksheets: 64,
  maxColumns: 1_024,
  maxCells: 6_000_000,
  maxCellCharacters: 200_000,
  maxTotalCharacters: 128 * 1024 * 1024,
  maxZipEntries: 10_000,
  maxCentralDirectoryBytes: 16 * 1024 * 1024,
  maxUncompressedBytes: 768 * 1024 * 1024,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 2_000,
  maxParseMs: 3 * 60 * 1000,
  // Large legacy workbooks can expand into millions of mapped cells and a
  // multi-gigabyte WAL. Keep a finite guard while allowing supported imports
  // to finish on an existing large database.
  maxCommitMs: 60 * 60 * 1000,
  maxWorkerOldGenerationMb: 1_024,
  maxWorkerYoungGenerationMb: 128,
  maxWorkerCodeRangeMb: 64,
  maxWorkerStackMb: 8
})

// Values below these floors can exhaust V8 while the Worker is still
// deserializing its startup payload, before Node can emit a recoverable
// ERR_WORKER_OUT_OF_MEMORY event.
export const IMPORT_WORKER_MEMORY_MINIMUMS = Object.freeze({
  maxWorkerOldGenerationMb: 16,
  maxWorkerYoungGenerationMb: 4,
  maxWorkerCodeRangeMb: 16,
  maxWorkerStackMb: 1
})

const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_LOCAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04])

const MIME_BY_EXTENSION = new Map([
  ['.csv', new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'])],
  ['.xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])],
  ['.xlsm', new Set(['application/vnd.ms-excel.sheet.macroenabled.12'])],
  ['.xls', new Set(['application/vnd.ms-excel', 'application/xls', 'application/x-xls'])]
])

function importError(status, message, code = 'import_parse_error', details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function mergeLimits(overrides = {}) {
  const limits = { ...IMPORT_RESOURCE_LIMITS }
  for (const [key, fallback] of Object.entries(IMPORT_RESOURCE_LIMITS)) {
    const requested = Number(overrides[key])
    const minimum = IMPORT_WORKER_MEMORY_MINIMUMS[key] ?? 1
    limits[key] = Number.isSafeInteger(requested) && requested > 0
      ? Math.max(requested, minimum)
      : fallback
  }
  return limits
}

async function readHeader(path, length = 8) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(length)
    const { bytesRead } = await handle.read(header, 0, length, 0)
    return header.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function normalizedMime(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase()
}

function assertMime(extension, mimetype) {
  const mime = normalizedMime(mimetype)
  // Some browsers use the generic MIME for legacy spreadsheet uploads. The
  // extension and binary signature are still validated before parsing.
  if (!mime || mime === 'application/octet-stream') return
  if (MIME_BY_EXTENSION.get(extension)?.has(mime)) return
  throw importError(415, `文件 MIME 类型 ${mime} 与 ${extension} 扩展名不匹配`, 'import_mime_mismatch')
}

async function assertFileSignature(file, extension) {
  const header = await readHeader(file.path)
  if (extension === '.xls') {
    if (header.length >= OLE2_SIGNATURE.length && header.subarray(0, OLE2_SIGNATURE.length).equals(OLE2_SIGNATURE)) return
    throw importError(422, '文件不是有效的 Excel 97-2003 BIFF8 .xls，请勿仅修改扩展名', 'request_error')
  }
  if (extension === '.xlsx' || extension === '.xlsm') {
    if (header.length >= ZIP_LOCAL_SIGNATURE.length && header.subarray(0, ZIP_LOCAL_SIGNATURE.length).equals(ZIP_LOCAL_SIGNATURE)) return
    throw importError(
      422,
      `文件不是有效的 ${extension} ZIP 容器，可能已损坏、加密或仅修改了扩展名`,
      'import_signature_mismatch'
    )
  }
  if (header.subarray(0, ZIP_LOCAL_SIGNATURE.length).equals(ZIP_LOCAL_SIGNATURE) || header.equals(OLE2_SIGNATURE)) {
    throw importError(422, 'CSV 扩展名与文件签名不匹配', 'import_signature_mismatch')
  }
}

function fromWorkerError(payload) {
  return importError(
    payload?.status ?? 422,
    payload?.message ?? '候选人导入文件解析失败',
    payload?.code ?? 'import_parse_error',
    payload?.details
  )
}

function runImportWorker(file, extension, limits, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const worker = new Worker(new URL('./import-file-worker.js', import.meta.url), {
      workerData: { path: file.path, extension, limits },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxWorkerOldGenerationMb,
        maxYoungGenerationSizeMb: limits.maxWorkerYoungGenerationMb,
        codeRangeSizeMb: limits.maxWorkerCodeRangeMb,
        stackSizeMb: limits.maxWorkerStackMb
      },
      // Import workers do not need host debug/test flags.
      execArgv: [],
      name: `candidate-import-${randomUUID()}`
    })

    let settled = false
    let timeoutError = null
    let cancelled = false
    let timer = null
    let workerResult = null
    let workerMessageError = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      if (settled || cancelled) return
      cancelled = true
      const error = importError(499, '鍊欓€変汉瀵煎叆浠诲姟宸茬敤鎴峰彇娑?', 'import_cancelled')
      worker.terminate().then(
        () => finish(reject, error),
        () => finish(reject, error)
      )
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      timeoutError = importError(
        422,
        `文件解析超过 ${Math.ceil(limits.maxParseMs / 1000)} 秒安全时限`,
        'import_parse_timeout'
      )
      // Wait until the worker has released the file before the route removes it.
      worker.terminate().then(
        () => finish(reject, timeoutError),
        () => finish(reject, timeoutError)
      )
    }, limits.maxParseMs)
    timer.unref?.()

    worker.on('message', (message) => {
      if (settled || timeoutError || cancelled) return
      if (message?.type === 'progress') {
        onProgress?.(message)
        return
      }
      if (message?.ok) {
        workerResult = message.result && typeof message.result === 'object'
          ? message.result
          : { headers: [], rows: [], sheetName: null }
      }
      else workerMessageError = fromWorkerError(message?.error)
    })
    worker.once('error', (cause) => {
      if (timeoutError || cancelled) return
      const outOfMemory = cause?.code === 'ERR_WORKER_OUT_OF_MEMORY'
      finish(
        reject,
        importError(
          422,
          outOfMemory ? '文件解析超过内存安全限制' : '候选人导入解析进程异常终止',
          outOfMemory ? 'import_memory_limit_exceeded' : 'import_worker_failed',
          {
            parser_error: cause?.name ?? 'Error',
            ...(outOfMemory ? {
              file_size_bytes: Number(file.size ?? 0),
              max_worker_old_generation_mb: limits.maxWorkerOldGenerationMb,
              max_worker_young_generation_mb: limits.maxWorkerYoungGenerationMb
            } : {})
          }
        )
      )
    })
    worker.once('exit', (code) => {
      if (timeoutError || cancelled) return
      if (workerResult && code === 0) {
        workerResult.metrics = {
          ...(workerResult.metrics ?? {}),
          signature_ms: Number(workerResult.metrics?.signature_ms ?? 0),
          worker_roundtrip_ms: Math.round(performance.now() - startedAt)
        }
        finish(resolve, workerResult)
        return
      }
      if (workerMessageError) {
        finish(reject, workerMessageError)
        return
      }
      const message = code === 0
        ? '候选人导入解析进程未返回结果'
        : '候选人导入解析进程异常终止'
      finish(reject, importError(422, message, 'import_worker_failed'))
    })
  })
}

export async function readCandidateImportFile(file, limitOverrides = {}, executionOptions = {}) {
  if (!file?.path) throw importError(400, '候选人导入缺少临时文件', 'import_file_missing')
  const extension = extname(file.originalname ?? '').toLowerCase()
  if (!MIME_BY_EXTENSION.has(extension)) {
    throw importError(415, '仅支持 .xlsx、.xlsm、.xls 或 UTF-8 .csv 文件', 'import_format_unsupported')
  }
  assertMime(extension, file.mimetype)
  executionOptions.onProgress?.({ phase: 'validating', progress: 10 })
  const signatureStartedAt = performance.now()
  await assertFileSignature(file, extension)
  const signatureValidationMs = Math.round(performance.now() - signatureStartedAt)
  executionOptions.onProgress?.({
    phase: extension === '.xlsx' || extension === '.xlsm' ? 'zip_validation' : 'parsing',
    progress: 25,
    metrics: { signature_validation_ms: signatureValidationMs }
  })
  const limits = mergeLimits(limitOverrides)
  const result = await runImportWorker(file, extension, limits, executionOptions)
  result.metrics = {
    ...(result.metrics ?? {}),
    signature_ms: signatureValidationMs,
    signature_validation_ms: signatureValidationMs
  }
  return result
}
