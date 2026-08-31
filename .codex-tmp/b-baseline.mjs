import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'

const staging = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-111242755'
const databasePath = 'C:/Users/cboy/Documents/北森/data/recruitment.db'
const outputPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-b-pre-baseline-20260827.json'

async function hashFile(path) {
  const data = await readFile(path)
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex').toUpperCase() }
}

const sourceManifest = JSON.parse(await readFile(`${staging}/source-manifest.json`, 'utf8'))
const sourceChecks = []
for (const group of sourceManifest.source_groups ?? []) {
  if (group.label !== 'applicant_data') continue
  for (const file of group.files ?? []) {
    const path = `${group.root}/${file.filename}`
    const actual = await hashFile(path)
    sourceChecks.push({
      filename: file.filename,
      expected_bytes: Number(file.size_bytes),
      actual_bytes: actual.bytes,
      expected_sha256: String(file.sha256_before).toUpperCase(),
      actual_sha256: actual.sha256,
      matches: actual.bytes === Number(file.size_bytes) && actual.sha256 === String(file.sha256_before).toUpperCase()
    })
  }
}

const db = new DatabaseSync(databasePath, { readOnly: true })
const counts = {}
for (const table of ['candidates', 'candidate_positions', 'candidate_talent_pools', 'candidate_source_records', 'candidate_position_sources', 'candidate_assessments', 'candidate_consents', 'import_batches', 'candidate_import_tasks']) {
  counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
}
const hireCounts = {
  hire_status_nonempty: Number(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE TRIM(COALESCE(hire_status,'')) <> ''").get().n),
  hire_date_nonnull: Number(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE hire_date IS NOT NULL').get().n),
  hire_position_nonempty: Number(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE TRIM(COALESCE(hire_position,'')) <> ''").get().n)
}
const schemaVersions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version))
const activeTasks = db.prepare("SELECT task_type,id,status,phase,progress FROM candidate_import_tasks WHERE status IN ('queued','validating','parsing','mapping','previewing','committing','cancelling')").all()
const sourceRecent = db.prepare("SELECT COUNT(*) AS n FROM candidate_source_records WHERE source_system = 'beisen' AND created_at >= '2026-08-27T00:00:00Z'").get().n
db.close()

const result = {
  generated_at: new Date().toISOString(),
  group: 'applicant_data',
  counts,
  hire_counts: hireCounts,
  schema_versions: schemaVersions,
  active_tasks: activeTasks,
  beisen_source_records_since_day_start: Number(sourceRecent),
  source_checks: sourceChecks,
  source_hash_failures: sourceChecks.filter((item) => !item.matches).length,
  privacy: { candidate_level_rows_persisted: false, sensitive_fields_persisted: false, raw_payload_persisted: false }
}
await writeFile(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify(result, null, 2))
