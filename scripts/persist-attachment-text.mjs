#!/usr/bin/env node
// 附件文本持久化：把阶段 3 已确认有正文的原始简历（resume_origin）重新提取成纯文本，
// 写回 candidate_attachments.extracted_text，供全文检索与后续向量管道使用。
//
//   node scripts/persist-attachment-text.mjs --limit 200            # 预演（默认，不写库）
//   node scripts/persist-attachment-text.mjs --limit 2000 --apply   # 写库（必须先停应用服务）
//   node scripts/persist-attachment-text.mjs --apply                # 全量（约 3 小时）
//
// 方案：docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md
//
// 只写 candidate_attachments 的五列（extracted_text / parse_status / parser_version /
// source / updated_at）。candidate_resume_documents 与 candidate_resume_fts 由触发器自动维护，
// 本脚本不直接写它们；也不碰 candidates、candidate_profile_sections。

import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(DATA, 'recruitment.db')
const EXTRACTOR = resolve(ROOT, 'scripts', 'extract-origin-text.mjs')
const PROGRESS_PATH = resolve(DATA, 'persist-attachment-text-progress.json')
const FAILED_PATH = resolve(DATA, 'persist-attachment-text-failed.jsonl')
const SERVICE_PID_PATH = resolve(DATA, 'service.pid')
const DEFAULT_REPORT_PATH = resolve(DATA, 'persist-attachment-text-report.json')

const PARSER_VERSION = 'origin-text-v1'
const SOURCE = 'origin_text_persist'
const MIN_TEXT_LENGTH = 40
const BATCH_SIZE = 200
const BUSY_RETRIES = 5
const CHILD_TIMEOUT_MS = 120_000
// PDF 解析跑在原生扩展里（pdfjs + 可能的内存压力），并发过高会以 0xC0000005
// 直接崩掉子进程（实测：串行 12/12 成功，12 并发崩 15%–25%；本机可用内存只剩 ~2 GB）。
// 默认降到 3，并且对崩溃做有限重试。
const MAX_CONCURRENCY = 8
const EXTRACT_RETRIES = 3
const RETRY_DELAY_MS = 500

function parseArgs(argv) {
  const options = { apply: false, limit: null, concurrency: 3, report: null, showPreview: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--show-preview') options.showPreview = true
    else if (arg === '--limit') { index += 1; options.limit = Number.parseInt(argv[index], 10) }
    else if (arg === '--concurrency') { index += 1; options.concurrency = Number.parseInt(argv[index], 10) }
    else if (arg === '--report') { index += 1; options.report = resolve(argv[index]) }
    else if (arg === '--help' || arg === '-h') { options.help = true }
    else throw new Error(`未知参数：${arg}`)
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) throw new Error('--limit 必须是正整数')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) throw new Error(`--concurrency 必须在 1–${MAX_CONCURRENCY} 之间`)
  return options
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const nowIso = () => new Date().toISOString()
const shortId = (value) => String(value ?? '').slice(0, 8)

// 应用服务在跑时禁止写库：SQLite 单写者，且项目规则要求导入/维护不与写库服务并行。
function serviceAlive() {
  try {
    const raw = readFileSync(SERVICE_PID_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const pid = Number(parsed?.pid)
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return { alive: true, pid, source: 'sentinel' } }
      catch (error) { if (error.code !== 'ESRCH') return { alive: true, pid, source: 'sentinel' } }
    }
  } catch { /* 没有 sentinel 或格式不同：继续用文本 PID 判断 */ }
  try {
    const pid = Number.parseInt(readFileSync(SERVICE_PID_PATH, 'utf8').trim().split(/\s+/)[0], 10)
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return { alive: true, pid, source: 'pid-file' } }
      catch (error) { if (error.code !== 'ESRCH') return { alive: true, pid, source: 'pid-file' } }
    }
  } catch { /* 无 pid 文件 */ }
  return { alive: false, pid: null, source: null }
}

function selectEligible(db, limit) {
  const where = `
    FROM candidate_resume_parse_state s
    JOIN candidate_attachments a ON a.id = s.source_attachment_id
    WHERE s.outcome = 'parsed'
      AND a.attachment_type = 'resume_origin'
      AND coalesce(a.extracted_text, '') = ''
      AND coalesce(a.parser_version, '') <> ?`
  const base = [PARSER_VERSION]
  const total = Number(db.prepare(`SELECT count(*) n ${where}`).get(...base).n)
  const rows = db.prepare(`
    SELECT s.candidate_id, a.id AS attachment_id, a.mime_type, a.storage_path, a.file_size
    ${where}
    ORDER BY a.id
    ${limit ? 'LIMIT ?' : ''}`).all(...base, ...(limit ? [limit] : []))
  return { total, rows }
}

function extractOne(row) {
  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(value) } }
    let child
    try {
      child = spawn(process.execPath, [EXTRACTOR, row.storage_path, row.mime_type], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      finish({ ok: false, error: `spawn:${String(error?.code ?? error?.message ?? 'error').slice(0, 80)}` })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 子进程可能已退出 */ }
      finish({ ok: false, error: 'timeout' })
    }, CHILD_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, error: `spawn:${String(error?.code ?? 'error').slice(0, 80)}` }))
    child.on('close', (code) => {
      if (code !== 0) { finish({ ok: false, error: `exit:${code}${stderr ? ':' + String(stderr).slice(0, 80) : ''}` }); return }
      let parsed
      try {
        const line = String(stdout).trim().split('\n').filter(Boolean).pop() ?? ''
        parsed = JSON.parse(line)
      } catch { finish({ ok: false, error: 'bad_json' }); return }
      if (parsed?.ok !== true || typeof parsed.text !== 'string') {
        finish({ ok: false, error: String(parsed?.error ?? 'no_text').slice(0, 120) })
        return
      }
      finish({ ok: true, text: parsed.text, method: String(parsed.method ?? '') })
    })
  })
}

// 原生崩溃（0xC0000005）/超时是概率性的：同一份文件换一个新子进程重跑通常就能过。
async function extractOneWithRetry(row) {
  let last = null
  for (let attempt = 1; attempt <= EXTRACT_RETRIES; attempt += 1) {
    last = await extractOne(row)
    if (last.ok) return { ...last, attempts: attempt }
    const retryable = /^(exit:|timeout|spawn:)/u.test(String(last.error ?? ''))
    if (!retryable || attempt === EXTRACT_RETRIES) return { ...last, attempts: attempt }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAY_MS * attempt))
  }
  return last
}

function guardTableShape(db) {
  const columns = new Set(db.prepare(`SELECT name FROM pragma_table_info('candidate_attachments')`).all().map((row) => row.name))
  for (const name of ['extracted_text', 'parse_status', 'parser_version', 'source', 'updated_at', 'attachment_type', 'storage_path', 'mime_type']) {
    if (!columns.has(name)) throw new Error(`candidate_attachments 缺少列 ${name}`)
  }
  const stateColumns = new Set(db.prepare(`SELECT name FROM pragma_table_info('candidate_resume_parse_state')`).all().map((row) => row.name))
  for (const name of ['outcome', 'source_attachment_id']) {
    if (!stateColumns.has(name)) throw new Error(`candidate_resume_parse_state 缺少列 ${name}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 15).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
    return
  }
  if (!existsSync(EXTRACTOR)) throw new Error(`缺少提取器：${EXTRACTOR}`)
  if (!existsSync(DB_PATH)) throw new Error(`找不到数据库：${DB_PATH}`)

  const startedAt = nowIso()
  const startedMs = Date.now()
  const mode = options.apply ? 'apply' : 'dry-run'

  if (options.apply) {
    const service = serviceAlive()
    if (service.alive) {
      throw new Error(`检测到应用服务仍在运行（pid=${service.pid}，来源=${service.source}）。写库前必须停服务：先确认 data/service.pid 对应进程已退出。`)
    }
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: !options.apply })
  db.exec('PRAGMA busy_timeout=15000')
  guardTableShape(db)

  const { total, rows } = selectEligible(db, options.limit)
  console.log(JSON.stringify({ at: nowIso(), mode, eligible_total: total, selected: rows.length, concurrency: options.concurrency, limit: options.limit }, null, 1))

  const counters = { processed: 0, written: 0, skipped_short: 0, failed: 0 }
  const pending = []
  const updateStatement = options.apply
    ? db.prepare(`UPDATE candidate_attachments
        SET extracted_text = ?, parse_status = 'parsed', parser_version = ?, source = ?, updated_at = ?
        WHERE id = ?`)
    : null

  async function flush() {
    if (!options.apply || !pending.length) { pending.length = 0; return }
    const batch = pending.splice(0, pending.length)
    const stamp = nowIso()
    for (let attempt = 1; ; attempt += 1) {
      try {
        db.exec('BEGIN IMMEDIATE')
        for (const item of batch) updateStatement.run(item.text, PARSER_VERSION, SOURCE, stamp, item.attachment_id)
        db.exec('COMMIT')
        counters.written += batch.length
        return
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* 事务可能未开始 */ }
        const busy = /busy|locked/i.test(String(error?.message ?? ''))
        if (!busy || attempt >= BUSY_RETRIES) throw error
        await sleep(200 * attempt)
      }
    }
  }

  function writeProgress() {
    if (!options.apply) return
    mkdirSync(DATA, { recursive: true })
    writeFileSync(PROGRESS_PATH, `${JSON.stringify({
      at: nowIso(), started_at: startedAt, mode, selected: rows.length, eligible_total: total, ...counters,
      elapsed_ms: Date.now() - startedMs
    }, null, 2)}\n`)
  }

  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= rows.length) return
      const row = rows[index]
      const result = await extractOneWithRetry(row)
      counters.processed += 1
      if (!result.ok) {
        counters.failed += 1
        const record = {
          candidate_id: row.candidate_id, attachment_id: row.attachment_id,
          mime_type: row.mime_type, error: result.error, attempts: result.attempts, at: nowIso()
        }
        if (options.apply) appendFileSync(FAILED_PATH, `${JSON.stringify(record)}\n`)
        if (options.showPreview || counters.failed <= 3) console.log(JSON.stringify({ kind: 'failed', ...record, candidate: shortId(row.candidate_id) }))
      } else if (result.text.trim().length < MIN_TEXT_LENGTH) {
        counters.skipped_short += 1
        if (options.showPreview) console.log(JSON.stringify({ kind: 'short', candidate: shortId(row.candidate_id), chars: result.text.trim().length, method: result.method }))
      } else {
        if (options.apply) pending.push({ attachment_id: row.attachment_id, text: result.text })
        else counters.written += 1
        if (options.showPreview) console.log(JSON.stringify({
          kind: 'ok', candidate: shortId(row.candidate_id), chars: result.text.trim().length, method: result.method,
          preview: options.showPreview ? result.text.trim().slice(0, 30) : undefined
        }))
      }
      if (counters.processed % BATCH_SIZE === 0) {
        await flush()
        writeProgress()
        console.log(JSON.stringify({ at: nowIso(), progress: counters, elapsed_ms: Date.now() - startedMs }))
      } else if (pending.length >= BATCH_SIZE) {
        await flush()
      }
      if (counters.processed % 500 === 0 && counters.processed % BATCH_SIZE !== 0) writeProgress()
    }
  }

  try {
    const workers = Math.min(options.concurrency, Math.max(1, rows.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
    await flush()
    writeProgress()
  } finally {
    db.close()
  }

  const summary = {
    at: nowIso(), mode, started_at: startedAt, database: DB_PATH,
    eligible_total: total, selected: rows.length, ...counters,
    skipped_short: counters.skipped_short,
    parser_version: PARSER_VERSION, source: SOURCE, min_text_length: MIN_TEXT_LENGTH,
    elapsed_ms: Date.now() - startedMs,
    note: options.apply
      ? 'candidate_resume_documents / candidate_resume_fts 由触发器自动维护；写完请启动服务让 business-search 刷新 search_index_dirty_v2'
      : 'dry-run：未写数据库、未写失败清单'
  }
  if (options.apply) {
    writeFileSync(options.report ?? DEFAULT_REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`)
  } else if (options.report) {
    writeFileSync(options.report, `${JSON.stringify(summary, null, 2)}\n`)
  }
  console.log(JSON.stringify(summary, null, 1))
}

main().catch((error) => {
  console.error(JSON.stringify({ state: 'failed', error: String(error?.message ?? error).slice(0, 300) }))
  process.exitCode = 1
})
