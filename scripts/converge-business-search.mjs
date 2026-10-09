#!/usr/bin/env node
// 业务搜索索引收敛（**必须停服执行**）。
//
// 背景（docs/VECTOR_HYBRID_PLAN.md §7.1，2026-10-07 实测）：
// dirty 清零后 checkpoint 有时停在 indexing/queued，worker 会判定「回填被中断」
// 并重新排队整库约 190 万行，形成约 50 分钟一轮的循环，把 CPU 与 SQLite 占满。
// 处置：停服后用 flushBusinessSearchDirty() 清 dirty，再用
// getBusinessSearchCoverage() 重算 coverage，把 checkpoint 拉回 ready。
//
//   node scripts/converge-business-search.mjs            # 预演：只读，打印现状
//   node scripts/converge-business-search.mjs --apply    # 写库（先停服务）
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { flushBusinessSearchDirty, getBusinessSearchCoverage } from '../server/business-search.js'

const apply = process.argv.includes('--apply')
const database = resolve(process.env.DB_PATH ?? 'data/recruitment.db')
const db = new DatabaseSync(database)
db.exec('PRAGMA busy_timeout = 15000')

const checkpoint = () => db.prepare(`
  SELECT status, queued_rows, processed_rows, document_count, error_code, queue_table, queue_cursor, updated_at
  FROM search_index_checkpoints_v2 WHERE scope = 'full'
`).get()
const dirtyCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM search_index_dirty_v2').get().n)

console.log(JSON.stringify({
  at: new Date().toISOString(),
  mode: apply ? 'apply' : 'dry-run',
  database,
  checkpoint: checkpoint(),
  dirty: dirtyCount()
}))

if (apply) {
  let processedTotal = 0
  for (let round = 1; round <= 100000; round += 1) {
    const result = flushBusinessSearchDirty(db, { limit: 500 })
    processedTotal += Number(result.processed_rows ?? 0)
    const remaining = Number(result.remaining_rows ?? 0)
    if (round % 20 === 0 || remaining === 0) {
      console.log(JSON.stringify({
        at: new Date().toISOString(), round, processedTotal, remaining,
        inserted: result.inserted_documents, written: result.written_documents, removed: result.removed_documents
      }))
    }
    if (remaining === 0) break
  }
  const coverage = getBusinessSearchCoverage(db, { persist: true, includeFields: true })
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    coverage: coverage ? { ready: coverage.ready ?? null, tables: coverage.tables?.length ?? null, fields: coverage.fields?.length ?? null } : null,
    checkpoint: checkpoint(),
    dirty: dirtyCount()
  }, null, 1))
}

const finalCheckpoint = checkpoint()
const finalDirty = dirtyCount()
db.close()
if (apply && (String(finalCheckpoint?.status) !== 'ready' || finalDirty !== 0)) {
  console.error(JSON.stringify({ at: new Date().toISOString(), error: 'converge_incomplete', checkpoint: finalCheckpoint, dirty: finalDirty }))
  process.exitCode = 1
}
