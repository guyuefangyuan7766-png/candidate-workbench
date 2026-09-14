// Anonymous-only gateway probe: no database is opened and no candidate data is read.
import { writeFileSync, mkdirSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { createSearchModelAdapters } from '../server/search-model-adapters.js'
import { parseQueryPlan, validateQueryPlan } from '../server/search-query-plan.js'
import { anonymousQueries } from '../tests/fixtures/anonymous-search.mjs'
import { conditionPlanCorrect } from '../tests/fixtures/search-metrics.mjs'

const option = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const models = option('models', 'gpt-5.6-luna,gpt-5.6-terra,gemini-3.8-flash,qwen3.8-flash').split(',')
const limit = Math.min(60, Math.max(1, Number(option('limit', '6'))))
const term = text => ({ kind: 'term', text, match: 'concept', evidence_scope: 'self' })
const novel = [
  { id: 'novel-location', query: '深圳 可观测性', must: [{ kind: 'filter', field: 'current_location', op: 'eq', value: '深圳' }, term('可观测性')] },
  { id: 'novel-or', query: '可观测性 OR 链路追踪', must: [{ kind: 'any', scope: 'candidate', children: [term('可观测性'), term('链路追踪')] }] },
  { id: 'novel-exclusion', query: '(可观测性 OR 链路追踪) AND NOT 外包', must: [{ kind: 'any', scope: 'candidate', children: [term('可观测性'), term('链路追踪')] }], must_not: [term('外包')] },
  { id: 'novel-record', query: '同一项目 可观测性 AND 链路追踪', must: [{ kind: 'all', scope: 'record', children: [term('可观测性'), term('链路追踪')] }] },
]
const queries = (process.argv.includes('--novel') ? novel : anonymousQueries([])).slice(0, limit)
const rows = []
const stats = values => {
  const ordered = values.slice().sort((a,b) => a-b)
  return { p50: ordered[Math.floor(ordered.length * .5)], p95: ordered[Math.floor(ordered.length * .95)], max: ordered.at(-1) }
}
for (const model of models) {
  let cursor = 0
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < queries.length) {
      const q = queries[cursor++]
      let proposed = null
      let validationIssue = null
      const adapter = createSearchModelAdapters({ plannerModel: model, timeoutMs: 30000, httpsRequest: (url, options, callback) => httpsRequest(url, options, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          if (response.statusCode !== 200) return
          try {
            proposed = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).choices[0].message.content)
            try { validateQueryPlan(proposed, { query: q.query }) } catch (error) { validationIssue = error.message }
          } catch { validationIssue = 'invalid_json' }
        })
        callback(response)
      }) })
      const start = performance.now()
      let errorCode = null
      const plan = await parseQueryPlan(q.query, { planner: async (...args) => {
        try { return await adapter.planner(...args) } catch (error) { errorCode = error.code ?? 'probe_failed'; throw error }
      } })
      const row = { model, id: q.id, query: q.query, milliseconds: performance.now()-start, source: plan.metadata.source, correct: conditionPlanCorrect(plan, q), error_code: errorCode, warnings: plan.metadata.warnings, plan, proposed, validation_issue: validationIssue }
      rows.push(row)
      console.log(JSON.stringify({ model, id: q.id, milliseconds: Math.round(row.milliseconds), source: row.source, correct: row.correct, error_code: errorCode, warnings: row.warnings }))
    }
  }))
}
const summary = models.map(model => {
  const selected = rows.filter(row => row.model === model)
  return { model, count: selected.length, model_accepted: selected.filter(row => row.source === 'model').length, condition_correct: selected.filter(row => row.correct).length, latency_ms: stats(selected.map(row => row.milliseconds)) }
})
const report = { anonymous: true, database_access: false, cold_queries: true, reasoning_effort: process.env.SEARCH_QUERY_REASONING_EFFORT ?? 'low', concurrency: 2, at: new Date().toISOString(), summary, rows }
mkdirSync('docs/evidence', { recursive: true })
writeFileSync(option('output', 'docs/evidence/search-query-model-probe.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(summary))
