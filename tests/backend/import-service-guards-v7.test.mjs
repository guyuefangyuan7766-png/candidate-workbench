import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, test } from 'node:test'
import { createApp } from '../../server/app.js'
import { commitBeisenImport } from '../../server/beisen-import.js'
import { ImportPreviewStore } from '../../server/import-export.js'

const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function startApp(options = {}) {
  const uploadRoot = options.importUploadRoot ?? mkdtempSync(join(tmpdir(), 'candidate-import-guards-'))
  const app = createApp({ databasePath: ':memory:', ...options, importUploadRoot: uploadRoot })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    app.closeDatabase()
    rmSync(uploadRoot, { recursive: true, force: true })
  })
  return { app, url: `http://127.0.0.1:${server.address().port}` }
}

async function responseJson(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

function candidateCsvForm(content, filename = 'anonymous.csv') {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/csv' }), filename)
  return form
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('Timed out waiting for condition')
}

test('candidate import accepts a valid file one byte below its configured size limit', async () => {
  const maxBytes = 2_048
  const { url } = await startApp({ importMaxFileBytes: maxBytes })
  const prefix = Buffer.from('name,email,notes\nAnonymous,anonymous@example.test,"', 'utf8')
  const suffix = Buffer.from('"\n', 'utf8')
  const content = Buffer.concat([
    prefix,
    Buffer.alloc(maxBytes - 1 - prefix.length - suffix.length, 0x78),
    suffix
  ])
  assert.equal(content.length, maxBytes - 1)

  const response = await fetch(`${url}/api/candidates/import/preview`, {
    method: 'POST',
    body: candidateCsvForm(content)
  })
  const body = await responseJson(response)
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.summary.total_rows, 1)
})

test('async candidate import upload aliases report the configured candidate file limit', async () => {
  const maxBytes = 128
  const { url } = await startApp({ importMaxFileBytes: maxBytes })
  for (const path of ['/api/import/tasks', '/api/candidates/import/tasks']) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      body: candidateCsvForm(Buffer.alloc(maxBytes + 1, 0x78))
    })
    const body = await responseJson(response)
    assert.equal(response.status, 413, JSON.stringify(body))
    assert.equal(body.error.code, 'limit_file_size')
    assert.equal(body.error.details.max_file_size_bytes, maxBytes)
  }
})

test('candidate import config reports the effective parser and service resource limits', async () => {
  const { url } = await startApp({
    importPreviewTtlMs: 12_345,
    importPreviewMaxEntries: 3,
    importResourceLimits: {
      maxWorksheets: 7,
      maxZipEntries: 23,
      maxParseMs: 4_321,
      maxWorkerOldGenerationMb: 321
    }
  })

  const response = await fetch(`${url}/api/candidates/import/config`)
  const body = await responseJson(response)
  assert.equal(response.status, 200)
  assert.equal(body.preview_ttl_ms, 12_345)
  assert.equal(body.preview_store_max_entries, 3)
  assert.equal(body.max_concurrent_previews, 1)
  assert.equal(body.commit_failure_detail_limit, 100)
  assert.equal(body.resource_limits.max_worksheets, 7)
  assert.equal(body.resource_limits.max_zip_entries, 23)
  assert.equal(body.resource_limits.max_parse_ms, 4_321)
  assert.equal(body.resource_limits.max_worker_old_generation_mb, 321)
  assert.ok(body.resource_limits.max_uncompressed_bytes > 0)
  assert.ok(body.resource_limits.max_entry_uncompressed_bytes > 0)
})

test('candidate preview admission rejects a concurrent upload and releases after disconnect', async () => {
  const { app, url } = await startApp()
  const boundary = `----candidate-import-${Date.now()}`
  const heldRequest = http.request(`${url}/api/candidates/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  })
  heldRequest.on('response', (response) => response.resume())
  heldRequest.on('error', () => {})
  heldRequest.write(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="held.csv"\r\n' +
    'Content-Type: text/csv\r\n\r\n' +
    'name,email\nHeld,held@example.test'
  )
  await waitFor(() => app.locals.candidateImportPreviewActive)

  const busyResponse = await fetch(`${url}/api/import/preview`, {
    method: 'POST',
    body: candidateCsvForm('name,email\nSecond,second@example.test', 'second.csv')
  })
  const busyBody = await responseJson(busyResponse)
  assert.equal(busyResponse.status, 429)
  assert.equal(busyBody.error.code, 'import_busy')
  assert.equal(busyBody.error.details.max_concurrent_previews, 1)
  assert.equal(busyResponse.headers.get('retry-after'), '1')

  heldRequest.destroy()
  await waitFor(() => !app.locals.candidateImportPreviewActive)

  const retryResponse = await fetch(`${url}/api/import/preview`, {
    method: 'POST',
    body: candidateCsvForm('name,email\nRetry,retry@example.test', 'retry.csv')
  })
  assert.equal(retryResponse.status, 200, JSON.stringify(await responseJson(retryResponse)))
})

test('ImportPreviewStore evicts the oldest noncommitting entry and expires previews', async () => {
  let currentTime = 1_000
  const store = new ImportPreviewStore({
    ttlMs: 100,
    maxEntries: 2,
    cleanupIntervalMs: 10_000,
    now: () => currentTime
  })
  const first = store.put({ name: 'first' })
  currentTime += 1
  const second = store.put({ name: 'second' })
  store.get(first.token).committing = true
  currentTime += 1
  const third = store.put({ name: 'third' })
  assert.equal(store.get(first.token).name, 'first')
  assert.equal(store.get(second.token), null)
  assert.equal(store.get(third.token).name, 'third')
  assert.equal(store.size, 2)

  store.get(first.token).committing = false
  currentTime += 101
  store.purgeExpired()
  assert.equal(store.size, 0)
  store.close()

  const periodicStore = new ImportPreviewStore({ ttlMs: 20, maxEntries: 2, cleanupIntervalMs: 5 })
  periodicStore.put({ name: 'periodic' })
  await delay(60)
  assert.equal(periodicStore.size, 0)
  periodicStore.close()
})

test('candidate import commit caps failure details without losing the failed row total', async () => {
  const { url } = await startApp()
  const lines = ['name,email']
  for (let index = 0; index < 101; index += 1) lines.push(`,invalid-${index}`)
  const previewResponse = await fetch(`${url}/api/candidates/import/preview`, {
    method: 'POST',
    body: candidateCsvForm(lines.join('\n'), 'invalid-rows.csv')
  })
  const preview = await responseJson(previewResponse)
  assert.equal(previewResponse.status, 200, JSON.stringify(preview))
  assert.equal(preview.summary.invalid_rows, 101)

  const commitResponse = await fetch(`${url}/api/candidates/import/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview_token: preview.preview_token })
  })
  const result = await responseJson(commitResponse)
  assert.equal(commitResponse.status, 201, JSON.stringify(result))
  assert.equal(result.failed_rows, 101)
  assert.equal(result.failures.length, 100)
  assert.equal(result.failure_details_returned, 100)
  assert.equal(result.failure_details_limit, 100)
  assert.equal(result.failure_details_omitted, 1)
  assert.equal(result.failure_details_truncated, true)
})

test('Beisen import commit applies the same bounded failure report', async () => {
  const { app } = await startApp()
  const preview = {
    filename: 'anonymous-beisen.xlsx',
    sheetName: 'Anonymous',
    rows: Array.from({ length: 101 }, (_, index) => ({
      row_number: index + 2,
      errors: [{ field: 'name', code: 'required', message: 'required' }]
    }))
  }

  const result = commitBeisenImport({
    db: app.locals.db,
    preview,
    batchId: 'anonymous-beisen-failure-report'
  })
  assert.equal(result.failed_rows, 101)
  assert.equal(result.failures.length, 100)
  assert.equal(result.failure_details_returned, 100)
  assert.equal(result.failure_details_limit, 100)
  assert.equal(result.failure_details_omitted, 1)
  assert.equal(result.failure_details_truncated, true)
})

test('temporary upload cleanup retries and preserves import_temp_cleanup_failed', async () => {
  let unlinkAttempts = 0
  const { app, url } = await startApp({
    importTempCleanupAttempts: 3,
    importTempCleanupRetryDelayMs: 1,
    importTempUnlink: async () => {
      unlinkAttempts += 1
      const error = new Error('simulated locked file')
      error.code = 'EPERM'
      throw error
    }
  })

  const response = await fetch(`${url}/api/candidates/import/preview`, {
    method: 'POST',
    body: candidateCsvForm('name,email\nAnonymous,anonymous@example.test')
  })
  const body = await responseJson(response)
  assert.equal(response.status, 500)
  assert.equal(body.error.code, 'import_temp_cleanup_failed')
  assert.equal(unlinkAttempts, 3)
  assert.equal(app.locals.previewStore.size, 0)
  assert.equal(app.locals.candidateImportPreviewActive, false)
})
