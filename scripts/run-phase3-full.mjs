#!/usr/bin/env node
// 阶段 3 全量守护进程：跑解析脚本 + 每 60 秒写心跳，便于断点续跑与进度观测。
//
//   node scripts/run-phase3-full.mjs
//
// 心跳写入 data/phase3-full-progress.jsonl，解析结果写入数据库
// candidate_profile_sections（parser=origin-section-parse-v1）。
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
mkdirSync(DATA, { recursive: true })

const progressPath = resolve(DATA, 'phase3-full-progress.jsonl')
const logPath = resolve(DATA, 'phase3-full.log')
const errPath = resolve(DATA, 'phase3-full.err.log')

writeFileSync(progressPath, '')

const args = process.argv.slice(2)
const child = spawn('node', [
  'scripts/parse-origin-resume-sections.mjs',
  '--limit', process.env.PHASE3_LIMIT ?? '97948',
  '--batch-size', process.env.PHASE3_BATCH ?? '10',
  '--concurrency', process.env.PHASE3_CONCURRENCY ?? '5',
  '--apply',
  '--report', 'data/phase3-full-report.json',
  ...args
], {
  cwd: ROOT,
  stdio: ['ignore', openSync(logPath, 'a'), openSync(errPath, 'a')],
  windowsHide: true
})

writeFileSync(resolve(DATA, 'phase3-full.pid'), String(child.pid))
console.log(JSON.stringify({ started: child.pid, log: logPath, progress: progressPath }, null, 1))

const startedAt = Date.now()
let finished = false
child.on('exit', (code, signal) => {
  finished = true
  appendFileSync(progressPath, `${JSON.stringify({ at: new Date().toISOString(), event: 'exit', code, signal })}\n`)
})

// 心跳放在独立子进程里：主进程要跑同步 SQLite 查询（candidate_attachments 是
// 22.8 万行 + json_extract），如果自己写心跳会把事件循环堵住，心跳就断了。
const heartbeat = spawn('node', ['scripts/phase3-heartbeat.mjs', progressPath, String(startedAt)], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true
})
heartbeat.stderr.on('data', (chunk) => process.stderr.write(`[heartbeat] ${chunk}`))

while (!finished) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 60_000))
}

try { heartbeat.kill() } catch {}
console.log(JSON.stringify({ finished: true, elapsedMin: Number(((Date.now() - startedAt) / 60000).toFixed(1)) }, null, 1))
