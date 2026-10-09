#!/usr/bin/env node
// 全量向量构建守护：向量构建对网关瞬时故障很敏感（单批 3 次重试耗尽后整轮中止），
// 而 embedding-cache.sqlite 让重跑代价很低——已算过的切片会直接复用。
// 本包装器在失败后自动重跑，直到 maintenance-status.json 变成 ready 或达到尝试上限。
//
//   node scripts/run-vector-build.mjs
//
// 环境变量：VECTOR_BUILD_ATTEMPTS（默认 8）、VECTOR_BUILD_RETRY_DELAY_MS（默认 60000）

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATABASE = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(ROOT, 'data', 'recruitment.db')
const DIRECTORY = process.env.SEARCH_VECTOR_DIRECTORY ? resolve(process.env.SEARCH_VECTOR_DIRECTORY) : resolve(ROOT, 'data', 'search-vectors')
const STATUS_PATH = resolve(DIRECTORY, 'maintenance-status.json')
const ATTEMPTS = Number(process.env.VECTOR_BUILD_ATTEMPTS ?? 8)
const RETRY_DELAY_MS = Number(process.env.VECTOR_BUILD_RETRY_DELAY_MS ?? 60_000)
const CONCURRENCY = String(process.env.SEARCH_VECTOR_MAINTENANCE_CONCURRENCY ?? 4)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const readState = () => {
  try { return JSON.parse(readFileSync(STATUS_PATH, 'utf8')).state ?? null } catch { return null }
}
const log = (value) => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }))

log({ event: 'guard_start', attempts: ATTEMPTS, retry_delay_ms: RETRY_DELAY_MS, concurrency: CONCURRENCY, database: DATABASE, directory: DIRECTORY })

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  log({ event: 'attempt_start', attempt })
  const exitCode = await new Promise((done) => {
    const child = spawn(process.execPath, [
      'scripts/search-vector-maintenance.mjs',
      '--formal',
      '--database', DATABASE,
      '--directory', DIRECTORY,
      '--dimensions', '1024',
      '--concurrency', CONCURRENCY
    ], { cwd: ROOT, windowsHide: true, stdio: 'inherit' })
    child.once('error', () => done(-1))
    child.once('exit', (code) => done(code ?? -1))
  })
  const state = readState()
  log({ event: 'attempt_end', attempt, exit_code: exitCode, maintenance_state: state })
  if (state === 'ready' || exitCode === 0) {
    log({ event: 'guard_done', attempt, result: state === 'ready' ? 'ready' : 'exit_zero' })
    process.exit(0)
  }
  if (attempt < ATTEMPTS) {
    log({ event: 'retry_wait', attempt, delay_ms: RETRY_DELAY_MS })
    await sleep(RETRY_DELAY_MS)
  }
}

log({ event: 'guard_exhausted', attempts: ATTEMPTS })
process.exit(1)
