import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createConnection } from 'node:net'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPROVED_ROOT = resolve('C:/Users/cboy/Documents/北森')
const SELF_PATH = fileURLToPath(import.meta.url)
export const MAINTENANCE_SENTINEL_KIND = 'candidate-workbench-maintenance-v1'
export const SOURCE_MANIFEST_FORMAT = 'candidate-workbench-source-snapshot-v1'

let migrationCommitted = false
let migrationVerified = false
let formalAttempt = false
let migrationLockPath = ''
let migrationLockExpectedHash = ''
let migrationLockMode = ''

function fail(code, message, details = undefined) {
  const error = new Error(message)
  error.code = code
  error.details = details
  throw error
}

function argumentValue(name) {
  const prefix = `--${name}=`
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return value ? value.slice(prefix.length).trim() : ''
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function validateArguments() {
  const valueArguments = new Set([
    'root', 'database', 'mode', 'backup-manifest', 'backup-manifest-sha256',
    'source-manifest', 'source-manifest-sha256', 'migration-script-sha256',
    'service-pid', 'host', 'port', 'marker-out', 'recovery-marker',
    'recovery-marker-sha256', 'maintenance-sentinel-sha256'
  ])
  const seen = new Set()
  for (const argument of process.argv.slice(2)) {
    if (argument === '--allow-formal') {
      if (seen.has('allow-formal')) fail('duplicate_argument', 'Duplicate --allow-formal argument.')
      seen.add('allow-formal')
      continue
    }
    const match = /^--([^=]+)=/.exec(argument)
    if (!match || !valueArguments.has(match[1])) fail('unknown_argument', `Unknown migration argument: ${argument}`)
    if (seen.has(match[1])) fail('duplicate_argument', `Duplicate migration argument: --${match[1]}`)
    seen.add(match[1])
  }
  return seen
}

function canonical(path) {
  return realpathSync.native(resolve(path)).toLowerCase()
}

function sha256(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  const descriptor = openSync(path, 'r')
  try {
    let bytesRead
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

function regularFile(path, label) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail('file_identity_invalid', `Expected an independent regular file: ${label}`)
  }
  return info
}

function entryExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail('metadata_invalid', `Unable to read metadata file: ${path}`, String(error?.message ?? error))
  }
}

function normalizeRelativePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '')
}

function databaseFingerprint(databasePath) {
  return createHash('sha256')
    .update(resolve(databasePath).replaceAll('\\', '/').toLowerCase())
    .digest('hex')
}

export function maintenanceSentinelPath(root, databasePath) {
  return resolve(root, `.candidate-workbench-maintenance-${databaseFingerprint(databasePath).slice(0, 24)}.lock`)
}

function writeExclusiveJson(path, value) {
  let descriptor = null
  try {
    descriptor = openSync(path, 'wx')
    writeSync(descriptor, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
    fsyncSync(descriptor)
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch {}
      descriptor = null
    }
    const current = entryExists(path) ? readJson(path) : null
    if (current?.token === value.token) {
      try { unlinkSync(path) } catch {}
    }
    throw error
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function releaseMigrationLock() {
  if (!migrationLockPath) return
  const retainOnFailure = formalAttempt || migrationCommitted
  if (!retainOnFailure || migrationVerified) {
    try {
      if (!migrationLockExpectedHash || sha256(migrationLockPath) === migrationLockExpectedHash) unlinkSync(migrationLockPath)
    } catch {}
  }
  migrationLockPath = ''
  migrationLockExpectedHash = ''
  migrationLockMode = ''
}

function registerMigrationLock(path, expectedHash, mode) {
  migrationLockPath = path
  migrationLockExpectedHash = expectedHash
  migrationLockMode = mode
  process.once('exit', releaseMigrationLock)
}

function expectedSentinel(root, databasePath, migrationScriptHash, mode) {
  return {
    kind: MAINTENANCE_SENTINEL_KIND,
    owner: 'migration',
    mode,
    database_fingerprint: databaseFingerprint(databasePath),
    root_fingerprint: createHash('sha256').update(canonical(root)).digest('hex'),
    migration_script_sha256: migrationScriptHash
  }
}

function validateSentinel(path, expectedHash, expected) {
  if (!entryExists(path)) fail('maintenance_sentinel_missing', 'The pre-armed maintenance sentinel is missing.')
  regularFile(path, 'maintenance sentinel')
  const actualHash = sha256(path)
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
    fail('maintenance_sentinel_hash_mismatch', 'The maintenance sentinel does not match the approved hash.')
  }
  const value = readJson(path)
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value?.[key] !== expectedValue) fail('maintenance_sentinel_invalid', `Maintenance sentinel field is invalid: ${key}`)
  }
  if (typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.token) || typeof value.created_at !== 'string') {
    fail('maintenance_sentinel_invalid', 'Maintenance sentinel identity is invalid.')
  }
  return { value, sha256: actualHash }
}

export function armFormalSentinel(root, databasePath, migrationScriptHash) {
  const path = maintenanceSentinelPath(root, databasePath)
  const value = {
    ...expectedSentinel(root, databasePath, migrationScriptHash, 'formal'),
    token: randomUUID(),
    state: 'armed',
    created_at: new Date().toISOString()
  }
  try {
    writeExclusiveJson(path, value)
  } catch (error) {
    fail('maintenance_sentinel_exists', 'A runtime or maintenance sentinel already owns the formal database.', String(error?.message ?? error))
  }
  const hash = sha256(path)
  registerMigrationLock(path, hash, 'arm')
  return { path, sha256: hash, value }
}

function acquireRecoveryLock(root, databasePath, migrationScriptHash) {
  const path = maintenanceSentinelPath(root, databasePath)
  const value = {
    ...expectedSentinel(root, databasePath, migrationScriptHash, 'recovery'),
    token: randomUUID(),
    state: 'running',
    pid: process.pid,
    created_at: new Date().toISOString()
  }
  try {
    writeExclusiveJson(path, value)
  } catch (error) {
    fail('migration_locked', 'Another runtime or V9 migration owns this database.', String(error?.message ?? error))
  }
  const hash = sha256(path)
  registerMigrationLock(path, hash, 'recovery')
}

function adoptFormalSentinel(root, databasePath, migrationScriptHash, expectedHash) {
  const path = maintenanceSentinelPath(root, databasePath)
  validateSentinel(path, expectedHash, expectedSentinel(root, databasePath, migrationScriptHash, 'formal'))
  registerMigrationLock(path, expectedHash, 'formal')
}

function ensureFormalFailureSentinel(root, databasePath, migrationScriptHash) {
  if (!formalAttempt || !root || !databasePath) return
  const path = maintenanceSentinelPath(root, databasePath)
  if (entryExists(path)) return
  const value = {
    ...expectedSentinel(root, databasePath, migrationScriptHash || 'unknown', 'formal-failure'),
    token: randomUUID(),
    state: 'restore_required',
    pid: process.pid,
    created_at: new Date().toISOString()
  }
  try { writeExclusiveJson(path, value) } catch {}
}

function pathTreeContains(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep.toLowerCase()}`)
}

export function assertDisjointDirectoryTrees(entries) {
  const resolved = entries.map(({ label, path }) => ({ label, path: canonical(path) }))
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      if (pathTreeContains(resolved[left].path, resolved[right].path) || pathTreeContains(resolved[right].path, resolved[left].path)) {
        fail('directory_trees_overlap', `${resolved[left].label} and ${resolved[right].label} must use disjoint directory trees.`)
      }
    }
  }
}

function collectTreeFiles(root, relativeDirectory) {
  const absoluteDirectory = resolve(root, relativeDirectory)
  const directoryInfo = lstatSync(absoluteDirectory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail('source_snapshot_invalid', `Production directory is invalid: ${relativeDirectory}`)
  const files = []
  const visit = (directory, relativeBase) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name)
      const relative = normalizeRelativePath(`${relativeBase}/${entry.name}`)
      if (entry.isSymbolicLink()) fail('source_snapshot_invalid', `Production source symlink is not allowed: ${relative}`)
      if (entry.isDirectory()) visit(absolute, relative)
      else if (entry.isFile()) files.push(relative)
      else fail('source_snapshot_invalid', `Unsupported production source entry: ${relative}`)
    }
  }
  visit(absoluteDirectory, normalizeRelativePath(relativeDirectory))
  return files
}

export function requiredProductionFiles(root) {
  const fixed = [
    'package.json',
    'package-lock.json',
    'index.html',
    'tsconfig.json',
    'vite.config.ts',
    'start.cmd',
    'start.ps1',
    'scripts/formal-v9-migrate.mjs'
  ]
  const result = [...fixed, ...collectTreeFiles(root, 'server'), ...collectTreeFiles(root, 'src'), ...collectTreeFiles(root, 'dist')]
  for (const relativePath of fixed) regularFile(resolve(root, relativePath), relativePath)
  return [...new Set(result)].sort()
}

export function verifySourceManifest(root, manifestPath, expectedHash, migrationScriptHash) {
  if (!manifestPath || !entryExists(manifestPath)) fail('source_manifest_required', 'A source snapshot manifest is required.')
  regularFile(manifestPath, 'source snapshot manifest')
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || sha256(manifestPath) !== expectedHash) {
    fail('source_manifest_hash_mismatch', 'The source snapshot manifest hash does not match the approved value.')
  }
  const manifest = readJson(manifestPath)
  if (manifest.format !== SOURCE_MANIFEST_FORMAT || canonical(manifest.root) !== canonical(root) || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('source_manifest_invalid', 'The source snapshot manifest is not bound to the project root and expected format.')
  }
  const canonicalRootPrefix = `${canonical(root)}${sep.toLowerCase()}`
  const manifestPaths = new Set()
  for (const expected of manifest.files) {
    const normalizedPath = normalizeRelativePath(expected?.path)
    const sourceBaseName = normalizedPath.split('/').at(-1) ?? ''
    if (!normalizedPath || normalizedPath !== expected.path || manifestPaths.has(normalizedPath) || normalizedPath.includes('..') || /^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('/') || /^\.candidate-workbench-maintenance-.*\.lock$/i.test(normalizedPath) || /^(?:data|backups|output|node_modules|\.git|\.playwright-cli)(?:\/|$)/i.test(normalizedPath) || /(^|\/)\.env(?:[./]|$)|\.(?:key|pem|p12|pfx|log)$/i.test(normalizedPath) || /(?:token|secret|credential|password)/i.test(sourceBaseName)) {
      fail('source_manifest_invalid', `Sensitive, duplicate, or unsafe source path is not allowed: ${expected?.path}`)
    }
    manifestPaths.add(normalizedPath)
    const path = resolve(root, normalizedPath)
    if (!existsSync(path) || !canonical(path).startsWith(canonicalRootPrefix) || !Number.isSafeInteger(Number(expected.bytes)) || Number(expected.bytes) < 0 || !/^[0-9a-f]{64}$/i.test(String(expected.sha256 ?? '')) || regularFile(path, normalizedPath).size !== Number(expected.bytes) || sha256(path) !== String(expected.sha256).toLowerCase()) {
      fail('source_snapshot_changed', `Approved source file changed: ${normalizedPath}`)
    }
  }
  const required = requiredProductionFiles(root)
  const missing = required.filter((path) => !manifestPaths.has(path))
  if (missing.length > 0) fail('source_manifest_incomplete', 'The source manifest omits required production files.', missing)
  const migrationEntry = manifest.files.find((entry) => entry.path === 'scripts/formal-v9-migrate.mjs')
  if (String(migrationEntry?.sha256 ?? '').toLowerCase() !== migrationScriptHash || sha256(SELF_PATH) !== migrationScriptHash) {
    fail('migration_script_manifest_mismatch', 'The executing migration script is not the script approved by the source manifest.')
  }
  return { manifest, required_files: required }
}

function pragmaValue(row) {
  return String(row?.integrity_check ?? Object.values(row ?? {})[0] ?? '')
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?").get(name))
}

function count(db, table) {
  if (!tableExists(db, table)) fail('required_table_missing', `Required table is missing: ${table}`)
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
}

const REQUIRED_TABLES = [
  'stages', 'candidates', 'notes', 'activities', 'import_batches', 'positions',
  'candidate_positions', 'talent_pools', 'candidate_talent_pools', 'candidate_attachments',
  'candidate_field_sources', 'candidate_profile_sections', 'candidate_preferences',
  'candidate_source_records', 'candidate_assessments', 'candidate_consents',
  'candidate_position_sources', 'agent_query_audits', 'agent_sessions', 'agent_messages',
  'agent_session_summaries', 'candidate_resume_documents', 'candidate_resume_fts',
  'search_documents_v2', 'search_documents_v2_fts', 'search_index_dirty_v2',
  'search_index_checkpoints_v2', 'search_index_coverage_v2', 'search_index_field_coverage_v2'
]

const PROTECTED_COUNT_TABLES = [
  ...REQUIRED_TABLES,
  'candidate_resume_vectors'
]

export const V9_INDEXES = [
  'agent_tasks_session_status_idx',
  'agent_tasks_heartbeat_idx',
  'agent_tasks_created_idx',
  'agent_query_audits_task_idx',
  'candidates_stage_id_v9_idx',
  'candidates_import_batch_id_v9_idx'
]
export const EXPECTED_AGENT_TASKS_SQL_SHA256 = 'c480c640686e24a2b1bda10535ba309598fc00f04b71095941c9f5bf4fb3ea6e'
export const EXPECTED_V9_DEFINITIONS_SHA256 = '61ff580d88447ad6e04beb325ccf0361c84bee6725130cb0aac093934d3c658f'

function metadataDigest(db, table, columns) {
  const hash = createHash('sha256')
  let rows = 0
  for (const row of db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`).iterate()) {
    hash.update(JSON.stringify(columns.map((column) => row[column] ?? null)))
    hash.update('\n')
    rows += 1
  }
  return { rows, sha256: hash.digest('hex') }
}

function coverageDigest(db, table, columns) {
  if (!tableExists(db, table)) fail('required_table_missing', `Required table is missing: ${table}`)
  const values = db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`).all()
    .map((row) => columns.map((column) => String(row[column] ?? '')).join('\u001f'))
  return { count: values.length, sha256: createHash('sha256').update(values.join('\n')).digest('hex') }
}

export function v9DefinitionSnapshot(db) {
  const auditColumns = new Set(db.prepare('PRAGMA table_info(agent_query_audits)').all().map((row) => row.name))
  const indexNames = V9_INDEXES.filter((name) => db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name))
  const agentTaskSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_tasks'").get()?.sql ?? null
  const v9Definitions = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE (type = 'table' AND name IN ('agent_tasks', 'agent_query_audits'))
       OR (type = 'index' AND name IN ('agent_tasks_session_status_idx', 'agent_tasks_heartbeat_idx', 'agent_tasks_created_idx', 'agent_query_audits_task_idx', 'candidates_stage_id_v9_idx', 'candidates_import_batch_id_v9_idx'))
    ORDER BY type, name
  `).all()
  return {
    agent_tasks: Boolean(agentTaskSql),
    agent_tasks_sql_sha256: agentTaskSql ? createHash('sha256').update(agentTaskSql).digest('hex') : null,
    audit_columns: ['trace_id', 'task_id', 'phase'].filter((column) => auditColumns.has(column)),
    indexes: indexNames,
    definitions_sha256: createHash('sha256').update(JSON.stringify(v9Definitions)).digest('hex')
  }
}

function snapshot(db, label) {
  process.stderr.write(`${JSON.stringify({ progress: `${label}_started` })}\n`)
  for (const table of REQUIRED_TABLES) if (!tableExists(db, table)) fail('required_table_missing', `Required table is missing: ${table}`)
  const checkpoint = db.prepare(`
    SELECT status, queued_rows, processed_rows, document_count, error_code
    FROM search_index_checkpoints_v2 WHERE scope = 'full'
  `).get()
  const counts = Object.fromEntries(PROTECTED_COUNT_TABLES.map((table) => [table, count(db, table)]))
  counts.agent_tasks = tableExists(db, 'agent_tasks') ? count(db, 'agent_tasks') : 0
  const tableCoverage = coverageDigest(db, 'search_index_coverage_v2', ['source_table', 'status'])
  const fieldCoverage = coverageDigest(db, 'search_index_field_coverage_v2', ['source_table', 'field_path', 'status'])
  process.stderr.write(`${JSON.stringify({ progress: `${label}_search_digest_started` })}\n`)
  const searchMetadata = metadataDigest(db, 'search_documents_v2', [
    'row_id', 'document_id', 'entity_type', 'entity_id', 'candidate_id', 'source_table',
    'source_row_id', 'field_path', 'segment_index', 'segment_count', 'char_start', 'char_end',
    'archived_at', 'source_updated_at', 'created_at', 'updated_at'
  ])
  const searchFtsMetadata = metadataDigest(db, 'search_documents_v2_fts', [
    'rowid', 'document_id', 'entity_type', 'entity_id', 'candidate_id', 'source_table',
    'source_row_id', 'field_path'
  ])
  const readyTableCount = Number(db.prepare("SELECT COUNT(*) AS count FROM search_index_coverage_v2 WHERE status = 'ready'").get().count)
  const readyFieldCount = Number(db.prepare("SELECT COUNT(*) AS count FROM search_index_field_coverage_v2 WHERE status = 'ready'").get().count)
  process.stderr.write(`${JSON.stringify({ progress: `${label}_integrity_started` })}\n`)
  const integrityRows = db.prepare('PRAGMA integrity_check').all().map(pragmaValue)
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length
  const migrationRows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
  const result = {
    versions: migrationRows.map((row) => Number(row.version)),
    migration_names: Object.fromEntries(migrationRows.map((row) => [String(row.version), row.name])),
    counts,
    checkpoint: checkpoint ? {
      status: checkpoint.status,
      queued_rows: Number(checkpoint.queued_rows),
      processed_rows: Number(checkpoint.processed_rows),
      document_count: Number(checkpoint.document_count),
      error_code: checkpoint.error_code ?? null
    } : null,
    coverage: {
      table_total: tableCoverage.count,
      table_ready: readyTableCount,
      table_keys_sha256: tableCoverage.sha256,
      field_total: fieldCoverage.count,
      field_ready: readyFieldCount,
      field_keys_sha256: fieldCoverage.sha256
    },
    search_metadata: searchMetadata,
    search_fts_metadata: searchFtsMetadata,
    integrity_check: integrityRows.length === 1 ? integrityRows[0] : integrityRows.join(','),
    foreign_key_violations: foreignKeyViolations,
    v9: v9DefinitionSnapshot(db)
  }
  process.stderr.write(`${JSON.stringify({ progress: `${label}_completed`, integrity: result.integrity_check, foreign_key_violations: foreignKeyViolations })}\n`)
  return result
}

function verifyManifest(manifestPath, directory, expectedManifestHash = '') {
  if (expectedManifestHash && sha256(manifestPath) !== expectedManifestHash) fail('backup_manifest_hash_mismatch', 'The backup manifest changed during verification.')
  const manifest = readJson(manifestPath)
  const requiredNames = ['recruitment.db', 'recruitment.db-wal', 'recruitment.db-shm']
  if (!Array.isArray(manifest.files) || manifest.files.length !== requiredNames.length) fail('backup_manifest_invalid', 'Backup manifest must contain the three SQLite files.')
  const manifestNames = manifest.files.map((entry) => entry?.name)
  if (new Set(manifestNames).size !== requiredNames.length || requiredNames.some((name) => !manifestNames.includes(name))) {
    fail('backup_manifest_invalid', 'Backup manifest file names must be complete and unique.')
  }
  const entries = []
  for (const expected of manifest.files) {
    const path = resolve(directory, expected.name)
    if (expected.present === false) {
      if (expected.bytes !== 0 || expected.sha256 !== null) fail('backup_manifest_invalid', `Absent file metadata is invalid: ${expected.name}`)
      if (entryExists(path)) fail('database_file_presence_mismatch', `Database sidecar unexpectedly exists: ${expected.name}`)
      entries.push({ name: expected.name, present: false, bytes: 0, sha256: null })
      continue
    }
    if (!entryExists(path)) fail('database_file_missing', `Missing database file: ${path}`)
    if (expected.present !== true || !Number.isSafeInteger(Number(expected.bytes)) || Number(expected.bytes) < 0 || !/^[0-9a-f]{64}$/i.test(String(expected.sha256 ?? ''))) {
      fail('backup_manifest_invalid', `Invalid metadata for ${expected.name}.`)
    }
    const actualBytes = regularFile(path, expected.name).size
    const actualHash = sha256(path)
    if (actualBytes !== Number(expected.bytes) || actualHash !== String(expected.sha256).toLowerCase()) {
      fail('database_file_hash_mismatch', `Database file changed: ${expected.name}`, { expected_bytes: expected.bytes, actual_bytes: actualBytes, expected_sha256: expected.sha256, actual_sha256: actualHash })
    }
    entries.push({ name: expected.name, present: true, bytes: actualBytes, sha256: actualHash })
  }
  return { ...manifest, files: entries }
}

function verifyMainDatabase(manifest, directory) {
  const expected = manifest.files.find((entry) => entry.name === 'recruitment.db')
  if (!expected?.present) fail('backup_manifest_invalid', 'Backup manifest must contain recruitment.db.')
  const path = resolve(directory, expected.name)
  if (!entryExists(path)) fail('database_file_missing', `Missing database file: ${path}`)
  const info = regularFile(path, expected.name)
  const actualHash = sha256(path)
  if (info.size !== Number(expected.bytes) || actualHash !== String(expected.sha256).toLowerCase()) {
    fail('database_file_hash_mismatch', 'The main database changed during verification.', { expected_bytes: expected.bytes, actual_bytes: info.size, expected_sha256: expected.sha256, actual_sha256: actualHash })
  }
}

function assertApprovedBaseline(value) {
  const minimums = {
    candidates: 8_209,
    positions: 312,
    talent_pools: 35,
    candidate_positions: 9_980,
    candidate_talent_pools: 6_224,
    search_documents_v2: 2_629_351,
    candidate_resume_documents: 112
  }
  for (const [key, minimum] of Object.entries(minimums)) {
    if (Number(value.counts[key] ?? 0) < minimum) fail('baseline_too_small', `Protected aggregate ${key} is below the approved V8 baseline.`)
  }
}

function portIsListening(host, port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host, port })
    const finish = (value) => { socket.destroy(); resolveResult(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(700, () => finish(false))
  })
}

export async function assertServiceStopped(pid, host, port) {
  if (pid) {
    try {
      process.kill(Number(pid), 0)
      fail('service_still_running', `Configured service PID ${pid} is still alive.`)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  if (await portIsListening(host, port)) fail('service_port_in_use', `Service port ${host}:${port} is still listening.`)
}

function now() {
  return new Date().toISOString()
}

function ensureColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}

export function applyEmbeddedV9Migration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL UNIQUE,
      client_request_id TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'planning', 'querying', 'retrieving', 'composing',
        'completed', 'partial', 'failed', 'cancelled'
      )),
      stage TEXT NOT NULL,
      result_json TEXT,
      result_bytes INTEGER NOT NULL DEFAULT 0 CHECK(result_bytes >= 0),
      result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
      has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0, 1)),
      timings_json TEXT NOT NULL DEFAULT '{}',
      tools_used_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_stage TEXT,
      error_message TEXT,
      retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
      cancel_requested_at TEXT,
      heartbeat_at TEXT,
      deadline_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(user_message_id) REFERENCES agent_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_session_status_idx
      ON agent_tasks(session_id, status, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS agent_tasks_heartbeat_idx
      ON agent_tasks(status, heartbeat_at);
    CREATE INDEX IF NOT EXISTS agent_tasks_created_idx
      ON agent_tasks(created_at DESC, id);
  `)
  ensureColumn(db, 'agent_query_audits', 'trace_id', 'TEXT')
  ensureColumn(db, 'agent_query_audits', 'task_id', 'TEXT')
  ensureColumn(db, 'agent_query_audits', 'phase', 'TEXT')
  db.exec(`
    CREATE INDEX IF NOT EXISTS agent_query_audits_task_idx
      ON agent_query_audits(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS candidates_stage_id_v9_idx
      ON candidates(stage, id);
    CREATE INDEX IF NOT EXISTS candidates_import_batch_id_v9_idx
      ON candidates(import_batch_id, id);
  `)
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (9, 'agent_async_tasks_and_phase_audits', ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name
  `).run(now())
}

function assertEmbeddedV9Definition(db) {
  const definition = v9DefinitionSnapshot(db)
  const migration = db.prepare('SELECT name FROM schema_migrations WHERE version = 9').get()
  if (migration?.name !== 'agent_async_tasks_and_phase_audits' || !definition.agent_tasks || definition.agent_tasks_sql_sha256 !== EXPECTED_AGENT_TASKS_SQL_SHA256 || definition.audit_columns.length !== 3 || JSON.stringify(definition.indexes) !== JSON.stringify(V9_INDEXES)) {
    fail('embedded_v9_definition_invalid', 'The embedded V9 migration differs from the approved schema.', { migration, definition })
  }
}

function openWritable(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  const journalMode = String(Object.values(db.prepare('PRAGMA journal_mode').get() ?? {})[0] ?? '').toLowerCase()
  if (journalMode !== 'wal') {
    db.close()
    fail('journal_mode_not_wal', 'The migration input is not already using WAL mode.', journalMode)
  }
  return db
}

export async function migrateV9Only(databasePath, beforeBegin = undefined) {
  const db = openWritable(databasePath)
  try {
    const requireV8 = () => {
      const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version))
      if (JSON.stringify(versions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8])) fail('pre_schema_changed', 'The migration target changed after the V8 snapshot.', versions)
    }
    requireV8()
    if (beforeBegin) await beforeBegin()
    db.exec('BEGIN IMMEDIATE')
    try {
      requireV8()
      applyEmbeddedV9Migration(db)
      assertEmbeddedV9Definition(db)
      db.exec('COMMIT')
      migrationCommitted = true
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    try { return db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all() } catch (error) { return [{ error: String(error?.message ?? error) }] }
  } finally {
    db.close()
  }
}

export function assertReadyV8(value) {
  if (JSON.stringify(value.versions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8])) fail('pre_schema_not_v8', 'Pre-migration schema must be exactly V1-V8.', value.versions)
  if (value.migration_names?.['8'] !== 'agent_sessions_and_full_business_search' || value.migration_names?.['9'] !== undefined) fail('pre_migration_name_invalid', 'The V8 migration metadata is not the approved baseline.')
  if (value.integrity_check !== 'ok') fail('pre_integrity_failed', 'Pre-migration integrity_check failed.')
  if (value.foreign_key_violations !== 0) fail('pre_foreign_keys_failed', 'Pre-migration foreign-key violations are nonzero.')
  if (value.checkpoint?.status !== 'ready' || value.checkpoint.error_code !== null || value.counts.search_index_dirty_v2 !== 0) fail('pre_search_not_ready', 'Pre-migration FTS checkpoint is not ready or dirty rows remain.')
  if (!value.checkpoint || value.checkpoint.processed_rows < value.checkpoint.queued_rows) fail('pre_checkpoint_incomplete', 'Pre-migration processed rows are behind queued rows.')
  if (value.counts.search_documents_v2 !== value.counts.search_documents_v2_fts || value.counts.search_documents_v2 !== value.checkpoint.document_count) fail('pre_search_counts_mismatch', 'Pre-migration business search document counts differ.')
  if (value.counts.candidate_resume_documents !== value.counts.candidate_resume_fts) fail('pre_resume_counts_mismatch', 'Pre-migration resume document counts differ.')
  if (value.coverage.table_total !== 19 || value.coverage.table_ready !== 19 || value.coverage.field_total !== 191 || value.coverage.field_ready !== 191) fail('pre_coverage_not_ready', 'Pre-migration table or field coverage is not exactly 19/19 and 191/191.')
  if (value.v9.agent_tasks || value.v9.audit_columns.length !== 0 || value.v9.indexes.length !== 0) fail('pre_v9_objects_present', 'Pre-migration database already contains V9 objects.')
  if (value.counts.agent_tasks !== 0) fail('pre_tasks_not_empty', 'Pre-migration database unexpectedly contains Agent tasks.')
  assertApprovedBaseline(value)
}

function assertReadyV9(before, after) {
  if (JSON.stringify(after.versions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9])) fail('post_schema_not_v9', 'Post-migration schema must be exactly V1-V9.', after.versions)
  if (after.migration_names?.['9'] !== 'agent_async_tasks_and_phase_audits') fail('post_migration_name_invalid', 'The V9 migration metadata name is invalid.')
  if (JSON.stringify(after.counts) !== JSON.stringify(before.counts)) fail('post_counts_changed', 'Protected aggregate counts changed during V9 migration.', { before: before.counts, after: after.counts })
  if (JSON.stringify(after.checkpoint) !== JSON.stringify(before.checkpoint)) fail('post_checkpoint_changed', 'FTS checkpoint changed during V9 migration.', { before: before.checkpoint, after: after.checkpoint })
  if (JSON.stringify(after.coverage) !== JSON.stringify(before.coverage)) fail('post_coverage_changed', 'FTS coverage changed during V9 migration.', { before: before.coverage, after: after.coverage })
  if (JSON.stringify(after.search_metadata) !== JSON.stringify(before.search_metadata) || JSON.stringify(after.search_fts_metadata) !== JSON.stringify(before.search_fts_metadata)) fail('post_search_metadata_changed', 'FTS document metadata changed during V9 migration.')
  if (after.integrity_check !== 'ok' || after.foreign_key_violations !== 0) fail('post_database_invalid', 'Post-migration integrity or foreign-key check failed.')
  if (!after.v9.agent_tasks || after.v9.audit_columns.length !== 3 || JSON.stringify(after.v9.indexes) !== JSON.stringify(V9_INDEXES)) fail('post_v9_objects_missing', 'One or more V9 additive objects are missing.', after.v9)
  if (after.v9.agent_tasks_sql_sha256 !== EXPECTED_AGENT_TASKS_SQL_SHA256 || after.v9.definitions_sha256 !== EXPECTED_V9_DEFINITIONS_SHA256) fail('post_v9_definitions_invalid', 'One or more V9 table or index definitions differ from the approved schema.', after.v9)
}

function inspect(path, label) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    return snapshot(db, label)
  } finally {
    db.close()
  }
}

let activeRoot = ''
let activeDatabasePath = ''
let activeMigrationScriptHash = ''

function assertExactArguments(seen, allowed, mode) {
  const unexpected = [...seen].filter((name) => !allowed.has(name))
  if (unexpected.length > 0) fail(`${mode}_argument_invalid`, `${mode} mode received invalid arguments.`, unexpected)
}

async function armMode(root, databasePath, migrationScriptHash, suppliedArguments) {
  assertExactArguments(suppliedArguments, new Set([
    'root', 'database', 'mode', 'migration-script-sha256', 'service-pid', 'host', 'port', 'allow-formal'
  ]), 'arm')
  if (!hasFlag('allow-formal')) fail('formal_not_authorized', 'Arming formal maintenance requires --allow-formal.')
  if (argumentValue('service-pid') !== '7232' || argumentValue('host') !== '127.0.0.1' || argumentValue('port') !== '4173') {
    fail('service_identity_required', 'Formal maintenance requires the approved service PID, loopback host, and port.')
  }
  const armed = armFormalSentinel(root, databasePath, migrationScriptHash)
  await assertServiceStopped('7232', '127.0.0.1', 4173)
  validateSentinel(armed.path, armed.sha256, expectedSentinel(root, databasePath, migrationScriptHash, 'formal'))
  console.log(JSON.stringify({
    ok: true,
    mode: 'arm',
    maintenance_sentinel: armed.path,
    maintenance_sentinel_sha256: armed.sha256,
    database_fingerprint: armed.value.database_fingerprint,
    migration_script_sha256: migrationScriptHash,
    runtime_must_remain_stopped: true
  }, null, 2))
}

async function main() {
  const suppliedArguments = validateArguments()
  const rootArgument = argumentValue('root')
  const databaseArgument = argumentValue('database')
  if (!rootArgument || !databaseArgument) fail('path_required', 'Explicit root and database paths are required.')
  const root = resolve(rootArgument)
  const databasePath = resolve(databaseArgument)
  activeRoot = root
  activeDatabasePath = databasePath
  if (!existsSync(root) || !existsSync(databasePath) || !statSync(databasePath).isFile()) fail('path_missing', 'Root or database file does not exist.')
  if (canonical(root) !== canonical(APPROVED_ROOT)) fail('root_not_approved', 'Migration root is not the approved project root.')
  if (basename(databasePath).toLowerCase() !== 'recruitment.db') fail('database_name_required', 'Migration target must be named recruitment.db.')
  regularFile(databasePath, 'migration target')
  const approvedScriptPath = resolve(root, 'scripts', 'formal-v9-migrate.mjs')
  if (canonical(SELF_PATH) !== canonical(approvedScriptPath)) fail('migration_script_location_invalid', 'The migration must run from the approved repository script path.')
  const migrationScriptHash = argumentValue('migration-script-sha256').toLowerCase()
  activeMigrationScriptHash = migrationScriptHash
  if (!/^[0-9a-f]{64}$/.test(migrationScriptHash) || sha256(SELF_PATH) !== migrationScriptHash) fail('migration_script_hash_mismatch', 'The migration script does not match the approved hash.')

  const mode = argumentValue('mode')
  if (!['arm', 'recovery', 'formal'].includes(mode)) fail('invalid_mode', 'Mode must be arm, recovery, or formal.')
  const formalPath = resolve(root, 'data', 'recruitment.db')
  const formal = databasePath.toLowerCase() === formalPath.toLowerCase()
  if (!formal && canonical(databasePath) === canonical(formalPath)) fail('formal_alias_not_allowed', 'The migration input resolves to the formal database path.')
  if (mode === 'arm') {
    formalAttempt = true
    if (!formal) fail('formal_target_required', 'Arm mode must target the formal database path.')
    await armMode(root, databasePath, migrationScriptHash, suppliedArguments)
    return
  }
  if (mode === 'formal' && !formal) fail('formal_target_required', 'Formal mode must target the formal database path.')
  if (mode === 'recovery' && formal) fail('recovery_target_formal', 'Recovery mode cannot target the formal database.')
  formalAttempt = mode === 'formal'
  if (mode === 'recovery' && ['allow-formal', 'service-pid', 'host', 'port', 'recovery-marker', 'recovery-marker-sha256', 'maintenance-sentinel-sha256'].some((name) => suppliedArguments.has(name))) fail('recovery_argument_invalid', 'Recovery mode received a formal-only argument.')
  if (mode === 'formal' && suppliedArguments.has('marker-out')) fail('formal_argument_invalid', 'Formal mode cannot write a recovery marker.')
  if (formal && !hasFlag('allow-formal')) fail('formal_not_authorized', 'Formal database migration requires --allow-formal.')
  if (formal && (argumentValue('service-pid') !== '7232' || argumentValue('host') !== '127.0.0.1' || argumentValue('port') !== '4173')) {
    fail('service_identity_required', 'Formal migration requires the approved service PID, loopback host, and port.')
  }

  const manifestArgument = argumentValue('backup-manifest')
  const manifestPath = manifestArgument ? resolve(manifestArgument) : ''
  const backupManifestHash = argumentValue('backup-manifest-sha256').toLowerCase()
  const sourceManifestPath = argumentValue('source-manifest') ? resolve(argumentValue('source-manifest')) : ''
  const sourceManifestHash = argumentValue('source-manifest-sha256').toLowerCase()
  if (!manifestPath || !entryExists(manifestPath) || !/^[0-9a-f]{64}$/.test(backupManifestHash)) fail('backup_manifest_required', 'A hashed three-file backup manifest is required.')
  regularFile(manifestPath, 'backup manifest')
  if (!sourceManifestPath || !/^[0-9a-f]{64}$/.test(sourceManifestHash)) fail('source_manifest_required', 'A hashed source snapshot manifest is required.')

  const manifestDirectory = dirname(manifestPath)
  const databaseDirectory = dirname(databasePath)
  const formalDataDirectory = dirname(formalPath)
  const markerOutPath = argumentValue('marker-out') ? resolve(argumentValue('marker-out')) : ''
  const recoveryMarkerPath = argumentValue('recovery-marker') ? resolve(argumentValue('recovery-marker')) : ''
  let markerDirectory = ''
  if (mode === 'recovery') {
    if (!markerOutPath) fail('recovery_marker_required', 'Recovery mode requires --marker-out.')
    if (entryExists(markerOutPath)) fail('recovery_marker_exists', 'Recovery marker output must not already exist.')
    markerDirectory = dirname(markerOutPath)
    if (!existsSync(markerDirectory) || !statSync(markerDirectory).isDirectory()) fail('recovery_marker_directory_missing', 'Recovery marker directory does not exist.')
    accessSync(markerDirectory, constants.W_OK)
    assertDisjointDirectoryTrees([
      { label: 'formal data', path: formalDataDirectory },
      { label: 'recovery database', path: databaseDirectory },
      { label: 'backup', path: manifestDirectory },
      { label: 'recovery marker', path: markerDirectory }
    ])
  } else {
    if (!recoveryMarkerPath || !entryExists(recoveryMarkerPath)) fail('recovery_marker_required', 'Formal migration requires a successful recovery marker.')
    markerDirectory = dirname(recoveryMarkerPath)
    assertDisjointDirectoryTrees([
      { label: 'formal data', path: formalDataDirectory },
      { label: 'backup', path: manifestDirectory },
      { label: 'recovery marker', path: markerDirectory }
    ])
  }

  if (mode === 'formal') {
    const maintenanceHash = argumentValue('maintenance-sentinel-sha256').toLowerCase()
    adoptFormalSentinel(root, databasePath, migrationScriptHash, maintenanceHash)
    await assertServiceStopped('7232', '127.0.0.1', 4173)
  } else {
    acquireRecoveryLock(root, databasePath, migrationScriptHash)
  }

  const sourceVerification = verifySourceManifest(root, sourceManifestPath, sourceManifestHash, migrationScriptHash)
  if (sha256(manifestPath) !== backupManifestHash) fail('backup_manifest_hash_mismatch', 'The backup manifest hash does not match the approved value.')
  const manifest = verifyManifest(manifestPath, manifestDirectory, backupManifestHash)
  if (manifest.source_snapshot_sha256 !== sourceManifestHash) fail('source_manifest_mismatch', 'The backup manifest is not bound to the source snapshot.')
  if (canonical(manifestDirectory) !== canonical(databaseDirectory)) {
    verifyManifest(manifestPath, databaseDirectory, backupManifestHash)
    for (const entry of manifest.files.filter((value) => value.present !== false)) {
      const backupStat = statSync(resolve(manifestDirectory, entry.name))
      const targetStat = statSync(resolve(databaseDirectory, entry.name))
      if (backupStat.nlink !== 1 || targetStat.nlink !== 1 || (backupStat.dev === targetStat.dev && backupStat.ino === targetStat.ino)) {
        fail('database_hardlink_not_allowed', `Backup and migration target must be independent files: ${entry.name}`)
      }
    }
  }

  const before = inspect(databasePath, 'pre_migration')
  assertReadyV8(before)
  if (sha256(SELF_PATH) !== migrationScriptHash) fail('migration_script_changed', 'The migration script changed during the migration window.')
  verifySourceManifest(root, sourceManifestPath, sourceManifestHash, migrationScriptHash)
  if (sha256(manifestPath) !== backupManifestHash) fail('backup_manifest_changed', 'The backup manifest changed during the migration window.')
  verifyManifest(manifestPath, manifestDirectory, backupManifestHash)
  if (formal) verifyMainDatabase(manifest, databaseDirectory)

  let recoveryMarker = null
  if (formal) {
    regularFile(recoveryMarkerPath, 'recovery marker')
    const recoveryMarkerHash = argumentValue('recovery-marker-sha256').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(recoveryMarkerHash) || sha256(recoveryMarkerPath) !== recoveryMarkerHash) fail('recovery_marker_hash_mismatch', 'Recovery marker does not match the approved hash.')
    recoveryMarker = readJson(recoveryMarkerPath)
    if (recoveryMarker.ok !== true || recoveryMarker.mode !== 'recovery' || recoveryMarker.backup_manifest_sha256 !== backupManifestHash || recoveryMarker.source_manifest_sha256 !== sourceManifestHash || recoveryMarker.migration_script_sha256 !== migrationScriptHash) fail('recovery_marker_invalid', 'Recovery marker is not bound to the approved backup, source snapshot, and migration script.')
    if (JSON.stringify(recoveryMarker.before) !== JSON.stringify(before)) fail('formal_baseline_changed', 'Formal database aggregates differ from the verified recovery baseline.')
    assertReadyV9(recoveryMarker.before, recoveryMarker.after)
  }

  const beforeBegin = formal ? async () => {
    if (sha256(SELF_PATH) !== migrationScriptHash) fail('migration_script_changed', 'The migration script changed immediately before BEGIN.')
    validateSentinel(migrationLockPath, migrationLockExpectedHash, expectedSentinel(root, databasePath, migrationScriptHash, 'formal'))
    await assertServiceStopped('7232', '127.0.0.1', 4173)
  } : undefined
  const started = performance.now()
  const walCheckpoint = await migrateV9Only(databasePath, beforeBegin)
  const migrationMs = performance.now() - started
  const after = inspect(databasePath, 'post_migration')
  assertReadyV9(before, after)
  if (formal && JSON.stringify(after) !== JSON.stringify(recoveryMarker.after)) fail('formal_result_differs_from_recovery', 'Formal migration result differs from the verified recovery result.')
  if (sha256(SELF_PATH) !== migrationScriptHash) fail('migration_script_changed', 'The migration script changed after migration.')
  verifySourceManifest(root, sourceManifestPath, sourceManifestHash, migrationScriptHash)
  if (formal) validateSentinel(migrationLockPath, migrationLockExpectedHash, expectedSentinel(root, databasePath, migrationScriptHash, 'formal'))

  const result = {
    ok: true,
    mode,
    migration_ms: Math.round(migrationMs * 1000) / 1000,
    wal_checkpoint: walCheckpoint,
    before,
    after,
    backup_manifest_sha256: backupManifestHash,
    source_manifest_sha256: sourceManifestHash,
    migration_script_sha256: migrationScriptHash,
    source_files_verified: sourceVerification.manifest.files.length,
    required_production_files: sourceVerification.required_files.length
  }
  if (mode === 'recovery') writeFileSync(markerOutPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  migrationVerified = true
  releaseMigrationLock()
  console.log(JSON.stringify(result, null, 2))
}

export function failureEnvelope(error, { formal = formalAttempt, committed = migrationCommitted } = {}) {
  return {
    ok: false,
    committed,
    restore_required: committed,
    runtime_must_remain_stopped: formal,
    required_action: formal
      ? (committed ? 'restore_v8_sqlite_file_set_and_keep_current_v9_runtime_stopped' : 'keep_current_v9_runtime_stopped_until_the_failure_is_resolved')
      : (committed ? 'discard_or_restore_the_recovery_copy_before_retrying' : 'fix_the_precommit_failure_before_retrying'),
    error: { code: error?.code ?? 'migration_check_failed' }
  }
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(SELF_PATH).toLowerCase()
if (invokedAsScript) {
  main().catch((error) => {
    ensureFormalFailureSentinel(activeRoot, activeDatabasePath, activeMigrationScriptHash)
    console.error(JSON.stringify(failureEnvelope(error), null, 2))
    process.exitCode = 1
  })
}
