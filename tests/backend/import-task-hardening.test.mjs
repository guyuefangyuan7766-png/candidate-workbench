import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createApp } from '../../server/app.js'
import { candidateApi } from '../../src/api.ts'

const TERMINAL_STATUSES = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])
const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function startApp(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-import-hardening-'))
  const databasePath = join(root, 'recruitment.db')
  const uploadRoot = join(root, 'imports')
  mkdirSync(uploadRoot, { recursive: true })
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }))

  const app = createApp({
    databasePath,
    importUploadRoot: uploadRoot,
    searchIndexIdleDelayMs: 60_000,
    ...options
  })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  })
  return {
    app,
    uploadRoot,
    url: `http://127.0.0.1:${server.address().port}`
  }
}

async function json(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function createPreview(url, requestKey, csv) {
  const form = new FormData()
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'anonymous.csv')
  const response = await fetch(`${url}/api/candidates/import/tasks`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestKey },
    body: form
  })
  return { response, body: await json(response) }
}

async function waitForTask(url, taskId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let task
  do {
    const response = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    task = await json(response)
    assert.equal(response.status, 200, JSON.stringify(task))
    if (TERMINAL_STATUSES.has(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  assert.fail(`Import task did not reach a terminal state: ${JSON.stringify(task)}`)
}

test('preview idempotency rejects a different file instead of returning an unrelated preview', async () => {
  const { app, url } = await startApp()
  const firstFile = 'name,email\nFirst,first@example.test'
  const first = await createPreview(url, 'same-preview-key', firstFile)
  assert.equal(first.response.status, 202, JSON.stringify(first.body))
  assert.equal((await waitForTask(url, first.body.task_id)).status, 'preview_ready')

  const replay = await createPreview(url, 'same-preview-key', firstFile)
  assert.equal(replay.response.status, 202, JSON.stringify(replay.body))
  assert.equal(replay.body.task_id, first.body.task_id)
  assert.equal(replay.body.status, 'preview_ready')

  const second = await createPreview(url, 'same-preview-key', 'name,email\nSecond,second@example.test')
  assert.equal(second.response.status, 409, JSON.stringify(second.body))
  assert.equal(second.body.error.code, 'import_preview_idempotency_conflict')
  assert.equal(
    app.locals.db.prepare("SELECT COUNT(*) AS count FROM candidate_import_tasks WHERE task_type = 'preview'").get().count,
    1
  )
})

test('preview idempotency cleanup failures are surfaced and retried by the upload route', async () => {
  let armed = false
  let cleanupAttempts = 0
  const { app, uploadRoot, url } = await startApp({
    importTempCleanupAttempts: 1,
    importTempCleanupRetryDelayMs: 1,
    importTempUnlink: async (path) => {
      if (armed) {
        cleanupAttempts += 1
        if (cleanupAttempts === 1) {
          const error = new Error('Anonymous simulated duplicate cleanup failure.')
          error.code = 'EPERM'
          throw error
        }
      }
      return unlink(path)
    }
  })
  const csv = 'name,email\nCleanup retry,cleanup-retry@example.test'
  const first = await createPreview(url, 'cleanup-retry-key', csv)
  assert.equal(first.response.status, 202, JSON.stringify(first.body))
  assert.equal((await waitForTask(url, first.body.task_id)).status, 'preview_ready')
  const filesBeforeReplay = readdirSync(uploadRoot).sort()

  armed = true
  const replay = await createPreview(url, 'cleanup-retry-key', csv)
  assert.equal(replay.response.status, 500, JSON.stringify(replay.body))
  assert.equal(replay.body.error.code, 'import_temp_cleanup_failed')
  assert.equal(cleanupAttempts, 2)
  assert.deepEqual(readdirSync(uploadRoot).sort(), filesBeforeReplay)
  assert.equal(
    app.locals.db.prepare("SELECT COUNT(*) AS count FROM candidate_import_tasks WHERE task_type = 'preview'").get().count,
    1
  )
})

test('SQLite write contention is reported as a retryable database_busy response', async () => {
  const lockedImportTasks = {
    hasActiveCommit() { return false },
    async createPreviewTask() {
      const error = new Error('database is locked')
      error.code = 'ERR_SQLITE_ERROR'
      throw error
    },
    async close() {}
  }
  const { url } = await startApp({ importTaskService: lockedImportTasks })
  const response = await createPreview(
    url,
    'database-busy-preview',
    'name,email\nBusy,busy@example.test'
  )

  assert.equal(response.response.status, 503, JSON.stringify(response.body))
  assert.equal(response.body.error.code, 'database_busy')
  assert.equal(response.response.headers.get('retry-after'), '5')
})

test('expired previews remove persisted payloads and no longer expose their result', async () => {
  const { app, url } = await startApp()
  const accepted = await createPreview(url, 'expiring-preview', 'name,email\nExpired,expired@example.test')
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body))
  const ready = await waitForTask(url, accepted.body.task_id)
  assert.equal(ready.status, 'preview_ready')
  assert.ok(ready.result)

  const persisted = app.locals.db.prepare(`
    SELECT preview_path FROM candidate_import_tasks WHERE id = ?
  `).get(ready.task_id)
  assert.equal(existsSync(persisted.preview_path), true)
  assert.equal(await app.locals.importTasks.purgeExpiredPreviews(Date.now() + 60 * 60 * 1000), 1)

  const expiredResponse = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(ready.task_id)}`)
  const expired = await json(expiredResponse)
  assert.equal(expired.status, 'failed')
  assert.equal(expired.phase, 'expired')
  assert.equal(expired.error.code, 'import_preview_expired')
  assert.equal(Object.hasOwn(expired, 'result'), false)
  assert.equal(existsSync(persisted.preview_path), false)
  const storedResult = app.locals.db.prepare('SELECT result_json FROM candidate_import_tasks WHERE id = ?').get(ready.task_id)
  assert.equal(JSON.parse(storedResult.result_json), null)
})

test('a failure after preview persistence removes both temporary files', async () => {
  const { app, uploadRoot, url } = await startApp()
  const originalRemoveUpload = app.locals.importTasks.removeUpload.bind(app.locals.importTasks)
  let failedOnce = false
  app.locals.importTasks.removeUpload = async (path) => {
    if (!failedOnce && !String(path).endsWith('.preview.json')) {
      failedOnce = true
      const error = new Error('Anonymous simulated upload cleanup failure.')
      error.code = 'EPERM'
      throw error
    }
    return originalRemoveUpload(path)
  }

  const accepted = await createPreview(url, 'persist-cleanup-preview', 'name,email\nCleanup,cleanup@example.test')
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body))
  const failed = await waitForTask(url, accepted.body.task_id)
  assert.equal(failed.status, 'failed', JSON.stringify(failed))
  assert.equal(readdirSync(uploadRoot).length, 0)
})

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('frontend task polling retries transient HTTP failures without resubmitting the commit', async () => {
  const originalFetch = globalThis.fetch
  let commitPosts = 0
  let taskReads = 0
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path === '/api/candidates/import/commit') {
        commitPosts += 1
        return jsonResponse({
          task_id: 'transient-poll-task',
          task_type: 'commit',
          status: 'queued',
          phase: 'queued',
          poll_after_ms: 1
        }, 202)
      }
      if (path === '/api/candidates/import/tasks/transient-poll-task') {
        taskReads += 1
        if (taskReads === 1) {
          return jsonResponse({ error: { code: 'database_busy', message: 'Temporarily busy.' } }, 503)
        }
        if (taskReads === 2) {
          return jsonResponse({ error: { code: 'too_early', message: 'Try again.' } }, 425)
        }
        if (taskReads === 3) {
          return jsonResponse({ error: { code: 'rate_limited', message: 'Try again.' } }, 429)
        }
        return jsonResponse({
          task_id: 'transient-poll-task',
          task_type: 'commit',
          status: 'completed',
          phase: 'completed',
          result: {
            import_batch_id: 'transient-poll-batch',
            imported_rows: 1,
            updated_rows: 0,
            skipped_rows: 0,
            failed_rows: 0
          }
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const result = await candidateApi.commitImport('transient-preview', {
      clientRequestId: 'transient-poll-request',
      maxWaitMs: 5_000
    })
    assert.equal(result.import_batch_id, 'transient-poll-batch')
    assert.equal(commitPosts, 1)
    assert.equal(taskReads, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})
