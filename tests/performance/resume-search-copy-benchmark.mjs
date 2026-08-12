import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  buildBusinessCandidateEvidencePlan,
  buildBusinessCandidatePlans,
  getBusinessSearchStatus,
  mapBusinessCandidateResults
} from '../../server/business-search.js'
import {
  buildResumeSearchPlans,
  getResumeSearchStatus,
  normalizeResumeSearch,
  searchCandidateResumesIndexed
} from '../../server/resume-search.js'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_QUERIES = ['TypeScript', '项目', '本科']
const VALID_ENGINES = new Set(['before', 'after', 'after_exact'])

function usage() {
  return [
    'Usage: node tests/performance/resume-search-copy-benchmark.mjs --database=<sqlite-copy> [options]',
    '  --database=PATH       Required WAL-consistent SQLite copy; production data/recruitment.db is rejected',
    '  --hot-runs=N          In-process runs per query and engine (default: 10)',
    '  --cold-runs=N         Fresh-process runs per query and engine (default: 5)',
    '  --engines=LIST        before,after,after_exact (default: all)',
    '  --queries=LIST        Comma-separated non-sensitive benchmark terms',
    '  --help                Show this message'
  ].join('\n')
}

function integer(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function parseArguments(argv) {
  const options = {
    database: null,
    hotRuns: 10,
    coldRuns: 5,
    engines: ['before', 'after', 'after_exact'],
    queries: DEFAULT_QUERIES,
    child: null,
    query64: null
  }
  for (const argument of argv) {
    if (argument === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (argument.startsWith('--database=')) options.database = resolve(argument.slice('--database='.length))
    else if (argument.startsWith('--hot-runs=')) {
      options.hotRuns = integer(argument.slice('--hot-runs='.length), 'hot-runs', 3, 100)
    } else if (argument.startsWith('--cold-runs=')) {
      options.coldRuns = integer(argument.slice('--cold-runs='.length), 'cold-runs', 1, 30)
    } else if (argument.startsWith('--engines=')) {
      options.engines = argument.slice('--engines='.length).split(',').filter(Boolean)
      if (!options.engines.length || options.engines.some((engine) => !VALID_ENGINES.has(engine))) {
        throw new Error('engines must contain only before, after, and after_exact.')
      }
    } else if (argument.startsWith('--queries=')) {
      options.queries = argument.slice('--queries='.length).split(',').map((value) => value.trim()).filter(Boolean)
      if (!options.queries.length || options.queries.length > 10 || options.queries.some((value) => value.length > 80)) {
        throw new Error('queries must contain between 1 and 10 terms of at most 80 characters.')
      }
    } else if (argument.startsWith('--child=')) options.child = argument.slice('--child='.length)
    else if (argument.startsWith('--query64=')) options.query64 = argument.slice('--query64='.length)
    else throw new Error(`Unknown argument: ${argument}\n${usage()}`)
  }
  if (!options.database) throw new Error(`--database is required.\n${usage()}`)
  if (!existsSync(options.database)) throw new Error(`Database copy does not exist: ${options.database}`)
  const formalPath = resolve('data/recruitment.db').toLocaleLowerCase('en-US')
  if (options.database.toLocaleLowerCase('en-US') === formalPath) {
    throw new Error('Refusing to benchmark the formal data/recruitment.db. Create a WAL-consistent copy first.')
  }
  if (options.child && !VALID_ENGINES.has(options.child)) throw new Error('Invalid child engine.')
  return options
}

function openReadonly(database) {
  const db = new DatabaseSync(database, { readOnly: true })
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
  return db
}

function digestItems(items) {
  return createHash('sha256')
    .update(items.map((item) => String(item.candidate_id)).join('\n'))
    .digest('hex')
}

function runBefore(db, query) {
  const search = normalizeResumeSearch({ q: query, page_size: 20, include_total: true, fast: false })
  const plans = buildBusinessCandidatePlans(search)
  const rows = db.prepare(plans.page.sql).all(...plans.page.parameters)
  const visibleRows = rows.slice(0, search.page_size)
  const evidencePlan = buildBusinessCandidateEvidencePlan(plans.search, visibleRows.map((row) => row.candidate_id))
  const evidence = evidencePlan ? db.prepare(evidencePlan.sql).all(...evidencePlan.parameters) : []
  const items = mapBusinessCandidateResults(plans.search, visibleRows, evidence)
  return {
    item_count: items.length,
    total: Number(rows[0]?.total ?? 0),
    ordered_result_digest: digestItems(items)
  }
}

function runAfter(db, query, exact) {
  const result = searchCandidateResumesIndexed(db, {
    q: query,
    page_size: 20,
    fast: !exact,
    include_total: exact
  })
  return {
    item_count: result.items.length,
    total: result.pagination.total,
    has_more: result.pagination.has_more,
    ordered_result_digest: digestItems(result.items),
    phases_ms: result.performance
  }
}

function runEngine(db, engine, query) {
  if (engine === 'before') return runBefore(db, query)
  return runAfter(db, query, engine === 'after_exact')
}

function rounded(value) {
  return Number(Number(value).toFixed(3))
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
  return {
    runs: sorted.length,
    min_ms: rounded(sorted[0]),
    p50_ms: rounded(percentile(0.5)),
    p95_ms: rounded(percentile(0.95)),
    max_ms: rounded(sorted.at(-1)),
    mean_ms: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  }
}

function explain(db, engine, query) {
  const search = normalizeResumeSearch({
    q: query,
    page_size: 20,
    fast: engine !== 'before' && engine !== 'after_exact',
    include_total: engine === 'before' || engine === 'after_exact'
  })
  const plan = engine === 'before'
    ? buildBusinessCandidatePlans(search).page
    : buildResumeSearchPlans(search).page
  return db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.parameters).map((row) => ({
    id: Number(row.id),
    parent: Number(row.parent),
    detail: String(row.detail)
  }))
}

function runChild(options) {
  if (!options.query64) throw new Error('--query64 is required in child mode.')
  const query = Buffer.from(options.query64, 'base64url').toString('utf8')
  const db = openReadonly(options.database)
  try {
    const started = performance.now()
    const result = runEngine(db, options.child, query)
    process.stdout.write(JSON.stringify({ duration_ms: performance.now() - started, result }))
  } finally {
    db.close()
  }
}

function benchmarkHot(db, engine, query, runs) {
  runEngine(db, engine, query)
  const durations = []
  let result
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    result = runEngine(db, engine, query)
    durations.push(performance.now() - started)
  }
  return { timing: summarize(durations), result }
}

function benchmarkCold(options, engine, query) {
  const durations = []
  let result
  const query64 = Buffer.from(query, 'utf8').toString('base64url')
  for (let index = 0; index < options.coldRuns; index += 1) {
    const started = performance.now()
    const child = spawnSync(process.execPath, [
      SCRIPT_PATH,
      `--database=${options.database}`,
      `--child=${engine}`,
      `--query64=${query64}`
    ], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    })
    durations.push(performance.now() - started)
    if (child.error) throw child.error
    if (child.status !== 0) throw new Error(child.stderr || `Cold child exited with ${child.status}.`)
    const payload = JSON.parse(child.stdout)
    result = payload.result
  }
  return { timing: summarize(durations), result }
}

function main(options) {
  const db = openReadonly(options.database)
  try {
    const results = {}
    for (const query of options.queries) {
      results[query] = {}
      for (const engine of options.engines) {
        results[query][engine] = {
          hot_connection: benchmarkHot(db, engine, query, options.hotRuns),
          process_cold: benchmarkCold(options, engine, query),
          query_plan: explain(db, engine, query)
        }
      }
      if (results[query].after && results[query].after_exact) {
        results[query].after_fast_equals_exact =
          results[query].after.hot_connection.result.ordered_result_digest ===
          results[query].after_exact.hot_connection.result.ordered_result_digest
      }
    }
    const output = {
      generated_at: new Date().toISOString(),
      database: {
        bytes: statSync(options.database).size,
        query_only: true,
        formal_database_rejected: true
      },
      runs: { hot: options.hotRuns, process_cold: options.coldRuns },
      index_status: {
        resume: getResumeSearchStatus(db),
        business: getBusinessSearchStatus(db)
      },
      results
    }
    console.log(JSON.stringify(output, null, 2))
  } finally {
    db.close()
  }
}

try {
  const options = parseArguments(process.argv.slice(2))
  if (options.child) runChild(options)
  else main(options)
} catch (error) {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
}
