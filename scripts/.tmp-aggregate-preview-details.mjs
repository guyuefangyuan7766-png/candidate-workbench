// Read-only aggregation of durable preview state. Never writes row-level data.
import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

const [staging, databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'] = process.argv.slice(2)
if (!staging) throw new Error('usage: node scripts/.tmp-aggregate-preview-details.mjs <staging> [db]')
const manifest = JSON.parse(await readFile(`${staging}/prepared-manifest.json`, 'utf8'))
const db = new DatabaseSync(databasePath, { readOnly: true })
const cutoff = manifest.generated_at

function partsFor(group) {
  return (manifest.source_groups?.[group] ?? []).flatMap((source) => (
    (source.sheets ?? []).flatMap((sheet) => (sheet.output_parts ?? []).map((part) => ({
      group,
      source_file: source.source_file,
      source_sheet: sheet.sheet_name,
      ...part
    })))
  ))
}

const parts = [...partsFor('talent_library'), ...partsFor('applicant_data')]
const errorCodes = {}
const groups = {
  talent_library: {
    rows: 0, raw_nonempty: 0, numeric_projection: 0, numeric_zero: 0,
    numeric_nonzero: 0, unknown_or_range: 0, range_values: 0, unknown_text: 0,
    work_year_error_rows: 0, status_only_rows: 0, date_only_rows: 0,
    both_nonempty_rows: 0, invalid_date_rows: 0, missing_id_rows: 0
  },
  applicant_data: {
    rows: 0, raw_nonempty: 0, numeric_projection: 0, numeric_zero: 0,
    numeric_nonzero: 0, unknown_or_range: 0, range_values: 0, unknown_text: 0,
    work_year_error_rows: 0, status_only_rows: 0, date_only_rows: 0,
    both_nonempty_rows: 0, invalid_date_rows: 0, missing_id_rows: 0
  }
}
const partResults = []

function isRange(raw) {
  return /(?:\d|[一二两三四五六七八九十])\s*(?:-|–|—|至|到)\s*(?:\d|[一二两三四五六七八九十])/.test(raw)
}

function getTask(part) {
  return db.prepare(`
    SELECT id, status, preview_path, result_json, error_json
    FROM candidate_import_tasks
    WHERE task_type = 'preview' AND file_name = ? AND file_size = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(part.output_file, Number(part.output_bytes ?? 0), cutoff)
}

for (const part of parts) {
  const group = groups[part.group]
  const task = getTask(part)
  if (!task || task.status !== 'preview_ready' || !task.preview_path) {
    partResults.push({ group: part.group, output_file: part.output_file, status: task?.status ?? 'missing' })
    continue
  }
  const persisted = JSON.parse(await readFile(task.preview_path, 'utf8'))
  const preview = persisted.preview ?? {}
  const rows = preview.rows ?? []
  const localErrors = {}
  let localRaw = 0
  let localNumeric = 0
  let localZero = 0
  let localNonzero = 0
  let localUnknown = 0
  let localRange = 0
  let localUnknownText = 0
  let localWorkErrors = 0
  let localStatusOnly = 0
  let localDateOnly = 0
  let localBoth = 0
  let localInvalidDate = 0
  let localMissingId = 0
  for (const row of rows) {
    group.rows += 1
    const candidate = row.candidate ?? {}
    const raw = String(candidate.years_experience_raw ?? '').trim()
    const numeric = candidate.years_experience
    if (raw) {
      localRaw += 1
      if (numeric != null && Number.isFinite(Number(numeric))) {
        localNumeric += 1
        if (Number(numeric) === 0) localZero += 1
        else localNonzero += 1
      } else {
        localUnknown += 1
        if (isRange(raw)) localRange += 1
        else localUnknownText += 1
      }
    }
    const errors = Array.isArray(row.errors) ? row.errors : []
    if (errors.some((error) => error?.field === 'years_experience' || error?.code === 'years_experience')) localWorkErrors += 1
    if (errors.some((error) => error?.code === 'invalid_date' || error?.field === 'hire_date')) localInvalidDate += 1
    if (errors.some((error) => error?.code === 'missing_candidate_id')) localMissingId += 1
    for (const error of errors) {
      const code = String(error?.code ?? error?.field ?? 'unknown').slice(0, 120)
      localErrors[code] = Number(localErrors[code] ?? 0) + 1
      errorCodes[code] = Number(errorCodes[code] ?? 0) + 1
    }
    const payload = row.raw_payload ?? {}
    const status = String(payload['入职状态'] ?? '').trim()
    const date = String(payload['入职日期'] ?? '').trim()
    if (status && date) localBoth += 1
    else if (status && !date) localStatusOnly += 1
    else if (!status && date) localDateOnly += 1
  }
  group.raw_nonempty += localRaw
  group.numeric_projection += localNumeric
  group.numeric_zero += localZero
  group.numeric_nonzero += localNonzero
  group.unknown_or_range += localUnknown
  group.range_values += localRange
  group.unknown_text += localUnknownText
  group.work_year_error_rows += localWorkErrors
  group.status_only_rows += localStatusOnly
  group.date_only_rows += localDateOnly
  group.both_nonempty_rows += localBoth
  group.invalid_date_rows += localInvalidDate
  group.missing_id_rows += localMissingId
  partResults.push({
    group: part.group,
    source_file: part.source_file,
    output_file: part.output_file,
    status: 'preview_ready',
    rows: rows.length,
    summary: preview.summary ?? {},
    work_year: {
      raw_nonempty: localRaw,
      numeric_projection: localNumeric,
      numeric_zero: localZero,
      numeric_nonzero: localNonzero,
      unknown_or_range: localUnknown,
      range_values: localRange,
      unknown_text: localUnknownText,
      work_year_error_rows: localWorkErrors
    },
    hire_filter: {
      status_only_rows: localStatusOnly,
      date_only_rows: localDateOnly,
      both_nonempty_rows: localBoth,
      invalid_date_rows: localInvalidDate
    },
    error_codes: localErrors
  })
  // Drop the large parsed object before opening the next durable preview.
}

const output = {
  recorded_at: new Date().toISOString(),
  groups,
  error_codes: errorCodes,
  preview_ready_parts: partResults.filter((item) => item.status === 'preview_ready').length,
  missing_or_failed_parts: partResults.filter((item) => item.status !== 'preview_ready').length,
  parts: partResults
}
await writeFile(`${staging}/preview-details-aggregate.json`, JSON.stringify(output, null, 2), 'utf8')
console.log(JSON.stringify({
  recorded_at: output.recorded_at,
  preview_ready_parts: output.preview_ready_parts,
  missing_or_failed_parts: output.missing_or_failed_parts,
  groups: output.groups,
  error_codes: output.error_codes
}))
