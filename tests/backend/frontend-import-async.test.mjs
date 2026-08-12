import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError, candidateApi, recoverImportTask } from '../../src/api.ts'
import { shouldAutoRecoverImportTask } from '../../src/import-task-state.ts'

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function commitResult(batchId = 'batch-1') {
  return {
    import_batch_id: batchId,
    imported_rows: 2,
    updated_rows: 1,
    skipped_rows: 3,
    failed_rows: 0,
    failures: []
  }
}

function previewResult(token = 'preview-1') {
  return {
    preview_token: token,
    expires_at: '2030-01-01T00:00:00.000Z',
    filename: 'anonymous.csv',
    sheet_name: 'anonymous',
    headers: ['name', 'email'],
    mapping: { name: 'name', email: 'email' },
    unmapped_headers: [],
    summary: {
      total_rows: 1,
      valid_rows: 1,
      invalid_rows: 0,
      existing_duplicates: 0,
      file_duplicates: 0
    },
    rows: [],
    preview_row_limit: 20
  }
}

class FakeEventTarget {
  listeners = new Map()

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class AcceptedTaskXHR extends FakeEventTarget {
  upload = new FakeEventTarget()
  status = 0
  responseText = ''
  withCredentials = false
  timeout = 0
  body = null
  path = ''

  open(_method, path) {
    this.path = path
  }

  getResponseHeader(name) {
    return name.toLowerCase() === 'location' ? '/api/candidates/import/tasks/preview-task-1' : null
  }

  send(body) {
    this.body = body
    AcceptedTaskXHR.last = this
    queueMicrotask(() => {
      this.upload.emit('progress', { lengthComputable: true, loaded: 10, total: 10 })
      this.status = 202
      this.responseText = JSON.stringify({
        task_id: 'preview-task-1',
        task_type: 'preview',
        status: 'queued',
        phase: 'uploaded',
        progress: 5,
        poll_after_ms: 1
      })
      this.emit('load')
    })
  }

  abort() {
    this.emit('abort')
  }
}

test('frontend import commit keeps legacy synchronous responses compatible', async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  try {
    globalThis.fetch = async (_input, init = {}) => {
      requestBody = JSON.parse(init.body)
      return jsonResponse(commitResult('legacy-batch'), 201)
    }
    const result = await candidateApi.commitImport('preview-legacy', { clientRequestId: 'legacy-request' })
    assert.equal(result.import_batch_id, 'legacy-batch')
    assert.equal(requestBody.preview_token, 'preview-legacy')
    assert.equal(requestBody.client_request_id, 'legacy-request')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend import commit polls a 202 task through real phases to its result', async () => {
  const originalFetch = globalThis.fetch
  const phases = []
  const requests = []
  let taskReads = 0
  try {
    globalThis.fetch = async (input, init = {}) => {
      const path = String(input)
      requests.push({ path, method: init.method ?? 'GET', headers: new Headers(init.headers) })
      if (path === '/api/candidates/import/commit') {
        return jsonResponse({
          task_id: 'commit-task-1',
          operation: 'commit',
          status: 'queued',
          phase: 'commit',
          poll_after_ms: 1,
          location: '/api/candidates/import/tasks/commit-task-1',
          client_request_id: 'commit-request-1'
        }, 202)
      }
      if (path === '/api/candidates/import/tasks/commit-task-1') {
        taskReads += 1
        return taskReads === 1
          ? jsonResponse({
              task_id: 'commit-task-1',
              status: 'running',
              phase: 'indexing',
              progress: 80,
              poll_after_ms: 1,
              client_request_id: 'commit-request-1'
            })
          : jsonResponse({
              task_id: 'commit-task-1',
              status: 'completed',
              phase: 'completed',
              result: commitResult('async-batch'),
              client_request_id: 'commit-request-1'
            })
      }
      throw new Error(`unexpected request: ${path}`)
    }

    const result = await candidateApi.commitImport('preview-async', {
      clientRequestId: 'commit-request-1',
      maxWaitMs: 5_000,
      onTask: (task) => phases.push(`${task.status}:${task.phase}`)
    })

    assert.equal(result.import_batch_id, 'async-batch')
    assert.deepEqual(phases, ['queued:commit', 'running:indexing', 'completed:completed'])
    assert.equal(requests[0].headers.get('Idempotency-Key'), 'commit-request-1')
    assert.equal(requests.filter((item) => item.method === 'POST').length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend import follows a Location header when an accepted response has no JSON body', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path === '/api/candidates/import/commit') {
        return new Response(null, {
          status: 202,
          headers: { Location: '/api/candidates/import/tasks/location-task-1' }
        })
      }
      if (path === '/api/candidates/import/tasks/location-task-1') {
        return jsonResponse({
          task_id: 'location-task-1',
          task_type: 'commit',
          status: 'completed',
          phase: 'completed',
          result: commitResult('location-batch')
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }
    const result = await candidateApi.commitImport('preview-location', {
      clientRequestId: 'location-request-1',
      maxWaitMs: 5_000
    })
    assert.equal(result.import_batch_id, 'location-batch')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend preview upload follows the durable preview_ready task result', async () => {
  const originalFetch = globalThis.fetch
  const originalXHR = globalThis.XMLHttpRequest
  const phases = []
  try {
    globalThis.XMLHttpRequest = AcceptedTaskXHR
    globalThis.fetch = async (input) => {
      assert.equal(String(input), '/api/candidates/import/tasks/preview-task-1')
      return jsonResponse({
        task_id: 'preview-task-1',
        task_type: 'preview',
        status: 'preview_ready',
        phase: 'preview',
        progress: 100,
        result: previewResult('preview-ready-token')
      })
    }

    const result = await candidateApi.previewImport(
      new File(['name,email\nAnonymous,anonymous@example.invalid'], 'anonymous.csv', { type: 'text/csv' }),
      undefined,
      undefined,
      {
        clientRequestId: 'preview-request-1',
        maxWaitMs: 5_000,
        onTask: (task) => phases.push(`${task.status}:${task.phase}`)
      }
    )

    assert.equal(result.preview_token, 'preview-ready-token')
    assert.deepEqual(phases, ['queued:uploaded', 'preview_ready:preview'])
    assert.equal(AcceptedTaskXHR.last.path, '/api/candidates/import/preview')
    assert.equal(AcceptedTaskXHR.last.body.get('client_request_id'), 'preview-request-1')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXHR
  }
})

test('frontend recovers a lost commit response by client request id without submitting twice', async () => {
  const originalFetch = globalThis.fetch
  let commitPosts = 0
  let recoveryReads = 0
  try {
    globalThis.fetch = async (input, init = {}) => {
      const path = String(input)
      if (path === '/api/candidates/import/commit') {
        commitPosts += 1
        throw new TypeError('connection closed after acceptance')
      }
      if (path === '/api/candidates/import/tasks?client_request_id=lost-request-1') {
        recoveryReads += 1
        return jsonResponse({
          items: [{
            task_id: 'lost-task-1',
            operation: 'commit',
            client_request_id: 'lost-request-1',
            status: 'running',
            phase: 'committing',
            poll_after_ms: 1
          }]
        })
      }
      if (path === '/api/candidates/import/tasks/lost-task-1') {
        return jsonResponse({
          task_id: 'lost-task-1',
          operation: 'commit',
          client_request_id: 'lost-request-1',
          status: 'completed',
          phase: 'completed',
          result: commitResult('recovered-batch')
        })
      }
      throw new Error(`unexpected request: ${path} ${init.method ?? 'GET'}`)
    }

    const result = await candidateApi.commitImport('preview-lost-response', {
      clientRequestId: 'lost-request-1',
      maxWaitMs: 5_000
    })
    assert.equal(result.import_batch_id, 'recovered-batch')
    assert.equal(commitPosts, 1)
    assert.equal(recoveryReads, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('task recovery rejects unrelated request ids and wrong operations', async () => {
  const originalFetch = globalThis.fetch
  const taskReads = []
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      taskReads.push(path)
      if (path.includes('/import/tasks?client_request_id=strict-request-1')) {
        return jsonResponse({
          items: [{
            task_id: 'unrelated-task',
            task_type: 'preview',
            client_request_id: 'different-request',
            status: 'preview_ready',
            result: previewResult('unrelated-preview')
          }]
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }

    await assert.rejects(
      recoverImportTask('strict-request-1', { operation: 'commit', maxWaitMs: 5_000 }),
      (error) => error instanceof ApiError && error.code === 'import_task_not_found'
    )
    assert.equal(taskReads.filter((path) => path.includes('/unrelated-task')).length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('legacy recovery accepts only one id-less task with the matching operation', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path === '/api/candidates/import/tasks?client_request_id=legacy-recovery-1') {
        return jsonResponse({
          items: [{
            task_id: 'legacy-commit-task',
            task_type: 'commit',
            status: 'completed',
            phase: 'completed',
            result: commitResult('legacy-recovered-batch')
          }]
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }

    const task = await recoverImportTask('legacy-recovery-1', { operation: 'commit', maxWaitMs: 5_000 })
    assert.equal(task.task_id, 'legacy-commit-task')
    assert.equal(task.operation, 'commit')
    assert.equal(task.result.import_batch_id, 'legacy-recovered-batch')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('legacy recovery rejects multiple id-less tasks even when one operation matches', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path.includes('/import/tasks?client_request_id=ambiguous-legacy')) {
        return jsonResponse({
          items: [
            { task_id: 'legacy-preview-task', task_type: 'preview', status: 'preview_ready', result: previewResult() },
            { task_id: 'legacy-commit-task', task_type: 'commit', status: 'completed', result: commitResult() }
          ]
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }

    await assert.rejects(
      recoverImportTask('ambiguous-legacy', { operation: 'commit', maxWaitMs: 5_000 }),
      (error) => error instanceof ApiError && error.code === 'import_task_not_found'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('legacy recovery rejects a single id-less task for the wrong operation', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path.includes('/import/tasks?client_request_id=wrong-operation-legacy')) {
        return jsonResponse({
          items: [{
            task_id: 'wrong-operation-preview-task',
            task_type: 'preview',
            status: 'preview_ready',
            result: previewResult()
          }]
        })
      }
      throw new Error(`unexpected request: ${path}`)
    }

    await assert.rejects(
      recoverImportTask('wrong-operation-legacy', { operation: 'commit', maxWaitMs: 5_000 }),
      (error) => error instanceof ApiError && error.code === 'import_task_not_found'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend surfaces durable task failure code, phase, and task id', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path === '/api/candidates/import/commit') {
        return jsonResponse({
          task_id: 'failed-task-1',
          operation: 'commit',
          status: 'failed',
          phase: 'indexing',
          client_request_id: 'failed-request-1',
          error: {
            code: 'search_index_refresh_failed',
            message: 'Business data committed; search refresh is pending.',
            status: 503,
            details: { retryable: true }
          }
        }, 202)
      }
      throw new Error(`unexpected request: ${path}`)
    }

    await assert.rejects(
      candidateApi.commitImport('preview-failed', { clientRequestId: 'failed-request-1' }),
      (error) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 503)
        assert.equal(error.code, 'search_index_refresh_failed')
        assert.equal(error.details.task_id, 'failed-task-1')
        assert.equal(error.details.phase, 'indexing')
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend preserves retryable commit metadata and its preview token', async () => {
  const originalFetch = globalThis.fetch
  let observedTask = null
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path === '/api/candidates/import/commit') {
        return jsonResponse({
          task_id: 'retryable-task-1',
          task_type: 'commit',
          client_request_id: 'retryable-request-1',
          preview_token: 'retryable-preview-1',
          status: 'failed',
          phase: 'committing',
          error: {
            code: 'database_busy',
            message: 'The database was temporarily busy.',
            status: 503,
            retryable: true
          }
        }, 202)
      }
      throw new Error(`unexpected request: ${path}`)
    }

    await assert.rejects(
      candidateApi.commitImport('retryable-preview-1', {
        clientRequestId: 'retryable-request-1',
        onTask: (task) => { observedTask = task }
      }),
      (error) => error instanceof ApiError && error.code === 'database_busy'
    )
    assert.equal(observedTask.preview_token, 'retryable-preview-1')
    assert.equal(observedTask.error.retryable, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend cancellation uses the durable task endpoint and reports terminal state', async () => {
  const originalFetch = globalThis.fetch
  const updates = []
  try {
    globalThis.fetch = async (input, init = {}) => {
      assert.equal(String(input), '/api/candidates/import/tasks/cancel-task-1/cancel')
      assert.equal(init.method, 'POST')
      return jsonResponse({
        task_id: 'cancel-task-1',
        task_type: 'preview',
        status: 'cancelled',
        phase: 'cancelled',
        progress: 10,
        error: { code: 'import_cancelled', message: 'The candidate import task was cancelled.', status: 499 }
      })
    }
    const task = await candidateApi.cancelImportTask('cancel-task-1', {
      onTask: (update) => updates.push(update.status)
    })
    assert.equal(task.status, 'cancelled')
    assert.deepEqual(updates, ['cancelled'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ImportWizard persists task identity but App auto-opens only actionable recovery states', () => {
  const wizard = readFileSync(new URL('../../src/components/ImportWizard.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
  assert.match(wizard, /candidate-import-task-v1/)
  assert.match(wizard, /candidateApi\.resumeImportTask/)
  assert.match(wizard, /candidateApi\.recoverImportTask/)
  assert.match(wizard, /clientRequestId: record\.clientRequestId/)
  assert.match(wizard, /previewToken: preview\.preview_token/)
  assert.match(wizard, /async function retryStoredCommit/)
  assert.match(wizard, /activeTask\?\.error\?\.retryable/)
  assert.match(wizard, /重试提交/)
  assert.match(wizard, /role="status" aria-live="polite"/)
  assert.match(app, /useState\(hasRecoverableImportTask\)/)
  assert.match(wizard, /shouldAutoRecoverImportTask\(task\.status\)/)
  for (const status of ['queued', 'parsing', 'mapping', 'preview_ready', 'committing']) {
    assert.equal(shouldAutoRecoverImportTask(status), true, status)
  }
  for (const status of ['failed', 'cancelled', 'completed', 'timed_out', 'expired']) {
    assert.equal(shouldAutoRecoverImportTask(status), false, status)
  }
  assert.equal(shouldAutoRecoverImportTask(undefined), true)
})
