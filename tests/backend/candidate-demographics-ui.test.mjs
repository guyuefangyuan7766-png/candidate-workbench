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
  assert.match(drawerSource, /profileGender && <div><dt><UserRound size=\{15\} \/>性别<\/dt><dd>\{profileGender\}<\/dd><\/div>/)
  assert.match(drawerSource, /candidate\?\.source_system === "manual" \? "" : candidate\?\.source_record_id/)
  assert.match(drawerSource, /applicantNumber && visibleApplicantNumber &&[\s\S]*应聘者编号/)
  assert.match(drawerSource, /displayApplicantNumber\(candidate\?\.source_system, applicantNumber\)/)
  assert.doesNotMatch(drawerSource, /candidate\.gender \|\| "-"/)
  assert.match(importSource, /当前仅展示前 \{preview\.rows\.length\} 条预览/)
  assert.match(importSource, /candidateApi\.getImportConfig\(\)/)
  assert.match(importSource, /nextFile\.size > maxFileSizeBytes/)
  assert.match(importSource, /uploadProgress\.percent/)
  assert.match(apiSource, /xhr\.upload\.addEventListener\("progress"/)
  assert.match(apiSource, /\/api\/candidates\/import\/config/)
  assert.doesNotMatch(importSource, /15 \* 1024 \* 1024|最大 15 MB|最多导入|候选人数超限/)
})

test('candidate form and drawer expose hire fields and preserve legacy response defaults', async () => {
  const typesSource = readFileSync(new URL('../../src/types.ts', import.meta.url), 'utf8')
  const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
  const formSource = readFileSync(new URL('../../src/components/CandidateForm.tsx', import.meta.url), 'utf8')
  const drawerSource = readFileSync(new URL('../../src/components/CandidateDrawer.tsx', import.meta.url), 'utf8')
  const candidateUtils = await import('../../src/utils.ts')

  assert.match(typesSource, /hire_status: string/)
  assert.match(typesSource, /hire_date: string \| null/)
  assert.match(typesSource, /export interface CandidateDraft[\s\S]*\| "hire_status"[\s\S]*\| "hire_date"/)
  assert.match(typesSource, /export const emptyDraft[\s\S]*hire_status: ""[\s\S]*hire_date: null/)

  assert.match(apiSource, /hire_status: candidate\.hire_status \?\? ""/)
  assert.match(apiSource, /hire_date: candidate\.hire_date \?\? null/)

  assert.match(formSource, /hire_status: candidate\.hire_status \?\? ""/)
  assert.match(formSource, /hire_date: candidate\.hire_date \?\? null/)
  assert.match(formSource, /<h3>入职信息<\/h3>/)
  assert.match(formSource, /<span>入职状态<\/span><input value=\{draft\.hire_status\} onChange=\{\(event\) => update\("hire_status", event\.target\.value\)\}/)
  assert.match(formSource, /<span>入职日期<\/span><input value=\{draft\.hire_date\?\.slice\(0, 10\) \?\? ""\} onChange=\{\(event\) => update\("hire_date", event\.target\.value \|\| null\)\} type="date"/)
  assert.ok(formSource.indexOf('<h3>入职信息</h3>') > formSource.indexOf('<h3>求职偏好</h3>'))

  assert.equal(typeof candidateUtils.candidateHireStatusText, 'function')
  assert.equal(candidateUtils.candidateHireStatusText?.('  无  '), '无')
  assert.equal(candidateUtils.candidateHireStatusText?.('未知'), '未知')
  assert.equal(candidateUtils.candidateHireStatusText?.('暂无'), '暂无')
  assert.equal(candidateUtils.candidateHireStatusText?.('N/A'), 'N/A')
  assert.equal(candidateUtils.candidateHireStatusText?.('   '), '')
  assert.equal(candidateUtils.candidateHireStatusText?.(null), '')
  assert.match(drawerSource, /const hireStatus = candidateHireStatusText\(candidate\?\.hire_status\)/)
  assert.doesNotMatch(drawerSource, /const hireStatus = displayValue\(candidate\?\.hire_status\)/)
  assert.match(drawerSource, /const hireDate = candidate\?\.hire_date \? formatDate\(candidate\.hire_date\) : ""/)
  assert.match(drawerSource, /<h4>入职信息<\/h4>[\s\S]*入职状态[\s\S]*入职日期/)
  assert.match(drawerSource, /hire_status: "入职状态", hire_date: "入职日期"/)
})
