#!/usr/bin/env node
// 真实业务查询评测：用正式库构造查询集与 qrels，再打本地检索服务算质量/延迟。
//
//   node scripts/evaluate-business-search.mjs            # 预演：只打印查询集与正例数（只读，不调模型）
//   node scripts/evaluate-business-search.mjs --run      # 真跑：逐条打 /api/resume-search
//
// qrels 口径（自动、可复现）：**本人材料里确实写了这个词**——
//   profile_sections.title/content、attachment.extracted_text、candidate 主档直写字段；
//   用 FTS 把候选集收窄到命中集，再用 instr() 精确确认（与检索链路同一套判定）。
// 局限：这是"文本包含"级真值，不是 HR 主观相关性；用于发现漏召回、元数据污染、超时与降级。
//
// 产物：
//   docs/evidence/search-business-eval.json   仅含 ID 与指标（可进仓库）
//   data/business-eval-review.html            带姓名的人工复核页（data/ 已 gitignore）

import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { businessSearchTermExpression } from '../server/business-search.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(ROOT, 'data', 'recruitment.db')
const BASE_URL = process.env.SEARCH_BASE_URL ?? 'http://127.0.0.1:4173'
const EVIDENCE_PATH = resolve(ROOT, 'docs', 'evidence', 'search-business-eval.json')
const REVIEW_PATH = resolve(ROOT, 'data', 'business-eval-review.html')
const RUN = process.argv.includes('--run')
const PAGE_SIZE = 20
const CHUNK = 500

const chunked = (values, size = CHUNK) => {
  const output = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

// 「一般查询短语」：不含标点、2–16 字，避免把"剪映，PR，AE…"这类整串当查询。
const PLAIN_PHRASE = /^[\p{Script=Han}A-Za-z0-9+#./\-\s]{2,16}$/u
const hasHan = (value) => /\p{Script=Han}/u.test(value)

function buildQuerySet(db) {
  const skills = db.prepare(`
    SELECT title AS q, count(DISTINCT candidate_id) AS n
    FROM candidate_profile_sections
    WHERE section_type = 'skill' AND archived_at IS NULL AND title IS NOT NULL
    GROUP BY title HAVING n >= 300 ORDER BY n DESC LIMIT 60`).all()
    .filter((row) => PLAIN_PHRASE.test(row.q.trim()))
    .slice(0, 16)

  const positions = db.prepare(`
    SELECT p.title AS q, count(*) AS n
    FROM candidate_positions cp JOIN positions p ON p.id = cp.position_id
    GROUP BY p.id HAVING n >= 20 ORDER BY n DESC LIMIT 40`).all()
    .filter((row) => row.q.trim().length >= 2 && row.q.trim().length <= 24)
    .filter((row, index, list) => list.findIndex((item) => item.q.trim() === row.q.trim()) === index)
    .slice(0, 16)

  const intents = [
    ['TikTok', '投放'], ['Unity', '热更新'], ['数值', '经济系统'], ['Python', '服务端'],
    ['游戏测试', '自动化'], ['广告', '投放'], ['Excel', '数据分析'], ['玩法', '策划'],
    ['项目管理', '进度'], ['3D', '美术'], ['运营', '活动'], ['测试', '用例'],
    ['Java', '微服务'], ['PS', '海报'], ['匹配', '算法'], ['安全', '反作弊']
  ].map((terms) => ({ kind: 'intent', q: terms.join(' '), terms }))

  return [
    ...skills.map((row) => ({ kind: 'skill', q: row.q.trim(), terms: [row.q.trim()] })),
    ...positions.map((row) => ({ kind: 'position', q: row.q.trim(), terms: [row.q.trim()] }))
      .filter((row, index, list) => skills.every((skill) => skill.q.trim() !== row.q) && list.findIndex((item) => item.q === row.q) === index),
    ...intents
  ]
}

// FTS 收窄：中文走全业务 gram 索引，非中文走简历 FTS（与检索链路一致）。
function narrowedCandidates(db, term) {
  const ids = new Set()
  if (hasHan(term)) {
    const expression = `search_text : (${businessSearchTermExpression(term)})`
    for (const row of db.prepare(`
      SELECT DISTINCT sd.candidate_id AS id
      FROM search_documents_v2_fts f JOIN search_documents_v2 sd ON sd.row_id = f.rowid
      WHERE search_documents_v2_fts MATCH ?
        AND sd.source_table IN ('candidates','candidate_profile_sections','candidate_attachments')
      LIMIT 20000`).all(expression)) ids.add(row.id)
  } else {
    const quoted = `"${term.replace(/"/g, '""')}"`
    for (const row of db.prepare(`
      SELECT DISTINCT d.candidate_id AS id
      FROM candidate_resume_fts f JOIN candidate_resume_documents d ON d.row_id = f.rowid
      WHERE candidate_resume_fts MATCH ? LIMIT 20000`).all(quoted)) ids.add(row.id)
  }
  return [...ids]
}

// 精确确认：本人材料里真的包含该词（避免只靠 FTS 的近似命中）。
function authoredMatches(db, term, candidateIds) {
  const matched = new Set()
  for (const batch of chunked(candidateIds)) {
    const marks = batch.map(() => '?').join(',')
    for (const row of db.prepare(`
      SELECT DISTINCT candidate_id AS id FROM candidate_profile_sections
      WHERE archived_at IS NULL AND candidate_id IN (${marks})
        AND instr(lower(coalesce(title,'') || char(10) || coalesce(content,'')), lower(?)) > 0`).all(...batch, term)) matched.add(row.id)
    for (const row of db.prepare(`
      SELECT DISTINCT candidate_id AS id FROM candidate_attachments
      WHERE parse_status = 'parsed' AND candidate_id IN (${marks})
        AND instr(lower(coalesce(extracted_text,'')), lower(?)) > 0`).all(...batch, term)) matched.add(row.id)
    for (const row of db.prepare(`
      SELECT id FROM candidates
      WHERE archived_at IS NULL AND id IN (${marks})
        AND instr(lower(coalesce(current_company,'') || char(10) || coalesce(current_title,'') || char(10) ||
              coalesce(self_summary,'') || char(10) || coalesce(tags,'')), lower(?)) > 0`).all(...batch, term)) matched.add(row.id)
  }
  return matched
}

function positives(db, query) {
  let current = null
  for (const term of query.terms) {
    const scope = narrowedCandidates(db, term)
    const hit = authoredMatches(db, term, scope)
    current = current === null ? hit : new Set([...current].filter((id) => hit.has(id)))
    if (current.size === 0) break
  }
  return current ?? new Set()
}

const metric = (ids, expected) => {
  const top10 = ids.slice(0, 10)
  const top20 = ids.slice(0, 20)
  const hit10 = top10.filter((id) => expected.has(id)).length
  const hit20 = top20.filter((id) => expected.has(id)).length
  const firstIndex = ids.findIndex((id) => expected.has(id))
  return {
    precision_at_10: Number((hit10 / Math.max(1, top10.length)).toFixed(4)),
    recall_at_20: Number((hit20 / Math.max(1, expected.size)).toFixed(6)),
    mrr: firstIndex >= 0 ? Number((1 / (firstIndex + 1)).toFixed(4)) : 0
  }
}

const percentile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
}

async function searchOnce(query) {
  const started = Date.now()
  const response = await fetch(`${BASE_URL}/api/resume-search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: query.q, page_size: PAGE_SIZE }),
    signal: AbortSignal.timeout(180000)
  })
  const body = await response.json().catch(() => null)
  return {
    http: response.status,
    ms: Date.now() - started,
    items: Array.isArray(body?.items) ? body.items : [],
    total: body?.pagination?.total ?? null,
    ranking: body?.completeness?.ranking ?? null,
    degradation: Array.isArray(body?.degradation) ? body.degradation.map((item) => item.code) : [],
    plan_source: body?.query?.plan_source ?? null
  }
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  db.exec('PRAGMA busy_timeout=30000')
  const queries = buildQuerySet(db)
  const scored = []
  for (const query of queries) {
    const expected = positives(db, query)
    scored.push({ ...query, expected })
  }
  const usable = scored.filter((query) => query.expected.size >= 5)
  console.log(JSON.stringify({
    mode: RUN ? 'run' : 'dry-run',
    database: DB_PATH,
    queries_built: scored.length,
    queries_usable: usable.length,
    skipped: scored.filter((query) => query.expected.size < 5).map((query) => ({ q: query.q, kind: query.kind, positives: query.expected.size })),
    sample: usable.slice(0, 10).map((query) => ({ kind: query.kind, q: query.q, positives: query.expected.size }))
  }, null, 1))
  if (!RUN) { db.close(); return }

  const rows = []
  const review = []
  for (const [index, query] of usable.entries()) {
    const outcome = await searchOnce(query)
    const ids = outcome.items.map((item) => String(item.candidate_id))
    const metrics = metric(ids, query.expected)
    rows.push({
      kind: query.kind, q: query.q, positives: query.expected.size,
      http: outcome.http, ms: outcome.ms, returned: ids.length, total: outcome.total,
      ranking: outcome.ranking, degradation: outcome.degradation, plan_source: outcome.plan_source,
      ...metrics,
      top_ids: ids.slice(0, 10)
    })
    review.push({
      kind: query.kind, q: query.q, positives: query.expected.size,
      results: outcome.items.slice(0, 10).map((item) => ({
        id: item.candidate_id, name: item.name, hit: query.expected.has(String(item.candidate_id)),
        reasons: item.reasons ?? [], snippets: (item.snippets ?? []).slice(0, 2)
      }))
    })
    console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), done: index + 1, total: usable.length, q: query.q, http: outcome.http, ms: outcome.ms, ...metrics, degradation: outcome.degradation }))
  }
  db.close()

  const ok = rows.filter((row) => row.http === 200)
  const latency = ok.map((row) => row.ms)
  const summary = {
    at: new Date().toISOString(),
    base_url: BASE_URL,
    query_count: rows.length,
    ok_count: ok.length,
    error_count: rows.length - ok.length,
    degraded_count: rows.filter((row) => row.degradation.length > 0).length,
    window_fallback_count: rows.filter((row) => row.ranking === 'fts').length,
    mean_precision_at_10: Number((ok.reduce((sum, row) => sum + row.precision_at_10, 0) / Math.max(1, ok.length)).toFixed(4)),
    mean_mrr: Number((ok.reduce((sum, row) => sum + row.mrr, 0) / Math.max(1, ok.length)).toFixed(4)),
    mean_recall_at_20: Number((ok.reduce((sum, row) => sum + row.recall_at_20, 0) / Math.max(1, ok.length)).toFixed(6)),
    latency_ms: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), max: latency.length ? Math.max(...latency) : null },
    by_kind: Object.fromEntries(['skill', 'position', 'intent'].map((kind) => {
      const subset = ok.filter((row) => row.kind === kind)
      return [kind, {
        queries: subset.length,
        mean_precision_at_10: subset.length ? Number((subset.reduce((sum, row) => sum + row.precision_at_10, 0) / subset.length).toFixed(4)) : null,
        mean_mrr: subset.length ? Number((subset.reduce((sum, row) => sum + row.mrr, 0) / subset.length).toFixed(4)) : null,
        latency_p50: percentile(subset.map((row) => row.ms), 0.5)
      }]
    })),
    caveat: 'qrels 为“本人材料精确包含查询词”，非 HR 主观相关性。大正例集（数千人）下 Recall@20 的上限仅 20/|正例|，不具区分度，应以 precision_at_10 / mrr / 延迟 / 降级率为主；本评测用于发现元数据污染、漏召回、超时与降级。',
    rows
  }
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(REVIEW_PATH, `<!doctype html><meta charset="utf-8"><title>检索人工复核</title>
<style>body{font:14px/1.6 system-ui;margin:24px}h2{margin:24px 0 6px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;vertical-align:top}.hit{color:#0a7}.miss{color:#c33}</style>
<h1>真实查询人工复核（${new Date().toISOString().slice(0, 10)}）</h1>
<p>标注口径：结果是否与查询意图相关。<b>自动 qrels 命中</b>是“材料里写了该词”，仅供参考。</p>
${review.map((item) => `<h2>${item.q} <small>(${item.kind}，自动正例 ${item.positives} 人)</small></h2>
<table><tr><th>#</th><th>候选人</th><th>自动命中</th><th>排序理由</th><th>证据片段</th></tr>
${item.results.map((row, index) => `<tr><td>${index + 1}</td><td>${row.name ?? ''}<br><small>${row.id}</small></td><td class="${row.hit ? 'hit' : 'miss'}">${row.hit ? '是' : '否'}</td><td>${(row.reasons ?? []).join('、')}</td><td>${(row.snippets ?? []).map((text) => String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))).join('<hr>')}</td></tr>`).join('')}
</table>`).join('')}
`)
  console.log(JSON.stringify({ ...summary, rows: undefined, review_path: REVIEW_PATH, evidence_path: EVIDENCE_PATH }, null, 1))
}

main().catch((error) => {
  console.error(JSON.stringify({ state: 'failed', error: String(error?.message ?? error).slice(0, 300) }))
  process.exitCode = 1
})
