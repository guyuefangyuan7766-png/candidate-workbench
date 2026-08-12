import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

function argumentValue(name) {
  const prefix = `--${name}=`
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix))
  return argument ? argument.slice(prefix.length).trim() : ''
}

const databasePath = resolve(argumentValue('database'))
const full = process.argv.slice(2).includes('--full')
if (!databasePath || !existsSync(databasePath)) {
  console.error(JSON.stringify({ ok: false, code: 'database_missing' }))
  process.exitCode = 2
} else {
  let db
  try {
    db = new DatabaseSync(databasePath, { readOnly: true })
    db.exec('PRAGMA busy_timeout=2000; PRAGMA query_only=ON;')
    db.exec('BEGIN')
    const count = (sql) => Number(db.prepare(sql).get()?.count ?? 0)
    const checkpoint = db.prepare(`
      SELECT status, queued_rows, processed_rows, document_count, error_code
      FROM search_index_checkpoints_v2 WHERE scope = 'full'
    `).get() ?? null
    const fileBytes = Object.fromEntries(['', '-wal', '-shm'].map((suffix) => {
      const path = `${databasePath}${suffix}`
      return [suffix || 'db', existsSync(path) ? statSync(path).size : 0]
    }))
    const result = {
      ok: true,
      file_bytes: fileBytes,
      dirty_rows_derived: checkpoint
        ? Math.max(0, Number(checkpoint.queued_rows) - Number(checkpoint.processed_rows))
        : null,
      checkpoint: checkpoint ? {
        status: checkpoint.status,
        queued_rows: Number(checkpoint.queued_rows),
        processed_rows: Number(checkpoint.processed_rows),
        document_count: Number(checkpoint.document_count),
        error_code: checkpoint.error_code ?? null
      } : null
    }
    if (full) {
      Object.assign(result, {
        candidates: count('SELECT COUNT(*) AS count FROM candidates'),
        experiences: count('SELECT COUNT(*) AS count FROM candidate_profile_sections'),
        candidate_position_relations: count('SELECT COUNT(*) AS count FROM candidate_positions'),
        candidate_pool_relations: count('SELECT COUNT(*) AS count FROM candidate_talent_pools'),
        source_records: count('SELECT COUNT(*) AS count FROM candidate_source_records'),
        dirty_rows: count('SELECT COUNT(*) AS count FROM search_index_dirty_v2'),
        business_documents: count('SELECT COUNT(*) AS count FROM search_documents_v2'),
        business_fts_documents: count('SELECT COUNT(*) AS count FROM search_documents_v2_fts'),
        resume_documents: count('SELECT COUNT(*) AS count FROM candidate_resume_documents'),
        resume_fts_documents: count('SELECT COUNT(*) AS count FROM candidate_resume_fts')
      })
    }
    db.exec('COMMIT')
    console.log(JSON.stringify(result))
  } catch (error) {
    try { db?.exec('ROLLBACK') } catch {}
    console.log(JSON.stringify({ ok: false, code: error?.code ?? 'progress_read_failed', message: String(error?.message ?? error).slice(0, 180) }))
    process.exitCode = 1
  } finally {
    try { db?.close() } catch {}
  }
}
