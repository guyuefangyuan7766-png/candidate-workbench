// Reconcile a commit-time identity race for A-group part 10 without re-committing.
// This script creates a preview only, compares it with the durable commit result,
// and records the reconciliation in the local progress/failure indexes.
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const manifestPath = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-a-rerun-02d7fcea2e29458e83f16195845adf9e/prepared-manifest.json'
const statePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-progress-20260826.json'
const failurePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-failure-index-20260826.json'
const databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'
const baseUrl = 'http://127.0.0.1:4173'
const partIndex = Number(process.argv[2] ?? 10)
if (!Number.isInteger(partIndex) || partIndex < 1) throw new Error('invalid_part_index')

const safeCode = (value, fallback = 'unknown') => {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : fallback
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hashFile = async (path) => {
  const hash = createHash('sha256')
  const stream = (await import('node:fs')).createReadStream(path)
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const requestJson = async (url, options = {}) => {
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, options)
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { /* handled by status checks */ }
      return { status: response.status, body }
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(1_000 * (attempt + 1))
    }
  }
  throw lastError
}
const taskFromRequestKey = async (key) => {
  const response = await requestJson(`${baseUrl}/api/candidates/import/tasks?client_request_id=${encodeURIComponent(key)}`)
  if (response.status !== 200) return null
  return Array.isArray(response.body?.items) ? response.body.items[0] ?? null : null
}
const waitTask = async (taskId) => {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const response = await requestJson(`${baseUrl}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    if (response.status === 200 && response.body) {
      const task = response.body
      if (['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'].includes(task.status)) return task
    }
    await sleep(attempt < 5 ? 500 : 2_000)
  }
  throw new Error('repreview_poll_timeout')
}
const failureCodes = (errors) => [...new Set((Array.isArray(errors) ? errors : [])
  .map((error) => safeCode(error?.code ?? error?.field)))] .sort()
const failureKey = (entry) => [entry.part_index, entry.phase, entry.csv_row_number ?? '', entry.unresolved_count ?? '', entry.error_codes?.join(',') ?? ''].join('|')
const addFailureEntries = (log, entries) => {
  const existing = new Set((log.entries ?? []).map(failureKey))
  log.entries ??= []
  for (const entry of entries) {
    const normalized = {
      part_index: Number(entry.part_index),
      source_file: basename(String(entry.source_file ?? 'unknown')),
      output_file: basename(String(entry.output_file ?? 'unknown')),
      phase: safeCode(entry.phase, 'unknown'),
      ...(Number.isInteger(entry.csv_row_number) ? { csv_row_number: entry.csv_row_number } : {}),
      ...(Number.isInteger(entry.data_row_number) ? { data_row_number: entry.data_row_number } : {}),
      ...(Array.isArray(entry.error_codes) ? { error_codes: entry.error_codes.map((code) => safeCode(code)).sort() } : {})
    }
    if (!existing.has(failureKey(normalized))) {
      log.entries.push(normalized)
      existing.add(failureKey(normalized))
    }
  }
}

const manifest = await readJson(manifestPath)
const state = await readJson(statePath)
const failureLog = await readJson(failurePath)
const parts = (manifest.source_groups?.talent_library ?? [])
  .flatMap((source) => (source.sheets ?? []).flatMap((sheet) => sheet.output_parts ?? []))
const part = parts[partIndex - 1]
if (!part) throw new Error('part10_manifest_missing')
const info = await stat(part.output_path)
const actualHash = await hashFile(part.output_path)
if (info.size !== Number(part.output_bytes) || actualHash !== String(part.output_sha256).toUpperCase()) {
  throw new Error('part10_output_fingerprint_mismatch')
}
const health = await requestJson(`${baseUrl}/api/health`)
if (health.status !== 200 || health.body?.status !== 'ok') throw new Error('health_gate_failed')

const runId = String(state.run_id)
const hashPrefix = actualHash.slice(0, 32)
const previewKey = `${runId}:repreview:${partIndex}:${hashPrefix}`
let previewTask = await taskFromRequestKey(previewKey)
if (!previewTask) {
  const bytes = await readFile(part.output_path)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'text/csv' }), basename(part.output_file))
  const accepted = await requestJson(`${baseUrl}/api/candidates/import/tasks`, {
    method: 'POST',
    headers: { 'Idempotency-Key': previewKey, Prefer: 'respond-async' },
    body: form
  })
  if (accepted.status < 200 || accepted.status >= 300 || !accepted.body?.task_id) throw new Error(`repreview_http_${accepted.status}`)
  previewTask = accepted.body
}
const terminal = ['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'].includes(previewTask.status)
  ? previewTask
  : await waitTask(previewTask.task_id)
if (terminal.status !== 'preview_ready') throw new Error(`repreview_${safeCode(terminal.status)}`)

const db = new DatabaseSync(databasePath, { readOnly: true })
let persistedTask
try {
  persistedTask = db.prepare(`
    SELECT id, status, preview_path, result_json
    FROM candidate_import_tasks WHERE id = ?
  `).get(previewTask.task_id)
} finally { db.close() }
if (!persistedTask?.preview_path) throw new Error('repreview_state_missing')
const persisted = await readJson(persistedTask.preview_path)
const previewRows = Array.isArray(persisted?.preview?.rows) ? persisted.preview.rows : []
if (previewRows.length !== Number(part.output_rows)) throw new Error('repreview_row_count_mismatch')
const previewSummary = terminal.result?.summary ?? {}
const invalidEntries = []
for (const row of previewRows) {
  if (!Array.isArray(row.errors)) throw new Error('repreview_row_errors_missing')
  if (row.errors.length === 0) continue
  const rowNumber = Number(row.row_number)
  invalidEntries.push({
    part_index: partIndex,
    source_file: part.source_file,
    output_file: part.output_file,
    phase: 'preview_invalid',
    csv_row_number: Number.isInteger(rowNumber) ? rowNumber : undefined,
    data_row_number: Number.isInteger(rowNumber) ? rowNumber - 1 : undefined,
    error_codes: failureCodes(row.errors)
  })
}
if (invalidEntries.length !== Number(previewSummary.invalid_rows)) throw new Error('repreview_invalid_count_mismatch')

const commitKey = `${runId}:commit:${partIndex}:${hashPrefix}`
const commitRow = dbRead(commitKey)
function dbRead(key) {
  const readDb = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return readDb.prepare(`
      SELECT id, status, result_json FROM candidate_import_tasks
      WHERE task_type = 'commit' AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1
    `).get(key) ?? null
  } finally { readDb.close() }
}
function dbPreviewRead(key) {
  const readDb = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return readDb.prepare(`
      SELECT id, status, result_json FROM candidate_import_tasks
      WHERE task_type = 'preview' AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1
    `).get(key) ?? null
  } finally { readDb.close() }
}
if (!commitRow || !['completed', 'committed'].includes(commitRow.status) || !commitRow.result_json) {
  throw new Error('existing_commit_result_missing')
}
const commitResult = JSON.parse(commitRow.result_json)
const commitFailures = Array.isArray(commitResult.failures) ? commitResult.failures : []
const previewByRow = new Map(invalidEntries.map((entry) => [entry.csv_row_number, entry.error_codes]))
const commitByRow = new Map(commitFailures.map((failure) => [Number(failure.row_number), failureCodes(failure.errors)]))
const extraCommit = [...commitByRow.keys()].filter((row) => !previewByRow.has(row))
const missingCommit = [...previewByRow.keys()].filter((row) => !commitByRow.has(row))
const codeMismatches = [...previewByRow.keys()]
  .filter((row) => commitByRow.has(row))
  .filter((row) => JSON.stringify(previewByRow.get(row)) !== JSON.stringify(commitByRow.get(row)))
// The commit endpoint deliberately caps returned failure details. Rows omitted
// from that capped list are still accounted for by the preview coordinates;
// treat them as covered only after checking the explicit omission count.
const returnedFailureCount = Number(commitResult.failure_details_returned ?? commitFailures.length)
const omittedFailureCount = Number(commitResult.failure_details_omitted ?? Math.max(0, Number(commitResult.failed_rows) - commitFailures.length))
const failureDetailCountMismatch = returnedFailureCount !== commitFailures.length
  || omittedFailureCount !== Math.max(0, Number(commitResult.failed_rows) - commitFailures.length)
if (Number(previewSummary.invalid_rows) !== Number(commitResult.failed_rows)
  || extraCommit.length || codeMismatches.length
  || missingCommit.length !== omittedFailureCount
  || failureDetailCountMismatch) {
  throw new Error(JSON.stringify({
    code: 'repreview_commit_mismatch',
    preview_invalid_rows: Number(previewSummary.invalid_rows),
    commit_failed_rows: Number(commitResult.failed_rows),
    extra_commit_rows: extraCommit,
    missing_commit_rows: missingCommit,
    code_mismatch_rows: codeMismatches,
    returned_failure_count: returnedFailureCount,
    actual_returned_failure_count: commitFailures.length,
    omitted_failure_count: omittedFailureCount,
    expected_omitted_failure_count: Math.max(0, Number(commitResult.failed_rows) - commitFailures.length)
  }))
}

// Keep the pre-commit preview in the primary preview field. The re-preview is
// recorded separately because duplicate counts change after materialization.
const originalPreviewRow = dbPreviewRead(`${runId}:preview:${partIndex}:${hashPrefix}`)
let originalPreviewResult = null
try { originalPreviewResult = originalPreviewRow?.result_json ? JSON.parse(originalPreviewRow.result_json) : null } catch { /* use prior state */ }
const priorPartState = state.parts?.[String(partIndex)] ?? {}
const originalSummary = originalPreviewResult?.summary ?? priorPartState.preview ?? previewSummary
const originalPosition = originalPreviewResult?.position_preview ?? priorPartState.position_preview ?? terminal.result?.position_preview ?? {}
const summarizePreview = (summary) => ({
  total_rows: Number(summary.total_rows),
  valid_rows: Number(summary.valid_rows),
  invalid_rows: Number(summary.invalid_rows),
  existing_duplicates: Number(summary.existing_duplicates ?? 0),
  file_duplicates: Number(summary.file_duplicates ?? 0),
  position_records: Number(summary.position_records ?? 0),
  position_link_count: Number(summary.position_link_count ?? 0)
})

addFailureEntries(failureLog, invalidEntries)
await mkdir(dirname(failurePath), { recursive: true })
await writeFile(failurePath, JSON.stringify(failureLog, null, 2), { encoding: 'utf8', mode: 0o600 })
state.parts ??= {}
state.parts[String(partIndex)] = {
  source_file: basename(part.source_file),
  output_file: basename(part.output_file),
  output_rows: Number(part.output_rows),
  status: 'completed',
  preview: summarizePreview(originalSummary),
  post_commit_repreview: summarizePreview(previewSummary),
  position_preview: {
    create_count: Number(originalPosition.create_count ?? 0),
    match_count: Number(originalPosition.match_count ?? 0),
    link_count: Number(originalPosition.link_count ?? 0)
  },
  commit: Object.fromEntries([
    'imported_rows', 'updated_rows', 'skipped_rows', 'failed_rows', 'candidate_count',
    'application_count', 'position_count', 'positions_created', 'positions_matched', 'links_created',
    'failure_details_returned', 'failure_details_omitted', 'failure_details_truncated'
  ].filter((key) => commitResult[key] !== undefined).map((key) => [key, commitResult[key]])),
  commit_task_id: commitRow.id,
  preview_recheck: {
    status: 'verified_after_commit',
    preview_task_id: previewTask.task_id,
    invalid_rows: Number(previewSummary.invalid_rows),
    commit_task_reused: true,
    extra_commit_rows: 0,
    missing_commit_rows: 0,
    code_mismatch_rows: 0,
    returned_commit_failure_rows: commitFailures.length,
    omitted_commit_failure_rows: omittedFailureCount
  }
}
delete state.stop_reason
delete state.gate_failures
state[`recovery_part${partIndex}`] = {
  status: 'verified_after_commit',
  preview_invalid_rows: Number(previewSummary.invalid_rows),
  commit_failed_rows: Number(commitResult.failed_rows),
  extra_commit_rows: 0,
  missing_commit_rows: 0,
  code_mismatch_rows: 0,
  returned_commit_failure_rows: commitFailures.length,
  omitted_commit_failure_rows: omittedFailureCount,
  commit_task_reused: true
}
state.updated_at = new Date().toISOString()
await writeFile(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify({
  event: `part${partIndex}_repreview_reconciled`,
  preview_invalid_rows: Number(previewSummary.invalid_rows),
  commit_failed_rows: Number(commitResult.failed_rows),
  commit_task_reused: true,
  failure_entries: failureLog.entries.length
}))
