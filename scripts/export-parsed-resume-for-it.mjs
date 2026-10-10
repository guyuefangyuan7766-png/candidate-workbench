#!/usr/bin/env node
// 解析补全简历文本导出（给 IT / 人才资产 owner）。
// 规格：docs/IT_PARSED_RESUME_HANDOVER.md 第 6 节。
//
//   node scripts/export-parsed-resume-for-it.mjs --out transfer/parsed-resume-20261010
//   node scripts/export-parsed-resume-for-it.mjs --out <dir> --limit 100   # 试跑（每份 jsonl 最多 N 条）
//
// 纯只读导出：不写数据库、不调用模型。产出：
//   parsed-sections.jsonl  大模型补全的结构化区块（每人一行）
//   origin-text.jsonl      原始附件全文提取（每份一行）
//   manifest.json          行数 / 字节 / SHA256 / 解析器与模型
//   README.md              提取与合并说明
//   checksums.sha256       三个文件的校验和

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(ROOT, 'data', 'recruitment.db')
const PARSER_VERSION = 'origin-section-parse-v1'
const TEXT_PARSER_VERSION = 'origin-text-v1'
const MODEL = process.env.AGENT_RESUME_MODEL || process.env.AGENT_MODEL || 'deepseek/deepseek-flash'
const SECTION_MARKER = 'origin-section-parse-v1:%'

const USAGE = [
  '用法：node scripts/export-parsed-resume-for-it.mjs [--out <目录>] [--limit N]',
  '  --out    输出目录（默认 transfer/parsed-resume-<YYYYMMDD>）',
  '  --limit  N  试跑：parsed-sections 最多 N 人、origin-text 最多 N 条'
].join('\n')

function parseArgs(argv) {
  const options = { out: null, limit: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = argv[index + 1]
    else if (arg === '--limit') options.limit = Number(argv[index + 1]) || null
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
    else throw new Error(`未知参数：${arg}`)
    if (arg === '--out' || arg === '--limit') index += 1
  }
  if (!options.out) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    options.out = join(ROOT, 'transfer', `parsed-resume-${stamp}`)
  }
  options.out = resolve(ROOT, options.out)
  return options
}

function localTimestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${sign}${hours}:${minutes}`
}

function createLineWriter(path) {
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const hash = createHash('sha256')
  const state = { lines: 0, bytes: 0 }
  return {
    async write(value) {
      const chunk = `${JSON.stringify(value)}\n`
      const buffer = Buffer.from(chunk, 'utf8')
      hash.update(buffer)
      state.lines += 1
      state.bytes += buffer.length
      if (!stream.write(chunk)) await once(stream, 'drain')
    },
    async close() {
      stream.end()
      await once(stream, 'finish')
      return { lines: state.lines, bytes: state.bytes, sha256: hash.digest('hex') }
    }
  }
}

function renderReadme(manifest) {
  const counts = manifest.counts
  return [
    '# 解析补全简历文本包（给 IT / 人才资产 owner）',
    '',
    `生成时间（本地）：${manifest.generated_at_local}`,
    `解析器：${manifest.parser_version}（模型默认 ${manifest.model}）＋ ${manifest.text_parser_version}（本地提取）`,
    '',
    '## 内容',
    '',
    '| 文件 | 行数 | 字节 | 说明 |',
    '| --- | ---: | ---: | --- |',
    `| parsed-sections.jsonl | ${counts.sections_candidates} | ${manifest.files['parsed-sections.jsonl'].bytes} | 大模型补全区块（每人一行，共 ${counts.sections_rows} 条区块） |`,
    `| origin-text.jsonl | ${counts.origin_text_records} | ${manifest.files['origin-text.jsonl'].bytes} | 原始附件全文提取（每份一行） |`,
    '',
    '## 主键',
    '',
    '- `applicant_id`：北森 applicantId，也是 WDCloud 共享资产 `candidates/<2>/<2>/<applicantId>/` 的目录名；',
    '- `candidate_id`：本地主库主键；`beisen_candidate_id`：北森 candidateId（如 C00146616）。',
    '',
    '## 校验',
    '',
    '```powershell',
    'Get-FileHash parsed-sections.jsonl, origin-text.jsonl, manifest.json -Algorithm SHA256',
    '# 与 checksums.sha256 对照',
    '```',
    '',
    '## 合并到 WDCloud 人才库资产',
    '',
    '1. 在资产源里为每个候选人增加 `parsed/sections.json`（parsed-sections.jsonl 的 sections 数组）',
    '   与 `parsed/origin-text.txt`（origin-text.jsonl 的 text），或并入 `profile.json` 的新增字段；',
    '2. 按 Shared Asset 流程 Probe/Build 发布新版本（新的 kav_*），等待 Ready；',
    '3. 消费方（talent-pool-agent）请求刷新后**重跑任务**（任务创建时固定资产版本）；',
    '4. 验收：任意候选人能读到解析区块，无 ASSET_* 错误。',
    '',
    '详细方案、字段定义与验收清单见仓库 `docs/IT_PARSED_RESUME_HANDOVER.md`。',
    ''
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(DB_PATH)) throw new Error(`数据库不存在：${DB_PATH}`)
  mkdirSync(options.out, { recursive: true })

  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const applicantByCandidate = new Map(
    db.prepare('SELECT candidate_id, applicant_id FROM candidate_asset_index').all()
      .map((row) => [row.candidate_id, row.applicant_id])
  )
  const beisenByCandidate = new Map(
    db.prepare('SELECT id, source_record_id FROM candidates').all()
      .map((row) => [row.id, row.source_record_id])
  )

  let missingApplicant = 0
  let invalidStructured = 0

  // 1) 大模型补全的结构化区块：按 candidate_id 分组，每人一行。
  const sectionsWriter = createLineWriter(join(options.out, 'parsed-sections.jsonl'))
  const sectionStatement = db.prepare(`
    SELECT candidate_id, section_type, title, content, structured_data, sort_order
    FROM candidate_profile_sections
    WHERE source_record_id LIKE ?
    ORDER BY candidate_id, sort_order, id
  `)
  let currentCandidate = null
  let currentSections = []
  let sectionRows = 0
  let sectionCandidates = 0

  const flushSections = async () => {
    if (!currentCandidate || currentSections.length === 0) return
    const applicantId = applicantByCandidate.get(currentCandidate) ?? null
    if (!applicantId) missingApplicant += 1
    await sectionsWriter.write({
      applicant_id: applicantId,
      candidate_id: currentCandidate,
      beisen_candidate_id: beisenByCandidate.get(currentCandidate) ?? null,
      sections: currentSections,
      parser: { version: PARSER_VERSION, model: MODEL }
    })
    sectionCandidates += 1
    if (sectionCandidates % 10000 === 0) console.log(`  sections: ${sectionCandidates} 人 / ${sectionRows} 区块`)
  }

  for (const row of sectionStatement.iterate(SECTION_MARKER)) {
    if (row.candidate_id !== currentCandidate) {
      await flushSections()
      if (options.limit && sectionCandidates >= options.limit) { currentCandidate = null; currentSections = []; break }
      currentCandidate = row.candidate_id
      currentSections = []
    }
    let structured = null
    if (row.structured_data) {
      try {
        structured = JSON.parse(row.structured_data)
      } catch {
        invalidStructured += 1
        structured = row.structured_data
      }
    }
    currentSections.push({
      section_type: row.section_type,
      title: row.title,
      content: row.content ?? '',
      structured_data: structured,
      sort_order: row.sort_order
    })
    sectionRows += 1
  }
  await flushSections()

  // 2) 原始附件全文：每份附件一行（当前 1 人 1 份）。
  const textWriter = createLineWriter(join(options.out, 'origin-text.jsonl'))
  const textStatement = db.prepare(`
    SELECT candidate_id, original_filename, mime_type, extracted_text, sha256
    FROM candidate_attachments
    WHERE extracted_text IS NOT NULL AND LENGTH(TRIM(extracted_text)) > 0
    ORDER BY candidate_id, id
  `)
  let textRecords = 0
  for (const row of textStatement.iterate()) {
    if (options.limit && textRecords >= options.limit) break
    const applicantId = applicantByCandidate.get(row.candidate_id) ?? null
    if (!applicantId) missingApplicant += 1
    await textWriter.write({
      applicant_id: applicantId,
      candidate_id: row.candidate_id,
      beisen_candidate_id: beisenByCandidate.get(row.candidate_id) ?? null,
      file: row.original_filename,
      mime: row.mime_type,
      chars: row.extracted_text.length,
      sha256: row.sha256,
      text: row.extracted_text
    })
    textRecords += 1
    if (textRecords % 10000 === 0) console.log(`  origin-text: ${textRecords} 条`)
  }

  db.close()

  const sectionsStats = await sectionsWriter.close()
  const textStats = await textWriter.close()

  const manifest = {
    generated_at: new Date().toISOString(),
    generated_at_local: localTimestamp(),
    generator: 'scripts/export-parsed-resume-for-it.mjs',
    source_database: 'data/recruitment.db',
    parser_version: PARSER_VERSION,
    text_parser_version: TEXT_PARSER_VERSION,
    model: MODEL,
    keys: ['applicant_id', 'candidate_id', 'beisen_candidate_id'],
    counts: {
      sections_candidates: sectionCandidates,
      sections_rows: sectionRows,
      origin_text_records: textRecords,
      missing_applicant_id: missingApplicant,
      invalid_structured_data: invalidStructured
    },
    files: {
      'parsed-sections.jsonl': sectionsStats,
      'origin-text.jsonl': textStats
    },
    notes: [
      '只读导出，未调用模型。',
      'sections 只包含大模型补全的区块（source_record_id LIKE origin-section-parse-v1:%），不覆盖北森原有字段。',
      'origin-text 为原始附件全文提取（origin-text-v1；origin.html / origin.pdf / origin.txt）。',
      'model 为运行环境默认值（AGENT_RESUME_MODEL / AGENT_MODEL），未设置时为 deepseek/deepseek-flash。'
    ]
  }
  const manifestPath = join(options.out, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const manifestHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
  writeFileSync(
    join(options.out, 'checksums.sha256'),
    `${sectionsStats.sha256}  parsed-sections.jsonl\n${textStats.sha256}  origin-text.jsonl\n${manifestHash}  manifest.json\n`,
    'utf8'
  )
  writeFileSync(join(options.out, 'README.md'), renderReadme(manifest), 'utf8')

  const totalBytes = sectionsStats.bytes + textStats.bytes
  console.log(`完成：${options.out}`)
  console.log(`  parsed-sections.jsonl  ${sectionCandidates} 行 / ${sectionsStats.bytes} 字节`)
  console.log(`  origin-text.jsonl      ${textRecords} 行 / ${textStats.bytes} 字节`)
  console.log(`  合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB（不含 README/manifest）`)
  if (missingApplicant) console.log(`  警告：${missingApplicant} 条记录缺少 applicant_id`)
  if (invalidStructured) console.log(`  警告：${invalidStructured} 条 structured_data 未能解析为 JSON（按原文写入）`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

