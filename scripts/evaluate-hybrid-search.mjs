import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openDatabase } from '../server/database.js'
import { searchCandidateResumesIndexed } from '../server/resume-search.js'
import { parseQueryPlan } from '../server/search-query-plan.js'
import { createSearchModelAdapters } from '../server/search-model-adapters.js'
import { createVectorStore } from '../server/search-vector-store.js'
import { buildVectorIndex } from '../server/search-vector-maintenance.js'
import { hybridSearch } from '../server/hybrid-search.js'
import {
  seedAnonymousSearch,
  anonymousQueries
} from '../tests/fixtures/anonymous-search.mjs'
import {
  conditionPlanCorrect as parseCorrect,
  rankingMetrics as metric
} from '../tests/fixtures/search-metrics.mjs'

const remote = process.argv.includes('--remote-anonymous')
const concurrency = process.argv.includes('--concurrency=2') ? 2 : 1
const root = mkdtempSync(join(tmpdir(), 'shicai-anonymous-eval-'))
const file = join(root, 'anonymous.db')
const directory = join(root, 'vectors')
const db = openDatabase(file)
const facts = seedAnonymousSearch(db)
const queries = anonymousQueries(facts)
const adapters = createSearchModelAdapters({ timeoutMs: 30000 })
let store
const calls = { planner: 0, embedding: 0, embedding_texts: 0, rerank: 0 }
const started = performance.now()
const embed = async (texts, opts) => {
  calls.embedding++
  calls.embedding_texts += texts.length
  return adapters.embedTexts(texts, opts)
}
const rows = []
try {
  if (remote) {
    if (!adapters.configured.embedding)
      throw new Error('anonymous gateway configuration missing')
    await buildVectorIndex({ databasePath: file, directory, embedTexts: embed })
    store = createVectorStore({ directory, readOnly: true })
  }
  let next = 0
  let completed = 0
  const runQuery = async () => {
    while (next < queries.length) {
      const i = next++
      const q = queries[i]
      const baselineStart = performance.now()
      const baseline = searchCandidateResumesIndexed(db, {
        q: q.query,
        page_size: 50,
        fast: false
      })
      const baselineMs = performance.now() - baselineStart
      const time = performance.now()
      let modelError = null
      const plan = await parseQueryPlan(q.query, {
        planner: remote
          ? async (...args) => {
              calls.planner++
              try {
                return await adapters.planner(...args)
              } catch (e) {
                modelError = e.code ?? 'model_error'
                throw e
              }
            }
          : undefined
      })
      const result = await hybridSearch(db, {
        plan,
        query: q.query,
        page_size: 50,
        vectorStore: store,
        embedTexts: remote ? embed : undefined,
        rerankDocuments: remote
          ? async (...args) => {
              calls.rerank++
              return adapters.rerankDocuments(...args)
            }
          : undefined
      })
      const ms = performance.now() - time
      const evidence = result.items.flatMap((item) => item.evidence)
      rows[i] = {
        id: q.id,
        query: q.query,
        expected_count: q.expected.length,
        expected_plan: { must: q.must, must_not: q.must_not },
        actual_plan: plan,
        baseline: {
          ...metric(
            baseline.items.map((x) => x.candidate_id),
            q.expected
          ),
          ms: baselineMs
        },
        enhanced: {
          ...metric(
            result.items.map((x) => x.candidate_id),
            q.expected
          ),
          ms,
          condition_correct: parseCorrect(plan, q),
          plan_source: plan.metadata.source,
          model_error: modelError,
          degradation: result.degradation.map((x) => x.code),
          evidence_count: evidence.length,
          evidence_correct: evidence.filter(
            (e) =>
              e.ownership === 'self' &&
              facts.some(
                (f) =>
                  f.id === e.candidate_id &&
                  (e.source_row_id === f.id || e.source_row_id === f.section)
              )
          ).length
        },
        rss: process.memoryUsage().rss
      }
      console.log(
        JSON.stringify({
          completed: ++completed,
          total: queries.length,
          model_source: plan.metadata.source,
          condition_correct: rows[i].enhanced.condition_correct,
          ms: Math.round(ms)
        })
      )
    }
  }
  const tasks = await Promise.allSettled(
    Array.from({ length: concurrency }, runQuery)
  )
  for (const task of tasks) if (task.status === 'rejected') throw task.reason
  const mean = (items, key) => {
    const valid = items.filter((x) => x[key] !== null)
    return valid.length
      ? valid.reduce((s, x) => s + x[key], 0) / valid.length
      : null
  }
  const percentile = (items, p) =>
    [...items].sort((a, b) => a - b)[
      Math.min(items.length - 1, Math.floor(items.length * p))
    ]
  const aggregate = (key) => {
    const items = rows.map((r) => r[key])
    return {
      Recall_at_50: mean(items, 'recall50'),
      Precision_at_10: mean(items, 'precision10'),
      nDCG_at_10: mean(items, 'ndcg10'),
      MRR: mean(items, 'mrr'),
      latency_p50_ms: percentile(
        items.map((x) => x.ms),
        0.5
      ),
      latency_p95_ms: percentile(
        items.map((x) => x.ms),
        0.95
      )
    }
  }
  const failures = []
  for (const scenario of ['embedding', 'rerank', 'planning', 'cancel']) {
    const controller = new AbortController()
    if (scenario === 'cancel') controller.abort()
    try {
      const plan = await parseQueryPlan('Unity 不要外包', {
        planner:
          scenario === 'planning'
            ? async () => {
                throw new Error('injected')
              }
            : undefined,
        signal: controller.signal
      })
      const r = await hybridSearch(db, {
        plan,
        query: 'Unity 不要外包',
        page_size: 50,
        vectorStore: { status: () => ({ dimensions: 2 }), search: () => [] },
        embedTexts: async () => {
          if (scenario === 'embedding') throw new Error('injected')
          return [[1, 0]]
        },
        rerankDocuments: async (_q, docs) => {
          if (scenario === 'rerank') throw new Error('injected')
          return docs.map((_, index) => ({ index, relevance_score: 1 }))
        },
        signal: controller.signal
      })
      failures.push({
        scenario,
        pass:
          r.items.every(
            (x) => !facts.find((f) => f.id === x.candidate_id).outsourcing
          ) &&
          (scenario === 'planning'
            ? plan.metadata.source === 'rules'
            : r.degradation.some((x) => x.stage === scenario))
      })
    } catch (e) {
      failures.push({
        scenario,
        pass: scenario === 'cancel' && e.code === 'search_cancelled'
      })
    }
  }
  function size(p) {
    return readdirSync(p, { withFileTypes: true }).reduce(
      (sum, e) =>
        sum +
        (e.isDirectory()
          ? size(join(p, e.name))
          : statSync(join(p, e.name)).size),
      0
    )
  }
  const evidenceN = rows.reduce((s, r) => s + r.enhanced.evidence_count, 0)
  const standard = rows.filter((r) => r.expected_count >= 10)
  const report = {
    anonymous: true,
    remote,
    concurrency,
    budgets_ms: { planner: 30000, embedding: 5000, rerank: 5000 },
    at: new Date().toISOString(),
    node: process.version,
    candidates: facts.length,
    queries: queries.length,
    distinct_queries: new Set(queries.map((q) => q.query)).size,
    no_positive_queries: rows.filter((r) => r.expected_count === 0).length,
    precision_standard_subset: {
      queries: standard.length,
      baseline: mean(
        standard.map((r) => r.baseline),
        'precision10'
      ),
      enhanced: mean(
        standard.map((r) => r.enhanced),
        'precision10'
      )
    },
    limitations: [
      '无正例时Recall/nDCG/MRR记N/A(null)；Precision固定除以10',
      '匿名合成语料；二元相关性标注，未评估0至3等级主观相关性或真实候选人分布',
      'qrels来自独立人工编码事实规则，需业务复核；模型source成功率与包含规则回退的条件正确率分开记录',
      '旧评测按JSON属性顺序比较造成条件误判，本次使用键顺序无关比较并保存原计划供审阅'
    ],
    models: remote
      ? {
          planner: 'gpt-6-astra',
          embedding: 'text-embedding-v4',
          dimensions: 1024,
          rerank: 'qwen3-rerank'
        }
      : null,
    calls,
    baseline: aggregate('baseline'),
    enhanced: {
      ...aggregate('enhanced'),
      condition_accuracy:
        rows.filter((r) => r.enhanced.condition_correct).length / rows.length,
      evidence_ownership_accuracy: evidenceN
        ? rows.reduce((s, r) => s + r.enhanced.evidence_correct, 0) / evidenceN
        : 0,
      model_plan_success_rate:
        rows.filter((r) => r.enhanced.plan_source === 'model').length /
        rows.length
    },
    peak_rss_bytes: Math.max(...rows.map((r) => r.rss)),
    database_bytes: statSync(file).size,
    index_bytes: store ? size(directory) : 0,
    degradation_success_rate:
      failures.filter((x) => x.pass).length / failures.length,
    failures,
    duration_ms: performance.now() - started,
    rows
  }
  const dest = resolve('docs/evidence')
  mkdirSync(dest, { recursive: true })
  writeFileSync(
    join(
      dest,
      remote
        ? 'search-hybrid-anonymous-remote.json'
        : 'search-hybrid-anonymous-local.json'
    ),
    JSON.stringify(report, null, 2)
  )
  console.log(JSON.stringify({ ...report, rows: undefined }))
} finally {
  store?.close()
  db.close()
}
