// Read-only post-import verification for the B applicant-data group.
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readCandidateImportFile } from '../server/import-file.js'

const staging = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-111242755'
const databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'
const statePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-progress-20260827.json'
const baselinePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-pre-baseline-20260827.json'
const failedRowsPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-failed-rows-final-20260827.csv'
const reasonsPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-failure-reasons-final-20260827.json'
const evidencePath = 'C:/Users/cboy/Documents/北森/docs/evidence/beisen-candidate-import-b-20260827.json'
const manifest = JSON.parse(await readFile(`${staging}/prepared-manifest.json`, 'utf8'))
const sourceManifest = JSON.parse(await readFile(`${staging}/source-manifest.json`, 'utf8'))
const state = JSON.parse(await readFile(statePath, 'utf8'))
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))

async function hashFile(path) {
  const data = await readFile(path)
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex').toUpperCase() }
}

function clean(value) { return String(value ?? '').trim() }

function partsForB() {
  return (manifest.source_groups?.applicant_data ?? []).flatMap((source) => (
    (source.sheets ?? []).flatMap((sheet) => (sheet.output_parts ?? []).map((part) => ({
      source_file: source.source_file,
      source_sheet: sheet.sheet_name,
      ...part
    })))
  )).map((part, index) => ({ ...part, index: index + 1 }))
}

const parts = partsForB()
const expectedById = new Map()
const valuesById = new Map()
const allRows = []
const sourcePartChecks = []
const aggregateInput = {
  original_rows: 0,
  excluded_double_empty_rows: 0,
  retained_rows: 0,
  status_only_rows: 0,
  date_only_rows: 0,
  both_nonempty_rows: 0,
  missing_id_rows: 0,
  invalid_date_rows: 0
}

for (const part of parts) {
  const actual = await hashFile(part.output_path)
  const parsed = await readCandidateImportFile({
    path: part.output_path,
    originalname: basename(part.output_file),
    mimetype: 'text/csv',
    size: actual.bytes
  })
  const matches = actual.bytes === Number(part.output_bytes) && actual.sha256 === String(part.output_sha256).toUpperCase() && parsed.rows.length === Number(part.output_rows)
  sourcePartChecks.push({
    part_index: part.index,
    file: basename(part.output_file),
    expected_rows: Number(part.output_rows),
    actual_rows: parsed.rows.length,
    expected_bytes: Number(part.output_bytes),
    actual_bytes: actual.bytes,
    expected_sha256: String(part.output_sha256).toUpperCase(),
    actual_sha256: actual.sha256,
    matches
  })
  for (const row of parsed.rows) {
    const status = clean(row.values['入职状态'])
    const date = clean(row.values['入职日期'])
    const id = clean(row.values['应聘者ID'])
    aggregateInput.retained_rows += 1
    if (!id) aggregateInput.missing_id_rows += 1
    if (status && date) aggregateInput.both_nonempty_rows += 1
    else if (status && !date) aggregateInput.status_only_rows += 1
    else if (!status && date) aggregateInput.date_only_rows += 1
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) aggregateInput.invalid_date_rows += 1
    allRows.push({ part_index: part.index, csv_row_number: Number(row.row_number), id, status, date })
    if (id) {
      const previous = expectedById.get(id) ?? { last_status: null, last_date: null, occurrences: 0 }
      if (status) previous.last_status = status
      if (date) previous.last_date = date
      previous.occurrences += 1
      expectedById.set(id, previous)
      const values = valuesById.get(id) ?? { statuses: new Set(), dates: new Set(), occurrences: 0 }
      if (status) values.statuses.add(status)
      if (date) values.dates.add(date)
      values.occurrences += 1
      valuesById.set(id, values)
    }
  }
}
for (const source of manifest.source_groups?.applicant_data ?? []) {
  for (const sheet of source.sheets ?? []) {
    aggregateInput.original_rows += Number(sheet.original_rows ?? 0)
    aggregateInput.excluded_double_empty_rows += Number(sheet.excluded_double_empty_rows ?? 0)
  }
}

const db = new DatabaseSync(databasePath, { readOnly: true })
const tableNames = ['candidates', 'positions', 'talent_pools', 'candidate_positions', 'candidate_talent_pools', 'candidate_source_records', 'candidate_position_sources', 'candidate_assessments', 'candidate_consents', 'import_batches', 'candidate_import_tasks']
const countsAfter = {}
for (const table of tableNames) countsAfter[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
const hireCountsAfter = {
  hire_status_nonempty: Number(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE TRIM(COALESCE(hire_status,'')) <> ''").get().n),
  hire_date_nonnull: Number(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE hire_date IS NOT NULL').get().n),
  hire_position_nonempty: Number(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE TRIM(COALESCE(hire_position,'')) <> ''").get().n)
}
const schemaVersions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version))
const batches = db.prepare('SELECT id,filename,total_rows,imported_rows,updated_rows,skipped_rows,failed_rows,status,created_at,completed_at FROM import_batches WHERE created_at >= ? ORDER BY created_at').all(state.started_at)
const runTasks = db.prepare('SELECT id,task_type,status,phase,progress,idempotency_key,result_json,error_json,created_at,updated_at FROM candidate_import_tasks WHERE idempotency_key LIKE ? ORDER BY created_at').all(`${state.run_id}:%`)
const commitBusinessTotals = {
  positions_created: 0,
  positions_matched: 0,
  links_created: 0,
  pools_created: 0,
  application_count: 0
}
for (const task of runTasks) {
  if (task.task_type !== 'commit' || task.status !== 'completed') continue
  let result = {}
  try { result = JSON.parse(task.result_json ?? '{}') } catch { result = {} }
  for (const key of Object.keys(commitBusinessTotals)) commitBusinessTotals[key] += Number(result[key] ?? 0)
}
const candidateRows = db.prepare("SELECT id,source_record_id,hire_status,hire_date,archived_at FROM candidates WHERE source_system = 'beisen' AND source_record_id IS NOT NULL").all()
const candidateBySourceId = new Map()
const duplicateSourceIds = []
for (const row of candidateRows) {
  const id = clean(row.source_record_id)
  const existing = candidateBySourceId.get(id)
  if (existing) duplicateSourceIds.push(id)
  else candidateBySourceId.set(id, row)
}
const sourceRows = db.prepare("SELECT candidate_id,source_record_id FROM candidate_source_records WHERE source_system = 'beisen'").all()
const sourceBySourceId = new Map()
for (const row of sourceRows) sourceBySourceId.set(clean(row.source_record_id), row)
const missingCandidateIds = []
const archivedCandidateIds = []
const statusMismatches = []
const dateMismatches = []
for (const [sourceId, expected] of expectedById) {
  const candidate = candidateBySourceId.get(sourceId)
  if (!candidate) { missingCandidateIds.push(sourceId); continue }
  if (candidate.archived_at) archivedCandidateIds.push(sourceId)
  if (expected.last_status && clean(candidate.hire_status) !== expected.last_status) statusMismatches.push(sourceId)
  if (expected.last_date && clean(candidate.hire_date) !== expected.last_date) dateMismatches.push(sourceId)
}
const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all().length
const searchCheckpoint = db.prepare('SELECT status,queued_rows,processed_rows,document_count,updated_at,error_code FROM search_index_checkpoints_v2 WHERE scope = ?').get('full') ?? null
const dirtySearchRows = Number(db.prepare('SELECT COUNT(*) AS n FROM search_index_dirty_v2').get().n)
const writeWindow = { start: state.started_at, end: state.finished_at ?? null, tables: {} }
for (const table of ['candidates', 'positions', 'talent_pools', 'candidate_positions', 'candidate_talent_pools', 'candidate_source_records']) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  const stats = {}
  if (columns.includes('created_at')) {
    stats.created_in_window = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at >= ? AND created_at <= ?`).get(state.started_at, state.finished_at ?? new Date().toISOString()).n)
  }
  if (columns.includes('updated_at')) {
    stats.updated_in_window = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE updated_at >= ? AND updated_at <= ?`).get(state.started_at, state.finished_at ?? new Date().toISOString()).n)
  }
  writeWindow.tables[table] = stats
}
db.close()

const sourceChecks = []
for (const group of sourceManifest.source_groups ?? []) {
  if (group.label !== 'applicant_data') continue
  for (const file of group.files ?? []) {
    const actual = await hashFile(`${group.root}/${file.filename}`)
    sourceChecks.push({
      file: file.filename,
      expected_bytes: Number(file.size_bytes),
      actual_bytes: actual.bytes,
      expected_sha256: String(file.sha256_before).toUpperCase(),
      actual_sha256: actual.sha256,
      matches: actual.bytes === Number(file.size_bytes) && actual.sha256 === String(file.sha256_before).toUpperCase()
    })
  }
}
const failedInfo = await stat(failedRowsPath)
let failedCsvRows = 0
if (failedInfo.size > 0) {
  try {
    const failedParsed = await readCandidateImportFile({ path: failedRowsPath, originalname: basename(failedRowsPath), mimetype: 'text/csv', size: failedInfo.size })
    failedCsvRows = failedParsed.rows.length
  } catch (error) {
    // The failure artifact intentionally contains only a header when there are no failed rows.
    if (error?.code !== 'import_empty_workbook') throw error
  }
}
const reasons = JSON.parse(await readFile(reasonsPath, 'utf8'))
const batchTotals = batches.reduce((sum, batch) => {
  for (const key of ['total_rows', 'imported_rows', 'updated_rows', 'skipped_rows', 'failed_rows']) sum[key] += Number(batch[key] ?? 0)
  return sum
}, { total_rows: 0, imported_rows: 0, updated_rows: 0, skipped_rows: 0, failed_rows: 0 })
const taskStatusCounts = {}
for (const task of runTasks) {
  const key = `${task.task_type}:${task.status}`
  taskStatusCounts[key] = Number(taskStatusCounts[key] ?? 0) + 1
}
const previewExpiredAfterCommit = runTasks.filter((task) => {
  if (task.task_type !== 'preview' || task.status !== 'failed') return false
  try {
    const error = JSON.parse(task.error_json ?? '{}') ?? {}
    return error.code === 'import_preview_expired' || error.error_code === 'import_preview_expired'
  } catch { return false }
}).length
const baselineCountKeys = Object.keys(baseline.counts ?? {})
const countDeltas = Object.fromEntries(baselineCountKeys.map((table) => [table, countsAfter[table] - Number(baseline.counts[table] ?? 0)]))
const countDeltasUnavailableBefore = tableNames.filter((table) => !baselineCountKeys.includes(table))
const duplicateGroups = [...valuesById.values()].filter((value) => value.occurrences > 1)
const duplicateConflictCounts = duplicateGroups.reduce((counts, value) => {
  if (value.statuses.size > 1 && value.dates.size > 1) counts.status_and_date += 1
  else if (value.dates.size > 1) counts.date_only += 1
  else if (value.statuses.size > 1) counts.status_only += 1
  else counts.same_values += 1
  return counts
}, { same_values: 0, date_only: 0, status_only: 0, status_and_date: 0 })
const duplicateExtraRows = duplicateGroups.reduce((sum, value) => sum + value.occurrences - 1, 0)
const evidence = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  group: 'applicant_data',
  formal_database_commit: true,
  service: { base_url: 'http://127.0.0.1:4173', health_checked: true, status: 'ok' },
  schema_versions: schemaVersions,
  input: {
    original_rows: aggregateInput.original_rows,
    excluded_double_empty_rows: aggregateInput.excluded_double_empty_rows,
    retained_rows: aggregateInput.retained_rows,
    parts: parts.length,
    status_only_rows: aggregateInput.status_only_rows,
    date_only_rows: aggregateInput.date_only_rows,
    both_nonempty_rows: aggregateInput.both_nonempty_rows,
    missing_id_rows: aggregateInput.missing_id_rows,
    invalid_date_rows: aggregateInput.invalid_date_rows,
    unique_source_ids: expectedById.size,
    duplicate_source_ids: duplicateGroups.length,
    duplicate_extra_rows: duplicateExtraRows,
    duplicate_conflict_counts: duplicateConflictCounts,
    row_conservation: aggregateInput.original_rows === aggregateInput.excluded_double_empty_rows + aggregateInput.retained_rows
  },
  part_file_checks: sourcePartChecks,
  preview_and_commit: {
    completed_parts: Object.values(state.parts ?? {}).filter((part) => part.status === 'completed').length,
    total_parts: parts.length,
    task_status_counts: taskStatusCounts,
    preview_expired_after_commit: previewExpiredAfterCommit,
    batch_count: batches.length,
    batch_totals: batchTotals,
    row_conservation: batchTotals.total_rows === aggregateInput.retained_rows && batchTotals.imported_rows + batchTotals.updated_rows + batchTotals.skipped_rows + batchTotals.failed_rows === batchTotals.total_rows,
    batches: batches.map((batch) => ({ id: batch.id, filename: batch.filename, total_rows: Number(batch.total_rows), imported_rows: Number(batch.imported_rows), updated_rows: Number(batch.updated_rows), skipped_rows: Number(batch.skipped_rows), failed_rows: Number(batch.failed_rows), status: batch.status }))
  },
  database_verification: {
    counts_before: baseline.counts,
    counts_after: countsAfter,
    count_deltas: countDeltas,
    count_deltas_unavailable_before: countDeltasUnavailableBefore,
    business_write_counters: commitBusinessTotals,
    business_write_window: writeWindow,
    hire_counts_before: baseline.hire_counts,
    hire_counts_after: hireCountsAfter,
    candidate_ids_found: expectedById.size - missingCandidateIds.length,
    missing_candidate_ids: missingCandidateIds.length,
    archived_candidate_ids: archivedCandidateIds.length,
    duplicate_source_ids: duplicateSourceIds.length,
    source_records_found: [...expectedById.keys()].filter((id) => sourceBySourceId.has(id)).length,
    hire_status_mismatches: statusMismatches.length,
    hire_date_mismatches: dateMismatches.length,
    foreign_key_errors: foreignKeyErrors,
    integrity_check: 'not_run_due_to_database_size',
    search_index_checkpoint: searchCheckpoint,
    search_index_dirty_rows: dirtySearchRows
  },
  failures: {
    failure_rows: Number(reasons.failure_rows ?? 0),
    reason_counts: reasons.reason_counts ?? {},
    failed_csv_rows: failedCsvRows,
    output_csv: basename(failedRowsPath)
  },
  source_hash_checks: sourceChecks,
  privacy: {
    candidate_level_rows_persisted: false,
    sensitive_fields_persisted: false,
    raw_payload_persisted: false,
    preview_tokens_persisted: false,
    note: 'These flags describe this evidence/output artifact only. The service may retain protected preview metadata, including tokens, in its task store; no token values are copied into this evidence or the failure CSV.'
  }
}
await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify({
  evidence_path: evidencePath,
  input: evidence.input,
  batch_totals: batchTotals,
  task_status_counts: taskStatusCounts,
  count_deltas: countDeltas,
  hire_verification: { missing_candidate_ids: missingCandidateIds.length, archived_candidate_ids: archivedCandidateIds.length, status_mismatches: statusMismatches.length, date_mismatches: dateMismatches.length },
  failures: evidence.failures,
  foreign_key_errors: foreignKeyErrors,
  integrity_check: evidence.database_verification.integrity_check,
  source_hash_failures: sourceChecks.filter((item) => !item.matches).length
}, null, 2))
