import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDatabase, serializeCandidate } from '../../server/database.js'
import {
  normalizeYearsExperience,
  formatYearsExperience,
  sanitizeCandidateInput
} from '../../server/validation.js'

test('years experience parser preserves source text while projecting safe durations', () => {
  const parseable = [
    ['3', 3],
    ['3.5', 3.5],
    ['3年', 3],
    ['3 年', 3],
    ['3 years', 3],
    ['3 yrs', 3],
    ['3年6个月', 3.5],
    ['3年6月', 3.5],
    ['42个月', 3.5],
    ['三年', 3],
    ['三年半', 3.5],
    ['0', 0],
    ['0年', 0],
    ['100年', 100],
    ['150', 150]
  ]
  for (const [input, numeric] of parseable) {
    const result = normalizeYearsExperience(input)
    assert.equal(result.raw, input, input)
    assert.equal(result.numeric, numeric, input)
    assert.equal(result.provided, true, input)
  }
})

test('years experience parser keeps raw text without inventing numbers', () => {
  const unparseable = [
    '约3年',
    '3年以上',
    '3年左右',
    '1-3年',
    '1至3年',
    '1 到 3 年',
    '应届',
    '无经验',
    '经验不详',
    '待核实',
    '-1年',
    'Infinity',
    '9999999999999999999999999999999999999999年',
    '工作3年，管理经验5年'
  ]
  for (const input of unparseable) {
    const result = normalizeYearsExperience(input)
    assert.equal(result.raw, input, input)
    assert.equal(result.numeric, null, input)
    assert.equal(result.provided, true, input)
  }
})

test('years experience parser treats empty values as not provided', () => {
  for (const input of [null, undefined, '', '   ', '　']) {
    const result = normalizeYearsExperience(input)
    assert.equal(result.raw, '', JSON.stringify(input))
    assert.equal(result.numeric, null, JSON.stringify(input))
    assert.equal(result.provided, false, JSON.stringify(input))
  }
})

test('years experience parser bounds raw text length and control characters', () => {
  const longText = `经验${'很'.repeat(2000)}`
  const result = normalizeYearsExperience(longText)
  assert.ok(result.raw.length <= 1000)
  assert.ok(result.raw.startsWith('经验'))
  assert.equal(result.numeric, null)

  const withControl = '3年' + String.fromCharCode(3) + '恶意'
  const control = normalizeYearsExperience(withControl)
  assert.equal(control.raw, '3年恶意')
  const submitted = sanitizeCandidateInput({ name: '边界', years_experience: withControl })
  assert.deepEqual(submitted.errors, [])
  assert.equal(submitted.value.years_experience_raw, '3年恶意')
})

test('formatYearsExperience prefers raw, then formatted numeric, then empty', () => {
  assert.equal(formatYearsExperience({ raw: '3年6个月', numeric: 3.5 }), '3年6个月')
  assert.equal(formatYearsExperience({ raw: '经验不详', numeric: null }), '经验不详')
  assert.equal(formatYearsExperience({ raw: '0', numeric: 0 }), '0')
  assert.equal(formatYearsExperience({ raw: '', numeric: 3.5 }), '3.5')
  assert.equal(formatYearsExperience({ raw: '', numeric: 3 }), '3')
  assert.equal(formatYearsExperience({ raw: '', numeric: 0 }), '0')
  assert.equal(formatYearsExperience({ raw: '', numeric: 100 }), '100')
  assert.equal(formatYearsExperience({ raw: '', numeric: null }), '')
})

test('unparseable non-empty work years do not invalidate a candidate row', () => {
  const result = normalizeYearsExperience('经验不详')
  assert.equal(result.raw, '经验不详')
  assert.equal(result.numeric, null)

  const accepted = sanitizeCandidateInput({ name: '宽容测试', years_experience: '经验不详' })
  assert.deepEqual(accepted.errors, [])
  assert.equal(accepted.value.years_experience, null)
  assert.equal(accepted.value.years_experience_raw, '经验不详')
})

test('explicit zero work years is preserved as zero', () => {
  const accepted = sanitizeCandidateInput({ name: '应届但明确为0', years_experience: '0' })
  assert.deepEqual(accepted.errors, [])
  assert.equal(accepted.value.years_experience, 0)
  assert.equal(accepted.value.years_experience_raw, '0')
})

test('numeric overflow and negative values keep raw text without a number', () => {
  for (const input of ['-1年', '-3', '1e400', 'Infinity']) {
    const accepted = sanitizeCandidateInput({ name: '边界', years_experience: input })
    assert.deepEqual(accepted.errors, [], input)
    assert.equal(accepted.value.years_experience, null, input)
    assert.equal(accepted.value.years_experience_raw, input, input)
  }
})

test('absent work years leave the field untouched in partial updates', () => {
  const partialSanitized = sanitizeCandidateInput({ name: '张三' }, { partial: true })
  assert.equal('years_experience' in partialSanitized.value, false)
  assert.equal('years_experience_raw' in partialSanitized.value, false)
})

test('explicit empty work years clear both raw and numeric values', () => {
  const cleared = sanitizeCandidateInput({ name: '张三', years_experience: '' }, { partial: true })
  assert.deepEqual(cleared.errors, [])
  assert.equal(cleared.value.years_experience, null)
  assert.equal(cleared.value.years_experience_raw, '')
})

test('phone and email format errors still fail after work years tolerance', () => {
  const rejected = sanitizeCandidateInput({
    name: '李四',
    years_experience: '经验不详',
    phone: 'not-a-phone',
    email: 'not-an-email'
  }, { partial: true })
  assert.ok(rejected.errors.some((entry) => entry.field === 'phone'))
  assert.ok(rejected.errors.some((entry) => entry.field === 'email'))
  assert.ok(!rejected.errors.some((entry) => entry.field === 'years_experience'))
})

test('V13 migration adds years_experience_raw and backfills numeric rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-v13-'))
  const databasePath = join(directory, 'v13.db')

  try {
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
      INSERT INTO candidates(id, name, years_experience, created_at, updated_at)
        VALUES ('v13-numeric', 'Numeric', 3.5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO candidates(id, name, years_experience, created_at, updated_at)
        VALUES ('v13-null', 'Null', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO candidates(id, name, years_experience, created_at, updated_at)
        VALUES ('v13-zero', 'Zero', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `)
    legacy.close()

    const db = openDatabase(databasePath, { synchronizeSearch: false })
    const columns = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
    assert.ok(columns.has('years_experience_raw'))
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version = 13').get().name, 'candidate_years_experience_raw')

    const numeric = db.prepare('SELECT years_experience, years_experience_raw FROM candidates WHERE id = ?').get('v13-numeric')
    assert.equal(numeric.years_experience, 3.5)
    assert.equal(numeric.years_experience_raw, '3.5')

    const nullRow = db.prepare('SELECT years_experience, years_experience_raw FROM candidates WHERE id = ?').get('v13-null')
    assert.equal(nullRow.years_experience, null)
    assert.equal(nullRow.years_experience_raw, '')

    const zero = db.prepare('SELECT years_experience, years_experience_raw FROM candidates WHERE id = ?').get('v13-zero')
    assert.equal(zero.years_experience, 0)
    assert.equal(zero.years_experience_raw, '0')

    const serialized = serializeCandidate(db.prepare('SELECT * FROM candidates WHERE id = ?').get('v13-numeric'))
    assert.equal(serialized.years_experience_display, '3.5')

    db.close()

    const reopen = openDatabase(databasePath, { synchronizeSearch: false })
    assert.equal(reopen.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13').get().count, 1)
    reopen.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('V13 migration is idempotent on a fresh database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-v13-fresh-'))

  try {
    const databasePath = join(directory, 'fresh.db')
    const db = openDatabase(databasePath, { synchronizeSearch: false })
    const columns = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
    assert.ok(columns.has('years_experience_raw'))
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version = 13').get().name, 'candidate_years_experience_raw')
    db.close()

    const reopen = openDatabase(databasePath, { synchronizeSearch: false })
    assert.equal(reopen.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13').get().count, 1)
    reopen.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
