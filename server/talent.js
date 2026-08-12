import { randomUUID } from 'node:crypto'
import { addActivity, now, withTransaction } from './database.js'

const POOL_FIELDS = ['name', 'description', 'color']
const PROFILE_SECTION_TYPES = new Set([
  'education',
  'experience',
  'project',
  'internship',
  'skill',
  'campus',
  'language',
  'certificate',
  'award',
  'training',
  'publication',
  'management',
  'other'
])

function talentError(status, message, details, code = 'request_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function cleanText(value, maxLength, { multiline = false, required = false } = {}) {
  if (value == null || value === '') return required ? undefined : null
  if (typeof value !== 'string') return undefined
  const text = multiline ? value.replace(/\r\n?/g, '\n').trim() : value.trim().replace(/\s+/g, ' ')
  if (!text) return required ? undefined : null
  return text.length <= maxLength ? text : undefined
}

function parsePositiveInteger(value, fallback, maximum, field) {
  if (value == null || value === '') return fallback
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) throw talentError(400, `${field} 必须是正整数`, undefined, 'invalid_query')
  const number = Number(text)
  if (number < 1 || number > maximum) {
    throw talentError(400, `${field} 必须在 1 至 ${maximum} 之间`, undefined, 'invalid_query')
  }
  return number
}

function normalizeCandidateIds(input) {
  if (!Array.isArray(input) || input.length === 0) throw talentError(422, 'candidate_ids 必须是非空数组', undefined, 'validation_error')
  if (input.length > 100) throw talentError(413, '单次最多处理 100 名候选人', undefined, 'limit_exceeded')
  const cleaned = input.map((value, index) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
      throw talentError(422, '候选人 ID 无效', [{ field: `candidate_ids.${index}`, message: '必须是 1 至 200 个字符' }], 'validation_error')
    }
    return value.trim()
  })
  return { ids: [...new Set(cleaned)], inputCount: cleaned.length }
}

export function sanitizeTalentPoolInput(input, { partial = false } = {}) {
  const value = {}
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value, errors: [{ field: 'body', message: '请求正文必须是对象' }] }
  }
  for (const field of Object.keys(input)) {
    if (!POOL_FIELDS.includes(field)) errors.push({ field, message: '不支持的人才库字段' })
  }
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field)
  if (!partial || has('name')) {
    value.name = cleanText(input.name, 200, { required: true })
    if (!value.name) errors.push({ field: 'name', message: '人才库名称必须是 1 至 200 个字符' })
  }
  if (!partial || has('description')) {
    value.description = cleanText(input.description, 5_000, { multiline: true })
    if (value.description === undefined) errors.push({ field: 'description', message: '人才库说明不能超过 5000 个字符' })
  }
  if (!partial || has('color')) {
    const color = input.color == null || input.color === '' ? '#2563eb' : String(input.color).trim()
    if (!/^#[0-9a-f]{6}$/i.test(color)) errors.push({ field: 'color', message: '颜色必须是 #RRGGBB 格式' })
    else value.color = color.toLowerCase()
  }
  return { value, errors }
}

function poolSelect() {
  return `
    SELECT tp.*, COUNT(ctp.candidate_id) AS candidate_count
    FROM talent_pools tp
    LEFT JOIN candidate_talent_pools ctp ON ctp.talent_pool_id = tp.id
  `
}

function serializePool(row) {
  return row ? { ...row, candidate_count: Number(row.candidate_count ?? 0) } : null
}

export function getTalentPool(db, id) {
  return serializePool(db.prepare(`${poolSelect()} WHERE tp.id = ? GROUP BY tp.id`).get(id))
}

export function talentPoolExists(db, id) {
  return Boolean(db.prepare('SELECT 1 FROM talent_pools WHERE id = ?').get(id))
}

export function listTalentPools(db, filters = {}) {
  const clauses = []
  const values = []
  const archived = String(filters.archived ?? 'exclude').trim().toLowerCase()
  if (!['exclude', 'include', 'only'].includes(archived)) throw talentError(400, 'archived 参数无效', undefined, 'invalid_query')
  if (archived === 'exclude') clauses.push('tp.archived_at IS NULL')
  if (archived === 'only') clauses.push('tp.archived_at IS NOT NULL')
  if (filters.search != null) {
    if (Array.isArray(filters.search) || typeof filters.search !== 'string' || filters.search.length > 300) {
      throw talentError(400, 'search 必须是最多 300 个字符', undefined, 'invalid_query')
    }
    const search = `%${filters.search.replace(/[!%_]/g, (character) => `!${character}`).trim()}%`
    clauses.push("(tp.name LIKE ? ESCAPE '!' OR tp.description LIKE ? ESCAPE '!')")
    values.push(search, search)
  }
  const sortMap = new Map([['name', 'tp.name'], ['created_at', 'tp.created_at'], ['updated_at', 'tp.updated_at'], ['candidate_count', 'candidate_count']])
  const requestedSort = String(filters.sort ?? '').trim()
  if (requestedSort && !sortMap.has(requestedSort)) throw talentError(400, '不支持的人才库排序字段', undefined, 'invalid_query')
  const requestedOrder = String(filters.order ?? '').trim().toLowerCase()
  if (requestedOrder && !['asc', 'desc'].includes(requestedOrder)) throw talentError(400, 'order 只支持 asc 或 desc', undefined, 'invalid_query')
  const page = parsePositiveInteger(filters.page, 1, 1_000_000, 'page')
  const pageSize = parsePositiveInteger(filters.page_size, 20, 100, 'page_size')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const sort = sortMap.get(requestedSort) ?? 'tp.updated_at'
  const order = requestedOrder === 'asc' ? 'ASC' : 'DESC'
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM talent_pools tp ${where}`).get(...values).count)
  const data = db.prepare(`
    ${poolSelect()} ${where} GROUP BY tp.id
    ORDER BY ${sort} ${order}, tp.id ASC LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize).map(serializePool)
  return {
    data,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
      has_next: page * pageSize < total
    }
  }
}

function translateUniquePoolError(error) {
  if (error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: talent_pools/i.test(error.message)) {
    throw talentError(409, '同名人才库已存在', undefined, 'conflict')
  }
  throw error
}

export function insertTalentPool(db, input) {
  const timestamp = now()
  const record = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    color: input.color ?? '#2563eb',
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null
  }
  try {
    db.prepare(`
      INSERT INTO talent_pools(id, name, description, color, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(record.id, record.name, record.description, record.color, timestamp, timestamp)
  } catch (error) {
    translateUniquePoolError(error)
  }
  return getTalentPool(db, record.id)
}

export function patchTalentPool(db, id, patch) {
  const fields = POOL_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field))
  if (fields.length === 0) return getTalentPool(db, id)
  try {
    db.prepare(`UPDATE talent_pools SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((field) => patch[field] ?? null), now(), id)
  } catch (error) {
    translateUniquePoolError(error)
  }
  return getTalentPool(db, id)
}

export function archiveTalentPool(db, id, expectedUpdatedAt) {
  if (expectedUpdatedAt !== undefined) {
    return archiveTalentPools(db, [{ id, expected_updated_at: expectedUpdatedAt }]).updated_count > 0
  }
  return withTransaction(db, () => {
    const timestamp = now()
    return db.prepare('UPDATE talent_pools SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(timestamp, timestamp, id).changes > 0
  })
}

export function restoreTalentPool(db, id, expectedUpdatedAt) {
  if (expectedUpdatedAt !== undefined) {
    return restoreTalentPools(db, [{ id, expected_updated_at: expectedUpdatedAt }]).updated_count > 0
  }
  return withTransaction(db, () => (
    db.prepare('UPDATE talent_pools SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL')
      .run(now(), id).changes > 0
  ))
}

function normalizeTalentPoolRecords(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw talentError(422, 'records 必须是非空数组', undefined, 'validation_error')
  }
  if (input.length > 100) {
    throw talentError(413, '单次最多处理 100 个人才库分组', undefined, 'limit_exceeded')
  }

  const seen = new Set()
  return input.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw talentError(422, 'records 包含无效记录', [
        { field: `records.${index}`, message: '必须是对象' }
      ], 'validation_error')
    }
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const expectedUpdatedAt = typeof record.expected_updated_at === 'string'
      ? record.expected_updated_at.trim()
      : ''
    if (!id || id.length > 200) {
      throw talentError(422, 'records 包含无效人才库 ID', [
        { field: `records.${index}.id`, message: '必须是 1 至 200 个字符' }
      ], 'validation_error')
    }
    if (!expectedUpdatedAt || expectedUpdatedAt.length > 200) {
      throw talentError(422, 'records 缺少有效版本', [
        { field: `records.${index}.expected_updated_at`, message: '必须是非空版本字符串' }
      ], 'validation_error')
    }
    if (seen.has(id)) {
      throw talentError(422, 'records 不能包含重复人才库', [
        { field: `records.${index}.id`, message: '人才库 ID 重复' }
      ], 'validation_error')
    }
    seen.add(id)
    return { id, expected_updated_at: expectedUpdatedAt }
  })
}

function validateTalentPoolBatch(db, records, operation) {
  const placeholders = records.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, updated_at, archived_at
    FROM talent_pools
    WHERE id IN (${placeholders})
  `).all(...records.map((record) => record.id))
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missingIds = records.filter((record) => !byId.has(record.id)).map((record) => record.id)
  const alreadyArchivedIds = operation === 'archive'
    ? records.filter((record) => byId.get(record.id)?.archived_at).map((record) => record.id)
    : []
  const notArchivedIds = operation === 'archive'
    ? []
    : records.filter((record) => {
        const row = byId.get(record.id)
        return row && !row.archived_at
      }).map((record) => record.id)
  const versionConflictIds = records.filter((record) => {
    const row = byId.get(record.id)
    const stateMatches = operation === 'archive' ? row && !row.archived_at : Boolean(row?.archived_at)
    return stateMatches && row.updated_at !== record.expected_updated_at
  }).map((record) => record.id)

  if (missingIds.length || alreadyArchivedIds.length || notArchivedIds.length || versionConflictIds.length) {
    const labels = {
      archive: '归档',
      restore: '恢复',
      permanent_delete: '永久删除'
    }
    throw talentError(409, `人才库批量${labels[operation]}校验失败，未修改任何数据`, {
      missing_ids: missingIds,
      already_archived_ids: alreadyArchivedIds,
      not_archived_ids: notArchivedIds,
      version_conflict_ids: versionConflictIds
    }, `talent_pool_${operation}_conflict`)
  }
  return rows
}

function talentPoolMutationTimestamp(rows) {
  const currentVersions = new Set(rows.map((row) => row.updated_at))
  let timestamp = now()
  while (currentVersions.has(timestamp)) {
    timestamp = new Date(Date.parse(timestamp) + 1).toISOString()
  }
  return timestamp
}

function mutateTalentPools(db, recordsInput, operation) {
  const records = normalizeTalentPoolRecords(recordsInput)
  return withTransaction(db, () => {
    const rows = validateTalentPoolBatch(db, records, operation)
    const timestamp = talentPoolMutationTimestamp(rows)
    const archivedAt = operation === 'archive' ? timestamp : null
    const stateClause = operation === 'archive' ? 'archived_at IS NULL' : 'archived_at IS NOT NULL'
    const update = db.prepare(`
      UPDATE talent_pools
      SET archived_at = ?, updated_at = ?
      WHERE id = ? AND ${stateClause} AND updated_at = ?
    `)
    for (const record of records) {
      const result = update.run(archivedAt, timestamp, record.id, record.expected_updated_at)
      if (result.changes !== 1) {
        throw talentError(409, '人才库版本已变化，未修改任何数据', {
          missing_ids: [],
          already_archived_ids: [],
          not_archived_ids: [],
          version_conflict_ids: [record.id]
        }, `talent_pool_${operation}_conflict`)
      }
    }
    return {
      operation,
      requested_count: records.length,
      updated_count: records.length,
      updated_ids: records.map((record) => record.id),
      items: records.map((record) => getTalentPool(db, record.id))
    }
  })
}

export function archiveTalentPools(db, recordsInput) {
  return mutateTalentPools(db, recordsInput, 'archive')
}

export function restoreTalentPools(db, recordsInput) {
  return mutateTalentPools(db, recordsInput, 'restore')
}

export function permanentlyDeleteTalentPools(db, recordsInput) {
  const records = normalizeTalentPoolRecords(recordsInput)
  return withTransaction(db, () => {
    validateTalentPoolBatch(db, records, 'permanent_delete')
    const placeholders = records.map(() => '?').join(', ')
    const poolIds = records.map((record) => record.id)
    const relations = db.prepare(`
      SELECT candidate_id, talent_pool_id
      FROM candidate_talent_pools
      WHERE talent_pool_id IN (${placeholders})
    `).all(...poolIds)

    db.prepare(`DELETE FROM candidate_talent_pools WHERE talent_pool_id IN (${placeholders})`).run(...poolIds)
    const remove = db.prepare(`
      DELETE FROM talent_pools
      WHERE id = ? AND archived_at IS NOT NULL AND updated_at = ?
    `)
    for (const record of records) {
      const result = remove.run(record.id, record.expected_updated_at)
      if (result.changes !== 1) {
        throw talentError(409, '人才库版本已变化，未删除任何数据', {
          missing_ids: [],
          already_archived_ids: [],
          not_archived_ids: [],
          version_conflict_ids: [record.id]
        }, 'talent_pool_permanent_delete_conflict')
      }
    }

    return {
      operation: 'permanent_delete',
      requested_count: records.length,
      deleted_count: records.length,
      deleted_ids: poolIds,
      affected_candidate_count: new Set(relations.map((relation) => relation.candidate_id)).size,
      relation_count: relations.length
    }
  })
}

export function linkCandidatesToTalentPool(db, poolId, candidateIdsInput) {
  const { ids, inputCount } = normalizeCandidateIds(candidateIdsInput)
  return withTransaction(db, () => {
    const pool = db.prepare('SELECT id, name, archived_at FROM talent_pools WHERE id = ?').get(poolId)
    if (!pool) throw talentError(404, '人才库不存在', undefined, 'not_found')
    if (pool.archived_at) throw talentError(409, '已归档人才库不能新增关联', undefined, 'conflict')
    const placeholders = ids.map(() => '?').join(', ')
    const candidates = db.prepare(`SELECT id, archived_at FROM candidates WHERE id IN (${placeholders})`).all(...ids)
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const missing = ids.filter((id) => !candidateMap.has(id))
    if (missing.length) throw talentError(404, '部分候选人不存在', { candidate_ids: missing }, 'not_found')
    const archived = ids.filter((id) => candidateMap.get(id).archived_at)
    if (archived.length) throw talentError(409, '已归档候选人不能加入人才库', { candidate_ids: archived }, 'conflict')
    const existing = new Set(db.prepare(`
      SELECT candidate_id FROM candidate_talent_pools
      WHERE talent_pool_id = ? AND candidate_id IN (${placeholders})
    `).all(poolId, ...ids).map((row) => row.candidate_id))
    const linkedIds = ids.filter((id) => !existing.has(id))
    const timestamp = now()
    const insert = db.prepare('INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, ?, ?)')
    for (const candidateId of linkedIds) {
      insert.run(candidateId, poolId, timestamp)
      db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, candidateId)
      addActivity(db, candidateId, 'talent_pool_linked', `加入人才库：${pool.name}`, { talent_pool_id: poolId, talent_pool_name: pool.name })
    }
    if (linkedIds.length) db.prepare('UPDATE talent_pools SET updated_at = ? WHERE id = ?').run(timestamp, poolId)
    return {
      talent_pool_id: poolId,
      input_count: inputCount,
      requested_count: ids.length,
      linked_count: linkedIds.length,
      already_linked_count: existing.size,
      linked_ids: linkedIds
    }
  })
}

export function unlinkCandidatesFromTalentPool(db, poolId, candidateIdsInput) {
  const { ids, inputCount } = normalizeCandidateIds(candidateIdsInput)
  return withTransaction(db, () => {
    const pool = db.prepare('SELECT id, name FROM talent_pools WHERE id = ?').get(poolId)
    if (!pool) throw talentError(404, '人才库不存在', undefined, 'not_found')
    const placeholders = ids.map(() => '?').join(', ')
    const candidates = db.prepare(`SELECT id, archived_at FROM candidates WHERE id IN (${placeholders})`).all(...ids)
    const archived = candidates.filter((candidate) => candidate.archived_at).map((candidate) => candidate.id)
    if (archived.length) {
      throw talentError(409, '已归档候选人只能恢复或永久删除', { candidate_ids: archived }, 'candidate_archived')
    }
    const existing = new Set(db.prepare(`
      SELECT candidate_id FROM candidate_talent_pools
      WHERE talent_pool_id = ? AND candidate_id IN (${placeholders})
    `).all(poolId, ...ids).map((row) => row.candidate_id))
    const timestamp = now()
    const remove = db.prepare('DELETE FROM candidate_talent_pools WHERE talent_pool_id = ? AND candidate_id = ?')
    for (const candidateId of existing) {
      remove.run(poolId, candidateId)
      db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, candidateId)
      addActivity(db, candidateId, 'talent_pool_unlinked', `移出人才库：${pool.name}`, { talent_pool_id: poolId, talent_pool_name: pool.name })
    }
    if (existing.size) db.prepare('UPDATE talent_pools SET updated_at = ? WHERE id = ?').run(timestamp, poolId)
    return {
      talent_pool_id: poolId,
      input_count: inputCount,
      requested_count: ids.length,
      unlinked_count: existing.size,
      not_linked_count: ids.length - existing.size,
      unlinked_ids: [...existing]
    }
  })
}

function normalizeTextArray(value, field) {
  if (value == null || value === '') return []
  const values = Array.isArray(value) ? value : String(value).split(/[,，;；|\n]+/)
  if (values.length > 50) throw talentError(422, `${field} 最多 50 项`, undefined, 'validation_error')
  const cleaned = []
  const seen = new Set()
  for (const item of values) {
    if (typeof item !== 'string' || item.trim().length > 300) throw talentError(422, `${field} 包含无效值`, undefined, 'validation_error')
    const text = item.trim().replace(/\s+/g, ' ')
    if (text && !seen.has(text)) {
      seen.add(text)
      cleaned.push(text)
    }
  }
  return cleaned
}

function checkedJson(value, field, maximum = 200_000) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw talentError(422, `${field} 必须是对象`, undefined, 'validation_error')
  const text = JSON.stringify(value)
  if (text.length > maximum) throw talentError(413, `${field} 超过大小限制`, undefined, 'limit_exceeded')
  return value
}

export function replaceCandidatePreferences(db, candidateId, input) {
  if (!db.prepare('SELECT 1 FROM candidates WHERE id = ?').get(candidateId)) throw talentError(404, '候选人不存在', undefined, 'not_found')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw talentError(422, '求职偏好必须是对象', undefined, 'validation_error')
  const allowed = new Set(['employment_status', 'desired_titles', 'desired_locations', 'employment_type', 'expected_salary', 'availability', 'raw_payload'])
  const unknown = Object.keys(input).filter((field) => !allowed.has(field))
  if (unknown.length) throw talentError(422, '包含不支持的求职偏好字段', unknown.map((field) => ({ field })), 'validation_error')
  const record = {
    employment_status: cleanText(input.employment_status, 200),
    desired_titles: normalizeTextArray(input.desired_titles, 'desired_titles'),
    desired_locations: normalizeTextArray(input.desired_locations, 'desired_locations'),
    employment_type: cleanText(input.employment_type, 200),
    expected_salary: cleanText(input.expected_salary, 200),
    availability: cleanText(input.availability, 200),
    raw_payload: checkedJson(input.raw_payload, 'raw_payload')
  }
  for (const field of ['employment_status', 'employment_type', 'expected_salary', 'availability']) {
    if (record[field] === undefined) throw talentError(422, `${field} 格式无效`, undefined, 'validation_error')
  }
  return withTransaction(db, () => {
    const timestamp = now()
    db.prepare(`
      INSERT INTO candidate_preferences(
        candidate_id, employment_status, desired_titles, desired_locations,
        employment_type, expected_salary, availability, raw_payload, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        employment_status = excluded.employment_status,
        desired_titles = excluded.desired_titles,
        desired_locations = excluded.desired_locations,
        employment_type = excluded.employment_type,
        expected_salary = excluded.expected_salary,
        availability = excluded.availability,
        raw_payload = excluded.raw_payload,
        updated_at = excluded.updated_at
    `).run(
      candidateId,
      record.employment_status,
      JSON.stringify(record.desired_titles),
      JSON.stringify(record.desired_locations),
      record.employment_type,
      record.expected_salary,
      record.availability,
      JSON.stringify(record.raw_payload),
      timestamp
    )
    db.prepare(`
      UPDATE candidates SET job_seeking_status = COALESCE(?, job_seeking_status),
        expected_salary = COALESCE(?, expected_salary), updated_at = ? WHERE id = ?
    `).run(record.employment_status, record.expected_salary, timestamp, candidateId)
    addActivity(db, candidateId, 'preferences_updated', '更新求职偏好')
    return record
  })
}

export function replaceCandidateProfileSections(db, candidateId, input) {
  if (!db.prepare('SELECT 1 FROM candidates WHERE id = ?').get(candidateId)) throw talentError(404, '候选人不存在', undefined, 'not_found')
  const sections = input?.sections
  if (!Array.isArray(sections)) throw talentError(422, 'sections 必须是数组', undefined, 'validation_error')
  if (sections.length > 100) throw talentError(413, '单次最多保存 100 个资料区块', undefined, 'limit_exceeded')
  const normalized = sections.map((section, index) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw talentError(422, `sections.${index} 无效`, undefined, 'validation_error')
    const sectionType = cleanText(section.section_type, 80, { required: true })
    if (!PROFILE_SECTION_TYPES.has(sectionType)) throw talentError(422, `sections.${index}.section_type 无效`, undefined, 'validation_error')
    const content = cleanText(section.content, 100_000, { multiline: true })
    const title = cleanText(section.title, 300)
    const sensitivity = section.sensitivity == null ? 'internal' : String(section.sensitivity).trim().toLowerCase()
    if (!['public', 'internal', 'high'].includes(sensitivity)) throw talentError(422, `sections.${index}.sensitivity 无效`, undefined, 'validation_error')
    if (content === undefined || title === undefined) throw talentError(422, `sections.${index} 文本超过限制`, undefined, 'validation_error')
    return {
      id: typeof section.id === 'string' && section.id.trim() ? section.id.trim().slice(0, 200) : randomUUID(),
      id_was_provided: typeof section.id === 'string' && Boolean(section.id.trim()),
      section_type: sectionType,
      title,
      content,
      structured_data: checkedJson(section.structured_data, `sections.${index}.structured_data`),
      sort_order: Number.isInteger(section.sort_order) && section.sort_order >= 0 && section.sort_order <= 10_000 ? section.sort_order : index,
      sensitivity,
      source_record_id: cleanText(section.source_record_id, 300)
    }
  })
  return withTransaction(db, () => {
    const timestamp = now()
    for (const section of normalized) {
      if (!section.id_was_provided) continue
      const owner = db.prepare('SELECT candidate_id FROM candidate_profile_sections WHERE id = ?').get(section.id)
      if (owner && owner.candidate_id !== candidateId) {
        throw talentError(409, '资料区块 ID 已属于其他候选人', { section_id: section.id }, 'conflict')
      }
    }
    db.prepare(`
      UPDATE candidate_profile_sections SET archived_at = ?, updated_at = ?
      WHERE candidate_id = ? AND archived_at IS NULL
    `).run(timestamp, timestamp, candidateId)
    const insert = db.prepare(`
      INSERT INTO candidate_profile_sections(
        id, candidate_id, section_type, title, content, structured_data,
        sort_order, sensitivity, source_record_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        section_type = excluded.section_type,
        title = excluded.title,
        content = excluded.content,
        structured_data = excluded.structured_data,
        sort_order = excluded.sort_order,
        sensitivity = excluded.sensitivity,
        source_record_id = excluded.source_record_id,
        updated_at = excluded.updated_at,
        archived_at = NULL
    `)
    for (const section of normalized) {
      insert.run(
        section.id, candidateId, section.section_type, section.title, section.content,
        JSON.stringify(section.structured_data), section.sort_order, section.sensitivity,
        section.source_record_id, timestamp, timestamp
      )
    }
    db.prepare('UPDATE candidates SET updated_at = ? WHERE id = ?').run(timestamp, candidateId)
    addActivity(db, candidateId, 'profile_sections_updated', '更新人才资料区块', { section_count: normalized.length })
    return normalized.map(({ id_was_provided, ...section }) => ({
      ...section,
      candidate_id: candidateId,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null
    }))
  })
}
