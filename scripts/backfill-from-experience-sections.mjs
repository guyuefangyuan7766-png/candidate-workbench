#!/usr/bin/env node
/**
 * 第二轮回填：对 candidates.current_company / current_title 仍为空的候选人，
 * 从 candidate_profile_sections 的 experience 区块正文里恢复最近一段工作经历。
 *
 * 这批候选人的北森原始字段（最近任职公司/最近任职职位）本身就为空，主档两列
 * 因此没有值；但履历区块里保留了结构化的「公司名称 / 职位名称」。
 *
 * Dry run by default; pass --apply to write.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const databasePath = process.argv[2] ?? process.env.DB_PATH ?? 'data/recruitment.db'
const apply = process.argv.includes('--apply')

const JUNK = new Set([
  '工作经历', '工作经验', '无', '暂无', '未填写', '未提取', '其他', '-', '--', '—', 'N/A', 'NA', 'null', 'NULL'
])

function clean(value) {
  if (value == null) return ''
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text || JUNK.has(text)) return ''
  return text.length > 300 ? text.slice(0, 300) : text
}

function parseEntries(content) {
  const text = String(content ?? '')
  const segments = text
    .split(/(?=^\s*\d+\s*[、.．]\s*公司名称\s*[:：])/mu)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const source = segments.length ? segments : [text]
  return source.map((segment) => ({
    company: clean(/公司名称\s*[:：]\s*([^\n]*)/u.exec(segment)?.[1]),
    title: clean(/职位名称\s*[:：]\s*([^\n]*)/u.exec(segment)?.[1]),
    isCurrent: /结束时间\s*[:：]\s*至今/u.test(segment)
  }))
}

const db = new DatabaseSync(databasePath)
db.exec('PRAGMA busy_timeout = 30000')

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

try {
  const rows = db.prepare(`
    SELECT c.id AS candidate_id, c.name AS name, c.current_company AS existing_company,
           c.current_title AS existing_title, s.content AS content, s.sort_order AS sort_order
      FROM candidates c
      JOIN candidate_profile_sections s ON s.candidate_id = c.id
     WHERE s.section_type = 'experience'
       AND s.archived_at IS NULL
       AND s.content IS NOT NULL
       AND TRIM(s.content) <> ''
       AND (c.current_company IS NULL OR TRIM(c.current_company) = '')
       AND (c.current_title IS NULL OR TRIM(c.current_title) = '')
     ORDER BY c.id, s.sort_order
  `).all()

  const byCandidate = new Map()
  for (const row of rows) {
    const list = byCandidate.get(row.candidate_id) ?? []
    list.push(row)
    byCandidate.set(row.candidate_id, list)
  }

  const updates = new Map()
  let candidatesWithCurrentEntry = 0
  let skippedNoValue = 0
  for (const [candidateId, blocks] of byCandidate) {
    const entries = blocks.flatMap((block) => parseEntries(block.content))
    const currentEntry = entries.find((entry) => entry.isCurrent && (entry.company || entry.title))
    const picked = currentEntry ?? entries.find((entry) => entry.company || entry.title)
    if (!picked || (!picked.company && !picked.title)) {
      skippedNoValue += 1
      continue
    }
    if (currentEntry) candidatesWithCurrentEntry += 1

    const existing = blocks[0]
    const value = {}
    if (picked.company && !String(existing.existing_company ?? '').trim()) value.current_company = picked.company
    if (picked.title && !String(existing.existing_title ?? '').trim()) value.current_title = picked.title
    if (value.current_company || value.current_title) updates.set(candidateId, value)
    else skippedNoValue += 1
  }

  const withCompany = [...updates.values()].filter((value) => value.current_company).length
  const withTitle = [...updates.values()].filter((value) => value.current_title).length
  console.log('数据库              :', databasePath)
  console.log('两列为空的候选人    :', byCandidate.size)
  console.log('履历区块记录数      :', rows.length)
  console.log('取到「结束时间至今」:', candidatesWithCurrentEntry)
  console.log('无法提取有效值      :', skippedNoValue)
  console.log('待回填候选人数      :', updates.size)
  console.log('  其中公司          :', withCompany)
  console.log('  其中职位          :', withTitle)
  console.log('')
  console.log('样例（前 5 条，脱敏为长度）：')
  let shown = 0
  for (const [id, value] of updates) {
    if (shown >= 5) break
    console.log(`  candidate ${id.slice(0, 8)}… company=${value.current_company ? value.current_company.length + ' 字符' : '-'} title=${value.current_title ? value.current_title.length + ' 字符' : '-'}`)
    shown += 1
  }

  if (!apply) {
    console.log('')
    console.log('这是预演，未写入任何数据。确认后加 --apply：')
    console.log(`  node scripts/backfill-from-experience-sections.mjs "${databasePath}" --apply`)
    process.exit(0)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = resolve(process.env.BACKFILL_BACKUP_DIR ?? join(dirname(databasePath), 'backups'))
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `backfill-from-sections-${stamp}.txt`)
  writeFileSync(backupPath, [
    '# backfill candidates.current_company / current_title from experience sections',
    `# database: ${databasePath}`,
    `# created_at: ${new Date().toISOString()}`,
    '# rollback: UPDATE candidates SET current_company = NULL, current_title = NULL WHERE id IN (...)',
    ...[...updates.keys()]
  ].join('\n') + '\n', 'utf8')
  console.log(`已写出回滚清单: ${backupPath}（${updates.size} 个 id）`)

  const updateCompany = db.prepare(`
    UPDATE candidates SET current_company = ?
     WHERE id = ? AND (current_company IS NULL OR TRIM(current_company) = '')
  `)
  const updateTitle = db.prepare(`
    UPDATE candidates SET current_title = ?
     WHERE id = ? AND (current_title IS NULL OR TRIM(current_title) = '')
  `)

  const BATCH_SIZE = 500
  const ids = [...updates.keys()]
  let changedCandidates = 0
  let changedCompany = 0
  let changedTitle = 0
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const batch = ids.slice(offset, offset + BATCH_SIZE)
    for (let attempt = 1; ; attempt += 1) {
      let transactionOpen = false
      try {
        db.exec('BEGIN IMMEDIATE')
        transactionOpen = true
        for (const id of batch) {
          const value = updates.get(id)
          const companyChanged = value.current_company ? Number(updateCompany.run(value.current_company, id).changes) : 0
          const titleChanged = value.current_title ? Number(updateTitle.run(value.current_title, id).changes) : 0
          changedCompany += companyChanged
          changedTitle += titleChanged
          if (companyChanged || titleChanged) changedCandidates += 1
        }
        db.exec('COMMIT')
        break
      } catch (error) {
        if (transactionOpen) {
          try { db.exec('ROLLBACK') } catch {}
        }
        const busy = /locked|busy/i.test(String(error?.message ?? ''))
        if (!busy || attempt >= 12) throw error
        console.log(`  数据库忙（第 ${attempt} 次），等待 2.5 秒后重试当前批次`)
        sleepSync(2_500)
      }
    }
    console.log(`  进度 ${Math.min(offset + BATCH_SIZE, ids.length)}/${ids.length}`)
  }
  console.log('')
  console.log(`已更新 ${changedCandidates} 位候选人（公司 ${changedCompany} 处 / 职位 ${changedTitle} 处）。`)
  const afterCompany = db.prepare("SELECT COUNT(*) AS c FROM candidates WHERE current_company IS NOT NULL AND TRIM(current_company) <> ''").get().c
  const afterTitle = db.prepare("SELECT COUNT(*) AS c FROM candidates WHERE current_title IS NOT NULL AND TRIM(current_title) <> ''").get().c
  console.log(`回填后 current_company 非空: ${afterCompany}`)
  console.log(`回填后 current_title   非空: ${afterTitle}`)
} finally {
  db.close()
}
