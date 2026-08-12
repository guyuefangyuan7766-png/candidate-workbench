import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { candidateDisplayAge } from '../../src/utils.ts'

test('candidate display age prefers a valid full birth date and falls back to imported age', () => {
  const beforeBirthday = new Date(2026, 6, 14)
  const onBirthday = new Date(2026, 6, 15)

  assert.equal(candidateDisplayAge({ birth_date: '1990-07-15', age: 99 }, beforeBirthday), 35)
  assert.equal(candidateDisplayAge({ birth_date: '1990-07-15', age: 99 }, onBirthday), 36)
  assert.equal(candidateDisplayAge({ birth_date: '1990-02-30', age: 42 }, onBirthday), 42)
  assert.equal(candidateDisplayAge({ birth_date: null, age: 28 }, onBirthday), 28)
  assert.equal(candidateDisplayAge({ birth_date: null, age: null }, onBirthday), null)
})

test('candidate UI uses server-backed gender filtering and keeps major out of the filter panel', () => {
  const appSource = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
  const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
  const drawerSource = readFileSync(new URL('../../src/components/CandidateDrawer.tsx', import.meta.url), 'utf8')
  const importSource = readFileSync(new URL('../../src/components/ImportWizard.tsx', import.meta.url), 'utf8')

  assert.match(appSource, /candidateApi\.list\(\{ \.\.\.candidateListFilters, page: candidatePage, page_size: candidatePageSize \}, controller\.signal\)/)
  assert.doesNotMatch(appSource, /candidateApi\.listAll\(/)
  assert.match(appSource, /gender: candidateGender === "all" \? undefined : candidateGender/)
  assert.match(appSource, /<span>性别<\/span><select value=\{candidateGender\}/)
  assert.doesNotMatch(appSource, /<span>专业<\/span><select/)
  assert.doesNotMatch(appSource, /candidateMajor|setCandidateMajor|availableMajors/)

  assert.match(drawerSource, /candidateDisplayAge\(candidate\)/)
  assert.match(drawerSource, /candidate\.gender \|\| "-"/)
  assert.match(drawerSource, /candidate\?\.source_system === "manual" \? "" : candidate\?\.source_record_id/)
  assert.match(drawerSource, /applicantNumber &&[\s\S]*应聘者编号/)
  assert.match(importSource, /当前仅展示前 \{preview\.rows\.length\} 条预览/)
  assert.match(importSource, /candidateApi\.getImportConfig\(\)/)
  assert.match(importSource, /nextFile\.size > maxFileSizeBytes/)
  assert.match(importSource, /uploadProgress\.percent/)
  assert.match(apiSource, /xhr\.upload\.addEventListener\("progress"/)
  assert.match(apiSource, /\/api\/candidates\/import\/config/)
  assert.doesNotMatch(importSource, /15 \* 1024 \* 1024|最大 15 MB|最多导入|候选人数超限/)
})
