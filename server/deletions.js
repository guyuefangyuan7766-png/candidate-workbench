import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isBusinessSearchAvailable, synchronizeBusinessSearch } from './business-search.js'

const CANDIDATE_OPERATION = 'candidate_permanent_delete'
const POSITION_OPERATION = 'position_permanent_delete'
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 1000
const MAX_DELETE_TARGETS = 100

function deletionError(status, message, details, code = 'request_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function timestamp(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(milliseconds)) throw new TypeError('DeletionPreviewStore clock must return a valid time')
  return milliseconds
}

function cloneSnapshot(snapshot) {
  return {
    operation: snapshot.operation,
    targets: snapshot.targets.map((target) => ({ id: target.id, updated_at: target.updated_at }))
  }
}

export class DeletionPreviewStore {
  #entries = new Map()
  #ttlMs
  #clock
  #tokenFactory

  constructor({
    ttlMs = DEFAULT_TOKEN_TTL_MS,
    clock = Date.now,
    tokenFactory = () => randomBytes(32).toString('base64url')
  } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 15 * 60 * 1000) {
      throw new TypeError('ttlMs must be an integer between 1 and 900000')
    }
    if (typeof clock !== 'function' || typeof tokenFactory !== 'function') {
      throw new TypeError('clock and tokenFactory must be functions')
    }
    this.#ttlMs = ttlMs
    this.#clock = clock
    this.#tokenFactory = tokenFactory
  }

  issue(snapshot) {
    if (!snapshot || ![CANDIDATE_OPERATION, POSITION_OPERATION].includes(snapshot.operation)) {
      throw new TypeError('A supported deletion operation is required')
    }
    if (!Array.isArray(snapshot.targets) || snapshot.targets.length === 0) {
      throw new TypeError('At least one deletion target is required')
    }

    const issuedAt = timestamp(this.#clock())
    const expiresAt = issuedAt + this.#ttlMs
    let token = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.#tokenFactory()
      if (typeof candidate !== 'string' || candidate.length < 32) {
        throw new TypeError('tokenFactory must return a string of at least 32 characters')
      }
      if (!this.#entries.has(candidate)) {
        token = candidate
        break
      }
    }
    if (!token) throw new Error('Unable to allocate a unique deletion preview token')

    this.#entries.set(token, {
      snapshot: cloneSnapshot(snapshot),
      expiresAt,
      consumedAt: null
    })
    this.#sweep(issuedAt)
    return { preview_token: token, expires_at: new Date(expiresAt).toISOString() }
  }

  consume(token, expectedOperation) {
    if (typeof token !== 'string' || !token) {
      throw deletionError(422, 'preview_token 必须是非空字符串', undefined, 'validation_error')
    }
    const entry = this.#entries.get(token)
    if (!entry) {
      throw deletionError(409, '删除预览令牌无效，请重新预览', undefined, 'deletion_preview_invalid')
    }
    const currentTime = timestamp(this.#clock())
    if (currentTime >= entry.expiresAt) {
      this.#entries.delete(token)
      throw deletionError(409, '删除预览令牌已过期，请重新预览', {
        expires_at: new Date(entry.expiresAt).toISOString()
      }, 'deletion_preview_expired')
    }
    if (entry.snapshot.operation !== expectedOperation) {
      throw deletionError(409, '删除预览令牌与当前操作不匹配', undefined, 'deletion_preview_operation_mismatch')
    }
    if (entry.consumedAt !== null) {
      throw deletionError(409, '删除预览令牌已使用，请重新预览', undefined, 'deletion_preview_replayed')
    }

    entry.consumedAt = currentTime
    return cloneSnapshot(entry.snapshot)
  }

  #sweep(currentTime) {
    for (const [token, entry] of this.#entries) {
      if (currentTime >= entry.expiresAt) this.#entries.delete(token)
    }
  }
}

export function createDeletionPreviewStore(options) {
  return new DeletionPreviewStore(options)
}

export const defaultDeletionPreviewStore = new DeletionPreviewStore()

function normalizeIds(input, entityName) {
  if (!Array.isArray(input) || input.length === 0) {
    throw deletionError(422, `${entityName}_ids 必须是非空数组`, undefined, 'validation_error')
  }
  if (input.length > MAX_DELETE_TARGETS) {
    throw deletionError(413, `单次最多永久删除 ${MAX_DELETE_TARGETS} 个${entityName === 'candidate' ? '候选人' : '职位'}`, {
      maximum: MAX_DELETE_TARGETS
    }, 'limit_exceeded')
  }
  const ids = input.map((value, index) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
      throw deletionError(422, `${entityName} ID 无效`, [{
        field: `${entityName}_ids.${index}`,
        message: '必须是 1 至 200 个字符'
      }], 'validation_error')
    }
    return value.trim()
  })
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ')
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?
  `).get(table))
}

function countRows(db, table, foreignKey, ids) {
  if (!tableExists(db, table)) return 0
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${table} WHERE ${foreignKey} IN (${placeholders(ids.length)})
  `).get(...ids).count ?? 0)
}

function hashIdentifier(id) {
  return createHash('sha256').update(id, 'utf8').digest('hex')
}

function transact(db, callback) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    if (result && typeof result.then === 'function') {
      throw deletionError(500, '删除事务回调必须同步完成', undefined, 'invalid_transaction_callback')
    }
    const v8Recorded = tableExists(db, 'schema_migrations') && Boolean(db.prepare(
      'SELECT 1 FROM schema_migrations WHERE version = 8'
    ).get())
    if (v8Recorded || isBusinessSearchAvailable(db)) synchronizeBusinessSearch(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the original failure when SQLite has already rolled back.
    }
    throw error
  }
}

function readTargets(db, table, ids) {
  return db.prepare(`
    SELECT id, archived_at, updated_at
    FROM ${table}
    WHERE id IN (${placeholders(ids.length)})
    ORDER BY id
  `).all(...ids)
}

function stateConflict(entity, ids, rows, expectedTargets) {
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const missingIds = ids.filter((id) => !rowById.has(id))
  const activeIds = ids.filter((id) => rowById.has(id) && !rowById.get(id).archived_at)
  const expectedById = new Map((expectedTargets ?? []).map((target) => [target.id, target.updated_at]))
  const versionConflicts = expectedTargets
    ? ids.filter((id) => rowById.has(id) && rowById.get(id).updated_at !== expectedById.get(id))
    : []
  if (!missingIds.length && !activeIds.length && !versionConflicts.length) return null

  const details = {}
  if (missingIds.length) details.missing_ids = missingIds
  if (activeIds.length) details.not_archived_ids = activeIds
  if (versionConflicts.length) details.version_conflict_ids = versionConflicts
  if (missingIds.length) {
    return deletionError(409, `${entity === 'candidate' ? '候选人' : '职位'}不存在，整批未删除`, details, `${entity}_not_found`)
  }
  if (activeIds.length) {
    return deletionError(409, `活动${entity === 'candidate' ? '候选人' : '职位'}必须先归档，整批未删除`, details, `${entity}_not_archived`)
  }
  return deletionError(409, `${entity === 'candidate' ? '候选人' : '职位'}版本已变化，整批未删除`, details, 'version_conflict')
}

function assertRequestedTargets(input, field, entity, snapshotIds) {
  if (input?.[field] === undefined) return
  const requestedIds = normalizeIds(input[field], entity)
  if (
    requestedIds.length !== snapshotIds.length ||
    requestedIds.some((id, index) => id !== snapshotIds[index])
  ) {
    throw deletionError(409, '删除预览令牌与提交目标不匹配，请重新预览', {
      operation: `${entity}_permanent_delete`
    }, 'deletion_preview_target_mismatch')
  }
}

function requireStore(store) {
  const resolved = store ?? defaultDeletionPreviewStore
  if (typeof resolved.issue !== 'function' || typeof resolved.consume !== 'function') {
    throw new TypeError('A deletion preview store with issue() and consume() is required')
  }
  return resolved
}

export function previewCandidateDeletion(db, input, store) {
  const ids = normalizeIds(input?.candidate_ids, 'candidate')
  const rows = readTargets(db, 'candidates', ids)
  const conflict = stateConflict('candidate', ids, rows)
  if (conflict) throw conflict

  const issued = requireStore(store).issue({
    operation: CANDIDATE_OPERATION,
    targets: rows.map((row) => ({ id: row.id, updated_at: row.updated_at }))
  })
  return {
    ...issued,
    candidate_count: ids.length,
    impact: {
      irreversible: true,
      attachment_count: countRows(db, 'candidate_attachments', 'candidate_id', ids),
      position_relation_count: countRows(db, 'candidate_positions', 'candidate_id', ids),
      talent_pool_relation_count: countRows(db, 'candidate_talent_pools', 'candidate_id', ids),
      deletes: [
        '候选人主档和联系方式',
        '照片地址、备注、活动与职位/人才库关系',
        '履历、偏好、来源记录、评估、授权与申请来源',
        '附件元数据、解析文本和候选人检索索引'
      ],
      preserves: ['共享职位', '共享人才库', '导入批次'],
      boundary: '不影响北森等来源系统、既有导出副本和历史备份'
    }
  }
}

function readCandidateAttachments(db, ids) {
  if (!tableExists(db, 'candidate_attachments')) return []
  const columns = new Set(db.prepare('PRAGMA table_info(candidate_attachments)').all().map((column) => column.name))
  if (!columns.has('candidate_id') || !columns.has('storage_path')) {
    throw deletionError(500, '候选人附件表缺少安全清理所需字段', undefined, 'attachment_schema_invalid')
  }
  return db.prepare(`
    SELECT id, candidate_id, storage_path
    FROM candidate_attachments
    WHERE candidate_id IN (${placeholders(ids.length)})
      AND storage_path IS NOT NULL AND trim(storage_path) <> ''
    ORDER BY candidate_id, id
  `).all(...ids)
}

function queueAttachmentCleanup(db, ids, deletedAt, enqueueAttachmentCleanup) {
  const attachments = readCandidateAttachments(db, ids)
  if (!attachments.length) return 0

  if (enqueueAttachmentCleanup !== undefined) {
    if (typeof enqueueAttachmentCleanup !== 'function') {
      throw new TypeError('enqueueAttachmentCleanup must be a function')
    }
    const result = enqueueAttachmentCleanup({
      db,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      reason: 'candidate_permanent_delete',
      created_at: deletedAt
    })
    if (result && typeof result.then === 'function') {
      throw deletionError(500, '附件清理排队必须在删除事务内同步完成', undefined, 'invalid_cleanup_callback')
    }
    return attachments.length
  }

  if (!tableExists(db, 'attachment_cleanup_jobs')) {
    throw deletionError(503, '附件清理队列不可用，候选人未删除', undefined, 'attachment_cleanup_unavailable')
  }
  const enqueue = db.prepare(`
    INSERT OR IGNORE INTO attachment_cleanup_jobs(
      id, storage_path, reason, attempts, last_error, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 0, NULL, ?, ?, NULL)
  `)
  const queuedPaths = new Set()
  for (const attachment of attachments) {
    if (queuedPaths.has(attachment.storage_path)) continue
    queuedPaths.add(attachment.storage_path)
    enqueue.run(
      randomUUID(),
      attachment.storage_path,
      'candidate_permanent_delete',
      deletedAt,
      deletedAt
    )
    const queued = db.prepare(`
      SELECT 1 FROM attachment_cleanup_jobs
      WHERE storage_path = ? AND completed_at IS NULL
    `).get(attachment.storage_path)
    if (!queued) {
      throw deletionError(503, '附件清理任务无法入队，候选人未删除', {
        attachment_id: attachment.id
      }, 'attachment_cleanup_enqueue_failed')
    }
  }
  return queuedPaths.size
}

export function commitCandidateDeletion(db, input, store, { enqueueAttachmentCleanup } = {}) {
  const snapshot = requireStore(store).consume(input?.preview_token, CANDIDATE_OPERATION)
  const ids = snapshot.targets.map((target) => target.id)
  assertRequestedTargets(input, 'candidate_ids', 'candidate', ids)

  return transact(db, () => {
    const rows = readTargets(db, 'candidates', ids)
    const conflict = stateConflict('candidate', ids, rows, snapshot.targets)
    if (conflict) throw conflict

    const deletedAt = new Date().toISOString()
    const cleanupQueuedCount = queueAttachmentCleanup(db, ids, deletedAt, enqueueAttachmentCleanup)
    const deleted = db.prepare(`
      DELETE FROM candidates
      WHERE id IN (${placeholders(ids.length)}) AND archived_at IS NOT NULL
    `).run(...ids)
    if (Number(deleted.changes) !== ids.length) {
      throw deletionError(409, '候选人状态已变化，整批未删除', undefined, 'version_conflict')
    }

    const insertAudit = db.prepare(`
      INSERT INTO deletion_audits(id, candidate_id_hash, deleted_at) VALUES (?, ?, ?)
    `)
    const auditIds = ids.map((id) => {
      const auditId = randomUUID()
      insertAudit.run(auditId, hashIdentifier(id), deletedAt)
      return auditId
    })
    const result = {
      deleted: true,
      deleted_count: ids.length,
      candidate_ids: ids,
      deleted_at: deletedAt,
      audit_ids: auditIds,
      attachment_cleanup_queued_count: cleanupQueuedCount
    }
    if (ids.length === 1) {
      result.candidate_id = ids[0]
      result.audit_id = auditIds[0]
    }
    return result
  })
}

function positionCandidateRelations(db, ids) {
  const queries = []
  const parameters = []
  if (tableExists(db, 'candidate_positions')) {
    queries.push(`SELECT candidate_id, position_id FROM candidate_positions WHERE position_id IN (${placeholders(ids.length)})`)
    parameters.push(...ids)
  }
  if (tableExists(db, 'candidate_position_sources')) {
    queries.push(`SELECT candidate_id, position_id FROM candidate_position_sources WHERE position_id IN (${placeholders(ids.length)})`)
    parameters.push(...ids)
  }
  if (tableExists(db, 'candidate_assessments')) {
    queries.push(`SELECT candidate_id, position_id FROM candidate_assessments WHERE position_id IN (${placeholders(ids.length)})`)
    parameters.push(...ids)
  }
  if (!queries.length) return []
  return db.prepare(`${queries.join(' UNION ')} ORDER BY candidate_id, position_id`).all(...parameters)
}

export function previewPositionDeletion(db, input, store) {
  const ids = normalizeIds(input?.position_ids, 'position')
  const rows = readTargets(db, 'positions', ids)
  const conflict = stateConflict('position', ids, rows)
  if (conflict) throw conflict
  const candidateCount = new Set(positionCandidateRelations(db, ids).map((row) => row.candidate_id)).size
  const issued = requireStore(store).issue({
    operation: POSITION_OPERATION,
    targets: rows.map((row) => ({ id: row.id, updated_at: row.updated_at }))
  })
  return {
    ...issued,
    position_count: ids.length,
    affected_candidate_count: candidateCount,
    impact: {
      irreversible: true,
      affected_candidate_count: candidateCount,
      deletes: ['职位主记录', '候选人与职位关系', '职位申请来源关系'],
      preserves: ['候选人主档', '人才库', '候选人附件、备注和其他候选人资料'],
      candidate_activity: '为受影响候选人记录“关联职位已永久删除”',
      boundary: '不影响北森等来源系统、既有导出副本和历史备份'
    }
  }
}

function writePositionDeletionActivities(db, relations, deletedAt) {
  const positionsByCandidate = new Map()
  for (const relation of relations) {
    const positionIds = positionsByCandidate.get(relation.candidate_id) ?? []
    positionIds.push(relation.position_id)
    positionsByCandidate.set(relation.candidate_id, positionIds)
  }
  const insert = db.prepare(`
    INSERT INTO activities(id, candidate_id, type, description, metadata, created_at)
    VALUES (?, ?, 'position_permanently_deleted', '关联职位已永久删除', ?, ?)
  `)
  for (const [candidateId, positionIds] of positionsByCandidate) {
    const uniquePositionIds = [...new Set(positionIds)].sort((left, right) => left.localeCompare(right))
    insert.run(randomUUID(), candidateId, JSON.stringify({
      position_count: uniquePositionIds.length,
      position_id_hashes: uniquePositionIds.map(hashIdentifier)
    }), deletedAt)
  }
  return positionsByCandidate.size
}

export function commitPositionDeletion(db, input, store) {
  const snapshot = requireStore(store).consume(input?.preview_token, POSITION_OPERATION)
  const ids = snapshot.targets.map((target) => target.id)
  assertRequestedTargets(input, 'position_ids', 'position', ids)

  return transact(db, () => {
    const rows = readTargets(db, 'positions', ids)
    const conflict = stateConflict('position', ids, rows, snapshot.targets)
    if (conflict) throw conflict

    const relations = positionCandidateRelations(db, ids)
    const affectedByPosition = new Map(ids.map((id) => [id, new Set()]))
    for (const relation of relations) affectedByPosition.get(relation.position_id)?.add(relation.candidate_id)
    const deletedAt = new Date().toISOString()
    const activityCount = writePositionDeletionActivities(db, relations, deletedAt)
    const deleted = db.prepare(`
      DELETE FROM positions
      WHERE id IN (${placeholders(ids.length)}) AND archived_at IS NOT NULL
    `).run(...ids)
    if (Number(deleted.changes) !== ids.length) {
      throw deletionError(409, '职位状态已变化，整批未删除', undefined, 'version_conflict')
    }

    const insertAudit = db.prepare(`
      INSERT INTO position_deletion_audits(
        id, position_id_hash, affected_candidate_count, deleted_at
      ) VALUES (?, ?, ?, ?)
    `)
    const auditIds = ids.map((id) => {
      const auditId = randomUUID()
      insertAudit.run(auditId, hashIdentifier(id), affectedByPosition.get(id)?.size ?? 0, deletedAt)
      return auditId
    })
    const affectedCandidateCount = new Set(relations.map((relation) => relation.candidate_id)).size
    const result = {
      deleted: true,
      deleted_count: ids.length,
      position_ids: ids,
      affected_candidate_count: affectedCandidateCount,
      candidate_activity_count: activityCount,
      deleted_at: deletedAt,
      audit_ids: auditIds
    }
    if (ids.length === 1) {
      result.position_id = ids[0]
      result.audit_id = auditIds[0]
    }
    return result
  })
}

export const DELETION_LIMITS = Object.freeze({
  max_targets: MAX_DELETE_TARGETS,
  default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS
})
