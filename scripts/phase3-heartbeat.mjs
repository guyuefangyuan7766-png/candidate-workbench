#!/usr/bin/env node
// 阶段 3 全量的心跳写入器：独立进程，每 60 秒把进度追加到 jsonl。
//
//   node scripts/phase3-heartbeat.mjs <progressPath> [startedAtMs]
//
// 单独跑的原因：主流程要做同步 SQLite 查询（candidate_attachments 22.8 万行 +
// json_extract），放在同一个进程里会把事件循环堵住，心跳定时器就失效了。
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const progressPath = resolve(process.argv[2] ?? 'data/phase3-full-progress.jsonl')
const startedAt = Number(process.argv[3] ?? Date.now())
const DB_PATH = resolve('data/recruitment.db')

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true })

function snapshot() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
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
    return { ...stats, remaining }
  } finally {
    db.close()
  }
}

while (!stopping) {
  try {
    appendFileSync(progressPath, `${JSON.stringify({
      at: new Date().toISOString(),
      elapsedMin: Number(((Date.now() - startedAt) / 60000).toFixed(1)),
      ...snapshot()
    })}\n`)
  } catch (error) {
    appendFileSync(progressPath, `${JSON.stringify({ at: new Date().toISOString(), event: 'heartbeat_error', error: String(error?.message ?? error).slice(0, 120) })}\n`)
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 60_000))
}
