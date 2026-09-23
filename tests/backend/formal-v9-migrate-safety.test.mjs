import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { migrateV9Database } from '../../server/database.js'
import {
  EXPECTED_AGENT_TASKS_SQL_SHA256,
  SOURCE_MANIFEST_FORMAT,
  applyEmbeddedV9Migration,
  armFormalSentinel,
  assertDisjointDirectoryTrees,
  assertReadyV8,
  failureEnvelope,
  maintenanceSentinelPath as migrationSentinelPath,
  migrateV9Only,
  requiredProductionFiles,
  v9DefinitionSnapshot,
  verifySourceManifest
} from '../../scripts/formal-v9-migrate.mjs'
import {
  MAINTENANCE_SENTINEL_KIND,
  acquireRuntimeSentinel,
  maintenanceSentinelPath as runtimeSentinelPath
} from '../../server/maintenance.js'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createV8Core(path, { includeAudit = true } = {}) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      stage TEXT,
      import_batch_id TEXT
    );
    CREATE TABLE agent_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE agent_messages (id TEXT PRIMARY KEY);
  `)
  if (includeAudit) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_query_audits (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 100),
        query_scope TEXT NOT NULL DEFAULT '{}',
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
        row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count >= 0),
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_query_audits_created_at_idx
        ON agent_query_audits(created_at DESC);
    `)
  }
  const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
  for (let version = 1; version <= 8; version += 1) {
    insert.run(version, version === 8 ? 'agent_sessions_and_full_business_search' : `anonymous_v${version}`, '2026-08-07T00:00:00.000Z')
  }
  db.close()
}

function readDefinition(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      definition: v9DefinitionSnapshot(db),
      migration: db.prepare('SELECT version, name FROM schema_migrations WHERE version = 9').get()
    }
  } finally {
    db.close()
  }
}

test('embedded formal V9 migration exactly matches the repository V9 schema on anonymous V8 files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-formal-v9-schema-'))
  const repositoryPath = join(directory, 'repository.db')
  const embeddedPath = join(directory, 'embedded.db')
  try {
    const migrationSource = readFileSync(resolve(PROJECT_ROOT, 'scripts/formal-v9-migrate.mjs'), 'utf8')
    assert.doesNotMatch(migrationSource, /\bimport\s*\(/)
    createV8Core(repositoryPath)
    createV8Core(embeddedPath)
    const repository = new DatabaseSync(repositoryPath)
    try {
      repository.exec('BEGIN IMMEDIATE')
      migrateV9Database(repository)
      repository.exec('COMMIT')
    } finally {
      repository.close()
    }

    await migrateV9Only(embeddedPath)
    const expected = readDefinition(repositoryPath)
    const actual = readDefinition(embeddedPath)
    assert.deepEqual(actual, expected)
    assert.equal(actual.definition.agent_tasks_sql_sha256, EXPECTED_AGENT_TASKS_SQL_SHA256)
    assert.deepEqual({ ...actual.migration }, { version: 9, name: 'agent_async_tasks_and_phase_audits' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('embedded migration rolls back every V9 object when an anonymous V8 prerequisite is missing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-formal-v9-rollback-'))
  const databasePath = join(directory, 'recruitment.db')
  try {
    createV8Core(databasePath, { includeAudit: false })
    await assert.rejects(migrateV9Only(databasePath), /agent_query_audits|no such table/i)
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 9').get(), undefined)
      assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'agent_tasks'").get(), undefined)
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE '%_v9_idx'").get().count, 0)
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ready V8 checkpoint accepts processed rows ahead of queued rows but never behind', () => {
  const baseline = {
    versions: [1, 2, 3, 4, 5, 6, 7, 8],
    migration_names: { 8: 'agent_sessions_and_full_business_search' },
    counts: {
      candidates: 8_209,
      positions: 312,
      talent_pools: 35,
      candidate_positions: 9_980,
      candidate_talent_pools: 6_224,
      search_documents_v2: 2_629_351,
      search_documents_v2_fts: 2_629_351,
      search_index_dirty_v2: 0,
      candidate_resume_documents: 112,
      candidate_resume_fts: 112,
      agent_tasks: 0
    },
    checkpoint: {
      status: 'ready',
      queued_rows: 120_806,
      processed_rows: 120_823,
      document_count: 2_629_351,
      error_code: null
    },
    coverage: { table_total: 19, table_ready: 19, field_total: 191, field_ready: 191 },
    integrity_check: 'ok',
    foreign_key_violations: 0,
    v9: { agent_tasks: false, audit_columns: [], indexes: [] }
  }
  assert.doesNotThrow(() => assertReadyV8(baseline))
  assert.throws(() => assertReadyV8({
    ...baseline,
    checkpoint: { ...baseline.checkpoint, processed_rows: baseline.checkpoint.queued_rows - 1 }
  }), (error) => error?.code === 'pre_checkpoint_incomplete')
})

test('formal database, backup, recovery copy and marker require disjoint directory trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-formal-v9-paths-'))
  const formalData = join(root, 'formal-data')
  const nestedBackup = join(formalData, 'backup')
  const recovery = join(root, 'recovery')
  const marker = join(root, 'marker')
  try {
    for (const path of [formalData, nestedBackup, recovery, marker]) mkdirSync(path, { recursive: true })
    assert.throws(() => assertDisjointDirectoryTrees([
      { label: 'formal data', path: formalData },
      { label: 'backup', path: nestedBackup }
    ]), (error) => error?.code === 'directory_trees_overlap')
    assert.doesNotThrow(() => assertDisjointDirectoryTrees([
      { label: 'formal data', path: formalData },
      { label: 'recovery', path: recovery },
      { label: 'marker', path: marker }
    ]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('source manifest must cover the complete production closure and the executing script', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-formal-v9-manifest-'))
  const manifestPath = join(directory, 'source-manifest.json')
  try {
    const required = requiredProductionFiles(PROJECT_ROOT)
    assert.equal(required.includes('.env'), false)
    assert.equal(required.includes('server/database.js'), true)
    assert.equal(required.includes('server/maintenance.js'), true)
    assert.equal(required.includes('scripts/formal-v9-migrate.mjs'), true)
    const files = required.map((path) => {
      const absolutePath = resolve(PROJECT_ROOT, path)
      return { path, bytes: statSync(absolutePath).size, sha256: sha256File(absolutePath) }
    })
    const manifest = { format: SOURCE_MANIFEST_FORMAT, root: PROJECT_ROOT, files }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const scriptHash = sha256File(resolve(PROJECT_ROOT, 'scripts/formal-v9-migrate.mjs'))
    assert.doesNotThrow(() => verifySourceManifest(PROJECT_ROOT, manifestPath, sha256File(manifestPath), scriptHash))

    manifest.files.push({ path: 'data/recruitment.db', bytes: 1, sha256: '0'.repeat(64) })
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    assert.throws(
      () => verifySourceManifest(PROJECT_ROOT, manifestPath, sha256File(manifestPath), scriptHash),
      (error) => error?.code === 'source_manifest_invalid'
    )
    manifest.files.pop()
    manifest.files = manifest.files.filter((entry) => entry.path !== 'server/database.js')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    assert.throws(
      () => verifySourceManifest(PROJECT_ROOT, manifestPath, sha256File(manifestPath), scriptHash),
      (error) => error?.code === 'source_manifest_incomplete'
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('runtime and migration use the same sentinel and maintenance ownership blocks startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-formal-v9-sentinel-'))
  const databasePath = join(root, 'anonymous', 'recruitment.db')
  mkdirSync(join(root, 'anonymous'), { recursive: true })
  try {
    const path = migrationSentinelPath(root, databasePath)
    assert.equal(path, runtimeSentinelPath(databasePath, root))
    const armed = armFormalSentinel(root, databasePath, sha256File(resolve(PROJECT_ROOT, 'scripts/formal-v9-migrate.mjs')))
    assert.equal(armed.path, path)
    assert.match(armed.sha256, /^[0-9a-f]{64}$/)
    assert.equal(armed.value.kind, MAINTENANCE_SENTINEL_KIND)
    assert.equal(armed.value.owner, 'migration')
    assert.equal(armed.value.mode, 'formal')
    assert.throws(
      () => acquireRuntimeSentinel(databasePath, root),
      (error) => error?.code === 'database_maintenance_active'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pre-armed maintenance sentinel stops start.ps1 before install, build, or service startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-formal-v9-launcher-'))
  const databasePath = join(directory, 'recruitment.db')
  const scriptHash = sha256File(resolve(PROJECT_ROOT, 'scripts/formal-v9-migrate.mjs'))
  const armed = armFormalSentinel(PROJECT_ROOT, databasePath, scriptHash)
  try {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', resolve(PROJECT_ROOT, 'start.ps1')
    ], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
        PATH: process.env.PATH ?? ''
      }
    })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /Database maintenance is active/)
    assert.equal(statSync(armed.path).isFile(), true)
  } finally {
    try { unlinkSync(armed.path) } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('formal failure envelope requires V8 file-set restore after commit and keeps V9 runtime stopped', () => {
  assert.deepEqual(failureEnvelope({ code: 'post_database_invalid' }, { formal: true, committed: true }), {
    ok: false,
    committed: true,
    restore_required: true,
    runtime_must_remain_stopped: true,
    required_action: 'restore_v8_sqlite_file_set_and_keep_current_v9_runtime_stopped',
    error: { code: 'post_database_invalid' }
  })
})
