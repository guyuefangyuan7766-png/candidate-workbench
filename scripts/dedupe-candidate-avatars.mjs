#!/usr/bin/env node
// 清理阶段 2 头部同步里的模板误提。
//
//   node scripts/dedupe-candidate-avatars.mjs            # 只报告，不写库
//   node scripts/dedupe-candidate-avatars.mjs --apply    # 执行清理
//
// 判据（任一成立即清理）：
//   1. 同一张头像字节（sha256）被 >=2 个不同姓名的候选人共用 —— 说明不是
//      "同一人的重复档案"，而是把简历模板里的默认头像 / logo / 产品截图
//      当成了证件照；
//   2. 图片颜色多样性 < 2% —— 真实人像有肤色、发丝等大量连续色阶，而默认
//      剪影、纯色块、UI 截图、二维码的"不同颜色数 / 采样像素数"极低。
//      实测：全库 32k 张里只有 24 张低于该阈值，逐张目视确认全部是扁平图形。
//
// 实测依据：本库 33k 张头像里共有 261 个重复图组，其中 136 组跨不同姓名
// （680 人）。这 136 组经人工目视为卡通头像、产品界面截图、二维码、广告图、
// 宠物照等；且组内每个候选人的 IDPhoto 源路径互不相同，说明不同源文件却
// 提取出同一张图，属于模板误提。另 125 组是同名重复档案（真人照），保留。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.includes('--apply')
const dbPath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(ROOT, 'data', 'recruitment.db')
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 15000')

const groups = db.prepare(`
  SELECT a.sha256,
         COUNT(*) AS rows,
         COUNT(DISTINCT a.candidate_id) AS candidates,
         COUNT(DISTINCT c.name) AS distinct_names,
         GROUP_CONCAT(DISTINCT c.name) AS names
  FROM candidate_attachments a
  JOIN candidates c ON c.id = a.candidate_id
  WHERE a.attachment_type = 'avatar'
  GROUP BY a.sha256
  HAVING COUNT(DISTINCT a.candidate_id) > 1 AND COUNT(DISTINCT c.name) > 1
  ORDER BY candidates DESC
`).all()

const rows = []
for (const group of groups) {
  rows.push(...db.prepare(`
    SELECT a.id AS attachment_id, a.candidate_id, a.storage_path, a.file_size, c.name
    FROM candidate_attachments a
    JOIN candidates c ON c.id = a.candidate_id
    WHERE a.attachment_type = 'avatar' AND a.sha256 = ?
  `).all(group.sha256))
}

// 低颜色多样性追加判据：在已提取的 PNG 上按采样网格统计不同颜色占比。
const COLOR_DIVERSITY_FLOOR = Number(process.env.AVATAR_COLOR_DIVERSITY_FLOOR ?? '0.02')

function decodePng(buffer) {
  let cursor = 8, width = 0, height = 0, colorType = 6
  const idat = []
  while (cursor < buffer.length) {
    const length = buffer.readUInt32BE(cursor)
    const type = buffer.subarray(cursor + 4, cursor + 8).toString('ascii')
    const data = buffer.subarray(cursor + 8, cursor + 8 + length)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    cursor += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels || !width || !height) return null
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * channels)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const current = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      if (filter === 1) current[x] = (current[x] + a) & 0xff
      else if (filter === 2) current[x] = (current[x] + b) & 0xff
      else if (filter === 3) current[x] = (current[x] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        current[x] = (current[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    current.copy(out, y * stride)
    previous = current
  }
  return { width, height, channels, data: out }
}

const lowDiversityRows = []
for (const row of db.prepare(`
  SELECT a.id AS attachment_id, a.candidate_id, a.storage_path, a.file_size, a.sha256, c.name
  FROM candidate_attachments a JOIN candidates c ON c.id = a.candidate_id
  WHERE a.attachment_type = 'avatar' AND a.mime_type = 'image/png'
`).all()) {
  let decoded
  try { decoded = decodePng(readFileSync(row.storage_path)) } catch { continue }
  if (!decoded) continue
  const { width, height, channels, data } = decoded
  const colors = new Set()
  let sampled = 0
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 2000)))
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * channels
      colors.add((data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2])
      sampled += 1
    }
  }
  const ratio = colors.size / sampled
  if (ratio < COLOR_DIVERSITY_FLOOR) {
    lowDiversityRows.push({ ...row, ratio: Number(ratio.toFixed(5)) })
  }
}

// 合并两类目标，按 attachment_id 去重。
const targets = new Map()
for (const row of rows) targets.set(row.attachment_id, { ...row, reason: 'duplicate_image_across_people' })
for (const row of lowDiversityRows) {
  targets.set(row.attachment_id, { ...row, reason: 'low_color_diversity_flat_graphic' })
}
const allRows = [...targets.values()]

const report = {
  mode: apply ? 'apply' : 'dry-run',
  purgedGroups: groups.length,
  purgedCandidates: new Set(allRows.map((row) => row.candidate_id)).size,
  purgedRows: allRows.length,
  duplicateImageRows: rows.length,
  lowDiversityRows: lowDiversityRows.length,
  colorDiversityFloor: COLOR_DIVERSITY_FLOOR,
  groups: groups.map((group) => ({ candidates: group.candidates, names: group.names.slice(0, 60), sha: group.sha256.slice(0, 16) })),
  lowDiversity: lowDiversityRows
    .sort((left, right) => left.ratio - right.ratio)
    .map((row) => ({ name: row.name, ratio: row.ratio, sha: row.sha256.slice(0, 12) }))
}

if (!apply) {
  console.log(JSON.stringify(report, null, 1))
  db.close()
  process.exit(0)
}

const candidateIds = [...new Set(allRows.map((row) => row.candidate_id))]
const placeholders = candidateIds.map(() => '?').join(',')
const timestamp = new Date().toISOString()

let removedRows = 0
let resetCandidates = 0
let removedFiles = 0
let missingFiles = 0

db.exec('BEGIN IMMEDIATE')
try {
  const removeAttachment = db.prepare('DELETE FROM candidate_attachments WHERE id = ?')
  for (const row of allRows) {
    removedRows += Number(removeAttachment.run(row.attachment_id).changes)
  }
  const reset = db.prepare(`
    UPDATE candidates SET photo_url = NULL, updated_at = ?
    WHERE id IN (${placeholders}) AND photo_url LIKE 'attachment-avatar:%'
  `)
  resetCandidates = Number(reset.run(timestamp, ...candidateIds).changes)
  db.exec('COMMIT')
} catch (error) {
  try { db.exec('ROLLBACK') } catch {}
  throw error
}

// 只有确认没有任何附件行再引用该路径时才删文件。
const stillReferenced = db.prepare('SELECT COUNT(*) AS n FROM candidate_attachments WHERE storage_path = ?')
for (const row of allRows) {
  if (Number(stillReferenced.get(row.storage_path).n) > 0) continue
  if (!existsSync(row.storage_path)) { missingFiles += 1; continue }
  unlinkSync(row.storage_path)
  removedFiles += 1
}

const auditPath = resolve(ROOT, 'data', 'avatar-dedupe-audit.json')
let history = []
try {
  const previous = JSON.parse(readFileSync(auditPath, 'utf8'))
  history = Array.isArray(previous.history) ? previous.history : [previous]
} catch { /* 首次运行时没有历史 */ }

const audit = {
  ...report,
  removedRows,
  resetCandidates,
  removedFiles,
  missingFiles,
  appliedAt: timestamp,
  purgedCandidateIds: candidateIds,
  history
}
writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`)
db.close()
console.log(JSON.stringify({ ...audit, purgedCandidateIds: candidateIds.length }, null, 1))
