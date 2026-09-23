import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import ExcelJS from 'exceljs'
import { readFirstSheet, XlsError } from 'xls-reader'
import { EXPORT_FIELDS, FIELD_LABELS } from './constants.js'
import { findDuplicate, insertCandidate, patchCandidate } from './candidates.js'
import { addActivity, now, withTransaction } from './database.js'
import { readCandidateImportFile } from './import-file.js'
import { buildHeaderMapping, formatYearsExperience, mapImportedPosition, mapImportedRow, sanitizeCandidateInput } from './validation.js'
import {
  commitBeisenImport,
  createImportPositionResolver,
  importPositionError,
  isBeisenTalentWorkbook,
  prepareBeisenPreview
} from './beisen-import.js'

export const DEFAULT_IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000
export const DEFAULT_IMPORT_PREVIEW_MAX_ENTRIES = 2
export const IMPORT_FAILURE_DETAIL_LIMIT = 100

function positiveInteger(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function appendImportFailure(failures, failure) {
  if (failures.length < IMPORT_FAILURE_DETAIL_LIMIT) failures.push(failure)
}

function failureDetailMetadata(failedRows, failures) {
  const omitted = Math.max(0, failedRows - failures.length)
  return {
    failure_details_returned: failures.length,
    failure_details_limit: IMPORT_FAILURE_DETAIL_LIMIT,
    failure_details_omitted: omitted,
    failure_details_truncated: omitted > 0
  }
}

function cellValue(value) {
  if (value == null) return null
  if (value instanceof Date) {
    const date = [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
      .join('-')
    const hasTime = value.getHours() || value.getMinutes() || value.getSeconds() || value.getMilliseconds()
    if (!hasTime) return date
    const time = [value.getHours(), value.getMinutes(), value.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':')
    return `${date}T${time}`
  }
  if (typeof value !== 'object') return value
  if ('result' in value) return cellValue(value.result)
  if ('text' in value) return value.text
  if ('hyperlink' in value) return value.text ?? value.hyperlink
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('')
  if ('code' in value && typeof value.code === 'string') return value.code
  return String(value)
}

function uniqueHeaders(row) {
  return uniqueHeaderValues(Array.from({ length: row.cellCount }, (_, index) => row.getCell(index + 1).value))
}

function uniqueHeaderValues(headerValues) {
  const seen = new Map()
  const values = []
  for (let index = 0; index < headerValues.length; index += 1) {
    const raw = String(cellValue(headerValues[index]) ?? '').trim() || `未命名列${index + 1}`
    const count = seen.get(raw) ?? 0
    seen.set(raw, count + 1)
    values.push(count === 0 ? raw : `${raw}_${count + 1}`)
  }
  return values
}

function legacyXlsToRows(file) {
  const ole2Signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  if (file.buffer.length < ole2Signature.length || !file.buffer.subarray(0, ole2Signature.length).equals(ole2Signature)) {
    const error = new Error('文件不是有效的 Excel 97-2003 二进制 .xls，请勿仅修改扩展名')
    error.status = 422
    throw error
  }

  let sheet
  try {
    sheet = readFirstSheet(file.buffer)
  } catch (cause) {
    const error = new Error(
      cause instanceof XlsError
        ? '无法读取该 .xls；仅支持未加密的 Excel 97-2003 BIFF8 工作簿'
        : '解析 .xls 时发生错误'
    )
    error.status = 422
    throw error
  }

  if (!sheet || sheet.rows.length < 1) {
    const error = new Error('文件中没有可读取的工作表或表头')
    error.status = 422
    throw error
  }

  const headers = uniqueHeaderValues(sheet.rows[0] ?? [])
  const rows = []
  for (let rowIndex = 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const sourceRow = sheet.rows[rowIndex] ?? []
    const record = {}
    let populated = false
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const value = cellValue(sourceRow[columnIndex])
      if (value != null && String(value).trim() !== '') populated = true
      record[headers[columnIndex]] = value
    }
    if (populated) rows.push({ row_number: rowIndex + 1, values: record })
  }
  if (rows.length === 0) {
    const error = new Error('文件只有表头，没有数据行')
    error.status = 422
    throw error
  }
  return { headers, rows, sheetName: sheet.name }
}

async function fileToRows(file) {
  if (file?.path) return readCandidateImportFile(file)
  const extension = extname(file.originalname ?? '').toLowerCase()
  if (extension === '.xls') return legacyXlsToRows(file)

  const workbook = new ExcelJS.Workbook()
  let worksheet

  if (extension === '.csv' || /csv/i.test(file.mimetype ?? '')) {
    worksheet = await workbook.csv.read(Readable.from([file.buffer]))
  } else if (extension === '.xlsx' || extension === '.xlsm') {
    await workbook.xlsx.load(file.buffer)
    worksheet = workbook.worksheets[0]
  } else {
    const error = new Error('仅支持 .xlsx、.xlsm、.xls 或 .csv 文件')
    error.status = 415
    throw error
  }

  if (!worksheet || worksheet.rowCount < 1) {
    const error = new Error('文件中没有可读取的工作表或表头')
    error.status = 422
    throw error
  }

  const headers = uniqueHeaders(worksheet.getRow(1))
  const rows = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const record = {}
    let populated = false
    for (let index = 0; index < headers.length; index += 1) {
      const value = cellValue(row.getCell(index + 1).value)
      if (value != null && String(value).trim() !== '') populated = true
      record[headers[index]] = value
    }
    if (populated) rows.push({ row_number: rowNumber, values: record })
  })

  if (rows.length === 0) {
    const error = new Error('文件只有表头，没有数据行')
    error.status = 422
    throw error
  }

  return { headers, rows, sheetName: worksheet.name }
}

function parseJsonField(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    const error = new Error('mapping 或 defaults 不是有效的 JSON')
    error.status = 400
    throw error
  }
}

function identityKeys(candidate) {
  const keys = []
  if (candidate.source_system && candidate.source_record_id) {
    keys.push(`source:${candidate.source_system}\u0000${candidate.source_record_id}`)
  }
  if (candidate.email) keys.push(`email:${candidate.email}`)
  if (candidate.phone) keys.push(`phone:${candidate.phone}`)
  return keys
}

function createImportDuplicateResolver(db) {
  const index = new Map()
  const rowsById = new Map()
  const keysById = new Map()
  const add = (key, row) => {
    if (!key) return
    const matches = index.get(key) ?? []
    if (!matches.some((match) => match.id === row.id)) matches.push(row)
    index.set(key, matches)
  }
  const remove = (key, rowId) => {
    if (!key) return
    const matches = index.get(key)
    if (!matches) return
    const remaining = matches.filter((match) => match.id !== rowId)
    if (remaining.length > 0) index.set(key, remaining)
    else index.delete(key)
  }
  const addRow = (row) => {
    if (!row?.id) return
    const normalized = { ...row }
    const keys = identityKeys(normalized)
    rowsById.set(normalized.id, normalized)
    keysById.set(normalized.id, keys)
    for (const key of keys) add(key, normalized)
  }
  const removeRow = (id) => {
    const keys = keysById.get(id) ?? []
    for (const key of keys) remove(key, id)
    keysById.delete(id)
    rowsById.delete(id)
  }
  const replaceRow = (row) => {
    if (!row?.id) return
    removeRow(row.id)
    addRow(row)
  }
  for (const row of db.prepare(`
    SELECT id, name, email, phone, source_system, source_record_id, archived_at
    FROM candidates
  `).all()) addRow(row)

  const resolve = (candidate) => {
    const matches = new Map()
    for (const key of identityKeys(candidate)) {
      const matchedBy = key.split(':', 1)[0] === 'source' ? 'source_record' : key.split(':', 1)[0]
      for (const row of index.get(key) ?? []) {
        const current = matches.get(row.id)
        if (current) current.matched_fields.push(matchedBy)
        else matches.set(row.id, { ...row, matched_fields: [matchedBy] })
      }
    }
    const values = [...matches.values()]
    if (values.length === 0) return null
    if (values.length > 1) {
      return { identity_conflict: true, matched_by: 'identity_conflict', matches: values }
    }
    return { ...values[0], matched_by: values[0].matched_fields[0] }
  }
  resolve.add = addRow
  resolve.remove = removeRow
  resolve.replace = replaceRow
  resolve.get = (id) => rowsById.get(id) ?? null
  return resolve
}

function identityConflictError() {
  return {
    field: 'identity',
    code: 'identity_conflict',
    message: '邮箱、手机号或来源记录 ID 分别命中不同候选人，需要人工复核'
  }
}

function archivedCandidateImportError() {
  return {
    field: 'candidate',
    code: 'candidate_archived',
    message: '已归档候选人不能通过导入更新或建立关系，请先恢复候选人'
  }
}

function neutralizeCsvFormula(value) {
  if (typeof value !== 'string' || !/^[=+\-@\t\r]/.test(value)) return value
  return `'${value}`
}

function publicPositionResolution(resolution) {
  if (!resolution) return null
  const { record, ...safe } = resolution
  return safe
}

function buildPositionPreview(rows) {
  const items = new Map()
  const links = new Set()
  let ambiguousCount = 0
  let invalidCount = 0
  let archivedConflictCount = 0

  for (const row of rows) {
    const resolution = row.position_resolution
    if (!resolution || resolution.action === 'none') continue
    if (row.errors.length > 0 && ['create', 'match'].includes(resolution.action)) continue
    if (resolution.action === 'ambiguous') ambiguousCount += 1
    if (resolution.action === 'invalid') invalidCount += 1
    if (resolution.action === 'archived_conflict') archivedConflictCount += 1

    const key = resolution.action === 'create'
      ? `create:${resolution.plan_key}`
      : resolution.action === 'match'
        ? `match:${resolution.position_id}`
        : `${resolution.action}:${row.row_number}`
    const previewPosition = resolution.action === 'create'
      ? resolution.position ?? row.position
      : row.position
    if (!items.has(key)) {
      items.set(key, {
        action: resolution.action,
        reason: resolution.reason,
        title: previewPosition?.title ?? null,
        external_code: previewPosition?.external_code ?? null,
        source_record_id: previewPosition?.source_record_id ?? null,
        source_system: previewPosition?.source_system ?? null,
        department: previewPosition?.department ?? null,
        location: previewPosition?.location ?? null,
        owner: previewPosition?.owner ?? null,
        ...(resolution.position_id ? { position_id: resolution.position_id } : {}),
        ...(resolution.match_count ? { match_count: resolution.match_count } : {}),
        row_numbers: []
      })
    }
    items.get(key).row_numbers.push(row.row_number)

    if (row.errors.length === 0 && ['create', 'match'].includes(resolution.action)) {
      const candidateKey = row.duplicate?.type === 'existing'
        ? `candidate:${row.duplicate.id}`
        : identityKeys(row.candidate)[0] ?? `row:${row.row_number}`
      const positionKey = resolution.action === 'create'
        ? `plan:${resolution.plan_key}`
        : `position:${resolution.position_id}`
      links.add(`${candidateKey}\u0000${positionKey}`)
    }
  }

  const values = [...items.values()]
  return {
    create_count: values.filter((item) => item.action === 'create').length,
    match_count: values.filter((item) => item.action === 'match').length,
    ambiguous_count: ambiguousCount,
    invalid_count: invalidCount,
    archived_conflict_count: archivedConflictCount,
    link_count: links.size,
    items: values.slice(0, 100)
  }
}

export class ImportPreviewStore {
  #previews = new Map()
  #ttlMs
  #maxEntries
  #cleanupTimer
  #now

  constructor(options = {}) {
    this.#ttlMs = positiveInteger(options.ttlMs, DEFAULT_IMPORT_PREVIEW_TTL_MS)
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_IMPORT_PREVIEW_MAX_ENTRIES)
    this.#now = typeof options.now === 'function' ? options.now : Date.now
    const cleanupIntervalMs = positiveInteger(
      options.cleanupIntervalMs,
      Math.min(this.#ttlMs, 60 * 1000)
    )
    this.#cleanupTimer = setInterval(() => this.purgeExpired(), cleanupIntervalMs)
    this.#cleanupTimer.unref?.()
  }

  purgeExpired() {
    const timestamp = this.#now()
    for (const [token, preview] of this.#previews) {
      if (!preview.committing && preview.expiresAt <= timestamp) this.#previews.delete(token)
    }
  }

  put(preview, options = {}) {
    this.purgeExpired()
    while (this.#previews.size >= this.#maxEntries) {
      let oldest = null
      for (const [token, stored] of this.#previews) {
        if (stored.committing) continue
        if (!oldest || stored.createdAt < oldest.createdAt) oldest = { token, createdAt: stored.createdAt }
      }
      if (!oldest) {
        const error = new Error('当前导入预览正在提交，请完成后再上传新文件')
        error.status = 409
        error.code = 'import_preview_capacity'
        throw error
      }
      this.#previews.delete(oldest.token)
    }
    const token = options.token ?? randomUUID()
    const createdAt = options.createdAt ?? this.#now()
    const expiresAt = options.expiresAt ?? createdAt + this.#ttlMs
    this.#previews.set(token, { ...preview, createdAt, expiresAt, committing: false })
    return { token, expiresAt }
  }

  restore(token, preview, options = {}) {
    if (!token || !preview || typeof preview !== 'object') return null
    return this.put(preview, {
      token,
      createdAt: options.createdAt ?? preview.createdAt,
      expiresAt: options.expiresAt ?? preview.expiresAt
    })
  }

  get(token) {
    this.purgeExpired()
    return this.#previews.get(token) ?? null
  }

  delete(token) {
    this.#previews.delete(token)
  }

  get size() {
    this.purgeExpired()
    return this.#previews.size
  }

  close() {
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer)
    this.#cleanupTimer = null
    this.#previews.clear()
  }
}

export async function createImportPreview({
  db,
  file,
  body = {},
  validStages,
  store,
  resourceLimits = {},
  signal,
  onProgress
}) {
  const previewStartedAt = performance.now()
  onProgress?.({ phase: 'validating', progress: 15 })
  const { headers, rows, sheetName, metrics: parserMetrics = {} } = file?.path
    ? await readCandidateImportFile(file, resourceLimits, { signal, onProgress })
    : await fileToRows(file)
  onProgress?.({ phase: 'mapping', progress: 60, metrics: parserMetrics })
  if (isBeisenTalentWorkbook(headers)) {
    const response = prepareBeisenPreview({
      db,
      rows,
      headers,
      filename: file.originalname,
      sheetName,
      validStages,
      store
    })
    const previewMetrics = {
      ...parserMetrics,
      mapping_validation_ms: Math.round(performance.now() - previewStartedAt - Number(parserMetrics.worker_roundtrip_ms ?? 0)),
      preview_total_ms: Math.round(performance.now() - previewStartedAt)
    }
    const stored = store.get(response.preview_token)
    if (stored) stored.metrics = previewMetrics
    onProgress?.({ phase: 'preview', progress: 100, metrics: previewMetrics })
    return { ...response, metrics: previewMetrics }
  }
  const mappingOverride = parseJsonField(body.mapping, {})
  const defaults = {
    ...parseJsonField(body.defaults, {}),
    ...(body.source_system ? { source_system: body.source_system } : {})
  }
  const {
    mapping,
    position_mapping: positionMapping,
    unmapped_headers: unmappedHeaders
  } = buildHeaderMapping(headers, mappingOverride)

  if (!mapping.name) {
    const error = new Error('无法自动识别姓名列，请通过 mapping 指定 name 对应的表头')
    error.status = 422
    error.details = { headers, mapping, unmapped_headers: unmappedHeaders }
    throw error
  }

  const seen = new Map()
  const positionResolver = createImportPositionResolver(db)
  const duplicateResolver = createImportDuplicateResolver(db)
  const mappingStartedAt = performance.now()
  const preparedRows = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (signal?.aborted) {
      const error = new Error('鍊欓€変汉瀵煎叆浠诲姟宸茬敤鎴峰彇娑?')
      error.status = 499
      error.code = 'import_cancelled'
      throw error
    }
    const { row_number: rowNumber, values } = rows[rowIndex]
    const raw = mapImportedRow(values, mapping, defaults)
    const { value: candidate, errors: validationErrors } = sanitizeCandidateInput(raw, {
      validStages,
      allowExcelHireDateValues: true
    })
    const errors = [...validationErrors]
    const position = mapImportedPosition(values, positionMapping, defaults, candidate)
    const positionResolution = positionResolver.resolve(position)
    const positionError = importPositionError(positionResolution)
    if (positionError) errors.push(positionError)
    const keys = identityKeys(candidate)
    let fileDuplicate = null
    let existingDuplicate = null
    if (errors.length === 0) {
      for (const key of keys) {
        if (seen.has(key)) {
          fileDuplicate = { row_number: seen.get(key), matched_by: key.split(':', 1)[0] }
          break
        }
      }
      if (!fileDuplicate) {
        existingDuplicate = duplicateResolver(candidate)
        if (existingDuplicate?.identity_conflict) errors.push(identityConflictError())
        else if (existingDuplicate?.archived_at) {
          errors.push(archivedCandidateImportError())
        }
      }
      if (!fileDuplicate && errors.length === 0) {
        for (const key of keys) seen.set(key, rowNumber)
      }
    }
    preparedRows.push({
      row_number: rowNumber,
      candidate,
      position,
      position_resolution: positionResolution,
      errors,
      duplicate: fileDuplicate
        ? { type: 'file', ...fileDuplicate }
        : existingDuplicate
          ? { type: 'existing', ...existingDuplicate }
          : null
    })
    if ((rowIndex & 0xff) === 0xff) {
      onProgress?.({
        phase: 'mapping',
        progress: 60 + Math.floor(((rowIndex + 1) / rows.length) * 30)
      })
      await yieldToEventLoop()
    }
  }

  const summary = {
    total_rows: preparedRows.length,
    valid_rows: preparedRows.filter((row) => row.errors.length === 0).length,
    invalid_rows: preparedRows.filter((row) => row.errors.length > 0).length,
    existing_duplicates: preparedRows.filter((row) => row.duplicate?.type === 'existing').length,
    file_duplicates: preparedRows.filter((row) => row.duplicate?.type === 'file').length
  }
  const positionPreview = buildPositionPreview(preparedRows)
  const previewSerializationStartedAt = performance.now()
  const previewMetrics = {
    ...parserMetrics,
    mapping_validation_ms: Math.round(performance.now() - mappingStartedAt),
    preview_serialization_ms: 0,
    preview_total_ms: Math.round(performance.now() - previewStartedAt)
  }
  const stored = store.put({
    filename: file.originalname,
    sheetName,
    mapping,
    positionMapping,
    mappedFields: new Set(Object.keys(mapping)),
    defaults,
    rows: preparedRows,
    summary,
    metrics: previewMetrics
  })
  const response = {
    preview_token: stored.token,
    expires_at: new Date(stored.expiresAt).toISOString(),
    filename: file.originalname,
    sheet_name: sheetName,
    headers,
    mapping: { ...mapping, ...positionMapping },
    candidate_mapping: mapping,
    position_mapping: positionMapping,
    unmapped_headers: unmappedHeaders,
    summary: {
      ...summary,
      position_records: positionPreview.create_count + positionPreview.match_count,
      position_link_count: positionPreview.link_count
    },
    position_preview: positionPreview,
    rows: preparedRows.slice(0, 20).map((row) => ({
      ...row,
      candidate: {
        ...row.candidate,
        years_experience_display: formatYearsExperience({
          raw: row.candidate.years_experience_raw,
          numeric: row.candidate.years_experience
        })
      },
      position_resolution: publicPositionResolution(row.position_resolution)
    })),
    preview_row_limit: 20,
    metrics: previewMetrics
  }
  previewMetrics.preview_serialization_ms = Math.round(performance.now() - previewSerializationStartedAt)
  previewMetrics.preview_total_ms = Math.round(performance.now() - previewStartedAt)
  onProgress?.({ phase: 'preview', progress: 100, metrics: previewMetrics })
  return response
}

function importUpdatePatch(candidate, mappedFields, defaults) {
  const allowed = new Set([...mappedFields, ...Object.keys(defaults)])
  const patch = {}
  for (const field of allowed) {
    if (field === 'import_batch_id' || field === 'name') continue
    const value = candidate[field]
    if (value != null && value !== '' && (!Array.isArray(value) || value.length > 0)) patch[field] = value
  }
  if (allowed.has('years_experience') && candidate.years_experience_raw) {
    patch.years_experience_raw = candidate.years_experience_raw
    patch.years_experience = candidate.years_experience ?? null
  }
  return patch
}

export function commitImport({
  db,
  token,
  onDuplicate = 'skip',
  store,
  batchId = randomUUID(),
  taskId = null,
  metrics = null
}) {
  if (taskId) {
    const completedTask = db.prepare(`
      SELECT result_json FROM candidate_import_tasks
      WHERE id = ? AND status IN ('committed', 'completed') AND result_json IS NOT NULL
    `).get(taskId)
    if (completedTask?.result_json) return JSON.parse(completedTask.result_json)
  }
  const preview = store.get(token)
  if (!preview) {
    const error = new Error('预览令牌不存在或已过期，请重新预览文件')
    error.status = 404
    throw error
  }
  if (preview.committing) {
    const error = new Error('该预览正在提交，请勿重复操作')
    error.status = 409
    throw error
  }
  if (!['skip', 'update'].includes(onDuplicate)) {
    const error = new Error('on_duplicate 仅支持 skip 或 update')
    error.status = 400
    throw error
  }

  preview.committing = true
  try {
    if (preview.kind === 'beisen_talent') {
      const result = commitBeisenImport({ db, preview, batchId, taskId, metrics })
      store.delete(token)
      return result
    }
    const result = withTransaction(db, () => {
      const summary = {
        imported_rows: 0,
        updated_rows: 0,
        skipped_rows: 0,
        failed_rows: 0,
        position_count: 0,
        positions_created: 0,
        positions_matched: 0,
        links_created: 0
      }
      const failures = []
      const positionResolver = createImportPositionResolver(db)
      const duplicateIndexStartedAt = performance.now()
      const duplicateResolver = createImportDuplicateResolver(db)
      const duplicateIndexLoadMs = performance.now() - duplicateIndexStartedAt
      let duplicateCheckMs = 0
      let duplicateChecks = 0
      const usedPositionIds = new Set()
      const createdPositionIds = new Set()
      const matchedPositionIds = new Set()
      db.prepare(`
        INSERT INTO import_batches(
          id, filename, sheet_name, total_rows, imported_rows, updated_rows,
          skipped_rows, failed_rows, status, created_at
        ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'processing', ?)
      `).run(batchId, preview.filename, preview.sheetName, preview.rows.length, now())

      for (const row of preview.rows) {
        if (row.errors.length > 0) {
          summary.failed_rows += 1
          appendImportFailure(failures, { row_number: row.row_number, errors: row.errors })
          continue
        }

        const positionResolution = positionResolver.resolve(row.position)
        const positionFailure = importPositionError(positionResolution)
        if (positionFailure) {
          summary.failed_rows += 1
          appendImportFailure(failures, { row_number: row.row_number, errors: [positionFailure] })
          continue
        }

        const candidate = { ...row.candidate, import_batch_id: batchId }
        duplicateChecks += 1
        const duplicateCheckStartedAt = performance.now()
        const duplicate = duplicateResolver(candidate)
        duplicateCheckMs += performance.now() - duplicateCheckStartedAt
        let candidateId = null
        if (duplicate) {
          if (duplicate.identity_conflict) {
            summary.failed_rows += 1
            appendImportFailure(failures, {
              row_number: row.row_number,
              errors: [identityConflictError()],
              conflict: duplicate.matches
            })
            continue
          }
          if (duplicate.archived_at) {
            summary.failed_rows += 1
            appendImportFailure(failures, { row_number: row.row_number, errors: [archivedCandidateImportError()] })
            continue
          }
          candidateId = duplicate.id
          if (onDuplicate === 'update' && row.duplicate?.type !== 'file') {
            const patch = importUpdatePatch(candidate, preview.mappedFields, preview.defaults)
            patch.import_batch_id = batchId
            patchCandidate(db, duplicate.id, patch, {
              activityType: 'candidate_import_updated',
              activityMetadata: { import_batch_id: batchId, row_number: row.row_number, matched_by: duplicate.matched_by },
              hydrate: false
            })
            duplicateResolver.replace({
              ...duplicateResolver.get(duplicate.id),
              ...patch,
              id: duplicate.id
            })
            summary.updated_rows += 1
          } else {
            summary.skipped_rows += 1
          }
        } else if (row.duplicate?.type === 'file') {
          summary.skipped_rows += 1
          continue
        } else {
          candidateId = insertCandidate(db, candidate, {
            activityType: 'candidate_imported',
            activityMetadata: { import_batch_id: batchId, row_number: row.row_number },
            hydrate: false
          }).id
          duplicateResolver.add({
            ...candidate,
            id: candidateId,
            archived_at: null
          })
          summary.imported_rows += 1
        }

        if (candidateId && ['create', 'match'].includes(positionResolution.action)) {
          const materialized = positionResolver.materialize(positionResolution)
          if (materialized) {
            usedPositionIds.add(materialized.id)
            if (materialized.created) createdPositionIds.add(materialized.id)
            else if (!createdPositionIds.has(materialized.id)) matchedPositionIds.add(materialized.id)
            const linked = db.prepare(`
              INSERT OR IGNORE INTO candidate_positions(candidate_id, position_id, created_at)
              VALUES (?, ?, ?)
            `).run(candidateId, materialized.id, now())
            if (linked.changes) {
              summary.links_created += 1
              addActivity(db, candidateId, 'position_linked', '导入候选人时关联职位', {
                position_id: materialized.id,
                import_batch_id: batchId,
                row_number: row.row_number
              })
            }
          }
        }
      }

      summary.position_count = usedPositionIds.size
      summary.positions_created = createdPositionIds.size
      summary.positions_matched = matchedPositionIds.size

      db.prepare(`
        UPDATE import_batches SET
          imported_rows = ?, updated_rows = ?, skipped_rows = ?, failed_rows = ?,
          status = 'completed', completed_at = ?
        WHERE id = ?
      `).run(
        summary.imported_rows,
        summary.updated_rows,
        summary.skipped_rows,
        summary.failed_rows,
        now(),
        batchId
      )
      const output = {
        import_batch_id: batchId,
        ...summary,
        failures,
        ...failureDetailMetadata(summary.failed_rows, failures)
      }
      const queuedSearchRows = taskId
        ? Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count ?? 0)
        : 0
      const taskOutput = taskId
        ? {
            ...output,
            search_index: {
              status: queuedSearchRows > 0
                ? 'pending'
                : 'ready',
              queued_rows: queuedSearchRows,
              processed_rows: 0,
              resumable: true
            }
          }
        : output
      if (metrics) {
        metrics.duplicate_index_load_ms = Math.round(duplicateIndexLoadMs)
        metrics.duplicate_check_ms = Math.round(duplicateCheckMs)
        metrics.duplicate_query_count = 1
        metrics.duplicate_checks = duplicateChecks
        if (taskId) metrics.search_index_queued_rows = queuedSearchRows
      }
      if (taskId) {
        const completedAt = now()
        db.prepare(`
          UPDATE candidate_import_tasks SET
            status = 'committed', phase = 'committed', progress = 95,
            result_json = ?, error_json = NULL, metrics_json = ?, updated_at = ?, completed_at = NULL
          WHERE id = ?
        `).run(JSON.stringify(taskOutput), JSON.stringify(metrics ?? {}), completedAt, taskId)
      }
      return taskOutput
    }, { synchronizeSearch: false })
    store.delete(token)
    return result
  } catch (error) {
    preview.committing = false
    throw error
  }
}

export function commitStructuredImport({ db, filename = 'structured-import', mapping, rows, validStages }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const error = new Error('rows 必须是非空数组')
    error.status = 400
    throw error
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    const error = new Error('mapping 必须是表头到目标字段的对象')
    error.status = 400
    throw error
  }

  const allowed = new Set([...EXPORT_FIELDS, 'ignore'])
  const mappedEntries = Object.entries(mapping).filter(([, field]) => allowed.has(field) && field !== 'ignore')
  if (!mappedEntries.some(([, field]) => field === 'name')) {
    const error = new Error('mapping 必须包含 name 字段')
    error.status = 422
    throw error
  }

  const batchId = randomUUID()
  const safeFilename = String(filename || 'structured-import').slice(0, 500)
  return withTransaction(db, () => {
    const summary = { total: rows.length, imported: 0, duplicates: 0, invalid: 0 }
    const seen = new Map()
    db.prepare(`
      INSERT INTO import_batches(
        id, filename, sheet_name, total_rows, imported_rows, updated_rows,
        skipped_rows, failed_rows, status, created_at
      ) VALUES (?, ?, NULL, ?, 0, 0, 0, 0, 'processing', ?)
    `).run(batchId, safeFilename, rows.length, now())

    for (let index = 0; index < rows.length; index += 1) {
      const sourceRow = rows[index]
      if (!sourceRow || typeof sourceRow !== 'object' || Array.isArray(sourceRow)) {
        summary.invalid += 1
        continue
      }
      const raw = {}
      for (const [header, field] of mappedEntries) raw[field] = sourceRow[header]
      raw.source = raw.source || 'Excel导入'
      raw.owner = raw.owner || '未分配'
      raw.source_system = raw.source_system || 'excel_import'
      raw.source_record_id = raw.source_record_id || `${safeFilename}:${index + 2}`
      const { value: candidate, errors } = sanitizeCandidateInput(raw, { validStages })
      if (errors.length > 0) {
        summary.invalid += 1
        continue
      }

      const keys = identityKeys(candidate)
      if (keys.some((key) => seen.has(key))) {
        summary.duplicates += 1
        continue
      }
      for (const key of keys) seen.set(key, index + 2)
      if (findDuplicate(db, candidate)) {
        summary.duplicates += 1
        continue
      }

      const explicitId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 200) : undefined
      if (explicitId && db.prepare('SELECT 1 FROM candidates WHERE id = ?').get(explicitId)) {
        summary.duplicates += 1
        continue
      }
      insertCandidate(db, { ...candidate, ...(explicitId ? { id: explicitId } : {}), import_batch_id: batchId }, {
        activityType: 'candidate_imported',
        activityMetadata: { import_batch_id: batchId, row_number: index + 2 },
        hydrate: false
      })
      summary.imported += 1
    }

    db.prepare(`
      UPDATE import_batches SET
        imported_rows = ?, skipped_rows = ?, failed_rows = ?, status = 'completed', completed_at = ?
      WHERE id = ?
    `).run(summary.imported, summary.duplicates, summary.invalid, now(), batchId)

    return {
      batchId,
      ...summary,
      import_batch_id: batchId,
      imported_rows: summary.imported,
      skipped_rows: summary.duplicates,
      failed_rows: summary.invalid
    }
  }, { synchronizeSearch: false })
}

export async function exportCandidates(candidates, format = 'xlsx') {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Recruitment Platform'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet('候选人')
  sheet.columns = EXPORT_FIELDS.map((field) => ({
    header: FIELD_LABELS[field] ?? field,
    key: field,
    width: field === 'tags' ? 28 : Math.max(14, Math.min(30, (FIELD_LABELS[field] ?? field).length + 6))
  }))
  for (const candidate of candidates) {
    const row = {
      ...candidate,
      years_experience: formatYearsExperience({
        raw: candidate.years_experience_raw,
        numeric: candidate.years_experience
      }),
      tags: (candidate.tags ?? []).join('，')
    }
    if (format === 'csv') {
      for (const field of EXPORT_FIELDS) row[field] = neutralizeCsvFormula(row[field])
    }
    sheet.addRow(row)
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(EXPORT_FIELDS.length).letter}1` }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }

  if (format === 'csv') {
    const csv = await workbook.csv.writeBuffer()
    return {
      buffer: Buffer.concat([Buffer.from('\uFEFF'), Buffer.from(csv)]),
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv'
    }
  }
  const buffer = await workbook.xlsx.writeBuffer()
  return {
    buffer: Buffer.from(buffer),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx'
  }
}
