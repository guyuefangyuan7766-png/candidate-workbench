import { existsSync, realpathSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  BUSINESS_SEARCH_INTERNALS,
  buildAllRecordsPlans,
  buildBusinessCandidatePlans
} from '../../server/business-search.js'
import { createReadonlyQueryService } from '../../server/readonly-query.js'
import { normalizeResumeSearch } from '../../server/resume-search.js'

const FORMAL_DATABASE_PATH = resolve(process.cwd(), 'data', 'recruitment.db')
const MIN_CAPACITY_CANDIDATES = 100_000
const DEFAULT_WARM_REPEATS = 3
const READONLY_TIMEOUT_MS = 15_000

class PostcheckError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'PostcheckError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details = undefined) {
  throw new PostcheckError(code, message, details)
}

function progress(stage, details = undefined) {
  const payload = { progress: stage, at: new Date().toISOString() }
  if (details !== undefined) payload.details = details
  process.stderr.write(`${JSON.stringify(payload)}\n`)
}

function usage() {
  return [
    'Usage: node tests/performance/v9-capacity-postcheck.mjs --database=<absolute-anonymous-db>',
    'Checks a completed, kept V9 anonymous benchmark database without copying or writing it.',
    'The formal data/recruitment.db path is always refused.'
  ].join('\n')
}

function parseArguments(argv) {
  let databasePath = null
  for (const argument of argv) {
    if (argument === '--help') return { help: true }
    if (argument.startsWith('--database=')) {
      if (databasePath !== null) fail('invalid_arguments', 'Only one --database argument is permitted.')
      databasePath = argument.slice('--database='.length).trim()
      continue
    }
    fail('invalid_arguments', `Unsupported argument: ${argument}`)
  }
  if (!databasePath) fail('invalid_arguments', usage())
  if (!isAbsolute(databasePath)) fail('invalid_arguments', '--database must be an absolute path.')
  return { databasePath: resolve(databasePath), warmRepeats: DEFAULT_WARM_REPEATS }
}

function canonicalPath(value) {
  const resolved = resolve(value)
  const normalize = (path) => {
    const trimmed = path.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  try {
    return normalize(realpathSync.native(resolved))
  } catch {
    return normalize(resolved)
  }
}

function assertAnonymousDatabase(databasePath) {
  if (canonicalPath(databasePath) === canonicalPath(FORMAL_DATABASE_PATH)) {
    fail('formal_database_refused', 'The formal recruitment database is not an allowed postcheck input.')
  }
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    fail('database_not_found', 'The anonymous database file does not exist.')
  }
}

function fileBytes(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? statSync(path).size : 0
  } catch {
    return 0
  }
}

function snapshotFiles(databasePath) {
  const main = fileBytes(databasePath)
  const wal = fileBytes(`${databasePath}-wal`)
  const shm = fileBytes(`${databasePath}-shm`)
  return {
    database_bytes: main,
    wal_bytes: wal,
    shm_bytes: shm,
    total_bytes: main + wal + shm
  }
}

function openReadOnlyDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false
  })
  try {
    db.enableLoadExtension?.(false)
    db.enableDefensive?.(true)
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA query_only = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 0;
    `)
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }
  return db
}

function numberValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function rowCount(db, table) {
  return numberValue(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
}

const ANONYMOUS_SOURCE_SYSTEM = 'anonymous-benchmark'
const PROVENANCE_TABLES = [
  'candidates',
  'positions',
  'talent_pools',
  'candidate_profile_sections',
  'candidate_preferences',
  'candidate_source_records',
  'notes',
  'activities',
  'candidate_attachments',
  'candidate_assessments',
  'candidate_consents',
  'candidate_position_sources',
  'candidate_positions',
  'candidate_talent_pools',
  'search_documents_v2',
  'candidate_resume_documents'
]

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)))
}

function inspectAnonymousProvenance(db) {
  const contamination = {}
  for (const table of PROVENANCE_TABLES) {
    const columns = tableColumns(db, table)
    if (!columns.size) continue
    let count = 0
    if (columns.has('source_system') && table !== 'positions') {
      count += numberValue(db.prepare(`
        SELECT COUNT(*) AS count FROM ${table}
        WHERE source_system IS NULL OR source_system <> ?
      `).get(ANONYMOUS_SOURCE_SYSTEM).count)
    }
    if (columns.has('source') && table === 'candidate_attachments') {
      count += numberValue(db.prepare(`
        SELECT COUNT(*) AS count FROM ${table}
        WHERE source IS NULL OR source <> 'anonymous_benchmark'
      `).get().count)
    }
    if (columns.has('candidate_id') && table !== 'candidates') {
      count += numberValue(db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${table} t
        LEFT JOIN candidates c ON c.id = t.candidate_id
        WHERE t.candidate_id IS NOT NULL
          AND (c.id IS NULL OR c.source_system <> ?)
      `).get(ANONYMOUS_SOURCE_SYSTEM).count)
    }
    if (columns.has('position_id')) {
      count += numberValue(db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${table} t
        LEFT JOIN candidates c ON c.id = t.candidate_id
        LEFT JOIN positions p ON p.id = t.position_id
        WHERE c.id IS NULL OR c.source_system <> ? OR p.id IS NULL
      `).get(ANONYMOUS_SOURCE_SYSTEM).count)
    }
    if (columns.has('talent_pool_id')) {
      count += numberValue(db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${table} t
        LEFT JOIN candidates c ON c.id = t.candidate_id
        LEFT JOIN talent_pools p ON p.id = t.talent_pool_id
        WHERE c.id IS NULL OR c.source_system <> ? OR p.id IS NULL
      `).get(ANONYMOUS_SOURCE_SYSTEM).count)
    }
    if (count > 0) contamination[table] = count
  }
  return contamination
}

function pragmaValue(row) {
  if (!row) return ''
  return String(row.integrity_check ?? Object.values(row)[0] ?? '')
}

function inspectDatabase(databasePath) {
  const db = openReadOnlyDatabase(databasePath)
  try {
    progress('inspection_counts_started')
    const checkpoint = db.prepare(`
      SELECT status, queued_rows, processed_rows, document_count, error_code
      FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable}
      WHERE scope = 'full'
    `).get() ?? null
    const dirtyRows = rowCount(db, BUSINESS_SEARCH_INTERNALS.dirtyTable)
    const businessDocuments = rowCount(db, BUSINESS_SEARCH_INTERNALS.documentsTable)
    const businessFtsDocuments = rowCount(db, BUSINESS_SEARCH_INTERNALS.ftsTable)
    const resumeDocuments = rowCount(db, 'candidate_resume_documents')
    const resumeFtsDocuments = rowCount(db, 'candidate_resume_fts')
    const candidates = rowCount(db, 'candidates')
    const experiences = rowCount(db, 'candidate_profile_sections')
    const positionRelations = rowCount(db, 'candidate_positions')
    const poolRelations = rowCount(db, 'candidate_talent_pools')
    const sourceRecords = rowCount(db, 'candidate_source_records')
    // The structured aggregation intentionally scopes to active candidates;
    // keep its expected counts separate from the all-row capacity counts.
    const activeCandidates = numberValue(db.prepare(`
      SELECT COUNT(*) AS count FROM candidates WHERE archived_at IS NULL
    `).get().count)
    const activeExperiences = numberValue(db.prepare(`
      SELECT COUNT(*) AS count
      FROM candidate_profile_sections s
      JOIN candidates c ON c.id = s.candidate_id
      WHERE c.archived_at IS NULL AND s.archived_at IS NULL
    `).get().count)
    const activePositionRelations = numberValue(db.prepare(`
      SELECT COUNT(*) AS count
      FROM candidate_positions r
      JOIN candidates c ON c.id = r.candidate_id
      WHERE c.archived_at IS NULL
    `).get().count)
    const activePoolRelations = numberValue(db.prepare(`
      SELECT COUNT(*) AS count
      FROM candidate_talent_pools r
      JOIN candidates c ON c.id = r.candidate_id
      WHERE c.archived_at IS NULL
    `).get().count)
    const nonAnonymousCandidates = numberValue(db.prepare(`
      SELECT COUNT(*) AS count FROM candidates
      WHERE source_system IS NULL OR source_system <> 'anonymous-benchmark'
    `).get().count)
    const nonAnonymousSources = numberValue(db.prepare(`
      SELECT COUNT(*) AS count FROM candidate_source_records
      WHERE source_system IS NULL OR source_system <> 'anonymous-benchmark'
    `).get().count)
    progress('inspection_provenance_started')
    const provenanceContamination = inspectAnonymousProvenance(db)

    const checkpointReady = Boolean(
      checkpoint
      && checkpoint.status === 'ready'
      && numberValue(checkpoint.queued_rows) === numberValue(checkpoint.processed_rows)
    )
    const checkpointDocumentsMatch = Boolean(
      checkpoint && numberValue(checkpoint.document_count) === businessDocuments
    )
    const dirtyClear = dirtyRows === 0
    const businessFtsMatch = businessDocuments === businessFtsDocuments
    const resumeFtsMatch = resumeDocuments === resumeFtsDocuments
    if (!checkpointReady || !checkpointDocumentsMatch || !dirtyClear || !businessFtsMatch || !resumeFtsMatch) {
      fail('fts_not_ready', 'The anonymous database does not have a complete ready FTS index.', {
        checkpoint_status: checkpoint?.status ?? null,
        queued_rows: numberValue(checkpoint?.queued_rows),
        processed_rows: numberValue(checkpoint?.processed_rows),
        checkpoint_document_count: numberValue(checkpoint?.document_count),
        business_documents: businessDocuments,
        business_fts_documents: businessFtsDocuments,
        resume_documents: resumeDocuments,
        resume_fts_documents: resumeFtsDocuments,
        dirty_rows: dirtyRows
      })
    }
    if (candidates < MIN_CAPACITY_CANDIDATES || nonAnonymousCandidates > 0 || nonAnonymousSources > 0 || Object.keys(provenanceContamination).length > 0) {
      fail('anonymous_capacity_database_required', 'The postcheck accepts only a ready anonymous capacity database.', {
        candidate_count: candidates,
        minimum_candidate_count: MIN_CAPACITY_CANDIDATES,
        non_anonymous_candidates: nonAnonymousCandidates,
        non_anonymous_source_records: nonAnonymousSources,
        provenance_contamination: provenanceContamination
      })
    }

    progress('inspection_integrity_started')
    const integrityValues = db.prepare('PRAGMA integrity_check').all().map(pragmaValue)
    const integrity = integrityValues.length === 1 ? integrityValues[0] : 'multiple_results'
    progress('inspection_integrity_check_completed', { result_count: integrityValues.length, ok: integrity === 'ok' })
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length
    progress('inspection_foreign_key_check_completed', { violations: foreignKeyViolations })
    if (integrity !== 'ok' || foreignKeyViolations !== 0) {
      fail('database_integrity_failed', 'The anonymous database failed SQLite integrity checks.', {
        integrity_check: integrity,
        integrity_result_count: integrityValues.length,
        foreign_key_violations: foreignKeyViolations
      })
    }
    progress('inspection_completed')

    return {
      candidate_count: candidates,
      active_candidate_count: activeCandidates,
      experience_records: experiences,
      active_experience_records: activeExperiences,
      candidate_position_relations: positionRelations,
      active_candidate_position_relations: activePositionRelations,
      candidate_pool_relations: poolRelations,
      active_candidate_pool_relations: activePoolRelations,
      source_records: sourceRecords,
      source_rows: numberValue(checkpoint.queued_rows),
      business_search_documents: businessDocuments,
      business_search_fts_documents: businessFtsDocuments,
      candidate_resume_documents: resumeDocuments,
      candidate_resume_fts_documents: resumeFtsDocuments,
      checkpoint: {
        status: String(checkpoint.status),
        queued_rows: numberValue(checkpoint.queued_rows),
        processed_rows: numberValue(checkpoint.processed_rows),
        document_count: numberValue(checkpoint.document_count),
        error_code: checkpoint.error_code ?? null
      },
      dirty_rows: dirtyRows,
      consistency: {
        checkpoint_ready: checkpointReady,
        checkpoint_queue_complete: numberValue(checkpoint.queued_rows) === numberValue(checkpoint.processed_rows),
        checkpoint_document_count_matches_base: checkpointDocumentsMatch,
        business_fts_document_count_matches_base: businessFtsMatch,
        resume_fts_document_count_matches_base: resumeFtsMatch,
        dirty_rows_zero: dirtyClear,
        anonymous_source_only: true,
        provenance_contamination: provenanceContamination,
        integrity_check: integrity,
        foreign_key_violations: foreignKeyViolations
      }
    }
  } finally {
    try { db.close() } catch {}
  }
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? Number(entry) : entry)
}

function responseBytes(rows, hasMore) {
  return Buffer.byteLength(jsonSafe({ rows, has_more: Boolean(hasMore) }), 'utf8')
}

function stableSignature(rows) {
  return jsonSafe(rows.map((row) => jsonSafe(row)).sort())
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
  return {
    iterations: sorted.length,
    min_ms: Number(sorted[0].toFixed(3)),
    median_ms: Number(percentile(0.5).toFixed(3)),
    p95_ms: Number(percentile(0.95).toFixed(3)),
    max_ms: Number(sorted.at(-1).toFixed(3)),
    mean_ms: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3))
  }
}

function sampleProcessRss(peak) {
  const rss = process.memoryUsage().rss
  return { current: rss, peak: Math.max(peak, rss) }
}

function makeProjectedPlan(plan, columns) {
  return {
    sql: `SELECT ${columns.join(', ')} FROM (${plan.sql}) AS postcheck_page`,
    parameters: plan.parameters
  }
}

const AGGREGATE_SQL = `
  WITH active_candidates AS MATERIALIZED (
    SELECT id, location, stage, gender, years_experience, expected_salary
    FROM candidates
    WHERE archived_at IS NULL
  ),
  experience_counts AS (
    SELECT candidate_id, COUNT(*) AS experience_count
    FROM candidate_profile_sections
    WHERE archived_at IS NULL
    GROUP BY candidate_id
  ),
  position_counts AS (
    SELECT candidate_id, COUNT(*) AS position_count
    FROM candidate_positions
    GROUP BY candidate_id
  ),
  pool_counts AS (
    SELECT candidate_id, COUNT(*) AS pool_count
    FROM candidate_talent_pools
    GROUP BY candidate_id
  ),
  candidate_metrics AS (
    SELECT
      a.location,
      a.stage,
      a.gender,
      a.years_experience,
      a.expected_salary,
      coalesce(e.experience_count, 0) AS experience_count,
      coalesce(p.position_count, 0) AS position_count,
      coalesce(t.pool_count, 0) AS pool_count
    FROM active_candidates a
    LEFT JOIN experience_counts e ON e.candidate_id = a.id
    LEFT JOIN position_counts p ON p.candidate_id = a.id
    LEFT JOIN pool_counts t ON t.candidate_id = a.id
  ),
  grouped AS (
    SELECT
      location,
      stage,
      SUM(CASE WHEN gender = '男' THEN 1 ELSE 0 END) AS male_count,
      COUNT(*) AS candidate_count,
      SUM(experience_count) AS experience_count,
      SUM(position_count) AS position_count,
      SUM(pool_count) AS pool_count,
      ROUND(AVG(CAST(years_experience AS REAL)), 3) AS average_years,
      ROUND(AVG(CAST(expected_salary AS REAL)), 3) AS average_salary
    FROM candidate_metrics
    GROUP BY location, stage
  )
  SELECT
    COUNT(*) AS group_count,
    COALESCE(SUM(candidate_count), 0) AS candidate_count,
    COALESCE(SUM(male_count), 0) AS male_count,
    COALESCE(SUM(experience_count), 0) AS experience_count,
    COALESCE(SUM(position_count), 0) AS position_count,
    COALESCE(SUM(pool_count), 0) AS pool_count,
    ROUND(AVG(average_years), 3) AS average_group_years,
    ROUND(AVG(average_salary), 3) AS average_group_salary
  FROM grouped
`

function aggregateResult(rows) {
  const row = rows[0] ?? {}
  const numeric = (key) => numberValue(row[key])
  return {
    group_count: numeric('group_count'),
    candidate_count: numeric('candidate_count'),
    male_count: numeric('male_count'),
    experience_count: numeric('experience_count'),
    position_count: numeric('position_count'),
    pool_count: numeric('pool_count'),
    average_group_years: numeric('average_group_years'),
    average_group_salary: numeric('average_group_salary')
  }
}

function querySpecifications(inspection) {
  const broad = buildAllRecordsPlans({
    keywords: ['Anonymous'],
    match_mode: 'any',
    archived: 'exclude',
    page: 1,
    page_size: 20,
    evidence_limit: 1,
    fast: true,
    include_total: false
  })
  const hybrid = buildBusinessCandidatePlans(normalizeResumeSearch({
    query: 'Unity overseas project',
    keywords: ['Unity', 'overseas project'],
    match_mode: 'all',
    archived: 'exclude',
    location: 'Shanghai',
    page: 1,
    page_size: 20,
    evidence_limit: 1,
    fast: true,
    include_total: false
  }))
  const candidateBroad = buildBusinessCandidatePlans(normalizeResumeSearch({
    query: 'Anonymous',
    keywords: ['Anonymous'],
    match_mode: 'any',
    archived: 'exclude',
    page: 1,
    page_size: 20,
    evidence_limit: 1,
    fast: true,
    include_total: false
  }))
  const candidateAnd = buildBusinessCandidatePlans(normalizeResumeSearch({
    query: 'Anonymous TypeScript',
    keywords: ['Anonymous', 'TypeScript'],
    match_mode: 'all',
    archived: 'exclude',
    page: 1,
    page_size: 20,
    evidence_limit: 1,
    fast: true,
    include_total: false
  }))
  return [
    {
      key: 'high_frequency_broad_fast_top_k',
      tool: 'search_all_records',
      visible_limit: 20,
      max_rows: 21,
      max_bytes: 400_000,
      plan: makeProjectedPlan(broad.page, ['entity_type', 'entity_id', 'bm25_rank'])
    },
    {
      key: 'candidate_high_frequency_or_fast_top_k',
      tool: 'search_candidate_resumes',
      visible_limit: 20,
      max_rows: 21,
      max_bytes: 400_000,
      plan: makeProjectedPlan(candidateBroad.page, ['candidate_id', 'bm25_rank', 'concept_count', 'matched_concepts'])
    },
    {
      key: 'candidate_multi_keyword_and_fast_top_k',
      tool: 'search_candidate_resumes',
      visible_limit: 20,
      max_rows: 21,
      max_bytes: 400_000,
      plan: makeProjectedPlan(candidateAnd.page, ['candidate_id', 'bm25_rank', 'concept_count', 'matched_concepts'])
    },
    {
      key: 'hybrid_candidate_search',
      tool: 'search_candidate_resumes',
      visible_limit: 20,
      max_rows: 21,
      max_bytes: 400_000,
      plan: makeProjectedPlan(hybrid.page, ['candidate_id', 'bm25_rank', 'concept_count', 'matched_concepts'])
    },
    {
      key: 'complex_structured_aggregation',
      tool: 'execute_readonly_query',
      visible_limit: Number.POSITIVE_INFINITY,
      max_rows: 10,
      max_bytes: 100_000,
      plan: { sql: AGGREGATE_SQL, parameters: [] },
      safeResult: aggregateResult,
      validate(rows) {
        if (rows.length !== 1) fail('aggregate_shape_invalid', 'The aggregate query must return exactly one row.')
        const result = aggregateResult(rows)
        const expected = {
          candidate_count: inspection.active_candidate_count,
          experience_count: inspection.active_experience_records,
          position_count: inspection.active_candidate_position_relations,
          pool_count: inspection.active_candidate_pool_relations
        }
        for (const [key, value] of Object.entries(expected)) {
          if (result[key] !== value) fail('aggregate_count_mismatch', `The aggregate ${key} did not match the anonymous fixture.`, { expected: value, actual: result[key] })
        }
        if (result.group_count < 1 || !Number.isFinite(result.average_group_years) || !Number.isFinite(result.average_group_salary)) {
          fail('aggregate_result_invalid', 'The aggregate query did not return finite grouped metrics.', { result })
        }
      }
    }
  ]
}

function summarizePage(rawRows, visibleLimit) {
  const visibleRows = Number.isFinite(visibleLimit) ? rawRows.slice(0, visibleLimit) : rawRows
  return {
    returned_count: visibleRows.length,
    has_more_count: rawRows.length > visibleRows.length ? 1 : 0,
    response_bytes: responseBytes(visibleRows, rawRows.length > visibleRows.length),
    signature: stableSignature(visibleRows)
  }
}

function runDirectScenario(databasePath, spec, warmRepeats) {
  let db
  let peakRss = process.memoryUsage().rss
  const openedAt = performance.now()
  try {
    db = openReadOnlyDatabase(databasePath)
    const statement = db.prepare(spec.plan.sql)
    const connectionOpenAndPrepareMs = performance.now() - openedAt
    const execute = () => {
      const startedAt = performance.now()
      const rawRows = statement.all(...spec.plan.parameters)
      const elapsedMs = performance.now() - startedAt
      const memory = sampleProcessRss(peakRss)
      peakRss = memory.peak
      return { elapsedMs, rawRows, memoryRss: memory.current, summary: summarizePage(rawRows, spec.visible_limit) }
    }
    const cold = execute()
    const warm = []
    for (let index = 0; index < warmRepeats; index += 1) warm.push(execute())
    spec.validate?.(cold.rawRows)
    warm.forEach((sample) => spec.validate?.(sample.rawRows))
    for (const sample of warm) {
      if (sample.summary.signature !== cold.summary.signature) {
        fail('nondeterministic_query', `The ${spec.key} query changed between cold and warm executions.`)
      }
    }
    return {
      process_cold: {
        os_cache_cleared: false,
        connection_open_and_prepare_ms: Number(connectionOpenAndPrepareMs.toFixed(3)),
        query_ms: Number(cold.elapsedMs.toFixed(3)),
        returned_count: cold.summary.returned_count,
        has_more_count: cold.summary.has_more_count,
        response_bytes: cold.summary.response_bytes,
        process_rss_bytes: cold.memoryRss,
        ...(spec.safeResult ? { safe_result: spec.safeResult(cold.rawRows) } : {})
      },
      same_process_warm: {
        query_timing: summarize(warm.map((sample) => sample.elapsedMs)),
        returned_count: cold.summary.returned_count,
        has_more_count: cold.summary.has_more_count,
        response_bytes: cold.summary.response_bytes,
        process_peak_rss_bytes: peakRss
      }
    }
  } finally {
    try { db?.close() } catch {}
  }
}

async function runWorkerScenario(readonlyService, spec, warmRepeats) {
  const execute = async () => {
    const startedAt = performance.now()
    const result = await readonlyService.executeReadonlyQuery({
      ...spec.plan,
      maxRows: spec.max_rows,
      maxBytes: spec.max_bytes,
      timeoutMs: READONLY_TIMEOUT_MS,
      tool: spec.tool
    })
    const elapsedMs = performance.now() - startedAt
    const summary = summarizePage(result.rows ?? [], spec.visible_limit)
    spec.validate?.(result.rows ?? [])
    return {
      elapsedMs,
      workerExecutionMs: Number(result.audit?.execution_ms ?? 0),
      workerRssBytes: numberValue(result.worker_peak_rss_bytes),
      summary,
      safeResult: spec.safeResult ? spec.safeResult(result.rows ?? []) : undefined
    }
  }
  const first = await execute()
  const subsequent = []
  for (let index = 0; index < warmRepeats; index += 1) subsequent.push(await execute())
  for (const sample of subsequent) {
    if (sample.summary.signature !== first.summary.signature) {
      fail('nondeterministic_worker_query', `The ${spec.key} worker query changed between executions.`)
    }
  }
  return {
    worker_process_reused: false,
    isolated_worker_first: {
      os_cache_cleared: false,
      end_to_end_ms: Number(first.elapsedMs.toFixed(3)),
      worker_execution_ms: Number(first.workerExecutionMs.toFixed(3)),
      returned_count: first.summary.returned_count,
      has_more_count: first.summary.has_more_count,
      response_bytes: first.summary.response_bytes,
      worker_peak_rss_bytes: first.workerRssBytes,
      ...(first.safeResult ? { safe_result: first.safeResult } : {})
    },
    isolated_worker_subsequent: {
      end_to_end_timing: summarize(subsequent.map((sample) => sample.elapsedMs)),
      worker_execution_timing: summarize(subsequent.map((sample) => sample.workerExecutionMs)),
      returned_count: first.summary.returned_count,
      has_more_count: first.summary.has_more_count,
      response_bytes: first.summary.response_bytes,
      max_worker_peak_rss_bytes: Math.max(...subsequent.map((sample) => sample.workerRssBytes), first.workerRssBytes)
    }
  }
}

async function run(options) {
  assertAnonymousDatabase(options.databasePath)
  const beforeFiles = snapshotFiles(options.databasePath)
  progress('postcheck_started')
  const inspection = inspectDatabase(options.databasePath)
  const specifications = querySpecifications(inspection)
  const readonlyService = createReadonlyQueryService({
    databasePath: options.databasePath,
    timeoutMs: READONLY_TIMEOUT_MS
  })
  const measurements = {}
  for (const spec of specifications) {
    progress('direct_scenario_started', { key: spec.key })
    const direct = runDirectScenario(options.databasePath, spec, options.warmRepeats)
    progress('worker_scenario_started', { key: spec.key })
    const worker = await runWorkerScenario(readonlyService, spec, options.warmRepeats)
    measurements[spec.key] = { ...direct, ...worker }
    progress('scenario_completed', { key: spec.key })
  }
  const afterFiles = snapshotFiles(options.databasePath)
  const sourceFilesUnchanged = jsonSafe(beforeFiles) === jsonSafe(afterFiles)
  if (!sourceFilesUnchanged) {
    fail('database_changed_during_postcheck', 'The source database changed while the read-only postcheck was running.')
  }
  progress('postcheck_completed')
  return {
    benchmark: 'candidate-workbench-v9-capacity-postcheck',
    completed_at: new Date().toISOString(),
    isolation: {
      formal_database_used: false,
      source_open_mode: 'read_only',
      source_copied: false,
      query_content_emitted: false,
      os_cache_cleared: false,
      os_cache_note: 'process-cold means the first query on a fresh read-only connection; the operating-system cache was not cleared.'
    },
    files: {
      before: beforeFiles,
      after: afterFiles,
      source_files_unchanged: sourceFilesUnchanged
    },
    capacity: inspection,
    measurements
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const result = await run(options)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  const payload = {
    error: {
      code: error?.code ?? 'postcheck_failed',
      message: String(error?.message ?? error).slice(0, 240)
    }
  }
  if (error?.details !== undefined) payload.error.details = error.details
  console.error(JSON.stringify(payload, null, 2))
  process.exitCode = 1
})
