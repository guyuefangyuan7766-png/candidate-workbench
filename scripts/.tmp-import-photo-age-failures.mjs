// One-shot formal import for the corrected photo/age failure subset.
// Preview tokens stay in memory; persisted outputs contain aggregate evidence
// and a user-requested full-field table only for rows that still fail.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readCandidateImportFile } from '../server/import-file.js'

const baseUrl = 'http://127.0.0.1:4174'
const databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'
const inputPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-photo-age-failures-ready-20260828.csv'
const evidencePath = 'C:/Users/cboy/Documents/北森/docs/evidence/beisen-photo-age-correction-import-20260828.json'
const failureCsvPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-photo-age-formal-failures-ready-20260828.csv'
const failureSummaryPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-photo-age-formal-failure-reasons-ready-20260828.json'
const expectedSha256 = '35a7b5ccf8aaE56DBDC16E81BA39D63AC4E3EE8D61AF7942E64CABB68DB8954B'.toLowerCase()
const expectedRows = 46
const terminalStatuses = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function safeCode(value, fallback = 'unknown') {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : fallback
}

function csvField(value) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function errorCodes(errors) {
  return [...new Set((Array.isArray(errors) ? errors : []).map((error) => (
    safeCode(error?.code ?? error?.field, 'unknown')
  )))].sort()
}

async function requestJson(url, options = {}, attempts = 4) {
  let lastError
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
      if (attempt + 1 < attempts) await sleep(Math.min(10_000, 1_000 * (attempt + 1)))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('request_failed')
}

async function waitTask(taskId, kind) {
  let lastMarker = ''
  for (let attempt = 0; attempt < 5400; attempt += 1) {
    const response = await requestJson(`${baseUrl}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    if (response.status !== 200 || !response.body) {
      if (attempt < 30) { await sleep(1_000); continue }
      throw Object.assign(new Error('task_status_unavailable'), { code: `task_status_${response.status}` })
    }
    const task = response.body
    const marker = `${task.status}:${task.phase}:${task.progress}`
    if (marker !== lastMarker) {
      console.log(JSON.stringify({ event: 'progress', kind, status: safeCode(task.status), phase: safeCode(task.phase), progress: Number(task.progress ?? 0) }))
      lastMarker = marker
    }
    if (terminalStatuses.has(task.status)) return task
    await sleep(attempt < 5 ? 500 : 2_000)
  }
  throw Object.assign(new Error('task_poll_timeout'), { code: `${kind}_poll_timeout` })
}

function readGateState() {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const checkpoint = db.prepare(`
      SELECT status, queued_rows, processed_rows, document_count, error_code
      FROM search_index_checkpoints_v2 WHERE scope = 'full'
    `).get()
    const dirtyRows = Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get()?.count ?? 0)
    return { checkpoint, dirty_rows: dirtyRows }
  } finally { db.close() }
}

function taskPreviewPath(taskId) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return db.prepare('SELECT preview_path FROM candidate_import_tasks WHERE id = ?').get(taskId)?.preview_path ?? null
  } finally { db.close() }
}

async function waitForSearchReady() {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const state = readGateState()
    if (state.checkpoint?.status === 'failed') {
      throw Object.assign(new Error('search_index_failed'), { code: state.checkpoint.error_code ?? 'search_index_failed' })
    }
    if (state.checkpoint?.status === 'ready' && state.dirty_rows === 0) return state
    if (attempt % 10 === 0) {
      console.log(JSON.stringify({ event: 'search_index_wait', status: safeCode(state.checkpoint?.status), dirty_rows: state.dirty_rows }))
    }
    await sleep(5_000)
  }
  throw Object.assign(new Error('search_index_wait_timeout'), { code: 'search_index_wait_timeout' })
}

async function writeFailures(parsed, failures, phase) {
  const byRow = new Map((parsed.rows ?? []).map((row) => [Number(row.row_number), row.values ?? {}]))
  const headers = parsed.headers ?? []
  const metadata = ['CSV行号', '失败阶段', '失败原因']
  const lines = [[...metadata, ...headers].map(csvField).join(',')]
  const reasonCounts = {}
  for (const failure of failures.sort((a, b) => Number(a.row_number) - Number(b.row_number))) {
    const rowNumber = Number(failure.row_number)
    const codes = errorCodes(failure.errors)
    for (const code of codes) reasonCounts[code] = Number(reasonCounts[code] ?? 0) + 1
    const values = byRow.get(rowNumber) ?? {}
    lines.push([rowNumber, phase, codes.join(';'), ...headers.map((header) => values[header] ?? '')].map(csvField).join(','))
  }
  await mkdir(dirname(failureCsvPath), { recursive: true })
  await writeFile(failureCsvPath, `\uFEFF${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
  await writeFile(failureSummaryPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    source_file: basename(inputPath),
    formal_failure_rows: failures.length,
    reason_counts: reasonCounts,
    failure_table: basename(failureCsvPath),
    contains_complete_original_fields: true,
    preview_tokens_persisted: false
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return reasonCounts
}

function verifyCandidates(sourceIds) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const found = []
    for (let offset = 0; offset < sourceIds.length; offset += 500) {
      const ids = sourceIds.slice(offset, offset + 500)
      const placeholders = ids.map(() => '?').join(',')
      found.push(...db.prepare(`
        SELECT source_record_id, photo_url, age
        FROM candidates
        WHERE source_system = 'beisen' AND source_record_id IN (${placeholders})
      `).all(...ids))
    }
    return {
      expected_candidates: sourceIds.length,
      found_candidates: found.length,
      missing_candidates: sourceIds.length - found.length,
      gif_photo_values: found.filter((row) => /\.gif(?:$|[?#])/i.test(String(row.photo_url ?? ''))).length,
      out_of_range_age_values: found.filter((row) => row.age != null && (!Number.isInteger(Number(row.age)) || Number(row.age) < 0 || Number(row.age) > 120)).length,
      blank_photo_values: found.filter((row) => !String(row.photo_url ?? '').trim()).length,
      null_age_values: found.filter((row) => row.age == null).length
    }
  } finally { db.close() }
}

async function main() {
  const fileInfo = await stat(inputPath)
  const bytes = await readFile(inputPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== expectedSha256 || fileInfo.size !== bytes.length) {
    throw Object.assign(new Error('input_fingerprint_mismatch'), { code: 'input_fingerprint_mismatch' })
  }

  const parsed = await readCandidateImportFile({
    path: inputPath,
    originalname: basename(inputPath),
    mimetype: 'text/csv',
    size: fileInfo.size
  })
  if (parsed.rows.length !== expectedRows || !parsed.headers.includes('应聘者ID')) {
    throw Object.assign(new Error('input_structure_mismatch'), { code: 'input_structure_mismatch' })
  }
  const sourceIds = parsed.rows.map((row) => String(row.values?.['应聘者ID'] ?? '').trim())
  if (sourceIds.some((value) => !value) || new Set(sourceIds).size !== expectedRows) {
    throw Object.assign(new Error('candidate_id_gate_failed'), { code: 'candidate_id_gate_failed' })
  }

  const health = await requestJson(`${baseUrl}/api/health`)
  const config = await requestJson(`${baseUrl}/api/candidates/import/config`)
  if (health.status !== 200 || health.body?.status !== 'ok') throw Object.assign(new Error('health_gate_failed'), { code: 'health_gate_failed' })
  if (config.status !== 200 || Number(config.body?.max_file_size_bytes ?? 0) < fileInfo.size) {
    throw Object.assign(new Error('import_config_gate_failed'), { code: 'import_config_gate_failed' })
  }
  const beforeGate = readGateState()
  if (beforeGate.checkpoint?.status !== 'ready' || beforeGate.dirty_rows !== 0) {
    throw Object.assign(new Error('database_busy'), { code: 'database_busy' })
  }

  const runId = randomUUID()
  const previewKey = `photo-age:${runId}:preview:${sha256.slice(0, 24)}`
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'text/csv' }), basename(inputPath))
  const accepted = await requestJson(`${baseUrl}/api/candidates/import/preview`, {
    method: 'POST',
    headers: { 'Idempotency-Key': previewKey, Prefer: 'respond-async' },
    body: form
  })
  if (accepted.status !== 202 || !accepted.body?.task_id) {
    const code = safeCode(accepted.body?.error?.code, `preview_http_${accepted.status}`)
    throw Object.assign(new Error(code), { code })
  }
  const previewTask = await waitTask(accepted.body.task_id, 'preview')
  if (previewTask.status !== 'preview_ready') {
    const code = safeCode(previewTask.error?.code, `preview_${previewTask.status}`)
    throw Object.assign(new Error(code), { code })
  }

  const previewPath = taskPreviewPath(previewTask.task_id)
  const persisted = previewPath ? JSON.parse(await readFile(previewPath, 'utf8')) : null
  const preview = persisted?.preview
  const summary = previewTask.result?.summary ?? preview?.summary ?? {}
  const previewFailures = (preview?.rows ?? []).filter((row) => Array.isArray(row.errors) && row.errors.length > 0)
  if (!preview || preview.rows?.length !== expectedRows) {
    throw Object.assign(new Error('preview_payload_gate_failed'), { code: 'preview_payload_gate_failed' })
  }
  await writeFailures(parsed, previewFailures.map((row) => ({ row_number: row.row_number, errors: row.errors })), 'preview')
  const previewGatePassed = previewTask.result?.profile === 'beisen_talent' &&
    Number(summary.total_rows) === expectedRows && Number(summary.valid_rows) === expectedRows &&
    Number(summary.invalid_rows) === 0 && Number(summary.missing_candidate_id_rows ?? 0) === 0 &&
    previewFailures.length === 0
  if (!previewGatePassed) {
    throw Object.assign(new Error('preview_validation_gate_failed'), { code: 'preview_validation_gate_failed' })
  }

  const commitKey = `photo-age:${runId}:commit:${sha256.slice(0, 24)}`
  const commitAccepted = await requestJson(`${baseUrl}/api/candidates/import/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': commitKey, Prefer: 'respond-async' },
    body: JSON.stringify({ preview_token: previewTask.preview_token, on_duplicate: 'update', async: true })
  })
  if (![200, 202].includes(commitAccepted.status) || !commitAccepted.body?.task_id) {
    const code = safeCode(commitAccepted.body?.error?.code, `commit_http_${commitAccepted.status}`)
    throw Object.assign(new Error(code), { code })
  }
  const commitTask = terminalStatuses.has(commitAccepted.body.status)
    ? commitAccepted.body
    : await waitTask(commitAccepted.body.task_id, 'commit')
  if (commitTask.status !== 'completed') {
    const code = safeCode(commitTask.error?.code, `commit_${commitTask.status}`)
    throw Object.assign(new Error(code), { code })
  }
  const result = commitTask.result ?? {}
  const commitFailures = Array.isArray(result.failures) ? result.failures : []
  const reasonCounts = await writeFailures(parsed, commitFailures, 'commit')
  const accounted = Number(result.imported_rows ?? 0) + Number(result.updated_rows ?? 0) + Number(result.skipped_rows ?? 0) + Number(result.failed_rows ?? 0)
  if (accounted !== expectedRows || Number(result.failed_rows ?? 0) !== commitFailures.length) {
    throw Object.assign(new Error('commit_accounting_gate_failed'), { code: 'commit_accounting_gate_failed' })
  }

  const searchIndexAfter = await waitForSearchReady()
  const candidateVerification = verifyCandidates(sourceIds)
  if (candidateVerification.missing_candidates !== 0 || candidateVerification.gif_photo_values !== 0 || candidateVerification.out_of_range_age_values !== 0) {
    throw Object.assign(new Error('post_import_verification_failed'), { code: 'post_import_verification_failed' })
  }
  const finalHealth = await requestJson(`${baseUrl}/api/health`)
  if (finalHealth.status !== 200 || finalHealth.body?.status !== 'ok') {
    throw Object.assign(new Error('final_health_gate_failed'), { code: 'final_health_gate_failed' })
  }

  const evidence = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    operation: 'beisen_photo_age_failure_correction_import',
    service: { base_url: baseUrl, health_before: 'ok', health_after: 'ok' },
    source: { file: basename(inputPath), bytes: fileInfo.size, sha256, rows: expectedRows, columns: parsed.headers.length },
    corrections: {
      incompatible_gif_photo_values_cleared_in_original_failure_set: 47,
      out_of_range_age_values_cleared_in_original_failure_set: 4,
      excluded_missing_identity_rows: 5
    },
    preview: {
      profile: previewTask.result?.profile,
      total_rows: Number(summary.total_rows),
      valid_rows: Number(summary.valid_rows),
      invalid_rows: Number(summary.invalid_rows),
      missing_candidate_id_rows: Number(summary.missing_candidate_id_rows ?? 0),
      preview_tokens_persisted: false
    },
    commit: {
      imported_rows: Number(result.imported_rows ?? 0),
      updated_rows: Number(result.updated_rows ?? 0),
      skipped_rows: Number(result.skipped_rows ?? 0),
      failed_rows: Number(result.failed_rows ?? 0),
      candidate_count: Number(result.candidate_count ?? 0),
      failure_reason_counts: reasonCounts
    },
    verification: {
      ...candidateVerification,
      search_index_status: searchIndexAfter.checkpoint?.status,
      search_index_dirty_rows: searchIndexAfter.dirty_rows
    },
    privacy: {
      candidate_level_rows_persisted_in_evidence: false,
      preview_tokens_persisted: false,
      user_requested_failure_table_contains_complete_fields: true
    },
    failure_table: basename(failureCsvPath),
    excluded_failure_table: 'candidate-import-photo-age-formal-failures-20260828.csv',
    rollback: 'No per-batch rollback API exists; database restore requires separate explicit approval.'
  }
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { encoding: 'utf8', mode: 0o600 })
  console.log(JSON.stringify({ event: 'complete', preview: evidence.preview, commit: evidence.commit, verification: evidence.verification }))
}

main().catch((error) => {
  console.log(JSON.stringify({ event: 'stopped', code: safeCode(error?.code ?? error?.message, 'driver_error') }))
  process.exitCode = 1
})
