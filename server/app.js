import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AGENT_TOOL_NAMES, CANDIDATE_FIELDS } from './constants.js'
import {
  addNote,
  archiveCandidate,
  archiveCandidates,
  assertCandidateActive,
  candidateExists,
  dashboard,
  findDuplicate,
  getCandidate,
  insertCandidate,
  listActivities,
  listCandidateFacets,
  listCandidates,
  listNotes,
  patchCandidate,
  restoreCandidate
} from './candidates.js'
import { createAgentService } from './agent.js'
import { BusinessSearchMaintenanceService } from './business-search-maintenance.js'
import { SearchVectorMaintenanceService } from './search-vector-maintenance-service.js'
import { configuredDatabasePath, listStages, openDatabase, withTransaction } from './database.js'
import { createAttachmentService } from './attachments.js'
import { recoverLegacyOriginalFilename } from './attachment-parser.js'
import { createAttachmentVisualParser } from './attachment-visual-parser.js'
import {
  ATTACHMENT_BATCH_LIMITS,
  attachmentBatchError,
  createAttachmentBatchService,
  isTopLevelAttachmentArchive
} from './attachment-batches.js'
import {
  commitCandidateDeletion,
  commitPositionDeletion,
  createDeletionPreviewStore,
  previewCandidateDeletion,
  previewPositionDeletion
} from './deletions.js'
import {
  commitImport,
  commitStructuredImport,
  createImportPreview,
  DEFAULT_IMPORT_PREVIEW_MAX_ENTRIES,
  DEFAULT_IMPORT_PREVIEW_TTL_MS,
  exportCandidates,
  IMPORT_FAILURE_DETAIL_LIMIT,
  ImportPreviewStore
} from './import-export.js'
import { IMPORT_RESOURCE_LIMITS, IMPORT_WORKER_MEMORY_MINIMUMS } from './import-file.js'
import { CandidateImportTaskService } from './import-tasks.js'
import {
  archivePosition,
  archivePositions,
  getPosition,
  insertPosition,
  linkCandidates,
  listCandidatePositions,
  listPositionFacets,
  listPositions,
  patchPosition,
  POSITION_FIELDS,
  positionExists,
  restorePosition,
  sanitizePositionInput,
  unlinkCandidate,
  unlinkCandidates
} from './positions.js'
import { changedFields, normalizePhotoUrl, sanitizeCandidateInput } from './validation.js'
import {
  archiveTalentPool,
  archiveTalentPools,
  getTalentPool,
  insertTalentPool,
  linkCandidatesToTalentPool,
  listTalentPools,
  patchTalentPool,
  permanentlyDeleteTalentPools,
  replaceCandidatePreferences,
  replaceCandidateProfileSections,
  restoreTalentPool,
  restoreTalentPools,
  sanitizeTalentPoolInput,
  talentPoolExists,
  unlinkCandidatesFromTalentPool
} from './talent.js'
import {
  getResumeSearchStatus,
  searchCandidateResumesIndexed
} from './resume-search.js'
import { ResumeSearchService } from './resume-search-service.js'
import { HybridSearchService } from './hybrid-search-service.js'
import { AuthError } from './auth/ldap.js'

export const DEFAULT_CANDIDATE_IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_CANDIDATE_IMPORT_ASYNC_THRESHOLD_BYTES = 8 * 1024 * 1024
export const DEFAULT_CANDIDATE_IMPORT_ASYNC_COMMIT_ROWS = 2_000
const ATTACHMENT_MAX_FILE_BYTES = 15 * 1024 * 1024

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: ATTACHMENT_MAX_FILE_BYTES, files: 1 }
})

function positiveByteLimit(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isSqliteBusyError(error) {
  return error?.code === 'SQLITE_BUSY' ||
    Number(error?.errcode) === 5 ||
    /database (?:is )?(?:locked|busy)/i.test(String(error?.message ?? ''))
}

function cleanImportFilename(value) {
  const recovered = recoverLegacyOriginalFilename(basename(String(value ?? 'candidate-import')))
  const leaf = basename(recovered).replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()
  const safe = leaf || 'candidate-import'
  if (safe.length <= 255) return safe
  const extension = extname(safe).slice(0, 20)
  return `${safe.slice(0, 255 - extension.length)}${extension}`
}

function safeAttachmentRelativePath(value) {
  const normalized = String(value ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => recoverLegacyOriginalFilename(segment))
    .join('/')
    .normalize('NFC')
    .trim()
  const segments = normalized.split('/')
  if (
    !normalized || normalized.startsWith('/') || normalized.startsWith('//') ||
    /^[a-z]:/i.test(normalized) || normalized.includes('\0') || normalized.length > 1_000 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))
  ) {
    throw httpError(422, '附件目录包含不安全路径', undefined, 'unsafe_attachment_relative_path')
  }
  return normalized
}

function byteLimitLabel(bytes) {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`
  return `${bytes} bytes`
}

function attachmentBatchDiskStorage({ destination, maxTotalBytes, maxArchiveBytes, maxAttachmentBytes }) {
  return {
    _handleFile(req, file, callback) {
      const filename = randomUUID()
      const path = resolve(destination, filename)
      let fileBytes = 0
      const archive = isTopLevelAttachmentArchive(file.originalname, file.mimetype)
      const maxFileBytes = archive ? maxArchiveBytes : maxAttachmentBytes
      let callbackCalled = false
      const done = (error, info) => {
        if (callbackCalled) return
        callbackCalled = true
        callback(error, info)
      }
      const counter = new Transform({
        transform(chunk, _encoding, transformCallback) {
          const nextTotal = Number(req.attachmentBatchUploadedBytes ?? 0) + chunk.length
          req.attachmentBatchUploadedBytes = nextTotal
          fileBytes += chunk.length
          if (fileBytes > maxFileBytes) {
            transformCallback(attachmentBatchError(
              413,
              'file_too_large',
              archive
                ? `批次中的单个压缩包超过 ${byteLimitLabel(maxFileBytes)} 上限`
                : `单个简历附件超过 ${byteLimitLabel(maxFileBytes)} 上限`,
              { max_file_size_bytes: maxFileBytes, archive }
            ))
            return
          }
          if (nextTotal > maxTotalBytes) {
            transformCallback(attachmentBatchError(
              413,
              'attachment_batch_size_limit',
              `批量附件实际上传总量超过 ${byteLimitLabel(maxTotalBytes)} 上限`,
              { max_batch_upload_bytes: maxTotalBytes }
            ))
            return
          }
          transformCallback(null, chunk)
        }
      })
      const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })
      pipeline(file.stream, counter, output).then(
        () => done(null, { destination, filename, path, size: fileBytes }),
        async (error) => {
          try { await unlink(path) } catch {}
          done(error)
        }
      )
    },
    _removeFile(_req, file, callback) {
      const path = file?.path
      delete file.destination
      delete file.filename
      delete file.path
      if (!path) return callback(null)
      unlink(path).then(() => callback(null), (error) => error?.code === 'ENOENT' ? callback(null) : callback(error))
    }
  }
}

function resolveImportResourceLimits(overrides = {}) {
  return Object.freeze(Object.fromEntries(
    Object.entries(IMPORT_RESOURCE_LIMITS).map(([key, fallback]) => [
      key,
      Math.max(
        positiveByteLimit(overrides?.[key], fallback),
        IMPORT_WORKER_MEMORY_MINIMUMS[key] ?? 1
      )
    ])
  ))
}

async function removeImportTemporaryFile(path, options = {}) {
  const unlinkFile = options.unlinkFile ?? unlink
  const attempts = positiveByteLimit(options.attempts, 3)
  const retryDelayMs = positiveByteLimit(options.retryDelayMs, 25)
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await unlinkFile(path)
      return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs * attempt))
      }
    }
  }
  throw lastError
}

function httpError(status, message, details, code = 'request_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function privateNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store')
}

/**
 * 当前请求的登录用户 ID。未启用认证时返回 null，此时业务库按单用户语义运行，
 * 会话归属过滤不生效；启用认证后每个请求都会带上真实用户 ID。
 */
function authenticatedUserId(req) {
  return req?.auth?.user?.id ?? null
}

function stageValues(db) {
  return listStages(db).map((stage) => stage.value)
}

function booleanQuery(value, field) {
  if (value == null || value === '') return false
  if (Array.isArray(value) || typeof value !== 'string' || !['true', 'false'].includes(value.toLowerCase())) {
    throw httpError(400, `${field} 只支持 true 或 false`, [{ field }], 'invalid_query')
  }
  return value.toLowerCase() === 'true'
}

function setCors(req, res, next) {
  const origin = req.headers.origin
  const configured = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const allowed = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    ...configured
  ])
  const loopbackOrigin = typeof origin === 'string'
    && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(origin)
  // Same-origin requests are always allowed. Comparing the Origin against the
  // request's own Host keeps LAN deployments working behind a reverse proxy
  // without maintaining an origin allowlist, and still rejects cross-site
  // writes because those carry a different Origin than Host.
  let sameOrigin = false
  if (typeof origin === 'string') {
    try {
      sameOrigin = new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase()
    } catch {
      sameOrigin = false
    }
  }
  const originAllowed = !origin || allowed.has(origin) || loopbackOrigin || sameOrigin
  if (origin && originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, Prefer')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  }
  if (!originAllowed && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({
      error: { code: 'origin_not_allowed', message: '不允许来自该页面来源的写请求' }
    })
  }
  if (req.method === 'OPTIONS') return res.sendStatus(originAllowed ? 204 : 403)
  return next()
}

function paginatedPayload(result) {
  const pagination = result.pagination ?? {}
  const items = result.items ?? result.data ?? []
  return {
    ...result,
    data: items,
    items,
    page: pagination.page,
    page_size: pagination.page_size,
    total: pagination.total,
    total_pages: pagination.total_pages,
    has_next: pagination.has_next
  }
}

export function createApp(options = {}) {
  const auth = options.auth ?? null
  const databasePath = options.databasePath ?? (options.db ? null : configuredDatabasePath())
  const backgroundSearchMaintenance = !options.db && databasePath !== ':memory:'
  const db = options.db ?? openDatabase(databasePath, { synchronizeSearch: !backgroundSearchMaintenance })
  const searchMaintenance = options.searchMaintenanceService ?? (
    backgroundSearchMaintenance
      ? new BusinessSearchMaintenanceService({
          databasePath,
          batchSize: options.searchIndexBatchSize ?? 100,
          activeDelayMs: options.searchIndexActiveDelayMs ?? 25,
          idleDelayMs: options.searchIndexIdleDelayMs ?? 1_000
        })
      : null
  )
  const resumeSearch = options.resumeSearchService ?? (
    databasePath && databasePath !== ':memory:'
      ? new ResumeSearchService({
          databasePath,
          workerTimeoutMs: options.resumeSearchWorkerTimeoutMs ?? 30_000,
          retryCount: options.resumeSearchRetryCount ?? 1,
          maxConcurrent: options.resumeSearchConcurrency ?? 2
        })
      : {
          search: async (input) => searchCandidateResumesIndexed(db, input, { defaultFast: true }),
          status: async () => getResumeSearchStatus(db),
          close: async () => undefined
        }
  )
  const hybridResumeSearch = options.hybridSearchService ?? new HybridSearchService({
    ...(databasePath && databasePath !== ':memory:' ? { databasePath } : { db }),
    remoteEnabled: options.searchRemoteEnabled ?? process.env.SEARCH_REMOTE_ENABLED === 'true',
    modelConfig: options.searchModelConfig,
    vectorDirectory: options.searchVectorDirectory ?? process.env.SEARCH_VECTOR_DIRECTORY,
    dimensions: Number(process.env.SEARCH_EMBEDDING_DIMENSIONS ?? 1024)
  })
  const vectorDirectory = options.searchVectorDirectory ?? process.env.SEARCH_VECTOR_DIRECTORY
  const remoteSearchEnabled = options.searchRemoteEnabled ?? process.env.SEARCH_REMOTE_ENABLED === 'true'
  const vectorMaintenanceEnabled = options.searchVectorMaintenanceEnabled ?? process.env.SEARCH_VECTOR_MAINTENANCE_ENABLED === 'true'
  const vectorMaintenance = options.searchVectorMaintenanceService ?? (
    remoteSearchEnabled && vectorMaintenanceEnabled && vectorDirectory && databasePath && databasePath !== ':memory:'
      ? new SearchVectorMaintenanceService({
          databasePath, directory: vectorDirectory,
          dimensions: Number(process.env.SEARCH_EMBEDDING_DIMENSIONS ?? 1024),
          model: options.searchModelConfig?.embeddingModel ?? process.env.SEARCH_EMBEDDING_MODEL ?? 'text-embedding-v4',
          modelConfig: options.searchModelConfig,
          concurrency: Number(process.env.SEARCH_VECTOR_MAINTENANCE_CONCURRENCY ?? 4),
          intervalMs: Number(process.env.SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS ?? 300_000)
        })
      : null
  )
  if (remoteSearchEnabled) void hybridResumeSearch.warmup?.().catch(() => undefined)
  const importPreviewTtlMs = positiveByteLimit(options.importPreviewTtlMs, DEFAULT_IMPORT_PREVIEW_TTL_MS)
  const importPreviewMaxEntries = positiveByteLimit(
    options.importPreviewMaxEntries,
    DEFAULT_IMPORT_PREVIEW_MAX_ENTRIES
  )
  const previewStore = options.previewStore ?? new ImportPreviewStore({
    ttlMs: importPreviewTtlMs,
    maxEntries: importPreviewMaxEntries,
    cleanupIntervalMs: options.importPreviewCleanupIntervalMs
  })
  const deletionPreviewStore = options.deletionPreviewStore ?? createDeletionPreviewStore()
  const importMaxFileBytes = positiveByteLimit(
    options.importMaxFileBytes ?? process.env.CANDIDATE_IMPORT_MAX_BYTES,
    DEFAULT_CANDIDATE_IMPORT_MAX_FILE_BYTES
  )
  const importResourceLimits = resolveImportResourceLimits(options.importResourceLimits)
  const persistentImportUploadRoot = !options.importUploadRoot && databasePath && databasePath !== ':memory:'
    ? resolve(dirname(databasePath), 'private', 'imports')
    : null
  const temporaryImportUploadRoot = options.importUploadRoot || persistentImportUploadRoot
    ? null
    : mkdtempSync(join(tmpdir(), 'candidate-workbench-imports-'))
  const importUploadRoot = options.importUploadRoot
    ? resolve(options.importUploadRoot)
    : persistentImportUploadRoot ?? temporaryImportUploadRoot
  mkdirSync(importUploadRoot, { recursive: true })
  const importAsyncThresholdBytes = positiveByteLimit(
    options.importAsyncThresholdBytes ?? process.env.CANDIDATE_IMPORT_ASYNC_THRESHOLD_BYTES,
    DEFAULT_CANDIDATE_IMPORT_ASYNC_THRESHOLD_BYTES
  )
  const importAsyncCommitRows = positiveByteLimit(
    options.importAsyncCommitRows ?? process.env.CANDIDATE_IMPORT_ASYNC_COMMIT_ROWS,
    DEFAULT_CANDIDATE_IMPORT_ASYNC_COMMIT_ROWS
  )
  const candidateImportUpload = multer({
    defParamCharset: 'utf8',
    storage: multer.diskStorage({
      destination: importUploadRoot,
      filename: (req, file, callback) => callback(null, randomUUID())
    }),
    limits: {
      fileSize: importMaxFileBytes,
      files: 1,
      fields: 10,
      fieldSize: 256 * 1024,
      parts: 11
    }
  })
  let candidateImportPreviewActive = false
  const acquireCandidateImportPreview = (req, res, next) => {
    const commitActive = importTasks?.hasActiveCommit?.() === true
    if (candidateImportPreviewActive || commitActive) {
      res.setHeader('Retry-After', '1')
      return next(httpError(
        429,
        '已有候选人文件正在上传或解析，请稍后重试',
        { max_concurrent_previews: 1, active_commit: commitActive },
        'import_busy'
      ))
    }
    candidateImportPreviewActive = true
    req.candidateImportUploadStartedAt = performance.now()
    let released = false
    const release = () => {
      if (released) return
      released = true
      candidateImportPreviewActive = false
    }
    req.releaseCandidateImportPreview = release
    req.once('aborted', release)
    res.once('finish', release)
    res.once('close', release)
    return next()
  }
  const importTasks = options.importTaskService ?? new CandidateImportTaskService({
    db,
    databasePath,
    previewStore,
    uploadRoot: importUploadRoot,
    validStages: () => stageValues(db),
    resourceLimits: importResourceLimits,
    maxConcurrent: options.importTaskConcurrency ?? 1,
    recoverOnStartup: options.recoverImportTasksOnStartup,
    enablePreviewCleanupTimer: options.enableImportTaskPreviewCleanupTimer,
    removeUpload: async (path) => removeImportTemporaryFile(path, {
      unlinkFile: options.importTempUnlink,
      attempts: options.importTempCleanupAttempts,
      retryDelayMs: options.importTempCleanupRetryDelayMs
    })
  })
  const agent = options.agentService ?? createAgentService(db, {
    ...options.agentConfig,
    hybridSearchService: hybridResumeSearch,
    databasePath,
    exportRoot: options.agentExportRoot ?? resolve(process.cwd(), 'exports', 'agent')
  })
  const attachmentVisualParser = options.attachmentVisualParser ?? createAttachmentVisualParser(
    options.attachmentVisualConfig ?? {}
  )
  const temporaryAttachmentRoot = !options.attachmentRoot && (!databasePath || databasePath === ':memory:')
    ? mkdtempSync(join(tmpdir(), 'candidate-workbench-attachments-'))
    : null
  const attachmentRoot = options.attachmentRoot
    ?? temporaryAttachmentRoot
    ?? resolve(dirname(databasePath ?? configuredDatabasePath()), 'private', 'attachments')
  const attachments = options.attachmentService ?? createAttachmentService({
    db,
    rootDir: attachmentRoot,
    parser: options.attachmentParser,
    suggestionProvider: Object.prototype.hasOwnProperty.call(options, 'attachmentSuggestionProvider')
      ? options.attachmentSuggestionProvider
      : agent.suggestAttachment,
    visualSuggestionProvider: Object.prototype.hasOwnProperty.call(options, 'attachmentVisualSuggestionProvider')
      ? options.attachmentVisualSuggestionProvider
      : attachmentVisualParser,
    previewTtlMs: options.attachmentPreviewTtlMs,
    parseConcurrency: options.attachmentParseConcurrency
  })
  const attachmentBatches = options.attachmentBatchService ?? createAttachmentBatchService({
    db,
    attachmentService: attachments,
    limits: options.attachmentBatchLimits,
    processingConcurrency: options.attachmentBatchConcurrency
  })
  const attachmentBatchMultipartRoot = resolve(attachmentRoot, 'batch-multipart')
  mkdirSync(attachmentBatchMultipartRoot, { recursive: true })
  for (const entry of readdirSync(attachmentBatchMultipartRoot)) {
    const path = resolve(attachmentBatchMultipartRoot, entry)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() || stat.isSymbolicLink()) unlinkSync(path)
    } catch {}
  }
  const attachmentBatchMaxUploadBytes = attachmentBatches.limits?.maxBatchUploadBytes
    ?? ATTACHMENT_BATCH_LIMITS.maxBatchUploadBytes
  const attachmentBatchRequestOverheadBytes = 64 * 1024 +
    (attachmentBatches.limits?.maxUploadFiles ?? ATTACHMENT_BATCH_LIMITS.maxUploadFiles) * 1024
  const attachmentBatchUpload = multer({
    preservePath: true,
    defParamCharset: 'utf8',
    storage: attachmentBatchDiskStorage({
      destination: attachmentBatchMultipartRoot,
      maxTotalBytes: attachmentBatchMaxUploadBytes,
      maxArchiveBytes: attachmentBatches.limits?.maxArchiveBytes ?? ATTACHMENT_BATCH_LIMITS.maxArchiveBytes,
      maxAttachmentBytes: attachmentBatches.limits?.maxAttachmentBytes ?? ATTACHMENT_BATCH_LIMITS.maxAttachmentBytes
    }),
    limits: {
      fileSize: attachmentBatches.limits?.maxArchiveBytes ?? ATTACHMENT_BATCH_LIMITS.maxArchiveBytes,
      files: attachmentBatches.limits?.maxUploadFiles ?? ATTACHMENT_BATCH_LIMITS.maxUploadFiles,
      fields: 5,
      fieldSize: 16 * 1024,
      parts: (attachmentBatches.limits?.maxUploadFiles ?? ATTACHMENT_BATCH_LIMITS.maxUploadFiles) + 5
    }
  })
  const removeAttachmentBatchUploads = async (files = []) => {
    await Promise.allSettled(files.map((file) => file?.path ? unlink(file.path) : undefined))
  }
  const receiveAttachmentBatch = (req, res, next) => {
    const declaredBytes = Number(req.get('Content-Length'))
    if (
      Number.isFinite(declaredBytes) && declaredBytes >
        attachmentBatchMaxUploadBytes + attachmentBatchRequestOverheadBytes
    ) {
      return next(attachmentBatchError(
        413,
        'attachment_batch_size_limit',
        `批量附件请求体超过 ${byteLimitLabel(attachmentBatchMaxUploadBytes)} 文件总量上限`,
        { max_batch_upload_bytes: attachmentBatchMaxUploadBytes }
      ))
    }
    req.attachmentBatchUploadedBytes = 0
    attachmentBatchUpload.array('files', attachmentBatches.limits?.maxUploadFiles ?? ATTACHMENT_BATCH_LIMITS.maxUploadFiles)(req, res, (error) => {
      if (!error) return next()
      void removeAttachmentBatchUploads(Array.isArray(req.files) ? req.files : []).then(() => next(error))
    })
  }
  const attachmentBatchToken = (req) => req.get('X-Attachment-Batch-Token')
  const attachmentBatchOptions = (req) => ({ batchToken: attachmentBatchToken(req) })
  const app = express()

  app.disable('x-powered-by')
  app.use(setCors)
  app.use(express.json({ limit: '1mb' }))
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; " +
        "font-src 'self' data:; connect-src 'self'"
    )
    next()
  })

  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get()
    res.json({ status: 'ok', service: 'recruitment-api', timestamp: new Date().toISOString() })
  })

  if (auth) {
    app.post('/api/auth/login', auth.middleware.loginHandler)
    app.post('/api/auth/logout', auth.middleware.requireSession, auth.middleware.logoutHandler)
    app.get('/api/auth/session', auth.middleware.sessionHandler)
    app.get('/api/auth/me', auth.middleware.requireSession, auth.middleware.meHandler)
    // Public by design: it exposes only the authentication mode and allowlist
    // file status, never allowlist contents, credentials or session data.
    app.get('/api/auth/status', (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(auth.middleware.status())
    })
    // Mounted by prefix so every existing and future /api route is protected
    // by default; only the paths in PUBLIC_API_PATHS stay anonymous.
    app.use('/api', auth.middleware.guard)
  }

  app.get('/api/stages', (req, res) => res.json({ data: listStages(db) }))

  app.get('/api/dashboard', (req, res) => res.json(dashboard(db)))

  app.get('/api/candidates', (req, res) => {
    const result = listCandidates(db, req.query)
    res.json(paginatedPayload(result))
  })

  app.get('/api/candidates/facets', (req, res) => {
    res.json(listCandidateFacets(db, req.query))
  })

  app.get('/api/talent-pools', (req, res) => {
    const result = listTalentPools(db, req.query)
    res.json(paginatedPayload(result))
  })

  app.post('/api/talent-pools', (req, res) => {
    const { value, errors } = sanitizeTalentPoolInput(req.body)
    if (errors.length) throw httpError(422, '人才库字段校验失败', errors, 'validation_error')
    res.status(201).json(withTransaction(db, () => insertTalentPool(db, value)))
  })

  app.post('/api/talent-pools/archive-batch', (req, res) => {
    res.json(archiveTalentPools(db, req.body?.records))
  })

  app.post('/api/talent-pools/restore-batch', (req, res) => {
    res.json(restoreTalentPools(db, req.body?.records))
  })

  app.post('/api/talent-pools/permanent-delete-batch', (req, res) => {
    res.json(permanentlyDeleteTalentPools(db, req.body?.records))
  })

  app.get('/api/talent-pools/:id/candidates', (req, res) => {
    if (!talentPoolExists(db, req.params.id)) throw httpError(404, '人才库不存在', undefined, 'not_found')
    const result = listCandidates(db, { ...req.query, pool_id: req.params.id })
    res.json(paginatedPayload(result))
  })

  app.post('/api/talent-pools/:id/candidates', (req, res) => {
    const result = linkCandidatesToTalentPool(db, req.params.id, req.body?.candidate_ids)
    res.status(result.linked_count ? 201 : 200).json(result)
  })

  app.delete('/api/talent-pools/:id/candidates', (req, res) => {
    res.json(unlinkCandidatesFromTalentPool(db, req.params.id, req.body?.candidate_ids))
  })

  app.get('/api/talent-pools/:id', (req, res) => {
    const pool = getTalentPool(db, req.params.id)
    if (!pool) throw httpError(404, '人才库不存在', undefined, 'not_found')
    res.json(pool)
  })

  app.patch('/api/talent-pools/:id', (req, res) => {
    if (!talentPoolExists(db, req.params.id)) throw httpError(404, '人才库不存在', undefined, 'not_found')
    const { value, errors } = sanitizeTalentPoolInput(req.body, { partial: true })
    if (errors.length) throw httpError(422, '人才库字段校验失败', errors, 'validation_error')
    if (Object.keys(value).length === 0) throw httpError(400, '没有可更新的人才库字段')
    res.json(withTransaction(db, () => patchTalentPool(db, req.params.id, value)))
  })

  app.post('/api/talent-pools/:id/archive', (req, res) => {
    if (!talentPoolExists(db, req.params.id)) throw httpError(404, '人才库不存在', undefined, 'not_found')
    const archived = archiveTalentPool(db, req.params.id, req.body?.expected_updated_at)
    if (!archived) {
      throw httpError(409, '人才库已归档，不能重复归档', {
        talent_pool_id: req.params.id
      }, 'talent_pool_archive_conflict')
    }
    res.json(getTalentPool(db, req.params.id))
  })

  app.post('/api/talent-pools/:id/restore', (req, res) => {
    if (!talentPoolExists(db, req.params.id)) throw httpError(404, '人才库不存在', undefined, 'not_found')
    const restored = restoreTalentPool(db, req.params.id, req.body?.expected_updated_at)
    if (!restored) {
      throw httpError(409, '人才库未归档，不能恢复', {
        talent_pool_id: req.params.id
      }, 'talent_pool_restore_conflict')
    }
    res.json(getTalentPool(db, req.params.id))
  })

  app.post('/api/talent-pools/:id/permanent-delete', (req, res) => {
    const result = permanentlyDeleteTalentPools(db, [{
      id: req.params.id,
      expected_updated_at: req.body?.expected_updated_at
    }])
    res.json({ ...result, talent_pool_id: req.params.id })
  })

  app.get('/api/positions', (req, res) => {
    const result = listPositions(db, req.query)
    res.json(paginatedPayload(result))
  })

  app.get('/api/positions/facets', (req, res) => {
    res.json(listPositionFacets(db, req.query))
  })

  app.post('/api/positions', (req, res) => {
    const { value, errors } = sanitizePositionInput(req.body)
    if (errors.length) throw httpError(422, '职位字段校验失败', errors, 'validation_error')
    const position = withTransaction(db, () => insertPosition(db, value))
    res.status(201).json(position)
  })

  app.post('/api/positions/archive-batch', (req, res) => {
    res.json(archivePositions(db, req.body?.records))
  })

  app.get('/api/positions/:id/candidates', (req, res) => {
    if (!positionExists(db, req.params.id)) throw httpError(404, '职位不存在', undefined, 'not_found')
    const result = listCandidates(db, { ...req.query, position_id: req.params.id })
    res.json(paginatedPayload(result))
  })

  app.post('/api/positions/:id/candidates', (req, res) => {
    const result = linkCandidates(db, req.params.id, req.body?.candidate_ids)
    res.status(result.linked_count > 0 ? 201 : 200).json(result)
  })

  app.delete('/api/positions/:id/candidates', (req, res) => {
    res.json(unlinkCandidates(db, req.params.id, req.body?.candidate_ids))
  })

  app.delete('/api/positions/:id/candidates/:candidateId', (req, res) => {
    res.json(unlinkCandidate(db, req.params.id, req.params.candidateId))
  })

  app.get('/api/positions/:id', (req, res) => {
    const position = getPosition(db, req.params.id)
    if (!position) throw httpError(404, '职位不存在', undefined, 'not_found')
    res.json(position)
  })

  app.patch('/api/positions/:id', (req, res) => {
    if (!positionExists(db, req.params.id)) throw httpError(404, '职位不存在', undefined, 'not_found')
    const requestedFields = POSITION_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field))
    if (requestedFields.length === 0) throw httpError(400, '没有可更新的职位字段')
    const { value, errors } = sanitizePositionInput(req.body, { partial: true })
    if (errors.length) throw httpError(422, '职位字段校验失败', errors, 'validation_error')
    res.json(withTransaction(db, () => patchPosition(db, req.params.id, value)))
  })

  app.post('/api/positions/:id/archive', (req, res) => {
    if (!positionExists(db, req.params.id)) throw httpError(404, '职位不存在', undefined, 'not_found')
    withTransaction(db, () => archivePosition(db, req.params.id))
    res.json(getPosition(db, req.params.id))
  })

  app.post('/api/positions/:id/restore', (req, res) => {
    if (!positionExists(db, req.params.id)) throw httpError(404, '职位不存在', undefined, 'not_found')
    withTransaction(db, () => restorePosition(db, req.params.id))
    res.json(getPosition(db, req.params.id))
  })

  app.post('/api/positions/permanent-delete/preview', (req, res) => {
    res.json(previewPositionDeletion(db, req.body, deletionPreviewStore))
  })

  app.post('/api/positions/permanent-delete/commit', (req, res) => {
    res.json(commitPositionDeletion(db, req.body, deletionPreviewStore))
  })

  app.post('/api/positions/:id/permanent-delete/preview', (req, res) => {
    res.json(previewPositionDeletion(db, { position_ids: [req.params.id] }, deletionPreviewStore))
  })

  app.post('/api/positions/:id/permanent-delete', (req, res) => {
    res.json(commitPositionDeletion(db, {
      ...(req.body ?? {}),
      position_ids: [req.params.id]
    }, deletionPreviewStore))
  })

  const handleExport = asyncRoute(async (req, res) => {
    const requestedFormat = req.query.format
    if (Array.isArray(requestedFormat) || (requestedFormat != null && typeof requestedFormat !== 'string')) {
      throw httpError(400, 'format 必须是单值查询参数', [{ field: 'format', message: 'format 必须是单值查询参数' }], 'invalid_query')
    }
    const format = String(requestedFormat ?? 'xlsx').trim().toLowerCase()
    if (!['xlsx', 'csv'].includes(format)) {
      throw httpError(400, 'format 仅支持 xlsx 或 csv', [{ field: 'format', message: 'format 仅支持 xlsx 或 csv' }], 'invalid_query')
    }
    const candidates = listCandidates(db, req.query, { paginate: false, includeSensitive: true })
    const result = await exportCandidates(candidates, format)
    const date = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', result.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="candidates-${date}.${result.extension}"`)
    res.send(result.buffer)
  })
  app.get('/api/export', handleExport)
  app.get('/api/candidates/export', handleExport)

  const candidateImportConfig = Object.freeze({
    max_file_size_bytes: importMaxFileBytes,
    preview_row_limit: 20,
    preview_ttl_ms: importPreviewTtlMs,
    preview_store_max_entries: importPreviewMaxEntries,
    max_concurrent_previews: 1,
    max_concurrent_tasks: Math.max(1, Number(options.importTaskConcurrency ?? 1)),
    async_threshold_bytes: importAsyncThresholdBytes,
    async_commit_threshold_rows: importAsyncCommitRows,
    task_status_endpoint: '/api/candidates/import/tasks/{task_id}',
    commit_failure_detail_limit: IMPORT_FAILURE_DETAIL_LIMIT,
    allowed_extensions: ['.csv', '.xlsx', '.xlsm', '.xls'],
    resource_limits: {
      max_worksheets: importResourceLimits.maxWorksheets,
      max_columns: importResourceLimits.maxColumns,
      max_cells: importResourceLimits.maxCells,
      max_cell_characters: importResourceLimits.maxCellCharacters,
      max_total_characters: importResourceLimits.maxTotalCharacters,
      max_zip_entries: importResourceLimits.maxZipEntries,
      max_central_directory_bytes: importResourceLimits.maxCentralDirectoryBytes,
      max_uncompressed_bytes: importResourceLimits.maxUncompressedBytes,
      max_entry_uncompressed_bytes: importResourceLimits.maxEntryUncompressedBytes,
      max_compression_ratio: importResourceLimits.maxCompressionRatio,
      max_parse_ms: importResourceLimits.maxParseMs,
      max_commit_ms: importResourceLimits.maxCommitMs,
      max_worker_old_generation_mb: importResourceLimits.maxWorkerOldGenerationMb,
      max_worker_young_generation_mb: importResourceLimits.maxWorkerYoungGenerationMb,
      max_worker_code_range_mb: importResourceLimits.maxWorkerCodeRangeMb,
      max_worker_stack_mb: importResourceLimits.maxWorkerStackMb
    }
  })
  app.get('/api/import/config', (req, res) => res.json(candidateImportConfig))
  app.get('/api/candidates/import/config', (req, res) => res.json(candidateImportConfig))

  const handlePreview = asyncRoute(async (req, res) => {
    if (!req.file) throw httpError(400, '请使用 multipart/form-data 的 file 字段上传文件')
    const temporaryPath = req.file.path
    const uploadMetrics = {
      upload_bytes: Number(req.file.size ?? 0),
      multipart_upload_ms: Math.max(
        0,
        Math.round(performance.now() - Number(req.candidateImportUploadStartedAt ?? performance.now()))
      )
    }
    const requestedAsync = req.forceCandidateImportAsync === true ||
      /^(?:1|true)$/i.test(String(req.body?.async ?? '')) ||
      String(req.get('Prefer') ?? '').toLowerCase().includes('respond-async')
    const previewIdempotencyKey = req.get('Idempotency-Key') ?? req.body?.client_request_id ?? req.body?.idempotency_key
    if (requestedAsync || Boolean(previewIdempotencyKey) || Number(req.file.size ?? 0) >= importAsyncThresholdBytes) {
      try {
        req.file.originalname = cleanImportFilename(req.file.originalname)
        const task = await importTasks.createPreviewTask({
          file: req.file,
          body: req.body,
          idempotencyKey: previewIdempotencyKey,
          uploadMetrics
        })
        req.releaseCandidateImportPreview?.()
        res.setHeader('Location', `/api/candidates/import/tasks/${encodeURIComponent(task.task_id)}`)
        return res.status(202).json(task)
      } catch (error) {
        await removeImportTemporaryFile(temporaryPath, {
          unlinkFile: options.importTempUnlink,
          attempts: options.importTempCleanupAttempts,
          retryDelayMs: options.importTempCleanupRetryDelayMs
        }).catch(() => undefined)
        req.releaseCandidateImportPreview?.()
        throw error
      }
    }
    let preview
    try {
      req.file.originalname = cleanImportFilename(req.file.originalname)
      preview = await createImportPreview({
        db,
        file: req.file,
        body: req.body,
        validStages: stageValues(db),
        store: previewStore,
        resourceLimits: importResourceLimits
      })
      preview.metrics = { ...(preview.metrics ?? {}), ...uploadMetrics }
      const storedPreview = previewStore.get(preview.preview_token)
      if (storedPreview) storedPreview.metrics = preview.metrics
    } finally {
      try {
        await removeImportTemporaryFile(temporaryPath, {
          unlinkFile: options.importTempUnlink,
          attempts: options.importTempCleanupAttempts,
          retryDelayMs: options.importTempCleanupRetryDelayMs
        })
      } catch (cause) {
        if (preview?.preview_token) previewStore.delete(preview.preview_token)
        req.releaseCandidateImportPreview?.()
        throw httpError(500, '候选人导入临时文件清理失败', undefined, 'import_temp_cleanup_failed')
      }
      req.releaseCandidateImportPreview?.()
    }
    res.json(preview)
  })
  app.post('/api/import/preview', acquireCandidateImportPreview, candidateImportUpload.single('file'), handlePreview)
  app.post(
    '/api/candidates/import/preview',
    acquireCandidateImportPreview,
    candidateImportUpload.single('file'),
    handlePreview
  )

  const forceAsyncCandidateImport = (req, res, next) => {
    req.forceCandidateImportAsync = true
    next()
  }
  app.post('/api/import/tasks',
    acquireCandidateImportPreview,
    candidateImportUpload.single('file'),
    forceAsyncCandidateImport,
    handlePreview)
  app.post('/api/candidates/import/tasks',
    acquireCandidateImportPreview,
    candidateImportUpload.single('file'),
    forceAsyncCandidateImport,
    handlePreview)

  const handleImportTask = (req, res) => {
    const task = importTasks.get(req.params.task_id)
    if (!task) throw httpError(404, 'Import task not found.', undefined, 'import_task_not_found')
    res.json(task)
  }
  app.get('/api/import/tasks/:task_id', handleImportTask)
  app.get('/api/candidates/import/tasks/:task_id', handleImportTask)
  const handleImportTaskLookup = (req, res) => {
    const clientRequestId = String(req.query?.client_request_id ?? '').trim()
    if (!clientRequestId) throw httpError(400, 'client_request_id is required.', undefined, 'invalid_query')
    const task = importTasks.getByClientRequestId(clientRequestId)
    res.json({ items: task ? [task] : [] })
  }
  app.get('/api/import/tasks', handleImportTaskLookup)
  app.get('/api/candidates/import/tasks', handleImportTaskLookup)
  const handleCancelImportTask = asyncRoute(async (req, res) => {
    const task = await importTasks.cancel(req.params.task_id)
    if (!task) throw httpError(404, 'Import task not found.', undefined, 'import_task_not_found')
    res.status(task.terminal ? 200 : 202).json(task)
  })
  app.post('/api/import/tasks/:task_id/cancel', handleCancelImportTask)
  app.post('/api/candidates/import/tasks/:task_id/cancel', handleCancelImportTask)

  const handleCommit = asyncRoute(async (req, res) => {
    const token = req.body?.preview_token ?? req.body?.token
    if (!token) throw httpError(400, 'preview_token 不能为空')
    const requestedAsync = /^(?:1|true)$/i.test(String(req.body?.async ?? '')) ||
      String(req.get('Prefer') ?? '').toLowerCase().includes('respond-async')
    const idempotencyKey = req.get('Idempotency-Key') ?? req.body?.client_request_id ?? req.body?.idempotency_key
    const taskBackedPreview = Boolean(db.prepare(`
      SELECT 1 FROM candidate_import_tasks WHERE task_type = 'preview' AND preview_token = ?
    `).get(token))
    const existingCommitTask = Boolean(db.prepare(`
      SELECT 1 FROM candidate_import_tasks WHERE task_type = 'commit' AND preview_token = ?
    `).get(token))
    let preview = null
    // A durable task is authoritative after the preview file has been cleaned
    // up. Resolve it before reading the transient preview so retries after a
    // lost response cannot turn a completed import into a misleading 404.
    if (requestedAsync || Boolean(idempotencyKey) || taskBackedPreview || existingCommitTask) {
      const task = await importTasks.createCommitTask({
        token,
        onDuplicate: req.body?.on_duplicate ?? 'skip',
        idempotencyKey
      })
      res.setHeader('Location', `/api/candidates/import/tasks/${encodeURIComponent(task.task_id)}`)
      return res.status(task.status === 'completed' ? 200 : 202).json(task)
    }
    preview = await importTasks.ensurePreview(token)
    if (!preview) throw httpError(404, 'Preview token not found or expired.', undefined, 'import_preview_missing')
    if (Number(preview.rows?.length ?? 0) >= importAsyncCommitRows) {
      const task = await importTasks.createCommitTask({
        token,
        onDuplicate: req.body?.on_duplicate ?? 'skip',
        idempotencyKey
      })
      res.setHeader('Location', `/api/candidates/import/tasks/${encodeURIComponent(task.task_id)}`)
      return res.status(task.status === 'completed' ? 200 : 202).json(task)
    }
    const result = commitImport({
      db,
      token,
      onDuplicate: req.body?.on_duplicate ?? 'skip',
      store: previewStore
    })
    res.status(201).json(result)
  })
  app.post('/api/import/commit', handleCommit)
  app.post('/api/candidates/import/commit', handleCommit)

  app.post('/api/imports/candidates', (req, res) => {
    const result = commitStructuredImport({
      db,
      filename: req.body?.filename,
      mapping: req.body?.mapping,
      rows: req.body?.rows,
      validStages: stageValues(db)
    })
    res.status(201).json(result)
  })

  app.post('/api/candidates', (req, res) => {
    const { value, errors } = sanitizeCandidateInput(req.body, { validStages: stageValues(db) })
    if (errors.length) throw httpError(422, '候选人字段校验失败', errors)

    const candidate = withTransaction(db, () => {
      const duplicate = findDuplicate(db, value)
      if (duplicate) throw httpError(409, '发现可能重复的候选人', duplicate)
      return insertCandidate(db, value)
    })
    res.status(201).json(candidate)
  })

  app.post('/api/candidates/archive-batch', (req, res) => {
    res.json(archiveCandidates(db, req.body?.candidate_ids))
  })

  app.get('/api/candidates/:id/avatar', (req, res, next) => {
    const candidate = getCandidate(db, req.params.id, { includeRelated: false })
    if (!candidate) throw httpError(404, '候选人不存在', undefined, 'not_found')
    const localAvatar = attachments.resolveCandidateAvatar(candidate.id, candidate.photo_url)
    if (localAvatar) {
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.setHeader('Content-Type', localAvatar.mime_type)
      res.setHeader('Content-Length', String(localAvatar.file_size))
      res.setHeader('Content-Disposition', 'inline')
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Robots-Tag', 'noindex, nofollow')
      return res.sendFile(localAvatar.path, { dotfiles: 'deny' }, (error) => {
        if (error) next(error)
      })
    }
    const photoUrl = normalizePhotoUrl(candidate.photo_url)
    if (!photoUrl) throw httpError(404, '候选人没有可用证件照', undefined, 'avatar_not_found')

    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.redirect(302, photoUrl)
  })

  app.get('/api/candidates/:id', (req, res) => {
    const candidate = getCandidate(db, req.params.id, {
      includeSensitive: booleanQuery(req.query.include_sensitive, 'include_sensitive'),
      includeLegacyStage: booleanQuery(req.query.include_legacy_stage, 'include_legacy_stage')
    })
    if (!candidate) throw httpError(404, '候选人不存在')
    res.json(candidate)
  })

  app.put('/api/candidates/:id/preferences', (req, res) => {
    assertCandidateActive(db, req.params.id)
    res.json(replaceCandidatePreferences(db, req.params.id, req.body))
  })

  app.put('/api/candidates/:id/profile-sections', (req, res) => {
    assertCandidateActive(db, req.params.id)
    res.json({ data: replaceCandidateProfileSections(db, req.params.id, req.body) })
  })

  app.get('/api/candidates/:id/positions', (req, res) => {
    if (!candidateExists(db, req.params.id)) throw httpError(404, '候选人不存在', undefined, 'not_found')
    const positions = listCandidatePositions(db, req.params.id)
    res.json({ data: positions, items: positions })
  })

  app.patch('/api/candidates/:id', (req, res) => {
    const current = getCandidate(db, req.params.id, { includeRelated: false })
    if (!current) throw httpError(404, '候选人不存在')
    if (current.archived_at) {
      throw httpError(409, '已归档候选人只能恢复或永久删除', undefined, 'candidate_archived')
    }
    const requestedFields = CANDIDATE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field))
    if (requestedFields.length === 0) throw httpError(400, '没有可更新的候选人字段')

    const { value, errors } = sanitizeCandidateInput(req.body, {
      partial: true,
      validStages: stageValues(db),
      fallbackHireStatus: !current.hire_status
    })
    if (errors.length) throw httpError(422, '候选人字段校验失败', errors)
    const hasPatchedField = (field) => Object.prototype.hasOwnProperty.call(value, field)
    const effectiveHireDate = hasPatchedField('hire_date') ? value.hire_date : current.hire_date
    const effectiveHireStatus = hasPatchedField('hire_status') ? value.hire_status : current.hire_status
    if (effectiveHireDate && !effectiveHireStatus) value.hire_status = '不确定'
    const changes = changedFields(current, value)
    if (changes.length === 0) return res.json(getCandidate(db, req.params.id))

    const candidate = withTransaction(db, () => {
      const duplicate = findDuplicate(db, { ...current, ...value }, req.params.id)
      if (duplicate) throw httpError(409, '更新后将与其他候选人重复', duplicate)
      return patchCandidate(db, req.params.id, value, { activityMetadata: { fields: changes } })
    })
    return res.json(candidate)
  })

  app.post('/api/candidates/:id/archive', (req, res) => {
    assertCandidateActive(db, req.params.id)
    const candidate = withTransaction(db, () => {
      archiveCandidate(db, req.params.id)
      return getCandidate(db, req.params.id)
    })
    res.json(candidate)
  })

  app.post('/api/candidates/:id/restore', (req, res) => {
    const current = getCandidate(db, req.params.id, { includeRelated: false })
    if (!current) throw httpError(404, '候选人不存在', undefined, 'not_found')
    if (!current.archived_at) {
      throw httpError(409, '活动候选人无需恢复', undefined, 'candidate_not_archived')
    }
    const candidate = withTransaction(db, () => {
      restoreCandidate(db, req.params.id)
      return getCandidate(db, req.params.id)
    })
    res.json(candidate)
  })

  app.post('/api/candidates/permanent-delete/preview', (req, res) => {
    res.json(previewCandidateDeletion(db, req.body, deletionPreviewStore))
  })

  app.post('/api/candidates/permanent-delete/commit', (req, res) => {
    const result = commitCandidateDeletion(db, req.body, deletionPreviewStore)
    attachments.processCleanupJobs()
    res.json(result)
  })

  app.post('/api/candidates/:id/permanent-delete/preview', (req, res) => {
    res.json(previewCandidateDeletion(db, { candidate_ids: [req.params.id] }, deletionPreviewStore))
  })

  app.post('/api/candidates/:id/permanent-delete', (req, res) => {
    const result = commitCandidateDeletion(db, {
      ...(req.body ?? {}),
      candidate_ids: [req.params.id]
    }, deletionPreviewStore)
    attachments.processCleanupJobs()
    res.json(result)
  })

  app.post('/api/attachment-batches', receiveAttachmentBatch, asyncRoute(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : []
    if (!files.length) throw httpError(400, '请使用 multipart/form-data 的 files 字段上传至少一个文件', undefined, 'files_required')
    try {
      const batch = await attachmentBatches.createBatch({
        files: files.map((file) => ({
          ...file,
          relativePath: safeAttachmentRelativePath(file.originalname)
        })),
        requestedCandidateId: req.body?.candidate_id,
        idempotencyKey: req.get('Idempotency-Key'),
        batchToken: attachmentBatchToken(req)
      })
      res.setHeader('Location', `/api/attachment-batches/${encodeURIComponent(batch.batch_id)}`)
      res.setHeader('Retry-After', '1')
      res.status(202).json(batch)
    } finally {
      await removeAttachmentBatchUploads(files)
    }
  }))

  app.get('/api/attachment-batches/:id', (req, res) => {
    privateNoStore(res)
    res.json(attachmentBatches.getBatch(req.params.id, attachmentBatchOptions(req)))
  })

  app.get('/api/attachment-batches/:id/items/:itemId', (req, res) => {
    privateNoStore(res)
    res.json(attachmentBatches.getItem(req.params.id, req.params.itemId, attachmentBatchOptions(req)))
  })

  app.post('/api/attachment-batches/:id/items/:itemId/candidates', asyncRoute(async (req, res) => {
    privateNoStore(res)
    const candidate = await attachmentBatches.createCandidateForItem(
      req.params.id,
      req.params.itemId,
      req.body ?? {},
      attachmentBatchOptions(req)
    )
    res.status(201).json(candidate)
  }))

  app.post('/api/attachment-batches/:id/items/:itemId/confirm', asyncRoute(async (req, res) => {
    privateNoStore(res)
    const result = await attachmentBatches.confirmItem(req.params.id, req.params.itemId, req.body ?? {}, {
      ...attachmentBatchOptions(req),
      idempotencyKey: req.get('Idempotency-Key')
    })
    res.json(result)
  }))

  app.post('/api/attachment-batches/:id/items/:itemId/skip', (req, res) => {
    privateNoStore(res)
    attachmentBatches.skipItem(req.params.id, req.params.itemId, attachmentBatchOptions(req))
    res.json(attachmentBatches.getBatch(req.params.id, attachmentBatchOptions(req)))
  })

  app.post('/api/attachment-batches/:id/items/:itemId/retry', (req, res) => {
    privateNoStore(res)
    attachmentBatches.retryItem(req.params.id, req.params.itemId, attachmentBatchOptions(req))
    res.setHeader('Retry-After', '1')
    res.status(202).json(attachmentBatches.getBatch(req.params.id, attachmentBatchOptions(req)))
  })

  app.post('/api/attachment-batches/:id/items/:itemId/cancel', (req, res) => {
    privateNoStore(res)
    attachmentBatches.cancelItem(req.params.id, req.params.itemId, attachmentBatchOptions(req))
    res.json(attachmentBatches.getBatch(req.params.id, attachmentBatchOptions(req)))
  })

  app.post('/api/attachment-batches/:id/cancel', (req, res) => {
    privateNoStore(res)
    res.json(attachmentBatches.cancelBatch(req.params.id, attachmentBatchOptions(req)))
  })

  app.post('/api/attachments/previews', attachmentUpload.single('file'), asyncRoute(async (req, res) => {
    privateNoStore(res)
    if (!req.file) throw httpError(400, '请使用 multipart/form-data 的 file 字段上传文件', undefined, 'file_required')
    const preview = await attachments.createPreview({
      file: req.file,
      requestedCandidateId: req.body?.candidate_id
    })
    res.setHeader('Location', `/api/attachments/previews/${encodeURIComponent(preview.preview_id)}`)
    res.setHeader('Retry-After', '1')
    res.status(202).json(preview)
  }))

  app.get('/api/attachments/previews/:id', (req, res) => {
    privateNoStore(res)
    attachments.assertPreviewAccess(req.params.id, req.get('X-Attachment-Preview-Token'))
    res.json(attachments.getPreview(req.params.id))
  })

  app.delete('/api/attachments/previews/:id', (req, res) => {
    privateNoStore(res)
    attachments.assertPreviewAccess(req.params.id, req.get('X-Attachment-Preview-Token'))
    res.json(attachments.cancelPreview(req.params.id))
  })

  app.post('/api/attachments/previews/:id/candidates', asyncRoute(async (req, res) => {
    privateNoStore(res)
    res.status(201).json(await attachments.createCandidateFromPreview(req.params.id, req.body ?? {}))
  }))

  app.post('/api/attachments/previews/:id/confirm', (req, res) => {
    privateNoStore(res)
    res.status(201).json(attachments.confirmPreview(req.params.id, req.body))
  })

  app.get('/api/candidates/:id/attachments', (req, res) => {
    const items = attachments.listCandidateAttachments(req.params.id)
    res.json({ data: items, items })
  })

  app.get('/api/attachments/:id/text', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(attachments.getAttachment(req.params.id, { includeText: true }))
  })

  app.delete('/api/attachments/:id', (req, res) => {
    res.json(attachments.deleteAttachment(req.params.id))
  })

  app.get('/api/attachments/:id/download', (req, res, next) => {
    const attachment = attachments.resolveDownload(req.params.id)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', attachment.mime_type)
    res.setHeader('Content-Length', String(attachment.file_size))
    res.download(attachment.path, attachment.filename, { dotfiles: 'deny' }, (error) => {
      if (error) next(error)
    })
  })

  // 简历原件内嵌预览。资产里的 origin 有六成其实是 HTML，必须禁脚本、禁外部资源，
  // 否则等于把候选人上传的内容当页面跑。
  app.get('/api/attachments/:id/content', (req, res, next) => {
    const attachment = attachments.resolveDownload(req.params.id)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', attachment.mime_type)
    res.setHeader('Content-Length', String(attachment.file_size))
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // 全局中间件设了 X-Frame-Options: DENY 与 frame-ancestors 'none'，同源也不许内嵌，
    // 这里必须按单条响应覆盖，否则 iframe 预览会被浏览器拒绝。
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    if (attachment.mime_type === 'application/pdf') {
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'")
    } else {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; sandbox; frame-ancestors 'self'",
      )
    }
    res.sendFile(attachment.path, { dotfiles: 'deny' }, (error) => {
      if (error) next(error)
    })
  })

  app.get('/api/resume-search/status', asyncRoute(async (req, res) => {
    privateNoStore(res)
    const status = await resumeSearch.status()
    if (!status.ready) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(Number(status.retry_after_ms ?? 2_000) / 1_000))))
    res.json({ ...status, hybrid: hybridResumeSearch.status?.() ?? { remote_enabled: remoteSearchEnabled }, vector_maintenance: vectorMaintenance?.status() ?? { enabled: false, state: 'disabled' } })
  }))

  app.get('/api/resume-search/options', (req, res) => {
    privateNoStore(res)
    const kinds = { position: ['positions', 'title'], talent_pool: ['talent_pools', 'name'] }
    const kind = kinds[req.query.kind]
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.page_size ?? 100)
    if (!kind || !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw httpError(400, '筛选选项参数无效')
    const [table, title] = kind
    const total = Number(db.prepare(`SELECT count(*) n FROM ${table} WHERE archived_at IS NULL`).get().n)
    const items = db.prepare(`SELECT id, ${title} name FROM ${table} WHERE archived_at IS NULL ORDER BY ${title}, id LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize)
    res.json({ items, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize), has_more: page * pageSize < total } })
  })

  const searchResumesHandler = asyncRoute(async (req, res) => {
    privateNoStore(res)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const cancelOnClosedResponse = () => { if (!res.writableEnded) cancel() }
    req.once('aborted', cancel)
    res.once('close', cancelOnClosedResponse)
    try {
      res.json(await hybridResumeSearch.search(req.method === 'POST' ? req.body : req.query, { signal: controller.signal }))
    } finally {
      req.removeListener('aborted', cancel)
      res.removeListener('close', cancelOnClosedResponse)
    }
  })
  app.get('/api/resume-search', searchResumesHandler)
  app.post('/api/resume-search', searchResumesHandler)

  app.get('/api/candidates/:id/notes', (req, res) => {
    if (!candidateExists(db, req.params.id)) throw httpError(404, '候选人不存在')
    res.json({ data: listNotes(db, req.params.id) })
  })

  app.post('/api/candidates/:id/notes', (req, res) => {
    assertCandidateActive(db, req.params.id)
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
    if (!content) throw httpError(422, '备注内容不能为空')
    if (content.length > 10_000) throw httpError(413, '备注内容超过 10000 字符限制')
    res.status(201).json(withTransaction(db, () => addNote(db, req.params.id, content, '本地用户')))
  })

  app.get('/api/candidates/:id/activities', (req, res) => {
    if (!candidateExists(db, req.params.id)) throw httpError(404, '候选人不存在')
    res.json({ data: listActivities(db, req.params.id) })
  })

  app.get('/api/agent/status', (req, res) => res.json(agent.status()))
  app.post('/api/agent/sessions', (req, res) => {
    privateNoStore(res)
    res.status(201).json(agent.createSession({ ...(req.body ?? {}), userId: authenticatedUserId(req) }))
  })
  app.get('/api/agent/sessions', (req, res) => {
    privateNoStore(res)
    res.json(agent.listSessions({ ...req.query, userId: authenticatedUserId(req) }))
  })
  app.get('/api/agent/sessions/:id/messages', (req, res) => {
    privateNoStore(res)
    res.json(agent.listSessionMessages(req.params.id, { ...req.query, userId: authenticatedUserId(req) }))
  })
  app.get('/api/agent/sessions/:id/tasks', (req, res) => {
    privateNoStore(res)
    res.json(agent.listTasks(req.params.id, { ...req.query, userId: authenticatedUserId(req) }))
  })
  app.post('/api/agent/sessions/:id/messages', asyncRoute(async (req, res) => {
    privateNoStore(res)
    const result = await agent.querySession(req.params.id, { ...(req.body ?? {}), userId: authenticatedUserId(req) })
    if (result.state === 'processing') res.setHeader('Retry-After', '1')
    const status = result.state === 'processing' ? 202 : result.replayed ? 200 : 201
    res.status(status).json(result)
  }))
  app.get('/api/agent/tasks/:task_id', (req, res) => {
    privateNoStore(res)
    res.json(agent.getTask(req.params.task_id, authenticatedUserId(req)))
  })
  app.post('/api/agent/tasks/:task_id/cancel', (req, res) => {
    privateNoStore(res)
    res.json(agent.cancelTask(req.params.task_id, authenticatedUserId(req)))
  })
  app.post('/api/agent/tasks/:task_id/retry-answer', asyncRoute(async (req, res) => {
    privateNoStore(res)
    const result = await agent.retryTaskAnswer(req.params.task_id, authenticatedUserId(req))
    if (result.state === 'processing') res.setHeader('Retry-After', '1')
    res.status(result.state === 'processing' ? 202 : 200).json(result)
  }))
  app.get('/api/agent/sessions/:id', (req, res) => {
    privateNoStore(res)
    res.json(agent.getSession(req.params.id, authenticatedUserId(req)))
  })
  app.patch('/api/agent/sessions/:id', (req, res) => {
    privateNoStore(res)
    res.json(agent.updateSession(req.params.id, { ...(req.body ?? {}), userId: authenticatedUserId(req) }))
  })
  app.delete('/api/agent/sessions/:id', (req, res) => {
    privateNoStore(res)
    res.json(agent.deleteSession(req.params.id, { userId: authenticatedUserId(req) }))
  })
  app.post('/api/agent/tools/:name', asyncRoute(async (req, res) => {
    if (!AGENT_TOOL_NAMES.includes(req.params.name)) {
      throw httpError(404, 'Agent 只读工具不存在', undefined, 'tool_not_found')
    }
    res.json(await agent.executeTool(req.params.name, req.body ?? {}))
  }))
  app.post('/api/agent/query', asyncRoute(async (req, res) => {
    privateNoStore(res)
    res.setHeader('Deprecation', 'true')
    res.setHeader('Sunset', 'Use /api/agent/sessions/:id/messages for durable async tasks')
    const result = await agent.query(req.body?.message, req.body?.history)
    if (result.state === 'processing') res.setHeader('Retry-After', '1')
    res.status(result.state === 'processing' ? 202 : 200).json(result)
  }))

  app.get('/api/agent/exports/:id', (req, res, next) => {
    const exported = agent.resolveExport(req.params.id)
    if (!exported) throw httpError(404, 'Agent 导出文件不存在或已失效', undefined, 'not_found')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', exported.mime_type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.download(exported.path, exported.filename, { dotfiles: 'deny' }, (error) => {
      if (error) next(error)
    })
  })

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } }))

  const distPath = resolve(process.cwd(), 'dist')
  const indexPath = resolve(distPath, 'index.html')
  if (existsSync(indexPath)) {
    app.use(express.static(distPath, { index: false }))
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html')) return res.sendFile('index.html', { root: distPath })
      return next()
    })
  }
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: '资源不存在' } }))

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    const isMulterError = error instanceof multer.MulterError
    const databaseBusy = isSqliteBusyError(error)
    const candidateImportRequest = new Set([
      '/api/import/preview',
      '/api/candidates/import/preview',
      '/api/import/tasks',
      '/api/candidates/import/tasks'
    ]).has(req.path)
    const attachmentBatchRequest = req.path === '/api/attachment-batches'
    const status = databaseBusy
      ? 503
      : isMulterError
      ? error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
      : error instanceof AuthError
      ? error.status
      : Number.isInteger(error.status) ? error.status : 500
    if (databaseBusy) res.setHeader('Retry-After', '5')
    const retryAfterMs = Number(error?.details?.retry_after_ms ?? error?.details?.retryAfterMs)
    if (!databaseBusy && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))))
    }
    // Auth failures are expected operational outcomes (directory down, timeout)
    // and are already reported to the caller with a stable code; they must not
    // be logged as internal errors.
    if (status >= 500 && !databaseBusy && !(error instanceof AuthError)) console.error(error)
    return res.status(status).json({
      error: {
        code: databaseBusy
          ? 'database_busy'
          : isMulterError
          ? error.code.toLowerCase()
          : status === 500
            ? error.code === 'import_temp_cleanup_failed' ? error.code : 'internal_error'
            : error.code ?? 'request_error',
        message: databaseBusy
          ? 'The database is temporarily busy while another write is finishing. Please retry shortly.'
          : isMulterError && error.code === 'LIMIT_FILE_SIZE'
          ? candidateImportRequest
            ? `候选人导入文件超过 ${byteLimitLabel(importMaxFileBytes)} 配置上限`
            : attachmentBatchRequest
              ? `批次中的单个压缩包超过 ${byteLimitLabel(attachmentBatches.limits?.maxArchiveBytes ?? ATTACHMENT_BATCH_LIMITS.maxArchiveBytes)} 上限`
            : '简历附件超过 15 MiB 限制'
          : status === 500
            ? '服务器内部错误，请稍后重试'
            : error.message,
        ...(isMulterError && error.code === 'LIMIT_FILE_SIZE'
          ? { details: { max_file_size_bytes: candidateImportRequest
            ? importMaxFileBytes
            : attachmentBatchRequest
              ? attachmentBatches.limits?.maxArchiveBytes ?? ATTACHMENT_BATCH_LIMITS.maxArchiveBytes
              : ATTACHMENT_MAX_FILE_BYTES } }
          : status !== 500 && error.details !== undefined ? { details: error.details } : {})
      }
    })
  })

  app.locals.db = db
  app.locals.previewStore = previewStore
  app.locals.deletionPreviewStore = deletionPreviewStore
  app.locals.attachments = attachments
  app.locals.attachmentVisualParser = attachmentVisualParser
  app.locals.attachmentBatches = attachmentBatches
  app.locals.importTasks = importTasks
  app.locals.searchMaintenance = searchMaintenance
  app.locals.resumeSearch = resumeSearch
  app.locals.hybridResumeSearch = hybridResumeSearch
  app.locals.vectorMaintenance = vectorMaintenance
  app.locals.agent = agent
  app.locals.auth = auth ?? null
  app.locals.authStore = auth?.store ?? null
  app.locals.candidateImportConfig = candidateImportConfig
  app.locals.importUploadRoot = importUploadRoot
  Object.defineProperty(app.locals, 'candidateImportPreviewActive', {
    enumerable: true,
    get: () => candidateImportPreviewActive
  })
  let closePromise = null
  app.closeDatabase = () => {
    if (closePromise) return closePromise
    closePromise = Promise.resolve()
      .then(() => agent.close?.())
      .catch(() => undefined)
      .then(async () => {
        await resumeSearch.close?.()
        await hybridResumeSearch.close?.()
        await vectorMaintenance?.close()
        await searchMaintenance?.close()
        await importTasks.close?.()
        previewStore.close?.()
        await Promise.all([
          attachments.close(),
          attachmentBatches.close?.()
        ])
        if (db.open) db.close()
        if (auth?.store && auth.store !== db && typeof auth.store.close === 'function') auth.store.close()
        if (temporaryImportUploadRoot) rmSync(temporaryImportUploadRoot, { recursive: true, force: true })
        if (temporaryAttachmentRoot) rmSync(temporaryAttachmentRoot, { recursive: true, force: true })
      })
    return closePromise
  }
  return app
}

export default createApp
