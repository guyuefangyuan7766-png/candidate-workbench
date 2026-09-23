// One-shot, resumable A-group commit driver.
// It deliberately emits only aggregate counters and a redacted row failure index.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, resolve } from 'node:path'

const [
  manifestPath = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-a-rerun-02d7fcea2e29458e83f16195845adf9e/prepared-manifest.json',
  sourceManifestPath = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-111242755/source-manifest.json',
  baseUrl = 'http://127.0.0.1:4173',
  databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db',
  statePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-progress-20260826.json',
  failurePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-failure-index-20260826.json'
] = process.argv.slice(2)

const GROUP = 'talent_library'
const MAX_FETCH_ATTEMPTS = 4
const TERMINAL = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])
const ALLOWED_PREVIEW_CODES = new Set([
  'identity_conflict', 'birth_date', 'missing_identity', 'phone', 'email', 'photo_url', 'age',
  'candidate_archived', 'invalid_date', 'missing_candidate_id', 'position_invalid',
  'position_ambiguous', 'position_archived_conflict', 'years_experience'
])

function safeCode(value, fallback = 'unknown') {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : fallback
}

function safeErrorCode(error, fallback = 'driver_error') {
  return safeCode(error?.code ?? error?.cause?.code, fallback)
}

function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }

async function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex').toUpperCase()))
  })
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function flattenParts(manifest) {
  return (manifest.source_groups?.[GROUP] ?? []).flatMap((source) => {
    return (source.sheets ?? []).flatMap((sheet) => {
      return (sheet.output_parts ?? []).map((part) => ({
        group: GROUP,
        source_file: source.source_file,
        source_sheet: sheet.sheet_name,
        ...part
      }))
    })
  })
}

function taskLookupDb(taskId) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return db.prepare(`
      SELECT id, status, phase, progress, preview_path, result_json, error_json
      FROM candidate_import_tasks WHERE id = ?
    `).get(taskId) ?? null
  } finally { db.close() }
}

function sourceTaskByKey(key, taskType) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return db.prepare(`
      SELECT id, status, phase, progress, preview_path, result_json, error_json
      FROM candidate_import_tasks
      WHERE task_type = ? AND idempotency_key = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(taskType, key) ?? null
  } finally { db.close() }
}

async function requestJson(url, options = {}) {
  let lastCode = 'network_error'
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      return { status: response.status, body }
    } catch (error) {
      lastCode = safeErrorCode(error, 'network_error')
      if (attempt + 1 < MAX_FETCH_ATTEMPTS) await sleep(Math.min(15_000, 1_000 * (attempt + 1)))
    } finally { clearTimeout(timer) }
  }
  const error = new Error('request failed')
  error.code = lastCode
  throw error
}

function responseErrorCode(body, fallback) {
  return safeCode(body?.error?.code ?? body?.code ?? body?.error_code, fallback)
}

async function lookupTaskByRequestKey(key) {
  const response = await requestJson(`${baseUrl}/api/candidates/import/tasks?client_request_id=${encodeURIComponent(key)}`)
  if (response.status !== 200) return null
  const item = Array.isArray(response.body?.items) ? response.body.items[0] : null
  return item ?? null
}

async function waitTask(taskId, kind, index, total) {
  let last = ''
  for (let attempt = 0; attempt < 5400; attempt += 1) {
    const response = await requestJson(`${baseUrl}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    if (response.status !== 200 || !response.body) {
      if (attempt < 30) { await sleep(1_000); continue }
      const error = new Error('task status unavailable')
      error.code = `task_status_${response.status}`
      throw error
    }
    const task = response.body
    const marker = `${task.status ?? ''}:${task.phase ?? ''}:${task.progress ?? 0}`
    if (marker !== last) {
      console.log(JSON.stringify({ event: 'progress', index, total, kind, status: safeCode(task.status, 'unknown'), phase: safeCode(task.phase, 'unknown'), progress: Number(task.progress ?? 0) }))
      last = marker
    }
    if (TERMINAL.has(task.status)) return task
    await sleep(attempt < 5 ? 500 : 2_000)
  }
  const error = new Error('task poll timeout')
  error.code = `${kind}_poll_timeout`
  throw error
}

function extractCodes(errors) {
  const codes = []
  for (const error of Array.isArray(errors) ? errors : []) {
    const code = safeCode(error?.code ?? error?.field, 'unknown')
    if (!codes.includes(code)) codes.push(code)
  }
  return codes.length ? codes.sort() : ['unknown']
}

function failureKey(entry) {
  return [entry.part_index, entry.phase, entry.csv_row_number ?? '', entry.unresolved_count ?? '', entry.error_codes?.join(',') ?? ''].join('|')
}

function addFailureEntries(log, entries) {
  const existing = new Set(log.entries.map(failureKey))
  for (const entry of entries) {
    const normalized = {
      part_index: Number(entry.part_index),
      source_file: basename(String(entry.source_file ?? 'unknown')),
      output_file: basename(String(entry.output_file ?? 'unknown')),
      phase: safeCode(entry.phase, 'unknown'),
      ...(Number.isInteger(entry.csv_row_number) ? { csv_row_number: entry.csv_row_number } : {}),
      ...(Number.isInteger(entry.data_row_number) ? { data_row_number: entry.data_row_number } : {}),
      ...(Number.isInteger(entry.unresolved_count) ? { unresolved_count: entry.unresolved_count } : {}),
      ...(Array.isArray(entry.error_codes) ? { error_codes: entry.error_codes.map((code) => safeCode(code)).sort() } : {})
    }
    if (!existing.has(failureKey(normalized))) {
      log.entries.push(normalized)
      existing.add(failureKey(normalized))
    }
  }
}

async function sourceHashGate(sourceManifest, phase) {
  const failures = []
  const groups = Array.isArray(sourceManifest.source_groups) ? sourceManifest.source_groups : []
  for (const group of groups) {
    for (const file of group.files ?? []) {
      const path = resolve(String(group.root ?? ''), String(file.filename ?? ''))
      try {
        const info = await stat(path)
        const expectedSize = Number(file.size_bytes ?? 0)
        const expectedHash = String(file.sha256_before ?? '').toUpperCase()
        const actualHash = await hashFile(path)
        if (info.size !== expectedSize || actualHash !== expectedHash) {
          failures.push({ phase, group: safeCode(group.label, 'unknown'), file: basename(path), reason: 'source_fingerprint_mismatch' })
        }
      } catch (error) {
        failures.push({ phase, group: safeCode(group.label, 'unknown'), file: basename(path), reason: safeErrorCode(error, 'source_unreadable') })
      }
    }
  }
  return failures
}

async function outputHashGate(parts) {
  const failures = []
  for (const part of parts) {
    try {
      const info = await stat(part.output_path)
      const actualHash = await hashFile(part.output_path)
      if (info.size !== Number(part.output_bytes) || actualHash !== String(part.output_sha256).toUpperCase()) {
        failures.push({ part_index: part.index, reason: 'output_fingerprint_mismatch' })
      }
    } catch (error) {
      failures.push({ part_index: part.index, reason: safeErrorCode(error, 'output_unreadable') })
    }
  }
  return failures
}

function checkLockAndHealth() {
  // The service itself is the authority for the maintenance lock.  This check
  // is intentionally done through health only; no lock contents are emitted.
  return requestJson(`${baseUrl}/api/health`).then((response) => {
    if (response.status !== 200 || response.body?.status !== 'ok') {
      const error = new Error('health gate failed')
      error.code = `health_${response.status}`
      throw error
    }
  })
}

async function previewPart(part, index, total, runId, state) {
  const previewKey = `${runId}:preview:${index}:${String(part.output_sha256).slice(0, 32)}`
  let task = await lookupTaskByRequestKey(previewKey).catch(() => null)
  if (!task) {
    const bytes = await readFile(part.output_path)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'text/csv' }), basename(part.output_file))
    const accepted = await requestJson(`${baseUrl}/api/candidates/import/tasks`, {
      method: 'POST',
      headers: { 'Idempotency-Key': previewKey, Prefer: 'respond-async' },
      body: form
    })
    if (accepted.status !== 202 && !(accepted.status >= 200 && accepted.status < 300)) {
      const error = new Error('preview request rejected')
      error.code = responseErrorCode(accepted.body, `preview_http_${accepted.status}`)
      throw error
    }
    task = accepted.body
  }
  if (!task?.task_id) {
    const error = new Error('preview task id missing')
    error.code = 'preview_task_id_missing'
    throw error
  }
  const terminal = TERMINAL.has(task.status) ? task : await waitTask(task.task_id, 'preview', index, total)
  if (terminal.status !== 'preview_ready') {
    const error = new Error('preview did not reach ready')
    error.code = safeCode(terminal.error?.code, `preview_${terminal.status ?? 'failed'}`)
    throw error
  }
  const persistedRow = taskLookupDb(task.task_id)
  if (!persistedRow?.preview_path) {
    const error = new Error('preview state path missing')
    error.code = 'preview_state_missing'
    throw error
  }
  const persisted = await readJson(persistedRow.preview_path, null)
  const preview = persisted?.preview
  if (!preview || !Array.isArray(preview.rows)) {
    const error = new Error('preview payload invalid')
    error.code = 'preview_payload_invalid'
    throw error
  }
  if (preview.rows.length !== Number(part.output_rows)) {
    const error = new Error('preview row count mismatch')
    error.code = 'preview_row_count_mismatch'
    throw error
  }
  const summary = terminal.result?.summary ?? {}
  if (Number(summary.total_rows) !== preview.rows.length || Number(summary.valid_rows) + Number(summary.invalid_rows) !== preview.rows.length) {
    const error = new Error('preview summary mismatch')
    error.code = 'preview_summary_mismatch'
    throw error
  }
  const position = terminal.result?.position_preview ?? {}
  for (const key of ['ambiguous_count', 'invalid_count', 'archived_conflict_count']) {
    if (Number(position[key] ?? 0) !== 0) {
      const error = new Error('preview position gate failed')
      error.code = `preview_${key}`
      throw error
    }
  }
  const invalidEntries = []
  let workYearErrors = 0
  for (const row of preview.rows) {
    if (!Array.isArray(row.errors)) {
      const error = new Error('preview row errors missing')
      error.code = 'preview_row_errors_missing'
      throw error
    }
    const hasErrors = row.errors.length > 0
    const codes = hasErrors ? extractCodes(row.errors) : []
    if (codes.includes('years_experience')) workYearErrors += 1
    if (hasErrors) {
      for (const code of codes) {
        if (code === 'unknown' || !ALLOWED_PREVIEW_CODES.has(code)) {
          const error = new Error('unexplained preview error')
          error.code = `preview_error_${code}`
          throw error
        }
      }
      const csvRow = Number(row.row_number)
      invalidEntries.push({
        part_index: index,
        source_file: part.source_file,
        output_file: part.output_file,
        phase: 'preview_invalid',
        csv_row_number: Number.isInteger(csvRow) ? csvRow : undefined,
        data_row_number: Number.isInteger(csvRow) ? csvRow - 1 : undefined,
        error_codes: codes
      })
    }
  }
  if (workYearErrors !== 0) {
    const error = new Error('work year validation errors')
    error.code = 'preview_years_experience_error'
    throw error
  }
  const expectedInvalid = Number(summary.invalid_rows)
  if (invalidEntries.length !== expectedInvalid) {
    const error = new Error('preview invalid row accounting mismatch')
    error.code = 'preview_invalid_count_mismatch'
    throw error
  }
  addFailureEntries(state.failures, invalidEntries)
  await writeJson(failurePath, state.failures)
  return {
    task_id: task.task_id,
    token: terminal.preview_token,
    preview_path: persistedRow.preview_path,
    summary: {
      total_rows: Number(summary.total_rows),
      valid_rows: Number(summary.valid_rows),
      invalid_rows: Number(summary.invalid_rows),
      existing_duplicates: Number(summary.existing_duplicates ?? 0),
      file_duplicates: Number(summary.file_duplicates ?? 0),
      position_records: Number(summary.position_records ?? 0),
      position_link_count: Number(summary.position_link_count ?? 0)
    },
    position: {
      create_count: Number(position.create_count ?? 0),
      match_count: Number(position.match_count ?? 0),
      link_count: Number(position.link_count ?? 0)
    }
  }
}

function safeCommitResult(result) {
  const keys = [
    'imported_rows', 'updated_rows', 'skipped_rows', 'failed_rows', 'candidate_count',
    'application_count', 'position_count', 'positions_created', 'positions_matched', 'links_created',
    'failure_details_returned', 'failure_details_omitted', 'failure_details_truncated'
  ]
  return Object.fromEntries(keys.filter((key) => result?.[key] !== undefined).map((key) => [key, typeof result[key] === 'boolean' ? result[key] : Number(result[key])]))
}

async function commitPart(part, index, total, preview, runId, state) {
  const commitKey = `${runId}:commit:${index}:${String(part.output_sha256).slice(0, 32)}`
  let task = await lookupTaskByRequestKey(commitKey).catch(() => null)
  if (!task) {
    const response = await requestJson(`${baseUrl}/api/candidates/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': commitKey, Prefer: 'respond-async' },
      body: JSON.stringify({ preview_token: preview.token, on_duplicate: 'update', async: true })
    })
    if (response.status !== 202 && response.status !== 200 && response.status !== 201) {
      const error = new Error('commit request rejected')
      error.code = responseErrorCode(response.body, `commit_http_${response.status}`)
      throw error
    }
    task = response.body
  }
  if (!task?.task_id) {
    const error = new Error('commit task id missing')
    error.code = 'commit_task_id_missing'
    throw error
  }
  const terminal = TERMINAL.has(task.status) ? task : await waitTask(task.task_id, 'commit', index, total)
  if (terminal.status !== 'completed') {
    const error = new Error('commit did not complete')
    error.code = safeCode(terminal.error?.code, `commit_${terminal.status ?? 'failed'}`)
    throw error
  }
  const result = safeCommitResult(terminal.result)
  const accounted = Number(result.imported_rows ?? 0) + Number(result.updated_rows ?? 0) + Number(result.skipped_rows ?? 0) + Number(result.failed_rows ?? 0)
  if (accounted !== Number(part.output_rows)) {
    const error = new Error('commit row accounting mismatch')
    error.code = 'commit_row_count_mismatch'
    throw error
  }
  const previewInvalid = Number(preview.summary.invalid_rows)
  const commitFailed = Number(result.failed_rows ?? 0)
  if (commitFailed !== previewInvalid) {
    const returned = Array.isArray(terminal.result?.failures) ? terminal.result.failures : []
    addFailureEntries(state.failures, returned.map((failure) => ({
      part_index: index,
      source_file: part.source_file,
      output_file: part.output_file,
      phase: 'commit_failed',
      csv_row_number: Number.isInteger(Number(failure?.row_number)) ? Number(failure.row_number) : undefined,
      data_row_number: Number.isInteger(Number(failure?.row_number)) ? Number(failure.row_number) - 1 : undefined,
      error_codes: extractCodes(failure?.errors)
    })))
    const omitted = Math.max(0, commitFailed - returned.length)
    if (omitted > 0) addFailureEntries(state.failures, [{
      part_index: index, source_file: part.source_file, output_file: part.output_file,
      phase: 'commit_failure_details_omitted', unresolved_count: omitted
    }])
    await writeJson(failurePath, state.failures)
    const error = new Error('commit failure count changed after preview')
    error.code = 'commit_new_failures'
    throw error
  }
  const returned = Array.isArray(terminal.result?.failures) ? terminal.result.failures : []
  addFailureEntries(state.failures, returned.map((failure) => ({
    part_index: index,
    source_file: part.source_file,
    output_file: part.output_file,
    phase: 'commit_failed',
    csv_row_number: Number.isInteger(Number(failure?.row_number)) ? Number(failure.row_number) : undefined,
    data_row_number: Number.isInteger(Number(failure?.row_number)) ? Number(failure.row_number) - 1 : undefined,
    error_codes: extractCodes(failure?.errors)
  })))
  await writeJson(failurePath, state.failures)
  return result
}

async function main() {
  const manifest = await readJson(manifestPath, null)
  const sourceManifest = await readJson(sourceManifestPath, null)
  if (!manifest || !sourceManifest) throw Object.assign(new Error('manifest_missing'), { code: 'manifest_missing' })
  const parts = flattenParts(manifest).map((part, index) => ({ ...part, index: index + 1 }))
  if (parts.length !== 18 || parts.some((part) => part.group !== GROUP)) throw Object.assign(new Error('A manifest gate failed'), { code: 'manifest_group_gate' })
  if (parts.reduce((sum, part) => sum + Number(part.output_rows ?? 0), 0) !== 119402) throw Object.assign(new Error('A row total gate failed'), { code: 'manifest_row_total_gate' })

  const state = await readJson(statePath, null) ?? {
    schema_version: 1,
    run_id: randomUUID(),
    group: GROUP,
    started_at: new Date().toISOString(),
    parts: {},
    failures: {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      group: GROUP,
      privacy: {
        candidate_level_rows_persisted: false,
        sensitive_fields_persisted: false,
        raw_payload_persisted: false,
        preview_tokens_persisted: false,
        only_source_file_part_and_row_and_stable_error_codes: true
      },
      entries: []
    }
  }
  const persistedFailures = await readJson(failurePath, null)
  if (persistedFailures?.entries?.length) {
    state.failures = state.failures ?? persistedFailures
    state.failures.entries = state.failures.entries ?? []
    addFailureEntries(state.failures, persistedFailures.entries)
  }
  state.failures ??= { schema_version: 1, group: GROUP, entries: [] }
  state.failures.entries ??= []
  delete state.stop_reason
  delete state.gate_failures
  await writeJson(failurePath, state.failures)

  const outputFailures = await outputHashGate(parts)
  const sourceBeforeFailures = await sourceHashGate(sourceManifest, 'before')
  if (outputFailures.length || sourceBeforeFailures.length) {
    state.stop_reason = outputFailures.length ? 'output_fingerprint_mismatch' : 'source_fingerprint_mismatch'
    state.gate_failures = [...outputFailures, ...sourceBeforeFailures]
    await writeJson(statePath, state)
    throw Object.assign(new Error('preflight gate failed'), { code: state.stop_reason })
  }

  let stopped = null
  for (const part of parts) {
    if (state.parts[part.index]?.status === 'completed') continue
    try {
      await checkLockAndHealth()
      const preview = await previewPart(part, part.index, parts.length, state.run_id, state)
      const result = await commitPart(part, part.index, parts.length, preview, state.run_id, state)
      state.parts[part.index] = {
        source_file: basename(part.source_file), output_file: basename(part.output_file), output_rows: Number(part.output_rows),
        status: 'completed', preview: preview.summary, position_preview: preview.position, commit: result
      }
      await writeJson(statePath, state)
      console.log(JSON.stringify({ event: 'part_completed', index: part.index, total: parts.length, rows: Number(part.output_rows), commit: result }))
    } catch (error) {
      stopped = safeErrorCode(error)
      state.parts[part.index] = { source_file: basename(part.source_file), output_file: basename(part.output_file), output_rows: Number(part.output_rows), status: 'stopped', error_code: stopped }
      state.stop_reason = stopped
      await writeJson(statePath, state)
      break
    }
  }

  const sourceAfterFailures = await sourceHashGate(sourceManifest, 'after')
  state.source_hash_gate = { before: 'passed', after: sourceAfterFailures.length ? 'failed' : 'passed', failures: sourceAfterFailures }
  state.completed_parts = Object.values(state.parts).filter((part) => part.status === 'completed').length
  state.finished_at = new Date().toISOString()
  await writeJson(statePath, state)
  await writeJson(failurePath, state.failures)
  if (stopped || sourceAfterFailures.length) {
    console.log(JSON.stringify({ event: 'stopped', completed_parts: state.completed_parts, stop_code: stopped ?? 'source_fingerprint_mismatch' }))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify({ event: 'complete', completed_parts: state.completed_parts, failure_entries: state.failures.entries.length }))
}

main().catch(async (error) => {
  const code = safeErrorCode(error)
  console.log(JSON.stringify({ event: 'driver_error', code }))
  process.exitCode = 1
})
