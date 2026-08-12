import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  BUSINESS_SEARCH_INTERNALS,
  buildAllRecordsPlans,
  buildBusinessCandidatePlans,
  flushBusinessSearchDirty,
  getBusinessSearchCoverage,
  queueBusinessSearchBackfill,
  searchAllRecords,
  searchAllRecordsReadonly,
  searchBusinessCandidates
} from '../../server/business-search.js'
import { listCandidates } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import { createReadonlyQueryService } from '../../server/readonly-query.js'
import { normalizeResumeSearch, searchCandidateResumesReadonly } from '../../server/resume-search.js'
import { normalizeGender } from '../../server/validation.js'

const MIB = 1024 * 1024
const DEFAULTS = Object.freeze({
  candidates: 10_000,
  iterations: 15,
  readonlyIterations: 3,
  batchSize: 5_000,
  commitBatch: 2_000,
  capacity: false,
  keep: false
})

function usage() {
  return [
    'Usage: node --expose-gc tests/performance/v8-anonymous-benchmark.mjs [options]',
    '  --candidates=N            Anonymous candidate count (default: 10000; 100k+ capacity is supported)',
    '  --iterations=N            In-process timing iterations (default: 15)',
    '  --readonly-iterations=N   Isolated worker timing iterations (default: 3)',
    '  --batch-size=N            FTS dirty flush size, 1-5000 (default: 5000)',
    '  --commit-batch=N          Fixture commit size, 100-10000 (default: 2000)',
    '  --capacity                Generate 5 experiences and 10 relations per candidate',
    '  --keep                    Keep the temporary database for inspection',
    '  --help                    Show this message'
  ].join('\n')
}

function positiveInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function parseArguments(argv) {
  const options = { ...DEFAULTS }
  for (const argument of argv) {
    if (argument === '--keep') options.keep = true
    else if (argument === '--capacity') options.capacity = true
    else if (argument === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (argument.startsWith('--candidates=')) {
      // Keep the benchmark guard well above the 100k capacity target. This is
      // a test-resource bound only; the application has no candidate-count
      // hard limit.
      options.candidates = positiveInteger(argument.slice('--candidates='.length), 'candidates', 100, 250_000)
    } else if (argument.startsWith('--iterations=')) {
      options.iterations = positiveInteger(argument.slice('--iterations='.length), 'iterations', 3, 100)
    } else if (argument.startsWith('--readonly-iterations=')) {
      options.readonlyIterations = positiveInteger(
        argument.slice('--readonly-iterations='.length),
        'readonly-iterations',
        1,
        20
      )
    } else if (argument.startsWith('--batch-size=')) {
      options.batchSize = positiveInteger(argument.slice('--batch-size='.length), 'batch-size', 1, 5_000)
    } else if (argument.startsWith('--commit-batch=')) {
      options.commitBatch = positiveInteger(argument.slice('--commit-batch='.length), 'commit-batch', 100, 10_000)
    } else {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    }
  }
  return options
}

function rounded(value, digits = 3) {
  return Number(Number(value).toFixed(digits))
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function summarize(durations) {
  const values = [...durations].sort((left, right) => left - right)
  const percentile = (ratio) => values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]
  return {
    iterations: values.length,
    min_ms: rounded(values[0]),
    median_ms: rounded(percentile(0.5)),
    p95_ms: rounded(percentile(0.95)),
    max_ms: rounded(values.at(-1)),
    mean_ms: rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
  }
}

function benchmarkSync(operation, { iterations, warmup = 2 }) {
  let result
  for (let index = 0; index < warmup; index += 1) result = operation()
  const durations = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    result = operation()
    durations.push(performance.now() - startedAt)
  }
  return { timing: summarize(durations), result }
}

async function benchmarkAsync(operation, { iterations, warmup = 1 }) {
  let result
  for (let index = 0; index < warmup; index += 1) result = await operation()
  const durations = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    result = await operation()
    durations.push(performance.now() - startedAt)
  }
  return { timing: summarize(durations), result }
}

function explainQueryPlan(db, sql, parameters = []) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => ({
    id: Number(row.id),
    parent: Number(row.parent),
    detail: row.detail
  }))
}

function safeTemporaryCleanup(directory) {
  const resolvedDirectory = resolve(directory)
  const resolvedTemp = resolve(tmpdir())
  const expectedPrefix = `candidate-workbench-v8-benchmark-`
  if (
    !resolvedDirectory.startsWith(`${resolvedTemp}${sep}`) ||
    !basename(resolvedDirectory).startsWith(expectedPrefix)
  ) {
    throw new Error(`Refusing to remove unexpected benchmark directory: ${resolvedDirectory}`)
  }
  rmSync(resolvedDirectory, { recursive: true, force: true })
}

function fixtureStatements(db) {
  return {
    position: db.prepare(`
      INSERT INTO positions(
        id, title, department, location, owner, headcount, status, description,
        tags, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)
    `),
    pool: db.prepare(`
      INSERT INTO talent_pools(
        id, name, description, color, source_system, source_record_id,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, '#2563eb', 'anonymous-benchmark', ?, ?, ?, NULL)
    `),
    candidate: db.prepare(`
      INSERT INTO candidates(
        id, name, phone, email, current_company, current_title, location, gender,
        birth_date, age, years_experience, education, highest_school, highest_major,
        job_seeking_status, resume_updated_at, self_summary, source, stage, owner,
        tags, expected_salary, source_system, source_record_id,
        created_at, updated_at, archived_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `),
    section: db.prepare(`
      INSERT INTO candidate_profile_sections(
        id, candidate_id, section_type, title, content, structured_data,
        sort_order, sensitivity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?)
    `),
    preference: db.prepare(`
      INSERT INTO candidate_preferences(
        candidate_id, employment_status, desired_titles, desired_locations,
        employment_type, expected_salary, availability, raw_payload, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    source: db.prepare(`
      INSERT INTO candidate_source_records(
        id, candidate_id, source_system, source_record_id, record_type,
        source_name, source_timestamp, raw_payload, sensitivity, created_at, updated_at
      ) VALUES (?, ?, 'anonymous-benchmark', ?, 'candidate', ?, ?, ?, 'high', ?, ?)
    `),
    note: db.prepare(`
      INSERT INTO notes(id, candidate_id, content, author, created_at, updated_at)
      VALUES (?, ?, ?, 'Anonymous Recruiter', ?, ?)
    `),
    activity: db.prepare(`
      INSERT INTO activities(id, candidate_id, type, description, metadata, created_at)
      VALUES (?, ?, 'benchmark_activity', ?, ?, ?)
    `),
    attachment: db.prepare(`
      INSERT INTO candidate_attachments(
        id, candidate_id, original_filename, storage_path, mime_type, file_size,
        sha256, attachment_type, parse_status, parser_version, extracted_text,
        source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'resume', 'parsed',
        'anonymous-benchmark-parser', ?, 'anonymous_benchmark', ?, ?)
    `),
    positionLink: db.prepare(`
      INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, ?, ?)
    `),
    poolLink: db.prepare(`
      INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, ?, ?)
    `)
  }
}

function insertAnonymousFixture(db, candidateCount, sampleMemory, options = {}) {
  const statements = fixtureStatements(db)
  const stage = db.prepare('SELECT value FROM stages ORDER BY position, value LIMIT 1').get()?.value
  if (!stage) throw new Error('The anonymous database did not create a candidate stage.')
  const locations = ['Shanghai', 'Beijing', 'Shenzhen']
  const genders = ['male', 'female', 'other'].map((value) => normalizeGender(value))
  const capacity = options.capacity === true
  const relationWidth = capacity ? 5 : 1
  const sectionWidth = capacity ? 5 : 1
  const positionIds = Array.from({ length: capacity ? 100 : 40 }, (_, index) => `anon-position-${String(index).padStart(3, '0')}`)
  const poolIds = Array.from({ length: capacity ? 100 : 20 }, (_, index) => `anon-pool-${String(index).padStart(3, '0')}`)
  const baseTimestamp = Date.UTC(2026, 0, 1)
  let profileSections = 0
  let preferences = 0
  let sources = 0
  let notes = 0
  let activities = 0
  let attachments = 0
  let searchSignals = 0
  let candidatePositionRelations = 0
  let candidatePoolRelations = 0
  const commitBatch = Math.max(100, Number(options.commitBatch) || 2_000)

  db.exec('BEGIN IMMEDIATE')
  try {
    for (let index = 0; index < positionIds.length; index += 1) {
      const timestamp = new Date(baseTimestamp + index * 1_000).toISOString()
      statements.position.run(
        positionIds[index],
        `Anonymous Position ${index}`,
        index % 2 ? 'Product' : 'Engineering',
        locations[index % locations.length],
        `Owner ${index % 8}`,
        1 + (index % 8),
        index === 7 ? 'unitybenchmark position evidence' : 'Anonymous benchmark position description',
        JSON.stringify(['anonymous', `position-${index % 5}`]),
        timestamp,
        timestamp
      )
    }
    for (let index = 0; index < poolIds.length; index += 1) {
      const timestamp = new Date(baseTimestamp + index * 1_000).toISOString()
      statements.pool.run(
        poolIds[index],
        `Anonymous Pool ${index}`,
        index === 3 ? 'unitybenchmark talent pool evidence' : 'Anonymous benchmark talent group',
        `ANON-POOL-${index}`,
        timestamp,
        timestamp
      )
    }
    db.exec('COMMIT')

    for (let index = 1; index <= candidateCount; index += 1) {
      if ((index - 1) % commitBatch === 0) db.exec('BEGIN IMMEDIATE')
      const serial = String(index).padStart(6, '0')
      const candidateId = `anon-candidate-${serial}`
      const timestamp = new Date(baseTimestamp + index * 1_000).toISOString()
      const marker = index <= locations.length || index % 137 === 0
      const location = locations[index % locations.length]
      const expectedSalary = String(18_000 + (index % 30) * 1_000)
      if (marker) searchSignals += 1
      statements.candidate.run(
        candidateId,
        `Anonymous Candidate ${serial}`,
        `138${String(index).padStart(8, '0')}`,
        `candidate.${serial}@example.test`,
        `Anonymous Company ${index % 100}`,
        marker ? 'Unity Technical Lead' : `Software Engineer ${index % 12}`,
        location,
        genders[index % genders.length],
        `${1980 + (index % 20)}-${String((index % 12) + 1).padStart(2, '0')}-15`,
        27 + (index % 20),
        1 + (index % 15),
        index % 3 === 0 ? 'Bachelor' : 'Master',
        `Anonymous University ${index % 80}`,
        index % 4 === 0 ? 'Computer Science' : 'Software Engineering',
        index % 5 === 0 ? 'Actively looking' : 'Open to opportunities',
        timestamp,
        marker
          ? 'unitybenchmark Unity engineer with overseas project delivery and live operations experience'
          : 'Anonymous engineer experienced in TypeScript services and product delivery',
        'anonymous-benchmark',
        stage,
        `Owner ${index % 8}`,
        JSON.stringify(['anonymous', marker ? 'unity' : `skill-${index % 20}`]),
        expectedSalary,
        'anonymous-benchmark',
        `ANON-APPLICANT-${serial}`,
        timestamp,
        timestamp,
        index % 100 === 0 ? timestamp : null
      )
      for (let relationIndex = 0; relationIndex < relationWidth; relationIndex += 1) {
        statements.positionLink.run(
          candidateId,
          positionIds[(index * relationWidth + relationIndex) % positionIds.length],
          timestamp
        )
        statements.poolLink.run(
          candidateId,
          poolIds[(index * relationWidth + relationIndex) % poolIds.length],
          timestamp
        )
        candidatePositionRelations += 1
        candidatePoolRelations += 1
      }

      if (capacity) {
        const sectionTypes = ['work', 'work', 'project', 'project', 'education']
        for (let sectionIndex = 0; sectionIndex < sectionWidth; sectionIndex += 1) {
          const sectionType = sectionTypes[sectionIndex]
          statements.section.run(
            `anon-section-${serial}-${sectionIndex}`,
            candidateId,
            sectionType,
            `Anonymous ${sectionType} experience ${sectionIndex}`,
            marker
              ? `Delivered a Unity overseas ${sectionType} with multilingual release operations.`
              : `Built local TypeScript and SQLite ${sectionType} workflows for product delivery.`,
            JSON.stringify({ years: 1 + (index % 15), verified: index % 4 === 0, section: sectionIndex }),
            sectionIndex,
            timestamp,
            timestamp
          )
          profileSections += 1
        }
      } else if (index % 2 === 0) {
        statements.section.run(
          `anon-section-${serial}`,
          candidateId,
          'work',
          'Anonymous work experience',
          marker
            ? 'Delivered a Unity overseas mobile project with multilingual release operations.'
            : 'Built local TypeScript and SQLite recruitment workflows.',
          JSON.stringify({ years: 1 + (index % 15), verified: index % 4 === 0 }),
          0,
          timestamp,
          timestamp
        )
        profileSections += 1
      }
      if (index % 5 === 0) {
        statements.preference.run(
          candidateId,
          'employed',
          JSON.stringify(marker ? ['Unity Lead'] : ['Software Engineer']),
          JSON.stringify([location]),
          'full-time',
          expectedSalary,
          '30 days',
          JSON.stringify({ remote: index % 2 === 0, anonymous_code: `PREF-${serial}` }),
          timestamp
        )
        preferences += 1
        statements.source.run(
          `anon-source-${serial}`,
          candidateId,
          `ANON-SOURCE-${serial}`,
          'Anonymous benchmark source',
          timestamp,
          JSON.stringify({
            identity: { external_code: `EXT-${serial}` },
            skills: marker ? ['Unity', 'overseas project', 'unitybenchmark'] : ['TypeScript', 'SQLite'],
            desired_salary: Number(expectedSalary),
            verified: index % 10 === 0
          }),
          timestamp,
          timestamp
        )
        sources += 1
      }
      if (index % 10 === 0) {
        statements.note.run(
          `anon-note-${serial}`,
          candidateId,
          marker ? 'unitybenchmark recruiter evidence' : 'Anonymous recruiter benchmark note',
          timestamp,
          timestamp
        )
        notes += 1
      }
      if (index % 20 === 0) {
        statements.activity.run(
          `anon-activity-${serial}`,
          candidateId,
          marker ? 'unitybenchmark activity evidence' : 'Anonymous benchmark activity',
          JSON.stringify({ channel: 'anonymous', sequence: index }),
          timestamp
        )
        activities += 1
      }
      if (marker) {
        const attachmentId = `anon-attachment-${serial}`
        statements.attachment.run(
          attachmentId,
          candidateId,
          `anonymous-resume-${serial}.pdf`,
          `benchmark-quarantine/${attachmentId}.pdf`,
          1_024,
          createHash('sha256').update(attachmentId).digest('hex'),
          'unitybenchmark complete resume: Unity overseas project architecture and release evidence',
          timestamp,
          timestamp
        )
        attachments += 1
      }
      if (index % commitBatch === 0 || index === candidateCount) {
        db.exec('COMMIT')
        sampleMemory()
      }
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }

  return {
    candidates: candidateCount,
    positions: positionIds.length,
    talent_pools: poolIds.length,
    candidate_position_relations: candidatePositionRelations,
    candidate_pool_relations: candidatePoolRelations,
    business_detail_records: candidatePositionRelations + candidatePoolRelations + preferences + sources + notes + activities,
    experience_records: profileSections,
    profile_sections: profileSections,
    preferences,
    source_records: sources,
    notes,
    activities,
    attachments,
    fts_signal_candidates: searchSignals
  }
}

function fileBytes(path) {
  return existsSync(path) ? statSync(path).size : 0
}

const options = parseArguments(process.argv.slice(2))
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'candidate-workbench-v8-benchmark-'))
const databasePath = join(temporaryDirectory, 'anonymous-v8-benchmark.db')
let db
let sampledPeakRss = process.memoryUsage().rss
const sampleMemory = () => {
  sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss)
}

try {
  console.error(`[v8-benchmark] creating anonymous file database with ${options.candidates} candidates`)
  const openStartedAt = performance.now()
  db = openDatabase(databasePath)
  const openMs = performance.now() - openStartedAt
  db.exec('PRAGMA synchronous=NORMAL')

  const fixtureStartedAt = performance.now()
  const fixture = insertAnonymousFixture(db, options.candidates, sampleMemory, options)
  const fixtureMs = performance.now() - fixtureStartedAt
  sampleMemory()

  const analyzeStartedAt = performance.now()
  db.exec('ANALYZE')
  db.exec('PRAGMA optimize')
  const analyzeMs = performance.now() - analyzeStartedAt

  const paginationParameters = [normalizeGender('male')]
  const countSql = `
    SELECT COUNT(*) AS count
    FROM candidates
    WHERE archived_at IS NULL AND gender = ?
  `
  const countStatement = db.prepare(countSql)
  const paginationTotal = Number(countStatement.get(...paginationParameters).count)
  const paginationPage = Math.min(100, Math.max(1, Math.floor(paginationTotal / 40)))
  const paginationOffset = (paginationPage - 1) * 20
  const pageSql = `
    SELECT * FROM candidates
    WHERE archived_at IS NULL AND gender = ?
    ORDER BY updated_at DESC, id ASC
    LIMIT 20 OFFSET ?
  `
  const pageParameters = [...paginationParameters, paginationOffset]
  const pageStatement = db.prepare(pageSql)
  const countBenchmark = benchmarkSync(
    () => countStatement.get(...paginationParameters),
    { iterations: options.iterations }
  )
  const paginationDatabase = benchmarkSync(
    () => ({
      total: Number(countStatement.get(...paginationParameters).count),
      rows: pageStatement.all(...pageParameters)
    }),
    { iterations: options.iterations }
  )
  const paginationService = benchmarkSync(
    () => listCandidates(db, {
      archived: 'exclude',
      gender: 'male',
      sort: 'updated_at',
      order: 'desc',
      page: paginationPage,
      page_size: 20
    }),
    { iterations: options.iterations }
  )
  assert.equal(paginationService.result.pagination.total, paginationTotal)
  assert.equal(paginationService.result.pagination.page, paginationPage)
  assert.equal(paginationService.result.pagination.page_size, 20)
  assert.equal(paginationService.result.data.length, 20)

  const qnaSql = `
    SELECT location,
      COUNT(*) AS candidate_count,
      SUM(CASE WHEN gender = ? THEN 1 ELSE 0 END) AS male_count,
      ROUND(AVG(CAST(expected_salary AS REAL)), 2) AS average_expected_salary
    FROM candidates
    WHERE archived_at IS NULL
    GROUP BY location
    ORDER BY candidate_count DESC, location ASC
  `
  const qnaParameters = [normalizeGender('male')]
  const qnaStatement = db.prepare(qnaSql)
  const qnaDatabase = benchmarkSync(
    () => qnaStatement.all(...qnaParameters),
    { iterations: options.iterations }
  )

  const readonly = createReadonlyQueryService({
    databasePath,
    exportRoot: join(temporaryDirectory, 'exports'),
    timeoutMs: 15_000
  })
  const qnaReadonly = await benchmarkAsync(
    () => readonly.executeReadonlyQuery({
      sql: qnaSql,
      parameters: qnaParameters,
      maxRows: 20,
      maxBytes: 100_000,
      tool: 'execute_readonly_query'
    }),
    { iterations: options.readonlyIterations }
  )
  assert.equal(JSON.stringify(qnaReadonly.result.rows), JSON.stringify(qnaDatabase.result))
  sampleMemory()

  console.error('[v8-benchmark] running V8 full-field FTS queue and backfill')
  const backfillStartedAt = performance.now()
  const queueStartedAt = performance.now()
  const queued = queueBusinessSearchBackfill(db)
  const queueMs = performance.now() - queueStartedAt
  const batchDurations = []
  let processedRows = 0
  let insertedDocuments = 0
  let remainingRows = Number.POSITIVE_INFINITY
  while (remainingRows > 0) {
    const batchStartedAt = performance.now()
    const batch = flushBusinessSearchDirty(db, { limit: options.batchSize })
    batchDurations.push(performance.now() - batchStartedAt)
    processedRows += batch.processed_rows
    insertedDocuments += batch.inserted_documents
    remainingRows = batch.remaining_rows
    sampleMemory()
    console.error(
      `[v8-benchmark] indexed ${processedRows}/${queued.queued_rows} source rows; remaining ${remainingRows}`
    )
    if (batch.processed_rows === 0 && remainingRows > 0) {
      throw new Error('V8 FTS backfill stopped while dirty rows remain.')
    }
  }
  const coverageStartedAt = performance.now()
  const coverage = getBusinessSearchCoverage(db, { persist: true, includeFields: true })
  const coverageMs = performance.now() - coverageStartedAt
  const backfillMs = performance.now() - backfillStartedAt
  if (coverage.status !== 'ready') throw new Error(`V8 FTS coverage is not ready: ${coverage.status}`)

  db.exec('ANALYZE')
  db.exec('PRAGMA optimize')

  const allRecordInput = {
    keywords: ['unitybenchmark'],
    match_mode: 'any',
    archived: 'exclude',
    page: 1,
    page_size: 20,
    evidence_limit: 3
  }
  const allRecordPlans = buildAllRecordsPlans(allRecordInput)
  const ftsPageStatement = db.prepare(allRecordPlans.page.sql)
  const ftsPageDatabase = benchmarkSync(
    () => ftsPageStatement.all(...allRecordPlans.page.parameters),
    { iterations: options.iterations }
  )
  const allRecordService = benchmarkSync(
    () => searchAllRecords(db, allRecordInput),
    { iterations: options.iterations }
  )
  const allRecordReadonly = await benchmarkAsync(
    () => searchAllRecordsReadonly(readonly, { ...allRecordInput, include_total: true }),
    { iterations: options.readonlyIterations }
  )
  const allRecordFastReadonly = await benchmarkAsync(
    () => searchAllRecordsReadonly(readonly, { ...allRecordInput, include_total: false }),
    { iterations: 1, warmup: 0 }
  )
  if (!allRecordService.result.items.length) throw new Error('The all-record FTS benchmark returned no evidence.')
  assert.equal(allRecordReadonly.result.pagination.total, allRecordService.result.pagination.total)
  assert.equal(allRecordReadonly.result.items.length, allRecordService.result.items.length)
  assert.ok(allRecordReadonly.result.items.length <= allRecordInput.page_size)

  const candidateSearchInput = {
    query: 'Unity overseas project',
    keywords: ['Unity', 'overseas project'],
    match_mode: 'all',
    archived: 'exclude',
    location: 'Shanghai',
    page: 1,
    page_size: 20,
    evidence_limit: 3
  }
  const normalizedCandidateSearch = normalizeResumeSearch(candidateSearchInput)
  const candidatePlans = buildBusinessCandidatePlans(normalizedCandidateSearch)
  const candidateSearchService = benchmarkSync(
    () => searchBusinessCandidates(db, normalizedCandidateSearch),
    { iterations: options.iterations }
  )
  const candidateSearchReadonly = await benchmarkAsync(
    () => searchCandidateResumesReadonly(readonly, { ...candidateSearchInput, include_total: true }),
    { iterations: options.readonlyIterations }
  )
  const candidateFastReadonly = await benchmarkAsync(
    () => searchCandidateResumesReadonly(readonly, { ...candidateSearchInput, include_total: false }),
    { iterations: 1, warmup: 0 }
  )
  if (!candidateSearchService.result.items.length) throw new Error('The candidate FTS benchmark returned no candidates.')
  assert.equal(candidateSearchReadonly.result.pagination.total, candidateSearchService.result.pagination.total)
  assert.equal(candidateSearchReadonly.result.items.length, candidateSearchService.result.items.length)
  assert.ok(candidateSearchReadonly.result.items.length <= candidateSearchInput.page_size)
  assert.equal(allRecordFastReadonly.result.pagination.total, null)
  assert.equal(candidateFastReadonly.result.pagination.total, null)
  assert.equal(typeof allRecordFastReadonly.result.pagination.has_more, 'boolean')
  assert.equal(typeof candidateFastReadonly.result.pagination.has_more, 'boolean')
  sampleMemory()

  const wideSearchInputs = {
    high_frequency_or: {
      keywords: ['Anonymous'],
      match_mode: 'any',
      archived: 'exclude',
      page: 1,
      page_size: 20,
      evidence_limit: 1,
      fast: true
    },
    multi_keyword_and: {
      keywords: ['Anonymous', 'TypeScript'],
      match_mode: 'all',
      archived: 'exclude',
      page: 1,
      page_size: 20,
      evidence_limit: 1,
      fast: true
    },
    no_match: {
      keywords: ['term-that-does-not-exist-anonymous-benchmark'],
      match_mode: 'any',
      archived: 'include',
      page: 1,
      page_size: 20,
      evidence_limit: 1,
      fast: true
    }
  }
  const wideSearch = {}
  for (const [label, input] of Object.entries(wideSearchInputs)) {
    try {
      const measured = await benchmarkAsync(
        () => searchCandidateResumesReadonly(readonly, input),
        { iterations: 1, warmup: 0 }
      )
      assert.ok(measured.result.items.length <= input.page_size)
      wideSearch[label] = {
        timing: measured.timing,
        returned_candidates: measured.result.items.length,
        has_more: measured.result.pagination.has_more,
        response_bytes: byteSize(measured.result),
        worker_peak_rss_bytes: measured.result.performance?.worker_peak_rss_bytes ?? null,
        worker_peak_rss_mib: measured.result.performance?.worker_peak_rss_bytes == null ? null : rounded(measured.result.performance.worker_peak_rss_bytes / MIB)
      }
    } catch (error) {
      wideSearch[label] = { error_code: error?.code ?? 'query_failed', message: String(error?.message ?? error).slice(0, 200) }
    }
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size)
  const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count)
  const resourcePeakRss = Number(process.resourceUsage().maxRSS) * 1024
  const peakRss = Math.max(sampledPeakRss, resourcePeakRss)
  const databaseBytes = fileBytes(databasePath)
  const walBytes = fileBytes(`${databasePath}-wal`)
  const shmBytes = fileBytes(`${databasePath}-shm`)
  const documentCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
  `).get().count)

  const result = {
    benchmark: 'candidate-workbench-v8-anonymous',
    completed_at: new Date().toISOString(),
    reproducible_command: `node --expose-gc tests/performance/v8-anonymous-benchmark.mjs --candidates=${options.candidates} --iterations=${options.iterations} --readonly-iterations=${options.readonlyIterations} --batch-size=${options.batchSize} --commit-batch=${options.commitBatch}${options.capacity ? ' --capacity' : ''}`,
    isolation: {
      dataset: 'generated anonymous data only',
      database: options.keep ? databasePath : 'temporary file removed after benchmark',
      formal_database_used: false,
      model_gateway_invoked: false
    },
    environment: {
      node: process.version,
      sqlite: sqliteVersion,
      platform: process.platform,
      arch: process.arch,
      cpu_model: cpus()[0]?.model ?? null,
      cpu_count: cpus().length
    },
    fixture: {
      ...fixture,
      capacity_target: 100_000,
      capacity_headroom_case: options.candidates > 100_000,
      capacity_fixture: options.capacity,
      fixture_commit_batch: options.commitBatch,
      open_database_ms: rounded(openMs),
      insert_ms: rounded(fixtureMs),
      analyze_ms: rounded(analyzeMs),
      database_bytes: databaseBytes,
      database_mib: rounded(databaseBytes / MIB),
      wal_bytes: walBytes,
      shm_bytes: shmBytes,
      sqlite_logical_bytes: pageSize * pageCount
    },
    memory: {
      sampled_peak_rss_bytes: sampledPeakRss,
      resource_usage_peak_rss_bytes: resourcePeakRss,
      process_peak_rss_bytes: peakRss,
      process_peak_rss_mib: rounded(peakRss / MIB),
      note: 'Main benchmark process only; isolated read-only workers are short-lived child processes.'
    },
    pagination: {
      filters: { archived: 'exclude', gender: 'male' },
      page: paginationPage,
      page_size: 20,
      matched_total: Number(countBenchmark.result.count),
      returned_rows: paginationService.result.data.length,
      count_database: countBenchmark.timing,
      count_response_bytes: byteSize(countBenchmark.result),
      database_count_and_page: paginationDatabase.timing,
      service_layer: paginationService.timing,
      estimated_application_overhead_ms: rounded(
        paginationService.timing.median_ms - paginationDatabase.timing.median_ms
      ),
      response_bytes: byteSize(paginationService.result),
      explain_query_plan: explainQueryPlan(db, pageSql, pageParameters)
    },
    structured_data_qna: {
      question: 'Count active candidates by location and calculate male count and average expected salary.',
      database: qnaDatabase.timing,
      readonly_worker_end_to_end: qnaReadonly.timing,
      estimated_application_overhead_ms: rounded(
        qnaReadonly.timing.median_ms - qnaDatabase.timing.median_ms
      ),
      result_rows: qnaDatabase.result.length,
      database_response_bytes: byteSize(qnaDatabase.result),
      worker_response_bytes: byteSize(qnaReadonly.result),
      worker_peak_rss_bytes: qnaReadonly.result.worker_peak_rss_bytes ?? null,
      worker_peak_rss_mib: qnaReadonly.result.worker_peak_rss_bytes == null ? null : rounded(qnaReadonly.result.worker_peak_rss_bytes / MIB),
      model_gateway_ms: null,
      model_gateway_note: 'No model gateway was called; this isolates SQLite and application overhead.',
      explain_query_plan: explainQueryPlan(db, qnaSql, qnaParameters)
    },
    full_field_fts_backfill: {
      queued_rows: queued.queued_rows,
      processed_rows: processedRows,
      inserted_documents_during_flush: insertedDocuments,
      final_document_count: documentCount,
      batch_size: options.batchSize,
      batches: batchDurations.length,
      queue_ms: rounded(queueMs),
      batch_timing: summarize(batchDurations),
      coverage_verification_ms: rounded(coverageMs),
      total_ms: rounded(backfillMs),
      coverage_status: coverage.status,
      policy_table_count: coverage.tables.length,
      field_count: coverage.totals.field_count,
      ready_field_count: coverage.totals.ready_field_count,
      field_coverage_percent: rounded(
        coverage.totals.field_count
          ? (coverage.totals.ready_field_count / coverage.totals.field_count) * 100
          : 100
      )
    },
    all_record_fts_search: {
      keywords: allRecordInput.keywords,
      database_page_query: ftsPageDatabase.timing,
      in_process_search_and_evidence: allRecordService.timing,
      readonly_worker_end_to_end: allRecordReadonly.timing,
      total_matches: allRecordService.result.pagination.total,
      returned_entities: allRecordService.result.items.length,
      response_bytes: byteSize(allRecordService.result),
      readonly_response_bytes: byteSize(allRecordReadonly.result),
      fast_top_k_readonly: allRecordFastReadonly.timing,
      fast_top_k_response_bytes: byteSize(allRecordFastReadonly.result),
      worker_peak_rss_bytes: allRecordReadonly.result.performance?.worker_peak_rss_bytes ?? null,
      worker_peak_rss_mib: allRecordReadonly.result.performance?.worker_peak_rss_bytes == null ? null : rounded(allRecordReadonly.result.performance.worker_peak_rss_bytes / MIB),
      explain_query_plan: explainQueryPlan(
        db,
        allRecordPlans.page.sql,
        allRecordPlans.page.parameters
      )
    },
    candidate_hybrid_search: {
      keywords: candidateSearchInput.keywords,
      structured_filters: { archived: 'exclude', location: 'Shanghai' },
      in_process_search_and_evidence: candidateSearchService.timing,
      readonly_worker_end_to_end: candidateSearchReadonly.timing,
      total_matches: candidateSearchService.result.pagination.total,
      returned_candidates: candidateSearchService.result.items.length,
      response_bytes: byteSize(candidateSearchService.result),
      readonly_response_bytes: byteSize(candidateSearchReadonly.result),
      fast_top_k_readonly: candidateFastReadonly.timing,
      fast_top_k_response_bytes: byteSize(candidateFastReadonly.result),
      worker_peak_rss_bytes: candidateSearchReadonly.result.performance?.worker_peak_rss_bytes ?? null,
      worker_peak_rss_mib: candidateSearchReadonly.result.performance?.worker_peak_rss_bytes == null ? null : rounded(candidateSearchReadonly.result.performance.worker_peak_rss_bytes / MIB),
      explain_query_plan: explainQueryPlan(db, candidatePlans.page.sql, candidatePlans.page.parameters)
    },
    wide_query_matrix: wideSearch
  }

  console.log(JSON.stringify(result, null, 2))
} finally {
  try { db?.close() } catch {}
  if (options.keep) {
    console.error(`[v8-benchmark] kept anonymous database at ${databasePath}`)
  } else {
    safeTemporaryCleanup(temporaryDirectory)
  }
}
