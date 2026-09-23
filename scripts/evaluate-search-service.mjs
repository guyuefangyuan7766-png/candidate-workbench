// Actual resident-worker evaluation. This script only opens its newly created
// anonymous database. Fault injection is separately labelled and never scored
// as a remote model/retrieval success.
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/database.js'
import { HybridSearchService } from '../server/hybrid-search-service.js'
import { createSearchModelAdapters } from '../server/search-model-adapters.js'
import { parseRuleQueryPlan } from '../server/search-query-plan.js'
import { normalizeResumeSearch, searchCandidateResumesIndexed } from '../server/resume-search.js'
import { buildVectorIndex } from '../server/search-vector-maintenance.js'
import { VECTOR_CHUNK_VERSION } from '../server/search-vector-store.js'
import { seedAnonymousSearch, anonymousQueries } from '../tests/fixtures/anonymous-search.mjs'
import { conditionPlanCorrect, rankingMetrics } from '../tests/fixtures/search-metrics.mjs'

if (!process.argv.includes('--remote-anonymous')) throw new Error('Explicit --remote-anonymous is required')
const outputName = process.argv.find(value => value.startsWith('--output-name='))?.slice('--output-name='.length) ?? 'search-service-anonymous-remote.json'
if (!/^search-service-[a-z0-9-]+\.json$/.test(outputName)) throw new Error('Invalid anonymous evidence filename')
// Only this evaluation process and its worker receive these search settings.
process.env.SEARCH_QUERY_MODEL = 'qwen3.8-flash'
process.env.SEARCH_QUERY_REASONING_EFFORT = 'none'
process.env.SEARCH_QUERY_TIMEOUT_MS = '12000'
const root = mkdtempSync(join(tmpdir(), 'shicai-service-evaluation-'))
const databasePath = join(root, 'anonymous.db')
const vectorDirectory = join(root, 'vectors')
const db = openDatabase(databasePath)
const facts = seedAnonymousSearch(db)
const queries = anonymousQueries(facts)
const adapters = createSearchModelAdapters()
const service = new HybridSearchService({ databasePath, vectorDirectory, remoteEnabled: true })
const started = performance.now()
const rows = []
let peakRss = process.memoryUsage().rss
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 100)
const percentile = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b)
  return { p50: sorted[Math.floor(sorted.length * .5)] ?? null, p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null }
}
const mean = values => { const finite = values.filter(Number.isFinite); return finite.length ? finite.reduce((a,b) => a+b,0)/finite.length : null }
const bytes = path => statSync(path).isDirectory() ? readdirSync(path).reduce((sum, item) => sum + bytes(join(path, item)), 0) : statSync(path).size
const safeCode = error => typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'anonymous_evaluation_failed'
function legacyProjection(normalized) {
  const terms = normalized.concepts.map(concept => ({ kind: 'term', text: concept.label, match: 'concept', evidence_scope: 'self' }))
  const must = normalized.match_mode === 'any' && terms.length > 1 ? [{ kind: 'any', scope: 'candidate', children: terms }] : terms
  for (const [key, field, op] of [['location','current_location','eq'],['min_years','years','gte'],['max_years','years','lte']]) {
    if (normalized[key] !== undefined) must.push({ kind: 'filter', field, op, value: normalized[key] })
  }
  return { version: 1, must, should: [], minimum_should_match: 0, must_not: [], unresolved: [] }
}
async function injectFaults() {
  const q = queries.find(query => query.query === 'Unity 不要外包')
  const failures = []
  for (const stage of ['planning', 'embedding', 'rerank', 'cancel']) {
    const controller = new AbortController()
    const injected = new HybridSearchService({ db, vectorDirectory, remoteEnabled: true, adapters: {
      configured: { planner: true, embedding: true, rerank: true },
      planner: async query => {
        if (stage === 'cancel') controller.abort()
        if (stage === 'planning') throw new Error('anonymous injected planner failure')
        const { metadata, ...plan } = parseRuleQueryPlan(query); return plan
      },
      embedTexts: async texts => {
        if (stage === 'embedding') throw new Error('anonymous injected embedding failure')
        return texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0))
      },
      rerankDocuments: async (_query, documents) => {
        if (stage === 'rerank') throw new Error('anonymous injected rerank failure')
        return documents.map((_, index) => ({ index, relevance_score: 1-index/100 }))
      }
    } })
    try {
      const result = await injected.search({ q: q.query, page_size: 50 }, { signal: controller.signal })
      const ids = result.items.map(item => item.candidate_id)
      const correctIds = ids.length === q.expected.length && ids.every(id => q.expected.includes(id))
      failures.push({ stage, injected: true, pass: correctIds && (stage === 'planning' ? result.query.plan_source === 'rules' : result.degradation.some(item => item.stage === stage)), degradation: result.degradation.map(item => item.code) })
    } catch (error) { failures.push({ stage, injected: true, pass: stage === 'cancel' && error.code === 'search_cancelled', error: safeCode(error) }) }
    finally { await injected.close() }
  }
  return failures
}
try {
  let indexEmbeddingCalls = 0
  const indexStart = performance.now()
  const built = await buildVectorIndex({ databasePath, directory: vectorDirectory, dimensions: 1024, embedTexts: (...args) => { indexEmbeddingCalls++; return adapters.embedTexts(...args) } })
  const indexBuildMs = performance.now()-indexStart
  const warmStart = performance.now()
  const warmState = await service.warmup()
  const warmupMs = performance.now()-warmStart
  for (const q of queries) {
    const baselineStart = performance.now()
    const baselineResult = searchCandidateResumesIndexed(db, { q: q.query, page_size: 50, fast: false })
    const baselineMs = performance.now()-baselineStart
    const baselinePlan = legacyProjection(normalizeResumeSearch({ q: q.query, page_size: 50, fast: false }))
    const baseline = { ...rankingMetrics(baselineResult.items.map(item => item.candidate_id), q.expected), ms: baselineMs, condition_correct: conditionPlanCorrect(baselinePlan, q), declared_plan: baselinePlan }
    const before = performance.now()
    try {
      // Every q is unique. No cursor is sent and the warmed worker only reuses
      // its index, never a query result or query vector.
      const result = await service.search({ q: q.query, page_size: 50 })
      const elapsed = performance.now()-before
      const token = JSON.parse(Buffer.from(result.pagination.current_cursor, 'base64url').toString())
      const plan = service.cache.get(token.id).cache.plan
      const evidence = result.items.flatMap(item => item.evidence)
      const correctEvidence = evidence.filter(item => item.ownership === 'self' && facts.some(fact => fact.id === item.candidate_id && [fact.id, fact.section].includes(item.source_row_id))).length
      rows.push({ id: q.id, query: q.query, expected_count: q.expected.length, expected_plan: { must: q.must, must_not: q.must_not }, baseline,
        enhanced: { ...rankingMetrics(result.items.map(item => item.candidate_id), q.expected), ms: elapsed, condition_correct: conditionPlanCorrect({ ...plan, must: plan.must.filter(node => !(node.kind === 'filter' && node.field === 'archived' && node.op === 'eq' && node.value === 'include')) }, q), plan_source: plan.metadata.source,
          plan_warnings: plan.metadata.warnings, degradation: result.degradation.map(item => ({ code: item.code, stage: item.stage })),
          completeness: result.completeness, performance: result.performance, evidence_count: evidence.length, evidence_correct: correctEvidence, actual_plan: plan }, rss: process.memoryUsage().rss })
    } catch (error) {
      rows.push({ id: q.id, query: q.query, expected_count: q.expected.length, baseline, enhanced: { ...rankingMetrics([], q.expected), ms: performance.now()-before, failed: safeCode(error), condition_correct: false, plan_source: null, evidence_count: 0, evidence_correct: 0 }, rss: process.memoryUsage().rss })
    }
    console.log(JSON.stringify({ completed: rows.length, total: queries.length, source: rows.at(-1).enhanced.plan_source, ms: Math.round(rows.at(-1).enhanced.ms), condition_correct: rows.at(-1).enhanced.condition_correct }))
  }
  const finalState = service.status()
  const failures = await injectFaults()
  const summarize = name => ({
    condition_accuracy: rows.filter(row => row[name].condition_correct).length/rows.length,
    recall50: mean(rows.map(row => row[name].recall50)), precision10: mean(rows.map(row => row[name].precision10)),
    ndcg10: mean(rows.map(row => row[name].ndcg10)), mrr: mean(rows.map(row => row[name].mrr)), latency_ms: percentile(rows.map(row => row[name].ms))
  })
  const evidenceCount = rows.reduce((sum,row) => sum+row.enhanced.evidence_count,0)
  const report = { anonymous: true, actual_service: 'HybridSearchService', concurrency: 1, unique_cold_queries: new Set(queries.map(query => query.query)).size, query_cache_used: false,
    at: new Date().toISOString(), node: process.version, candidates: facts.length, queries: queries.length,
    model: { planner: 'qwen3.8-flash', reasoning_effort: 'none', embedding: 'text-embedding-v4', rerank: 'qwen3-rerank', dimensions: 1024, chunk_version: VECTOR_CHUNK_VERSION },
    budgets_ms: { query: 18000, planner: 12000, embedding: 5000, rerank: 5000 },
    baseline: summarize('baseline'), enhanced: { ...summarize('enhanced'), model_accepted: rows.filter(row => row.enhanced.plan_source === 'model').length,
      fallback: rows.filter(row => row.enhanced.plan_source === 'rules').length, failed: rows.filter(row => row.enhanced.failed).length,
      degraded_queries: rows.filter(row => row.enhanced.degradation?.length).length,
      vector_result_queries: rows.filter(row => row.enhanced.performance?.vector_candidates > 0).length,
      reranked_queries: rows.filter(row => row.enhanced.completeness?.ranking === 'hybrid_reranked').length,
      evidence_count: evidenceCount, evidence_ownership_accuracy: evidenceCount ? rows.reduce((sum,row) => sum+row.enhanced.evidence_correct,0)/evidenceCount : null },
    warmup_ms: warmupMs, index_build_ms: indexBuildMs, index_embedding_calls: indexEmbeddingCalls, indexed_chunks: built.chunks,
    rss: { sampled_peak_bytes: peakRss, sampling_interval_ms: 100, scope: 'Current Node process including resident worker; separate verification child-process peak is not sampled.' },
    database_bytes: statSync(databasePath).size, index_bytes: bytes(vectorDirectory), warm_state: warmState, final_state: finalState,
    fault_injection: { separate_from_remote_evaluation: true, count: failures.length, success_rate: failures.filter(item => item.pass).length/failures.length, failures },
    duration_ms: performance.now()-started,
    limitations: [
      'Synthetic 80-person corpus and binary hand-coded qrels; not a production-scale or human expert relevance judgment.',
      'Index warmed once. Serial one-query service baseline; does not measure multi-user queue contention or throughput. Provider prompt caching is not controlled.',
      'Other authorized index maintenance was concurrently using the same existing gateway with up to eight maintenance requests (batch ten). Its latency/load is not measured or altered by this script.',
      'The service default archived=include is a neutral scope setting and is omitted only from expected condition comparison; the full actual plan is retained.',
      'Baseline condition metric compares normalized legacy declared concept labels, match mode and explicit bounds/location with the expected condition structure. It is not a general synonym-equivalence proof.',
      'Stage transport timing/counts are not exposed by the service. Successful vector candidates and hybrid_reranked explicitly evidence real remote stages; no exact worker request-count or stage-latency claim is inferred.',
      'Recall/nDCG/MRR are null for zero-positive queries; this fixed 60-query corpus has positives. Precision denominator is fixed at ten.',
      'Fault injection uses only a separately labelled inline anonymous service with stub adapters and contributes no remote quality/latency samples.'
    ], rows }
  writeFileSync(join('docs/evidence', outputName), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ baseline: report.baseline, enhanced: report.enhanced, warmup_ms: warmupMs, worker: finalState.worker, fault_injection: report.fault_injection, rss: report.rss, index_bytes: report.index_bytes }))
} catch (error) {
  console.log(JSON.stringify({ error: safeCode(error), completed: rows.length }))
  process.exitCode = 1
} finally { clearInterval(sample); await service.close(); db.close() }
