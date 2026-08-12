import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.js'
import { flushBusinessSearchDirty } from '../../server/business-search.js'

async function startApp() {
  const app = createApp({ databasePath: ':memory:' })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    app,
    url,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      app.closeDatabase()
    }
  }
}

async function readJson(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

async function waitForImportTask(url, task, timeoutMs = 10_000) {
  let current = task
  const deadline = Date.now() + timeoutMs
  while (current?.task_id && !TERMINAL_TASK_STATUSES.has(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const response = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(current.task_id)}`)
    current = await readJson(response)
    assert.equal(response.status, 200, JSON.stringify(current))
  }
  return current
}

async function createPreview(url) {
  const response = await fetch(`${url}/api/candidates/import/preview`, {
    method: 'POST',
    body: csvForm()
  })
  const preview = await readJson(response)
  assert.equal(response.status, 200, JSON.stringify(preview))
  assert.ok(preview.preview_token)
  return preview
}

async function commitPreview(url, previewToken, requestKey) {
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
  return waitForImportTask(url, task)
}

function insertFailedCommitTask(db, {
  id,
  previewToken,
  idempotencyKey,
  status = 'failed',
  retryable
}) {
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO candidate_import_tasks(
      id, task_type, status, phase, progress, idempotency_key,
      preview_token, request_json, error_json, metrics_json,
      heartbeat_at, created_at, updated_at, completed_at
    ) VALUES (?, 'commit', ?, ?, 20, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
  `).run(
    id,
    status,
    status === 'timed_out' ? 'timeout' : 'failed',
    idempotencyKey,
    previewToken,
    JSON.stringify({ token: previewToken, onDuplicate: 'skip', batchId: id }),
    JSON.stringify({
      code: status === 'timed_out' ? 'import_commit_timeout' : 'database_busy',
      message: 'Anonymous simulated commit failure.',
      status: status === 'timed_out' ? 504 : 503,
      retryable
    }),
    createdAt,
    createdAt,
    createdAt,
    createdAt
  )
}

function csvForm() {
  const form = new FormData()
  form.append(
    'file',
    new Blob(['name,email\nIdempotent Candidate,idempotent@example.test\n'], { type: 'text/csv' }),
    'idempotent.csv'
  )
  return form
}

test('retrying a completed import commit with the same idempotency key is stable', async () => {
  const { app, url, close } = await startApp()
  try {
    const preview = await createPreview(url)

    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'import-retry-regression-1'
    }
    const body = JSON.stringify({
      preview_token: preview.preview_token,
      on_duplicate: 'skip',
      client_request_id: 'import-retry-regression-1'
    })
    const firstResponse = await fetch(`${url}/api/candidates/import/commit`, {
      method: 'POST',
      headers,
      body
    })
    const first = await readJson(firstResponse)
    assert.ok([200, 201, 202].includes(firstResponse.status), JSON.stringify(first))

    let terminal = first
    if (first?.task_id && first.status !== 'completed') {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const taskResponse = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(first.task_id)}`)
        terminal = await readJson(taskResponse)
        if (['completed', 'failed', 'cancelled', 'timed_out'].includes(terminal?.status)) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(terminal.status, 'completed', JSON.stringify(terminal))
      terminal = terminal.result
    }

    const secondResponse = await fetch(`${url}/api/candidates/import/commit`, {
      method: 'POST',
      headers,
      body
    })
    const second = await readJson(secondResponse)
    assert.ok([200, 201, 202].includes(secondResponse.status), JSON.stringify(second))
    let secondResult = second
    if (second?.task_id && second.status !== 'completed') {
      const taskResponse = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(second.task_id)}`)
      const task = await readJson(taskResponse)
      assert.equal(task.status, 'completed', JSON.stringify(task))
      secondResult = task.result
    } else if (second?.task_id && second.status === 'completed') {
      secondResult = second.result
    }

    assert.equal(secondResult.import_batch_id, terminal.import_batch_id)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1)
  } finally {
    await close()
  }
})

test('completed commit task GET exposes live pending, failed, and ready search-index states', async () => {
  const { app, url, close } = await startApp()
  try {
    const preview = await createPreview(url)
    const completed = await commitPreview(url, preview.preview_token, 'search-status-task')
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal(completed.result.imported_rows, 1)
    assert.equal(completed.result.search_index.status, 'pending')
    assert.ok(completed.result.search_index.remaining_rows > 0)
    assert.equal(completed.result.search_index.resumable, true)

    app.locals.db.prepare(`
      UPDATE search_index_checkpoints_v2
      SET status = 'failed', error_code = 'anonymous_index_failure', updated_at = ?
      WHERE scope = 'full'
    `).run(new Date().toISOString())
    const failedResponse = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(completed.task_id)}`)
    const failed = await readJson(failedResponse)
    assert.equal(failedResponse.status, 200)
    assert.equal(failed.status, 'completed')
    assert.equal(failed.result.imported_rows, 1)
    assert.equal(failed.result.search_index.status, 'failed')
    assert.equal(failed.result.search_index.error_code, 'anonymous_index_failure')
    assert.equal(failed.result.search_index.resumable, true)

    while (flushBusinessSearchDirty(app.locals.db, { limit: 10 }).remaining_rows > 0) {}
    const readyResponse = await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(completed.task_id)}`)
    const ready = await readJson(readyResponse)
    assert.equal(readyResponse.status, 200)
    assert.equal(ready.status, 'completed')
    assert.equal(ready.result.imported_rows, 1)
    assert.equal(ready.result.search_index.status, 'ready')
    assert.equal(ready.result.search_index.remaining_rows, 0)
    assert.equal(ready.result.search_index.error_code, null)
    assert.equal(ready.result.search_index.resumable, false)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1)
  } finally {
    await close()
  }
})

test('retryable failed commit for the same preview resumes once without duplicate business writes', async () => {
  const { app, url, close } = await startApp()
  try {
    const preview = await createPreview(url)
    insertFailedCommitTask(app.locals.db, {
      id: 'retryable-failed-task',
      previewToken: preview.preview_token,
      idempotencyKey: 'retryable-failed-original',
      status: 'failed',
      retryable: true
    })

    const completed = await commitPreview(url, preview.preview_token, 'retryable-failed-retry')
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal(completed.task_id, 'retryable-failed-task')
    assert.equal(completed.result.imported_rows, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1)

    const recoveryResponse = await fetch(
      `${url}/api/candidates/import/tasks?client_request_id=retryable-failed-retry`
    )
    const recovery = await readJson(recoveryResponse)
    assert.equal(recoveryResponse.status, 200, JSON.stringify(recovery))
    assert.equal(recovery.items.length, 1)
    assert.equal(recovery.items[0].task_id, completed.task_id)
    assert.equal(recovery.items[0].client_request_id, 'retryable-failed-retry')

    const replayed = await commitPreview(url, preview.preview_token, 'retryable-failed-replay')
    assert.equal(replayed.status, 'completed', JSON.stringify(replayed))
    assert.equal(replayed.task_id, completed.task_id)
    assert.equal(replayed.result.import_batch_id, completed.result.import_batch_id)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1)
  } finally {
    await close()
  }
})

test('retryable timed-out commit with a durable result recovers without replaying business data', async () => {
  const { app, url, close } = await startApp()
  try {
    const preview = await createPreview(url)
    const completed = await commitPreview(url, preview.preview_token, 'timed-out-original')
    assert.equal(completed.status, 'completed', JSON.stringify(completed))

    app.locals.db.prepare(`
      UPDATE candidate_import_tasks
      SET status = 'timed_out', phase = 'timeout', progress = 80,
          error_json = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify({
        code: 'import_commit_timeout',
        message: 'Anonymous simulated timeout after the durable commit boundary.',
        status: 504,
        retryable: true
      }),
      new Date().toISOString(),
      new Date().toISOString(),
      completed.task_id
    )

    const recovered = await commitPreview(url, preview.preview_token, 'timed-out-retry')
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered))
    assert.equal(recovered.task_id, completed.task_id)
    assert.equal(recovered.result.import_batch_id, completed.result.import_batch_id)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1)
  } finally {
    await close()
  }
})

test('non-retryable failed commit for the same preview remains terminal and is not requeued', async () => {
  const { app, url, close } = await startApp()
  try {
    const preview = await createPreview(url)
    insertFailedCommitTask(app.locals.db, {
      id: 'non-retryable-failed-task',
      previewToken: preview.preview_token,
      idempotencyKey: 'non-retryable-original',
      status: 'failed',
      retryable: false
    })

    const response = await fetch(`${url}/api/candidates/import/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'non-retryable-retry'
      },
      body: JSON.stringify({
        preview_token: preview.preview_token,
        on_duplicate: 'skip',
        client_request_id: 'non-retryable-retry'
      })
    })
    const failed = await readJson(response)
    assert.ok([200, 202].includes(response.status), JSON.stringify(failed))
    assert.equal(failed.task_id, 'non-retryable-failed-task')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.retryable, false)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const durable = app.locals.importTasks.get(failed.task_id)
    assert.equal(durable.status, 'failed')
    assert.equal(app.locals.db.prepare("SELECT COUNT(*) AS count FROM candidate_import_tasks WHERE task_type = 'commit'").get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 0)
  } finally {
    await close()
  }
})
