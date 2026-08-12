import { randomUUID } from 'node:crypto'
import {
  addActivity,
  now,
  serializePosition,
  withTransaction
} from './database.js'

export const POSITION_STATUSES = ['draft', 'open', 'paused', 'closed']
export const POSITION_FIELDS = [
  'title',
  'department',
  'location',
  'owner',
  'headcount',
  'status',
  'description',
  'tags',
  'source_system',
  'source_record_id',
  'external_code',
  'category',
  'professional_line',
  'job_sequence',
  'headcount_type',
  'project_name'
]

function positionError(status, message, details, code = 'request_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function cleanText(value, maxLength, { multiline = false } = {}) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return undefined
  const normalized = multiline
    ? value.replace(/\r\n?/g, '\n').trim()
    : value.trim().replace(/\s+/g, ' ')
  if (!normalized) return null
  if (normalized.length > maxLength) return undefined
  return normalized
}

function normalizeTags(input, errors) {
  if (input == null || input === '') return []
  if (!Array.isArray(input) && typeof input !== 'string') {
    errors.push({ field: 'tags', message: '标签必须是字符串或字符串数组' })
    return []
  }

  const source = Array.isArray(input) ? input : input.split(/[,，;；|\n]+/)
  if (source.length > 50) errors.push({ field: 'tags', message: '标签数量不能超过 50 个' })
  const tags = []
  const seen = new Set()
  for (const item of source.slice(0, 50)) {
    if (typeof item !== 'string') {
      errors.push({ field: 'tags', message: '每个标签都必须是字符串' })
      continue
    }
    const tag = item.trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (tag.length > 80) {
      errors.push({ field: 'tags', message: '单个标签不能超过 80 个字符' })
      continue
    }
    if (!seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }
  return tags
}

export function sanitizePositionInput(input, { partial = false } = {}) {
  const errors = []
  const value = {}
  const has = (field) => Object.prototype.hasOwnProperty.call(input ?? {}, field)

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value, errors: [{ field: 'body', message: '请求正文必须是对象' }] }
  }
  for (const field of Object.keys(input)) {
    if (!POSITION_FIELDS.includes(field)) errors.push({ field, message: '不支持的职位字段' })
  }

  if (!partial || has('title')) {
    value.title = cleanText(input.title, 200)
    if (value.title === undefined) errors.push({ field: 'title', message: '职位名称必须是最多 200 个字符的文本' })
    else if (!value.title) errors.push({ field: 'title', message: '职位名称不能为空' })
  }

  const textLimits = {
    department: 200,
    location: 200,
    owner: 200,
    source_system: 120,
    source_record_id: 300,
    external_code: 300,
    category: 300,
    professional_line: 300,
    job_sequence: 300,
    headcount_type: 300,
    project_name: 300
  }
  for (const [field, maxLength] of Object.entries(textLimits)) {
    if (!partial || has(field)) {
      value[field] = cleanText(input[field], maxLength)
      if (value[field] === undefined) {
        errors.push({ field, message: `${field} 必须是最多 ${maxLength} 个字符的文本` })
      }
    }
  }

  if (!partial || has('description')) {
    value.description = cleanText(input.description, 20_000, { multiline: true })
    if (value.description === undefined) {
      errors.push({ field: 'description', message: '职位描述必须是最多 20000 个字符的文本' })
    }
  }

  if (!partial || has('headcount')) {
    const raw = input.headcount ?? 1
    const headcount = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 10_000) {
      errors.push({ field: 'headcount', message: '计划人数必须是 1 至 10000 之间的整数' })
    } else {
      value.headcount = headcount
    }
  }

  if (!partial || has('status')) {
    const status = input.status == null || input.status === '' ? 'draft' : String(input.status).trim().toLowerCase()
    if (!POSITION_STATUSES.includes(status)) {
      errors.push({ field: 'status', message: `职位状态仅支持：${POSITION_STATUSES.join(', ')}` })
    } else {
      value.status = status
    }
  }

  if (!partial || has('tags')) value.tags = normalizeTags(input.tags, errors)
  return { value, errors }
}

function positionSelect() {
  return `
    SELECT p.*, COUNT(cp.candidate_id) AS candidate_count
    FROM positions p
    LEFT JOIN candidate_positions cp ON cp.position_id = p.id
  `
}

export function getPosition(db, id) {
  return serializePosition(db.prepare(`
    ${positionSelect()}
    WHERE p.id = ?
    GROUP BY p.id
  `).get(id))
}

export function positionExists(db, id) {
  return Boolean(db.prepare('SELECT 1 FROM positions WHERE id = ?').get(id))
}

function positionWhere(filters = {}) {
  const clauses = []
  const values = []
  const archived = String(filters.archived ?? 'exclude').trim().toLowerCase()
  if (!['exclude', 'include', 'only'].includes(archived)) {
    throw positionError(400, 'archived 仅支持 exclude、include 或 only')
  }
  if (archived === 'only') clauses.push('p.archived_at IS NOT NULL')
  else if (archived === 'exclude') clauses.push('p.archived_at IS NULL')

  if (filters.search) {
    const query = String(filters.search).trim()
    if (query.length > 300) throw positionError(400, 'search 不能超过 300 个字符')
    const search = `%${query}%`
    clauses.push(`(
      p.title LIKE ? OR p.department LIKE ? OR p.location LIKE ?
      OR p.owner LIKE ? OR p.description LIKE ? OR p.tags LIKE ?
      OR p.external_code LIKE ? OR p.category LIKE ? OR p.professional_line LIKE ?
    )`)
    values.push(search, search, search, search, search, search, search, search, search)
  }
  if (filters.status) {
    const status = String(filters.status).trim().toLowerCase()
    if (!POSITION_STATUSES.includes(status)) throw positionError(400, '未知职位状态')
    clauses.push('p.status = ?')
    values.push(status)
  }
  for (const field of ['department', 'owner', 'location']) {
    if (filters[field]) {
      const filter = String(filters[field]).trim()
      if (filter.length > 200) throw positionError(400, `${field} 不能超过 200 个字符`)
      clauses.push(`p.${field} = ?`)
      values.push(filter)
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values }
}

export function listPositions(db, filters = {}, { paginate = true } = {}) {
  const { sql, values } = positionWhere(filters)
  const sortFields = new Map([
    ['title', 'p.title'],
    ['created_at', 'p.created_at'],
    ['updated_at', 'p.updated_at'],
    ['status', 'p.status'],
    ['department', 'p.department'],
    ['location', 'p.location'],
    ['owner', 'p.owner'],
    ['headcount', 'p.headcount'],
    ['candidate_count', 'candidate_count']
  ])
  const requestedSort = String(filters.sort ?? '').trim()
  if (requestedSort && !sortFields.has(requestedSort)) throw positionError(400, '不支持的职位排序字段')
  const sort = sortFields.get(requestedSort) ?? 'p.updated_at'
  const requestedOrder = String(filters.order ?? '').trim().toLowerCase()
  if (requestedOrder && !['asc', 'desc'].includes(requestedOrder)) throw positionError(400, 'order 仅支持 asc 或 desc')
  const order = requestedOrder === 'asc' ? 'ASC' : 'DESC'
  const base = `${positionSelect()} ${sql} GROUP BY p.id ORDER BY ${sort} ${order}, p.id ASC`

  if (!paginate) return db.prepare(base).all(...values).map(serializePosition)

  const parsePagination = (value, fallback, field, maximum) => {
    if (value == null || value === '') return fallback
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) throw positionError(400, `${field} 必须是正整数`)
    const parsed = Number(raw)
    if (parsed < 1 || parsed > maximum) throw positionError(400, `${field} 必须在 1 至 ${maximum} 之间`)
    return parsed
  }
  const page = parsePagination(filters.page, 1, 'page', 1_000_000)
  const pageSize = parsePagination(filters.page_size, 20, 'page_size', 100)
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM positions p ${sql}`).get(...values).count)
  const rows = db.prepare(`${base} LIMIT ? OFFSET ?`)
    .all(...values, pageSize, (page - 1) * pageSize)
    .map(serializePosition)

  return {
    data: rows,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
      has_next: page * pageSize < total
    }
  }
}

export function listPositionFacets(db, filters = {}) {
  const { sql, values } = positionWhere(filters)
  const conjunction = sql ? 'AND' : 'WHERE'
  const valuesFor = (column) => db.prepare(`
    SELECT DISTINCT p.${column} AS value
    FROM positions p ${sql}
    ${conjunction} p.${column} IS NOT NULL AND TRIM(p.${column}) <> ''
    ORDER BY value COLLATE NOCASE
  `).all(...values)
    .map((row) => String(row.value ?? '').trim())
    .filter(Boolean)
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
    FROM positions
  `).get()
  const statusCounts = Object.fromEntries(POSITION_STATUSES.map((status) => [status, 0]))
  for (const row of db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM positions
    WHERE archived_at IS NULL
    GROUP BY status
  `).all()) {
    if (POSITION_STATUSES.includes(row.status)) statusCounts[row.status] = Number(row.count ?? 0)
  }
  return {
    departments: valuesFor('department'),
    owners: valuesFor('owner'),
    locations: valuesFor('location'),
    totals: {
      total: Number(totals.total ?? 0),
      active: Number(totals.active ?? 0),
      archived: Number(totals.archived ?? 0)
    },
    status_counts: statusCounts
  }
}

export function insertPosition(db, position) {
  const timestamp = now()
  const record = {
    id: randomUUID(),
    title: position.title,
    department: position.department ?? null,
    location: position.location ?? null,
    owner: position.owner ?? null,
    headcount: position.headcount ?? 1,
    status: position.status ?? 'draft',
    description: position.description ?? null,
    tags: position.tags ?? [],
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null
    ,source_system: position.source_system ?? null
    ,source_record_id: position.source_record_id ?? null
    ,external_code: position.external_code ?? null
    ,category: position.category ?? null
    ,professional_line: position.professional_line ?? null
    ,job_sequence: position.job_sequence ?? null
    ,headcount_type: position.headcount_type ?? null
    ,project_name: position.project_name ?? null
  }
  db.prepare(`
    INSERT INTO positions(
      id, title, department, location, owner, headcount, status,
      description, tags, source_system, source_record_id, external_code,
      category, professional_line, job_sequence, headcount_type, project_name,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.title,
    record.department,
    record.location,
    record.owner,
    record.headcount,
    record.status,
    record.description,
    JSON.stringify(record.tags),
    record.source_system,
    record.source_record_id,
    record.external_code,
    record.category,
    record.professional_line,
    record.job_sequence,
    record.headcount_type,
    record.project_name,
    record.created_at,
    record.updated_at,
    record.archived_at
  )
  return getPosition(db, record.id)
}

export function patchPosition(db, id, patch) {
  const fields = POSITION_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field))
  if (fields.length === 0) return getPosition(db, id)
  const timestamp = now()
  const values = fields.map((field) => field === 'tags' ? JSON.stringify(patch.tags ?? []) : patch[field] ?? null)
  db.prepare(`
    UPDATE positions
    SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ?
    WHERE id = ?
  `).run(...values, timestamp, id)
  return getPosition(db, id)
}

export function archivePosition(db, id) {
  const timestamp = now()
  return db.prepare(`
    UPDATE positions SET archived_at = ?, updated_at = ?
    WHERE id = ? AND archived_at IS NULL
  `).run(timestamp, timestamp, id).changes > 0
}

function normalizePositionArchiveRecords(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw positionError(422, 'records 必须是非空数组', undefined, 'validation_error')
  }
  if (input.length > 100) {
    throw positionError(413, '单次最多归档 100 个职位', undefined, 'limit_exceeded')
  }

  const seen = new Set()
  return input.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw positionError(422, 'records 包含无效记录', [
        { field: `records.${index}`, message: '必须是对象' }
      ], 'validation_error')
    }
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const expectedUpdatedAt = typeof record.expected_updated_at === 'string'
      ? record.expected_updated_at.trim()
      : ''
    if (!id || id.length > 200) {
      throw positionError(422, 'records 包含无效职位 ID', [
        { field: `records.${index}.id`, message: '必须是 1 至 200 个字符' }
      ], 'validation_error')
    }
    if (!expectedUpdatedAt || expectedUpdatedAt.length > 200) {
      throw positionError(422, 'records 缺少有效版本', [
        { field: `records.${index}.expected_updated_at`, message: '必须是非空版本字符串' }
      ], 'validation_error')
    }
    if (seen.has(id)) {
      throw positionError(422, 'records 不能包含重复职位', [
        { field: `records.${index}.id`, message: '职位 ID 重复' }
      ], 'validation_error')
    }
    seen.add(id)
    return { id, expected_updated_at: expectedUpdatedAt }
  })
}

export function archivePositions(db, recordsInput) {
  const records = normalizePositionArchiveRecords(recordsInput)
  return withTransaction(db, () => {
    const placeholders = records.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT id, updated_at, archived_at
      FROM positions
      WHERE id IN (${placeholders})
    `).all(...records.map((record) => record.id))
    const byId = new Map(rows.map((row) => [row.id, row]))
    const missingIds = records.filter((record) => !byId.has(record.id)).map((record) => record.id)
    const alreadyArchivedIds = records
      .filter((record) => byId.get(record.id)?.archived_at)
      .map((record) => record.id)
    const versionConflictIds = records
      .filter((record) => {
        const row = byId.get(record.id)
        return row && !row.archived_at && row.updated_at !== record.expected_updated_at
      })
      .map((record) => record.id)

    if (missingIds.length || alreadyArchivedIds.length || versionConflictIds.length) {
      throw positionError(409, '职位批量归档校验失败，未修改任何职位', {
        missing_ids: missingIds,
        already_archived_ids: alreadyArchivedIds,
        version_conflict_ids: versionConflictIds
      }, 'position_archive_conflict')
    }

    const currentVersions = new Set(rows.map((row) => row.updated_at))
    let timestamp = now()
    while (currentVersions.has(timestamp)) {
      timestamp = new Date(Date.parse(timestamp) + 1).toISOString()
    }
    const update = db.prepare(`
      UPDATE positions
      SET archived_at = ?, updated_at = ?
      WHERE id = ? AND archived_at IS NULL AND updated_at = ?
    `)
    for (const record of records) {
      const result = update.run(timestamp, timestamp, record.id, record.expected_updated_at)
      if (result.changes !== 1) {
        throw positionError(409, '职位版本已变化，未修改任何职位', {
          missing_ids: [],
          already_archived_ids: [],
          version_conflict_ids: [record.id]
        }, 'position_archive_conflict')
      }
    }

    return {
      operation: 'archive',
      requested_count: records.length,
      updated_count: records.length,
      updated_ids: records.map((record) => record.id),
      items: records.map((record) => getPosition(db, record.id))
    }
  })
}

export function restorePosition(db, id) {
  const timestamp = now()
  return db.prepare(`
    UPDATE positions SET archived_at = NULL, updated_at = ?
    WHERE id = ? AND archived_at IS NOT NULL
  `).run(timestamp, id).changes > 0
}

export function listCandidatePositions(db, candidateId) {
  return db.prepare(`
    SELECT p.*, cp.created_at AS linked_at,
      (SELECT COUNT(*) FROM candidate_positions count_cp WHERE count_cp.position_id = p.id) AS candidate_count
    FROM candidate_positions cp
    JOIN positions p ON p.id = cp.position_id
    WHERE cp.candidate_id = ?
    ORDER BY p.archived_at IS NOT NULL ASC, p.updated_at DESC, p.title ASC
  `).all(candidateId).map(serializePosition)
}

export function attachPositionsToCandidates(db, candidates) {
  if (candidates.length === 0) return candidates
  const ids = candidates.map((candidate) => candidate.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT cp.candidate_id, cp.created_at AS linked_at, p.*,
      COALESCE(position_counts.candidate_count, 0) AS candidate_count
    FROM candidate_positions cp
    JOIN positions p ON p.id = cp.position_id
    LEFT JOIN (
      SELECT position_id, COUNT(*) AS candidate_count
      FROM candidate_positions
      GROUP BY position_id
    ) AS position_counts ON position_counts.position_id = p.id
    WHERE cp.candidate_id IN (${placeholders})
    ORDER BY p.archived_at IS NOT NULL ASC, p.updated_at DESC, p.title ASC
  `).all(...ids)
  const byCandidate = new Map(ids.map((id) => [id, []]))
  for (const row of rows) {
    const { candidate_id: candidateId, ...position } = row
    byCandidate.get(candidateId)?.push(serializePosition(position))
  }
  return candidates.map((candidate) => ({ ...candidate, positions: byCandidate.get(candidate.id) ?? [] }))
}

function normalizeCandidateIds(input) {
  if (!Array.isArray(input)) throw positionError(422, 'candidate_ids 必须是数组')
  if (input.length === 0) throw positionError(422, 'candidate_ids 不能为空')
  if (input.length > 100) throw positionError(413, '单次最多关联 100 名候选人')
  const cleaned = input.map((id, index) => {
    if (typeof id !== 'string' || !id.trim() || id.trim().length > 200) {
      throw positionError(422, 'candidate_ids 包含无效值', [{ field: `candidate_ids.${index}`, message: '候选人 ID 无效' }])
    }
    return id.trim()
  })
  return { ids: [...new Set(cleaned)], inputCount: cleaned.length }
}

export function linkCandidates(db, positionId, candidateIdsInput) {
  const { ids, inputCount } = normalizeCandidateIds(candidateIdsInput)
  return withTransaction(db, () => {
    const position = db.prepare('SELECT id, title, status, archived_at FROM positions WHERE id = ?').get(positionId)
    if (!position) throw positionError(404, '职位不存在', undefined, 'not_found')

    const placeholders = ids.map(() => '?').join(', ')
    const candidates = db.prepare(`
      SELECT id, archived_at FROM candidates WHERE id IN (${placeholders})
    `).all(...ids)
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const missing = ids.filter((id) => !candidateMap.has(id))
    if (missing.length) {
      throw positionError(404, '部分候选人不存在', { candidate_ids: missing }, 'not_found')
    }
    const existing = new Set(db.prepare(`
      SELECT candidate_id FROM candidate_positions
      WHERE position_id = ? AND candidate_id IN (${placeholders})
    `).all(positionId, ...ids).map((row) => row.candidate_id))
    const newCandidateIds = ids.filter((id) => !existing.has(id))
    if (newCandidateIds.length > 0 && position.archived_at) {
      throw positionError(409, '已归档职位不能新增候选人关联', { position_id: positionId }, 'conflict')
    }
    if (newCandidateIds.length > 0 && position.status === 'closed') {
      throw positionError(409, '已关闭职位不能新增候选人关联', { position_id: positionId }, 'conflict')
    }
    const archived = newCandidateIds.filter((id) => candidateMap.get(id).archived_at)
    if (archived.length) {
      throw positionError(409, '已归档候选人不能关联职位', { candidate_ids: archived }, 'conflict')
    }

    const timestamp = now()
    const insert = db.prepare(`
      INSERT INTO candidate_positions(candidate_id, position_id, created_at)
      VALUES (?, ?, ?)
    `)
    let linkedCount = 0
    for (const candidateId of ids) {
      if (existing.has(candidateId)) continue
      insert.run(candidateId, positionId, timestamp)
      db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, candidateId)
      addActivity(db, candidateId, 'position_linked', `关联职位：${position.title}`, {
        position_id: positionId,
        position_title: position.title
      })
      linkedCount += 1
    }
    if (linkedCount > 0) db.prepare('UPDATE positions SET updated_at = ? WHERE id = ?').run(timestamp, positionId)

    return {
      position_id: positionId,
      input_count: inputCount,
      requested_count: ids.length,
      duplicate_input_count: inputCount - ids.length,
      linked_count: linkedCount,
      existing_count: existing.size,
      position: getPosition(db, positionId)
    }
  })
}

export function unlinkCandidates(db, positionId, candidateIdsInput) {
  const { ids, inputCount } = normalizeCandidateIds(candidateIdsInput)
  return withTransaction(db, () => {
    const position = db.prepare('SELECT id, title FROM positions WHERE id = ?').get(positionId)
    if (!position) throw positionError(404, '职位不存在', undefined, 'not_found')
    const placeholders = ids.map(() => '?').join(', ')
    const candidates = db.prepare(`
      SELECT id, archived_at FROM candidates WHERE id IN (${placeholders})
    `).all(...ids)
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const missing = ids.filter((id) => !candidateMap.has(id))
    if (missing.length) {
      throw positionError(404, '部分候选人不存在', { candidate_ids: missing }, 'not_found')
    }
    const archived = ids.filter((id) => candidateMap.get(id).archived_at)
    if (archived.length) {
      throw positionError(409, '已归档候选人只能恢复或永久删除', { candidate_ids: archived }, 'candidate_archived')
    }

    const existing = new Set(db.prepare(`
      SELECT candidate_id FROM candidate_positions
      WHERE position_id = ? AND candidate_id IN (${placeholders})
    `).all(positionId, ...ids).map((row) => row.candidate_id))
    const timestamp = now()
    const remove = db.prepare(`
      DELETE FROM candidate_positions WHERE position_id = ? AND candidate_id = ?
    `)
    for (const candidateId of ids) {
      if (!existing.has(candidateId)) continue
      remove.run(positionId, candidateId)
      db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, candidateId)
      addActivity(db, candidateId, 'position_unlinked', `解除职位关联：${position.title}`, {
        position_id: positionId,
        position_title: position.title
      })
    }
    if (existing.size > 0) db.prepare('UPDATE positions SET updated_at = ? WHERE id = ?').run(timestamp, positionId)
    return {
      position_id: positionId,
      input_count: inputCount,
      requested_count: ids.length,
      duplicate_input_count: inputCount - ids.length,
      removed_count: existing.size,
      existing_count: existing.size,
      absent_count: ids.length - existing.size
    }
  })
}

export function unlinkCandidate(db, positionId, candidateId) {
  const result = unlinkCandidates(db, positionId, [candidateId])
  return { position_id: positionId, candidate_id: candidateId, removed: result.removed_count > 0 }
}
