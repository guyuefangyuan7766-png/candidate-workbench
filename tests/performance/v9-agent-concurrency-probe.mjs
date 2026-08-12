import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createAgentSessionService } from '../../server/agent-sessions.js'
import { createApp } from '../../server/app.js'
import { BUSINESS_SEARCH_INTERNALS } from '../../server/business-search.js'

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])
const ACTIVE_STATUSES = new Set(['queued', 'planning', 'querying', 'retrieving', 'composing'])
const DEFAULT_WAIT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_APP_PORT = 0
const FORMAL_DATABASE_PATH = fileURLToPath(new URL('../../data/recruitment.db', import.meta.url))
const MIN_CAPACITY_CANDIDATES = 100_000
const ANONYMOUS_SOURCE_SYSTEM = 'anonymous-benchmark'
const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm']

// Cancellation and recovery fixtures use a guaranteed-no-match term. The two
// completed tool paths use fixed anonymous-benchmark terms; their result
// message content is never inspected or included in probe output.
const SEARCH_SENTINEL = `v9probe${randomUUID().replaceAll('-', '')}`

function probeError(code, message, details = undefined) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function canonicalPath(value) {
  const resolved = resolve(value)
  const canonical = existsSync(resolved) ? realpathSync.native(resolved) : resolved
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function fileIdentity(value) {
  try {
    const stats = statSync(value, { bigint: true })
    if (!stats.isFile() || stats.ino === 0n) return null
    return `${stats.dev}:${stats.ino}`
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const FORMAL_DATABASE_CANONICAL_PATH = canonicalPath(FORMAL_DATABASE_PATH)
const FORMAL_DATABASE_FILE_IDENTITY = fileIdentity(FORMAL_DATABASE_PATH)

function parseArguments(argv) {
  let databasePath = null
  let port = DEFAULT_APP_PORT
  for (const argument of argv) {
    if (argument === '--help') {
      return { help: true }
    }
    if (argument.startsWith('--database=')) {
      if (databasePath !== null) throw probeError('invalid_arguments', 'Only one --database argument is permitted.')
      databasePath = argument.slice('--database='.length).trim()
      continue
    }
    if (argument.startsWith('--port=')) {
      const value = argument.slice('--port='.length).trim()
      port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw probeError('invalid_arguments', '--port must be an integer between 0 and 65535.')
      }
      continue
    }
    throw probeError('invalid_arguments', `Unsupported argument: ${argument}`)
  }
  if (!databasePath) throw probeError('invalid_arguments', 'Usage: node tests/performance/v9-agent-concurrency-probe.mjs --database=<absolute-anonymous-db> [--port=0]')
  if (!isAbsolute(databasePath)) throw probeError('invalid_arguments', '--database must be an absolute path.')
  return { databasePath: resolve(databasePath), port }
}

function printUsage() {
  return [
    'Usage: node tests/performance/v9-agent-concurrency-probe.mjs --database=<absolute-anonymous-db> [--port=0]',
    'The database is copied (including -wal and -shm when present) into a temporary working directory.',
    'The probe never opens or mutates the supplied database path.'
  ].join('\n')
}

function databaseSetState(source) {
  return DATABASE_FILE_SUFFIXES.map((suffix) => {
    const path = `${source}${suffix}`
    try {
      const stats = statSync(path, { bigint: true })
      if (!stats.isFile()) {
        throw probeError('database_file_set_invalid', 'A supplied database sidecar path is not a file.', {
          suffix: suffix || 'db'
        })
      }
      return {
        suffix: suffix || 'db',
        present: true,
        bytes: Number(stats.size),
        mtime_ns: String(stats.mtimeNs)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { suffix: suffix || 'db', present: false, bytes: 0, mtime_ns: null }
      }
      throw error
    }
  })
}

function sameDatabaseSet(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return entry.suffix === other?.suffix
      && entry.present === other.present
      && entry.bytes === other.bytes
      && entry.mtime_ns === other.mtime_ns
  })
}

function copyDatabaseSet(sourcePath) {
  const requestedSource = resolve(sourcePath)
  if (!existsSync(requestedSource) || !statSync(requestedSource).isFile()) {
    throw probeError('database_not_found', 'The anonymous database file does not exist.')
  }
  const source = realpathSync.native(requestedSource)
  const sourceIdentity = fileIdentity(source)
  if (
    canonicalPath(source) === FORMAL_DATABASE_CANONICAL_PATH
    || (FORMAL_DATABASE_FILE_IDENTITY !== null && sourceIdentity === FORMAL_DATABASE_FILE_IDENTITY)
  ) {
    throw probeError('formal_database_refused', 'The formal recruitment database is not an allowed probe input.')
  }

  const workingDirectory = mkdtempSync(join(tmpdir(), 'candidate-workbench-v9-agent-probe-'))
  const workingPath = join(workingDirectory, basename(source))
  const copied = []
  let sourceBefore = null
  try {
    sourceBefore = databaseSetState(source)
    if (!sourceBefore[0]?.present) {
      throw probeError('database_not_found', 'The anonymous database file does not exist.')
    }
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      const expected = sourceBefore.find((entry) => entry.suffix === (suffix || 'db'))
      if (!expected?.present) continue
      const sourceFile = `${source}${suffix}`
      const targetFile = `${workingPath}${suffix}`
      copyFileSync(sourceFile, targetFile)
      const targetBytes = statSync(targetFile).size
      if (targetBytes !== expected.bytes) {
        throw probeError('database_copy_failed', 'A copied anonymous database file has an unexpected size.', {
          suffix: suffix || 'db',
          expected_bytes: expected.bytes,
          copied_bytes: targetBytes
        })
      }
      copied.push({ suffix: suffix || 'db', bytes: targetBytes })
    }
    if (!copied.some((entry) => entry.suffix === 'db')) {
      throw probeError('database_copy_failed', 'The anonymous database main file could not be copied.')
    }
    const sourceAfter = databaseSetState(source)
    if (!sameDatabaseSet(sourceBefore, sourceAfter)) {
      throw probeError('database_source_changed', 'The supplied database file set changed while it was being copied.', {
        before: sourceBefore,
        after: sourceAfter
      })
    }
    return {
      workingDirectory,
      workingPath,
      copied,
      source_files: { before: sourceBefore, after: sourceAfter, unchanged: true }
    }
  } catch (error) {
    let sourceAfter = null
    if (sourceBefore) {
      try { sourceAfter = databaseSetState(source) } catch {}
    }
    rmSync(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (sourceBefore && sourceAfter && !sameDatabaseSet(sourceBefore, sourceAfter) && error?.code !== 'database_source_changed') {
      throw probeError('database_source_changed', 'The supplied database file set changed while it was being copied.', {
        before: sourceBefore,
        after: sourceAfter
      })
    }
    if (error?.code && error.code.startsWith('database_')) throw error
    throw probeError('database_copy_failed', 'The anonymous database snapshot could not be copied.')
  }
}

function openReadOnlyDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.enableLoadExtension?.(false)
    db.enableDefensive?.(true)
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA query_only = ON;
    `)
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }
  return db
}

function inspectDatabase(databasePath) {
  let db
  try {
    db = openReadOnlyDatabase(databasePath)
    const integrityRow = db.prepare('PRAGMA integrity_check').get()
    const integrity = String(integrityRow?.integrity_check ?? Object.values(integrityRow ?? {})[0] ?? '')
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length
    const checkpoint = db.prepare(`
      SELECT status, queued_rows, processed_rows, document_count,
             started_at, completed_at, updated_at, error_code
      FROM ${BUSINESS_SEARCH_INTERNALS.checkpointTable}
      WHERE scope = 'full'
    `).get() ?? null
    const dirtyRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.dirtyTable}`).get().count)
    const documentRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.documentsTable}`).get().count)
    const ftsRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${BUSINESS_SEARCH_INTERNALS.ftsTable}`).get().count)
    const resumeDocumentRows = Number(db.prepare('SELECT COUNT(*) AS count FROM candidate_resume_documents').get().count)
    const resumeFtsRows = Number(db.prepare('SELECT COUNT(*) AS count FROM candidate_resume_fts').get().count)
    const candidateCount = Number(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count)
    const sourceRecordCount = Number(db.prepare('SELECT COUNT(*) AS count FROM candidate_source_records').get().count)
    const positionCount = Number(db.prepare('SELECT COUNT(*) AS count FROM positions').get().count)
    const talentPoolCount = Number(db.prepare('SELECT COUNT(*) AS count FROM talent_pools').get().count)
    const provenance = {
      non_anonymous_candidates: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM candidates
        WHERE source_system IS NULL OR source_system <> ?
      `).get(ANONYMOUS_SOURCE_SYSTEM).count),
      invalid_candidate_fixture_ids: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM candidates
        WHERE id NOT GLOB 'anon-candidate-*'
          OR source_record_id IS NULL
          OR source_record_id NOT GLOB 'ANON-APPLICANT-*'
      `).get().count),
      non_anonymous_source_records: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM candidate_source_records
        WHERE source_system IS NULL OR source_system <> ?
      `).get(ANONYMOUS_SOURCE_SYSTEM).count),
      invalid_source_fixture_ids: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM candidate_source_records
        WHERE id NOT GLOB 'anon-source-*'
          OR source_record_id NOT GLOB 'ANON-SOURCE-*'
      `).get().count),
      invalid_position_fixture_ids: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM positions
        WHERE id NOT GLOB 'anon-position-*'
      `).get().count),
      non_anonymous_talent_pools: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM talent_pools
        WHERE source_system IS NULL OR source_system <> ?
      `).get(ANONYMOUS_SOURCE_SYSTEM).count),
      invalid_talent_pool_fixture_ids: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM talent_pools
        WHERE id NOT GLOB 'anon-pool-*'
      `).get().count),
      invalid_candidate_position_relations: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_positions relation
        JOIN candidates candidate ON candidate.id = relation.candidate_id
        JOIN positions position ON position.id = relation.position_id
        WHERE candidate.source_system <> ? OR position.id NOT GLOB 'anon-position-*'
      `).get(ANONYMOUS_SOURCE_SYSTEM).count),
      invalid_candidate_pool_relations: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_talent_pools relation
        JOIN candidates candidate ON candidate.id = relation.candidate_id
        JOIN talent_pools pool ON pool.id = relation.talent_pool_id
        WHERE candidate.source_system <> ?
          OR pool.source_system <> ?
          OR pool.id NOT GLOB 'anon-pool-*'
      `).get(ANONYMOUS_SOURCE_SYSTEM, ANONYMOUS_SOURCE_SYSTEM).count)
    }
    const result = {
      integrity_check: integrity,
      foreign_key_violations: foreignKeyViolations,
      candidate_count: candidateCount,
      source_record_count: sourceRecordCount,
      position_count: positionCount,
      talent_pool_count: talentPoolCount,
      anonymous_provenance: provenance,
      checkpoint: checkpoint
        ? {
            status: checkpoint.status,
            queued_rows: Number(checkpoint.queued_rows),
            processed_rows: Number(checkpoint.processed_rows),
            document_count: Number(checkpoint.document_count),
            error_code: checkpoint.error_code ?? null
          }
        : null,
      dirty_rows: dirtyRows,
      document_rows: documentRows,
      fts_rows: ftsRows,
      resume_document_rows: resumeDocumentRows,
      resume_fts_rows: resumeFtsRows
    }
    if (integrity !== 'ok' || foreignKeyViolations !== 0) {
      throw probeError('database_integrity_failed', 'The anonymous database copy failed integrity checks.', {
        integrity_check: integrity,
        foreign_key_violations: foreignKeyViolations
      })
    }
    if (
      !checkpoint
      || checkpoint.status !== 'ready'
      || Number(checkpoint.queued_rows) !== Number(checkpoint.processed_rows)
      || Number(checkpoint.queued_rows) < 1
      || dirtyRows !== 0
      || checkpoint.error_code !== null
      || Number(checkpoint.document_count) !== documentRows
      || documentRows !== ftsRows
      || documentRows < candidateCount
      || resumeDocumentRows !== resumeFtsRows
      || resumeDocumentRows < candidateCount
    ) {
      throw probeError('fts_not_ready', 'The anonymous database copy does not have a complete ready FTS index.', {
        checkpoint: result.checkpoint,
        dirty_rows: dirtyRows,
        document_rows: documentRows,
        fts_rows: ftsRows,
        resume_document_rows: resumeDocumentRows,
        resume_fts_rows: resumeFtsRows
      })
    }
    if (
      candidateCount < MIN_CAPACITY_CANDIDATES
      || sourceRecordCount < 1
      || positionCount < 1
      || talentPoolCount < 1
      || Object.values(provenance).some((count) => count !== 0)
    ) {
      throw probeError('anonymous_capacity_database_required', 'The probe accepts only a ready 100k+ anonymous benchmark database.', {
        candidate_count: candidateCount,
        minimum_candidate_count: MIN_CAPACITY_CANDIDATES,
        source_record_count: sourceRecordCount,
        position_count: positionCount,
        talent_pool_count: talentPoolCount,
        provenance_contamination: provenance
      })
    }
    return result
  } catch (error) {
    if (error?.code && ['database_integrity_failed', 'fts_not_ready', 'anonymous_capacity_database_required'].includes(error.code)) throw error
    throw probeError('database_inspection_failed', 'The anonymous database copy could not be inspected without opening the source.', {
      message: String(error?.message ?? error).slice(0, 240)
    })
  } finally {
    try { db?.close() } catch {}
  }
}

function openTaskMonitor(databasePath) {
  const db = openReadOnlyDatabase(databasePath)
  const taskStatement = db.prepare(`
    SELECT id, status, stage, result_json IS NOT NULL AS has_result,
           result_count, has_more, error_code, retryable,
           created_at, started_at, updated_at, completed_at
    FROM agent_tasks
    WHERE id = ?
  `)
  const auditStatement = db.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_query_audits
    WHERE task_id = ? AND tool_name LIKE 'agent_tool_call:%'
  `)
  const toolAuditStatement = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END), 0) AS error_count,
           MAX(duration_ms) AS max_duration_ms
    FROM agent_query_audits
    WHERE task_id = ? AND tool_name = ?
  `)
  return {
    readTasks(taskIds) {
      return taskIds.map((taskId) => {
        const row = taskStatement.get(taskId)
        if (!row) throw probeError('task_not_found', 'A probe task disappeared from the anonymous copy.', { task_id: taskId })
        return {
          task_id: row.id,
          status: row.status,
          stage: row.stage,
          has_result: Boolean(row.has_result),
          result_count: Number(row.result_count ?? 0),
          has_more: Boolean(row.has_more),
          error_code: row.error_code ?? null,
          retryable: Boolean(row.retryable),
          created_at: row.created_at,
          started_at: row.started_at ?? null,
          updated_at: row.updated_at,
          completed_at: row.completed_at ?? null
        }
      })
    },
    auditCount(taskId) {
      return Number(auditStatement.get(taskId).count)
    },
    toolAudit(taskId, toolName) {
      const row = toolAuditStatement.get(taskId, `agent_tool_call:${toolName}`)
      return {
        tool: toolName,
        count: Number(row.count),
        error_count: Number(row.error_count),
        max_duration_ms: row.max_duration_ms === null ? null : Number(row.max_duration_ms)
      }
    },
    readonlyToolAudit(taskId, toolName) {
      const row = toolAuditStatement.get(taskId, toolName)
      return {
        tool: toolName,
        count: Number(row.count),
        error_count: Number(row.error_count),
        max_duration_ms: row.max_duration_ms === null ? null : Number(row.max_duration_ms)
      }
    },
    close() {
      try { db.close() } catch {}
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function taskStateDetails(rows) {
  return rows.map((row) => ({
    task_id: row.task_id,
    status: row.status,
    stage: row.stage,
    has_result: row.has_result,
    result_count: row.result_count,
    has_more: row.has_more,
    error_code: row.error_code
  }))
}

async function waitForTaskState(monitor, taskIds, predicate, label, timeoutMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  let latest = []
  while (Date.now() < deadline) {
    latest = monitor.readTasks(taskIds)
    if (predicate(latest)) return latest
    await delay(50)
  }
  throw probeError('task_state_timeout', `Timed out waiting for ${label}.`, { label, tasks: taskStateDetails(latest) })
}

async function waitForFtsInFlight(monitor, target, timeoutMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  let latestAudit = monitor.toolAudit(target.task_id, target.tool)
  let latestReadonlyAudit = monitor.readonlyToolAudit(target.task_id, target.tool)
  while (Date.now() < deadline) {
    latest = monitor.readTasks([target.task_id])[0]
    latestAudit = monitor.toolAudit(target.task_id, target.tool)
    latestReadonlyAudit = monitor.readonlyToolAudit(target.task_id, target.tool)
    if (latest?.status === 'querying' && latestAudit.count === 0 && latestReadonlyAudit.count === 0) {
      return { task: latest, agent_audit: latestAudit, readonly_audit: latestReadonlyAudit }
    }
    if (latest && TERMINAL_STATUSES.has(latest.status)) break
    await delay(10)
  }
  throw probeError('fts_querying_not_observed', 'The expected FTS tool was not observed while it was executing.', {
    expected_tool: target.tool,
    task: latest ? taskStateDetails([latest])[0] : null,
    agent_tool_audit: latestAudit,
    readonly_tool_audit: latestReadonlyAudit
  })
}

async function readRequestBody(request) {
  const chunks = []
  try {
    for await (const chunk of request) chunks.push(chunk)
  } catch {
    return null
  }
  if (!chunks.length) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function sendJson(response, payload, status = 200) {
  if (response.destroyed) return
  try {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(payload))
  } catch {}
}

function originalQuestion(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const user = [...messages].reverse().find((message) => message?.role === 'user')
  if (typeof user?.content === 'string') return user.content
  return ''
}

function searchToolResponse(question) {
  const candidateWideSearch = question.includes('probe partial ')
  const allRecordsWideSearch = question.includes('probe completed ')
  const toolName = candidateWideSearch ? 'search_candidate_resumes' : 'search_all_records'
  const toolArguments = candidateWideSearch
    ? {
        query: 'Anonymous TypeScript',
        keywords: ['Anonymous', 'TypeScript'],
        match_mode: 'all',
        archived: 'exclude',
        page: 1,
        page_size: 20,
        evidence_limit: 1,
        include_total: false,
        fast: true
      }
    : allRecordsWideSearch
      ? {
          q: 'Anonymous',
          keywords: ['Anonymous'],
          match_mode: 'any',
          archived: 'exclude',
          page: 1,
          page_size: 20,
          evidence_limit: 1,
          include_total: false,
          fast: true
        }
      : {
          keywords: [SEARCH_SENTINEL],
          match_mode: 'any',
          archived: 'include',
          page: 1,
          page_size: 5,
          evidence_limit: 1,
          include_total: false,
          fast: true
        }
  return {
    model: 'anonymous-v9-probe-model',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `probe-search-${randomUUID()}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(toolArguments)
          }
        }]
      }
    }]
  }
}

function finalModelResponse(kind) {
  return {
    model: 'anonymous-v9-probe-model',
    choices: [{
      message: {
        role: 'assistant',
        content: `anonymous v9 probe ${kind} completed`
      }
    }]
  }
}

async function startGateway() {
  let releasePlanning
  let planningReleased = false
  const planningGate = new Promise((resolveGate) => {
    releasePlanning = () => {
      if (planningReleased) return
      planningReleased = true
      resolveGate()
    }
  })
  const metrics = {
    requests: 0,
    planning_requests: 0,
    tool_round_requests: 0,
    answer_only_requests: 0,
    partial_failures: 0,
    active: 0,
    max_active: 0
  }
  const server = http.createServer((request, response) => Promise.resolve((async () => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      sendJson(response, { error: 'not_found' }, 404)
      return
    }
    const payload = await readRequestBody(request)
    if (!payload) {
      sendJson(response, { error: 'invalid_request' }, 400)
      return
    }
    metrics.requests += 1
    metrics.active += 1
    metrics.max_active = Math.max(metrics.max_active, metrics.active)
    try {
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const hasToolMessage = messages.some((message) => message?.role === 'tool')
      const answerOnly = Array.isArray(payload.tools) && payload.tools.length === 0
      if (answerOnly) {
        metrics.answer_only_requests += 1
        sendJson(response, finalModelResponse('answer-only'))
        return
      }
      const question = originalQuestion(payload)
      if (!hasToolMessage) {
        metrics.planning_requests += 1
        await planningGate
        if (request.aborted || response.destroyed) return
        sendJson(response, searchToolResponse(question))
        return
      }
      metrics.tool_round_requests += 1
      if (question.includes('partial')) {
        metrics.partial_failures += 1
        sendJson(response, { error: 'anonymous probe composition failure' }, 503)
        return
      }
      sendJson(response, finalModelResponse(question.includes('completed') ? 'completed' : 'cancelled'))
    } finally {
      metrics.active = Math.max(0, metrics.active - 1)
    }
  })()).catch(() => {
    sendJson(response, { error: 'anonymous probe gateway error' }, 500)
  }))
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    metrics,
    releasePlanning,
    close: async () => {
      releasePlanning()
      server.closeAllConnections?.()
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  }
}

async function startAppServer(databasePath, gatewayUrl, port, rootDirectory) {
  const startedAt = performance.now()
  const app = createApp({
    databasePath,
    agentExportRoot: join(rootDirectory, 'exports'),
    importUploadRoot: join(rootDirectory, 'imports'),
    attachmentRoot: join(rootDirectory, 'attachments'),
    agentConfig: {
      baseUrl: `${gatewayUrl}/v1`,
      apiKey: 'anonymous-v9-probe-key',
      model: 'anonymous-v9-probe-model',
      syncResponseWindowMs: 80,
      maxConcurrentTasks: 2,
      maxQueuedTasks: 20,
      taskDeadlineMs: 60_000,
      modelPlanningTimeoutMs: 20_000,
      modelCompositionTimeoutMs: 20_000,
      sqlTimeoutMs: 3_000,
      ftsTimeoutMs: 8_000,
      timeoutMs: 8_000
    }
  })
  const server = http.createServer(app)
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, '127.0.0.1', resolveListen)
    })
  } catch (error) {
    try { await app.closeDatabase() } catch {}
    throw error
  }
  return {
    app,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    startup_ms: Math.max(0, Math.round(performance.now() - startedAt))
  }
}

async function closeAppServer(runtime) {
  if (!runtime) return
  runtime.server.closeAllConnections?.()
  if (runtime.server.listening) {
    await new Promise((resolveClose) => runtime.server.close(resolveClose))
  }
  await runtime.app.closeDatabase()
}

async function requestJson(baseUrl, path, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  try {
    const headers = new Headers(options.headers)
    let body = options.body
    if (body !== undefined && typeof body !== 'string') {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(body)
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal
    })
    const text = await response.text()
    let parsed = null
    if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = null }
    }
    return { response, body: parsed }
  } catch (error) {
    throw probeError('http_request_failed', 'An anonymous probe HTTP request failed.', {
      path,
      reason: error?.name === 'AbortError' ? 'timeout' : 'transport'
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function requestStatusOnly(baseUrl, path, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal })
    try { await response.body?.cancel() } catch {}
    return {
      status: response.status,
      elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      cache_control: response.headers.get('cache-control'),
      retry_after: response.headers.get('retry-after')
    }
  } catch (error) {
    throw probeError('business_api_unavailable', 'An anonymous health/status/pagination request failed.', {
      path,
      reason: error?.name === 'AbortError' ? 'timeout' : 'transport'
    })
  } finally {
    clearTimeout(timeout)
  }
}

function taskFromEnvelope(body) {
  const task = body?.task ?? body?.data ?? body
  return {
    task_id: task?.task_id ?? body?.error?.details?.task_id ?? null,
    state: body?.state ?? null,
    replayed: body?.replayed ?? null
  }
}

async function createSession(baseUrl, title) {
  const result = await requestJson(baseUrl, '/api/agent/sessions', { method: 'POST', body: { title } })
  if (result.response.status !== 201 || !result.body?.id) {
    throw probeError('session_create_failed', 'The anonymous Agent session could not be created.', { status: result.response.status })
  }
  return result.body.id
}

async function submitTask(baseUrl, sessionId, kind) {
  const clientRequestId = `v9-probe-${kind}-${randomUUID()}`
  const result = await requestJson(baseUrl, `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: {
      message: `wide FTS anonymous probe ${kind} ${SEARCH_SENTINEL}`,
      client_request_id: clientRequestId
    }
  })
  const task = taskFromEnvelope(result.body)
  if (!task.task_id || ![201, 202].includes(result.response.status)) {
    throw probeError('task_submit_failed', 'The anonymous Agent task was not accepted.', { status: result.response.status })
  }
  return { kind, session_id: sessionId, task_id: task.task_id, response_state: task.state }
}

async function cancelTask(baseUrl, taskId) {
  const result = await requestJson(baseUrl, `/api/agent/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })
  if (result.response.status !== 200) {
    throw probeError('task_cancel_failed', 'The anonymous Agent task could not be cancelled.', { status: result.response.status, task_id: taskId })
  }
  return taskFromEnvelope(result.body)
}

async function retryAnswer(baseUrl, taskId) {
  const result = await requestJson(baseUrl, `/api/agent/tasks/${encodeURIComponent(taskId)}/retry-answer`, { method: 'POST' })
  if (![200, 202].includes(result.response.status)) {
    throw probeError('task_retry_failed', 'The anonymous partial task answer retry was not accepted.', { status: result.response.status, task_id: taskId })
  }
  return taskFromEnvelope(result.body)
}

function activeCount(rows) {
  return rows.filter((row) => ACTIVE_STATUSES.has(row.status) && row.status !== 'queued').length
}

function queueCount(rows) {
  return rows.filter((row) => row.status === 'queued').length
}

function rowFor(entries, rows, kind) {
  const entry = entries.find((item) => item.kind === kind)
  return rows.find((row) => row.task_id === entry?.task_id)
}

function emptySearchSnapshot() {
  return {
    tool_results: [{
      tool: 'search_all_records',
      result: {
        items: [],
        pagination: { page: 1, page_size: 5, total: null, total_pages: null, has_more: false }
      }
    }]
  }
}

function createRecoveryTasks(databasePath) {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const service = createAgentSessionService(db)
    const makeTask = (kind, result = undefined) => {
      const session = service.createSession({ title: `anonymous v9 recovery ${kind}` })
      const turn = service.beginTurn(session.id, {
        message: `anonymous recovery ${kind} ${SEARCH_SENTINEL}`,
        client_request_id: `v9-recovery-${kind}-${randomUUID()}`
      })
      const task = service.createTask(turn, {
        task_id: randomUUID(),
        trace_id: randomUUID(),
        deadline_at: new Date(Date.now() + 60_000).toISOString()
      })
      service.updateTask(task.task_id, {
        status: result ? 'querying' : 'planning',
        stage: result ? 'querying' : 'planning',
        ...(result ? { result, result_count: 0, has_more: false } : {})
      })
      return { kind, session_id: session.id, task_id: task.task_id }
    }
    return {
      failed: makeTask('failed'),
      partial: makeTask('partial', emptySearchSnapshot())
    }
  } finally {
    try { db.close() } catch {}
  }
}

function selectedAgentStatus(body) {
  return {
    configured: Boolean(body?.configured),
    read_only: Boolean(body?.read_only),
    full_readonly: Boolean(body?.full_readonly),
    readonly_connection: Boolean(body?.readonly_connection),
    persistent_sessions: Boolean(body?.persistent_sessions),
    async_tasks: Boolean(body?.async_tasks),
    task_limits: body?.task_limits ?? null,
    vector_search: body?.vector_search
      ? { enabled: Boolean(body.vector_search.enabled), fallback: body.vector_search.fallback ?? null }
      : null
  }
}

async function runProbe(databasePath, appPort) {
  const snapshot = copyDatabaseSet(databasePath)
  let gateway
  let runtime
  let monitor
  const output = {
    probe: 'v9-agent-concurrency',
    ok: false,
    isolation: {
      source_database_used_for_app: false,
      working_copy: true,
      model_gateway_invoked: false,
      candidate_result_payloads_inspected: false
    },
    input: {
      database_filename: basename(resolve(databasePath)),
      copied_files: snapshot.copied,
      source_files: snapshot.source_files
    }
  }
  try {
    output.preflight = inspectDatabase(snapshot.workingPath)
    gateway = await startGateway()
    runtime = await startAppServer(snapshot.workingPath, gateway.url, appPort, snapshot.workingDirectory)
    output.app = { port: Number(runtime.server.address().port), startup_ms: runtime.startup_ms }

    const statusResponse = await requestJson(runtime.url, '/api/agent/status')
    if (statusResponse.response.status !== 200) {
      throw probeError('agent_status_failed', 'The anonymous Agent status endpoint did not return 200.', { status: statusResponse.response.status })
    }
    output.agent_status = selectedAgentStatus(statusResponse.body)
    if (
      !output.agent_status.configured
      || !output.agent_status.readonly_connection
      || output.agent_status.task_limits?.max_concurrent !== 2
    ) {
      throw probeError('agent_status_invalid', 'The anonymous Agent status did not expose the expected read-only/concurrency contract.', {
        status: output.agent_status
      })
    }

    monitor = openTaskMonitor(snapshot.workingPath)
    const firstWave = [
      { kind: 'running-cancel', title: 'anonymous v9 running cancellation' },
      { kind: 'partial', title: 'anonymous v9 partial result' }
    ]
    const secondWave = [
      { kind: 'queued-cancel', title: 'anonymous v9 queued cancellation' },
      { kind: 'completed', title: 'anonymous v9 completed result' }
    ]
    const entries = []
    for (const item of [...firstWave, ...secondWave]) {
      entries.push({ ...item, session_id: await createSession(runtime.url, item.title) })
    }

    const submissionStartedAt = performance.now()
    const firstSubmitted = await Promise.all(firstWave.map((item) => {
      const entry = entries.find((candidate) => candidate.kind === item.kind)
      return submitTask(runtime.url, entry.session_id, entry.kind)
    }))
    for (const submitted of firstSubmitted) Object.assign(entries.find((item) => item.kind === submitted.kind), submitted)
    await waitForTaskState(
      monitor,
      firstSubmitted.map((item) => item.task_id),
      (rows) => rows.every((row) => row.status !== 'queued' && ACTIVE_STATUSES.has(row.status)),
      'first two tasks to occupy both Agent slots'
    )

    const secondSubmitted = await Promise.all(secondWave.map((item) => {
      const entry = entries.find((candidate) => candidate.kind === item.kind)
      return submitTask(runtime.url, entry.session_id, entry.kind)
    }))
    for (const submitted of secondSubmitted) Object.assign(entries.find((item) => item.kind === submitted.kind), submitted)
    const taskIds = entries.map((entry) => entry.task_id)
    const queueObservedAt = performance.now()
    const queueRows = await waitForTaskState(
      monitor,
      taskIds,
      (rows) => activeCount(rows) === 2 && queueCount(rows) === 2,
      'two running and two queued tasks'
    )
    output.concurrency = {
      submission_ms: Math.max(0, Math.round(performance.now() - submissionStartedAt)),
      queue_observed_ms: Math.max(0, Math.round(performance.now() - queueObservedAt)),
      running_count: activeCount(queueRows),
      queued_count: queueCount(queueRows),
      queue_snapshot: taskStateDetails(queueRows),
      cancellation_modes: {}
    }
    const queuedCancelBefore = rowFor(entries, queueRows, 'queued-cancel')
    const runningCancelBefore = rowFor(entries, queueRows, 'running-cancel')
    if (queuedCancelBefore?.status !== 'queued' || !runningCancelBefore || !ACTIVE_STATUSES.has(runningCancelBefore.status) || runningCancelBefore.status === 'queued') {
      throw probeError('queue_shape_invalid', 'The named queued/running cancellation tasks did not occupy the expected states.', {
        queued_cancel: queuedCancelBefore?.status ?? null,
        running_cancel: runningCancelBefore?.status ?? null
      })
    }

    await cancelTask(runtime.url, queuedCancelBefore.task_id)
    output.concurrency.cancellation_modes.queued = queuedCancelBefore.status
    const queuedCancelledRows = await waitForTaskState(
      monitor,
      [queuedCancelBefore.task_id],
      (rows) => rows[0]?.status === 'cancelled',
      'queued task cancellation'
    )
    output.concurrency.queued_cancel = taskStateDetails(queuedCancelledRows)[0]

    await cancelTask(runtime.url, runningCancelBefore.task_id)
    output.concurrency.cancellation_modes.running = runningCancelBefore.status
    const runningCancelledRows = await waitForTaskState(
      monitor,
      [runningCancelBefore.task_id],
      (rows) => rows[0]?.status === 'cancelled',
      'running task cancellation'
    )
    output.concurrency.running_cancel = taskStateDetails(runningCancelledRows)[0]

    const ftsTargets = [
      {
        kind: 'partial',
        task_id: entries.find((entry) => entry.kind === 'partial').task_id,
        tool: 'search_candidate_resumes'
      },
      {
        kind: 'completed',
        task_id: entries.find((entry) => entry.kind === 'completed').task_id,
        tool: 'search_all_records'
      }
    ]
    gateway.releasePlanning()
    const ftsInFlight = await waitForFtsInFlight(monitor, ftsTargets[0])
    const availabilityStartedAt = performance.now()
    const availability = await Promise.all([
      requestStatusOnly(runtime.url, '/api/health'),
      requestStatusOnly(runtime.url, '/api/agent/status'),
      requestStatusOnly(runtime.url, '/api/candidates?page=1&page_size=20')
    ])
    const ftsAfterAvailability = monitor.readTasks([ftsTargets[0].task_id])[0]
    const ftsAuditAfterAvailability = monitor.toolAudit(ftsTargets[0].task_id, ftsTargets[0].tool)
    const readonlyFtsAuditAfterAvailability = monitor.readonlyToolAudit(ftsTargets[0].task_id, ftsTargets[0].tool)
    const availabilityOverlappedFts = ftsAfterAvailability?.status === 'querying'
      && ftsAuditAfterAvailability.count === 0
      && readonlyFtsAuditAfterAvailability.count === 0
    output.concurrency.api_availability = {
      observed_phase: ftsInFlight.task.status,
      expected_tool: ftsTargets[0].tool,
      agent_tool_audits_before: ftsInFlight.agent_audit.count,
      agent_tool_audits_after: ftsAuditAfterAvailability.count,
      readonly_tool_audits_before: ftsInFlight.readonly_audit.count,
      readonly_tool_audits_after: readonlyFtsAuditAfterAvailability.count,
      fts_execution_overlapped: availabilityOverlappedFts,
      elapsed_ms: Math.max(0, Math.round(performance.now() - availabilityStartedAt)),
      health: availability[0],
      agent_status: availability[1],
      candidates_pagination: availability[2]
    }
    if (availability.some((result) => result.status !== 200)) {
      throw probeError('business_api_unavailable', 'A health/status/pagination request returned a non-200 status during FTS execution.', {
        statuses: availability.map((result) => result.status)
      })
    }
    if (!availabilityOverlappedFts) {
      throw probeError('fts_api_overlap_not_observed', 'The API availability sample did not remain inside the real FTS tool execution window.', {
        expected_tool: ftsTargets[0].tool,
        task_after_sample: taskStateDetails([ftsAfterAvailability])[0],
        agent_tool_audit_after_sample: ftsAuditAfterAvailability,
        readonly_tool_audit_after_sample: readonlyFtsAuditAfterAvailability
      })
    }

    const terminalRows = await waitForTaskState(
      monitor,
      taskIds,
      (rows) => rows.every((row) => TERMINAL_STATUSES.has(row.status)),
      'all four tasks to reach terminal states'
    )
    const partialRow = rowFor(entries, terminalRows, 'partial')
    const completedRow = rowFor(entries, terminalRows, 'completed')
    const ftsToolAudits = ftsTargets.map((target) => ({
      kind: target.kind,
      tool: target.tool,
      agent: monitor.toolAudit(target.task_id, target.tool),
      readonly: monitor.readonlyToolAudit(target.task_id, target.tool)
    }))
    output.concurrency.fts_tool_audits = ftsToolAudits
    if (ftsToolAudits.some((audit) => (
      audit.agent.count !== 1
      || audit.agent.error_count !== 0
      || audit.readonly.count !== 1
      || audit.readonly.error_count !== 0
    ))) {
      throw probeError('fts_tool_failed', 'A required anonymous wide FTS tool did not complete exactly once without an error.', {
        tool_audits: ftsToolAudits
      })
    }
    if (partialRow?.status !== 'partial' || !partialRow.has_result || completedRow?.status !== 'completed') {
      throw probeError('terminal_state_invalid', 'The partial/completed task outcomes were not observed.', {
        tasks: taskStateDetails(terminalRows)
      })
    }
    const auditBeforeRetry = monitor.auditCount(partialRow.task_id)
    await retryAnswer(runtime.url, partialRow.task_id)
    const retriedRows = await waitForTaskState(
      monitor,
      [partialRow.task_id],
      (rows) => rows[0]?.status === 'completed',
      'partial task answer-only retry'
    )
    const auditAfterRetry = monitor.auditCount(partialRow.task_id)
    if (auditAfterRetry !== auditBeforeRetry) {
      throw probeError('retry_reran_tools', 'Answer-only retry added a new Agent tool audit.', {
        before: auditBeforeRetry,
        after: auditAfterRetry
      })
    }
    output.concurrency.partial = {
      before_retry: taskStateDetails([partialRow])[0],
      after_retry: taskStateDetails(retriedRows)[0],
      tool_audits_before: auditBeforeRetry,
      tool_audits_after: auditAfterRetry
    }
    output.concurrency.final_tasks = taskStateDetails(monitor.readTasks(taskIds))
    output.gateway = { ...gateway.metrics, planning_gate_released: true }

    await closeAppServer(runtime)
    runtime = null
    monitor.close()
    monitor = null
    const recoveryFixtures = createRecoveryTasks(snapshot.workingPath)
    runtime = await startAppServer(snapshot.workingPath, gateway.url, 0, snapshot.workingDirectory)
    monitor = openTaskMonitor(snapshot.workingPath)
    const recoveryIds = [recoveryFixtures.failed.task_id, recoveryFixtures.partial.task_id]
    const recoveredRows = await waitForTaskState(
      monitor,
      recoveryIds,
      (rows) => rows.every((row) => TERMINAL_STATUSES.has(row.status)),
      'recovery tasks to become terminal after app restart'
    )
    const recoveredFailed = rowFor([recoveryFixtures.failed], recoveredRows, 'failed')
    const recoveredPartial = rowFor([recoveryFixtures.partial], recoveredRows, 'partial')
    if (recoveredFailed?.status !== 'failed' || recoveredFailed.error_code !== 'agent_interrupted') {
      throw probeError('recovery_failed', 'A no-result active task was not recovered as failed.', { tasks: taskStateDetails(recoveredRows) })
    }
    if (recoveredPartial?.status !== 'partial' || !recoveredPartial.has_result || !recoveredPartial.retryable) {
      throw probeError('recovery_partial_failed', 'A retained-result active task was not recovered as partial.', { tasks: taskStateDetails(recoveredRows) })
    }
    const recoveryAuditBefore = monitor.auditCount(recoveredPartial.task_id)
    await retryAnswer(runtime.url, recoveredPartial.task_id)
    const recoveryRetriedRows = await waitForTaskState(
      monitor,
      [recoveredPartial.task_id],
      (rows) => rows[0]?.status === 'completed',
      'recovered partial answer-only retry'
    )
    const recoveryAuditAfter = monitor.auditCount(recoveredPartial.task_id)
    if (recoveryAuditAfter !== recoveryAuditBefore) {
      throw probeError('recovery_retry_reran_tools', 'Recovery answer-only retry added a new Agent tool audit.', {
        before: recoveryAuditBefore,
        after: recoveryAuditAfter
      })
    }
    output.recovery = {
      app_restart_ms: runtime.startup_ms,
      failed: taskStateDetails([recoveredFailed])[0],
      partial: taskStateDetails([recoveredPartial])[0],
      partial_after_retry: taskStateDetails(recoveryRetriedRows)[0],
      tool_audits_before: recoveryAuditBefore,
      tool_audits_after: recoveryAuditAfter
    }
    output.ok = true
    output.isolation.model_gateway_invoked = true
    return output
  } finally {
    try { monitor?.close() } catch {}
    try { await closeAppServer(runtime) } catch {}
    try { await gateway?.close() } catch {}
    try { rmSync(snapshot.workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  }
}

function safeFailure(error) {
  return {
    code: String(error?.code ?? 'probe_failed').slice(0, 120),
    message: String(error?.message ?? error ?? 'Probe failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300),
    ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {})
  }
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.log(JSON.stringify({ probe: 'v9-agent-concurrency', ok: false, error: safeFailure(error) }))
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(JSON.stringify({ probe: 'v9-agent-concurrency', ok: true, usage: printUsage() }))
    return
  }
  try {
    const result = await runProbe(options.databasePath, options.port)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ probe: 'v9-agent-concurrency', ok: false, error: safeFailure(error) }, null, 2))
    process.exitCode = 1
  }
}

await main()
