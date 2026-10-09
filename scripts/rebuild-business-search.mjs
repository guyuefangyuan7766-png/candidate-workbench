#!/usr/bin/env node
// 全业务检索索引重建（**必须停服执行**）。
//
// 场景：`server/business-search.js` 的列策略收缩后（§11.4：不再索引 source_record_id /
// sort_order / sha256 / parse_status / structured_data.* / raw_payload.* 等元数据），
// 需要把既有的 2,527 万行文档按新策略重建成约 400–600 万行。
//
// 做法：直接丢掉派生的 `search_documents_v2` 与其 contentless FTS，用
// migrateBusinessSearch 重建空表，再按当前策略整库回填 + 覆盖自校验。
// 索引是纯派生数据，随时可由本脚本重建。
//
//   node scripts/rebuild-business-search.mjs            # dry-run：只报告现状与预计规模
//   node scripts/rebuild-business-search.mjs --apply    # 真正重建（数小时，纯本地）
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  BUSINESS_SEARCH_INTERNALS,
  compactBusinessSearchFts,
  flushBusinessSearchDirty,
  getBusinessSearchCoverage,
  migrateBusinessSearch,
  queueBusinessSearchBackfill
} from '../server/business-search.js'

const apply = process.argv.includes('--apply')
const databasePath = resolve(process.env.DB_PATH ?? 'data/recruitment.db')
const reportPath = resolve('data/business-search-rebuild-report.jsonl')
const batchSizeIndex = process.argv.indexOf('--batch-size')
const batchSize = batchSizeIndex >= 0 ? Number.parseInt(process.argv[batchSizeIndex + 1], 10) : 5000
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
  console.error(JSON.stringify({ error: 'invalid_batch_size', batchSize }))
  process.exit(1)
}

const db = new DatabaseSync(databasePath)
// 纯派生索引重建：关掉同步刷盘、放大缓存/批量，换来明显更快的整库回填。
// （崩溃也只是让本次重建重跑，业务数据本身不受影响。）
db.exec(`
  PRAGMA busy_timeout = 15000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -131072;
`)

const count = (table) => {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
  } catch {
    // 前一次中断的构建可能已经删掉了 FTS/文档表：按 0 处理即可。
    return 0
  }
}
const documentCount = () => count(BUSINESS_SEARCH_INTERNALS.documentsTable)
const ftsCount = () => count(BUSINESS_SEARCH_INTERNALS.ftsTable)
const dirtyCount = () => count(BUSINESS_SEARCH_INTERNALS.dirtyTable)

const serviceRunning = () => {
  const probe = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } | Measure-Object | Select-Object -ExpandProperty Count"
  ], { encoding: 'utf8', windowsHide: true })
  return Number.parseInt(String(probe.stdout ?? '0').trim() || '0', 10) > 0
}

const log = (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  console.log(line)
  if (apply) {
    mkdirSync(dirname(reportPath), { recursive: true })
    appendFileSync(reportPath, `${line}\n`)
  }
}

log({ mode: apply ? 'apply' : 'dry-run', database: databasePath, documents: documentCount(), fts: ftsCount(), dirty: dirtyCount() })

if (!apply) {
  db.close()
  process.exit(0)
}

if (serviceRunning()) {
  console.error(JSON.stringify({ error: 'service_running', message: '重建前必须先停掉 server/index.mjs' }))
  db.close()
  process.exit(1)
}
// 整库重建会覆盖所有源行，遗留的 dirty 队列条目直接清掉即可。
const dirtyBeforeRebuild = dirtyCount()
if (dirtyBeforeRebuild > 0) {
  db.exec(`DELETE FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`)
  log({ step: 'dirty_cleared', cleared: dirtyBeforeRebuild })
}

if (existsSync(`${databasePath}-wal`)) log({ note: 'wal_present', wal_bytes: existsSync(`${databasePath}-wal`) ? 1 : 0 })

const startedAt = Date.now()
log({ step: 'drop_derived' })
// 必须先删触发器：带着 AFTER DELETE 触发器删 2,500 万行文档表会逐行触发删 FTS，
// 实测卡了 10+ 分钟还在里面（CPU 一直涨、freelist 不动）。
db.exec(`
  DROP TRIGGER IF EXISTS search_documents_v2_ai;
  DROP TRIGGER IF EXISTS search_documents_v2_au;
  DROP TRIGGER IF EXISTS search_documents_v2_ad;
  DROP TABLE IF EXISTS ${BUSINESS_SEARCH_INTERNALS.ftsTable};
  DROP TABLE IF EXISTS ${BUSINESS_SEARCH_INTERNALS.documentsTable};
`)
db.exec(`DELETE FROM ${BUSINESS_SEARCH_INTERNALS.fieldCoverageTable}`)
db.exec(`DELETE FROM ${BUSINESS_SEARCH_INTERNALS.coverageTable}`)

migrateBusinessSearch(db)
log({ step: 'migrated', documents: documentCount() })

const queued = queueBusinessSearchBackfill(db, { batchSize })
log({ step: 'queued', queued_rows: Number(queued.queued_rows ?? 0), stale_deleted: queued.stale_documents_deleted, non_searchable_deleted: queued.non_searchable_documents_deleted })

let processed = 0
let written = 0
let removed = 0
let remaining = Number(queued.queued_rows ?? 0)
let round = 0
while (remaining > 0) {
  const batch = flushBusinessSearchDirty(db, { limit: batchSize })
  processed += batch.processed_rows
  written += batch.written_documents
  removed += batch.removed_documents
  remaining = batch.remaining_rows
  round += 1
  if (round % 100 === 0 || remaining === 0) {
    log({ step: 'backfill', round, processed, written, removed, remaining, documents: documentCount(), elapsed_ms: Date.now() - startedAt })
  }
  if (batch.processed_rows === 0 && remaining > 0) {
    log({ step: 'stalled', round, remaining })
    db.close()
    process.exit(1)
  }
}

// FTS 压缩 + 覆盖自校验（ready 时会把 checkpoint 置回 ready 并清掉队列）
let compactRound = 0
while (true) {
  const compact = compactBusinessSearchFts(db, { batchSize: 50_000, maxBatches: 1 })
  compactRound += 1
  if (compact.status === 'ready' || compactRound > 10_000) break
}
const coverage = getBusinessSearchCoverage(db, { persist: true, includeFields: true })
db.exec('PRAGMA synchronous = NORMAL; PRAGMA optimize;')
log({
  step: 'done',
  documents: documentCount(),
  fts: ftsCount(),
  dirty: dirtyCount(),
  freelist_pages: Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0),
  coverage_status: coverage.status,
  field_count: coverage.totals.field_count,
  ready_field_count: coverage.totals.ready_field_count,
  elapsed_ms: Date.now() - startedAt
})

db.close()
