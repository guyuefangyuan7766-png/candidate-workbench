// Opt-in anonymous gateway evaluation. Always creates its own synthetic database.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/database.js'
import { createSearchModelAdapters } from '../server/search-model-adapters.js'
import { parseQueryPlan } from '../server/search-query-plan.js'
import { createVectorStore } from '../server/search-vector-store.js'
import { buildVectorIndex } from '../server/search-vector-maintenance.js'
import { hybridSearch } from '../server/hybrid-search.js'
import { seedAnonymousSearch, anonymousQueries } from '../tests/fixtures/anonymous-search.mjs'
import { conditionPlanCorrect, rankingMetrics } from '../tests/fixtures/search-metrics.mjs'

if (!process.argv.includes('--remote-anonymous')) throw new Error('Explicit --remote-anonymous is required')
const root = mkdtempSync(join(tmpdir(), 'shicai-query-cold-'))
const databasePath = join(root, 'anonymous.db')
const directory = join(root, 'vectors')
const db = openDatabase(databasePath)
const adapters = createSearchModelAdapters()
const facts = seedAnonymousSearch(db)
const queries = anonymousQueries(facts)
const rows = []
const calls = { index_embedding: 0, planner: 0, embedding: 0, rerank: 0 }
const percentile = values => {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a,b) => a-b)
  return { p50: sorted[Math.floor(sorted.length * .5)] ?? null, p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null }
}
let store
try {
  await buildVectorIndex({ databasePath, directory, embedTexts: async (...args) => { calls.index_embedding++; return adapters.embedTexts(...args) } })
  store = createVectorStore({ directory, readOnly: true })
  let cursor = 0
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < queries.length) {
      const q = queries[cursor++]
      const start = performance.now()
      const signal = AbortSignal.timeout(18000)
      const timing = {}
      const errors = {}
      const timed = async (name, fn) => {
        calls[name]++
        const before = performance.now()
        try { return await fn() } catch (error) { errors[name] = error.code ?? 'anonymous_eval_failed'; throw error } finally { timing[name] = performance.now()-before }
      }
      // Concurrent raw-query embedding is independent of plan semantics and has no cache.
      const embedding = timed('embedding', () => adapters.embedTexts([q.query], { dimensions: 1024, signal })).then(value => ({ value }), error => ({ error }))
      let plan
      try {
        plan = await parseQueryPlan(q.query, { signal, planner: (...args) => timed('planner', () => adapters.planner(...args)) })
        const vector = await embedding
        const result = await hybridSearch(db, { plan, query: q.query, page_size: 50, vectorStore: store, signal,
          embedTexts: async () => { if (vector.error) throw vector.error; return vector.value },
          rerankDocuments: (...args) => timed('rerank', () => adapters.rerankDocuments(...args)),
        })
        rows.push({ id: q.id, query: q.query, ms: performance.now()-start, timing, errors, plan_source: plan.metadata.source, plan_warnings: plan.metadata.warnings,
          condition_correct: conditionPlanCorrect(plan, q), degradation: result.degradation.map(item => item.code),
          ...rankingMetrics(result.items.map(item => item.candidate_id), q.expected), actual_plan: plan })
      } catch (error) {
        await embedding
        rows.push({ id: q.id, query: q.query, ms: performance.now()-start, timing, errors, plan_source: plan?.metadata.source ?? null, failed: error.code ?? 'anonymous_eval_failed', condition_correct: false })
      }
      console.log(JSON.stringify({ completed: rows.length, total: queries.length, id: q.id, source: rows.at(-1).plan_source, correct: rows.at(-1).condition_correct, ms: Math.round(rows.at(-1).ms) }))
    }
  }))
  const mean = key => {
    const values = rows.map(row => row[key]).filter(value => Number.isFinite(value))
    return values.length ? values.reduce((sum,value) => sum+value,0)/values.length : null
  }
  const summary = { total: rows.length, model_accepted: rows.filter(row => row.plan_source === 'model').length, fallback: rows.filter(row => row.plan_source === 'rules').length,
    failed: rows.filter(row => row.failed).length, condition_correct: rows.filter(row => row.condition_correct).length,
    degraded: rows.filter(row => row.degradation?.length).length, latency_ms: percentile(rows.map(row => row.ms)),
    stage_ms: Object.fromEntries(['planner','embedding','rerank'].map(name => [name, percentile(rows.map(row => row.timing[name]))])),
    recall50: mean('recall50'), precision10: mean('precision10'), ndcg10: mean('ndcg10'), mrr: mean('mrr') }
  const report = { anonymous: true, cold_queries: true, query_cache: false, unique_queries: new Set(queries.map(q => q.query)).size, concurrency: 2, at: new Date().toISOString(),
    model: process.env.SEARCH_QUERY_MODEL ?? 'gpt-6-astra', reasoning_effort: process.env.SEARCH_QUERY_REASONING_EFFORT ?? 'low',
    budgets_ms: { query: 18000, planner: Math.min(Number(process.env.SEARCH_QUERY_TIMEOUT_MS) || 30000,30000), embedding: 5000, rerank: 5000 },
    limitations: ['Synthetic 80-candidate binary qrels; not a production-data quality claim.', 'Fresh temporary index and unique cold application queries; provider prompt caching is not controlled.'], calls, summary, rows }
  writeFileSync('docs/evidence/search-query-cold-60.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(summary))
} catch {
  console.log(JSON.stringify({ error: 'anonymous_cold_evaluation_failed' }))
  process.exitCode = 1
} finally { store?.close(); db.close() }
