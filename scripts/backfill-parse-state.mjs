#!/usr/bin/env node
// 一次性维护：把历史批次登记进 candidate_resume_parse_state。
//
//   node scripts/backfill-parse-state.mjs            # 预演
//   node scripts/backfill-parse-state.mjs --apply    # 写库
//
// 两类来源：
//   1. 当前已有本解析器产物的候选人 → parsed（source_sha256 取当前原件 sha256）
//   2. 历史报告里「模型跑过但没产出」的候选人 → no_content / failed
//      * status=batch_failed 的条目一律跳过——那是额度中断，必须留着重跑
//      * 报告里 inserted>0 但产物已被删除的条目也跳过，留着重跑
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = 'D:/talent-asset-workbench'
const DB_PATH = resolve(ROOT, 'data/recruitment.db')
const PARSER = 'origin-section-parse-v1'
const apply = process.argv.includes('--apply')

const REPORT_PATHS = [
  'data/phase3-full-report.json',
  'data/phase3-batch-1000-report.json',
  'data/phase3-batch-300-titlecheck.json',
  'data/phase3-batch-300-titlecheck2.json',
  'data/phase3-batch-150-final.json',
  'data/phase3-batch-150-final2.json',
  'data/phase3-batch-200-final3.json',
  'data/phase3-batch-200-final4.json',
  'data/phase3-batch-200-final5.json',
  '.codex-tmp/pilot100.json',
  '.codex-tmp/pilot-topup.json',
  '.codex-tmp/pilot-retry.json',
  '.codex-tmp/improved-100-202.json',
  '.codex-tmp/final-100-400.json',
  '.codex-tmp/final-100-500.json',
  '.codex-tmp/backfill-100-200.json',
  '.codex-tmp/wave-300.json'
]

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA busy_timeout = 15000')
db.exec(`
  CREATE TABLE IF NOT EXISTS candidate_resume_parse_state (
    candidate_id TEXT PRIMARY KEY,
    parser TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('parsed','no_content','failed')),
    source_attachment_id TEXT,
    source_sha256 TEXT,
    sections_written INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL
  )
`)

const timestamp = new Date().toISOString()
const insertState = db.prepare(`
  INSERT INTO candidate_resume_parse_state(
    candidate_id, parser, outcome, source_attachment_id, source_sha256,
    sections_written, attempts, last_error, first_at, last_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(candidate_id) DO NOTHING
`)

// ── 1. 已有产物的候选人 ─────────────────────────────────────────────────
const withRows = db.prepare(`
  SELECT s.candidate_id AS candidate_id,
         COUNT(*) AS sections,
         a.id AS attachment_id,
         a.sha256 AS sha256
  FROM candidate_profile_sections s
  JOIN candidate_attachments a
    ON a.candidate_id = s.candidate_id AND a.attachment_type = 'resume_origin'
  WHERE s.archived_at IS NULL
    AND json_extract(s.structured_data, '$.parser') = ?
  GROUP BY s.candidate_id
`).all(PARSER)

// ── 2. 历史报告里扫过但没产出的人 ───────────────────────────────────────
const fromReports = new Map()
let skippedBatchFailed = 0
let skippedRowsDeleted = 0
for (const relative of REPORT_PATHS) {
  const path = resolve(ROOT, relative)
  if (!existsSync(path)) continue
  let report
  try { report = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
  for (const entry of report.perCandidate ?? []) {
    const candidateId = String(entry.candidate_id ?? '').trim()
    if (!candidateId) continue
    if (entry.status === 'batch_failed') { skippedBatchFailed += 1; continue }
    const isFailure = entry.status === 'text_failed' || entry.status === 'text_too_short'
    const inserted = Number(entry.inserted ?? 0)
    if (!isFailure && inserted > 0) { skippedRowsDeleted += 1; continue }
    const outcome = isFailure ? 'failed' : 'no_content'
    const previous = fromReports.get(candidateId)
    // 同一人多次出现时，'parsed' > 'failed' > 'no_content'
    if (!previous || (previous === 'no_content' && outcome === 'failed')) {
      fromReports.set(candidateId, outcome)
    }
  }
}

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  withRows: withRows.length,
  fromReports: fromReports.size,
  reportOutcomes: [...fromReports.values()].reduce((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {}),
  skippedBatchFailed,
  skippedRowsDeleted,
  alreadyRecorded: 0,
  inserted: 0
}

const existing = new Set(db.prepare('SELECT candidate_id FROM candidate_resume_parse_state').all().map((row) => row.candidate_id))

// 报告来源的状态行必须带上「当时解析的那份原件」的 sha256，否则选人条件
// （sha 相同才跳过）会把它们继续当成待解析。这里用当前原件补齐。
const currentOrigin = db.prepare(`
  SELECT id AS attachment_id, sha256
  FROM candidate_attachments
  WHERE candidate_id = ? AND attachment_type = 'resume_origin'
  LIMIT 1
`)
const updateMissingSha = db.prepare(`
  UPDATE candidate_resume_parse_state SET source_attachment_id = ?, source_sha256 = ?
  WHERE candidate_id = ? AND (source_sha256 IS NULL OR source_sha256 = '')
`)

if (apply) {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of withRows) {
      if (existing.has(row.candidate_id)) { summary.alreadyRecorded += 1; continue }
      insertState.run(row.candidate_id, PARSER, 'parsed', row.attachment_id, row.sha256, row.sections, 1, null, timestamp, timestamp)
      summary.inserted += 1
    }
    for (const [candidateId, outcome] of fromReports) {
      if (existing.has(candidateId)) { summary.alreadyRecorded += 1; continue }
      const origin = currentOrigin.get(candidateId)
      insertState.run(
        candidateId, PARSER, outcome,
        origin?.attachment_id ?? null, origin?.sha256 ?? null,
        0, 1, outcome === 'failed' ? 'historical' : null, timestamp, timestamp
      )
      summary.inserted += 1
    }
    // 兜底：把仍然是 NULL sha 的状态行补成当前原件 sha
    let patched = 0
    for (const row of db.prepare("SELECT candidate_id FROM candidate_resume_parse_state WHERE source_sha256 IS NULL OR source_sha256 = ''").all()) {
      const origin = currentOrigin.get(row.candidate_id)
      if (!origin?.sha256) continue
      patched += Number(updateMissingSha.run(origin.attachment_id, origin.sha256, row.candidate_id).changes)
    }
    summary.shaPatched = patched
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

const finalCounts = db.prepare('SELECT outcome, COUNT(*) AS n FROM candidate_resume_parse_state GROUP BY 1 ORDER BY n DESC').all()
db.close()
console.log(JSON.stringify({ ...summary, stateTable: finalCounts }, null, 1))
