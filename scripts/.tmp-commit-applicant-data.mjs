// Sequential B-group preview/commit driver.
// Tokens and raw rows stay in memory; persisted progress contains only
// file/part coordinates, aggregate counters, and stable error codes.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readCandidateImportFile } from '../server/import-file.js'

const [
  manifestPath = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-111242755/prepared-manifest.json',
  sourceManifestPath = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-111242755/source-manifest.json',
  baseUrl = 'http://127.0.0.1:4173',
  databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db',
  statePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-progress-20260827.json',
  failurePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-failure-index-20260827.json',
  failedRowsPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-failed-rows-final-20260827.csv',
  reasonsPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-failure-reasons-final-20260827.json'
] = process.argv.slice(2)

const TERMINAL = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])
const ALLOWED_ERROR_CODES = new Set([
  'missing_identity', 'missing_candidate_id', 'identity_conflict', 'application_identity_conflict',
  'duplicate_application_id', 'invalid_date', 'birth_date', 'phone', 'email', 'photo_url', 'age',
  'candidate_archived', 'position_invalid', 'position_ambiguous', 'position_archived_conflict', 'hire_date'
])

function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }

function safeCode(value, fallback = 'unknown') {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : fallback
}

function csvField(value) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

async function hashFile(path) {
  const hash = createHash('sha256')
  const bytes = await readFile(path)
  hash.update(bytes)
  return { bytes: bytes.length, sha256: hash.digest('hex').toUpperCase() }
}

async function requestJson(url, options = {}, attempts = 6) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      return { status: response.status, body }
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) await sleep(Math.min(15_000, 1_000 * (attempt + 1)))
    } finally { clearTimeout(timer) }
  }
  throw lastError ?? new Error('network_error')
}

function responseErrorCode(body, fallback) {
  return safeCode(body?.error?.code ?? body?.code ?? body?.error_code, fallback)
}

function taskRow(taskId) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return db.prepare(`
      SELECT id, task_type, status, phase, progress, preview_path, preview_token,
             result_json, error_json, metrics_json
      FROM candidate_import_tasks WHERE id = ?
    `).get(taskId) ?? null
  } finally { db.close() }
}

async function lookupTask(key) {
  const response = await requestJson(`${baseUrl}/api/candidates/import/tasks?client_request_id=${encodeURIComponent(key)}`)
  if (response.status !== 200) return null
  return Array.isArray(response.body?.items) ? response.body.items[0] ?? null : null
}

async function waitTask(taskId, kind, index, total) {
  let last = ''
  for (let attempt = 0; attempt < 5400; attempt += 1) {
    const response = await requestJson(`${baseUrl}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    if (response.status !== 200 || !response.body) {
      if (attempt < 30) { await sleep(1_000); continue }
      throw Object.assign(new Error(`task_status_${response.status}`), { code: `task_status_${response.status}` })
    }
    const task = response.body
    const marker = `${task.status ?? ''}:${task.phase ?? ''}:${task.progress ?? 0}`
    if (marker !== last) {
      console.log(JSON.stringify({ event: 'progress', kind, index, total, status: safeCode(task.status), phase: safeCode(task.phase), progress: Number(task.progress ?? 0) }))
      last = marker
    }
    if (TERMINAL.has(task.status)) return task
    await sleep(attempt < 5 ? 500 : 2_000)
  }
  throw Object.assign(new Error(`${kind}_poll_timeout`), { code: `${kind}_poll_timeout` })
}

function flattenParts(manifest) {
  return (manifest.source_groups?.applicant_data ?? []).flatMap((source) => (
    (source.sheets ?? []).flatMap((sheet) => (sheet.output_parts ?? []).map((part) => ({
      group: 'applicant_data',
      source_file: source.source_file,
      source_sheet: sheet.sheet_name,
      ...part
    })))
  )).map((part, index) => ({ ...part, index: index + 1 }))
}

function errorCodes(errors) {
  const codes = [...new Set((Array.isArray(errors) ? errors : []).map((error) => {
    const code = error?.code ?? error?.field
    return safeCode(code, 'unknown')
  }))]
  return codes.length ? codes.sort() : []
}

function addFailure(failures, part, row, phase, codes) {
  const csvRow = Number(row?.row_number ?? row?.csv_row_number)
  if (!Number.isInteger(csvRow) || csvRow < 2 || csvRow > Number(part.output_rows) + 1) return
  const entry = {
    part_index: part.index,
    source_file: basename(part.source_file),
    output_file: basename(part.output_file),
    phase: safeCode(phase),
    csv_row_number: csvRow,
    data_row_number: csvRow - 1,
    error_codes: [...new Set((codes ?? []).map((code) => safeCode(code)))].sort()
  }
  const existing = failures.find((item) => item.part_index === entry.part_index && item.csv_row_number === entry.csv_row_number)
  if (!existing) {
    failures.push(entry)
    return
  }
  existing.phase = [...new Set(`${existing.phase};${entry.phase}`.split(';').filter(Boolean))].sort().join(';')
  existing.error_codes = [...new Set([...(existing.error_codes ?? []), ...entry.error_codes])].sort()
}

function validateBPreview(part, terminal, persisted) {
  if (terminal.status !== 'preview_ready') throw Object.assign(new Error('preview_not_ready'), { code: `preview_${terminal.status ?? 'failed'}` })
  const preview = persisted?.preview
  if (!preview || !Array.isArray(preview.rows)) throw Object.assign(new Error('preview_payload_invalid'), { code: 'preview_payload_invalid' })
  const summary = terminal.result?.summary ?? {}
  if (preview.rows.length !== Number(part.output_rows) || Number(summary.total_rows) !== preview.rows.length) {
    throw Object.assign(new Error('preview_row_count_mismatch'), { code: 'preview_row_count_mismatch' })
  }
  if (Number(summary.valid_rows ?? 0) + Number(summary.invalid_rows ?? 0) !== preview.rows.length) {
    throw Object.assign(new Error('preview_summary_mismatch'), { code: 'preview_summary_mismatch' })
  }
  const invalid = preview.rows.filter((row) => Array.isArray(row.errors) && row.errors.length)
  const codeCounts = {}
  for (const row of preview.rows) {
    const rowNumber = Number(row?.row_number)
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > Number(part.output_rows) + 1 || !Array.isArray(row.errors)) {
      throw Object.assign(new Error('preview_row_structure_invalid'), { code: 'preview_row_structure_invalid' })
    }
    for (const code of errorCodes(row.errors)) {
      if (!ALLOWED_ERROR_CODES.has(code)) throw Object.assign(new Error(`unexpected_preview_error_${code}`), { code: `preview_error_${code}` })
      codeCounts[code] = Number(codeCounts[code] ?? 0) + 1
    }
  }
  if (invalid.length !== Number(summary.invalid_rows ?? -1)) throw Object.assign(new Error('preview_invalid_count_mismatch'), { code: 'preview_invalid_count_mismatch' })
  const hire = { status_only_rows: 0, date_only_rows: 0, both_nonempty_rows: 0, invalid_date_rows: 0 }
  for (const row of preview.rows) {
    const payload = row.raw_payload ?? {}
    const status = String(payload['入职状态'] ?? '').trim()
    const date = String(payload['入职日期'] ?? '').trim()
    if (status && date) hire.both_nonempty_rows += 1
    else if (status && !date) hire.status_only_rows += 1
    else if (!status && date) hire.date_only_rows += 1
    if (errorCodes(row.errors).includes('invalid_date')) hire.invalid_date_rows += 1
  }
  if (hire.date_only_rows !== 0 || hire.invalid_date_rows !== 0) throw Object.assign(new Error('hire_field_gate_failed'), { code: 'hire_field_gate_failed' })
  return { summary, codeCounts, hire, invalidRows: invalid }
}

async function previewPart(part, runId) {
  const key = `${runId}:preview:${part.index}:${String(part.output_sha256).slice(0, 32)}`
  let task = await lookupTask(key).catch(() => null)
  if (!task) {
    const bytes = await readFile(part.output_path)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'text/csv' }), basename(part.output_file))
    const accepted = await requestJson(`${baseUrl}/api/candidates/import/tasks`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key, Prefer: 'respond-async' },
      body: form
    })
    if (accepted.status !== 202 && !(accepted.status >= 200 && accepted.status < 300)) {
      throw Object.assign(new Error('preview_request_rejected'), { code: responseErrorCode(accepted.body, `preview_http_${accepted.status}`) })
    }
    task = accepted.body
  }
  if (!task?.task_id) throw Object.assign(new Error('preview_task_id_missing'), { code: 'preview_task_id_missing' })
  const terminal = TERMINAL.has(task.status) ? task : await waitTask(task.task_id, 'preview', part.index, 7)
  const durable = taskRow(task.task_id)
  if (!durable?.preview_path) throw Object.assign(new Error('preview_state_missing'), { code: 'preview_state_missing' })
  const persisted = await readJson(durable.preview_path)
  const checked = validateBPreview(part, terminal, persisted)
  return { task_id: task.task_id, token: terminal.preview_token, preview_path: durable.preview_path, ...checked }
}

function safeCommitResult(result) {
  const keys = [
    'imported_rows', 'updated_rows', 'skipped_rows', 'failed_rows', 'candidate_count',
    'application_count', 'position_count', 'positions_created', 'positions_matched', 'links_created',
    'pools_created', 'failure_details_returned', 'failure_details_omitted', 'failure_details_truncated'
  ]
  return Object.fromEntries(keys.filter((key) => result?.[key] !== undefined).map((key) => [key, typeof result[key] === 'boolean' ? result[key] : Number(result[key])]))
}

async function commitPart(part, preview, runId, failures) {
  const key = `${runId}:commit:${part.index}:${String(part.output_sha256).slice(0, 32)}`
  let task = await lookupTask(key).catch(() => null)
  let attempts = 0
  while (!task || (['failed', 'timed_out'].includes(task.status) && task.error?.retryable === true)) {
    if (attempts >= 3) {
      throw Object.assign(new Error('commit_retry_exhausted'), { code: 'commit_retry_exhausted' })
    }
    const response = await requestJson(`${baseUrl}/api/candidates/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Prefer: 'respond-async' },
      body: JSON.stringify({ preview_token: preview.token, on_duplicate: 'update', async: true })
    })
    if (response.status !== 202 && response.status !== 200 && response.status !== 201) {
      throw Object.assign(new Error('commit_request_rejected'), { code: responseErrorCode(response.body, `commit_http_${response.status}`) })
    }
    task = response.body
    attempts += 1
    if (task?.status === 'queued' || task?.status === 'committing') break
  }
  if (!task?.task_id) throw Object.assign(new Error('commit_task_id_missing'), { code: 'commit_task_id_missing' })
  let terminal = TERMINAL.has(task.status) ? task : await waitTask(task.task_id, 'commit', part.index, 7)
  while (['failed', 'timed_out'].includes(terminal.status) && terminal.error?.retryable === true && attempts < 3) {
    const response = await requestJson(`${baseUrl}/api/candidates/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Prefer: 'respond-async' },
      body: JSON.stringify({ preview_token: preview.token, on_duplicate: 'update', async: true })
    })
    if (response.status !== 202 && response.status !== 200 && response.status !== 201) {
      throw Object.assign(new Error('commit_retry_request_rejected'), { code: responseErrorCode(response.body, `commit_retry_http_${response.status}`) })
    }
    task = response.body
    attempts += 1
    terminal = TERMINAL.has(task.status) ? task : await waitTask(task.task_id, 'commit', part.index, 7)
  }
  if (terminal.status !== 'completed') throw Object.assign(new Error('commit_not_completed'), { code: safeCode(terminal.error?.code, `commit_${terminal.status ?? 'failed'}`) })
  const result = safeCommitResult(terminal.result)
  const accounted = Number(result.imported_rows ?? 0) + Number(result.updated_rows ?? 0) + Number(result.skipped_rows ?? 0) + Number(result.failed_rows ?? 0)
  if (accounted !== Number(part.output_rows)) throw Object.assign(new Error('commit_row_count_mismatch'), { code: 'commit_row_count_mismatch' })
  if (Number(result.failed_rows ?? 0) !== Number(preview.summary.invalid_rows ?? 0)) {
    throw Object.assign(new Error('commit_failure_count_changed'), { code: 'commit_new_failures' })
  }
  for (const row of preview.invalidRows) addFailure(failures, part, row, 'preview_invalid', errorCodes(row.errors))
  for (const failure of terminal.result?.failures ?? []) {
    addFailure(failures, part, { row_number: Number(failure?.row_number) }, 'commit_failed', errorCodes(failure?.errors))
  }
  return { task_id: task.task_id, result }
}

async function sourceHashGate(sourceManifest) {
  const failures = []
  for (const group of sourceManifest.source_groups ?? []) {
    if (group.label !== 'applicant_data') continue
    for (const file of group.files ?? []) {
      const path = resolve(String(group.root), String(file.filename))
      const actual = await hashFile(path)
      if (actual.bytes !== Number(file.size_bytes) || actual.sha256 !== String(file.sha256_before).toUpperCase()) {
        failures.push({ file: basename(path), reason: 'source_fingerprint_mismatch' })
      }
    }
  }
  return failures
}

async function exportFailures(parts, failures) {
  const byPart = new Map(parts.map((part) => [part.index, part]))
  const parsed = new Map()
  const headers = []
  const headerSet = new Set()
  for (const entry of failures) {
    if (parsed.has(entry.part_index)) continue
    const part = byPart.get(entry.part_index)
    const info = await stat(part.output_path)
    const data = await readCandidateImportFile({ path: part.output_path, originalname: basename(part.output_file), mimetype: 'text/csv', size: info.size })
    parsed.set(entry.part_index, data)
    for (const header of data.headers) if (!headerSet.has(header)) { headerSet.add(header); headers.push(header) }
  }
  const lines = [[
    '来源文件', '来源分片', 'CSV行号', '数据行号', '失败阶段', '失败原因', '定位状态', '未定位数量', ...headers
  ].map(csvField).join(',')]
  const reasonCounts = {}
  const phaseCounts = {}
  const rowKeys = new Set()
  for (const entry of failures.sort((a, b) => a.part_index - b.part_index || a.csv_row_number - b.csv_row_number || a.phase.localeCompare(b.phase))) {
    const key = `${entry.part_index}:${entry.csv_row_number}`
    const part = byPart.get(entry.part_index)
    const data = parsed.get(entry.part_index)
    const sourceRow = data?.rows?.find((row) => Number(row.row_number) === entry.csv_row_number)
    const values = sourceRow?.values ?? {}
    if (rowKeys.has(key)) continue
    rowKeys.add(key)
    for (const code of entry.error_codes) reasonCounts[code] = Number(reasonCounts[code] ?? 0) + 1
    phaseCounts[entry.phase] = Number(phaseCounts[entry.phase] ?? 0) + 1
    const valueMap = new Map(data?.headers?.map((header) => [header, values[header] ?? '']) ?? [])
    lines.push([
      part?.source_file ?? entry.source_file,
      part?.output_file ?? entry.output_file,
      entry.csv_row_number,
      entry.data_row_number,
      entry.phase,
      entry.error_codes.join(';'),
      sourceRow ? '已定位' : '未定位',
      '',
      ...headers.map((header) => valueMap.get(header) ?? '')
    ].map(csvField).join(','))
  }
  await mkdir(dirname(failedRowsPath), { recursive: true })
  await writeFile(failedRowsPath, `\uFEFF${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    group: 'applicant_data',
    failure_rows: rowKeys.size,
    reason_counts: reasonCounts,
    phase_counts: phaseCounts,
    output_csv: basename(failedRowsPath),
    privacy_notice: 'User-authorized local failure table; original source fields are included and no preview tokens are included.'
  }
  await writeJson(reasonsPath, summary)
  return summary
}

async function main() {
  const manifest = await readJson(manifestPath)
  const sourceManifest = await readJson(sourceManifestPath)
  if (!manifest || !sourceManifest) throw Object.assign(new Error('manifest_missing'), { code: 'manifest_missing' })
  const parts = flattenParts(manifest)
  if (parts.length !== 7 || parts.reduce((sum, part) => sum + Number(part.output_rows ?? 0), 0) !== 1390) {
    throw Object.assign(new Error('manifest_gate_failed'), { code: 'manifest_gate_failed' })
  }
  const expectedSourceFailures = await sourceHashGate(sourceManifest)
  if (expectedSourceFailures.length) throw Object.assign(new Error('source_fingerprint_mismatch'), { code: 'source_fingerprint_mismatch' })
  for (const part of parts) {
    const actual = await hashFile(part.output_path)
    if (actual.bytes !== Number(part.output_bytes) || actual.sha256 !== String(part.output_sha256).toUpperCase()) {
      throw Object.assign(new Error(`output_fingerprint_mismatch_${part.index}`), { code: 'output_fingerprint_mismatch' })
    }
    const parsed = await readCandidateImportFile({ path: part.output_path, originalname: basename(part.output_file), mimetype: 'text/csv', size: actual.bytes })
    if (parsed.rows.length !== Number(part.output_rows) || parsed.headers.join('\u0000') !== '入职状态\u0000入职日期\u0000应聘者ID') {
      throw Object.assign(new Error(`part_structure_mismatch_${part.index}`), { code: 'part_structure_mismatch' })
    }
  }
  const previous = await readJson(statePath)
  const resumable = previous?.group === 'applicant_data' && typeof previous.run_id === 'string' && previous.run_id.length > 0
  const runId = resumable ? previous.run_id : randomUUID()
  const state = resumable
    ? previous
    : {
        schema_version: 1,
        run_id: runId,
        group: 'applicant_data',
        started_at: new Date().toISOString(),
        parts: {},
        failures: []
      }
  state.parts ??= {}
  state.failures ??= []
  if (resumable) state.resumed_at = new Date().toISOString()
  delete state.stop_reason
  delete state.failure_summary
  delete state.completed_parts
  delete state.finished_at
  const priorFailureIndex = await readJson(failurePath)
  for (const entry of priorFailureIndex?.entries ?? []) {
    const part = parts.find((item) => item.index === Number(entry.part_index))
    if (part) addFailure(state.failures, part, entry, entry.phase, entry.error_codes)
  }
  await writeJson(statePath, state)
  for (const part of parts) {
    if (state.parts[String(part.index)]?.status === 'completed') {
      console.log(JSON.stringify({ event: 'part_skipped_completed', index: part.index, total: parts.length }))
      continue
    }
    console.log(JSON.stringify({ event: 'part_start', index: part.index, total: parts.length, rows: Number(part.output_rows) }))
    try {
      const preview = await previewPart(part, runId)
      for (const row of preview.invalidRows) addFailure(state.failures, part, row, 'preview_invalid', errorCodes(row.errors))
      await writeJson(failurePath, { schema_version: 1, group: 'applicant_data', entries: state.failures })
      const commit = await commitPart(part, preview, runId, state.failures)
      state.parts[String(part.index)] = {
        source_file: basename(part.source_file), output_file: basename(part.output_file), output_rows: Number(part.output_rows),
        status: 'completed', preview: {
          total_rows: Number(preview.summary.total_rows), valid_rows: Number(preview.summary.valid_rows), invalid_rows: Number(preview.summary.invalid_rows),
          existing_duplicates: Number(preview.summary.existing_duplicates ?? 0), file_duplicates: Number(preview.summary.file_duplicates ?? 0),
          candidate_records: Number(preview.summary.candidate_records ?? 0), hire: preview.hire, error_codes: preview.codeCounts
        },
        commit: commit.result
      }
      await writeJson(failurePath, { schema_version: 1, group: 'applicant_data', entries: state.failures })
      await writeJson(statePath, state)
      console.log(JSON.stringify({ event: 'part_completed', index: part.index, total: parts.length, rows: Number(part.output_rows), commit: commit.result }))
    } catch (error) {
      state.parts[String(part.index)] = {
        source_file: basename(part.source_file), output_file: basename(part.output_file), output_rows: Number(part.output_rows),
        status: 'stopped', error_code: safeCode(error?.code ?? error?.message)
      }
      state.stop_reason = safeCode(error?.code ?? error?.message)
      await writeJson(statePath, state)
      await writeJson(failurePath, { schema_version: 1, group: 'applicant_data', entries: state.failures })
      state.failure_summary = await exportFailures(parts, state.failures)
      await writeJson(statePath, state)
      throw error
    }
  }
  const finalSourceFailures = await sourceHashGate(sourceManifest)
  if (finalSourceFailures.length) throw Object.assign(new Error('source_fingerprint_mismatch_after'), { code: 'source_fingerprint_mismatch_after' })
  state.completed_parts = parts.length
  state.finished_at = new Date().toISOString()
  state.failure_summary = await exportFailures(parts, state.failures)
  await writeJson(statePath, state)
  await writeJson(failurePath, { schema_version: 1, group: 'applicant_data', entries: state.failures })
  console.log(JSON.stringify({ event: 'complete', completed_parts: state.completed_parts, failure_rows: state.failure_summary.failure_rows, reason_counts: state.failure_summary.reason_counts }))
}

main().catch((error) => {
  console.log(JSON.stringify({ event: 'stopped', code: safeCode(error?.code ?? error?.message) }))
  process.exitCode = 1
})
