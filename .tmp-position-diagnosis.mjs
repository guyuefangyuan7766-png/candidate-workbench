import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readCandidateImportFile } from './server/import-file.js'

const sourcePath = resolve('outputs/2026-08-21-hire-information-v12/北森候选人入职信息导入样本-100人.xlsx')
const parsed = await readCandidateImportFile({
  path: sourcePath,
  originalname: '北森候选人入职信息导入样本-100人.xlsx',
  mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
})
const db = new DatabaseSync(resolve('data/recruitment.db'), { readOnly: true })
db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 10000;')
const rows = parsed.rows ?? []
const sourceRows = rows.map((row, index) => ({
  rowNumber: row.row_number ?? index + 2,
  values: row.values ?? {}
}))
const candidateIds = sourceRows.map(({ values }) => String(values['应聘者ID'] ?? '').trim()).filter(Boolean)
const placeholders = candidateIds.map(() => '?').join(',')
const candidates = placeholders
  ? db.prepare(`SELECT id, name, source_record_id, hire_position, hire_status, hire_date FROM candidates WHERE source_system = 'beisen' AND source_record_id IN (${placeholders})`).all(...candidateIds)
  : []
const candidateBySource = new Map(candidates.map((candidate) => [candidate.source_record_id, candidate]))
const candidateDbIds = candidates.map((candidate) => candidate.id)
const candidatePlaceholders = candidateDbIds.map(() => '?').join(',')
const linkedRows = candidatePlaceholders
  ? db.prepare(`
      SELECT cp.candidate_id, p.id AS position_id, p.title, p.external_code, p.source_record_id,
             p.source_system, p.status, p.archived_at
      FROM candidate_positions cp
      JOIN positions p ON p.id = cp.position_id
      WHERE cp.candidate_id IN (${candidatePlaceholders})
      ORDER BY cp.candidate_id, p.title, p.id
    `).all(...candidateDbIds)
  : []
const linksByCandidate = new Map()
for (const linked of linkedRows) {
  const items = linksByCandidate.get(linked.candidate_id) ?? []
  items.push(linked)
  linksByCandidate.set(linked.candidate_id, items)
}
const positionKeys = sourceRows
  .map(({ values }) => String(values['最后职位类投递的职位id'] ?? '').trim())
  .filter(Boolean)
const positionKeyPlaceholders = positionKeys.map(() => '?').join(',')
const matchingPositions = positionKeyPlaceholders
  ? db.prepare(`SELECT id, title, external_code, source_record_id, source_system, status, archived_at FROM positions WHERE external_code IN (${positionKeyPlaceholders}) OR source_record_id IN (${positionKeyPlaceholders})`).all(...positionKeys, ...positionKeys)
  : []
const positionKeyMatches = new Map()
for (const position of matchingPositions) {
  for (const key of [position.external_code, position.source_record_id]) {
    if (!key) continue
    const values = positionKeyMatches.get(String(key)) ?? []
    values.push(position)
    positionKeyMatches.set(String(key), values)
  }
}
const details = sourceRows.map(({ rowNumber, values }) => {
  const sourceId = String(values['应聘者ID'] ?? '').trim()
  const candidate = candidateBySource.get(sourceId)
  const links = candidate ? (linksByCandidate.get(candidate.id) ?? []) : []
  const dedicatedKey = String(values['最后职位类投递的职位id'] ?? '').trim()
  const genericCode = String(values['职位编号'] ?? '').trim()
  const lastDelivery = String(values['最后投递'] ?? '').trim()
  const firstDelivery = String(values['最初投递'] ?? '').trim()
  const positionMatches = positionKeyMatches.get(dedicatedKey) ?? []
  let diagnosis = '已关联招聘职位'
  if (!dedicatedKey) diagnosis = '源文件专用职位键为空；因整表存在该表头，系统按规则不回退普通职位编号'
  else if (!links.length) diagnosis = '源文件有专用职位键，但正式库未发现关联职位关系'
  else if (links.length > 1) diagnosis = '已关联多个招聘职位，需人工复核'
  return {
    source_row: rowNumber,
    source_record_id: sourceId,
    name: candidate?.name ?? null,
    hire_position: String(values['入职职位'] ?? '').trim() || null,
    hire_date_source: values['入职日期'] ?? null,
    hire_status_db: candidate?.hire_status ?? null,
    dedicated_position_key: dedicatedKey || null,
    generic_position_code: genericCode || null,
    last_delivery_value: lastDelivery || null,
    first_delivery_value: firstDelivery || null,
    source_position_key_matches: positionMatches.map(({ id, title, external_code, source_record_id, source_system, status, archived_at }) => ({ id, title, external_code, source_record_id, source_system, status, archived_at })),
    linked_positions: links.map(({ position_id, title, external_code, source_record_id, source_system, status, archived_at }) => ({ position_id, title, external_code, source_record_id, source_system, status, archived_at })),
    diagnosis
  }
})
const summary = {
  source_rows: details.length,
  candidates_found: candidates.length,
  hire_position_nonempty: details.filter((row) => row.hire_position).length,
  dedicated_position_key_nonempty: details.filter((row) => row.dedicated_position_key).length,
  dedicated_position_key_blank: details.filter((row) => !row.dedicated_position_key).length,
  generic_position_code_nonempty: details.filter((row) => row.generic_position_code).length,
  last_delivery_value_nonempty: details.filter((row) => row.last_delivery_value).length,
  first_delivery_value_nonempty: details.filter((row) => row.first_delivery_value).length,
  candidates_with_any_link: details.filter((row) => row.linked_positions.length > 0).length,
  candidates_without_any_link: details.filter((row) => row.linked_positions.length === 0).length,
  no_link_with_blank_dedicated_key: details.filter((row) => !row.dedicated_position_key && row.linked_positions.length === 0).length,
  no_link_with_nonempty_dedicated_key: details.filter((row) => row.dedicated_position_key && row.linked_positions.length === 0).length,
  total_link_rows: details.reduce((sum, row) => sum + row.linked_positions.length, 0),
  position_key_matches_in_positions_table: details.reduce((sum, row) => sum + row.source_position_key_matches.length, 0)
}
console.log(JSON.stringify({ summary, details }, null, 2))
db.close()
