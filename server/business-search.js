import { createHash } from 'node:crypto'

export const BUSINESS_SEARCH_VERSION = 8
export const BUSINESS_SEARCH_MAX_PAGE_SIZE = 100
export const BUSINESS_SEARCH_MAX_PAGE = 1_000
export const BUSINESS_SEARCH_MAX_CONCEPTS = 16
export const BUSINESS_SEARCH_MAX_EVIDENCE = 5
export const BUSINESS_SEARCH_SEGMENT_CHARS = 4_000

const SEARCH_DOCUMENTS_TABLE = 'search_documents_v2'
const SEARCH_FTS_TABLE = 'search_documents_v2_fts'
const DIRTY_TABLE = 'search_index_dirty_v2'
const CHECKPOINT_TABLE = 'search_index_checkpoints_v2'
const COVERAGE_TABLE = 'search_index_coverage_v2'
const FIELD_COVERAGE_TABLE = 'search_index_field_coverage_v2'
const SEARCH_FTS_BUILD_TABLE = 'search_documents_v2_fts_build'
const CANDIDATE_CURSOR_VERSION = 1
const CANDIDATE_CURSOR_MAX_LENGTH = 2_048
// Every query is explicitly scoped to search_text. Using the default weight
// keeps ranking identical for the legacy nine-column FTS table and the compact
// one-column contentless table used by new databases and maintenance rebuilds.
const FTS_RANK_CONFIGURATION = 'bm25()'

// These columns are database bookkeeping rather than user-visible search
// evidence. Their values remain in the business tables and in structured
// query results; omitting one field-level FTS document per row prevents IDs,
// timestamps and sensitivity labels from dominating the derived index.
const TECHNICAL_SEARCH_COLUMNS = new Set([
  'id',
  'candidate_id',
  'created_at',
  'updated_at',
  'sensitivity'
])

const TABLE_POLICIES = Object.freeze([
  { table: 'stages', key: ['value'], entityType: 'stage', entityId: 'value', title: ['label', 'value'] },
  { table: 'candidates', key: ['id'], entityType: 'candidate', entityId: 'id', candidateId: 'id', title: ['name'], archived: 'archived_at', json: ['tags'] },
  { table: 'notes', key: ['id'], entityType: 'candidate_note', entityId: 'id', candidateId: 'candidate_id', title: ['author'] },
  { table: 'activities', key: ['id'], entityType: 'candidate_activity', entityId: 'id', candidateId: 'candidate_id', title: ['type'], json: ['metadata'] },
  { table: 'import_batches', key: ['id'], entityType: 'import_batch', entityId: 'id', title: ['filename', 'sheet_name'] },
  { table: 'positions', key: ['id'], entityType: 'position', entityId: 'id', title: ['title'], archived: 'archived_at', json: ['tags'] },
  { table: 'candidate_positions', key: ['candidate_id', 'position_id'], entityType: 'candidate_position', candidateId: 'candidate_id', title: ['position_id'], searchable: false },
  { table: 'talent_pools', key: ['id'], entityType: 'talent_pool', entityId: 'id', title: ['name'], archived: 'archived_at' },
  { table: 'candidate_talent_pools', key: ['candidate_id', 'talent_pool_id'], entityType: 'candidate_talent_pool', candidateId: 'candidate_id', title: ['talent_pool_id'], searchable: false },
  { table: 'candidate_profile_sections', key: ['id'], entityType: 'candidate_profile_section', entityId: 'id', candidateId: 'candidate_id', title: ['title', 'section_type'], archived: 'archived_at', json: ['structured_data'] },
  { table: 'candidate_preferences', key: ['candidate_id'], entityType: 'candidate_preference', entityId: 'candidate_id', candidateId: 'candidate_id', title: ['employment_status'], json: ['desired_titles', 'desired_locations', 'raw_payload'] },
  // §11.4 索引收缩后，这张表只剩 source_timestamp 可索引（实测全空），
  // 其余列（source_system/source_record_id/source_name/record_type/raw_payload）
  // 全部按元数据排除，因此整表不参与检索（否则覆盖校验永远 pending）。
  { table: 'candidate_source_records', key: ['id'], entityType: 'candidate_source_record', entityId: 'id', candidateId: 'candidate_id', title: ['source_name', 'source_system'], json: [], searchable: false },
  { table: 'candidate_assessments', key: ['id'], entityType: 'candidate_assessment', entityId: 'id', candidateId: 'candidate_id', title: ['title', 'assessment_type'], json: ['raw_payload'], exclude: ['position_id'] },
  { table: 'candidate_consents', key: ['id'], entityType: 'candidate_consent', entityId: 'id', candidateId: 'candidate_id', title: ['agreement_name', 'consent_type'], json: ['raw_payload'] },
  { table: 'candidate_position_sources', key: ['id'], entityType: 'candidate_position_source', entityId: 'id', candidateId: 'candidate_id', title: ['source_system', 'source_application_id'], json: ['raw_payload'], exclude: ['position_id'] },
  { table: 'candidate_attachments', key: ['id'], entityType: 'candidate_attachment', entityId: 'id', candidateId: 'candidate_id', title: ['original_filename'], json: [] },
  { table: 'candidate_field_sources', key: ['id'], entityType: 'candidate_field_source', entityId: 'id', candidateId: 'candidate_id', title: ['field_name'], json: ['previous_value', 'new_value'] },
  { table: 'deletion_audits', key: ['id'], entityType: 'candidate_deletion_audit', entityId: 'id', title: ['deleted_at'] },
  { table: 'position_deletion_audits', key: ['id'], entityType: 'position_deletion_audit', entityId: 'id', title: ['deleted_at'] },
  { table: 'agent_query_audits', key: ['id'], entityType: 'agent_query_audit', entityId: 'id', title: ['tool_name'], json: ['query_scope'], searchable: false },
  // Kept readable for the existing get_candidate_resume tool, but not re-indexed.
  { table: 'candidate_resume_documents', key: ['row_id'], entityType: 'legacy_resume_document', entityId: 'document_id', candidateId: 'candidate_id', title: ['title'], searchable: false },
  // Metadata remains readable. The vector BLOB is excluded by the column policy.
  { table: 'candidate_resume_vectors', key: ['id'], entityType: 'resume_vector_metadata', entityId: 'id', candidateId: 'candidate_id', title: ['model'], searchable: false }
])

const POLICY_BY_TABLE = new Map(TABLE_POLICIES.map((policy) => [policy.table, policy]))
const DENIED_COLUMNS = new Map([
  ['candidate_attachments', new Set(['storage_path'])],
  ['candidate_resume_vectors', new Set(['vector'])]
])

// 不参与检索的元数据列（docs/VECTOR_HYBRID_PLAN.md §11.4）。
// 这些列此前被当成普通标量列全量索引，把 2,527 万行撑到了约 400–600 万行能覆盖的规模：
// 区块的排序/来源键、来源记录的渠道键、附件的哈希与解析状态，以及 structured_data /
// raw_payload 两棵 JSON 快照树。它们只用于流水线对账与去重，检索侧没有人会按它们查。
const UNINDEXED_SEARCH_COLUMNS = new Map([
  ['candidate_profile_sections', new Set(['source_record_id', 'sort_order', 'section_type', 'structured_data'])],
  ['candidate_source_records', new Set(['source_system', 'source_record_id', 'source_name', 'record_type', 'raw_payload'])],
  ['candidate_preferences', new Set(['raw_payload'])],
  ['candidate_assessments', new Set(['raw_payload'])],
  ['candidate_consents', new Set(['raw_payload'])],
  ['candidate_position_sources', new Set(['raw_payload'])],
  ['candidate_attachments', new Set(['sha256', 'parse_status', 'parser_version', 'source', 'mime_type'])]
])

const INTERNAL_SEARCH_NAMES = new Set([
  SEARCH_DOCUMENTS_TABLE,
  SEARCH_FTS_TABLE,
  SEARCH_FTS_BUILD_TABLE,
  DIRTY_TABLE,
  CHECKPOINT_TABLE,
  COVERAGE_TABLE,
  FIELD_COVERAGE_TABLE,
  'candidate_resume_fts'
])

const INTERNAL_SEARCH_TOOL_PREFIXES = [
  'business_search_',
  'search_all_records',
  'search_candidate_resume'
]

const INTERNAL_COMPATIBILITY_TOOLS = new Set([
  'get_attachment_text',
  'get_candidate_full_candidate_attachments',
  'get_candidate_full_vectors'
])

export class BusinessSearchError extends Error {
  constructor(code, message, { status = 400, details, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'BusinessSearchError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, options) {
  throw new BusinessSearchError(code, message, options)
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?
  `).get(table))
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all()
}

export function readonlyBusinessTablePolicy(tableName) {
  return POLICY_BY_TABLE.get(String(tableName ?? '').toLowerCase()) ?? null
}

export function isReadonlyBusinessTable(tableName) {
  return POLICY_BY_TABLE.has(String(tableName ?? '').toLowerCase())
}

export function isReadonlyBusinessColumn(tableName, columnName, declaredType = '') {
  const table = String(tableName ?? '').toLowerCase()
  const column = String(columnName ?? '').toLowerCase()
  if (!POLICY_BY_TABLE.has(table) || !column) return false
  if (String(declaredType ?? '').trim().toUpperCase().includes('BLOB')) return false
  // DENIED_COLUMNS 里的列（如 candidate_attachments.storage_path）既不进索引，
  // 也不属于只读业务列契约；否则物理路径会被当成普通可读字段暴露出去。
  if (DENIED_COLUMNS.get(table)?.has(column)) return false
  // The Agent has an explicit read-only contract; expose all scalar business
  // columns so complete candidate and talent-pool matching can be performed.
  return true
}

export function isInternalSearchTool(toolName) {
  const tool = String(toolName ?? '')
  return INTERNAL_COMPATIBILITY_TOOLS.has(tool) || INTERNAL_SEARCH_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix))
}

export function isInternalSearchSchemaObject(name) {
  const value = String(name ?? '').toLowerCase()
  if (INTERNAL_SEARCH_NAMES.has(value)) return true
  return value.startsWith(`${SEARCH_FTS_TABLE}_`) || value.startsWith('candidate_resume_fts_')
}

export function isRestrictedResultColumn(toolName, columnName) {
  const tool = String(toolName ?? '')
  const column = String(columnName ?? '').toLowerCase()
  return column === 'storage_path' && (
    tool === 'get_attachment_text' || tool === 'get_candidate_full_candidate_attachments'
  )
}

function policyColumns(db, policy) {
  if (!tableExists(db, policy.table)) return []
  return tableColumns(db, policy.table).filter((column) => (
    columnExclusionReason(policy.table, column, policy) === null
  ))
}

function columnExclusionReason(table, column, policy) {
  if (Number(column.hidden) !== 0) return 'hidden_column'
  if (String(column.type ?? '').trim().toUpperCase().includes('BLOB')) return 'blob_column'
  if (DENIED_COLUMNS.get(table)?.has(String(column.name).toLowerCase())) return 'restricted_path'
  if (UNINDEXED_SEARCH_COLUMNS.get(table)?.has(String(column.name).toLowerCase())) return 'unindexed_metadata'
  if (policy.searchable === false) return 'compatibility_metadata_only'
  if ((policy.exclude ?? []).some((name) => String(name).toLowerCase() === String(column.name).toLowerCase())) {
    return 'relationship_metadata'
  }
  if (TECHNICAL_SEARCH_COLUMNS.has(String(column.name).toLowerCase())) return 'technical_metadata'
  return null
}

export function getBusinessSearchFieldCatalog(db) {
  if (!db || typeof db.prepare !== 'function') fail('invalid_database', 'A SQLite database connection is required.', { status: 500 })
  const schemaTables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all()
    .map((row) => row.name)
    .filter((name) => !isInternalSearchSchemaObject(name))
  const policyTables = TABLE_POLICIES.filter((policy) => tableExists(db, policy.table))
  const policyTableNames = new Set(policyTables.map((policy) => policy.table))
  return {
    version: BUSINESS_SEARCH_VERSION,
    schema_tables: schemaTables,
    policy_tables: policyTables.map((policy) => policy.table),
    unclassified_tables: schemaTables.filter((table) => !policyTableNames.has(table)),
    tables: policyTables.map((policy) => ({
      table: policy.table,
      searchable: policy.searchable !== false,
      columns: tableColumns(db, policy.table).map((column) => {
        const exclusionReason = columnExclusionReason(policy.table, column, policy)
        return {
          name: column.name,
          declared_type: column.type || null,
          readable: Number(column.hidden) === 0 && isReadonlyBusinessColumn(policy.table, column.name, column.type),
          indexed: exclusionReason === null,
          exclusion_reason: exclusionReason
        }
      })
    }))
  }
}

function sourceRowExpression(policy, prefix) {
  if (policy.key.length === 1) return `CAST(${prefix}.${quoteIdentifier(policy.key[0])} AS TEXT)`
  return `json_array(${policy.key.map((column) => `${prefix}.${quoteIdentifier(column)}`).join(', ')})`
}

function sourceRowMatchPredicate(policy, sourcePrefix, indexedRowExpression) {
  if (policy.key.length === 1) {
    // Keep the indexed source column bare.  Casting the primary key forced a
    // correlated full scan for every search document on large databases.
    return `${sourcePrefix}.${quoteIdentifier(policy.key[0])} = ${indexedRowExpression}`
  }
  return policy.key.map((column, index) => (
    `${sourcePrefix}.${quoteIdentifier(column)} IS json_extract(${indexedRowExpression}, '$[${index}]')`
  )).join(' AND ')
}

function triggerRowExpression(policy, prefix) {
  if (policy.key.length === 1) return `CAST(${prefix}.${quoteIdentifier(policy.key[0])} AS TEXT)`
  return `json_array(${policy.key.map((column) => `${prefix}.${quoteIdentifier(column)}`).join(', ')})`
}

function triggerName(table, suffix) {
  return `search_v2_${table}_${suffix}`
}

function createDirtyTriggers(db, policy) {
  if (!tableExists(db, policy.table)) return
  if (policy.searchable === false) {
    for (const suffix of ['ai', 'au', 'ad']) {
      db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName(policy.table, suffix))}`)
    }
    return
  }
  const table = quoteIdentifier(policy.table)
  const updateTrigger = triggerName(policy.table, 'au')
  const searchableColumns = policyColumns(db, policy)
  const updateChanged = searchableColumns.length
    ? searchableColumns
        .map((column) => `OLD.${quoteIdentifier(column.name)} IS NOT NEW.${quoteIdentifier(column.name)}`)
        .join(' OR ')
    : '0'
  const queuedAt = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  const insertDirty = (prefix, reason) => `
    INSERT INTO ${DIRTY_TABLE}(source_table, source_row_id, reason, queued_at, attempts, last_error)
    VALUES ('${policy.table}', ${triggerRowExpression(policy, prefix)}, '${reason}', ${queuedAt}, 0, NULL)
    ON CONFLICT(source_table, source_row_id) DO UPDATE SET
      reason = excluded.reason,
      queued_at = excluded.queued_at,
      attempts = 0,
      last_error = NULL;`
  const markPending = `
    UPDATE ${CHECKPOINT_TABLE}
    SET status = 'pending', completed_at = NULL, updated_at = ${queuedAt}, error_code = NULL
    WHERE scope = 'full';`

  // V8's original UPDATE triggers queued rows even when an UPDATE wrote the
  // same values. Replace only that legacy definition once; subsequent schema
  // checks leave the trigger untouched.
  const existingUpdateTrigger = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?
  `).get(updateTrigger)?.sql ?? ''
  if (!/\bWHEN\b/i.test(existingUpdateTrigger)) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(updateTrigger)}`)
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(triggerName(policy.table, 'ai'))}
    AFTER INSERT ON ${table} BEGIN
      ${insertDirty('NEW', 'insert')}
      ${markPending}
    END;
    CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(updateTrigger)}
    AFTER UPDATE ON ${table}
    WHEN ${updateChanged} BEGIN
      ${insertDirty('OLD', 'update_old')}
      ${insertDirty('NEW', 'update')}
      ${markPending}
    END;
    CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(triggerName(policy.table, 'ad'))}
    AFTER DELETE ON ${table} BEGIN
      ${insertDirty('OLD', 'delete')}
      ${markPending}
    END;
  `)
}

function transaction(db, operation) {
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    if (ownsTransaction) db.exec('COMMIT')
    return result
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function createSearchDocumentTriggers(db) {
  const expectedInsertMarker = `INSERT INTO ${SEARCH_FTS_TABLE}(rowid, search_text)`
  const insertSql = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'search_documents_v2_ai'
  `).get()?.sql ?? ''
  const updateSql = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'search_documents_v2_au'
  `).get()?.sql ?? ''
  if (!insertSql.includes(expectedInsertMarker) || !/AFTER UPDATE OF search_text/i.test(updateSql)) {
    db.exec(`
      DROP TRIGGER IF EXISTS search_documents_v2_ai;
      DROP TRIGGER IF EXISTS search_documents_v2_au;
      DROP TRIGGER IF EXISTS search_documents_v2_ad;
    `)
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS search_documents_v2_ai
    AFTER INSERT ON ${SEARCH_DOCUMENTS_TABLE} BEGIN
      INSERT INTO ${SEARCH_FTS_TABLE}(rowid, search_text)
      VALUES (NEW.row_id, NEW.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS search_documents_v2_au
    AFTER UPDATE OF search_text ON ${SEARCH_DOCUMENTS_TABLE}
    WHEN OLD.search_text IS NOT NEW.search_text BEGIN
      DELETE FROM ${SEARCH_FTS_TABLE} WHERE rowid = OLD.row_id;
      INSERT INTO ${SEARCH_FTS_TABLE}(rowid, search_text)
      VALUES (NEW.row_id, NEW.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS search_documents_v2_ad
    AFTER DELETE ON ${SEARCH_DOCUMENTS_TABLE} BEGIN
      DELETE FROM ${SEARCH_FTS_TABLE} WHERE rowid = OLD.row_id;
    END;
  `)
}

export function migrateBusinessSearch(db) {
  if (!db || typeof db.prepare !== 'function') fail('invalid_database', 'A SQLite database connection is required.', { status: 500 })
  try {
    return transaction(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${SEARCH_DOCUMENTS_TABLE} (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id TEXT NOT NULL UNIQUE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          candidate_id TEXT,
          source_table TEXT NOT NULL,
          source_row_id TEXT NOT NULL,
          field_path TEXT NOT NULL,
          segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
          segment_count INTEGER NOT NULL CHECK(segment_count >= 1),
          char_start INTEGER NOT NULL CHECK(char_start >= 0),
          char_end INTEGER NOT NULL CHECK(char_end >= char_start),
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          normalized_content TEXT NOT NULL DEFAULT '',
          search_text TEXT NOT NULL DEFAULT '',
          archived_at TEXT,
          source_updated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(source_table, source_row_id, field_path, segment_index)
        );
        CREATE INDEX IF NOT EXISTS search_documents_v2_candidate_idx
          ON ${SEARCH_DOCUMENTS_TABLE}(candidate_id, row_id);
        CREATE INDEX IF NOT EXISTS search_documents_v2_entity_idx
          ON ${SEARCH_DOCUMENTS_TABLE}(entity_type, entity_id, row_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_FTS_TABLE} USING fts5(
          search_text,
          content = '',
          contentless_delete = 1,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TABLE IF NOT EXISTS ${DIRTY_TABLE} (
          source_table TEXT NOT NULL,
          source_row_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          queued_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          last_error TEXT,
          PRIMARY KEY(source_table, source_row_id)
        );
        CREATE INDEX IF NOT EXISTS search_index_dirty_v2_queue_idx
          ON ${DIRTY_TABLE}(queued_at, source_table, source_row_id);

        CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
          scope TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'indexing', 'ready', 'failed')),
          queued_rows INTEGER NOT NULL DEFAULT 0 CHECK(queued_rows >= 0),
          processed_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_rows >= 0),
          document_count INTEGER NOT NULL DEFAULT 0 CHECK(document_count >= 0),
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          error_code TEXT,
          queue_table TEXT,
          queue_cursor TEXT
        );

        CREATE TABLE IF NOT EXISTS ${COVERAGE_TABLE} (
          source_table TEXT PRIMARY KEY,
          source_rows INTEGER NOT NULL DEFAULT 0 CHECK(source_rows >= 0),
          indexed_rows INTEGER NOT NULL DEFAULT 0 CHECK(indexed_rows >= 0),
          document_count INTEGER NOT NULL DEFAULT 0 CHECK(document_count >= 0),
          dirty_rows INTEGER NOT NULL DEFAULT 0 CHECK(dirty_rows >= 0),
          status TEXT NOT NULL CHECK(status IN ('pending', 'ready')),
          checked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${FIELD_COVERAGE_TABLE} (
          source_table TEXT NOT NULL,
          field_path TEXT NOT NULL,
          source_value_rows INTEGER NOT NULL DEFAULT 0 CHECK(source_value_rows >= 0),
          indexed_rows INTEGER NOT NULL DEFAULT 0 CHECK(indexed_rows >= 0),
          document_count INTEGER NOT NULL DEFAULT 0 CHECK(document_count >= 0),
          status TEXT NOT NULL CHECK(status IN ('pending', 'ready')),
          checked_at TEXT NOT NULL,
          PRIMARY KEY(source_table, field_path)
        );
        CREATE INDEX IF NOT EXISTS search_index_field_coverage_v2_status_idx
          ON ${FIELD_COVERAGE_TABLE}(status, source_table, field_path);
      `)

      // Queue cursors were added after the first V8 schema shipped.  Keep the
      // migration additive so an existing database can resume a bounded
      // backfill without rebuilding any business table.
      const checkpointColumns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(CHECKPOINT_TABLE)})`).all().map((column) => column.name))
      if (!checkpointColumns.has('queue_table')) db.exec(`ALTER TABLE ${CHECKPOINT_TABLE} ADD COLUMN queue_table TEXT`)
      if (!checkpointColumns.has('queue_cursor')) db.exec(`ALTER TABLE ${CHECKPOINT_TABLE} ADD COLUMN queue_cursor TEXT`)

      const timestamp = new Date().toISOString()
      db.prepare(`
        INSERT INTO ${CHECKPOINT_TABLE}(scope, status, updated_at)
        VALUES ('full', 'pending', ?)
        ON CONFLICT(scope) DO NOTHING
      `).run(timestamp)
      createSearchDocumentTriggers(db)
      for (const policy of TABLE_POLICIES) createDirtyTriggers(db, policy)
      return { version: BUSINESS_SEARCH_VERSION, migrated: true }
    })
  } catch (error) {
    if (/no such module:\s*fts5/i.test(String(error?.message ?? ''))) {
      fail('fts5_unavailable', 'SQLite FTS5 is required for business search.', { status: 503, cause: error })
    }
    throw error
  }
}

function rowKey(policy, row) {
  if (policy.key.length === 1) return String(row[policy.key[0]])
  return JSON.stringify(policy.key.map((column) => row[column] == null ? null : row[column]))
}

function parsedKey(policy, sourceRowId) {
  if (policy.key.length === 1) return [sourceRowId]
  let values
  try {
    values = JSON.parse(sourceRowId)
  } catch {
    return null
  }
  return Array.isArray(values) && values.length === policy.key.length ? values : null
}

function sourceRowStatement(db, policy) {
  const where = policy.key.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ')
  return db.prepare(`SELECT * FROM ${quoteIdentifier(policy.table)} WHERE ${where} LIMIT 1`)
}

function findSourceRow(db, policy, sourceRowId, statement = sourceRowStatement(db, policy)) {
  const values = parsedKey(policy, sourceRowId)
  if (!values) return null
  return statement.get(...values) ?? null
}

function normalizeScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value.replaceAll('\0', '')
  return ''
}

function jsonPath(path, key) {
  const value = String(key)
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    ? `${path}.${value}`
    : `${path}[${JSON.stringify(value)}]`
}

function flattenJsonValue(value, path, output) {
  if (Array.isArray(value)) {
    if (value.length === 0) output.push({ fieldPath: path, value: '[]' })
    else value.forEach((item, index) => flattenJsonValue(item, `${path}[${index}]`, output))
    return
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0) output.push({ fieldPath: path, value: '{}' })
    else for (const [key, item] of entries) flattenJsonValue(item, jsonPath(path, key), output)
    return
  }
  output.push({ fieldPath: path, value: normalizeScalar(value) })
}

function fieldValues(policy, columns, row) {
  const jsonColumns = new Set(policy.json ?? [])
  const values = []
  const seenValues = new Set()
  const append = (fieldPath, value, { deduplicate = false } = {}) => {
    // Explicit typed columns are always retained. JSON leaves are traversed
    // deterministically and reuse the first evidence path when the same
    // normalized value is already represented by a typed column, another JSON
    // key, or another array index in this source row.
    const normalized = normalizedText(value)
    if (!normalized) return
    if (deduplicate && seenValues.has(normalized)) return
    seenValues.add(normalized)
    values.push({ fieldPath, value })
  }
  const processColumn = (column, expandJson) => {
    const fieldPath = `${policy.table}.${column.name}`
    const rawValue = row[column.name]
    if (rawValue === null || rawValue === undefined) return
    if (expandJson && jsonColumns.has(column.name) && typeof rawValue === 'string') {
      try {
        const flattened = []
        flattenJsonValue(JSON.parse(rawValue), fieldPath, flattened)
        for (const field of flattened) append(field.fieldPath, field.value, { deduplicate: true })
        return
      } catch {
        // Invalid legacy JSON remains searchable as its original text.
      }
    }
    const value = normalizeScalar(rawValue)
    if (value !== '') append(fieldPath, value)
  }
  // Prefer explicit typed columns as evidence owners when a raw payload
  // repeats the same value; JSON paths still remain searchable when unique.
  for (const column of columns) if (!jsonColumns.has(column.name)) processColumn(column, false)
  for (const column of columns) if (jsonColumns.has(column.name)) processColumn(column, true)
  return values
}

function splitDeterministically(value, maximum = BUSINESS_SEARCH_SEGMENT_CHARS) {
  const characters = Array.from(value)
  if (characters.length === 0) return []
  const segments = []
  for (let start = 0; start < characters.length; start += maximum) {
    const end = Math.min(characters.length, start + maximum)
    segments.push({ content: characters.slice(start, end).join(''), charStart: start, charEnd: end })
  }
  return segments
}

function normalizedText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
}

function cjkNgrams(value) {
  const tokens = []
  const seen = new Set()
  for (const match of value.matchAll(/[\p{Script=Han}]+/gu)) {
    const characters = Array.from(match[0])
    for (const size of [2, 3]) {
      if (characters.length < size) continue
      for (let index = 0; index <= characters.length - size; index += 1) {
        const token = characters.slice(index, index + size).join('')
        if (!seen.has(token)) {
          seen.add(token)
          tokens.push(token)
        }
      }
    }
  }
  return tokens
}

function searchableText(value) {
  const normalized = normalizedText(value)
  const grams = cjkNgrams(normalized)
  return grams.length ? `${normalized} ${grams.join(' ')}` : normalized
}

function firstTitle(policy, row) {
  for (const column of policy.title ?? []) {
    if (row[column] === null || row[column] === undefined) continue
    const value = normalizeScalar(row[column]).trim()
    if (value) return value.slice(0, 500)
  }
  return policy.entityType
}

function documentId(sourceTable, sourceRowId, fieldPath, segmentIndex) {
  const hash = createHash('sha256')
    .update(sourceTable).update('\0')
    .update(sourceRowId).update('\0')
    .update(fieldPath).update('\0')
    .update(String(segmentIndex))
    .digest('hex')
  return `search-v2:${hash}`
}

function documentsForRow(db, policy, row, columns = policyColumns(db, policy)) {
  const sourceRowId = rowKey(policy, row)
  const entityIdColumn = policy.entityId ?? policy.key[0]
  const entityId = normalizeScalar(row[entityIdColumn] ?? sourceRowId)
  const candidateId = policy.candidateId && row[policy.candidateId] != null
    ? normalizeScalar(row[policy.candidateId]) || null
    : null
  const title = firstTitle(policy, row)
  const archivedAt = policy.archived && row[policy.archived] != null
    ? normalizeScalar(row[policy.archived]) || null
    : null
  const sourceTimestamp = row.updated_at ?? row.created_at
  const sourceUpdatedAt = sourceTimestamp == null ? null : normalizeScalar(sourceTimestamp) || null
  const timestamp = new Date().toISOString()
  const documents = []

  for (const field of fieldValues(policy, columns, row)) {
    const segments = splitDeterministically(field.value)
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      documents.push({
        documentId: documentId(policy.table, sourceRowId, field.fieldPath, index),
        entityType: policy.entityType,
        entityId,
        candidateId,
        sourceTable: policy.table,
        sourceRowId,
        fieldPath: field.fieldPath,
        segmentIndex: index,
        segmentCount: segments.length,
        charStart: segment.charStart,
        charEnd: segment.charEnd,
        title,
        content: segment.content,
        normalizedContent: normalizedText(segment.content),
        searchText: searchableText(segment.content),
        archivedAt,
        sourceUpdatedAt,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    }
  }
  return documents
}

function documentUpsertStatement(db) {
  return db.prepare(`
    INSERT INTO ${SEARCH_DOCUMENTS_TABLE}(
      document_id, entity_type, entity_id, candidate_id,
      source_table, source_row_id, field_path,
      segment_index, segment_count, char_start, char_end,
      title, content, normalized_content, search_text,
      archived_at, source_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_table, source_row_id, field_path, segment_index) DO UPDATE SET
      document_id = excluded.document_id,
      entity_type = excluded.entity_type,
      entity_id = excluded.entity_id,
      candidate_id = excluded.candidate_id,
      segment_count = excluded.segment_count,
      char_start = excluded.char_start,
      char_end = excluded.char_end,
      title = excluded.title,
      content = excluded.content,
      normalized_content = excluded.normalized_content,
      search_text = excluded.search_text,
      archived_at = excluded.archived_at,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at
    WHERE ${SEARCH_DOCUMENTS_TABLE}.document_id IS NOT excluded.document_id
       OR ${SEARCH_DOCUMENTS_TABLE}.entity_type IS NOT excluded.entity_type
       OR ${SEARCH_DOCUMENTS_TABLE}.entity_id IS NOT excluded.entity_id
       OR ${SEARCH_DOCUMENTS_TABLE}.candidate_id IS NOT excluded.candidate_id
       OR ${SEARCH_DOCUMENTS_TABLE}.segment_count IS NOT excluded.segment_count
       OR ${SEARCH_DOCUMENTS_TABLE}.char_start IS NOT excluded.char_start
       OR ${SEARCH_DOCUMENTS_TABLE}.char_end IS NOT excluded.char_end
       OR ${SEARCH_DOCUMENTS_TABLE}.title IS NOT excluded.title
       OR ${SEARCH_DOCUMENTS_TABLE}.content IS NOT excluded.content
       OR ${SEARCH_DOCUMENTS_TABLE}.normalized_content IS NOT excluded.normalized_content
       OR ${SEARCH_DOCUMENTS_TABLE}.search_text IS NOT excluded.search_text
       OR ${SEARCH_DOCUMENTS_TABLE}.archived_at IS NOT excluded.archived_at
  `)
}

function upsertDocuments(insert, documents) {
  let written = 0
  for (const document of documents) {
    written += Number(insert.run(
      document.documentId, document.entityType, document.entityId, document.candidateId,
      document.sourceTable, document.sourceRowId, document.fieldPath,
      document.segmentIndex, document.segmentCount, document.charStart, document.charEnd,
      document.title, document.content, document.normalizedContent, document.searchText,
      document.archivedAt, document.sourceUpdatedAt, document.createdAt, document.updatedAt
    ).changes ?? 0)
  }
  return written
}

function replaceDocumentsForRow(db, selectExisting, deleteDocument, upsertDocument, policy, row, columns) {
  const sourceRowId = rowKey(policy, row)
  const documents = documentsForRow(db, policy, row, columns)
  const expectedIds = new Set(documents.map((document) => document.documentId))
  const existing = selectExisting.all(policy.table, sourceRowId)
  let removed = 0
  for (const document of existing) {
    if (expectedIds.has(document.document_id)) continue
    removed += Number(deleteDocument.run(document.row_id).changes ?? 0)
  }
  return {
    previous_documents: existing.length,
    active_documents: documents.length,
    removed_documents: removed,
    written_documents: upsertDocuments(upsertDocument, documents)
  }
}

function queueRow(db, policy, row, reason, timestamp) {
  db.prepare(`
    INSERT INTO ${DIRTY_TABLE}(source_table, source_row_id, reason, queued_at, attempts, last_error)
    VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(source_table, source_row_id) DO UPDATE SET
      reason = excluded.reason,
      queued_at = excluded.queued_at,
      attempts = 0,
      last_error = NULL
  `).run(policy.table, rowKey(policy, row), reason, timestamp)
}

function deleteStaleDocuments(db, policy) {
  return db.prepare(`
    DELETE FROM ${SEARCH_DOCUMENTS_TABLE}
    WHERE source_table = ?
      AND NOT EXISTS (
        SELECT 1 FROM ${quoteIdentifier(policy.table)} AS source
        WHERE ${sourceRowMatchPredicate(policy, 'source', `${SEARCH_DOCUMENTS_TABLE}.source_row_id`)}
      )
  `).run(policy.table).changes
}

function encodeQueueCursor(values) {
  return JSON.stringify(values.map((value) => typeof value === 'bigint' ? value.toString(10) : value))
}

function decodeQueueCursor(value) {
  if (!value || value === '__done__' || value === '__cleanup__') return value || null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function updateBackfillQueueCheckpoint(db, {
  status = 'queued',
  queueTable = null,
  queueCursor = null,
  queuedRows,
  documentCount,
  startedAt,
  processedRows = 0
} = {}) {
  const timestamp = new Date().toISOString()
  db.prepare(`
    UPDATE ${CHECKPOINT_TABLE}
    SET status = ?, queued_rows = COALESCE(?, queued_rows), processed_rows = ?,
        document_count = COALESCE(?, document_count), started_at = COALESCE(?, started_at),
        completed_at = NULL, updated_at = ?, error_code = NULL,
        queue_table = ?, queue_cursor = ?
    WHERE scope = 'full'
  `).run(
    status,
    queuedRows ?? null,
    processedRows,
    documentCount ?? null,
    startedAt ?? null,
    timestamp,
    queueTable,
    queueCursor
  )
}

function deleteStaleDocumentsBatch(db, policy, limit) {
  return Number(db.prepare(`
    DELETE FROM ${SEARCH_DOCUMENTS_TABLE}
    WHERE row_id IN (
      SELECT stale.row_id
      FROM ${SEARCH_DOCUMENTS_TABLE} AS stale
      WHERE stale.source_table = ?
        AND NOT EXISTS (
          SELECT 1 FROM ${quoteIdentifier(policy.table)} AS source
          WHERE ${sourceRowMatchPredicate(policy, 'source', 'stale.source_row_id')}
        )
      LIMIT ?
    )
  `).run(policy.table, limit).changes ?? 0)
}

// Compatibility-only source tables are intentionally excluded from the
// searchable policy and therefore have no current rows to refresh.  Older
// versions did index them, though, so a full backfill must remove every
// derived document they left behind.  Keep the delete bounded: each call is
// committed together with the queue checkpoint and can be replayed safely
// after a worker restart.
function deleteAllDocumentsBatch(db, sourceTable, limit) {
  return Number(db.prepare(`
    DELETE FROM ${SEARCH_DOCUMENTS_TABLE}
    WHERE row_id IN (
      SELECT row_id
      FROM ${SEARCH_DOCUMENTS_TABLE}
      WHERE source_table = ?
      LIMIT ?
    )
  `).run(sourceTable, limit).changes ?? 0)
}

export function explainBusinessSearchStaleCleanup(db, sourceTable) {
  const policy = POLICY_BY_TABLE.get(String(sourceTable ?? ''))
  if (!policy || !tableExists(db, policy.table)) {
    fail('invalid_source_table', 'Unknown business-search source table.')
  }
  return db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT stale.row_id
    FROM ${SEARCH_DOCUMENTS_TABLE} AS stale
    WHERE stale.source_table = ?
      AND NOT EXISTS (
        SELECT 1 FROM ${quoteIdentifier(policy.table)} AS source
        WHERE ${sourceRowMatchPredicate(policy, 'source', 'stale.source_row_id')}
      )
    LIMIT ?
  `).all(policy.table, 1)
}

/**
 * Queue a complete source snapshot using keyset-paginated INSERT ... SELECT
 * batches.  Each batch has its own transaction and advances a durable cursor,
 * so a worker restart resumes from the last committed source key.
 */
export function queueBusinessSearchBackfill(db, { batchSize = 500 } = {}) {
  migrateBusinessSearch(db)
  const size = Number(batchSize)
  if (!Number.isSafeInteger(size) || size < 1 || size > 5_000) {
    fail('invalid_limit', 'Backfill queue batchSize must be between 1 and 5000.')
  }
  const timestamp = new Date().toISOString()
  const checkpoint = db.prepare(`
    SELECT status, queue_table, queue_cursor, started_at
    FROM ${CHECKPOINT_TABLE} WHERE scope = 'full'
  `).get()
  let startIndex = 0
  let cursorValues = null
  let resumeCurrent = false
  // A worker can fail after committing a queue batch but before the next
  // worker observes it. Keep failed/indexing checkpoints resumable while a
  // durable table/cursor is present. synchronizeBusinessSearch also restarts
  // an empty failed checkpoint when no dirty row exists to drive recovery.
  if (checkpoint?.queue_table && ['queued', 'indexing', 'failed'].includes(String(checkpoint.status))) {
    const index = TABLE_POLICIES.findIndex((policy) => policy.table === checkpoint.queue_table)
    if (index >= 0) {
      startIndex = index
      const cursor = decodeQueueCursor(checkpoint.queue_cursor)
      if (cursor === '__done__') startIndex += 1
      else if (cursor === '__cleanup__') {
        // Cleanup is committed in bounded transactions.  Resume the same
        // policy after a crash so stale rows left after the last checkpoint
        // are not silently skipped.
        startIndex = index
      } else if (Array.isArray(cursor)) {
        cursorValues = cursor
        resumeCurrent = true
      }
    }
  }

  // The physical document count is the durable source of truth while queue
  // cleanup runs.  Keeping it in memory avoids a full COUNT(*) scan for every
  // bounded delete; a restart re-reads the actual count before resuming.
  let documentCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${SEARCH_DOCUMENTS_TABLE}`).get().count ?? 0)

  // A fresh run resets the index-progress counters.  A resumable queue keeps
  // the existing cursor and only rewrites rows after that cursor.
  const startedAt = resumeCurrent ? (checkpoint.started_at ?? timestamp) : timestamp
  if (!resumeCurrent) {
    transaction(db, () => {
      updateBackfillQueueCheckpoint(db, {
        status: 'queued',
        queueTable: TABLE_POLICIES[startIndex]?.table ?? null,
        queueCursor: null,
        queuedRows: null,
        documentCount,
        startedAt,
        processedRows: 0
      })
    })
  }

  let staleDocuments = 0
  let nonSearchableDocuments = 0
  for (let policyIndex = startIndex; policyIndex < TABLE_POLICIES.length; policyIndex += 1) {
    const policy = TABLE_POLICIES[policyIndex]
    if (!tableExists(db, policy.table)) {
      cursorValues = null
      resumeCurrent = false
      continue
    }

    if (policy.searchable === false) {
      // These tables are compatibility metadata only.  Do not leave legacy
      // field documents behind: they are outside coverage totals and would
      // make the physical derived row count diverge from the checkpoint.
      // `__cleanup__` is deliberately reused as the durable phase marker so
      // both an old stale-cleanup checkpoint and a new purge checkpoint resume
      // by deleting the remaining rows.
      while (true) {
        const removed = transaction(db, () => {
          const count = deleteAllDocumentsBatch(db, policy.table, size)
          documentCount = Math.max(0, documentCount - count)
          updateBackfillQueueCheckpoint(db, {
            status: 'queued',
            queueTable: policy.table,
            queueCursor: '__cleanup__',
            startedAt,
            processedRows: 0,
            documentCount
          })
          return count
        })
        nonSearchableDocuments += removed
        if (removed === 0) break
      }
      // Any dirty rows left by an older searchable policy are now redundant:
      // this table has no indexable fields and all of its derived documents
      // have been removed.  Keep the cleanup in its own transaction so a
      // crash before this point remains resumable.
      transaction(db, () => {
        db.prepare(`DELETE FROM ${DIRTY_TABLE} WHERE source_table = ?`).run(policy.table)
        updateBackfillQueueCheckpoint(db, {
          status: 'queued',
          queueTable: policy.table,
          queueCursor: '__done__',
          startedAt,
          processedRows: 0,
          documentCount
        })
      })
      cursorValues = null
      resumeCurrent = false
      continue
    }

    // Stale documents are removed before queuing source rows.  A cleanup
    // cursor is durable for the same reason as a source-key cursor.
    if (!resumeCurrent) {
      while (true) {
        const removed = transaction(db, () => {
          const count = deleteStaleDocumentsBatch(db, policy, size)
          documentCount = Math.max(0, documentCount - count)
          updateBackfillQueueCheckpoint(db, {
            status: 'queued',
            queueTable: policy.table,
            queueCursor: '__cleanup__',
            startedAt,
            processedRows: 0,
            documentCount
          })
          return count
        })
        staleDocuments += removed
        if (removed === 0) break
      }
    }

    const keySelection = policy.key.map(quoteIdentifier).join(', ')
    const orderBy = policy.key.map(quoteIdentifier).join(', ')
    while (true) {
      // The cursor changes after every committed batch, so compile the
      // keyset predicate with the current parameter shape each iteration.
      const cursorPredicate = Array.isArray(cursorValues)
        ? policy.key.length === 1
          ? `WHERE ${quoteIdentifier(policy.key[0])} > ?`
          : `WHERE (${keySelection}) > (${policy.key.map(() => '?').join(', ')})`
        : ''
      const selectSql = `
        SELECT ${keySelection}
        FROM ${quoteIdentifier(policy.table)}
        ${cursorPredicate}
        ORDER BY ${orderBy}
        LIMIT ?
      `
      const insertSql = `
        INSERT INTO ${DIRTY_TABLE}(source_table, source_row_id, reason, queued_at, attempts, last_error)
        SELECT ?, ${sourceRowExpression(policy, 'source')}, ?, ?, 0, NULL
        FROM (
          SELECT ${keySelection}
          FROM ${quoteIdentifier(policy.table)}
          ${cursorPredicate}
          ORDER BY ${orderBy}
          LIMIT ?
        ) AS source
        WHERE 1
        ON CONFLICT(source_table, source_row_id) DO UPDATE SET
          reason = excluded.reason,
          queued_at = excluded.queued_at,
          attempts = 0,
          last_error = NULL
      `
      const selected = db.prepare(selectSql).all(...(Array.isArray(cursorValues) ? cursorValues : []), size)
      if (!selected.length) break
      const last = selected.at(-1)
      const nextCursor = encodeQueueCursor(policy.key.map((column) => last[column]))
      transaction(db, () => {
        db.prepare(insertSql).run(
          policy.table,
          'backfill',
          timestamp,
          ...(Array.isArray(cursorValues) ? cursorValues : []),
          size
        )
        updateBackfillQueueCheckpoint(db, {
          status: 'queued',
          queueTable: policy.table,
          queueCursor: nextCursor,
          startedAt,
          processedRows: 0
        })
      })
      cursorValues = policy.key.map((column) => last[column])
      resumeCurrent = true
    }
    transaction(db, () => {
      updateBackfillQueueCheckpoint(db, {
        status: 'queued',
        queueTable: policy.table,
        queueCursor: '__done__',
        startedAt,
        processedRows: 0
      })
    })
    cursorValues = null
    resumeCurrent = false
  }

  let queuedRows = 0
  transaction(db, () => {
    queuedRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${DIRTY_TABLE}`).get().count ?? 0)
    // Re-read after all cleanup phases.  This also repairs a checkpoint left
    // by an interrupted older implementation whose count included legacy
    // compatibility documents.
    documentCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${SEARCH_DOCUMENTS_TABLE}`).get().count ?? 0)
    updateBackfillQueueCheckpoint(db, {
      status: 'queued',
      queueTable: null,
      queueCursor: null,
      queuedRows,
      documentCount,
      startedAt,
      processedRows: 0
    })
  })
  return {
    queued_rows: queuedRows,
    stale_documents_deleted: staleDocuments,
    non_searchable_documents_deleted: nonSearchableDocuments
  }
}

function markDirtyError(db, dirty, error) {
  db.prepare(`
    UPDATE ${DIRTY_TABLE}
    SET attempts = attempts + 1, last_error = ?, queued_at = ?
    WHERE source_table = ? AND source_row_id = ?
  `).run(String(error?.code ?? error?.message ?? 'index_failed').slice(0, 500), new Date().toISOString(), dirty.source_table, dirty.source_row_id)
  db.prepare(`
    UPDATE ${CHECKPOINT_TABLE}
    SET status = 'failed', updated_at = ?, error_code = ? WHERE scope = 'full'
  `).run(new Date().toISOString(), String(error?.code ?? 'index_failed').slice(0, 100))
}

export function flushBusinessSearchDirty(db, { limit = 500 } = {}) {
  migrateBusinessSearch(db)
  const batchLimit = Number(limit)
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 5_000) {
    fail('invalid_limit', 'Dirty flush limit must be an integer between 1 and 5000.')
  }
  const selectedDirtyRows = db.prepare(`
    SELECT source_table, source_row_id, reason, attempts
    FROM ${DIRTY_TABLE}
    ORDER BY queued_at, source_table, source_row_id
    LIMIT ?
  `).all(batchLimit + 1)
  const hasMoreDirtyRows = selectedDirtyRows.length > batchLimit
  const dirtyRows = selectedDirtyRows.slice(0, batchLimit)
  if (!dirtyRows.length) {
    const coverage = getBusinessSearchCoverage(db, { includeFields: false })
    return {
      processed_rows: 0,
      inserted_documents: 0,
      written_documents: 0,
      removed_documents: 0,
      remaining_rows: 0,
      coverage
    }
  }

  const checkpointBeforeBatch = db.prepare(`
    SELECT status, queued_rows, processed_rows, document_count
    FROM ${CHECKPOINT_TABLE} WHERE scope = 'full'
  `).get()
  const fullBackfillBatch = Boolean(
    checkpointBeforeBatch &&
    ['queued', 'indexing'].includes(checkpointBeforeBatch.status) &&
    Number(checkpointBeforeBatch.queued_rows ?? 0) > Number(checkpointBeforeBatch.processed_rows ?? 0)
  )
  let activeDocuments = 0
  let previousDocuments = 0
  let writtenDocuments = 0
  let removedDocuments = 0
  let checkpointDocumentCount = null
  let failedDirty = null
  try {
    transaction(db, () => {
      checkpointDocumentCount = Number(checkpointBeforeBatch?.document_count ?? 0)
      db.prepare(`UPDATE ${CHECKPOINT_TABLE} SET status = 'indexing', updated_at = ? WHERE scope = 'full'`)
        .run(new Date().toISOString())
      const removeDocuments = db.prepare(`
        DELETE FROM ${SEARCH_DOCUMENTS_TABLE} WHERE source_table = ? AND source_row_id = ?
      `)
      const selectExisting = db.prepare(`
        SELECT row_id, document_id
        FROM ${SEARCH_DOCUMENTS_TABLE}
        WHERE source_table = ? AND source_row_id = ?
      `)
      const deleteDocument = db.prepare(`DELETE FROM ${SEARCH_DOCUMENTS_TABLE} WHERE row_id = ?`)
      const upsertDocument = documentUpsertStatement(db)
      const removeDirty = db.prepare(`
        DELETE FROM ${DIRTY_TABLE} WHERE source_table = ? AND source_row_id = ?
      `)
      const sourceStatements = new Map()
      const columnCatalog = new Map()
      for (const dirty of dirtyRows) {
        failedDirty = dirty
        const policy = POLICY_BY_TABLE.get(dirty.source_table)
        if (!policy || policy.searchable === false || !tableExists(db, dirty.source_table)) {
          const removed = Number(removeDocuments.run(dirty.source_table, dirty.source_row_id).changes ?? 0)
          previousDocuments += removed
          removedDocuments += removed
          removeDirty.run(dirty.source_table, dirty.source_row_id)
          continue
        }
        if (!sourceStatements.has(policy.table)) {
          sourceStatements.set(policy.table, sourceRowStatement(db, policy))
          columnCatalog.set(policy.table, policyColumns(db, policy))
        }
        const row = findSourceRow(db, policy, dirty.source_row_id, sourceStatements.get(policy.table))
        if (row) {
          const replacement = replaceDocumentsForRow(
            db,
            selectExisting,
            deleteDocument,
            upsertDocument,
            policy,
            row,
            columnCatalog.get(policy.table)
          )
          previousDocuments += replacement.previous_documents
          activeDocuments += replacement.active_documents
          removedDocuments += replacement.removed_documents
          writtenDocuments += replacement.written_documents
        } else {
          const removed = Number(removeDocuments.run(dirty.source_table, dirty.source_row_id).changes ?? 0)
          previousDocuments += removed
          removedDocuments += removed
        }
        removeDirty.run(dirty.source_table, dirty.source_row_id)
      }
      const nextDocumentCount = Math.max(
        0,
        checkpointDocumentCount - previousDocuments + activeDocuments
      )
      db.prepare(`
        UPDATE ${CHECKPOINT_TABLE}
        SET processed_rows = processed_rows + ?, document_count = ?,
            updated_at = ?, error_code = NULL
        WHERE scope = 'full'
      `).run(dirtyRows.length, nextDocumentCount, new Date().toISOString())
    })
  } catch (error) {
    if (failedDirty) markDirtyError(db, failedDirty, error)
    throw error
  }

  const remaining = fullBackfillBatch
    ? Math.max(
        0,
        Number(checkpointBeforeBatch.queued_rows ?? 0) -
        Number(checkpointBeforeBatch.processed_rows ?? 0) -
        dirtyRows.length
      )
    // Incremental workers only need a truthful terminal/non-terminal signal.
    // Counting a multi-million-row derived queue before every small batch was
    // the dominant maintenance cost. The extra selected row is a stable
    // sentinel and the status endpoint calculates an exact count on demand.
    : hasMoreDirtyRows ? 1 : 0
  const coverage = remaining === 0 ? getBusinessSearchCoverage(db, { includeFields: false }) : null
  return {
    processed_rows: dirtyRows.length,
    inserted_documents: activeDocuments,
    written_documents: writtenDocuments,
    removed_documents: removedDocuments,
    remaining_rows: remaining,
    coverage
  }
}

function sourceValueRows(db, policy, column) {
  const identifier = quoteIdentifier(column.name)
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${quoteIdentifier(policy.table)}
    WHERE ${identifier} IS NOT NULL
      AND (typeof(${identifier}) <> 'text' OR TRIM(${identifier}) <> '')
  `).get().count ?? 0)
}

function fieldDocumentCoverage(db, policy, column) {
  const fieldPath = `${policy.table}.${column.name}`
  const isJson = (policy.json ?? []).includes(column.name)
  const escapedFieldPath = fieldPath.replace(/[!%_]/g, (character) => `!${character}`)
  const row = isJson
    ? db.prepare(`
        SELECT COUNT(DISTINCT source_row_id) AS indexed_rows, COUNT(*) AS document_count
        FROM ${SEARCH_DOCUMENTS_TABLE}
        WHERE source_table = ? AND (
          field_path = ? OR field_path LIKE ? ESCAPE '!' OR field_path LIKE ? ESCAPE '!'
        )
      `).get(policy.table, fieldPath, `${escapedFieldPath}.%`, `${escapedFieldPath}[%`)
    : db.prepare(`
        SELECT COUNT(DISTINCT source_row_id) AS indexed_rows, COUNT(*) AS document_count
        FROM ${SEARCH_DOCUMENTS_TABLE}
        WHERE source_table = ? AND field_path = ?
      `).get(policy.table, fieldPath)
  return {
    indexed_rows: Number(row.indexed_rows ?? 0),
    document_count: Number(row.document_count ?? 0)
  }
}

export function getBusinessSearchCoverage(db, { persist = true, includeFields = true } = {}) {
  migrateBusinessSearch(db)
  const checkedAt = new Date().toISOString()
  const tables = []
  const fields = []
  for (const policy of TABLE_POLICIES) {
    if (policy.searchable === false || !tableExists(db, policy.table)) continue
    const sourceRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(policy.table)}`).get().count)
    const indexed = db.prepare(`
      SELECT COUNT(DISTINCT source_row_id) AS indexed_rows, COUNT(*) AS document_count
      FROM ${SEARCH_DOCUMENTS_TABLE} WHERE source_table = ?
    `).get(policy.table)
    const dirtyRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${DIRTY_TABLE} WHERE source_table = ?`).get(policy.table).count)
    const indexedRows = Number(indexed.indexed_rows ?? 0)
    const documentCount = Number(indexed.document_count ?? 0)
    const status = dirtyRows === 0 && indexedRows === sourceRows ? 'ready' : 'pending'
    const coverage = {
      source_table: policy.table,
      source_rows: sourceRows,
      indexed_rows: indexedRows,
      document_count: documentCount,
      dirty_rows: dirtyRows,
      status,
      checked_at: checkedAt
    }
    tables.push(coverage)
    if (persist) {
      db.prepare(`
        INSERT INTO ${COVERAGE_TABLE}(
          source_table, source_rows, indexed_rows, document_count, dirty_rows, status, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_table) DO UPDATE SET
          source_rows = excluded.source_rows,
          indexed_rows = excluded.indexed_rows,
          document_count = excluded.document_count,
          dirty_rows = excluded.dirty_rows,
          status = excluded.status,
          checked_at = excluded.checked_at
      `).run(policy.table, sourceRows, indexedRows, documentCount, dirtyRows, status, checkedAt)
    }
    if (includeFields) {
      for (const column of policyColumns(db, policy)) {
        const fieldPath = `${policy.table}.${column.name}`
        const sourceRowsWithValue = sourceValueRows(db, policy, column)
        const indexed = fieldDocumentCoverage(db, policy, column)
        // JSON field coverage is value coverage, not one-document-per-leaf:
        // equivalent leaves intentionally reuse the first deterministic path.
        const isJson = (policy.json ?? []).includes(column.name)
        const fieldStatus = dirtyRows === 0 && (
          isJson
            ? indexed.indexed_rows <= sourceRowsWithValue
            : indexed.indexed_rows === sourceRowsWithValue
        ) ? 'ready' : 'pending'
        const fieldCoverage = {
          source_table: policy.table,
          field_path: fieldPath,
          source_value_rows: sourceRowsWithValue,
          indexed_rows: indexed.indexed_rows,
          document_count: indexed.document_count,
          status: fieldStatus,
          checked_at: checkedAt
        }
        fields.push(fieldCoverage)
        if (persist) {
          db.prepare(`
            INSERT INTO ${FIELD_COVERAGE_TABLE}(
              source_table, field_path, source_value_rows, indexed_rows,
              document_count, status, checked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_table, field_path) DO UPDATE SET
              source_value_rows = excluded.source_value_rows,
              indexed_rows = excluded.indexed_rows,
              document_count = excluded.document_count,
              status = excluded.status,
              checked_at = excluded.checked_at
          `).run(
            policy.table, fieldPath, sourceRowsWithValue, indexed.indexed_rows,
            indexed.document_count, fieldStatus, checkedAt
          )
        }
      }
    }
  }

  const totals = tables.reduce((result, table) => ({
    source_rows: result.source_rows + table.source_rows,
    indexed_rows: result.indexed_rows + table.indexed_rows,
    document_count: result.document_count + table.document_count,
    dirty_rows: result.dirty_rows + table.dirty_rows
  }), { source_rows: 0, indexed_rows: 0, document_count: 0, dirty_rows: 0 })
  const status = tables.every((table) => table.status === 'ready') && fields.every((field) => field.status === 'ready')
    ? 'ready'
    : 'pending'
  if (persist) {
    db.prepare(`
      UPDATE ${CHECKPOINT_TABLE}
      SET status = ?, document_count = ?, completed_at = CASE WHEN ? = 'ready' THEN ? ELSE NULL END,
          updated_at = ?, error_code = NULL,
          queue_table = CASE WHEN ? = 'ready' THEN NULL ELSE queue_table END,
          queue_cursor = CASE WHEN ? = 'ready' THEN NULL ELSE queue_cursor END
      WHERE scope = 'full'
    `).run(status, totals.document_count, status, checkedAt, checkedAt, status, status)
  }
  return {
    status,
    tables,
    fields,
    totals: {
      ...totals,
      field_count: fields.length,
      ready_field_count: fields.filter((field) => field.status === 'ready').length
    },
    checked_at: checkedAt
  }
}

export function backfillBusinessSearch(db, { batchSize = 500, maxBatches = Number.POSITIVE_INFINITY } = {}) {
  const queued = queueBusinessSearchBackfill(db, { batchSize })
  let batches = 0
  let processedRows = 0
  let insertedDocuments = 0
  let writtenDocuments = 0
  let removedDocuments = 0
  let remainingRows = null
  while (batches < maxBatches) {
    const result = flushBusinessSearchDirty(db, { limit: batchSize })
    remainingRows = Number(result.remaining_rows ?? 0)
    processedRows += result.processed_rows
    insertedDocuments += result.inserted_documents
    writtenDocuments += result.written_documents
    removedDocuments += result.removed_documents
    if (result.processed_rows === 0) break
    batches += 1
    if (result.remaining_rows === 0) break
  }
  if (remainingRows === null) {
    remainingRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${DIRTY_TABLE}`).get().count ?? 0)
  }
  const coverage = getBusinessSearchCoverage(db)
  return {
    ...queued,
    processed_rows: processedRows,
    inserted_documents: insertedDocuments,
    written_documents: writtenDocuments,
    removed_documents: removedDocuments,
    batches,
    remaining_rows: remainingRows,
    coverage
  }
}

export function synchronizeBusinessSearch(db, {
  forceBackfill = false,
  batchSize = 5_000,
  maxBatches = Number.POSITIVE_INFINITY,
  allowBackfill
} = {}) {
  if (!isBusinessSearchAvailable(db)) {
    fail('business_search_unavailable', 'Business search V8 is not migrated.', { status: 503 })
  }
  const size = Number(batchSize)
  if (!Number.isSafeInteger(size) || size < 1 || size > 5_000) {
    fail('invalid_limit', 'Business search sync batchSize must be between 1 and 5000.')
  }
  const hasDocuments = Boolean(db.prepare(`SELECT 1 FROM ${SEARCH_DOCUMENTS_TABLE} LIMIT 1`).get())
  const backgroundSearch = db.__candidateWorkbenchSearchPolicy === 'background'
  const shouldAllowBackfill = allowBackfill ?? !backgroundSearch
  const checkpoint = db.prepare(`
    SELECT status, queue_table, queue_cursor
    FROM ${CHECKPOINT_TABLE} WHERE scope = 'full'
  `).get()
  const hasDirtyRows = Boolean(db.prepare(`SELECT 1 FROM ${DIRTY_TABLE} LIMIT 1`).get())
  // 历史遗留：上一次中断的全量回填会在 checkpoint 上留下 queue_table/queued，
  // worker 会把它当成「回填被中断」并重新排队整库（实测约 50 分钟一轮的循环）。
  // 如果索引本身已经可用（有文档、没有 dirty、覆盖自校验通过），这里主动收敛回
  // ready 并清掉队列，让 worker 不再续跑那份早已过期的队列。
  if (hasDocuments && !hasDirtyRows && checkpoint && String(checkpoint.status) !== 'ready') {
    const healed = getBusinessSearchCoverage(db, { persist: true, includeFields: true })
    if (healed?.status === 'ready') {
      checkpoint.status = 'ready'
      checkpoint.queue_table = null
      checkpoint.queue_cursor = null
    }
  }
  const resumableQueue = Boolean(
    checkpoint?.queue_table &&
    ['queued', 'indexing', 'failed'].includes(String(checkpoint.status))
  )
  const retryEmptyCheckpoint = Boolean(
    shouldAllowBackfill &&
    !hasDirtyRows &&
    !checkpoint?.queue_table &&
    ['queued', 'indexing', 'failed'].includes(String(checkpoint?.status))
  )
  // A request-side read/write path in a file-backed service must never turn
  // an empty index or a large dirty queue into an unbounded synchronous scan.
  const maximumBatches = backgroundSearch && maxBatches === Number.POSITIVE_INFINITY
    ? 1
    : Number(maxBatches)
  if (!(maximumBatches === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maximumBatches) && maximumBatches >= 1))) {
    fail('invalid_limit', 'Business search maxBatches must be a positive integer or Infinity.')
  }
  if (
    forceBackfill ||
    (!hasDocuments && shouldAllowBackfill) ||
    (resumableQueue && shouldAllowBackfill) ||
    retryEmptyCheckpoint
  ) {
    return backfillBusinessSearch(db, { batchSize: size, maxBatches: maximumBatches })
  }
  if (!hasDocuments && !shouldAllowBackfill) {
    return {
      processed_rows: 0,
      inserted_documents: 0,
      written_documents: 0,
      removed_documents: 0,
      remaining_rows: hasDirtyRows ? 1 : 0,
      batches: 0,
      deferred_backfill: true,
      coverage: null
    }
  }
  if (!hasDirtyRows && isBusinessSearchReady(db)) {
    return {
      processed_rows: 0,
      inserted_documents: 0,
      written_documents: 0,
      removed_documents: 0,
      remaining_rows: 0,
      batches: 0,
      coverage: null
    }
  }
  let processedRows = 0
  let insertedDocuments = 0
  let writtenDocuments = 0
  let removedDocuments = 0
  let batches = 0
  let remainingRows = hasDirtyRows ? 1 : 0
  while (batches < maximumBatches) {
    const result = flushBusinessSearchDirty(db, { limit: size })
    remainingRows = Number(result.remaining_rows ?? 0)
    batches += result.processed_rows > 0 ? 1 : 0
    processedRows += result.processed_rows
    insertedDocuments += result.inserted_documents
    writtenDocuments += result.written_documents
    removedDocuments += result.removed_documents
    if (result.remaining_rows === 0 || result.processed_rows === 0) {
      return {
        processed_rows: processedRows,
        inserted_documents: insertedDocuments,
        written_documents: writtenDocuments,
        removed_documents: removedDocuments,
        remaining_rows: result.remaining_rows,
        batches,
        coverage: result.coverage ?? getBusinessSearchCoverage(db, { includeFields: false })
      }
    }
  }
  return {
    processed_rows: processedRows,
    inserted_documents: insertedDocuments,
    written_documents: writtenDocuments,
    removed_documents: removedDocuments,
    remaining_rows: remainingRows,
    batches,
    coverage: null
  }
}

function compactFtsSql(tableName) {
  return `
    CREATE VIRTUAL TABLE ${quoteIdentifier(tableName)} USING fts5(
      search_text,
      content = '',
      contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `
}

function isCompactFtsTable(db, tableName) {
  const sql = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(tableName)?.sql ?? ''
  return /\bcontent\s*=\s*''/i.test(sql) && /\bcontentless_delete\s*=\s*1/i.test(sql)
}

export function isBusinessSearchFtsCompact(db) {
  return tableExists(db, SEARCH_FTS_TABLE) && isCompactFtsTable(db, SEARCH_FTS_TABLE)
}

export function compactBusinessSearchOrdinaryIndexes(db) {
  if (!tableExists(db, SEARCH_DOCUMENTS_TABLE)) {
    fail('business_search_unavailable', 'Business search documents are unavailable.', { status: 503 })
  }
  transaction(db, () => {
    // The source UNIQUE constraint already owns this exact key order.
    db.exec('DROP INDEX IF EXISTS search_documents_v2_source_idx')
    const candidateSql = db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_v2_candidate_idx'
    `).get()?.sql ?? ''
    if (/updated_at/i.test(candidateSql)) {
      db.exec(`
        DROP INDEX search_documents_v2_candidate_idx;
        CREATE INDEX search_documents_v2_candidate_idx
          ON ${SEARCH_DOCUMENTS_TABLE}(candidate_id, row_id);
      `)
    }
    const entitySql = db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_v2_entity_idx'
    `).get()?.sql ?? ''
    if (/updated_at/i.test(entitySql)) {
      db.exec(`
        DROP INDEX search_documents_v2_entity_idx;
        CREATE INDEX search_documents_v2_entity_idx
          ON ${SEARCH_DOCUMENTS_TABLE}(entity_type, entity_id, row_id);
      `)
    }
  })
  return {
    redundant_source_index_removed: !db.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_v2_source_idx'
    `).get(),
    candidate_index: db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_v2_candidate_idx'
    `).get()?.sql ?? null,
    entity_index: db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_v2_entity_idx'
    `).get()?.sql ?? null
  }
}

export function compactBusinessSearchFts(db, {
  batchSize = 10_000,
  maxBatches = 1,
  compactOrdinaryIndexes = false
} = {}) {
  if (!isBusinessSearchAvailable(db)) {
    fail('business_search_unavailable', 'Business search V8 is not migrated.', { status: 503 })
  }
  const size = Number(batchSize)
  const maximumBatches = Number(maxBatches)
  if (!Number.isSafeInteger(size) || size < 1 || size > 50_000) {
    fail('invalid_limit', 'FTS compaction batchSize must be between 1 and 50000.')
  }
  if (!(maximumBatches === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maximumBatches) && maximumBatches >= 1))) {
    fail('invalid_limit', 'FTS compaction maxBatches must be a positive integer or Infinity.')
  }

  const sourceDocuments = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${SEARCH_DOCUMENTS_TABLE}`).get().count)
  if (isBusinessSearchFtsCompact(db)) {
    const indexedDocuments = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${SEARCH_FTS_TABLE}`).get().count)
    if (indexedDocuments !== sourceDocuments) {
      fail('fts_count_mismatch', 'Compact FTS row count does not match search documents.', {
        status: 500,
        details: { source_documents: sourceDocuments, indexed_documents: indexedDocuments }
      })
    }
    const ordinaryIndexes = compactOrdinaryIndexes ? compactBusinessSearchOrdinaryIndexes(db) : null
    return {
      status: 'ready',
      already_compact: true,
      source_documents: sourceDocuments,
      indexed_documents: indexedDocuments,
      processed_rows: 0,
      remaining_rows: 0,
      batches: 0,
      ordinary_indexes: ordinaryIndexes
    }
  }

  if (!tableExists(db, SEARCH_FTS_BUILD_TABLE)) {
    transaction(db, () => {
      db.exec(compactFtsSql(SEARCH_FTS_BUILD_TABLE))
      const timestamp = new Date().toISOString()
      db.prepare(`
        INSERT INTO ${CHECKPOINT_TABLE}(
          scope, status, queued_rows, processed_rows, document_count,
          started_at, completed_at, updated_at, error_code
        ) VALUES ('fts_compaction', 'queued', ?, 0, 0, ?, NULL, ?, NULL)
        ON CONFLICT(scope) DO UPDATE SET
          status = 'queued', queued_rows = excluded.queued_rows,
          processed_rows = 0, document_count = 0,
          started_at = excluded.started_at, completed_at = NULL,
          updated_at = excluded.updated_at, error_code = NULL
      `).run(sourceDocuments, timestamp, timestamp)
    })
  } else if (!isCompactFtsTable(db, SEARCH_FTS_BUILD_TABLE)) {
    fail('fts_compaction_state_invalid', 'The resumable FTS build table has an unexpected schema.', { status: 500 })
  }

  let processedRows = 0
  let batches = 0
  while (batches < maximumBatches) {
    const cursor = Number(db.prepare(`
      SELECT COALESCE(MAX(rowid), 0) AS value FROM ${quoteIdentifier(SEARCH_FTS_BUILD_TABLE)}
    `).get().value ?? 0)
    let inserted = 0
    transaction(db, () => {
      inserted = Number(db.prepare(`
        INSERT INTO ${quoteIdentifier(SEARCH_FTS_BUILD_TABLE)}(rowid, search_text)
        SELECT row_id, search_text
        FROM ${SEARCH_DOCUMENTS_TABLE}
        WHERE row_id > ?
        ORDER BY row_id
        LIMIT ?
      `).run(cursor, size).changes ?? 0)
      if (inserted === 0) return
      const timestamp = new Date().toISOString()
      db.prepare(`
        UPDATE ${CHECKPOINT_TABLE}
        SET status = 'indexing', processed_rows = processed_rows + ?,
            document_count = document_count + ?, updated_at = ?, error_code = NULL
        WHERE scope = 'fts_compaction'
      `).run(inserted, inserted, timestamp)
    })
    if (inserted === 0) break
    processedRows += inserted
    batches += 1
  }

  const indexedDocuments = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${quoteIdentifier(SEARCH_FTS_BUILD_TABLE)}
  `).get().count)
  const remainingRows = Math.max(0, sourceDocuments - indexedDocuments)
  if (remainingRows > 0) {
    return {
      status: 'indexing',
      already_compact: false,
      source_documents: sourceDocuments,
      indexed_documents: indexedDocuments,
      processed_rows: processedRows,
      remaining_rows: remainingRows,
      batches,
      ordinary_indexes: null
    }
  }
  if (indexedDocuments !== sourceDocuments) {
    fail('fts_count_mismatch', 'Resumable FTS compaction did not index every search document.', {
      status: 500,
      details: { source_documents: sourceDocuments, indexed_documents: indexedDocuments }
    })
  }

  transaction(db, () => {
    db.exec(`
      DROP TRIGGER IF EXISTS search_documents_v2_ai;
      DROP TRIGGER IF EXISTS search_documents_v2_au;
      DROP TRIGGER IF EXISTS search_documents_v2_ad;
      DROP TABLE ${quoteIdentifier(SEARCH_FTS_TABLE)};
      ALTER TABLE ${quoteIdentifier(SEARCH_FTS_BUILD_TABLE)} RENAME TO ${quoteIdentifier(SEARCH_FTS_TABLE)};
    `)
    createSearchDocumentTriggers(db)
    const timestamp = new Date().toISOString()
    db.prepare(`
      UPDATE ${CHECKPOINT_TABLE}
      SET status = 'ready', queued_rows = ?, processed_rows = ?, document_count = ?,
          completed_at = ?, updated_at = ?, error_code = NULL
      WHERE scope = 'fts_compaction'
    `).run(sourceDocuments, sourceDocuments, sourceDocuments, timestamp, timestamp)
  })
  const ordinaryIndexes = compactOrdinaryIndexes ? compactBusinessSearchOrdinaryIndexes(db) : null
  return {
    status: 'ready',
    already_compact: false,
    source_documents: sourceDocuments,
    indexed_documents: indexedDocuments,
    processed_rows: processedRows,
    remaining_rows: 0,
    batches,
    ordinary_indexes: ordinaryIndexes
  }
}

export function isBusinessSearchAvailable(db) {
  return tableExists(db, SEARCH_DOCUMENTS_TABLE) && tableExists(db, SEARCH_FTS_TABLE)
}

export function isBusinessSearchReady(db) {
  if (!isBusinessSearchAvailable(db) || !tableExists(db, CHECKPOINT_TABLE)) return false
  const checkpoint = db.prepare(`SELECT status FROM ${CHECKPOINT_TABLE} WHERE scope = 'full'`).get()
  return checkpoint?.status === 'ready'
}

export function getBusinessSearchStatus(db, { includeProgress = true } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    fail('invalid_database', 'A SQLite database connection is required.', { status: 500 })
  }
  const available = isBusinessSearchAvailable(db) && tableExists(db, CHECKPOINT_TABLE)
  if (!available) {
    return {
      state: 'unavailable',
      ready: false,
      available: false,
      progress: null,
      remaining: null,
      processed: null,
      queued: null,
      document_count: null,
      updated_at: null,
      retry_after_ms: 2_000,
      error: { code: 'business_search_unavailable', message: 'The full-field search index is unavailable.' }
    }
  }

  const checkpoint = db.prepare(`
    SELECT status, queued_rows, processed_rows, document_count,
      started_at, completed_at, updated_at, error_code
    FROM ${CHECKPOINT_TABLE}
    WHERE scope = 'full'
  `).get()
  const state = String(checkpoint?.status ?? 'pending')
  const ready = state === 'ready'
  const processed = Number(checkpoint?.processed_rows ?? 0)
  const queued = Number(checkpoint?.queued_rows ?? 0)
  const remaining = includeProgress
    ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${DIRTY_TABLE}`).get().count ?? 0)
    : null
  const checkpointProgressIsComparable = remaining !== null && queued >= processed && queued - processed === remaining
  const progress = ready
    ? 1
    : checkpointProgressIsComparable && queued > 0
      ? Number(Math.min(0.999999, processed / queued).toFixed(6))
      : null
  const errorCode = checkpoint?.error_code ? String(checkpoint.error_code).slice(0, 100) : null
  return {
    state,
    ready,
    available: true,
    progress,
    remaining,
    processed,
    queued,
    document_count: Number(checkpoint?.document_count ?? 0),
    started_at: checkpoint?.started_at ?? null,
    completed_at: checkpoint?.completed_at ?? null,
    updated_at: checkpoint?.updated_at ?? null,
    retry_after_ms: ready ? null : 2_000,
    fts_layout: isBusinessSearchFtsCompact(db) ? 'compact' : 'legacy_metadata',
    error: errorCode
      ? { code: errorCode, message: 'Search index maintenance failed and will be retried.' }
      : null
  }
}

// Agent queries must never perform index maintenance on the request path.
// Callers that use the isolated read-only connection can use this guard to
// fail fast while a background index build is still pending.
export function assertBusinessSearchReady(db) {
  if (!isBusinessSearchAvailable(db)) {
    fail('fts5_unavailable', 'The full-field FTS5 index is unavailable.', { status: 503 })
  }
  if (!isBusinessSearchReady(db)) {
    fail('fts_index_building', 'The full-field FTS5 index is still building. Try again shortly.', {
      status: 503,
      details: getBusinessSearchStatus(db)
    })
  }
  return true
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('invalid_query', `${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function stringList(value, name, { maximum = 100, itemMaximum = 200, allowed } = {}) {
  if (value === undefined || value === null || value === '') return []
  const input = Array.isArray(value) ? value : [value]
  if (input.length > maximum) fail('limit_exceeded', `${name} contains too many values.`, { status: 413 })
  const output = []
  for (const item of input) {
    if (typeof item !== 'string') fail('invalid_query', `${name} must contain strings.`)
    const normalized = item.normalize('NFKC').trim().replace(/\s+/g, ' ')
    if (!normalized || normalized.length > itemMaximum) fail('invalid_query', `${name} contains an invalid value.`)
    if (allowed && !allowed.has(normalized)) fail('invalid_query', `${name} contains an unsupported value.`)
    if (!output.includes(normalized)) output.push(normalized)
  }
  return output
}

function safeFtsPhrase(value) {
  const cleaned = normalizedText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) fail('invalid_query', 'Search terms cannot contain only control characters.')
  return `"${cleaned}"`
}

function cjkExpression(value) {
  const normalized = normalizedText(value)
  const pieces = []
  let lastIndex = 0
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const latin = normalized.slice(lastIndex, match.index).trim()
    if (latin) pieces.push(safeFtsPhrase(latin))
    const chars = Array.from(match[0])
    if (chars.length <= 2) pieces.push(safeFtsPhrase(match[0]))
    else {
      const size = chars.length === 3 ? 3 : 3
      for (let index = 0; index <= chars.length - size; index += 1) {
        pieces.push(safeFtsPhrase(chars.slice(index, index + size).join('')))
      }
    }
    lastIndex = Number(match.index) + match[0].length
  }
  const tail = normalized.slice(lastIndex).trim()
  if (tail) pieces.push(safeFtsPhrase(tail))
  return pieces.length > 1 ? `(${pieces.join(' AND ')})` : pieces[0] ?? safeFtsPhrase(normalized)
}

function termExpression(value) {
  return /\p{Script=Han}/u.test(value) ? cjkExpression(value) : safeFtsPhrase(value)
}

export { termExpression as businessSearchTermExpression }

function normalizeConcepts(input) {
  if (Array.isArray(input.concepts)) {
    if (!input.concepts.length || input.concepts.length > BUSINESS_SEARCH_MAX_CONCEPTS) {
      fail('invalid_query', `concepts must contain between 1 and ${BUSINESS_SEARCH_MAX_CONCEPTS} entries.`)
    }
    return input.concepts.map((concept, index) => {
      const terms = stringList(concept?.terms, `concepts.${index}.terms`, { maximum: 12, itemMaximum: 80 })
      if (!terms.length) fail('invalid_query', `concepts.${index}.terms cannot be empty.`)
      return { label: String(concept.label ?? terms[0]).slice(0, 100), terms }
    })
  }
  const explicit = input.keywords ?? input.terms
  let terms = stringList(explicit, 'keywords', { maximum: BUSINESS_SEARCH_MAX_CONCEPTS, itemMaximum: 80 })
  if (!terms.length) {
    if (typeof input.q !== 'string' || !input.q.trim() || input.q.length > 500) {
      fail('invalid_query', 'q or keywords is required and q may not exceed 500 characters.')
    }
    const normalized = input.q.normalize('NFKC')
    terms = [
      ...(normalized.match(/[A-Za-z][A-Za-z0-9+#.-]{1,79}/g) ?? []),
      ...(normalized.match(/[\p{Script=Han}]{2,40}/gu) ?? [])
    ].slice(0, BUSINESS_SEARCH_MAX_CONCEPTS)
  }
  if (!terms.length) fail('invalid_query', 'No searchable terms were found.')
  return terms.map((term) => ({ label: term, terms: [term] }))
}

function normalizeSearch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_query', 'Search input must be an object.')
  const concepts = normalizeConcepts(input)
  const matchMode = String(input.match_mode ?? input.matchMode ?? 'all').toLowerCase()
  if (!['all', 'any'].includes(matchMode)) fail('invalid_query', 'match_mode must be all or any.')
  const archived = String(input.archived ?? 'include').toLowerCase()
  if (!['include', 'exclude', 'only'].includes(archived)) {
    fail('invalid_query', 'archived must be include, exclude or only.')
  }
  const includeTotalValue = input.include_total ?? input.includeTotal
  if (includeTotalValue !== undefined && typeof includeTotalValue !== 'boolean') {
    fail('invalid_query', 'include_total must be a boolean.')
  }
  const fastValue = input.fast
  if (fastValue !== undefined && typeof fastValue !== 'boolean') {
    fail('invalid_query', 'fast must be a boolean.')
  }
  if (fastValue === true && includeTotalValue === true) {
    fail('invalid_query', 'fast cannot be combined with include_total=true.')
  }
  const fieldPaths = stringList(input.field_paths ?? input.fieldPaths ?? input.field_path ?? input.fieldPath, 'field_paths', {
    maximum: 100,
    itemMaximum: 500
  })
  const fieldPathPrefixes = stringList(input.field_path_prefixes ?? input.fieldPathPrefixes, 'field_path_prefixes', {
    maximum: 100,
    itemMaximum: 500
  })
  const searchablePrefixes = TABLE_POLICIES
    .filter((policy) => policy.searchable !== false)
    .map((policy) => `${policy.table}.`)
  for (const path of [...fieldPaths, ...fieldPathPrefixes]) {
    if (!searchablePrefixes.some((prefix) => path.startsWith(prefix))) {
      fail('invalid_query', 'field_paths must use a searchable server catalog path.')
    }
  }
  return {
    concepts,
    matchMode,
    archived,
    includeTotal: includeTotalValue === undefined ? fastValue !== true : includeTotalValue,
    // `fast:false` is an explicit exact-plan override. This is used when a
    // bounded Top-K probe needs an exact deep page while retaining the
    // caller's `include_total:false` response shape.
    fast: fastValue === true || (includeTotalValue === false && fastValue !== false),
    page: boundedInteger(input.page, 1, 1, BUSINESS_SEARCH_MAX_PAGE, 'page'),
    pageSize: boundedInteger(input.page_size ?? input.pageSize, 20, 1, BUSINESS_SEARCH_MAX_PAGE_SIZE, 'page_size'),
    evidenceLimit: boundedInteger(input.evidence_limit ?? input.evidenceLimit, 3, 1, BUSINESS_SEARCH_MAX_EVIDENCE, 'evidence_limit'),
    entityTypes: stringList(input.entity_types ?? input.entityTypes, 'entity_types', { maximum: 50, itemMaximum: 100 }),
    sourceTables: stringList(input.source_tables ?? input.sourceTables, 'source_tables', {
      maximum: TABLE_POLICIES.length,
      itemMaximum: 100,
      allowed: new Set(TABLE_POLICIES.filter((policy) => policy.searchable !== false).map((policy) => policy.table))
    }),
    fieldPaths,
    fieldPathPrefixes,
    candidateIds: stringList(input.candidate_ids ?? input.candidateIds ?? input.candidate_id ?? input.candidateId, 'candidate_ids', {
      maximum: 100,
      itemMaximum: 200
    }),
    positionIds: stringList(input.position_ids ?? input.positionIds ?? input.position_id ?? input.positionId, 'position_ids', {
      maximum: 100,
      itemMaximum: 200
    }),
    talentPoolIds: stringList(
      input.talent_pool_ids ?? input.talentPoolIds ?? input.talent_pool_id ?? input.talentPoolId,
      'talent_pool_ids',
      { maximum: 100, itemMaximum: 200 }
    )
  }
}

function conceptExpression(concept) {
  const expressions = concept.terms.map(termExpression)
  const expression = expressions.length === 1 ? expressions[0] : `(${expressions.join(' OR ')})`
  return `search_text : (${expression})`
}

function broadExpression(search) {
  const expressions = search.concepts.map(conceptExpression)
  return expressions.join(search.matchMode === 'all' ? ' AND ' : ' OR ')
}

function fastHitLimit(search) {
  if (!search?.fast || search.includeTotal) return null
  // Keep enough ranked documents to cover entities with many indexed fields,
  // while preventing a high-frequency term from materializing millions of
  // rows before the Top-K page is produced.
  // Candidate search plans use snake_case (`page_size`) while the all-record
  // plans use the normalized camelCase shape (`pageSize`). Read both forms so
  // the fast path always binds a finite LIMIT value (binding NaN causes
  // SQLite's "datatype mismatch" error).
  const pageSize = Number(search.page_size ?? search.pageSize ?? 20)
  return Math.min(50_000, Math.max(2_000, pageSize * 100))
}

function fastEvidenceHitLimit(search) {
  const pageHitLimit = fastHitLimit(search)
  if (pageHitLimit === null) return null
  // Candidate evidence is resolved only for the visible Top-K candidates. A
  // wider, unordered posting window avoids scanning millions of high-frequency
  // FTS matches while retaining enough rows for those candidates to appear.
  return Math.min(100_000, pageHitLimit * 10)
}

function candidateFastHitLimit(search) {
  const limit = fastHitLimit(search)
  if (limit === null || (search.source_types ?? []).length) return limit
  // Candidate intersection needs a wider posting sample than entity search so
  // multiple concepts still have enough candidate IDs in common.
  return Math.min(50_000, Math.max(10_000, limit))
}

function sourceFilters(search, alias, parameters) {
  const clauses = []
  if (search.entityTypes.length) {
    clauses.push(`${alias}.entity_type IN (${search.entityTypes.map(() => '?').join(', ')})`)
    parameters.push(...search.entityTypes)
  }
  if (search.sourceTables.length) {
    clauses.push(`${alias}.source_table IN (${search.sourceTables.map(() => '?').join(', ')})`)
    parameters.push(...search.sourceTables)
  }
  if (search.fieldPaths.length) {
    clauses.push(`${alias}.field_path IN (${search.fieldPaths.map(() => '?').join(', ')})`)
    parameters.push(...search.fieldPaths)
  }
  if (search.fieldPathPrefixes.length) {
    clauses.push(`(${search.fieldPathPrefixes.map(() => `${alias}.field_path LIKE ? ESCAPE '!'`).join(' OR ')})`)
    parameters.push(...search.fieldPathPrefixes.map((prefix) => (
      `${prefix.replace(/[!%_]/g, (character) => `!${character}`)}%`
    )))
  }
  const effectivelyArchived = `(CASE
    WHEN ${alias}.candidate_id IS NOT NULL AND ${alias}.candidate_id <> '' THEN EXISTS (
      SELECT 1 FROM candidates archived_candidate
      WHERE archived_candidate.id = ${alias}.candidate_id AND archived_candidate.archived_at IS NOT NULL
    )
    ELSE ${alias}.archived_at IS NOT NULL
  END)`
  if (search.archived === 'exclude') clauses.push(`${effectivelyArchived} = 0`)
  if (search.archived === 'only') clauses.push(`${effectivelyArchived} = 1`)
  if (search.candidateIds.length) {
    clauses.push(`EXISTS (
      SELECT 1 FROM candidate_documents candidate_relation
      WHERE candidate_relation.row_id = ${alias}.row_id
        AND candidate_relation.candidate_id IN (${search.candidateIds.map(() => '?').join(', ')})
    )`)
    parameters.push(...search.candidateIds)
  }
  if (search.positionIds.length) {
    const placeholders = search.positionIds.map(() => '?').join(', ')
    clauses.push(`(
      (${alias}.entity_type = 'position' AND ${alias}.entity_id IN (${placeholders})) OR
      EXISTS (
        SELECT 1 FROM candidate_documents position_relation
        JOIN candidate_positions related_position
          ON related_position.candidate_id = position_relation.candidate_id
        WHERE position_relation.row_id = ${alias}.row_id
          AND related_position.position_id IN (${placeholders})
      )
    )`)
    parameters.push(...search.positionIds, ...search.positionIds)
  }
  if (search.talentPoolIds.length) {
    const placeholders = search.talentPoolIds.map(() => '?').join(', ')
    clauses.push(`(
      (${alias}.entity_type = 'talent_pool' AND ${alias}.entity_id IN (${placeholders})) OR
      EXISTS (
        SELECT 1 FROM candidate_documents talent_pool_relation
        JOIN candidate_talent_pools related_pool
          ON related_pool.candidate_id = talent_pool_relation.candidate_id
        WHERE talent_pool_relation.row_id = ${alias}.row_id
          AND related_pool.talent_pool_id IN (${placeholders})
      )
    )`)
    parameters.push(...search.talentPoolIds, ...search.talentPoolIds)
  }
  return clauses
}

function inList(values, parameters) {
  parameters.push(...values)
  return values.map(() => '?').join(', ')
}

function fastCandidateScopeFilter(alias, candidateIds, parameters) {
  const direct = `${alias}.candidate_id IN (${inList(candidateIds, parameters)})`
  const position = `(
    ${alias}.entity_type = 'position'
    AND EXISTS (
      SELECT 1 FROM candidate_positions mapped_position
      WHERE mapped_position.position_id = ${alias}.entity_id
        AND mapped_position.candidate_id IN (${inList(candidateIds, parameters)})
    )
  )`
  const talentPool = `(
    ${alias}.entity_type = 'talent_pool'
    AND EXISTS (
      SELECT 1 FROM candidate_talent_pools mapped_pool
      WHERE mapped_pool.talent_pool_id = ${alias}.entity_id
        AND mapped_pool.candidate_id IN (${inList(candidateIds, parameters)})
    )
  )`
  const stage = `(
    ${alias}.entity_type = 'stage'
    AND EXISTS (
      SELECT 1 FROM candidates mapped_stage
      WHERE mapped_stage.stage = ${alias}.entity_id
        AND mapped_stage.id IN (${inList(candidateIds, parameters)})
    )
  )`
  const importBatch = `(
    ${alias}.entity_type = 'import_batch'
    AND EXISTS (
      SELECT 1 FROM candidates mapped_batch
      WHERE mapped_batch.import_batch_id = ${alias}.entity_id
        AND mapped_batch.id IN (${inList(candidateIds, parameters)})
    )
  )`
  return `(${direct} OR ${position} OR ${talentPool} OR ${stage} OR ${importBatch})`
}

function fastRelatedCandidateFilter(alias, relationTable, relationColumn, relationIds, parameters) {
  const mappedCandidate = `(
    ${alias}.candidate_id = related_target.candidate_id OR
    (
      ${alias}.entity_type = 'position'
      AND EXISTS (
        SELECT 1 FROM candidate_positions entity_position
        WHERE entity_position.position_id = ${alias}.entity_id
          AND entity_position.candidate_id = related_target.candidate_id
      )
    ) OR
    (
      ${alias}.entity_type = 'talent_pool'
      AND EXISTS (
        SELECT 1 FROM candidate_talent_pools entity_pool
        WHERE entity_pool.talent_pool_id = ${alias}.entity_id
          AND entity_pool.candidate_id = related_target.candidate_id
      )
    ) OR
    (
      ${alias}.entity_type = 'stage'
      AND EXISTS (
        SELECT 1 FROM candidates entity_stage
        WHERE entity_stage.stage = ${alias}.entity_id
          AND entity_stage.id = related_target.candidate_id
      )
    ) OR
    (
      ${alias}.entity_type = 'import_batch'
      AND EXISTS (
        SELECT 1 FROM candidates entity_batch
        WHERE entity_batch.import_batch_id = ${alias}.entity_id
          AND entity_batch.id = related_target.candidate_id
      )
    )
  )`
  return `EXISTS (
    SELECT 1 FROM ${relationTable} related_target
    WHERE related_target.${relationColumn} IN (${inList(relationIds, parameters)})
      AND ${mappedCandidate}
  )`
}

function fastSourceFilters(search, alias, parameters) {
  const clauses = []
  if (search.entityTypes.length) {
    clauses.push(`${alias}.entity_type IN (${inList(search.entityTypes, parameters)})`)
  }
  if (search.sourceTables.length) {
    clauses.push(`${alias}.source_table IN (${inList(search.sourceTables, parameters)})`)
  }
  if (search.fieldPaths.length) {
    clauses.push(`${alias}.field_path IN (${inList(search.fieldPaths, parameters)})`)
  }
  if (search.fieldPathPrefixes.length) {
    clauses.push(`(${search.fieldPathPrefixes.map(() => `${alias}.field_path LIKE ? ESCAPE '!'`).join(' OR ')})`)
    parameters.push(...search.fieldPathPrefixes.map((prefix) => (
      `${prefix.replace(/[!%_]/g, (character) => `!${character}`)}%`
    )))
  }
  const effectivelyArchived = `(CASE
    WHEN ${alias}.candidate_id IS NOT NULL AND ${alias}.candidate_id <> '' THEN EXISTS (
      SELECT 1 FROM candidates archived_candidate
      WHERE archived_candidate.id = ${alias}.candidate_id AND archived_candidate.archived_at IS NOT NULL
    )
    ELSE EXISTS (
      SELECT 1 FROM ${SEARCH_DOCUMENTS_TABLE} archived_document
      WHERE archived_document.row_id = ${alias}.rowid AND archived_document.archived_at IS NOT NULL
    )
  END)`
  if (search.archived === 'exclude') clauses.push(`${effectivelyArchived} = 0`)
  if (search.archived === 'only') clauses.push(`${effectivelyArchived} = 1`)
  if (search.candidateIds.length) {
    clauses.push(fastCandidateScopeFilter(alias, search.candidateIds, parameters))
  }
  if (search.positionIds.length) {
    clauses.push(`(
      (${alias}.entity_type = 'position' AND ${alias}.entity_id IN (${inList(search.positionIds, parameters)})) OR
      ${fastRelatedCandidateFilter(alias, 'candidate_positions', 'position_id', search.positionIds, parameters)}
    )`)
  }
  if (search.talentPoolIds.length) {
    clauses.push(`(
      (${alias}.entity_type = 'talent_pool' AND ${alias}.entity_id IN (${inList(search.talentPoolIds, parameters)})) OR
      ${fastRelatedCandidateFilter(alias, 'candidate_talent_pools', 'talent_pool_id', search.talentPoolIds, parameters)}
    )`)
  }
  return clauses
}

function scopedDocumentFilters(search, alias, parameters) {
  const clauses = []
  if (search.sourceTables.length) {
    clauses.push(`${alias}.source_table IN (${inList(search.sourceTables, parameters)})`)
  }
  if (search.fieldPaths.length) {
    clauses.push(`${alias}.field_path IN (${inList(search.fieldPaths, parameters)})`)
  }
  if (search.fieldPathPrefixes.length) {
    clauses.push(`(${search.fieldPathPrefixes.map(() => `${alias}.field_path LIKE ? ESCAPE '!'`).join(' OR ')})`)
    parameters.push(...search.fieldPathPrefixes.map((prefix) => (
      `${prefix.replace(/[!%_]/g, (character) => `!${character}`)}%`
    )))
  }
  const effectivelyArchived = `(CASE
    WHEN ${alias}.candidate_id IS NOT NULL AND ${alias}.candidate_id <> '' THEN EXISTS (
      SELECT 1 FROM candidates archived_candidate
      WHERE archived_candidate.id = ${alias}.candidate_id AND archived_candidate.archived_at IS NOT NULL
    )
    ELSE ${alias}.archived_at IS NOT NULL
  END)`
  if (search.archived === 'exclude') clauses.push(`${effectivelyArchived} = 0`)
  if (search.archived === 'only') clauses.push(`${effectivelyArchived} = 1`)
  if (search.candidateIds.length) {
    clauses.push(fastCandidateScopeFilter(alias, search.candidateIds, parameters))
  }
  if (search.positionIds.length) {
    clauses.push(`(
      (${alias}.entity_type = 'position' AND ${alias}.entity_id IN (${inList(search.positionIds, parameters)})) OR
      ${fastRelatedCandidateFilter(alias, 'candidate_positions', 'position_id', search.positionIds, parameters)}
    )`)
  }
  if (search.talentPoolIds.length) {
    clauses.push(`(
      (${alias}.entity_type = 'talent_pool' AND ${alias}.entity_id IN (${inList(search.talentPoolIds, parameters)})) OR
      ${fastRelatedCandidateFilter(alias, 'candidate_talent_pools', 'talent_pool_id', search.talentPoolIds, parameters)}
    )`)
  }
  return clauses
}

function requireReady(db) {
  if (!isBusinessSearchAvailable(db)) fail('business_search_unavailable', 'Business search V8 is not migrated.', { status: 503 })
  if (!isBusinessSearchReady(db)) {
    fail('search_index_not_ready', 'Business search is not fully indexed yet.', {
      status: 503,
      details: getBusinessSearchStatus(db)
    })
  }
}

function displayScore(rawRank, conceptCount = 1) {
  const strength = Math.max(0, -Number(rawRank || 0))
  return Number((Math.log1p(strength * 1_000_000) * 10 + Number(conceptCount) * 5).toFixed(2))
}

function cjkEvidenceTerms(value) {
  const normalized = normalizedText(value)
  const terms = []
  let lastIndex = 0
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const latin = normalized.slice(lastIndex, match.index).trim()
    if (latin) terms.push(latin)
    const characters = Array.from(match[0])
    if (characters.length <= 2) terms.push(match[0])
    else {
      for (let index = 0; index <= characters.length - 3; index += 1) {
        terms.push(characters.slice(index, index + 3).join(''))
      }
    }
    lastIndex = Number(match.index) + match[0].length
  }
  const tail = normalized.slice(lastIndex).trim()
  if (tail) terms.push(tail)
  return [...new Set(terms)]
}

function foldedTextWithOffsets(value) {
  let text = ''
  const offsets = []
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)
    const character = String.fromCodePoint(codePoint)
    const end = index + character.length
    const folded = character.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    text += folded
    for (let offset = 0; offset < folded.length; offset += 1) offsets.push({ start: index, end })
    index = end
  }
  return { text, offsets }
}

function literalTermMatches(content, concepts) {
  const folded = foldedTextWithOffsets(content)
  const matches = []
  const seen = new Set()
  const isWordCharacter = (value) => Boolean(value && /[A-Za-z0-9]/.test(value))
  for (const concept of concepts) {
    const conceptLabel = String(concept.label ?? concept.terms[0] ?? '')
    for (const value of concept.terms) {
      const sourceTerm = String(value)
      const actualTerms = [sourceTerm, ...cjkEvidenceTerms(sourceTerm)]
      const normalizedSourceTerm = normalizedText(sourceTerm)
      const allowEmbeddedMatch = concept.terms.some((candidate) => (
        normalizedText(candidate).startsWith(normalizedSourceTerm) && normalizedText(candidate) !== normalizedSourceTerm
      ))
      for (const actualTerm of [...new Set(actualTerms)]) {
        const needle = foldedTextWithOffsets(actualTerm).text
        if (!needle) continue
        let offset = 0
        while (offset <= folded.text.length - needle.length) {
          const start = folded.text.indexOf(needle, offset)
          if (start < 0) break
          const end = start + needle.length
          const hasHan = /[\p{Script=Han}]/u.test(actualTerm)
          const boundaryBefore = start === 0 || !isWordCharacter(folded.text[start - 1])
          const boundaryAfter = end >= folded.text.length || !isWordCharacter(folded.text[end])
          if (hasHan || allowEmbeddedMatch || (boundaryBefore && boundaryAfter)) {
            const originalStart = folded.offsets[start]?.start ?? start
            const originalEnd = folded.offsets[end - 1]?.end ?? end
            const key = `${originalStart}\0${originalEnd}\0${conceptLabel}\0${actualTerm}`
            if (!seen.has(key)) {
              seen.add(key)
              matches.push({
                start: originalStart,
                end: originalEnd,
                concept_label: conceptLabel,
                actual_term: actualTerm,
                matched_text: content.slice(originalStart, originalEnd),
                expanded: normalizedText(actualTerm) !== normalizedText(conceptLabel)
              })
            }
          }
          offset = start + 1
        }
      }
    }
  }
  return matches.sort((left, right) => (
    left.start - right.start || right.end - left.end ||
    left.concept_label.localeCompare(right.concept_label) || left.actual_term.localeCompare(right.actual_term)
  ))
}

function mergeLiteralIntervals(matches) {
  const merged = []
  for (const match of matches) {
    const previous = merged.at(-1)
    if (previous && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end)
      previous.matches.push(match)
    } else {
      merged.push({ start: match.start, end: match.end, matches: [match] })
    }
  }
  return merged.map((interval) => ({
    start: interval.start,
    end: interval.end,
    term: interval.matches[0].concept_label,
    actual_term: interval.matches[0].actual_term,
    concept_labels: [...new Set(interval.matches.map((match) => match.concept_label))],
    actual_terms: [...new Set(interval.matches.map((match) => match.actual_term))],
    expanded: interval.matches.some((match) => match.expanded),
    matches: interval.matches
  }))
}

function snippetWindow(contentLength, matches, maximum) {
  if (!matches.length || contentLength <= maximum) return { start: 0, end: Math.min(contentLength, maximum) }
  const first = matches[0]
  const last = matches.at(-1)
  if (last.end - first.start <= maximum) {
    const padding = maximum - (last.end - first.start)
    const start = Math.max(0, Math.min(first.start - Math.floor(padding / 2), contentLength - maximum))
    return { start, end: Math.min(contentLength, start + maximum) }
  }

  let best = null
  let left = 0
  let right = 0
  const conceptCounts = new Map()
  for (const anchor of matches) {
    const start = Math.max(0, Math.min(anchor.start - Math.floor(maximum / 4), contentLength - maximum))
    const end = Math.min(contentLength, start + maximum)
    while (right < matches.length && matches[right].start < end) {
      const label = matches[right].concept_label
      conceptCounts.set(label, (conceptCounts.get(label) ?? 0) + 1)
      right += 1
    }
    while (left < right && matches[left].end <= start) {
      const label = matches[left].concept_label
      const next = conceptCounts.get(label) - 1
      if (next === 0) conceptCounts.delete(label)
      else conceptCounts.set(label, next)
      left += 1
    }
    const score = conceptCounts.size * 10_000 + (right - left)
    if (!best || score > best.score || (score === best.score && start < best.start)) {
      best = { start, end, score }
    }
  }
  return { start: best.start, end: best.end }
}

function evidenceSnippet(content, concepts, maximum = 360, matches = literalTermMatches(content, concepts)) {
  const { start, end } = snippetWindow(content.length, matches, maximum)
  const text = content.slice(start, end)
  const visibleMatches = matches
    .filter((match) => match.start < end && match.end > start)
    .map((match) => ({
      ...match,
      start: Math.max(start, match.start) - start,
      end: Math.min(end, match.end) - start
    }))
  return {
    text,
    start,
    end,
    truncated_before: start > 0,
    truncated_after: end < content.length,
    highlights: mergeLiteralIntervals(visibleMatches),
    literal_matches: visibleMatches,
    source_match_count: matches.length,
    omitted_match_count: matches.length - visibleMatches.length
  }
}

function mapEvidenceRow(row, concepts) {
  const literalMatches = literalTermMatches(row.content, concepts)
  const snippet = evidenceSnippet(row.content, concepts, 360, literalMatches)
  const matchedTerms = [...new Set(literalMatches.map((match) => match.concept_label))]
  const matchedActualTerms = [...new Set(literalMatches.map((match) => match.actual_term))]
  return {
    document_id: row.document_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    candidate_id: row.candidate_id ?? null,
    source_table: row.source_table,
    source_row_id: row.source_row_id,
    field_path: row.field_path,
    title: row.title,
    score: displayScore(row.bm25_rank),
    bm25_score: Number(row.bm25_rank),
    matched_terms: matchedTerms,
    matched_actual_terms: matchedActualTerms,
    has_expanded_matches: literalMatches.some((match) => match.expanded),
    segment: {
      index: Number(row.segment_index),
      count: Number(row.segment_count),
      char_start: Number(row.char_start),
      char_end: Number(row.char_end)
    },
    snippet
  }
}

export function buildAllRecordsPlans(input = {}) {
  const search = normalizeSearch(input)
  const expression = broadExpression(search)
  const hitLimit = fastHitLimit(search)
  if (hitLimit !== null) {
    const filterParameters = []
    // Apply every all-record scope to the FTS row before LIMIT. Direct
    // metadata filters stay index-local; relation and archive checks are
    // correlated to the current FTS row instead of materializing the global
    // candidate_documents mapping.
    const clauses = fastSourceFilters(search, 'd', filterParameters)
    const where = clauses.length ? `AND ${clauses.join(' AND ')}` : ''
    const pageParameters = [expression, ...filterParameters, hitLimit, search.pageSize + 1, (search.page - 1) * search.pageSize]
    // High-frequency all-record terms can match millions of FTS postings.
    // Bound the stable rowid posting window first, then rank only that small
    // sample. Exact requests retain the complete BM25 ordering below.
    return {
      search,
      expression,
      page: {
        sql: `
          WITH raw_document_hits AS MATERIALIZED (
            SELECT d.entity_type, d.entity_id, f.rowid AS row_id, f.rank AS bm25_rank
            FROM ${SEARCH_FTS_TABLE} f
            JOIN ${SEARCH_DOCUMENTS_TABLE} d ON d.row_id = f.rowid
            WHERE ${SEARCH_FTS_TABLE} MATCH ?
              AND f.rank MATCH '${FTS_RANK_CONFIGURATION}'
              ${where}
            ORDER BY f.rowid ASC
            LIMIT ?
          ),
          document_hits AS (
            SELECT entity_type, entity_id, MIN(bm25_rank) AS bm25_rank
            FROM raw_document_hits
            GROUP BY entity_type, entity_id
          ),
          bounded_stats AS (
            SELECT
              (SELECT COUNT(*) FROM raw_document_hits) AS raw_hit_count,
              (SELECT COUNT(*) FROM document_hits) AS bounded_entity_count
          )
          SELECT entity_type, entity_id, bm25_rank,
            bounded_stats.raw_hit_count,
            bounded_stats.bounded_entity_count
          FROM document_hits
          CROSS JOIN bounded_stats
          ORDER BY bm25_rank ASC, entity_type ASC, entity_id ASC
          LIMIT ? OFFSET ?
        `,
        parameters: pageParameters
      }
    }
  }

  const pageParameters = [expression]
  const clauses = sourceFilters(search, 'd', pageParameters)
  const where = clauses.length ? `AND ${clauses.join(' AND ')}` : ''
  // Fast read-only callers fetch one sentinel row instead of calculating an
  // exact total for every matching entity. The direct UI path keeps the
  // historical exact-total behavior by leaving include_total at its default.
  pageParameters.push(
    search.includeTotal ? search.pageSize : search.pageSize + 1,
    (search.page - 1) * search.pageSize
  )
  const totalColumn = search.includeTotal ? ', COUNT(*) OVER () AS total' : ''
  const page = {
    sql: `
      WITH ${candidateDocumentCte()},
      raw_document_hits AS (
        SELECT d.entity_type, d.entity_id, ${SEARCH_FTS_TABLE}.rank AS bm25_rank
        FROM ${SEARCH_FTS_TABLE}
        JOIN ${SEARCH_DOCUMENTS_TABLE} d ON d.row_id = ${SEARCH_FTS_TABLE}.rowid
        WHERE ${SEARCH_FTS_TABLE} MATCH ? ${where}
          AND ${SEARCH_FTS_TABLE}.rank MATCH '${FTS_RANK_CONFIGURATION}'
        ${hitLimit === null ? '' : 'ORDER BY bm25_rank ASC, d.row_id ASC LIMIT ?'}
      ),
      document_hits AS (
        SELECT entity_type, entity_id, MIN(bm25_rank) AS bm25_rank
        FROM raw_document_hits
        GROUP BY entity_type, entity_id
      )
      SELECT entity_type, entity_id, bm25_rank${totalColumn}
      FROM document_hits
      ORDER BY bm25_rank ASC, entity_type ASC, entity_id ASC
      LIMIT ? OFFSET ?
    `,
    parameters: pageParameters
  }
  return { search, expression, page }
}

export function buildAllRecordEvidencePlan(search, expression, entities) {
  if (!entities.length) return null
  const pairClauses = entities.map(() => '(d.entity_type = ? AND d.entity_id = ?)').join(' OR ')
  const entityParameters = entities.flatMap((entity) => [entity.entity_type, entity.entity_id])
  const filterParameters = []
  const clauses = scopedDocumentFilters(search, 'd', filterParameters)
  const where = clauses.length ? `AND ${clauses.join(' AND ')}` : ''
  const pageHitLimit = fastHitLimit(search)
  if (pageHitLimit !== null) {
    const hitFilterParameters = []
    const hitClauses = fastSourceFilters(search, 'hit_document', hitFilterParameters)
    const hitWhere = hitClauses.length ? `AND ${hitClauses.join(' AND ')}` : ''
    const evidenceHitLimit = Math.min(20_000, pageHitLimit * 4)
    return {
      sql: `
        WITH scoped_entity_documents AS MATERIALIZED (
          SELECT d.row_id, d.entity_type, d.entity_id, d.document_id
          FROM ${SEARCH_DOCUMENTS_TABLE} d
          WHERE ${pairClauses}
            ${where}
        ),
        bounded_fts_hits AS MATERIALIZED (
          SELECT f.rowid AS row_id, f.rank AS bm25_rank
          FROM ${SEARCH_FTS_TABLE} f
          JOIN ${SEARCH_DOCUMENTS_TABLE} hit_document ON hit_document.row_id = f.rowid
          WHERE ${SEARCH_FTS_TABLE} MATCH ?
            AND f.rank MATCH '${FTS_RANK_CONFIGURATION}'
            ${hitWhere}
          ORDER BY f.rowid ASC
          LIMIT ?
        ),
        ranked AS (
          SELECT scoped.entity_type, scoped.entity_id, scoped.document_id,
            hits.row_id, hits.bm25_rank,
            ROW_NUMBER() OVER (
              PARTITION BY scoped.entity_type, scoped.entity_id
              ORDER BY hits.bm25_rank ASC, scoped.document_id ASC, hits.row_id ASC
            ) AS evidence_rank
          FROM bounded_fts_hits hits
          JOIN scoped_entity_documents scoped ON scoped.row_id = hits.row_id
        )
        SELECT ranked.entity_type, ranked.entity_id,
          ranked.bm25_rank, ranked.evidence_rank,
          d.document_id, d.title, d.content,
          d.candidate_id, d.source_table, d.source_row_id, d.field_path,
          d.segment_index, d.segment_count, d.char_start, d.char_end
        FROM ranked
        JOIN ${SEARCH_DOCUMENTS_TABLE} d ON d.row_id = ranked.row_id
        WHERE ranked.evidence_rank <= ?
        ORDER BY ranked.entity_type, ranked.entity_id, ranked.evidence_rank
      `,
      parameters: [
        ...entityParameters,
        ...filterParameters,
        expression,
        ...hitFilterParameters,
        evidenceHitLimit,
        search.evidenceLimit
      ]
    }
  }
  const parameters = [...entityParameters, ...filterParameters]
  const conceptCtes = []
  const conceptHits = search.concepts.map((concept, index) => {
    const hitName = `all_record_concept_${index}_fts_hits`
    const documentHitName = `all_record_concept_${index}_hits`
    parameters.push(conceptExpression(concept))
    conceptCtes.push(`
      ${hitName} AS MATERIALIZED (
        SELECT ${SEARCH_FTS_TABLE}.rowid AS row_id, ${SEARCH_FTS_TABLE}.rank AS bm25_rank
        FROM ${SEARCH_FTS_TABLE}
        WHERE ${SEARCH_FTS_TABLE} MATCH ?
          AND ${SEARCH_FTS_TABLE}.rank MATCH '${FTS_RANK_CONFIGURATION}'
          AND ${SEARCH_FTS_TABLE}.rowid IN (SELECT row_id FROM scoped_entity_documents)
      ),
      ${documentHitName} AS (
        SELECT scoped.entity_type, scoped.entity_id, scoped.document_id,
          hits.row_id, hits.bm25_rank,
          ${index} AS concept_index
        FROM ${hitName} hits
        JOIN scoped_entity_documents scoped ON scoped.row_id = hits.row_id
      )`)
    return `SELECT entity_type, entity_id, document_id, row_id, bm25_rank, concept_index FROM ${documentHitName}`
  })
  parameters.push(search.evidenceLimit)
  return {
    sql: `
      WITH scoped_entity_documents AS MATERIALIZED (
        SELECT d.row_id, d.entity_type, d.entity_id, d.document_id
        FROM ${SEARCH_DOCUMENTS_TABLE} d
        WHERE ${pairClauses}
          ${where}
      ),
      ${conceptCtes.join(',\n')},
      concept_document_hits AS (
        ${conceptHits.join('\n        UNION ALL\n        ')}
      ),
      ranked_concept_hits AS (
        SELECT concept_document_hits.*,
          ROW_NUMBER() OVER (
            PARTITION BY entity_type, entity_id
            , concept_index
            ORDER BY bm25_rank ASC, document_id ASC, row_id ASC
          ) AS evidence_rank
        FROM concept_document_hits
      ),
      document_priority AS (
        SELECT entity_type, entity_id, document_id, row_id,
          MIN(bm25_rank) AS bm25_rank,
          MIN(evidence_rank) AS best_concept_rank
        FROM ranked_concept_hits
        GROUP BY entity_type, entity_id, document_id, row_id
      ),
      ranked AS (
        SELECT document_priority.*,
          ROW_NUMBER() OVER (
            PARTITION BY entity_type, entity_id
            ORDER BY
              CASE WHEN best_concept_rank = 1 THEN 0 ELSE 1 END,
              best_concept_rank ASC,
              bm25_rank ASC,
              document_id ASC,
              row_id ASC
          ) AS entity_evidence_rank
        FROM document_priority
      )
      SELECT ranked.entity_type, ranked.entity_id,
        ranked.bm25_rank, ranked.entity_evidence_rank AS evidence_rank,
        d.document_id, d.title, d.content,
        d.candidate_id, d.source_table, d.source_row_id, d.field_path,
        d.segment_index, d.segment_count, d.char_start, d.char_end
      FROM ranked
      JOIN ${SEARCH_DOCUMENTS_TABLE} d ON d.row_id = ranked.row_id
      WHERE ranked.entity_evidence_rank <= ?
      ORDER BY ranked.entity_type, ranked.entity_id, ranked.entity_evidence_rank
    `,
    parameters
  }
}

export function mapAllRecordResults(search, rows, evidenceRows, totalOverride, hasMoreOverride) {
  const evidenceByEntity = new Map()
  for (const row of evidenceRows) {
    const key = `${row.entity_type}\0${row.entity_id}`
    const list = evidenceByEntity.get(key) ?? []
    list.push(mapEvidenceRow(row, search.concepts))
    evidenceByEntity.set(key, list)
  }
  const visibleRows = rows.slice(0, search.pageSize)
  const total = search.includeTotal
    ? Number(totalOverride ?? rows[0]?.total ?? 0)
    : null
  const hasMore = hasMoreOverride !== undefined
    ? Boolean(hasMoreOverride)
    : rows.length > search.pageSize
      || (search.fast && visibleRows.length >= search.pageSize)
      || (total !== null && total > search.page * search.pageSize)
  return {
    items: visibleRows.map((row) => {
      const evidence = evidenceByEntity.get(`${row.entity_type}\0${row.entity_id}`) ?? []
      return {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        score: displayScore(row.bm25_rank),
        bm25_score: Number(row.bm25_rank),
        matched_terms: [...new Set(evidence.flatMap((item) => item.matched_terms))],
        evidence,
        segments: evidence.map((item) => item.segment)
      }
    }),
    pagination: {
      page: search.page,
      page_size: search.pageSize,
      total,
      total_pages: total === null ? null : Math.ceil(total / search.pageSize),
      has_more: hasMore
    },
    query: {
      concepts: search.concepts,
      match_mode: search.matchMode,
      filters: {
        archived: search.archived,
        entity_types: search.entityTypes,
        source_tables: search.sourceTables,
        field_paths: search.fieldPaths,
        field_path_prefixes: search.fieldPathPrefixes,
        candidate_ids: search.candidateIds,
        position_ids: search.positionIds,
        talent_pool_ids: search.talentPoolIds
      }
    },
    context: {
      entity_limit: search.pageSize,
      evidence_per_entity: search.evidenceLimit,
      database_scope: 'all_matching_business_records',
      search_index: 'business_v2'
    }
  }
}

export function searchAllRecords(db, input = {}) {
  requireReady(db)
  const plans = buildAllRecordsPlans(input)
  let { search, expression, page } = plans
  let rows = db.prepare(page.sql).all(...page.parameters)
  if (fastRowsNeedExactFallback(search, rows)) {
    const exactPlans = buildAllRecordsPlans(exactSearchInput(input))
    page = exactPlans.page
    rows = db.prepare(page.sql).all(...page.parameters)
    search = exactPlans.search
    expression = exactPlans.expression
  }
  const visibleRows = rows.slice(0, search.pageSize)
  const evidencePlan = buildAllRecordEvidencePlan(search, expression, visibleRows)
  const evidenceRows = evidencePlan ? db.prepare(evidencePlan.sql).all(...evidencePlan.parameters) : []
  return mapAllRecordResults(search, rows, evidenceRows)
}

function fastRowsNeedExactFallback(search, rows) {
  if (!search.fast) return false
  const limit = fastHitLimit(search)
  if (limit === null) return false
  // Empty later pages have no bounded-stat row. Re-run the exact plan so a
  // fixed Top-K window can never silently turn a valid page into an empty one.
  if (!rows.length && search.page > 1) return true
  const rawHitCount = Number(rows[0]?.raw_hit_count)
  const boundedEntityCount = Number(rows[0]?.bounded_entity_count)
  if (!Number.isFinite(rawHitCount) || !Number.isFinite(boundedEntityCount)) return false
  const targetEntities = (search.page - 1) * search.pageSize + search.pageSize + 1
  return rawHitCount >= limit && boundedEntityCount < targetEntities
}

function exactSearchInput(input) {
  const {
    fast: _fast,
    include_total: includeTotalSnake,
    includeTotal: includeTotalCamel,
    ...rest
  } = input
  // A fast query is explicitly a no-total request unless the caller supplied
  // an include_total spelling.  Keep that response contract when the bounded
  // Top-K probe falls back to the exact plan for filtering or deep paging.
  if (includeTotalSnake !== undefined) return { ...rest, include_total: includeTotalSnake, fast: false }
  if (includeTotalCamel !== undefined) return { ...rest, includeTotal: includeTotalCamel, fast: false }
  return { ...rest, include_total: false, fast: false }
}

export async function searchAllRecordsReadonly(readonlyService, input = {}) {
  if (!readonlyService || typeof readonlyService.executeReadonlyQuery !== 'function') {
    fail('invalid_database', 'A valid isolated read-only query service is required.', { status: 500 })
  }
  const readonlyInput = { ...input }
  if (
    readonlyInput.include_total === undefined
    && readonlyInput.includeTotal === undefined
    && readonlyInput.fast === undefined
  ) {
    readonlyInput.include_total = false
  }
  try {
    let plans = buildAllRecordsPlans(readonlyInput)
    const clampEvidenceLimit = () => {
      plans.search.evidenceLimit = Math.min(
        plans.search.evidenceLimit,
        Math.max(1, Math.floor(100 / plans.search.pageSize))
      )
    }
    clampEvidenceLimit()
    let pageResult = await readonlyService.executeReadonlyQuery({
      ...plans.page,
      maxRows: Math.min(100, plans.search.pageSize + 1),
      maxBytes: 400_000,
      tool: 'search_all_records'
    })
    let rawRows = pageResult.rows
    if (fastRowsNeedExactFallback(plans.search, rawRows)) {
      plans = buildAllRecordsPlans(exactSearchInput(input))
      clampEvidenceLimit()
      pageResult = await readonlyService.executeReadonlyQuery({
        ...plans.page,
        maxRows: Math.min(100, plans.search.pageSize + 1),
        maxBytes: 400_000,
        tool: 'search_all_records_exact'
      })
      rawRows = pageResult.rows
    }
    const rows = rawRows.slice(0, plans.search.pageSize)
    let total = plans.search.includeTotal ? Number(rawRows[0]?.total ?? 0) : null
    if (plans.search.includeTotal && !rows.length && plans.search.page > 1) {
      const firstPage = buildAllRecordsPlans({ ...input, page: 1, page_size: 1 }).page
      const countResult = await readonlyService.executeReadonlyQuery({
        ...firstPage,
        maxRows: 1,
        maxBytes: 32_768,
        tool: 'search_all_records_count'
      })
      total = Number(countResult.rows[0]?.total ?? 0)
    }
    const evidencePlan = buildAllRecordEvidencePlan(plans.search, plans.expression, rows)
    const evidenceResult = evidencePlan
      ? (await readonlyService.executeReadonlyQuery({
          ...evidencePlan,
          maxRows: Math.min(100, plans.search.pageSize * plans.search.evidenceLimit),
          maxBytes: 500_000,
          tool: 'search_all_records_evidence'
        }))
      : { rows: [], worker_peak_rss_bytes: 0 }
    const evidenceRows = evidenceResult.rows
    const mapped = mapAllRecordResults(
      plans.search,
      rows,
      evidenceRows,
      total,
      Boolean(
        pageResult.has_more
        || rawRows.length > plans.search.pageSize
        || (plans.search.fast && rows.length >= plans.search.pageSize)
        || (plans.search.includeTotal && total > plans.search.page * plans.search.pageSize)
      )
    )
    return {
      ...mapped,
      performance: {
        worker_peak_rss_bytes: Math.max(
          Number(pageResult.worker_peak_rss_bytes) || 0,
          Number(evidenceResult.worker_peak_rss_bytes) || 0
        )
      }
    }
  } catch (error) {
    if (error instanceof BusinessSearchError) throw error
    if (/no such (?:table|module):\s*(?:search_documents_v2(?:_fts)?|fts5)/i.test(String(error?.message ?? ''))) {
      fail('fts5_unavailable', 'The full-field FTS5 index is unavailable.', { status: 503, cause: error })
    }
    throw error
  }
}

function candidateDocumentCte() {
  return `
    candidate_documents AS (
      SELECT d.row_id, d.candidate_id FROM ${SEARCH_DOCUMENTS_TABLE} d
      WHERE d.candidate_id IS NOT NULL AND d.candidate_id <> ''
      UNION
      SELECT d.row_id, cp.candidate_id
      FROM ${SEARCH_DOCUMENTS_TABLE} d
      JOIN candidate_positions cp ON d.entity_type = 'position' AND cp.position_id = d.entity_id
      UNION
      SELECT d.row_id, ctp.candidate_id
      FROM ${SEARCH_DOCUMENTS_TABLE} d
      JOIN candidate_talent_pools ctp ON d.entity_type = 'talent_pool' AND ctp.talent_pool_id = d.entity_id
      UNION
      SELECT d.row_id, c.id
      FROM ${SEARCH_DOCUMENTS_TABLE} d
      JOIN candidates c ON d.entity_type = 'stage' AND c.stage = d.entity_id
      UNION
      SELECT d.row_id, c.id
      FROM ${SEARCH_DOCUMENTS_TABLE} d
      JOIN candidates c ON d.entity_type = 'import_batch' AND c.import_batch_id = d.entity_id
    )`
}

function scopedCandidateDocumentCte(candidateIds) {
  const placeholders = candidateIds.map(() => '?').join(', ')
  return `
    candidate_documents AS (
      SELECT d.row_id, d.candidate_id FROM ${SEARCH_DOCUMENTS_TABLE} d
      WHERE d.candidate_id IN (${placeholders})
      UNION
      SELECT d.row_id, cp.candidate_id
      FROM candidate_positions cp
      JOIN ${SEARCH_DOCUMENTS_TABLE} d
        ON d.entity_type = 'position' AND d.entity_id = cp.position_id
      WHERE cp.candidate_id IN (${placeholders})
      UNION
      SELECT d.row_id, ctp.candidate_id
      FROM candidate_talent_pools ctp
      JOIN ${SEARCH_DOCUMENTS_TABLE} d
        ON d.entity_type = 'talent_pool' AND d.entity_id = ctp.talent_pool_id
      WHERE ctp.candidate_id IN (${placeholders})
      UNION
      SELECT d.row_id, c.id
      FROM candidates c
      JOIN ${SEARCH_DOCUMENTS_TABLE} d
        ON d.entity_type = 'stage' AND d.entity_id = c.stage
      WHERE c.id IN (${placeholders})
      UNION
      SELECT d.row_id, c.id
      FROM candidates c
      JOIN ${SEARCH_DOCUMENTS_TABLE} d
        ON d.entity_type = 'import_batch' AND d.entity_id = c.import_batch_id
      WHERE c.id IN (${placeholders})
    )`
}

function candidateFilterSql(search, parameters) {
  const clauses = []
  if (search.archived === 'exclude') clauses.push('c.archived_at IS NULL')
  if (search.archived === 'only') clauses.push('c.archived_at IS NOT NULL')
  if (search.location) {
    clauses.push("lower(coalesce(c.location, '')) LIKE lower(?) ESCAPE '!'")
    parameters.push(`%${String(search.location).replace(/[!%_]/g, (character) => `!${character}`)}%`)
  }
  if (search.min_years !== undefined) {
    clauses.push('c.years_experience >= ?')
    parameters.push(search.min_years)
  }
  if (search.max_years !== undefined) {
    clauses.push('c.years_experience <= ?')
    parameters.push(search.max_years)
  }
  if (search.stage) {
    clauses.push('c.stage = ?')
    parameters.push(search.stage)
  }
  if (search.position_id) {
    clauses.push('EXISTS (SELECT 1 FROM candidate_positions cp WHERE cp.candidate_id = c.id AND cp.position_id = ?)')
    parameters.push(search.position_id)
  }
  if (search.talent_pool_id) {
    clauses.push('EXISTS (SELECT 1 FROM candidate_talent_pools ctp WHERE ctp.candidate_id = c.id AND ctp.talent_pool_id = ?)')
    parameters.push(search.talent_pool_id)
  }
  if (Array.isArray(search.candidate_ids) && search.candidate_ids.length) {
    clauses.push(`c.id IN (${search.candidate_ids.map(() => '?').join(', ')})`)
    parameters.push(...search.candidate_ids)
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

function v2SourceTables(search) {
  const map = {
    candidate: 'candidates',
    profile_section: 'candidate_profile_sections',
    attachment: 'candidate_attachments'
  }
  return (search.source_types ?? []).map((value) => map[value]).filter(Boolean)
}

function candidateSearchFingerprint(search) {
  return createHash('sha256').update(JSON.stringify({
    concepts: search.concepts.map((concept) => ({
      label: String(concept.label ?? ''),
      terms: [...concept.terms].map((term) => normalizedText(String(term)))
    })),
    match_mode: search.match_mode,
    archived: search.archived,
    location: search.location ?? null,
    min_years: search.min_years ?? null,
    max_years: search.max_years ?? null,
    stage: search.stage ?? null,
    position_id: search.position_id ?? null,
    talent_pool_id: search.talent_pool_id ?? null,
    candidate_ids: [...(search.candidate_ids ?? [])],
    source_types: [...(search.source_types ?? [])],
    fast: Boolean(search.fast),
    include_total: Boolean(search.include_total)
  })).digest('hex')
}

function decodeCandidateCursor(value, search) {
  if (!value) return null
  if (
    typeof value !== 'string' || value.length > CANDIDATE_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    fail('invalid_cursor', 'The candidate search cursor is invalid.')
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    fail('invalid_cursor', 'The candidate search cursor is invalid.')
  }
  if (
    parsed?.v !== CANDIDATE_CURSOR_VERSION ||
    parsed.q !== candidateSearchFingerprint(search) ||
    !Number.isSafeInteger(parsed.p) || parsed.p < 1 || parsed.p > 10_000 ||
    !Number.isSafeInteger(parsed.cc) || parsed.cc < 1 ||
    !Number.isFinite(parsed.r) ||
    typeof parsed.u !== 'string' || !parsed.u || parsed.u.length > 100 ||
    typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 200
  ) {
    fail('invalid_cursor', 'The candidate search cursor does not match this query.')
  }
  return parsed
}

function encodeCandidateCursor(search, row, page) {
  if (!row || !Number.isFinite(Number(row.bm25_rank))) return null
  return Buffer.from(JSON.stringify({
    v: CANDIDATE_CURSOR_VERSION,
    q: candidateSearchFingerprint(search),
    p: page,
    cc: Number(row.concept_count),
    r: Number(row.bm25_rank),
    u: String(row.sort_updated_at),
    id: String(row.candidate_id)
  }), 'utf8').toString('base64url')
}

function candidateCursorFilter(cursor, parameters) {
  if (!cursor) return ''
  parameters.push(
    cursor.cc,
    cursor.cc, cursor.r,
    cursor.cc, cursor.r, cursor.u,
    cursor.cc, cursor.r, cursor.u, cursor.id
  )
  return `(
    cm.concept_count < ? OR
    (cm.concept_count = ? AND cm.bm25_rank > ?) OR
    (cm.concept_count = ? AND cm.bm25_rank = ? AND c.updated_at < ?) OR
    (cm.concept_count = ? AND cm.bm25_rank = ? AND c.updated_at = ? AND c.id > ?)
  )`
}

export function buildBusinessCandidatePlans(normalizedSearch) {
  const search = {
    ...normalizedSearch,
    page: boundedInteger(normalizedSearch.page, 1, 1, 10_000, 'page'),
    page_size: boundedInteger(normalizedSearch.page_size, 20, 1, BUSINESS_SEARCH_MAX_PAGE_SIZE, 'page_size'),
    evidence_limit: boundedInteger(normalizedSearch.evidence_limit, 3, 1, BUSINESS_SEARCH_MAX_EVIDENCE, 'evidence_limit'),
    include_total: normalizedSearch.include_total !== false
  }
  if (!Array.isArray(search.concepts) || !search.concepts.length || search.concepts.length > BUSINESS_SEARCH_MAX_CONCEPTS) {
    fail('invalid_query', 'Candidate search concepts are invalid.')
  }
  if (search.cursor && search.include_total) {
    fail('invalid_cursor', 'Cursor pagination requires include_total=false.')
  }
  const parameters = []
  const hitLimit = candidateFastHitLimit(search)
  const sourceTables = v2SourceTables(search)
  const sourceClause = sourceTables.length
    ? ` AND indexed_document.source_table IN (${sourceTables.map(() => '?').join(', ')})`
    : ''
  // The compact FTS stores postings only. Ownership metadata is joined by the
  // integer row id before applying source and relationship scopes.
  const conceptCtes = []
  const selects = search.concepts.map((concept, index) => {
    const hitName = `concept_${index}_hits`
    const mappedName = `concept_${index}_documents`
    parameters.push(conceptExpression(concept), ...sourceTables)
    if (hitLimit !== null) parameters.push(hitLimit)
    conceptCtes.push(`
      ${hitName} AS MATERIALIZED (
        SELECT f.rowid AS row_id, f.rank AS bm25_rank,
          indexed_document.entity_type, indexed_document.entity_id,
          indexed_document.candidate_id
        FROM ${SEARCH_FTS_TABLE} f
        JOIN ${SEARCH_DOCUMENTS_TABLE} indexed_document ON indexed_document.row_id = f.rowid
        WHERE ${SEARCH_FTS_TABLE} MATCH ?${sourceClause}
          AND f.rank MATCH '${FTS_RANK_CONFIGURATION}'
        ${hitLimit === null ? '' : 'ORDER BY f.rowid ASC LIMIT ?'}
      ),
      ${mappedName} AS (
        SELECT h.row_id, h.candidate_id, h.bm25_rank
        FROM ${hitName} h
        WHERE h.candidate_id IS NOT NULL AND h.candidate_id <> ''
        UNION ALL
        SELECT h.row_id, cp.candidate_id, h.bm25_rank
        FROM ${hitName} h
        JOIN candidate_positions cp
          ON h.entity_type = 'position' AND cp.position_id = h.entity_id
        UNION ALL
        SELECT h.row_id, ctp.candidate_id, h.bm25_rank
        FROM ${hitName} h
        JOIN candidate_talent_pools ctp
          ON h.entity_type = 'talent_pool' AND ctp.talent_pool_id = h.entity_id
        UNION ALL
        SELECT h.row_id, c.id, h.bm25_rank
        FROM ${hitName} h
        JOIN candidates c ON h.entity_type = 'stage' AND c.stage = h.entity_id
        UNION ALL
        SELECT h.row_id, c.id, h.bm25_rank
        FROM ${hitName} h
        JOIN candidates c ON h.entity_type = 'import_batch' AND c.import_batch_id = h.entity_id
      )`)
    return `
      SELECT mapped.candidate_id, ${index} AS concept_index,
        MIN(mapped.bm25_rank) AS concept_rank
      FROM ${mappedName} mapped
      GROUP BY mapped.candidate_id`
  })
  const requiredConcepts = search.match_mode === 'all' ? search.concepts.length : 1
  const ctes = `
    ${conceptCtes.join(',\n')},
    concept_hits AS (${selects.join('\nUNION ALL\n')}),
    candidate_matches AS (
      SELECT candidate_id, SUM(concept_rank) AS bm25_rank,
        COUNT(DISTINCT concept_index) AS concept_count,
        GROUP_CONCAT(concept_index) AS matched_concepts
      FROM concept_hits
      GROUP BY candidate_id
      HAVING COUNT(DISTINCT concept_index) >= ${requiredConcepts}
    )`
  const filters = candidateFilterSql(search, parameters)
  const cursor = decodeCandidateCursor(search.cursor, search)
  const cursorFilter = candidateCursorFilter(cursor, parameters)
  const where = cursorFilter
    ? filters ? `${filters} AND ${cursorFilter}` : `WHERE ${cursorFilter}`
    : filters
  parameters.push(search.include_total ? search.page_size : search.page_size + 1)
  if (!cursor) parameters.push((search.page - 1) * search.page_size)
  const totalColumn = search.include_total ? ', COUNT(*) OVER () AS total' : ''
  search.result_page = cursor ? cursor.p + 1 : search.page
  return {
    search,
    page: {
      sql: `
        WITH ${ctes}
        SELECT cm.candidate_id, c.name, cm.bm25_rank, cm.concept_count,
          cm.matched_concepts, c.updated_at AS sort_updated_at${totalColumn}
        FROM candidate_matches cm
        JOIN candidates c ON c.id = cm.candidate_id
        ${where}
        ORDER BY cm.concept_count DESC, cm.bm25_rank ASC, c.updated_at DESC, c.id ASC
        LIMIT ?${cursor ? '' : ' OFFSET ?'}
      `,
      parameters
    }
  }
}

export function buildBusinessCandidateEvidencePlan(search, candidateIds) {
  if (!candidateIds.length) return null
  const sourceTables = v2SourceTables(search)
  const sourceClause = sourceTables.length
    ? ` AND d.source_table IN (${sourceTables.map(() => '?').join(', ')})`
    : ''
  const evidenceHitLimit = fastEvidenceHitLimit(search)
  const scopedCandidateParameters = Array.from({ length: 5 }, () => candidateIds).flat()
  const parameters = [...scopedCandidateParameters, ...sourceTables]
  const conceptCtes = []
  const conceptHits = search.concepts.map((concept, index) => {
    const hitName = `candidate_concept_${index}_fts_hits`
    const documentHitName = `candidate_concept_${index}_hits`
    parameters.push(conceptExpression(concept))
    if (evidenceHitLimit !== null) parameters.push(...sourceTables, evidenceHitLimit)
    const hitScope = evidenceHitLimit === null
      ? `
          AND ${SEARCH_FTS_TABLE}.rowid IN (SELECT row_id FROM scoped_candidate_documents)`
      : `
          ${sourceTables.length ? `AND indexed_document.source_table IN (${sourceTables.map(() => '?').join(', ')})` : ''}
          LIMIT ?`
    conceptCtes.push(`
      ${hitName} AS MATERIALIZED (
        SELECT ${SEARCH_FTS_TABLE}.rowid AS row_id, ${SEARCH_FTS_TABLE}.rank AS bm25_rank
        FROM ${SEARCH_FTS_TABLE}
        JOIN ${SEARCH_DOCUMENTS_TABLE} indexed_document
          ON indexed_document.row_id = ${SEARCH_FTS_TABLE}.rowid
        WHERE ${SEARCH_FTS_TABLE} MATCH ?
          AND ${SEARCH_FTS_TABLE}.rank MATCH '${FTS_RANK_CONFIGURATION}'
          ${hitScope}
      ),
      ${documentHitName} AS (
        SELECT scoped.candidate_id AS mapped_candidate_id, scoped.document_id,
          hits.row_id, hits.bm25_rank, ${index} AS concept_index
        FROM ${hitName} hits
        JOIN scoped_candidate_documents scoped ON scoped.row_id = hits.row_id
      )`)
    return `SELECT mapped_candidate_id, document_id, ${index} AS concept_index, row_id, bm25_rank FROM ${documentHitName}`
  })
  parameters.push(search.evidence_limit)
  return {
    sql: `
      WITH ${scopedCandidateDocumentCte(candidateIds)},
      scoped_candidate_documents AS MATERIALIZED (
        SELECT cd.row_id, cd.candidate_id, d.document_id
        FROM candidate_documents cd
        JOIN ${SEARCH_DOCUMENTS_TABLE} d ON d.row_id = cd.row_id
        WHERE 1 = 1${sourceClause}
      ),
      ${conceptCtes.join(',\n')},
      concept_document_hits AS (
        ${conceptHits.join('\n        UNION ALL\n        ')}
      ),
      ranked_concept_hits AS (
        SELECT concept_document_hits.*,
          ROW_NUMBER() OVER (
            PARTITION BY mapped_candidate_id, concept_index
            ORDER BY bm25_rank, document_id, row_id
          ) AS concept_rank
        FROM concept_document_hits
      ),
      document_priority AS (
        SELECT mapped_candidate_id, document_id, row_id,
          MIN(bm25_rank) AS bm25_rank,
          MIN(concept_rank) AS best_concept_rank
        FROM ranked_concept_hits
        GROUP BY mapped_candidate_id, document_id, row_id
      ),
      ranked AS (
        SELECT document_priority.mapped_candidate_id, document_priority.row_id,
          document_priority.bm25_rank,
          ROW_NUMBER() OVER (
            PARTITION BY mapped_candidate_id
            ORDER BY
              CASE WHEN document_priority.best_concept_rank = 1 THEN 0 ELSE 1 END,
              document_priority.best_concept_rank,
              document_priority.bm25_rank,
              document_priority.document_id,
              document_priority.row_id
          ) AS evidence_rank
        FROM document_priority
      )
      SELECT ranked.mapped_candidate_id, ranked.bm25_rank, ranked.evidence_rank,
        d.document_id, d.entity_type, d.entity_id, d.candidate_id,
        d.source_table, d.source_row_id, d.field_path, d.title, d.content,
        d.segment_index, d.segment_count, d.char_start, d.char_end
      FROM ranked
      JOIN ${SEARCH_DOCUMENTS_TABLE} d ON d.row_id = ranked.row_id
      WHERE ranked.evidence_rank <= ?
      ORDER BY ranked.mapped_candidate_id, ranked.evidence_rank
    `,
    parameters
  }
}

function fieldLabel(sourceTable) {
  return ({
    candidates: '候选人主档',
    candidate_profile_sections: '履历区块',
    candidate_attachments: '附件简历',
    notes: '候选人备注',
    activities: '候选人活动',
    candidate_preferences: '求职偏好',
    candidate_source_records: '候选人来源',
    candidate_assessments: '历史评估',
    candidate_consents: '授权记录',
    candidate_position_sources: '申请来源',
    positions: '关联职位',
    talent_pools: '关联人才库'
  })[sourceTable] ?? sourceTable
}

export function mapBusinessCandidateResults(search, rows, evidenceRows) {
  const evidenceByCandidate = new Map()
  for (const row of evidenceRows) {
    const list = evidenceByCandidate.get(row.mapped_candidate_id) ?? []
    list.push(mapEvidenceRow({ ...row, candidate_id: row.mapped_candidate_id }, search.concepts))
    evidenceByCandidate.set(row.mapped_candidate_id, list)
  }
  return rows.map((row) => {
    const evidence = evidenceByCandidate.get(row.candidate_id) ?? []
    const matchedFields = [...new Set(evidence.map((item) => fieldLabel(item.source_table)))]
    const matchedTerms = [...new Set(evidence.flatMap((item) => item.matched_terms))]
    return {
      candidate_id: row.candidate_id,
      name: row.name,
      score: displayScore(row.bm25_rank, row.concept_count),
      bm25_score: Number(row.bm25_rank),
      matched_fields: matchedFields,
      matched_terms: matchedTerms,
      evidence,
      segments: evidence.map((item) => item.segment),
      snippets: evidence.map((item) => item.snippet.text),
      reasons: [
        ...matchedTerms.map((term) => `命中关键词：${term}`),
        ...matchedFields.map((field) => `证据来源：${field}`)
      ]
    }
  })
}

export function searchBusinessCandidates(db, normalizedSearch) {
  const searchStarted = performance.now()
  requireReady(db)
  const planningStarted = performance.now()
  const plans = buildBusinessCandidatePlans(normalizedSearch)
  const planningMs = performance.now() - planningStarted
  const pageStarted = performance.now()
  const rows = db.prepare(plans.page.sql).all(...plans.page.parameters)
  const pageMs = performance.now() - pageStarted
  const visibleRows = rows.slice(0, plans.search.page_size)
  const evidencePlan = buildBusinessCandidateEvidencePlan(plans.search, visibleRows.map((row) => row.candidate_id))
  const evidenceStarted = performance.now()
  const evidenceRows = evidencePlan ? db.prepare(evidencePlan.sql).all(...evidencePlan.parameters) : []
  const evidenceMs = performance.now() - evidenceStarted
  const total = plans.search.include_total ? Number(rows[0]?.total ?? 0) : null
  const hasMore = plans.search.include_total
    ? total > plans.search.result_page * plans.search.page_size
    : rows.length > plans.search.page_size
  const nextCursor = hasMore && visibleRows.length
    ? encodeCandidateCursor(plans.search, visibleRows.at(-1), plans.search.result_page)
    : null
  const mappingStarted = performance.now()
  const items = mapBusinessCandidateResults(plans.search, visibleRows, evidenceRows)
  const mappingMs = performance.now() - mappingStarted
  return {
    items,
    pagination: {
      page: plans.search.result_page,
      page_size: plans.search.page_size,
      total,
      total_pages: total === null ? null : Math.ceil(total / plans.search.page_size),
      has_more: hasMore,
      next_cursor: nextCursor
    },
    query: {
      terms: plans.search.concepts.map((concept) => ({ label: concept.label, terms: [...concept.terms] })),
      match_mode: plans.search.match_mode,
      filters: {
        archived: plans.search.archived,
        location: plans.search.location ?? null,
        min_years: plans.search.min_years ?? null,
        max_years: plans.search.max_years ?? null,
        stage: plans.search.stage ?? null,
        position_id: plans.search.position_id ?? null,
        talent_pool_id: plans.search.talent_pool_id ?? null,
        source_types: [...(plans.search.source_types ?? [])]
      }
    },
    context: {
      candidate_limit: plans.search.page_size,
      evidence_per_candidate: plans.search.evidence_limit,
      database_scope: 'all_matching_candidates',
      search_index: 'business_v2'
    },
    performance: {
      planning_ms: Number(planningMs.toFixed(1)),
      page_ms: Number(pageMs.toFixed(1)),
      evidence_ms: Number(evidenceMs.toFixed(1)),
      mapping_ms: Number(mappingMs.toFixed(1)),
      total_ms: Number((performance.now() - searchStarted).toFixed(1))
    }
  }
}

export const BUSINESS_SEARCH_INTERNALS = Object.freeze({
  documentsTable: SEARCH_DOCUMENTS_TABLE,
  ftsTable: SEARCH_FTS_TABLE,
  dirtyTable: DIRTY_TABLE,
  checkpointTable: CHECKPOINT_TABLE,
  coverageTable: COVERAGE_TABLE,
  fieldCoverageTable: FIELD_COVERAGE_TABLE
})
