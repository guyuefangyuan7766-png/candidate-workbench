import { createHash, randomUUID } from 'node:crypto'
import { CANDIDATE_FIELDS } from './constants.js'
import {
  addActivity,
  findDuplicate,
  getCandidate,
  now,
  serializeActivity,
  serializeCandidate,
  withTransaction
} from './database.js'
import { attachPositionsToCandidates, listPositions } from './positions.js'
import { formatYearsExperience, normalizeGender, normalizeYearsExperience } from './validation.js'

const candidateStatementCache = new WeakMap()

function candidateStatements(db) {
  let statements = candidateStatementCache.get(db)
  if (statements) return statements
  statements = {
    insert: db.prepare(`
      INSERT INTO candidates(
        id, name, phone, email, photo_url, current_company, current_title, location,
        gender, birth_date, age, years_experience, years_experience_raw, education, highest_school, highest_major,
        job_seeking_status, hire_position, hire_status, hire_date, resume_updated_at, self_summary, source, stage, owner, tags,
        expected_salary, source_system, source_record_id, import_batch_id,
        created_at, updated_at, archived_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `),
    updates: new Map()
  }
  candidateStatementCache.set(db, statements)
  return statements
}

function candidateUpdateStatement(db, fields) {
  const statements = candidateStatements(db)
  const key = fields.join('\u0000')
  let statement = statements.updates.get(key)
  if (statement) return statement
  const assignments = fields.map((field) => `${field} = ?`)
  assignments.push('updated_at = ?')
  statement = db.prepare(`UPDATE candidates SET ${assignments.join(', ')} WHERE id = ?`)
  statements.updates.set(key, statement)
  return statement
}

const CANDIDATE_SORT_FIELDS = new Set([
  'name',
  'created_at',
  'updated_at',
  'stage',
  'current_company',
  'years_experience',
  'education',
  'highest_school',
  'highest_major',
  'job_seeking_status',
  'resume_updated_at'
])

function candidateQueryError(field, message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'invalid_query'
  error.details = [{ field, message }]
  return error
}

function candidateOperationError(status, message, details, code = 'request_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function normalizeCandidateIds(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw candidateOperationError(422, 'candidate_ids 必须是非空数组', undefined, 'validation_error')
  }
  if (input.length > 100) {
    throw candidateOperationError(413, '单次最多归档 100 名候选人', undefined, 'limit_exceeded')
  }
  const cleaned = input.map((value, index) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
      throw candidateOperationError(
        422,
        '候选人 ID 无效',
        [{ field: `candidate_ids.${index}`, message: '必须是 1 至 200 个字符' }],
        'validation_error'
      )
    }
    return value.trim()
  })
  return { ids: [...new Set(cleaned)], inputCount: cleaned.length }
}

function candidateIdHash(candidateId) {
  return createHash('sha256').update(candidateId, 'utf8').digest('hex')
}

function singleQueryValue(filters, field) {
  const value = filters?.[field]
  if (value == null) return undefined
  if (Array.isArray(value) || typeof value === 'object') {
    throw candidateQueryError(field, `${field} 必须是单值查询参数`)
  }
  return value
}

function textQueryValue(filters, field, maximum) {
  const value = singleQueryValue(filters, field)
  if (value == null) return undefined
  if (typeof value !== 'string') {
    throw candidateQueryError(field, `${field} 必须是文本`)
  }
  const normalized = value.trim()
  if (normalized.length > maximum) {
    throw candidateQueryError(field, `${field} 不能超过 ${maximum} 个字符`)
  }
  return normalized || undefined
}

function enumQueryValue(filters, field, allowed, fallback) {
  const value = textQueryValue(filters, field, 40)
  if (value == null) return fallback
  const normalized = value.toLowerCase()
  if (!allowed.includes(normalized)) {
    throw candidateQueryError(field, `${field} 仅支持 ${allowed.join('、')}`)
  }
  return normalized
}

function positiveIntegerQueryValue(filters, field, fallback, maximum) {
  const value = singleQueryValue(filters, field)
  if (value == null || value === '') return fallback
  const raw = typeof value === 'number' ? String(value) : value
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw candidateQueryError(field, `${field} 必须是正整数`)
  }
  const parsed = Number(raw.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw candidateQueryError(field, `${field} 必须在 1 至 ${maximum} 之间`)
  }
  return parsed
}

function escapeLike(value) {
  return value.replace(/[!%_]/g, (character) => `!${character}`)
}

function normalizeCandidateQuery(filters = {}) {
  const archived = enumQueryValue(filters, 'archived', ['include', 'only', 'exclude'], 'include')
  const requestedSort = textQueryValue(filters, 'sort', 80)
  if (requestedSort && !CANDIDATE_SORT_FIELDS.has(requestedSort)) {
    throw candidateQueryError('sort', '不支持的候选人排序字段')
  }
  const order = enumQueryValue(filters, 'order', ['asc', 'desc'], 'desc')
  const genderInput = textQueryValue(filters, 'gender', 40)
  const gender = genderInput == null ? undefined : normalizeGender(genderInput)
  if (genderInput && !gender) throw candidateQueryError('gender', 'gender 仅支持男、女、其他或未说明')
  const query = {
    archived,
    search: textQueryValue(filters, 'search', 300),
    stage: textQueryValue(filters, 'stage', 80),
    source: textQueryValue(filters, 'source', 200),
    owner: textQueryValue(filters, 'owner', 200),
    source_system: textQueryValue(filters, 'source_system', 120),
    tag: textQueryValue(filters, 'tag', 80),
    position_id: textQueryValue(filters, 'position_id', 200),
    exclude_position_id: textQueryValue(filters, 'exclude_position_id', 200),
    pool_id: textQueryValue(filters, 'pool_id', 200),
    exclude_pool_id: textQueryValue(filters, 'exclude_pool_id', 200),
    education: textQueryValue(filters, 'education', 200),
    school: textQueryValue(filters, 'school', 300),
    major: textQueryValue(filters, 'major', 300),
    gender,
    job_seeking_status: textQueryValue(filters, 'job_seeking_status', 200),
    sort: requestedSort ?? 'updated_at',
    order,
    page: positiveIntegerQueryValue(filters, 'page', 1, 1_000_000),
    page_size: positiveIntegerQueryValue(filters, 'page_size', 20, 100)
  }
  return query
}

function toDatabaseValue(field, value) {
  if (field === 'tags') return JSON.stringify(value ?? [])
  return value ?? null
}

function normalizedYearsNumeric(value) {
  if (value == null) return null
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

function workYearsPair(candidate) {
  const hasRaw = Object.prototype.hasOwnProperty.call(candidate, 'years_experience_raw')
  const hasNumeric = Object.prototype.hasOwnProperty.call(candidate, 'years_experience') &&
    candidate.years_experience !== undefined
  if (!hasRaw && !hasNumeric) return null

  if (hasRaw) {
    const normalized = normalizeYearsExperience(candidate.years_experience_raw)
    return {
      years_experience_raw: normalized.raw,
      years_experience: normalized.numeric
    }
  }

  const yearsExperience = normalizedYearsNumeric(candidate.years_experience)
  return {
    years_experience: yearsExperience,
    years_experience_raw: formatYearsExperience({ raw: '', numeric: yearsExperience })
  }
}

export function insertCandidate(db, candidate, {
  activityType = 'candidate_created',
  activityMetadata = {},
  hydrate = true
} = {}) {
  const id = candidate.id ?? randomUUID()
  const timestamp = now()
  const years = workYearsPair(candidate)
  const record = {
    ...Object.fromEntries(CANDIDATE_FIELDS.map((field) => [field, null])),
    ...candidate,
    ...years,
    id,
    stage: candidate.stage ?? '新候选人',
    tags: candidate.tags ?? [],
    years_experience_raw: years?.years_experience_raw ?? '',
    created_at: candidate.created_at ?? timestamp,
    updated_at: candidate.updated_at ?? timestamp,
    archived_at: candidate.archived_at ?? null
  }

  candidateStatements(db).insert.run(
    record.id,
    record.name,
    record.phone,
    record.email,
    record.photo_url,
    record.current_company,
    record.current_title,
    record.location,
    record.gender,
    record.birth_date,
    record.age,
    record.years_experience,
    record.years_experience_raw,
    record.education,
    record.highest_school,
    record.highest_major,
    record.job_seeking_status,
    record.hire_position,
    record.hire_status,
    record.hire_date,
    record.resume_updated_at,
    record.self_summary,
    record.source,
    record.stage,
    record.owner,
    JSON.stringify(record.tags),
    record.expected_salary,
    record.source_system,
    record.source_record_id,
    record.import_batch_id,
    record.created_at,
    record.updated_at,
    record.archived_at
  )

  addActivity(db, id, activityType, activityType === 'candidate_imported' ? '通过文件导入候选人' : '创建候选人', activityMetadata)
  return hydrate ? getCandidate(db, id) : { id, updated_at: record.updated_at }
}

export function patchCandidate(db, id, patch, {
  activityType = 'candidate_updated',
  activityMetadata = {},
  hydrate = true
} = {}) {
  const years = workYearsPair(patch)
  const normalizedPatch = years ? { ...patch, ...years } : patch
  const fields = CANDIDATE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(normalizedPatch, field))
  if (fields.length === 0) return hydrate ? getCandidate(db, id) : { id, updated_at: null }

  const timestamp = now()
  const values = fields.map((field) => toDatabaseValue(field, normalizedPatch[field]))
  values.push(timestamp, id)

  candidateUpdateStatement(db, fields).run(...values)
  addActivity(db, id, activityType, activityType === 'candidate_import_updated' ? '导入数据更新候选人' : '更新候选人', {
    fields,
    ...activityMetadata
  })
  return hydrate ? getCandidate(db, id) : { id, updated_at: timestamp }
}

export function archiveCandidate(db, id) {
  const archivedAt = now()
  const result = db.prepare(`
    UPDATE candidates SET archived_at = ?, updated_at = ?
    WHERE id = ? AND archived_at IS NULL
  `).run(archivedAt, archivedAt, id)
  if (result.changes) addActivity(db, id, 'candidate_archived', '归档候选人')
  return result.changes > 0
}

export function archiveCandidates(db, candidateIdsInput) {
  const { ids, inputCount } = normalizeCandidateIds(candidateIdsInput)
  return withTransaction(db, () => {
    const placeholders = ids.map(() => '?').join(', ')
    const candidates = db.prepare(`
      SELECT id, archived_at FROM candidates WHERE id IN (${placeholders})
    `).all(...ids)
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length) {
      throw candidateOperationError(404, '部分候选人不存在', { candidate_ids: missing }, 'not_found')
    }
    const alreadyArchived = ids.filter((id) => byId.get(id).archived_at)
    if (alreadyArchived.length) {
      throw candidateOperationError(
        409,
        '已归档候选人只能恢复或永久删除',
        { candidate_ids: alreadyArchived },
        'candidate_archived'
      )
    }

    const archivedAt = now()
    const update = db.prepare(`
      UPDATE candidates SET archived_at = ?, updated_at = ?
      WHERE id = ? AND archived_at IS NULL
    `)
    for (const candidateId of ids) {
      const result = update.run(archivedAt, archivedAt, candidateId)
      if (result.changes !== 1) {
        throw candidateOperationError(409, '候选人状态已变化，请刷新后重试', { candidate_id: candidateId }, 'version_conflict')
      }
      addActivity(db, candidateId, 'candidate_archived', '归档候选人', { bulk: ids.length > 1 })
    }
    return {
      input_count: inputCount,
      requested_count: ids.length,
      duplicate_input_count: inputCount - ids.length,
      archived_count: ids.length,
      archived_ids: ids
    }
  })
}

export function restoreCandidate(db, id) {
  const timestamp = now()
  const result = db.prepare(`
    UPDATE candidates SET archived_at = NULL, updated_at = ?
    WHERE id = ? AND archived_at IS NOT NULL
  `).run(timestamp, id)
  if (result.changes) addActivity(db, id, 'candidate_restored', '恢复候选人')
  return result.changes > 0
}

export function assertCandidateActive(db, id) {
  const candidate = db.prepare('SELECT id, archived_at, updated_at FROM candidates WHERE id = ?').get(id)
  if (!candidate) throw candidateOperationError(404, '候选人不存在', undefined, 'not_found')
  if (candidate.archived_at) {
    throw candidateOperationError(409, '已归档候选人只能恢复或永久删除', undefined, 'candidate_archived')
  }
  return candidate
}

export function permanentlyDeleteCandidate(db, id, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw candidateOperationError(422, '永久删除请求必须是对象', undefined, 'validation_error')
  }
  if (input.confirmation !== '永久删除') {
    throw candidateOperationError(
      422,
      '必须输入确认词“永久删除”',
      [{ field: 'confirmation', message: '确认词不匹配' }],
      'confirmation_required'
    )
  }
  if (typeof input.expected_updated_at !== 'string' || !input.expected_updated_at || input.expected_updated_at.length > 80) {
    throw candidateOperationError(
      422,
      'expected_updated_at 必须是候选人当前更新时间',
      [{ field: 'expected_updated_at', message: '必须是 1 至 80 个字符' }],
      'validation_error'
    )
  }

  return withTransaction(db, () => {
    const candidate = db.prepare(`
      SELECT id, archived_at, updated_at FROM candidates WHERE id = ?
    `).get(id)
    if (!candidate) throw candidateOperationError(404, '候选人不存在', undefined, 'not_found')
    if (!candidate.archived_at) {
      throw candidateOperationError(409, '活动候选人必须先归档才能永久删除', undefined, 'candidate_not_archived')
    }
    if (candidate.updated_at !== input.expected_updated_at) {
      throw candidateOperationError(
        409,
        '候选人已发生变化，请刷新后重新确认',
        { current_updated_at: candidate.updated_at },
        'version_conflict'
      )
    }

    const deletedAt = now()
    const auditId = randomUUID()
    const deleted = db.prepare(`
      DELETE FROM candidates WHERE id = ? AND archived_at IS NOT NULL AND updated_at = ?
    `).run(id, input.expected_updated_at)
    if (deleted.changes !== 1) {
      throw candidateOperationError(409, '候选人状态已变化，请刷新后重试', undefined, 'version_conflict')
    }
    db.prepare(`
      INSERT INTO deletion_audits(id, candidate_id_hash, deleted_at) VALUES (?, ?, ?)
    `).run(auditId, candidateIdHash(id), deletedAt)
    return {
      deleted: true,
      candidate_id: id,
      deleted_at: deletedAt,
      audit_id: auditId
    }
  })
}

function candidateWhere(filters = {}) {
  const clauses = []
  const values = []
  const archived = filters.archived
  if (archived === 'only') clauses.push('archived_at IS NOT NULL')
  else if (archived === 'exclude') clauses.push('archived_at IS NULL')

  if (filters.search) {
    const search = `%${escapeLike(filters.search)}%`
    clauses.push(`(
      candidates.name LIKE ? ESCAPE '!' OR candidates.current_company LIKE ? ESCAPE '!'
      OR candidates.current_title LIKE ? ESCAPE '!' OR candidates.location LIKE ? ESCAPE '!'
      OR candidates.owner LIKE ? ESCAPE '!' OR candidates.source LIKE ? ESCAPE '!'
      OR candidates.education LIKE ? ESCAPE '!' OR candidates.highest_school LIKE ? ESCAPE '!'
      OR candidates.highest_major LIKE ? ESCAPE '!' OR candidates.job_seeking_status LIKE ? ESCAPE '!'
      OR EXISTS (
        SELECT 1
        FROM json_each(
          CASE WHEN json_valid(candidates.tags) THEN candidates.tags ELSE '[]' END
        ) AS search_tag
        WHERE search_tag.type = 'text' AND search_tag.value LIKE ? ESCAPE '!'
      )
      OR EXISTS (
        SELECT 1
        FROM candidate_positions search_cp
        JOIN positions search_position ON search_position.id = search_cp.position_id
        WHERE search_cp.candidate_id = candidates.id
          AND search_position.title LIKE ? ESCAPE '!'
      )
      OR EXISTS (
        SELECT 1
        FROM candidate_talent_pools search_ctp
        JOIN talent_pools search_pool ON search_pool.id = search_ctp.talent_pool_id
        WHERE search_ctp.candidate_id = candidates.id
          AND search_pool.name LIKE ? ESCAPE '!'
      )
    )`)
    values.push(search, search, search, search, search, search, search, search, search, search, search, search, search)
  }
  for (const field of ['stage', 'source', 'owner', 'source_system']) {
    if (filters[field]) {
      clauses.push(`candidates.${field} = ?`)
      values.push(filters[field])
    }
  }
  if (filters.tag) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM json_each(
        CASE WHEN json_valid(candidates.tags) THEN candidates.tags ELSE '[]' END
      ) AS exact_tag
      WHERE exact_tag.type = 'text' AND exact_tag.value = ?
    )`)
    values.push(filters.tag)
  }
  if (filters.position_id) {
    const positionId = filters.position_id
    if (positionId === 'unassigned') {
      clauses.push('NOT EXISTS (SELECT 1 FROM candidate_positions cp WHERE cp.candidate_id = candidates.id)')
    } else if (positionId) {
      clauses.push(`EXISTS (
        SELECT 1 FROM candidate_positions cp
        WHERE cp.candidate_id = candidates.id AND cp.position_id = ?
      )`)
      values.push(positionId)
    }
  }
  if (filters.exclude_position_id) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM candidate_positions excluded_cp
      WHERE excluded_cp.candidate_id = candidates.id AND excluded_cp.position_id = ?
    )`)
    values.push(filters.exclude_position_id)
  }
  if (filters.pool_id) {
    if (filters.pool_id === 'unassigned') {
      clauses.push('NOT EXISTS (SELECT 1 FROM candidate_talent_pools ctp WHERE ctp.candidate_id = candidates.id)')
    } else {
      clauses.push(`EXISTS (
        SELECT 1 FROM candidate_talent_pools ctp
        WHERE ctp.candidate_id = candidates.id AND ctp.talent_pool_id = ?
      )`)
      values.push(filters.pool_id)
    }
  }
  if (filters.exclude_pool_id) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM candidate_talent_pools excluded_ctp
      WHERE excluded_ctp.candidate_id = candidates.id AND excluded_ctp.talent_pool_id = ?
    )`)
    values.push(filters.exclude_pool_id)
  }
  for (const [filter, column] of [
    ['education', 'education'],
    ['school', 'highest_school'],
    ['major', 'highest_major'],
    ['gender', 'gender'],
    ['job_seeking_status', 'job_seeking_status']
  ]) {
    if (filters[filter]) {
      clauses.push(`candidates.${column} = ?`)
      values.push(filters[filter])
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values }
}

function withoutSensitiveListFields(candidate) {
  const result = { ...candidate }
  for (const field of ['phone', 'email', 'photo_url', 'expected_salary', 'source_record_id', 'import_batch_id', 'self_summary', 'stage']) {
    delete result[field]
  }
  return result
}

function attachTalentPoolsToCandidates(db, candidates) {
  if (candidates.length === 0) return candidates
  const ids = candidates.map((candidate) => candidate.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT ctp.candidate_id, ctp.created_at AS linked_at, tp.*
    FROM candidate_talent_pools ctp
    JOIN talent_pools tp ON tp.id = ctp.talent_pool_id
    WHERE ctp.candidate_id IN (${placeholders})
    ORDER BY tp.archived_at IS NOT NULL, tp.name COLLATE NOCASE
  `).all(...ids)
  const byCandidate = new Map(ids.map((id) => [id, []]))
  for (const row of rows) {
    const { candidate_id: candidateId, ...pool } = row
    byCandidate.get(candidateId)?.push(pool)
  }
  return candidates.map((candidate) => ({ ...candidate, talent_pools: byCandidate.get(candidate.id) ?? [] }))
}

export function listCandidates(db, filters = {}, { paginate = true, includeSensitive = false } = {}) {
  const query = normalizeCandidateQuery(filters)
  const { sql, values } = candidateWhere(query)
  const sort = `candidates.${query.sort}`
  const order = query.order === 'asc' ? 'ASC' : 'DESC'
  const ordering = `${sort} ${order}, candidates.id ASC`

  if (!paginate) {
    const rows = db.prepare(`SELECT * FROM candidates ${sql} ORDER BY ${ordering}`).all(...values).map(serializeCandidate)
    return includeSensitive ? rows : rows.map(withoutSensitiveListFields)
  }

  const page = query.page
  const pageSize = query.page_size
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM candidates ${sql}`).get(...values).count)
  let rows = attachPositionsToCandidates(db, db.prepare(`
    SELECT * FROM candidates ${sql}
    ORDER BY ${ordering}
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize).map(serializeCandidate))
  rows = attachTalentPoolsToCandidates(db, rows)
  if (!includeSensitive) rows = rows.map(withoutSensitiveListFields)

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

function facetValues(db, sql, values) {
  return db.prepare(sql).all(...values)
    .map((row) => String(row.value ?? '').trim())
    .filter(Boolean)
}

export function listCandidateFacets(db, filters = {}) {
  const query = normalizeCandidateQuery({ ...filters, page: 1, page_size: 20 })
  const { sql, values } = candidateWhere(query)
  const filtered = `WITH filtered_candidates AS (SELECT * FROM candidates ${sql})`
  const textFacet = (column) => facetValues(db, `
    ${filtered}
    SELECT DISTINCT ${column} AS value
    FROM filtered_candidates
    WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''
    ORDER BY value COLLATE NOCASE
  `, values)
  const tags = facetValues(db, `
    ${filtered}
    SELECT DISTINCT tag.value AS value
    FROM filtered_candidates
    JOIN json_each(
      CASE WHEN json_valid(filtered_candidates.tags) THEN filtered_candidates.tags ELSE '[]' END
    ) AS tag
    WHERE tag.type = 'text' AND TRIM(tag.value) <> ''
    ORDER BY value COLLATE NOCASE
  `, values)
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
    FROM candidates
  `).get()
  return {
    sources: textFacet('source'),
    owners: textFacet('owner'),
    tags,
    education: textFacet('education'),
    schools: textFacet('highest_school'),
    genders: textFacet('gender'),
    job_seeking_statuses: textFacet('job_seeking_status'),
    totals: {
      total: Number(totals.total ?? 0),
      active: Number(totals.active ?? 0),
      archived: Number(totals.archived ?? 0)
    }
  }
}

export function addNote(db, candidateId, content, author = '当前用户') {
  const timestamp = now()
  const note = { id: randomUUID(), candidate_id: candidateId, content, author, created_at: timestamp, updated_at: timestamp }
  db.prepare(`
    INSERT INTO notes(id, candidate_id, content, author, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(note.id, note.candidate_id, note.content, note.author, note.created_at, note.updated_at)
  addActivity(db, candidateId, 'note_added', '添加备注', { note_id: note.id })
  return note
}

export function listNotes(db, candidateId) {
  return db.prepare(`
    SELECT id, candidate_id, content, author, created_at, updated_at
    FROM notes WHERE candidate_id = ? ORDER BY created_at DESC
  `).all(candidateId)
}

export function listActivities(db, candidateId) {
  return db.prepare(`
    SELECT id, candidate_id, type, description, metadata, created_at
    FROM activities WHERE candidate_id = ? ORDER BY created_at DESC
  `).all(candidateId).map(serializeActivity)
}

export function dashboard(db) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
    FROM candidates
  `).get()
  const byStage = db.prepare(`
    SELECT s.value, s.label, s.color, s.position, COUNT(c.id) AS count
    FROM stages s
    LEFT JOIN candidates c ON c.stage = s.value AND c.archived_at IS NULL
    GROUP BY s.value, s.label, s.color, s.position
    ORDER BY s.position ASC
  `).all().map((row) => ({ ...row, count: Number(row.count) }))
  const bySource = db.prepare(`
    SELECT COALESCE(NULLIF(source, ''), '未设置') AS source, COUNT(*) AS count
    FROM candidates WHERE archived_at IS NULL
    GROUP BY COALESCE(NULLIF(source, ''), '未设置')
    ORDER BY count DESC, source ASC LIMIT 10
  `).all().map((row) => ({ ...row, count: Number(row.count) }))
  const recent = db.prepare(`
    SELECT * FROM candidates WHERE archived_at IS NULL
    ORDER BY updated_at DESC LIMIT 8
  `).all().map(serializeCandidate).map(withoutSensitiveListFields)
  const positionTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN archived_at IS NULL AND status = 'open' THEN 1 ELSE 0 END) AS open
    FROM positions
  `).get()
  const positionsByStatus = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM positions
    WHERE archived_at IS NULL
    GROUP BY status
    ORDER BY status ASC
  `).all().map((row) => ({ ...row, count: Number(row.count) }))
  const recentPositions = listPositions(db, {
    archived: 'exclude',
    sort: 'updated_at',
    order: 'desc',
    page: 1,
    page_size: 6
  }).data
  const assignedCandidates = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM (SELECT DISTINCT candidate_id FROM candidate_positions) cp
    JOIN candidates c ON c.id = cp.candidate_id
    WHERE c.archived_at IS NULL
  `).get().count)
  const unassignedCandidates = Math.max(0, Number(totals.active ?? 0) - assignedCandidates)
  const recentUpdateThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const recentUpdateCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM candidates
    WHERE archived_at IS NULL AND updated_at >= ?
  `).get(recentUpdateThreshold).count)
  const byTalentPool = db.prepare(`
    SELECT tp.id, tp.name, tp.color, COUNT(c.id) AS count
    FROM talent_pools tp
    LEFT JOIN candidate_talent_pools ctp ON ctp.talent_pool_id = tp.id
    LEFT JOIN candidates c ON c.id = ctp.candidate_id AND c.archived_at IS NULL
    WHERE tp.archived_at IS NULL
    GROUP BY tp.id ORDER BY count DESC, tp.name COLLATE NOCASE
  `).all().map((row) => ({ ...row, count: Number(row.count) }))
  const byEducation = db.prepare(`
    SELECT COALESCE(NULLIF(education, ''), '未设置') AS education, COUNT(*) AS count
    FROM candidates WHERE archived_at IS NULL
    GROUP BY COALESCE(NULLIF(education, ''), '未设置') ORDER BY count DESC, education LIMIT 20
  `).all().map((row) => ({ ...row, count: Number(row.count) }))
  const byJobSeekingStatus = db.prepare(`
    SELECT COALESCE(NULLIF(job_seeking_status, ''), '未设置') AS status, COUNT(*) AS count
    FROM candidates WHERE archived_at IS NULL
    GROUP BY COALESCE(NULLIF(job_seeking_status, ''), '未设置') ORDER BY count DESC, status LIMIT 20
  `).all().map((row) => ({ ...row, count: Number(row.count) }))
  const assignedPoolCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM (SELECT DISTINCT candidate_id FROM candidate_talent_pools) ctp
    JOIN candidates c ON c.id = ctp.candidate_id
    WHERE c.archived_at IS NULL
  `).get().count)
  const unassignedPoolCount = Math.max(0, Number(totals.active ?? 0) - assignedPoolCount)

  return {
    totals: {
      total: Number(totals.total ?? 0),
      active: Number(totals.active ?? 0),
      archived: Number(totals.archived ?? 0)
    },
    by_stage: byStage,
    by_source: bySource,
    recent_candidates: recent,
    position_totals: {
      total: Number(positionTotals.total ?? 0),
      active: Number(positionTotals.active ?? 0),
      archived: Number(positionTotals.archived ?? 0),
      open: Number(positionTotals.open ?? 0)
    },
    positions_by_status: positionsByStatus,
    recent_positions: recentPositions,
    unassigned_candidates: unassignedCandidates,
    recent_update_count: recentUpdateCount
    ,talent_summary: {
      by_pool: byTalentPool,
      by_education: byEducation,
      by_job_seeking_status: byJobSeekingStatus,
      unassigned_pool_count: unassignedPoolCount
    }
  }
}

export function candidateExists(db, id) {
  return Boolean(db.prepare('SELECT 1 FROM candidates WHERE id = ?').get(id))
}

export { findDuplicate, getCandidate }
