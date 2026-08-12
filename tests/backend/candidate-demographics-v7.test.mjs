import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'
import { openDatabase } from '../../server/database.js'

const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function startApp() {
  const app = createApp({ databasePath: ':memory:' })
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
  return `http://127.0.0.1:${server.address().port}`
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

test('V7 adds demographic columns and index without rebuilding a legacy candidates table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-demographics-v7-'))
  const databasePath = join(directory, 'legacy.db')
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, photo_url TEXT,
      current_company TEXT, current_title TEXT, location TEXT, years_experience REAL,
      education TEXT, source TEXT, stage TEXT NOT NULL DEFAULT '新候选人', owner TEXT,
      tags TEXT NOT NULL DEFAULT '[]', expected_salary TEXT, source_system TEXT,
      source_record_id TEXT, import_batch_id TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, archived_at TEXT
    );
    INSERT INTO candidates(id, name, email, created_at, updated_at)
    VALUES ('legacy-demographics', '旧库匿名候选人', 'legacy@example.test', '2026-01-01', '2026-01-01');
  `)
  legacy.close()

  const migrated = openDatabase(databasePath)
  try {
    const columns = new Set(migrated.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
    assert.equal(columns.has('gender'), true)
    assert.equal(columns.has('birth_date'), true)
    assert.equal(columns.has('age'), true)
    assert.equal(migrated.prepare('SELECT name FROM candidates WHERE id = ?').get('legacy-demographics').name, '旧库匿名候选人')
    assert.equal(
      migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'candidates_gender_idx'").get().count,
      1
    )
    assert.equal(migrated.prepare('SELECT name FROM schema_migrations WHERE version = 7').get().name, 'candidate_demographics_and_large_import')
  } finally {
    migrated.close()
  }
})

test('candidate demographics are validated, preserved, filtered server-side, and exported consistently', async () => {
  const url = await startApp()
  const male = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: {
      name: '匿名男性候选人',
      email: 'male@example.test',
      gender: '男性',
      birth_date: '1991/02/03',
      age: '35岁',
      source_system: 'anonymous-fixture',
      source_record_id: 'APPLICANT-0001'
    }
  })
  assert.equal(male.response.status, 201)
  assert.equal(male.body.gender, '男')
  assert.equal(male.body.birth_date, '1991-02-03')
  assert.equal(male.body.age, 35)

  const female = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: '匿名女性候选人', email: 'female@example.test', gender: 'female', age: 29 }
  })
  assert.equal(female.response.status, 201)
  assert.equal(female.body.gender, '女')

  const invalid = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: '无效人口字段', gender: '猜测值', birth_date: '2030-01-01', age: 121 }
  })
  assert.equal(invalid.response.status, 422)
  assert.deepEqual(
    invalid.body.error.details.map((item) => item.field).sort(),
    ['age', 'birth_date', 'gender']
  )

  const filtered = await requestJson(`${url}/api/candidates?gender=male&page=1&page_size=1`)
  assert.equal(filtered.response.status, 200)
  assert.equal(filtered.body.pagination.total, 1)
  assert.equal(filtered.body.items[0].id, male.body.id)

  const invalidFilter = await requestJson(`${url}/api/candidates?gender=unsupported`)
  assert.equal(invalidFilter.response.status, 400)
  assert.equal(invalidFilter.body.error.code, 'invalid_query')

  const patch = await requestJson(`${url}/api/candidates/${male.body.id}`, {
    method: 'PATCH',
    body: { current_title: '更新后的职位' }
  })
  assert.equal(patch.response.status, 200)
  assert.equal(patch.body.gender, '男')
  assert.equal(patch.body.birth_date, '1991-02-03')
  assert.equal(patch.body.age, 35)
  assert.equal(patch.body.source_record_id, 'APPLICANT-0001')

  const detail = await requestJson(`${url}/api/candidates/${male.body.id}`)
  assert.equal(detail.body.source_record_id, 'APPLICANT-0001')
  assert.equal(detail.body.gender, '男')

  const exported = await fetch(`${url}/api/candidates/export?format=csv&gender=${encodeURIComponent('女')}`)
  assert.equal(exported.status, 200)
  const csv = await exported.text()
  assert.match(csv, /匿名女性候选人/)
  assert.doesNotMatch(csv, /匿名男性候选人/)
})

test('CSV and Beisen workbook imports retain gender, birth date, age, and external applicant number', async () => {
  const url = await startApp()
  const csvForm = new FormData()
  csvForm.append('file', new Blob([
    '\uFEFF姓名,邮箱,性别,出生日期,年龄\n匿名 CSV 候选人,csv@example.test,女,1994-06-08,31\n'
  ], { type: 'text/csv' }), 'anonymous-demographics.csv')
  const csvPreview = await requestJson(`${url}/api/candidates/import/preview`, { method: 'POST', body: csvForm })
  assert.equal(csvPreview.response.status, 200)
  assert.equal(csvPreview.body.summary.valid_rows, 1)
  const csvCommit = await requestJson(`${url}/api/candidates/import/commit`, {
    method: 'POST',
    body: { preview_token: csvPreview.body.preview_token }
  })
  assert.equal(csvCommit.response.status, 201)

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('北森匿名数据')
  sheet.addRow(['应聘者ID', '姓名', '邮箱', '性别', '出生日期', '年龄'])
  sheet.addRow(['BEISEN-ANON-0001', '匿名北森候选人', 'beisen@example.test', '男', '1990年12月1日', '35岁'])
  const xlsxForm = new FormData()
  xlsxForm.append('file', new Blob([Buffer.from(await workbook.xlsx.writeBuffer())], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), 'anonymous-beisen.xlsx')
  const xlsxPreview = await requestJson(`${url}/api/candidates/import/preview`, { method: 'POST', body: xlsxForm })
  assert.equal(xlsxPreview.response.status, 200)
  assert.equal(xlsxPreview.body.profile, 'beisen_talent')
  const xlsxCommit = await requestJson(`${url}/api/candidates/import/commit`, {
    method: 'POST',
    body: { preview_token: xlsxPreview.body.preview_token }
  })
  assert.equal(xlsxCommit.response.status, 201)

  const csvCandidate = await requestJson(`${url}/api/candidates?search=${encodeURIComponent('匿名 CSV 候选人')}`)
  assert.equal(csvCandidate.body.items[0].gender, '女')
  assert.equal(csvCandidate.body.items[0].birth_date, '1994-06-08')
  assert.equal(csvCandidate.body.items[0].age, 31)

  const beisenList = await requestJson(`${url}/api/candidates?search=${encodeURIComponent('匿名北森候选人')}`)
  const beisenDetail = await requestJson(`${url}/api/candidates/${beisenList.body.items[0].id}`)
  assert.equal(beisenDetail.body.gender, '男')
  assert.equal(beisenDetail.body.birth_date, '1990-12-01')
  assert.equal(beisenDetail.body.age, 35)
  assert.equal(beisenDetail.body.source_record_id, 'BEISEN-ANON-0001')
})
