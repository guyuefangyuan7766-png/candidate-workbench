#!/usr/bin/env node
// 阶段 3 全量守护进程：跑解析脚本 + 每 60 秒写心跳，便于断点续跑与进度观测。
//
//   node scripts/run-phase3-full.mjs
//
// 心跳写入 data/phase3-full-progress.jsonl，解析结果写入数据库
// candidate_profile_sections（parser=origin-section-parse-v1）。
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
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

function snapshot() {
  const db = new DatabaseSync(resolve(DATA, 'recruitment.db'), { readOnly: true })
  const stats = db.prepare(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT candidate_id) AS candidates
    FROM candidate_profile_sections
    WHERE archived_at IS NULL AND json_extract(structured_data, '$.parser') = 'origin-section-parse-v1'
  `).get()
  const remaining = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_attachments a
    JOIN candidates c ON c.id = a.candidate_id
    WHERE a.attachment_type = 'resume_origin'
      AND a.mime_type IN ('text/html','text/plain','application/pdf')
      AND COALESCE(c.archived_at, '') = ''
      AND NOT EXISTS (
        SELECT 1 FROM candidate_profile_sections p
        WHERE p.candidate_id = a.candidate_id AND p.archived_at IS NULL
          AND json_extract(p.structured_data, '$.parser') = 'origin-section-parse-v1'
      )
  `).get().n
  db.close()
  return { ...stats, remaining }
}

const startedAt = Date.now()
let finished = false
child.on('exit', (code, signal) => {
  finished = true
  appendFileSync(progressPath, `${JSON.stringify({ at: new Date().toISOString(), event: 'exit', code, signal, ...snapshot() })}\n`)
})

while (!finished) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 60_000))
  if (finished) break
  const line = { at: new Date().toISOString(), elapsedMin: Number(((Date.now() - startedAt) / 60000).toFixed(1)), ...snapshot() }
  appendFileSync(progressPath, `${JSON.stringify(line)}\n`)
}

const final = snapshot()
console.log(JSON.stringify({ finished: true, ...final, elapsedMin: Number(((Date.now() - startedAt) / 60000).toFixed(1)) }, null, 1))
