#!/usr/bin/env node
// 主库 VACUUM：回收删除/重建后留下的空闲页（**必须停服执行**）。
//
//   node scripts/vacuum-database.mjs            # 预演：只报告当前页/空闲页
//   node scripts/vacuum-database.mjs --apply    # 执行 VACUUM（可能数十分钟）
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'

const apply = process.argv.includes('--apply')
const databasePath = resolve(process.env.DB_PATH ?? 'data/recruitment.db')
const db = new DatabaseSync(databasePath)
db.exec('PRAGMA busy_timeout = 15000;')

const snapshot = (label) => {
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size)
  const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count)
  const freelist = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
  console.log(JSON.stringify({
    at: new Date().toISOString(), label, page_size: pageSize, page_count: pageCount,
    freelist_count: freelist,
    allocated_bytes: pageSize * pageCount,
    live_bytes_estimate: pageSize * (pageCount - freelist),
    file_bytes: statSync(databasePath).size
  }))
}

snapshot('before')
if (apply) {
  db.exec('PRAGMA synchronous = OFF;')
  const started = Date.now()
  db.exec('VACUUM')
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA optimize;')
  console.log(JSON.stringify({ at: new Date().toISOString(), vacuum_ms: Date.now() - started }))
  snapshot('after')
}
db.close()
