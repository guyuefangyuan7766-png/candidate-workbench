import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import { createApp } from '../../server/app.js'

const TERMINAL_STATUSES = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])
const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'candidate-import-resilience-'))
  const workspace = {
    root,
    databasePath: join(root, 'recruitment.db'),
    uploadRoot: join(root, 'imports')
  }
  mkdirSync(workspace.uploadRoot, { recursive: true })
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
  return workspace
}

async function startApp(workspace, options = {}) {
  const app = createApp({
    databasePath: workspace.databasePath,
    importUploadRoot: workspace.uploadRoot,
    searchIndexIdleDelayMs: 60_000,
    ...options
  })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
  cleanups.push(close)
  return {
    app,
    close,
    url: `http://127.0.0.1:${server.address().port}`
  }
}

async function readJson(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function getTask(url, taskId) {
  const response = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
  const task = await readJson(response)
  assert.equal(response.status, 200, JSON.stringify(task))
  return task
}

async function waitForTask(url, taskId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let task = await getTask(url, taskId)
  while (!predicate(task) && Date.now() < deadline) {
    if (task.terminal) break
    await new Promise((resolve) => setTimeout(resolve, 20))
    task = await getTask(url, taskId)
  }
  assert.ok(predicate(task), `Task did not reach the expected state: ${JSON.stringify(task)}`)
  return task
}

function candidateCsv(rowCount, summaryCharacters = 0) {
  const lines = [summaryCharacters ? 'name,email,self_summary' : 'name,email']
  const summary = summaryCharacters ? 'x'.repeat(summaryCharacters) : ''
  for (let index = 0; index < rowCount; index += 1) {
    const prefix = `Anonymous ${index},anonymous-${index}@example.test`
    lines.push(summaryCharacters ? `${prefix},${summary}` : prefix)
  }
  return lines.join('\n')
}

async function createPreview(url, csv, requestKey) {
  const form = new FormData()
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'anonymous.csv')
  const response = await fetch(`${url}/api/candidates/import/tasks`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestKey },
    body: form
  })
  const accepted = await readJson(response)
  assert.equal(response.status, 202, JSON.stringify(accepted))
  const task = await waitForTask(
    url,
    accepted.task_id,
    (current) => TERMINAL_STATUSES.has(current.status)
  )
  assert.equal(task.status, 'preview_ready', JSON.stringify(task))
  assert.ok(task.preview_token)
  return task
}

async function createCommit(url, previewToken, requestKey) {
  const response = await fetch(`${url}/api/candidates/import/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': requestKey
    },
    body: JSON.stringify({
      preview_token: previewToken,
      on_duplicate: 'skip',
      client_request_id: requestKey
    })
  })
  const task = await readJson(response)
  assert.ok([200, 202].includes(response.status), JSON.stringify(task))
  return task
}

function businessCounts(db) {
  return {
    candidates: Number(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count),
    batches: Number(db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count)
  }
}

test('commit timeout wins the Worker termination race and rolls back all business writes', { timeout: 45_000 }, async () => {
  const workspace = createWorkspace()
  const { app, url } = await startApp(workspace, {
    importResourceLimits: { maxCommitMs: 1_000 }
  })
  const preview = await createPreview(url, candidateCsv(8_209), 'timeout-preview')
  const accepted = await createCommit(url, preview.preview_token, 'timeout-commit')
  const terminal = await waitForTask(
    url,
    accepted.task_id,
    (task) => TERMINAL_STATUSES.has(task.status),
    20_000
  )

  assert.equal(terminal.status, 'timed_out', JSON.stringify(terminal))
  assert.equal(terminal.phase, 'timeout')
  assert.equal(terminal.error.code, 'import_commit_timeout')
  assert.equal(terminal.error.status, 504)
  assert.equal(terminal.error.retryable, true)
  assert.deepEqual(businessCounts(app.locals.db), { candidates: 0, batches: 0 })
})

test('cancelling an active commit reaches a durable cancelled state and rolls back', { timeout: 45_000 }, async () => {
  const workspace = createWorkspace()
  const { app, url } = await startApp(workspace)
  const preview = await createPreview(url, candidateCsv(8_209), 'cancel-preview')
  const accepted = await createCommit(url, preview.preview_token, 'cancel-commit')
  await waitForTask(url, accepted.task_id, (task) => task.status === 'committing')

  const cancelResponse = await fetch(
    `${url}/api/candidates/import/tasks/${encodeURIComponent(accepted.task_id)}/cancel`,
    { method: 'POST' }
  )
  const cancelling = await readJson(cancelResponse)
  assert.ok([200, 202].includes(cancelResponse.status), JSON.stringify(cancelling))
  const terminal = await waitForTask(
    url,
    accepted.task_id,
    (task) => TERMINAL_STATUSES.has(task.status)
  )

  assert.equal(terminal.status, 'cancelled', JSON.stringify(terminal))
  assert.equal(terminal.error.code, 'import_cancelled')
  assert.equal(terminal.error.retryable, false)
  assert.deepEqual(businessCounts(app.locals.db), { candidates: 0, batches: 0 })
})

test('commit Worker memory exhaustion is structured and leaves no partial import', { timeout: 60_000 }, async () => {
  const workspace = createWorkspace()
  const first = await startApp(workspace)
  const preview = await createPreview(
    first.url,
    candidateCsv(1_000, 20_000),
    'memory-preview'
  )
  await first.close()

  const second = await startApp(workspace, {
    importResourceLimits: {
      maxWorkerOldGenerationMb: 16,
      maxWorkerYoungGenerationMb: 4
    }
  })
  const accepted = await createCommit(second.url, preview.preview_token, 'memory-commit')
  const terminal = await waitForTask(
    second.url,
    accepted.task_id,
    (task) => TERMINAL_STATUSES.has(task.status),
    30_000
  )

  assert.equal(terminal.status, 'failed', JSON.stringify(terminal))
  assert.equal(terminal.error.code, 'import_commit_memory_limit_exceeded')
  assert.equal(terminal.error.status, 422)
  assert.equal(terminal.error.retryable, false)
  assert.deepEqual(businessCounts(second.app.locals.db), { candidates: 0, batches: 0 })
})

test('a durable committed result is recovered after restart and replayed without duplicate writes', { timeout: 30_000 }, async () => {
  const workspace = createWorkspace()
  const first = await startApp(workspace)
  const preview = await createPreview(first.url, candidateCsv(1), 'recovery-preview')
  const accepted = await createCommit(first.url, preview.preview_token, 'recovery-commit')
  const completed = await waitForTask(
    first.url,
    accepted.task_id,
    (task) => TERMINAL_STATUSES.has(task.status)
  )
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  assert.deepEqual(businessCounts(first.app.locals.db), { candidates: 1, batches: 1 })

  first.app.locals.db.prepare(`
    UPDATE candidate_import_tasks
    SET status = 'committed', phase = 'committed', progress = 95,
        error_json = NULL, completed_at = NULL
    WHERE id = ?
  `).run(completed.task_id)
  await first.close()

  const second = await startApp(workspace)
  const recovered = await getTask(second.url, completed.task_id)
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered))
  assert.deepEqual(recovered.result, completed.result)
  assert.equal(recovered.metrics.recovered_after_commit, true)

  const replayed = await createCommit(second.url, preview.preview_token, 'recovery-commit')
  assert.equal(replayed.status, 'completed', JSON.stringify(replayed))
  assert.deepEqual(replayed.result, completed.result)
  assert.deepEqual(businessCounts(second.app.locals.db), { candidates: 1, batches: 1 })
})

test('an interrupted commit becomes explicitly retryable after restart instead of replaying automatically', { timeout: 30_000 }, async () => {
  const workspace = createWorkspace()
  const first = await startApp(workspace)
  const preview = await createPreview(first.url, candidateCsv(1), 'interrupted-preview')
  const previewPath = first.app.locals.db.prepare(`
    SELECT preview_path FROM candidate_import_tasks WHERE id = ?
  `).get(preview.task_id).preview_path
  const persistedPreview = JSON.parse(readFileSync(previewPath, 'utf8'))
  persistedPreview.preview.createdAt = Date.now() - 2 * 60 * 60 * 1000
  persistedPreview.preview.expiresAt = Date.now() - 60 * 60 * 1000
  writeFileSync(previewPath, JSON.stringify(persistedPreview))
  const createdAt = new Date().toISOString()
  first.app.locals.db.prepare(`
    INSERT INTO candidate_import_tasks(
      id, task_type, status, phase, progress, idempotency_key,
      preview_token, request_json, metrics_json, heartbeat_at, created_at, updated_at
    ) VALUES (?, 'commit', 'committing', 'committing', 20, ?, ?, ?, '{}', ?, ?, ?)
  `).run(
    'interrupted-commit-task',
    'interrupted-commit-original',
    preview.preview_token,
    JSON.stringify({
      token: preview.preview_token,
      onDuplicate: 'skip',
      batchId: 'interrupted-commit-task'
    }),
    createdAt,
    createdAt,
    createdAt
  )
  await first.close()

  const second = await startApp(workspace)
  assert.equal(await second.app.locals.importTasks.purgeExpiredPreviews(Date.now() + 60 * 60 * 1000), 0)
  assert.equal(existsSync(previewPath), true)
  const interrupted = await getTask(second.url, 'interrupted-commit-task')
  assert.equal(interrupted.status, 'timed_out', JSON.stringify(interrupted))
  assert.equal(interrupted.phase, 'interrupted')
  assert.equal(interrupted.error.code, 'import_commit_interrupted')
  assert.equal(interrupted.error.retryable, true)
  assert.equal(interrupted.metrics.recovered_after_interruption, true)
  assert.deepEqual(businessCounts(second.app.locals.db), { candidates: 0, batches: 0 })

  const accepted = await createCommit(second.url, preview.preview_token, 'interrupted-commit-retry')
  assert.equal(accepted.task_id, 'interrupted-commit-task')
  const completed = await waitForTask(
    second.url,
    accepted.task_id,
    (task) => TERMINAL_STATUSES.has(task.status)
  )
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  assert.deepEqual(businessCounts(second.app.locals.db), { candidates: 1, batches: 1 })
})

test('a missing persisted preview is reported as a domain error after restart', { timeout: 30_000 }, async () => {
  const workspace = createWorkspace()
  const first = await startApp(workspace)
  const preview = await createPreview(first.url, candidateCsv(1), 'missing-preview')
  const previewPath = first.app.locals.db.prepare(`
    SELECT preview_path FROM candidate_import_tasks WHERE id = ?
  `).get(preview.task_id).preview_path
  assert.equal(existsSync(previewPath), true)
  await first.close()
  unlinkSync(previewPath)

  const second = await startApp(workspace)
  const response = await fetch(`${second.url}/api/candidates/import/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'missing-commit'
    },
    body: JSON.stringify({
      preview_token: preview.preview_token,
      on_duplicate: 'skip',
      client_request_id: 'missing-commit'
    })
  })
  const body = await readJson(response)

  assert.equal(response.status, 410, JSON.stringify(body))
  assert.equal(body.error.code, 'import_preview_state_missing')
  assert.deepEqual(businessCounts(second.app.locals.db), { candidates: 0, batches: 0 })
})

test('an active preview is persisted as queued on shutdown and resumes after restart', { timeout: 90_000 }, async () => {
  const workspace = createWorkspace()
  const first = await startApp(workspace)
  const form = new FormData()
  form.append('file', new Blob([candidateCsv(2_000, 20_000)], { type: 'text/csv' }), 'shutdown.csv')
  const response = await fetch(`${first.url}/api/candidates/import/tasks`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'shutdown-preview' },
    body: form
  })
  const accepted = await readJson(response)
  assert.equal(response.status, 202, JSON.stringify(accepted))

  let active = await getTask(first.url, accepted.task_id)
  const activeDeadline = Date.now() + 10_000
  while (!['validating', 'parsing', 'mapping', 'previewing'].includes(active.status) && Date.now() < activeDeadline) {
    if (active.status === 'preview_ready') break
    await new Promise((resolve) => setTimeout(resolve, 10))
    active = await getTask(first.url, accepted.task_id)
  }
  assert.ok(
    ['validating', 'parsing', 'mapping', 'previewing'].includes(active.status),
    `preview completed before shutdown probe: ${JSON.stringify(active)}`
  )

  await first.close()
  const inspectionDb = new DatabaseSync(workspace.databasePath)
  const persisted = inspectionDb.prepare(`
    SELECT status, file_path FROM candidate_import_tasks WHERE id = ?
  `).get(accepted.task_id)
  inspectionDb.close()
  assert.equal(persisted.status, 'queued')
  assert.equal(existsSync(persisted.file_path), true)

  const second = await startApp(workspace)
  const recovered = await waitForTask(
    second.url,
    accepted.task_id,
    (task) => TERMINAL_STATUSES.has(task.status),
    60_000
  )
  assert.equal(recovered.status, 'preview_ready', JSON.stringify(recovered))
  assert.ok(recovered.preview_token)
  assert.equal(existsSync(persisted.file_path), false)
})
