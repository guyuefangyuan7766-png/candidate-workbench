import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { readCandidateImportFile } from '../server/import-file.js'

const outputDir = 'C:/Users/cboy/Documents/北森/output'
const sourcePath = `${outputDir}/candidate-import-a-failed-rows-final-20260827.csv`
const combinedPath = `${outputDir}/candidate-import-all-current-failures-20260828.csv`
const missingIdentityPath = `${outputDir}/candidate-import-current-missing-identity-20260828.csv`
const summaryPath = `${outputDir}/candidate-import-all-current-failure-reasons-20260828.json`
const successFiles = [
  'birth-date-failures-corrected-20260828.csv',
  'candidate-import-contact-failures-ready-20260828.csv',
  'candidate-import-contact-values-ready-20260828.csv',
  'candidate-import-photo-age-failures-ready-20260828.csv'
]
const unresolvedFiles = [
  'candidate-import-contact-failures-unresolved-20260828.csv',
  'candidate-import-contact-values-unresolved-20260828.csv',
  'candidate-import-photo-age-formal-failures-20260828.csv'
]

function csvField(value) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function addIds(target, rows) {
  for (const row of rows) {
    const id = String(row.values?.['应聘者ID'] ?? row['应聘者ID'] ?? '').trim()
    if (id) target.add(id)
  }
}

const source = await readCandidateImportFile({ path: sourcePath, originalname: basename(sourcePath), mimetype: 'text/csv' })
const successIds = new Set()
for (const file of successFiles) {
  const parsed = await readCandidateImportFile({ path: `${outputDir}/${file}`, originalname: file, mimetype: 'text/csv' })
  addIds(successIds, parsed.rows)
}
const unresolvedIds = new Set()
for (const file of unresolvedFiles) {
  const parsed = await readCandidateImportFile({ path: `${outputDir}/${file}`, originalname: file, mimetype: 'text/csv' })
  addIds(unresolvedIds, parsed.rows)
}
for (const id of unresolvedIds) successIds.delete(id)

const rows = source.rows.filter((row) => !successIds.has(String(row.values?.['应聘者ID'] ?? '').trim()))
const ids = new Set(rows.map((row) => String(row.values?.['应聘者ID'] ?? '').trim()).filter(Boolean))
const missingIdentityRows = rows.filter((row) => String(row.values?.['失败原因'] ?? '').trim() === 'missing_identity')
const reasonCounts = {}
const exactReasonCounts = {}
for (const row of rows) {
  const exact = String(row.values?.['失败原因'] ?? '').trim() || 'unknown'
  exactReasonCounts[exact] = Number(exactReasonCounts[exact] ?? 0) + 1
  for (const reason of exact.split(';').map((value) => value.trim()).filter(Boolean)) {
    reasonCounts[reason] = Number(reasonCounts[reason] ?? 0) + 1
  }
}

const headers = source.headers
const lines = [headers.map(csvField).join(',')]
for (const row of rows) lines.push(headers.map((header) => csvField(row.values?.[header] ?? '')).join(','))
await mkdir(dirname(combinedPath), { recursive: true })
await writeFile(combinedPath, `\uFEFF${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
const missingLines = [headers.map(csvField).join(',')]
for (const row of missingIdentityRows) missingLines.push(headers.map((header) => csvField(row.values?.[header] ?? '')).join(','))
await writeFile(missingIdentityPath, `\uFEFF${missingLines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
const summary = {
  generated_at: new Date().toISOString(),
  source_failure_file: basename(sourcePath),
  source_a_failure_rows: source.rows.length,
  successful_fix_ids_removed: successIds.size,
  explicitly_unresolved_ids_preserved: unresolvedIds.size,
  current_failure_rows: rows.length,
  current_failure_unique_candidate_ids: ids.size,
  missing_identity_rows: missingIdentityRows.length,
  missing_identity_unique_candidate_ids: new Set(missingIdentityRows.map((row) => String(row.values?.['应聘者ID'] ?? '').trim()).filter(Boolean)).size,
  b_group_current_failure_rows: 0,
  current_failure_reason_counts: reasonCounts,
  current_failure_exact_reason_counts: exactReasonCounts,
  success_inputs: successFiles,
  unresolved_inputs: unresolvedFiles,
  combined_failure_table: basename(combinedPath),
  missing_identity_table: basename(missingIdentityPath),
  contains_complete_original_fields: true,
  preview_tokens_persisted: false
}
await writeFile(summaryPath, JSON.stringify(summary, null, 2), { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify({
  source_a_failure_rows: summary.source_a_failure_rows,
  successful_fix_ids_removed: summary.successful_fix_ids_removed,
  explicitly_unresolved_ids_preserved: summary.explicitly_unresolved_ids_preserved,
  current_failure_rows: summary.current_failure_rows,
  current_failure_unique_candidate_ids: summary.current_failure_unique_candidate_ids,
  b_group_current_failure_rows: 0,
  current_failure_reason_counts: summary.current_failure_reason_counts,
  combined_failure_table: summary.combined_failure_table,
  missing_identity_table: summary.missing_identity_table,
  summary_file: basename(summaryPath)
}))
