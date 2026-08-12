import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  createApp,
  DEFAULT_CANDIDATE_IMPORT_MAX_FILE_BYTES
} from '../../server/app.js'
import { readCandidateImportFile } from '../../server/import-file.js'

const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function startApp(options = {}) {
  const app = createApp({ databasePath: ':memory:', ...options })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    app.closeDatabase()
  })
  return { app, url: `http://127.0.0.1:${server.address().port}` }
}

async function json(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

test('candidate import exposes a configurable limit of at least 64 MiB by default', async () => {
  assert.ok(DEFAULT_CANDIDATE_IMPORT_MAX_FILE_BYTES >= 64 * 1024 * 1024)
  const uploadRoot = mkdtempSync(join(tmpdir(), 'candidate-import-config-'))
  cleanups.push(async () => rmSync(uploadRoot, { recursive: true, force: true }))
  const { url } = await startApp({ importMaxFileBytes: 1_024, importUploadRoot: uploadRoot })

  const response = await fetch(`${url}/api/candidates/import/config`)
  const body = await json(response)
  assert.equal(response.status, 200)
  assert.equal(body.max_file_size_bytes, 1_024)
  assert.equal(body.preview_row_limit, 20)
  assert.deepEqual(body.allowed_extensions, ['.csv', '.xlsx', '.xlsm', '.xls'])
  assert.equal(Object.hasOwn(body, 'max_candidate_count'), false)
})

test('candidate import rejects only the configured byte limit and removes partial temporary uploads', async () => {
  const uploadRoot = mkdtempSync(join(tmpdir(), 'candidate-import-limit-'))
  cleanups.push(async () => rmSync(uploadRoot, { recursive: true, force: true }))
  const { url } = await startApp({ importMaxFileBytes: 1_024, importUploadRoot: uploadRoot })
  const form = new FormData()
  form.append('file', new Blob([Buffer.alloc(2_048, 0x61)], { type: 'text/csv' }), 'too-large.csv')

  const response = await fetch(`${url}/api/candidates/import/preview`, { method: 'POST', body: form })
  const body = await json(response)
  assert.equal(response.status, 413)
  assert.equal(body.error.code, 'limit_file_size')
  assert.equal(body.error.details.max_file_size_bytes, 1_024)
  assert.match(body.error.message, /候选人导入文件超过 1 KiB 配置上限/)
  assert.deepEqual(readdirSync(uploadRoot), [])
})

test('successful and failed previews both remove their random upload file', async () => {
  const uploadRoot = mkdtempSync(join(tmpdir(), 'candidate-import-cleanup-'))
  cleanups.push(async () => rmSync(uploadRoot, { recursive: true, force: true }))
  const { url } = await startApp({ importUploadRoot: uploadRoot })

  const valid = new FormData()
  valid.append('file', new Blob(['name,email\nAnonymous,anonymous@example.test'], { type: 'text/csv' }), '../anonymous.csv')
  const validResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: valid })
  assert.equal(validResponse.status, 200)
  assert.equal((await json(validResponse)).filename, 'anonymous.csv')
  assert.deepEqual(readdirSync(uploadRoot), [])

  const invalid = new FormData()
  invalid.append('file', new Blob(['name\n"unterminated'], { type: 'text/csv' }), 'damaged.csv')
  const invalidResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: invalid })
  assert.equal(invalidResponse.status, 422)
  assert.equal((await json(invalidResponse)).error.code, 'import_csv_invalid')
  assert.deepEqual(readdirSync(uploadRoot), [])
})

test('CSV parsing accepts more than the former 50,000-row ceiling without a count limit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-import-row-count-'))
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'anonymous-over-50000.csv')
  const lines = ['name,email']
  for (let index = 0; index < 50_001; index += 1) {
    lines.push(`Anonymous ${index},anonymous-${index}@example.test`)
  }
  writeFileSync(path, lines.join('\n'), 'utf8')

  const parsed = await readCandidateImportFile({
    path,
    originalname: 'anonymous-over-50000.csv',
    mimetype: 'text/csv'
  })
  assert.equal(parsed.rows.length, 50_001)
  assert.equal(parsed.rows.at(-1).row_number, 50_002)
})
