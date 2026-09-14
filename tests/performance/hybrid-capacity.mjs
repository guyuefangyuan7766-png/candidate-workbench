import { mkdtempSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openDatabase } from '../../server/database.js'
import { hybridSearch } from '../../server/hybrid-search.js'
import { parseRuleQueryPlan } from '../../server/search-query-plan.js'
import { HybridSearchService } from '../../server/hybrid-search-service.js'
const result = []
for (const count of [10000, 100000]) {
  const dir = mkdtempSync(join(tmpdir(), 'anonymous-search-capacity-'))
  const file = join(dir, 'anonymous.db')
  const db = openDatabase(file, { synchronizeSearch: false })
  const start = performance.now()
  const insert = db.prepare(
    "INSERT INTO candidates(id,name,current_title,location,years_experience,created_at,updated_at) VALUES(?,?,'Unity 后端工程师',?,?,?,?)"
  )
  db.exec('BEGIN')
  for (let i = 0; i < count; i++)
    insert.run(
      `anonymous-${String(i).padStart(8, '0')}`,
      '匿名容量样本',
      i === count - 1 ? '上海' : '北京',
      i % 8,
      '2026-09-10',
      '2026-09-10'
    )
  db.exec('COMMIT')
  const seedMs = performance.now() - start
  const ms = []
  const plan = parseRuleQueryPlan('上海 Unity')
  for (let i = 0; i < 30; i++) {
    const t = performance.now()
    const r = await hybridSearch(db, { plan, query: '上海 Unity' })
    if (r.items.length !== 1)
      throw new Error('late qualified candidate missing')
    ms.push(performance.now() - t)
  }
  const service = new HybridSearchService({ databasePath: file })
  const cold = []
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    await service.search({ q: '上海 Unity' })
    cold.push(performance.now() - t)
  }
  await Promise.all([
    service.search({ q: '上海 Unity' }),
    service.search({ q: '上海 Unity' })
  ])
  clearInterval(timer)
  const sorted = ms.sort((a, b) => a - b)
  result.push({
    candidates: count,
    seed_ms: seedMs,
    local_p50_ms: sorted[15],
    local_p95_ms: sorted[28],
    five_new_worker_ms: cold,
    main_event_loop_ticks: ticks,
    rss_bytes: process.memoryUsage().rss,
    database_bytes: statSync(file).size,
    vector: false,
    notes:
      'Synthetic capacity only; minimal candidate profiles; new worker is not OS disk-cache eviction.'
  })
  await service.close()
  db.close()
  console.log(JSON.stringify(result.at(-1)))
}
mkdirSync(resolve('docs/evidence'), { recursive: true })
writeFileSync(
  resolve('docs/evidence/search-hybrid-capacity.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      anonymous: true,
      node: process.version,
      result
    },
    null,
    2
  )
)
