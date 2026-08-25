import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import { insertPosition } from '../../server/positions.js'
import { normalizeHireDate, sanitizeCandidateInput } from '../../server/validation.js'

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

test('V12 adds hire_position and its index idempotently without rebuilding candidates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-hire-v12-'))
  const databasePath = join(directory, 'v12.db')
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
      hire_status TEXT,
      hire_date TEXT,
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
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations(version, name, applied_at)
      VALUES (11, 'candidate_hire_status_and_date', '2026-08-20T00:00:00.000Z');
    INSERT INTO candidates(
      id, name, current_company, current_title, location, education, hire_status, hire_date, created_at, updated_at
    ) VALUES (
      'v12-anonymous-legacy-candidate', 'Migration Preservation Candidate', 'Northstar Studio',
      'Platform Analyst', 'Suzhou', 'Bachelor', '已入职', '2026-08-20',
      '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
    );
  `)
  legacy.close()

  let db = openDatabase(databasePath, { synchronizeSearch: false })
  let columns = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
  assert.ok(columns.has('hire_position'))
  let indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'candidates'").all().map((row) => row.name))
  assert.ok(indexes.has('candidates_hire_position_idx'))
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version = 12').get().name, 'candidate_hire_information')
  db.close()

  db = openDatabase(databasePath, { synchronizeSearch: false })
  columns = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
  indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'candidates'").all().map((row) => row.name))
  assert.ok(columns.has('hire_position'))
  assert.ok(indexes.has('candidates_hire_position_idx'))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 12').get().count, 1)
  assert.deepEqual(
    { ...db.prepare(`
      SELECT id, name, current_company, current_title, location, education, hire_status, hire_date,
        source_system, source_record_id, created_at, updated_at
      FROM candidates WHERE id = ?
    `).get('v12-anonymous-legacy-candidate') },
    {
      id: 'v12-anonymous-legacy-candidate',
      name: 'Migration Preservation Candidate',
      current_company: 'Northstar Studio',
      current_title: 'Platform Analyst',
      location: 'Suzhou',
      education: 'Bachelor',
      hire_status: '已入职',
      hire_date: '2026-08-20',
      source_system: null,
      source_record_id: null,
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:00.000Z'
    }
  )
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

test('numeric hire dates are rejected by default and accepted only for file import sanitization', () => {
  const rejected = sanitizeCandidateInput({ name: 'Numeric Date Boundary', hire_date: 46389 })
  assert.deepEqual(rejected.errors, [{ field: 'hire_date', message: '入职日期必须是有效日期' }])

  const accepted = sanitizeCandidateInput(
    { name: 'Numeric Date Boundary', hire_date: 46389 },
    { allowExcelHireDateValues: true }
  )
  assert.deepEqual(accepted.errors, [])
  assert.equal(accepted.value.hire_date, '2027-01-02')
})

test('REST candidate writes reject numeric hire dates without mutating an existing date', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'REST Numeric Boundary', hire_status: '待入职', hire_date: '2026-09-17' }
  })
  assert.equal(created.response.status, 201)

  const invalidPost = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'REST Numeric Rejection', hire_date: 46389 }
  })
  assert.equal(invalidPost.response.status, 422)

  const invalidPatch = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_date: 46389 }
  })
  assert.equal(invalidPatch.response.status, 422)

  const unchanged = await requestJson(`${url}/api/candidates/${created.body.id}`)
  assert.equal(unchanged.body.hire_date, '2026-09-17')
  assert.equal(unchanged.body.hire_status, '待入职')
})

test('hire_status preserves internal whitespace and rejects values over 200 characters', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const literalStatus = '  待  入\t职\n  '

  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Literal Hire Status', hire_status: literalStatus }
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.hire_status, literalStatus.trim())

  const exactLimit = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Exact Hire Status Limit', hire_status: 'x'.repeat(200) }
  })
  assert.equal(exactLimit.response.status, 201)
  assert.equal(exactLimit.body.hire_status, 'x'.repeat(200))

  const overLimit = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Overlong Hire Status', hire_status: 'x'.repeat(201) }
  })
  assert.equal(overLimit.response.status, 422)
  assert.match(JSON.stringify(overLimit.body), /hire_status/)
})

test('a hire date without a status defaults to 不确定 and persists the hire position', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)

  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Uncertain Hire', hire_position: '  游戏服务端开发工程师  ', hire_date: '2026/10/08' }
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.hire_status, '不确定')
  assert.equal(created.body.hire_position, '游戏服务端开发工程师')
  assert.equal(created.body.hire_date, '2026-10-08')

  const overLimit = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Overlong Hire Position', hire_position: 'x'.repeat(301) }
  })
  assert.equal(overLimit.response.status, 422)
  assert.match(JSON.stringify(overLimit.body), /hire_position/)
})

test('date-only edits do not replace an existing explicit hire status', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Explicit Hire Status', hire_status: '已入职', hire_date: '2026-08-20' }
  })
  assert.equal(created.response.status, 201)
  const patched = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_date: '2026-08-21' }
  })
  assert.equal(patched.response.status, 200)
  assert.equal(patched.body.hire_status, '已入职')
  assert.equal(patched.body.hire_date, '2026-08-21')
})

test('candidate PATCH keeps a non-empty hire date paired with a non-empty status', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'PATCH Hire Invariant', hire_status: '已入职', hire_date: '2026-08-20' }
  })
  assert.equal(created.response.status, 201)

  const explicitStatusClear = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_status: '', hire_date: '2026-08-21' }
  })
  assert.equal(explicitStatusClear.response.status, 200)
  assert.equal(explicitStatusClear.body.hire_status, '不确定')
  assert.equal(explicitStatusClear.body.hire_date, '2026-08-21')

  const restoreExplicitStatus = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_status: '待入职' }
  })
  assert.equal(restoreExplicitStatus.response.status, 200)

  const statusOnlyClear = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_status: '' }
  })
  assert.equal(statusOnlyClear.response.status, 200)
  assert.equal(statusOnlyClear.body.hire_status, '不确定')
  assert.equal(statusOnlyClear.body.hire_date, '2026-08-21')

  const clearBoth = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { hire_status: '', hire_date: '' }
  })
  assert.equal(clearBoth.response.status, 200)
  assert.equal(clearBoth.body.hire_status, null)
  assert.equal(clearBoth.body.hire_date, null)
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

test('Excel date serials update an existing Beisen-source candidate through preview and commit', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  insertCandidate(app.locals.db, {
    id: 'excel-serial-existing-candidate',
    name: 'Existing Excel Serial Candidate',
    source_system: 'beisen',
    source_record_id: 'beisen-excel-serial-source'
  }, { hydrate: false })
  const url = await listen(app)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('北森人才')
  sheet.addRow(['应聘者ID', '姓名', '入职日期'])
  sheet.addRow(['beisen-excel-serial-source', 'Existing Excel Serial Candidate', new Date(Date.UTC(2027, 0, 2))])
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(await workbook.xlsx.writeBuffer())], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), 'excel-date-serial.xlsx')

  const previewResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200)
  assert.equal(preview.profile, 'beisen_talent')
  assert.equal(preview.summary.valid_rows, 1)
  assert.equal(preview.summary.existing_duplicates, 1)
  assert.equal(preview.rows[0].candidate.hire_date, '2027-01-02')

  const commitResponse = await fetch(`${url}/api/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preview_token: preview.preview_token, on_duplicate: 'update' })
  })
  const commit = await commitResponse.json()
  assert.equal(commitResponse.status, 201)
  assert.equal(commit.updated_rows, 1)

  const detail = await (await fetch(`${url}/api/candidates/excel-serial-existing-candidate?include_sensitive=true`)).json()
  assert.equal(detail.hire_date, '2027-01-02')
})

test('CSV text that resembles an Excel serial remains an invalid hire date', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const form = new FormData()
  form.append('file', new Blob(['name,hire date\nCSV Numeric Boundary,46389\n'], { type: 'text/csv' }), 'numeric-date.csv')

  const previewResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200)
  assert.equal(preview.summary.invalid_rows, 1)
  assert.ok(preview.rows[0].errors.some((error) => error.field === 'hire_date'))
})

test('normalizeHireDate accepts finite Excel 1900 serials and rejects invalid numeric inputs', () => {
  assert.equal(normalizeHireDate(1), '1900-01-01')
  assert.equal(normalizeHireDate(59), '1900-02-28')
  assert.equal(normalizeHireDate(61), '1900-03-01')
  assert.equal(normalizeHireDate(46282.75), '2026-09-17')
  assert.equal(normalizeHireDate(46389), '2027-01-02')
  assert.equal(normalizeHireDate(2958465.75), '9999-12-31')
  assert.equal(normalizeHireDate('2027/01/02'), '2027-01-02')

  for (const value of [NaN, Infinity, -Infinity, 0, -1, 60, 60.5, 2958466, Number.MAX_VALUE]) {
    assert.equal(normalizeHireDate(value), null)
  }
  assert.equal(normalizeHireDate('46282'), null)
})

test('Beisen last position delivery field overrides ordinary position codes for the whole workbook', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('北森人才')
  sheet.addRow([
    '应聘者ID', '姓名', '入职职位', '入职日期',
    '职位编号', '最后职位类投递的职位id', '应聘者关联人才库', '最初投递渠道'
  ])
  sheet.addRow(['beisen-position-key-1', '关联职位候选人', '入职岗位A', '2026-08-20', '普通职位编号A', '最后投递职位键A', '终面通过,技术人才库', 'BOSS直聘'])
  sheet.addRow(['beisen-position-key-2', '无关联职位候选人', '入职岗位B', '2026-08-21', '普通职位编号B', '', '终面通过', '内部推荐'])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'beisen-position-key.xlsx')

  const previewResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200)
  assert.equal(preview.profile, 'beisen_talent')
  assert.equal(preview.mapping.position_external_code, '最后职位类投递的职位id')
  assert.equal(preview.summary.valid_rows, 2)
  assert.equal(preview.position_preview.link_count, 1)
  assert.equal(preview.rows[0].position.title, '最后投递职位键A')
  assert.equal(preview.rows[0].position.external_code, '最后投递职位键A')
  assert.equal(preview.rows[1].position_resolution.action, 'none')

  const commitResponse = await fetch(`${url}/api/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preview_token: preview.preview_token })
  })
  const commit = await commitResponse.json()
  assert.ok([200, 201].includes(commitResponse.status))
  assert.equal(commit.imported_rows, 2)
  assert.equal(commit.links_created, 1)

  const candidateList = await (await fetch(`${url}/api/candidates`)).json()
  const linkedCandidate = candidateList.items.find((item) => item.name === '关联职位候选人')
  const unlinkedCandidate = candidateList.items.find((item) => item.name === '无关联职位候选人')
  assert.ok(linkedCandidate)
  assert.ok(unlinkedCandidate)
  const linkedDetail = await (await fetch(`${url}/api/candidates/${linkedCandidate.id}?include_sensitive=true`)).json()
  const unlinkedDetail = await (await fetch(`${url}/api/candidates/${unlinkedCandidate.id}?include_sensitive=true`)).json()
  assert.equal(linkedDetail.hire_position, '入职岗位A')
  assert.equal(linkedDetail.hire_status, '不确定')
  assert.equal(linkedDetail.positions.length, 1)
  assert.equal(linkedDetail.positions[0].title, '最后投递职位键A')
  assert.equal(linkedDetail.talent_pools.length, 2)
  assert.ok(linkedDetail.source_records.some((record) => record.record_type === 'source_first' && record.source_name === 'BOSS直聘'))
  assert.equal(unlinkedDetail.hire_position, '入职岗位B')
  assert.equal(unlinkedDetail.positions.length, 0)
})

test('Beisen preserves an overlong last-delivery key while materializing a valid draft title', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const url = await listen(app)
  const externalKey = 'K'.repeat(201)
  const expectedTitle = 'K'.repeat(200)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('北森人才')
  sheet.addRow(['应聘者ID', '姓名', '最后职位类投递的职位id'])
  sheet.addRow(['beisen-overlong-position-key', '超长职位键候选人', externalKey])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'beisen-overlong-position-key.xlsx')

  const previewResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200)
  assert.equal(preview.rows[0].position.title, expectedTitle)
  assert.equal(preview.rows[0].position.external_code, externalKey)
  assert.equal(preview.rows[0].position.source_record_id, externalKey)

  const commitResponse = await fetch(`${url}/api/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preview_token: preview.preview_token })
  })
  const commit = await commitResponse.json()
  assert.ok([200, 201].includes(commitResponse.status))
  assert.equal(commit.positions_created, 1)

  const candidates = await (await fetch(`${url}/api/candidates`)).json()
  const candidate = candidates.items.find((item) => item.name === '超长职位键候选人')
  assert.ok(candidate)
  const detail = await (await fetch(`${url}/api/candidates/${candidate.id}?include_sensitive=true`)).json()
  assert.equal(detail.positions.length, 1)
  assert.equal(detail.positions[0].title, expectedTitle)
  assert.equal(detail.positions[0].external_code, externalKey)
  assert.equal(detail.positions[0].source_record_id, externalKey)
})

test('Beisen last delivery resolves duplicate position titles from candidate application history', async () => {
  const app = createApp({ databasePath: ':memory:', synchronizeSearch: false })
  cleanups.push(async () => app.closeDatabase())
  const candidate = insertCandidate(app.locals.db, {
    id: 'beisen-history-candidate',
    name: '历史申请候选人',
    source_system: 'beisen',
    source_record_id: 'C-HISTORY-1'
  }, { hydrate: false })
  const olderPosition = insertPosition(app.locals.db, {
    title: '重复职位(J10001)',
    source_system: 'beisen',
    source_record_id: 'J10001',
    external_code: 'J10001'
  })
  const latestPosition = insertPosition(app.locals.db, {
    title: '重复职位(J10002)',
    source_system: 'beisen',
    source_record_id: 'J10002',
    external_code: 'J10002'
  })
  const sourceInsert = app.locals.db.prepare(`
    INSERT INTO candidate_position_sources(
      id, candidate_id, position_id, source_system, source_application_id,
      applied_at, raw_payload, sensitivity, created_at, updated_at
    ) VALUES (?, ?, ?, 'beisen', ?, NULL, ?, 'high', ?, ?)
  `)
  sourceInsert.run(
    'history-source-old', candidate.id, olderPosition.id, 'history-app-old',
    JSON.stringify({ '最后投递时间': '2023-01-01 10:00:00', '职位名称': '重复职位' }),
    '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
  )
  sourceInsert.run(
    'history-source-latest', candidate.id, latestPosition.id, 'history-app-latest',
    JSON.stringify({ '最后投递时间': '2023-02-01 10:00:00', '职位名称': '重复职位' }),
    '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
  )

  const url = await listen(app)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('北森人才')
  sheet.addRow(['应聘者ID', '姓名', '入职日期', '最后职位类投递的职位id', '最后职位类投递时间'])
  sheet.addRow(['C-HISTORY-1', '历史申请候选人', '2026-08-20', '重复职位', '2023-02-01 10:00:00'])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'beisen-history-position.xlsx')
  const previewResponse = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200)
  assert.equal(preview.summary.valid_rows, 1)
  assert.equal(preview.position_preview.link_count, 1)
  assert.equal(preview.rows[0].position_resolution.action, 'match')
  assert.equal(preview.rows[0].position_resolution.position_id, latestPosition.id)
  assert.equal(preview.rows[0].position.external_code, 'J10002')

  const commitResponse = await fetch(`${url}/api/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preview_token: preview.preview_token })
  })
  const commit = await commitResponse.json()
  assert.equal(commitResponse.status, 201)
  assert.equal(commit.links_created, 1)
  const detail = await (await fetch(`${url}/api/candidates/${candidate.id}?include_sensitive=true`)).json()
  assert.equal(detail.positions.length, 1)
  assert.equal(detail.positions[0].id, latestPosition.id)
  assert.equal(detail.positions[0].external_code, 'J10002')
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM positions').get().count, 2)
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
    'docs/TESTING.md',
    'docs/ROADMAP.md',
    'docs/DECISIONS.md',
    'docs/README.md',
    'docs/UI_DESIGN.md',
    'docs/PRODUCT_SPEC.md'
  ]
  const documents = Object.fromEntries(documentPaths.map((path) => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]))
  for (const [path, contents] of Object.entries(documents)) {
    for (const field of ['hire_status', 'hire_date', 'hire_position']) {
      assert.match(contents, new RegExp(`\\b${field}\\b`), `${path} is missing ${field}`)
    }
  }
  assert.match(documents['CHANGELOG.md'], /schema V12|V12 .*hire_position/i)
  assert.match(documents['docs/ITERATION_LOG.md'], /2026-08-21.*入职|入职.*2026-08-21/s)
  assert.match(documents['docs/DATA_MODEL.md'], /V11/)
  assert.match(documents['docs/API.md'], /hire_status[\s\S]*hire_date/)
  assert.match(documents['docs/FIELD_MAPPING.md'], /hire_status[\s\S]*hire_date/)
  assert.match(documents['docs/FIELD_MAPPING.md'], /`HIRE`/)
  assert.match(documents['docs/FIELD_MAPPING.md'], /F1#84[\s\S]*`HIRE`/)
  assert.match(documents['docs/FIELD_MAPPING.md'], /F3#124[\s\S]*`HIRE`/)
  assert.match(documents['docs/IMPORT_GUIDE.md'], /精确文本[“"']?空|空[”"']?视为空/)
  assert.match(documents['docs/TESTING.md'], /node --test tests[\\/]backend[\\/]hire-status-v11\.test\.mjs/)
  assert.match(documents['docs/TESTING.md'], /V1-V11/)
  assert.match(documents['docs/TESTING.md'], /hire-status-workbooks\.test\.mjs/)
  assert.match(documents['docs/ROADMAP.md'], /0\.3\.2.*V11.*入职/s)
  assert.match(documents['docs/DECISIONS.md'], /ADR-037.*入职信息/s)
  assert.match(documents['docs/README.md'], /V11.*候选人入职信息/)
  assert.match(documents['docs/README.md'], /V12.*hire_position/)
  assert.match(documents['docs/UI_DESIGN.md'], /入职信息[\s\S]*hire_status[\s\S]*hire_date/)
  assert.match(documents['docs/PRODUCT_SPEC.md'], /候选人入职信息[\s\S]*hire_status[\s\S]*hire_date/)
  assert.match(Object.values(documents).join('\n'), /不确定/)
  assert.match(Object.values(documents).join('\n'), /三项.*全空[\s\S]*不展示|全空.*入职信息.*区块/)
  assert.match(documents['docs/DATA_MODEL.md'], /V8[\s\S]*(同步触发器|搜索文档回填)/)
  assert.match(documents['docs/DATA_MODEL.md'], /V9[\s\S]*agent_tasks/)
  assert.match(documents['docs/DATA_MODEL.md'], /V10[\s\S]*durable_attachment_import_batches/)
  assert.match(Object.values(documents).join('\n'), /YYYY-MM-DD/)
})
