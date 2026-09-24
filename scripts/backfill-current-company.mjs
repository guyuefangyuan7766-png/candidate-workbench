#!/usr/bin/env node
/**
 * Backfill candidates.current_company / current_title from stored Beisen source
 * payloads.
 *
 * The importer's alias list did not know the real column names 最近任职公司 and
 * 最近任职职位, so both columns were skipped during import and every candidate
 * ended up empty. The raw source payload is still in the database, so the values
 * can be recovered without re-importing the workbooks.
 *
 * Dry run by default; pass --apply to write.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const databasePath = process.argv[2] ?? process.env.DB_PATH ?? 'data/recruitment.db'
const apply = process.argv.includes('--apply')

// Values that are section headings or placeholders rather than company names.
const JUNK = new Set([
  '工作经历', '工作经验', '无', '暂无', '未填写', '未提取', '其他', '-', '--', 'N/A', 'NA', 'null', 'NULL'
])

function clean(value) {
  if (value == null) return ''
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (JUNK.has(text)) return ''
  if (text.length > 300) return text.slice(0, 300)
  // A bare heading such as "工作经历：" is not a company name either.
  if (/^(工作经历|工作经验)[:：]?$/.test(text)) return ''
  return text
}

const db = new DatabaseSync(databasePath)
// 生产库上应用在同时读写，默认 busy_timeout=0 时一撞锁就报 database is locked。
db.exec('PRAGMA busy_timeout = 30000')

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

try {
  // Only rows that still need a value, and only from Beisen payloads.
  const rows = db.prepare(`
    SELECT s.candidate_id AS candidate_id, s.raw_payload AS raw_payload,
           c.current_company AS existing_company, c.current_title AS existing_title
      FROM candidate_source_records s
      JOIN candidates c ON c.id = s.candidate_id
     WHERE s.raw_payload IS NOT NULL
       AND LENGTH(s.raw_payload) > 200
       AND (
         (c.current_company IS NULL OR TRIM(c.current_company) = '')
         OR (c.current_title IS NULL OR TRIM(c.current_title) = '')
       )
  `).all()

  const updates = new Map()
  let scanned = 0
  let rejectedJunk = 0
  let alreadyFilled = 0
  const hasValue = (value) => typeof value === 'string' && value.trim() !== ''
  for (const row of rows) {
    let payload
    try {
      payload = JSON.parse(row.raw_payload)
    } catch {
      continue
    }
    scanned += 1
    const company = clean(payload['最近任职公司'])
    const title = clean(payload['最近任职职位'])
    if (!company && !title) {
      rejectedJunk += 1
      continue
    }
    const current = updates.get(row.candidate_id) ?? {}
    // Keep the first non-empty value per candidate: source records are ordered
    // by insertion, and the earliest substantive payload is the closest to the
    // candidate's own profile rather than a later application update.
    // 只收集目标列仍为空的字段，避免重跑时把已有值覆盖或把另一列写成空串。
    if (!current.current_company && company && !hasValue(row.existing_company)) current.current_company = company
    if (!current.current_title && title && !hasValue(row.existing_title)) current.current_title = title
    if (current.current_company || current.current_title) updates.set(row.candidate_id, current)
    else alreadyFilled += 1
  }

  const withCompany = [...updates.values()].filter((u) => u.current_company).length
  const withTitle = [...updates.values()].filter((u) => u.current_title).length
  console.log('数据库            :', databasePath)
  console.log('扫描来源记录      :', rows.length)
  console.log('可解析记录        :', scanned)
  console.log('字段为空或为标题  :', rejectedJunk)
  console.log('对应字段已填过    :', alreadyFilled)
  console.log('待回填候选人数    :', updates.size)
  console.log('  其中公司        :', withCompany)
  console.log('  其中职位        :', withTitle)
  console.log('')
  console.log('样例（前 5 条，已脱敏为长度与字段名）：')
  let shown = 0
  for (const [id, value] of updates) {
    if (shown >= 5) break
    console.log(`  candidate ${id.slice(0, 8)}… company=${value.current_company ? value.current_company.length + ' 字符' : '-'} title=${value.current_title ? value.current_title.length + ' 字符' : '-'}`)
    shown += 1
  }

  if (!apply) {
    console.log('')
    console.log('这是预演，未写入任何数据。确认后加 --apply：')
    console.log(`  node scripts/backfill-current-company.mjs "${databasePath}" --apply`)
    process.exit(0)
  }

  // 不更新 updated_at：回填是数据修复，不是候选人资料变更，否则 9 万行会
  // 挤到列表页最前面，而"更新时间"列也会集体变成今天。
  // 按字段更新：只写仍然为空的那一列，重跑时既不会覆盖已有值，也不会把
  // 另一列写成空串。
  const updateCompany = db.prepare(`
    UPDATE candidates SET current_company = ?
     WHERE id = ? AND (current_company IS NULL OR TRIM(current_company) = '')
  `)
  const updateTitle = db.prepare(`
    UPDATE candidates SET current_title = ?
     WHERE id = ? AND (current_title IS NULL OR TRIM(current_title) = '')
  `)

  // 记录将被更新的 id，便于回滚（原值必为空，回滚即把这些行两列置回 NULL）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = resolve(process.env.BACKFILL_BACKUP_DIR ?? join(dirname(databasePath), 'backups'))
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `backfill-current-company-${stamp}.txt`)
  writeFileSync(backupPath, [
    '# backfill candidates.current_company / current_title',
    `# database: ${databasePath}`,
    `# created_at: ${new Date().toISOString()}`,
    '# rollback: UPDATE candidates SET current_company = NULL, current_title = NULL WHERE id IN (...)',
    '# 说明：这些行在回填前两列均为空，所以回滚就是重新置空。',
    ...[...updates.keys()]
  ].join('\n') + '\n', 'utf8')
  console.log(`已写出回滚清单: ${backupPath}（${updates.size} 个 id）`)

  // 分批提交，避免在 38GB 生产库上长时间持有写锁。
  const BATCH_SIZE = 1_000
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
          const companyChanged = value.current_company
            ? Number(updateCompany.run(value.current_company, id).changes)
            : 0
          const titleChanged = value.current_title
            ? Number(updateTitle.run(value.current_title, id).changes)
            : 0
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
