#!/usr/bin/env node

/*
 * Safe derived-search maintenance.
 *
 * This command deliberately has no in-place mode. The input database is
 * opened read-only, copied with SQLite's consistent backup API, and all
 * rebuilds happen on the explicitly named artifact. A human can inspect and
 * switch the artifact later; this script never replaces data/recruitment.db.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  BUSINESS_SEARCH_INTERNALS,
  compactBusinessSearchFts,
  compactBusinessSearchOrdinaryIndexes,
  getBusinessSearchCoverage,
  isBusinessSearchFtsCompact,
  migrateBusinessSearch,
  queueBusinessSearchBackfill,
  flushBusinessSearchDirty
} from '../server/business-search.js'
import { acquireMaintenanceSentinel } from '../server/maintenance.js'

const DEFAULT_DATABASE = resolve(process.cwd(), 'data', 'recruitment.db')
const DEFAULT_BATCH_SIZE = 500
const REPORT_VERSION = 1
const DERIVED_TABLE_PREFIXES = [
  'search_documents_v2',
  'search_index_',
  'candidate_resume_fts_'
]

function fail(message, code = 'maintenance_error') {
  const error = new Error(message)
  error.code = code
  throw error
}

function parseArgs(argv) {
  const values = { mode: argv[0] ?? 'dry-run', database: DEFAULT_DATABASE, output: null, json: false, resume: false, vacuum: true, batchSize: DEFAULT_BATCH_SIZE }
  let index = argv.length && ['dry-run', 'build'].includes(argv[0]) ? 1 : 0
  while (index < argv.length) {
    const argument = argv[index]
    if (argument === '--json') values.json = true
    else if (argument === '--resume') values.resume = true
    else if (argument === '--no-vacuum') values.vacuum = false
    else if (argument === '--database' || argument === '--output' || argument === '--batch-size') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`, 'invalid_arguments')
      if (argument === '--database') values.database = resolve(value)
      if (argument === '--output') values.output = resolve(value)
      if (argument === '--batch-size') values.batchSize = Number(value)
      index += 1
    } else {
      fail(`Unknown argument: ${argument}`, 'invalid_arguments')
    }
    index += 1
  }
  if (!Number.isSafeInteger(values.batchSize) || values.batchSize < 1 || values.batchSize > 5_000) {
    fail('--batch-size must be an integer between 1 and 5000', 'invalid_arguments')
  }
  return values
}

function fileBytes(path) {
  try { return statSync(path).size } catch { return 0 }
}

function fileSetBytes(databasePath) {
  return {
    database: fileBytes(databasePath),
    wal: fileBytes(`${databasePath}-wal`),
    shm: fileBytes(`${databasePath}-shm`)
  }
}

function totalBytes(files) {
  return Object.values(files).reduce((sum, value) => sum + Number(value || 0), 0)
}

function databasePageSnapshot(db, databasePath) {
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 0)
  const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0)
  const freelistCount = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0)
  return {
    page_size: pageSize,
    page_count: pageCount,
    freelist_count: freelistCount,
    allocated_bytes: pageSize * pageCount,
    live_page_bytes: pageSize * Math.max(0, pageCount - freelistCount),
    files: fileSetBytes(databasePath)
  }
}

function maintenanceStatePath(outputPath) {
  return `${outputPath}.maintenance-state.json`
}

function writeMaintenanceState(sourcePath, outputPath) {
  const state = {
    report_version: REPORT_VERSION,
    source_database: resolve(sourcePath),
    artifact_database: resolve(outputPath),
    copied_at: new Date().toISOString()
  }
  writeFileSync(maintenanceStatePath(outputPath), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
  return state
}

function readMaintenanceState(outputPath) {
  const path = maintenanceStatePath(outputPath)
  if (!existsSync(path)) {
    fail('The artifact has no maintenance state and cannot be resumed safely.', 'resume_state_missing')
  }
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (!state?.source_database || resolve(state.artifact_database ?? '') !== resolve(outputPath)) throw new Error('invalid state')
    return state
  } catch (cause) {
    if (cause?.code === 'resume_state_missing') throw cause
    fail('The artifact maintenance state is invalid.', 'resume_state_invalid')
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?
  `).get(table))
}

function countTable(db, table) {
  return tableExists(db, table) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"`).get().count ?? 0) : null
}

function businessCounts(db) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name).filter((name) => (
    !DERIVED_TABLE_PREFIXES.some((prefix) => String(name).startsWith(prefix))
  ))
  return Object.fromEntries(tables.map((table) => [table, countTable(db, table)]))
}

function derivedCounts(db) {
  return {
    documents: countTable(db, BUSINESS_SEARCH_INTERNALS.documentsTable),
    fts: countTable(db, BUSINESS_SEARCH_INTERNALS.ftsTable),
    dirty: countTable(db, BUSINESS_SEARCH_INTERNALS.dirtyTable),
    fts_compaction_checkpoint: tableExists(db, BUSINESS_SEARCH_INTERNALS.checkpointTable)
      ? db.prepare(`SELECT status,queued_rows,processed_rows,document_count,error_code FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable} WHERE scope = 'fts_compaction'`).get() ?? null
      : null,
    full_checkpoint: tableExists(db, BUSINESS_SEARCH_INTERNALS.checkpointTable)
      ? db.prepare(`SELECT status,queued_rows,processed_rows,document_count,error_code FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable} WHERE scope = 'full'`).get() ?? null
      : null
  }
}

function dbstatBytes(db) {
  try {
    return Object.fromEntries(db.prepare(`
      SELECT name, SUM(pgsize) AS bytes
      FROM dbstat
      -- SQLite names UNIQUE constraints on the derived table as
      -- sqlite_autoindex_*; include those pages in the derived-space metric.
      WHERE name LIKE 'search_documents_v2%'
         OR name LIKE 'sqlite_autoindex_search_documents_v2_%'
      GROUP BY name
      ORDER BY bytes DESC
    `).all().map((row) => [row.name, Number(row.bytes ?? 0)]))
  } catch {
    return {}
  }
}

function integritySnapshot(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0])
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  return {
    integrity_ok: integrity.length === 1 && integrity[0] === 'ok',
    integrity,
    foreign_key_errors: foreignKeys.length
  }
}

function freeBytes(path) {
  try {
    const stats = statfsSync(dirname(resolve(path)))
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safePhrase(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? `search_text : ("${text.slice(0, 120)}")` : null
}

function collectSearchProbes(db) {
  const probes = []
  const add = (label, sourceTable, fieldPath, row) => {
    if (!row?.content || !safePhrase(row.content)) return
    probes.push({ label, source_table: sourceTable, field_path: fieldPath, value: String(row.content).slice(0, 120) })
  }
  const first = (sql, ...parameters) => db.prepare(sql).get(...parameters)
  add('candidate exact field', 'candidates', 'candidates.current_title', first(`
    SELECT content FROM search_documents_v2
    WHERE source_table = 'candidates' AND field_path = 'candidates.current_title' AND length(content) BETWEEN 2 AND 120
    ORDER BY row_id LIMIT 1
  `))
  add('source label', 'candidate_source_records', 'candidate_source_records.source_name', first(`
    SELECT content FROM search_documents_v2
    WHERE source_table = 'candidate_source_records' AND field_path = 'candidate_source_records.source_name' AND length(content) BETWEEN 2 AND 120
    ORDER BY row_id LIMIT 1
  `))
  add('position title', 'positions', 'positions.title', first(`
    SELECT content FROM search_documents_v2
    WHERE source_table = 'positions' AND field_path = 'positions.title' AND length(content) BETWEEN 2 AND 120
    ORDER BY row_id LIMIT 1
  `))
  add('talent pool name', 'talent_pools', 'talent_pools.name', first(`
    SELECT content FROM search_documents_v2
    WHERE source_table = 'talent_pools' AND field_path = 'talent_pools.name' AND length(content) BETWEEN 2 AND 120
    ORDER BY row_id LIMIT 1
  `))
  const candidateNames = db.prepare(`
    SELECT content FROM search_documents_v2
    WHERE source_table = 'candidates' AND field_path = 'candidates.name' AND length(content) BETWEEN 2 AND 120
    ORDER BY row_id LIMIT 500
  `).all()
  add('Chinese term', 'candidates', 'candidates.name', candidateNames.find((row) => /\p{Script=Han}/u.test(row.content)))
  add('archived scope', 'candidates', 'candidates.name', first(`
    SELECT d.content FROM search_documents_v2 d JOIN candidates c ON c.id = d.source_row_id
    WHERE d.source_table = 'candidates' AND d.field_path = 'candidates.name' AND c.archived_at IS NOT NULL
      AND length(d.content) BETWEEN 2 AND 120 ORDER BY d.row_id LIMIT 1
  `))
  return probes
}

function runSearchProbe(db, probe) {
  const expression = safePhrase(probe.value)
  if (!expression) return { count: 0, digest: sha256('') }
  const rows = db.prepare(`
    SELECT d.document_id, d.entity_type, d.entity_id, d.field_path
    FROM search_documents_v2_fts f
    JOIN search_documents_v2 d ON d.row_id = f.rowid
    WHERE search_documents_v2_fts MATCH ?
      AND d.source_table = ? AND d.field_path = ?
    ORDER BY d.document_id
  `).all(expression, probe.source_table, probe.field_path)
  return { count: rows.length, digest: sha256(JSON.stringify(rows)) }
}

function probesEqual(before, afterDb, after) {
  const result = []
  for (const probe of before) {
    const next = after.find((candidate) => candidate.label === probe.label)
    const right = next ? runSearchProbe(afterDb, next) : { count: 0, digest: sha256('') }
    result.push({
      label: probe.label,
      count_before: probe.result.count,
      count_after: right.count,
      equivalent: probe.result.count === right.count && probe.result.digest === right.digest
    })
  }
  return result
}

function checkpointWal(db, databasePath, state) {
  try { db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all() } catch {}
  state.wal_peak_bytes = Math.max(state.wal_peak_bytes, fileBytes(`${databasePath}-wal`))
}

function reportDryRun(options) {
  const started = performance.now()
  const sourcePath = resolve(options.database)
  if (!existsSync(sourcePath)) fail(`Database does not exist: ${sourcePath}`, 'database_missing')
  const db = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    const files = fileSetBytes(sourcePath)
    const derived = dbstatBytes(db)
    const derivedBytes = Object.values(derived).reduce((sum, value) => sum + value, 0)
    const required = totalBytes(files) + Math.max(256 * 1024 * 1024, Math.ceil(derivedBytes * 0.35))
    const free = freeBytes(sourcePath)
    return {
      report_version: REPORT_VERSION,
      mode: 'dry-run',
      database: sourcePath,
      read_only: true,
      files,
      business_counts: businessCounts(db),
      derived_counts: derivedCounts(db),
      derived_dbstat_bytes: derived,
      derived_bytes: derivedBytes,
      estimated_required_bytes: required,
      free_bytes: free,
      disk_ok: free === null ? null : free >= required,
      fts_compact: isBusinessSearchFtsCompact(db),
      elapsed_ms: Number((performance.now() - started).toFixed(1))
    }
  } finally {
    db.close()
  }
}

async function createConsistentCopy(sourcePath, outputPath) {
  if (resolve(sourcePath) === resolve(outputPath)) fail('Output must differ from the source database.', 'unsafe_target')
  if (existsSync(outputPath)) fail('Output already exists; pass --resume to continue an artifact rebuild.', 'output_exists')
  mkdirSync(dirname(outputPath), { recursive: true })
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    await backup(source, outputPath)
  } finally {
    source.close()
  }
}

function assertArtifactPath(sourcePath, outputPath) {
  const source = resolve(sourcePath)
  const output = resolve(outputPath)
  if (!outputPath || source === output) fail('A separate --output artifact path is required.', 'unsafe_target')
  // Never allow an accidental replacement-looking target under the formal
  // data directory. A manual operator can choose any separate artifact path.
  if (output.toLowerCase() === resolve(process.cwd(), 'data', 'recruitment.db').toLowerCase()) {
    fail('The formal data/recruitment.db path is never a maintenance output.', 'unsafe_target')
  }
}

async function buildArtifact(options) {
  const sourcePath = resolve(options.database)
  const outputPath = resolve(options.output ?? '')
  if (!existsSync(sourcePath)) fail(`Database does not exist: ${sourcePath}`, 'database_missing')
  assertArtifactPath(sourcePath, outputPath)
  if (existsSync(outputPath) && !options.resume) fail('Output exists; use --resume only for a prior artifact.', 'output_exists')
  mkdirSync(dirname(outputPath), { recursive: true })
  let maintenanceState
  if (!existsSync(outputPath)) {
    const plan = reportDryRun({ ...options, database: sourcePath })
    const available = freeBytes(outputPath)
    if (available !== null && available < plan.estimated_required_bytes) {
      fail('Insufficient disk space for a consistent artifact and rebuild workspace.', 'disk_space_insufficient')
    }
    await createConsistentCopy(sourcePath, outputPath)
    maintenanceState = writeMaintenanceState(sourcePath, outputPath)
  } else {
    maintenanceState = readMaintenanceState(outputPath)
    if (resolve(maintenanceState.source_database).toLowerCase() !== sourcePath.toLowerCase()) {
      fail('The resume source does not match the source that created this artifact.', 'resume_source_mismatch')
    }
    const available = freeBytes(outputPath)
    const workingBytes = Math.max(256 * 1024 * 1024, Math.ceil(fileBytes(outputPath) * 0.35))
    if (available !== null && available < workingBytes) {
      fail('Insufficient disk space to resume the artifact rebuild.', 'disk_space_insufficient')
    }
  }

  const sentinel = acquireMaintenanceSentinel(outputPath, undefined, { recoverStale: options.resume })
  const state = { wal_peak_bytes: fileBytes(`${outputPath}-wal`), phase_ms: {}, started_at: new Date().toISOString() }
  let db
  try {
    db = new DatabaseSync(outputPath)
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
    const beforeBusiness = businessCounts(db)
    const beforeIntegrity = integritySnapshot(db)
    const beforeDerived = derivedCounts(db)
    const beforeDerivedBytes = dbstatBytes(db)
    const beforePhysical = databasePageSnapshot(db, outputPath)
    const probesBefore = collectSearchProbes(db).map((probe) => ({ ...probe, result: runSearchProbe(db, probe) }))

    let phaseStarted = performance.now()
    migrateBusinessSearch(db)
    while (true) {
      const compact = compactBusinessSearchFts(db, {
        batchSize: Math.min(50_000, options.batchSize * 100),
        maxBatches: 1
      })
      checkpointWal(db, outputPath, state)
      if (compact.status === 'ready') break
    }
    state.phase_ms.fts_compaction = Number((performance.now() - phaseStarted).toFixed(1))

    phaseStarted = performance.now()
    const queued = queueBusinessSearchBackfill(db, { batchSize: options.batchSize })
    state.document_backfill = {
      queued_rows: Number(queued.queued_rows ?? 0),
      stale_documents_deleted: Number(queued.stale_documents_deleted ?? 0),
      non_searchable_documents_deleted: Number(queued.non_searchable_documents_deleted ?? 0),
      batch_size: options.batchSize
    }
    checkpointWal(db, outputPath, state)
    let remaining = Number(queued.queued_rows ?? 0)
    let processed = 0
    let written = 0
    let removed = 0
    while (remaining > 0) {
      const batch = flushBusinessSearchDirty(db, { limit: options.batchSize })
      processed += batch.processed_rows
      written += batch.written_documents
      removed += batch.removed_documents
      remaining = batch.remaining_rows
      checkpointWal(db, outputPath, state)
      if (batch.processed_rows === 0) fail('Dirty queue stopped before completion.', 'dirty_queue_stalled')
    }
    state.phase_ms.document_backfill = Number((performance.now() - phaseStarted).toFixed(1))
    state.document_backfill.processed_rows = processed
    state.document_backfill.written_documents = written
    state.document_backfill.removed_documents = removed
    state.document_backfill.remaining_rows = remaining

    phaseStarted = performance.now()
    const replayBefore = countTable(db, BUSINESS_SEARCH_INTERNALS.documentsTable)
    checkpointWal(db, outputPath, state)
    const replayPhysicalBefore = databasePageSnapshot(db, outputPath)
    const replayDerivedBefore = dbstatBytes(db)
    const replayQueued = queueBusinessSearchBackfill(db, { batchSize: options.batchSize })
    let replayWritten = 0
    let replayRemoved = 0
    while (Number(replayQueued.queued_rows ?? 0) > 0) {
      const batch = flushBusinessSearchDirty(db, { limit: options.batchSize })
      replayWritten += batch.written_documents
      replayRemoved += batch.removed_documents
      checkpointWal(db, outputPath, state)
      if (batch.processed_rows === 0) fail('Replay dirty queue stopped before completion.', 'dirty_queue_stalled')
      replayQueued.queued_rows = Math.max(0, Number(replayQueued.queued_rows) - batch.processed_rows)
    }
    const replayAfter = countTable(db, BUSINESS_SEARCH_INTERNALS.documentsTable)
    checkpointWal(db, outputPath, state)
    const replayPhysicalAfter = databasePageSnapshot(db, outputPath)
    const replayDerivedAfter = dbstatBytes(db)
    const replayDerivedBytesBefore = Object.values(replayDerivedBefore).reduce((sum, value) => sum + value, 0)
    const replayDerivedBytesAfter = Object.values(replayDerivedAfter).reduce((sum, value) => sum + value, 0)
    state.replay = {
      document_count_before: replayBefore,
      document_count_after: replayAfter,
      stable: replayBefore === replayAfter && replayDerivedBytesBefore === replayDerivedBytesAfter,
      written_documents: replayWritten,
      removed_documents: replayRemoved,
      first_pass_written_documents: written,
      first_pass_removed_documents: removed,
      first_pass_processed_rows: processed,
      derived_bytes_before: replayDerivedBytesBefore,
      derived_bytes_after: replayDerivedBytesAfter,
      physical_before: replayPhysicalBefore,
      physical_after: replayPhysicalAfter
    }
    state.phase_ms.replay = Number((performance.now() - phaseStarted).toFixed(1))

    phaseStarted = performance.now()
    const ordinaryIndexes = compactBusinessSearchOrdinaryIndexes(db)
    checkpointWal(db, outputPath, state)
    state.phase_ms.ordinary_indexes = Number((performance.now() - phaseStarted).toFixed(1))

    const probesAfter = collectSearchProbes(db)
    const probeResults = probesEqual(probesBefore, db, probesAfter)
    const afterBusiness = businessCounts(db)
    const beforeAfterCountsEqual = JSON.stringify(beforeBusiness) === JSON.stringify(afterBusiness)
    const beforeIntegrityAfterRebuild = integritySnapshot(db)
    const coverage = getBusinessSearchCoverage(db, { persist: true, includeFields: true })
    checkpointWal(db, outputPath, state)
    if (options.vacuum) {
      const available = freeBytes(outputPath)
      const needed = fileBytes(outputPath) + totalBytes(fileSetBytes(outputPath))
      if (available !== null && available < needed) fail('Insufficient disk space for artifact VACUUM.', 'disk_space_insufficient')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
      db.exec('PRAGMA journal_mode = WAL;')
      checkpointWal(db, outputPath, state)
    }
    db.close()
    db = null

    const verified = new DatabaseSync(outputPath, { readOnly: true })
    let afterIntegrity
    let afterDerived
    let afterDerivedBytes
    let afterPhysical
    try {
      afterIntegrity = integritySnapshot(verified)
      afterDerived = derivedCounts(verified)
      afterDerivedBytes = dbstatBytes(verified)
      afterPhysical = databasePageSnapshot(verified, outputPath)
    } finally { verified.close() }
    const outputFiles = fileSetBytes(outputPath)
    const report = {
      report_version: REPORT_VERSION,
      mode: 'build',
      source_database: sourcePath,
      artifact_database: outputPath,
      source_untouched: true,
      maintenance_state: maintenanceState,
      before: {
        business_counts: beforeBusiness,
        integrity: beforeIntegrity,
        derived_counts: beforeDerived,
        derived_dbstat_bytes: beforeDerivedBytes,
        physical: beforePhysical
      },
      after: {
        business_counts: afterBusiness,
        integrity_before_vacuum: beforeIntegrityAfterRebuild,
        integrity: afterIntegrity,
        derived_counts: afterDerived,
        derived_dbstat_bytes: afterDerivedBytes,
        physical: afterPhysical,
        coverage: { status: coverage.status, totals: coverage.totals, tables: coverage.tables },
        ordinary_indexes: ordinaryIndexes,
        output_files: outputFiles,
        compact_fts: true
      },
      representative_queries: probeResults,
      document_backfill: state.document_backfill,
      replay: state.replay,
      wal_peak_bytes: state.wal_peak_bytes,
      phase_ms: state.phase_ms,
      completed_at: new Date().toISOString()
    }
    const reportPath = `${outputPath}.maintenance.json`
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    return report
  } catch (error) {
    try { db?.close() } catch {}
    throw error
  } finally {
    sentinel.release()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = options.mode === 'dry-run' ? reportDryRun(options) : await buildArtifact(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { code: error?.code ?? 'maintenance_error', message: String(error?.message ?? error) } })}\n`)
  process.exitCode = 1
})
