// Staging-only preview driver. It never calls an import commit endpoint and
// deliberately writes only aggregate, non-identifying metrics.
import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename } from 'node:path'

const [staging, baseUrl = 'http://127.0.0.1:4173', databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'] = process.argv.slice(2)
if (!staging) throw new Error('usage: node scripts/.tmp-preview-import.mjs <staging> [baseUrl]')

const manifest = JSON.parse(await readFile(`${staging}/prepared-manifest.json`, 'utf8'))
const groups = ['talent_library', 'applicant_data']
const taskDb = new DatabaseSync(databasePath, { readOnly: true })
const taskCutoff = manifest.generated_at

function flatten(group) {
  const files = manifest.source_groups?.[group] ?? []
  return files.flatMap((source) => (source.sheets ?? []).flatMap((sheet) => (
    sheet.output_parts ?? []
  ).map((part) => ({
    group,
    source_file: source.source_file,
    source_sheet: sheet.sheet_name,
    ...part
  }))))
}

const parts = groups.flatMap((group) => flatten(group))

async function jsonResponse(response) {
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { parse_error: true } }
  return { status: response.status, body }
}

async function fetchJson(url, options = {}, attempts = 6) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      return await jsonResponse(response)
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 1_000 * (attempt + 1))))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('fetch_failed')
}

function existingTask(part) {
  const row = taskDb.prepare(`
    SELECT id, status, phase, progress, preview_token, result_json, error_json
    FROM candidate_import_tasks
    WHERE task_type = 'preview'
      AND file_name = ?
      AND file_size = ?
      AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(part.output_file, Number(part.output_bytes ?? 0), taskCutoff)
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    progress: Number(row.progress ?? 0),
    terminal: ['preview_ready', 'failed', 'cancelled', 'timed_out'].includes(row.status),
    preview_token: row.preview_token,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null
  }
}

function safeError(error) {
  if (!error || typeof error !== 'object') return { code: 'unknown', count: 1 }
  const code = String(error.code ?? error.field ?? 'unknown').slice(0, 120)
  return { code, count: 1 }
}

function addErrorCounts(target, errors) {
  for (const error of errors ?? []) {
    const code = String(error?.code ?? error?.field ?? 'unknown').slice(0, 120)
    target[code] = Number(target[code] ?? 0) + 1
  }
}

function aggregatePreview(part, payload, elapsedMs) {
  if (!payload || typeof payload !== 'object') {
    return {
      group: part.group,
      source_file: part.source_file,
      output_file: part.output_file,
      status: 'invalid_response',
      elapsed_ms: elapsedMs
    }
  }
  const summary = payload.summary ?? payload.result?.summary ?? {}
  const position = payload.position_preview ?? payload.result?.position_preview ?? {}
  const rows = payload.rows ?? payload.result?.rows ?? []
  const errorCodes = {}
  for (const row of rows) addErrorCounts(errorCodes, row?.errors)
  const result = {
    group: part.group,
    source_file: part.source_file,
    source_sheet: part.source_sheet,
    output_file: part.output_file,
    output_rows: Number(part.output_rows ?? 0),
    output_bytes: Number(part.output_bytes ?? 0),
    status: 'preview_ready',
    elapsed_ms: elapsedMs,
    summary: Object.fromEntries(Object.entries(summary).filter(([, value]) => (
      typeof value === 'number' && Number.isFinite(value)
    )).map(([key, value]) => [key, Number(value)])),
    position_preview: {
      create_count: Number(position.create_count ?? 0),
      match_count: Number(position.match_count ?? 0),
      ambiguous_count: Number(position.ambiguous_count ?? 0),
      invalid_count: Number(position.invalid_count ?? 0),
      archived_conflict_count: Number(position.archived_conflict_count ?? 0),
      link_count: Number(position.link_count ?? 0)
    },
    preview_sample_rows: rows.length,
    preview_sample_error_codes: errorCodes
  }
  // Do not retain or print preview_token, rows, headers, mappings, or payloads.
  return result
}

async function waitForTask(taskId, label) {
  let lastPhase = ''
  for (let attempt = 0; attempt < 5400; attempt += 1) {
    const { status, body } = await fetchJson(`${baseUrl}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    if (status !== 200 || !body) throw new Error(`task_status_${status}`)
    const phase = `${body.status ?? ''}:${body.phase ?? ''}:${body.progress ?? 0}`
    if (phase !== lastPhase && (body.status !== 'parsing' || attempt % 5 === 0)) {
      console.log(JSON.stringify({ event: 'progress', label, status: body.status, phase: body.phase, progress: Number(body.progress ?? 0) }))
      lastPhase = phase
    }
    if (body.terminal) return body
    await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 500 : 2000))
  }
  throw new Error('task_poll_timeout')
}

async function previewPart(part, index) {
  const label = `${part.group}/${basename(part.output_file)}`
  const started = Date.now()
  const recovered = existingTask(part)
  if (recovered) {
    console.log(JSON.stringify({ event: 'task_recovered', index, total: parts.length, group: part.group, status: recovered.status }))
    const terminal = recovered.terminal ? recovered : await waitForTask(recovered.id, label)
    if (terminal.status !== 'preview_ready') {
      return {
        group: part.group,
        source_file: part.source_file,
        source_sheet: part.source_sheet,
        output_file: part.output_file,
        output_rows: Number(part.output_rows ?? 0),
        output_bytes: Number(part.output_bytes ?? 0),
        status: terminal.status ?? 'task_failed',
        http_status: Number(terminal.error?.status ?? 0),
        error_code: String(terminal.error?.code ?? 'task_failed').slice(0, 120),
        elapsed_ms: Date.now() - started
      }
    }
    return aggregatePreview(part, terminal.result ?? {}, Date.now() - started)
  }
  const bytes = await readFile(part.output_path)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'text/csv' }), part.output_file)
  // Force the durable async path for every part so large files cannot hold an
  // HTTP request open and all processing remains serialized by the service.
  let accepted
  try {
    accepted = await fetchJson(`${baseUrl}/api/candidates/import/tasks`, { method: 'POST', body: form })
  } catch (error) {
    // The upload may have been accepted even when the response connection was
    // lost. Recover the durable task before considering a retry.
    const task = existingTask(part)
    if (!task) throw error
    accepted = { status: 202, body: { task_id: task.id } }
  }
  let terminal
  if (accepted.status === 202 && accepted.body?.task_id) {
    terminal = await waitForTask(accepted.body.task_id, label)
  } else if (accepted.status >= 200 && accepted.status < 300) {
    terminal = { terminal: true, status: 'preview_ready', result: accepted.body }
  } else {
    const error = accepted.body?.error ?? accepted.body
    return {
      group: part.group,
      source_file: part.source_file,
      source_sheet: part.source_sheet,
      output_file: part.output_file,
      output_rows: Number(part.output_rows ?? 0),
      output_bytes: Number(part.output_bytes ?? 0),
      status: 'request_failed',
      http_status: accepted.status,
      error_code: String(error?.code ?? error?.error?.code ?? 'request_failed').slice(0, 120),
      elapsed_ms: Date.now() - started
    }
  }
  if (terminal.status !== 'preview_ready') {
    return {
      group: part.group,
      source_file: part.source_file,
      source_sheet: part.source_sheet,
      output_file: part.output_file,
      output_rows: Number(part.output_rows ?? 0),
      output_bytes: Number(part.output_bytes ?? 0),
      status: terminal.status ?? 'task_failed',
      http_status: Number(terminal.error?.status ?? 0),
      error_code: String(terminal.error?.code ?? 'task_failed').slice(0, 120),
      elapsed_ms: Date.now() - started
    }
  }
  const result = terminal.result ?? terminal
  const aggregate = aggregatePreview(part, result, Date.now() - started)
  console.log(JSON.stringify({
    event: 'part_complete',
    index,
    total: parts.length,
    group: part.group,
    output_rows: aggregate.output_rows,
    status: aggregate.status,
    valid_rows: aggregate.summary?.valid_rows ?? null,
    invalid_rows: aggregate.summary?.invalid_rows ?? null,
    candidate_records: aggregate.summary?.candidate_records ?? null
  }))
  return aggregate
}

const results = []
for (let index = 0; index < parts.length; index += 1) {
  const part = parts[index]
  try {
    results.push(await previewPart(part, index + 1))
  } catch (error) {
    results.push({
      group: part.group,
      source_file: part.source_file,
      source_sheet: part.source_sheet,
      output_file: part.output_file,
      output_rows: Number(part.output_rows ?? 0),
      output_bytes: Number(part.output_bytes ?? 0),
      status: 'driver_error',
      error_code: String(error?.message ?? 'driver_error').slice(0, 120)
    })
    console.log(JSON.stringify({ event: 'part_error', index: index + 1, total: parts.length, group: part.group, error_code: String(error?.message ?? 'driver_error').slice(0, 120) }))
  }
}

function sum(group, key) {
  return results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.summary?.[key] ?? 0), 0)
}

const aggregate = {
  recorded_at: new Date().toISOString(),
  base_url: baseUrl,
  groups: Object.fromEntries(groups.map((group) => [group, {
    parts: results.filter((item) => item.group === group).length,
    preview_ready_parts: results.filter((item) => item.group === group && item.status === 'preview_ready').length,
    failed_parts: results.filter((item) => item.group === group && item.status !== 'preview_ready').length,
    output_rows: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.output_rows ?? 0), 0),
    total_rows: sum(group, 'total_rows'),
    valid_rows: sum(group, 'valid_rows'),
    invalid_rows: sum(group, 'invalid_rows'),
    existing_duplicates: sum(group, 'existing_duplicates'),
    file_duplicates: sum(group, 'file_duplicates'),
    candidate_records: sum(group, 'candidate_records'),
    application_records: sum(group, 'application_records'),
    position_records: sum(group, 'position_records'),
    missing_identity_rows: sum(group, 'missing_identity_rows'),
    missing_candidate_id_rows: sum(group, 'missing_candidate_id_rows'),
    skipped_application_rows: sum(group, 'skipped_application_rows'),
    skipped_position_rows: sum(group, 'skipped_position_rows'),
    position_create_count: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.position_preview?.create_count ?? 0), 0),
    position_match_count: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.position_preview?.match_count ?? 0), 0),
    position_ambiguous_count: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.position_preview?.ambiguous_count ?? 0), 0),
    position_invalid_count: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.position_preview?.invalid_count ?? 0), 0),
    position_archived_conflict_count: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.position_preview?.archived_conflict_count ?? 0), 0),
    position_link_count: results.filter((item) => item.group === group).reduce((total, item) => total + Number(item.position_preview?.link_count ?? 0), 0)
  }])),
  parts: results
}

await writeFile(`${staging}/preview-aggregate.json`, JSON.stringify(aggregate, null, 2), 'utf8')
console.log(JSON.stringify({ event: 'complete', groups: aggregate.groups }))
