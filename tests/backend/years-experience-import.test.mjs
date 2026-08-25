import test from 'node:test'
import assert from 'node:assert/strict'

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
