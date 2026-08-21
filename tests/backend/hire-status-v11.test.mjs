import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'
import { openDatabase } from '../../server/database.js'

const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  })
  return { response, body: await response.json() }
}

test('V11 adds hire columns to a legacy database without rebuilding candidates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-hire-v11-'))
  const databasePath = join(directory, 'legacy.db')
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))

  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`
    CREATE TABLE stages (
      value TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_terminal INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO stages(value, label, color, position) VALUES ('新候选人', '新候选人', '#64748b', 10);
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      photo_url TEXT,
      current_company TEXT,
      current_title TEXT,
      location TEXT,
      gender TEXT,
      birth_date TEXT,
      age INTEGER,
      years_experience REAL,
      education TEXT,
      source TEXT,
      stage TEXT NOT NULL DEFAULT '新候选人',
      owner TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      expected_salary TEXT,
      source_system TEXT,
      source_record_id TEXT,
      import_batch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY(stage) REFERENCES stages(value)
    );
    INSERT INTO candidates(id, name, email, created_at, updated_at)
      VALUES ('legacy-candidate', 'Legacy Candidate', 'legacy@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `)
  legacy.close()

  let db = openDatabase(databasePath, { synchronizeSearch: false })
  const columns = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
  assert.ok(columns.has('hire_status'))
  assert.ok(columns.has('hire_date'))
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'candidates'").all().map((row) => row.name))
  assert.ok(indexes.has('candidates_hire_status_idx'))
  assert.ok(indexes.has('candidates_hire_date_idx'))
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version = 11').get().name, 'candidate_hire_status_and_date')
  assert.deepEqual(
    { ...db.prepare('SELECT id, name, email FROM candidates WHERE id = ?').get('legacy-candidate') },
    { id: 'legacy-candidate', name: 'Legacy Candidate', email: 'legacy@example.com' }
  )
  db.close()

  db = openDatabase(databasePath, { synchronizeSearch: false })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11').get().count, 1)
  db.close()
})

test('hire fields accept future dates and reject impossible dates', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)

  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Future Hire', hire_status: '待入职', hire_date: '2026-09-17' }
  })
  assert.equal(created.response.status, 201)

  const invalidPost = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Invalid Hire', hire_date: '2026-02-30' }
  })
  assert.equal(invalidPost.response.status, 422)

  const invalidPatch = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_date: '2026-02-30' }
  })
  assert.equal(invalidPatch.response.status, 422)
})

test('candidate CRUD and exports round-trip hire fields', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const hireStatus = '待入职'
  const hireDate = '2026-09-17'
  const arbitraryStatus = '自定义状态-' + 'x'.repeat(24)

  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Hire Round Trip', hire_status: hireStatus, hire_date: hireDate }
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.hire_status, hireStatus)
  assert.equal(created.body.hire_date, hireDate)

  const patched = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_status: arbitraryStatus, hire_date: '2027-01-02' }
  })
  assert.equal(patched.response.status, 200)
  assert.equal(patched.body.hire_status, arbitraryStatus)
  assert.equal(patched.body.hire_date, '2027-01-02')

  const fetched = await requestJson(`${url}/api/candidates/${created.body.id}`)
  assert.equal(fetched.body.hire_status, arbitraryStatus)
  assert.equal(fetched.body.hire_date, '2027-01-02')

  const csv = await fetch(`${url}/api/candidates/export?format=csv`)
  assert.equal(csv.status, 200)
  const csvText = Buffer.from(await csv.arrayBuffer()).toString('utf8')
  assert.match(csvText, /入职状态/)
  assert.match(csvText, /入职日期/)
  assert.match(csvText, new RegExp(arbitraryStatus))
  assert.match(csvText, /2027-01-02/)

  const xlsx = await fetch(`${url}/api/candidates/export?format=xlsx`)
  assert.equal(xlsx.status, 200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await xlsx.arrayBuffer()))
  const row = workbook.worksheets[0].getRow(2).values
  const headers = workbook.worksheets[0].getRow(1).values
  const statusIndex = headers.indexOf('入职状态')
  const dateIndex = headers.indexOf('入职日期')
  assert.ok(statusIndex > 0)
  assert.ok(dateIndex > 0)
  assert.equal(row[statusIndex], arbitraryStatus)
  assert.equal(row[dateIndex], '2027-01-02')
})

test('public documentation describes the hire fields and migration', () => {
  const documentPaths = [
    'README.md',
    'CHANGELOG.md',
    'docs/ITERATION_LOG.md',
    'docs/DATA_MODEL.md',
    'docs/API.md',
    'docs/FIELD_MAPPING.md',
    'docs/IMPORT_GUIDE.md',
    'docs/TESTING.md'
  ]
  const documents = Object.fromEntries(documentPaths.map((path) => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))
  for (const [path, contents] of Object.entries(documents)) {
    for (const field of ['hire_status', 'hire_date']) {
      assert.match(contents, new RegExp(`\\b${field}\\b`), `${path} is missing ${field}`)
    }
  }
  assert.match(documents['CHANGELOG.md'], /schema V11|V11 .*hire_status/i)
  assert.match(documents['docs/ITERATION_LOG.md'], /2026-08-21.*入职|入职.*2026-08-21/s)
  assert.match(documents['docs/DATA_MODEL.md'], /V11/)
  assert.match(documents['docs/API.md'], /hire_status[\s\S]*hire_date/)
  assert.match(documents['docs/FIELD_MAPPING.md'], /hire_status[\s\S]*hire_date/)
  assert.match(documents['docs/IMPORT_GUIDE.md'], /精确文本[“"']?空|空[”"']?视为空/)
  assert.match(documents['docs/TESTING.md'], /node --test tests[\\/]backend[\\/]hire-status-v11\.test\.mjs/)
  assert.match(Object.values(documents).join('\n'), /YYYY-MM-DD/)
})
