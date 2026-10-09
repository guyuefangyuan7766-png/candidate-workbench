#!/usr/bin/env node
// 全业务检索索引**快速收缩**（必须停服执行）。
//
// 与 rebuild-business-search.mjs 的区别：不做逐文档 JS 重建，而是
//   ① 直接 DELETE 掉按新策略不再索引的元数据行（触发器已先行移除，避免逐行删 FTS）；
//   ② 用集合式 SQL 从剩余文档重建 contentless FTS；
//   ③ migrateBusinessSearch 重建触发器，覆盖自校验回到 ready。
// 25,326,858 → 5,560,863（22%）时，这条路省掉数小时的逐文档重建。
//
//   node scripts/shrink-business-search.mjs            # dry-run：报告将删除/保留多少行
//   node scripts/shrink-business-search.mjs --apply    # 执行（停服；先删触发器再删行）
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  BUSINESS_SEARCH_INTERNALS,
  compactBusinessSearchFts,
  getBusinessSearchCoverage,
  migrateBusinessSearch
} from '../server/business-search.js'

const apply = process.argv.includes('--apply')
// delete：逐行 DELETE（要维护两个二级索引，25M 行规模会跑很久）
// copy  ：把保留行复制进同构新表再换名（不做逐行删除/索引维护，明显更快）
const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex >= 0 ? String(process.argv[modeIndex + 1] ?? '').trim().toLowerCase() : 'copy'
if (!['delete', 'copy'].includes(mode)) {
  console.error(JSON.stringify({ error: 'invalid_mode', mode }))
  process.exit(1)
}
const databasePath = resolve(process.env.DB_PATH ?? 'data/recruitment.db')
const reportPath = resolve('data/business-search-shrink-report.jsonl')

// 与 server/business-search.js 的 UNINDEXED_SEARCH_COLUMNS 保持一致。
const EXCLUDED_PREDICATE = `(
  field_path LIKE 'candidate_profile_sections.structured_data%'
  OR field_path LIKE 'candidate_source_records.raw_payload%'
  OR field_path LIKE 'candidate_preferences.raw_payload%'
  OR field_path LIKE 'candidate_assessments.raw_payload%'
  OR field_path LIKE 'candidate_consents.raw_payload%'
  OR field_path LIKE 'candidate_position_sources.raw_payload%'
  OR field_path IN (
    'candidate_profile_sections.source_record_id',
    'candidate_profile_sections.sort_order',
    'candidate_profile_sections.section_type',
    'candidate_source_records.source_system',
    'candidate_source_records.source_record_id',
    'candidate_source_records.source_name',
    'candidate_source_records.record_type',
    'candidate_attachments.sha256',
    'candidate_attachments.parse_status',
    'candidate_attachments.parser_version',
    'candidate_attachments.source',
    'candidate_attachments.mime_type'
  )
)`

const db = new DatabaseSync(databasePath)
db.exec(`
  PRAGMA busy_timeout = 15000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -131072;
`)

const log = (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  console.log(line)
  if (apply) {
    mkdirSync(dirname(reportPath), { recursive: true })
    appendFileSync(reportPath, `${line}\n`)
  }
}

const countWhere = (where = '1=1') => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable} WHERE ${where}`).get().count)
const total = countWhere()
const excluded = countWhere(EXCLUDED_PREDICATE)
log({ mode: apply ? 'apply' : 'dry-run', strategy: mode, database: databasePath, total, excluded, keep: total - excluded })

if (!apply) {
  db.close()
  process.exit(0)
}

const probe = spawnSync('powershell', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } | Measure-Object | Select-Object -ExpandProperty Count"
], { encoding: 'utf8', windowsHide: true })
if (Number.parseInt(String(probe.stdout ?? '0').trim() || '0', 10) > 0) {
  console.error(JSON.stringify({ error: 'service_running', message: '收缩前必须先停掉 server/index.mjs' }))
  db.close()
  process.exit(1)
}

const startedAt = Date.now()

// ① 先移除文档表上的触发器：带着 AFTER DELETE 触发器删两千万行会逐行触发删 FTS。
log({ step: 'drop_triggers' })
db.exec(`
  DROP TRIGGER IF EXISTS search_documents_v2_ai;
  DROP TRIGGER IF EXISTS search_documents_v2_au;
  DROP TRIGGER IF EXISTS search_documents_v2_ad;
`)

// ② 收缩主体。
let remaining = 0
if (mode === 'copy') {
  const documentsTable = BUSINESS_SEARCH_INTERNALS.documentsTable
  const nextTable = `${documentsTable}_next`
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(documentsTable)?.sql ?? ''
  if (!ddl) {
    console.error(JSON.stringify({ error: 'documents_table_missing' }))
    db.close()
    process.exit(1)
  }
  const nextDdl = ddl.replace(/^CREATE TABLE\s+"?[A-Za-z0-9_]+"?/iu, `CREATE TABLE ${nextTable}`)
  log({ step: 'copy_start', excluded })
  db.exec(`DROP TABLE IF EXISTS ${nextTable}`)
  db.exec(nextDdl)
  db.exec(`INSERT INTO ${nextTable} SELECT * FROM ${documentsTable} WHERE NOT ${EXCLUDED_PREDICATE}`)
  remaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${nextTable}`).get().count)
  log({ step: 'copy_inserted', remaining, elapsed_ms: Date.now() - startedAt })
  db.exec(`DROP TABLE ${documentsTable}`)
  db.exec(`ALTER TABLE ${nextTable} RENAME TO ${documentsTable}`)
  log({ step: 'copy_swapped', remaining, elapsed_ms: Date.now() - startedAt })
} else {
  log({ step: 'delete_excluded_start', excluded })
  db.exec(`DELETE FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable} WHERE ${EXCLUDED_PREDICATE}`)
  remaining = countWhere()
  log({ step: 'delete_excluded_done', remaining, elapsed_ms: Date.now() - startedAt })
}

// ③ 重建 FTS（集合式，不逐行 JS）。
log({ step: 'rebuild_fts_start', remaining })
migrateBusinessSearch(db)
db.exec(`DELETE FROM ${BUSINESS_SEARCH_INTERNALS.ftsTable}`)
db.exec(`
  INSERT INTO ${BUSINESS_SEARCH_INTERNALS.ftsTable}(rowid, search_text)
  SELECT row_id, search_text FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}
`)
log({ step: 'rebuild_fts_done', fts: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.ftsTable}`).get().count), elapsed_ms: Date.now() - startedAt })

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
  documents: countWhere(),
  dirty: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`).get().count),
  freelist_pages: Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0),
  coverage_status: coverage.status,
  field_count: coverage.totals.field_count,
  ready_field_count: coverage.totals.ready_field_count,
  elapsed_ms: Date.now() - startedAt
})

db.close()
