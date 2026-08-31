import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { readCandidateImportFile } from '../server/import-file.js'

const staging = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-111242755'
const databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'
const progressPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-progress-20260826.json'
const reasonsPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-failure-reasons-final-20260827.json'
const finalFailedPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-failed-rows-final-20260827.csv'
const finalIssuePath = 'C:/Users/cboy/Documents/北森/output/candidate-import-a-issue-rows-final-20260827.csv'

async function hashFile(path) {
  const hash = createHash('sha256')
  const stream = (await import('node:fs')).createReadStream(path)
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}

const manifest = JSON.parse(await readFile(`${staging}/source-manifest.json`, 'utf8'))
const sourceChecks = []
for (const group of manifest.source_groups) {
  for (const file of group.files) {
    const path = `${group.root}/${file.filename}`
    const info = await stat(path)
    const hash = await hashFile(path)
    sourceChecks.push(info.size === Number(file.size_bytes) && hash === String(file.sha256_before).toUpperCase())
  }
}

const progress = JSON.parse(await readFile(progressPath, 'utf8'))
const partEntries = Object.values(progress.parts)
const totals = partEntries.reduce((sum, part) => {
  sum.rows += Number(part.output_rows)
  sum.imported += Number(part.commit?.imported_rows ?? 0)
  sum.updated += Number(part.commit?.updated_rows ?? 0)
  sum.skipped += Number(part.commit?.skipped_rows ?? 0)
  sum.failed += Number(part.commit?.failed_rows ?? 0)
  return sum
}, { rows: 0, imported: 0, updated: 0, skipped: 0, failed: 0 })

const failedInfo = await stat(finalFailedPath)
const issueInfo = await stat(finalIssuePath)
const failedParsed = await readCandidateImportFile({ path: finalFailedPath, originalname: 'failed.csv', mimetype: 'text/csv', size: failedInfo.size })
const issueParsed = await readCandidateImportFile({ path: finalIssuePath, originalname: 'issue.csv', mimetype: 'text/csv', size: issueInfo.size })
const db = new DatabaseSync(databasePath, { readOnly: true })
const task = db.prepare(`SELECT id,status,phase,progress,result_json,error_json FROM candidate_import_tasks WHERE id = 'cb751c15-5292-4aab-ae6f-60a0e0635dd0'`).get()
const batch = db.prepare(`SELECT id,total_rows,imported_rows,updated_rows,skipped_rows,failed_rows,status FROM import_batches WHERE id = 'cb751c15-5292-4aab-ae6f-60a0e0635dd0'`).get()
const counts = {}
for (const table of ['candidates', 'positions', 'candidate_positions', 'candidate_talent_pools', 'candidate_source_records', 'candidate_position_sources', 'candidate_assessments', 'candidate_consents', 'import_batches']) {
  counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}
const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length
const schema = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version)
db.close()

const result = task?.result_json ? JSON.parse(task.result_json) : null
const reasons = JSON.parse(await readFile(reasonsPath, 'utf8'))
console.log(JSON.stringify({
  source_files: sourceChecks.length,
  source_hash_failures: sourceChecks.filter((value) => !value).length,
  progress_completed_parts: progress.completed_parts,
  part_statuses: partEntries.map((part) => part.status),
  totals,
  totals_accounted: totals.imported + totals.updated + totals.skipped + totals.failed,
  final_failed_csv_rows: failedParsed.rows.length,
  final_issue_csv_rows: issueParsed.rows.length,
  reason_rows: reasons.failed_rows_indexed,
  task: { status: task?.status, phase: task?.phase, progress: task?.progress, result: result ? { imported_rows: result.imported_rows, updated_rows: result.updated_rows, skipped_rows: result.skipped_rows, failed_rows: result.failed_rows } : null },
  batch,
  counts,
  foreign_key_errors: foreignKeys,
  schema_versions: schema
}, null, 2))
