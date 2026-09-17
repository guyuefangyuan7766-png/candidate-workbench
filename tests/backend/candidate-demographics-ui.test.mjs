import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { candidateDisplayAge, hasHireInformation } from '../../src/utils.ts'

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
  assert.match(readFileSync(new URL('../../src/views/CandidatesView.tsx', import.meta.url), 'utf8'), /label="性别"[\s\S]*?value=\{filters\.gender\}[\s\S]*?props\.onFilterChange\("gender", value\)/)
  assert.doesNotMatch(appSource, /<span>专业<\/span><select/)
  assert.doesNotMatch(appSource, /candidateMajor|setCandidateMajor|availableMajors/)

  assert.match(drawerSource, /candidateDisplayAge\(candidate\)/)
  assert.doesNotMatch(drawerSource, /<UserRound size=\{15\} \/>性别/)
  assert.match(drawerSource, /\{gender && \([\s\S]{0,200}?<dt className="tw-row-label">性别<\/dt>[\s\S]{0,80}?<dd className="tw-row-value">\{gender\}<\/dd>/)
  assert.match(drawerSource, /candidate\?\.source_system === "manual" \? "" : candidate\?\.source_record_id/)
  assert.match(drawerSource, /sourceRecordId && applicantNumber &&[\s\S]*应聘者编号/)
  assert.match(drawerSource, /displayApplicantNumber\(candidate\?\.source_system, sourceRecordId\)/)
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
  assert.match(typesSource, /hire_position: string/)
  assert.match(typesSource, /export interface CandidateDraft[\s\S]*\| "hire_status"[\s\S]*\| "hire_date"[\s\S]*\| "hire_position"/)
  assert.match(typesSource, /export const emptyDraft[\s\S]*hire_status: ""[\s\S]*hire_date: null[\s\S]*hire_position: ""/)

  assert.match(apiSource, /hire_status: candidate\.hire_status \?\? ""/)
  assert.match(apiSource, /hire_date: candidate\.hire_date \?\? null/)
  assert.match(apiSource, /hire_position: candidate\.hire_position \?\? ""/)

  assert.match(formSource, /hire_status: candidate\.hire_status \?\? ""/)
  assert.match(formSource, /hire_date: candidate\.hire_date \?\? null/)
  assert.match(formSource, /hire_position: candidate\.hire_position \?\? ""/)
  assert.match(formSource, /<h4 className="tw-form-subhead">入职信息<\/h4>/)
  assert.match(formSource, /<span className="tw-field-label">入职状态<\/span><input value=\{draft\.hire_status\} onChange=\{\(event\) => update\("hire_status", event\.target\.value\)\}/)
  assert.match(formSource, /<span className="tw-field-label">入职日期<\/span><input value=\{draft\.hire_date\?\.slice\(0, 10\) \?\? ""\} onChange=\{\(event\) => update\("hire_date", event\.target\.value \|\| null\)\} type="date"/)
  assert.match(formSource, /<span className="tw-field-label">入职职位<\/span><input value=\{draft\.hire_position\} onChange=\{\(event\) => update\("hire_position", event\.target\.value\)\}/)
  assert.ok(formSource.indexOf('<h4 className="tw-form-subhead">入职信息</h4>') > formSource.indexOf('>求职偏好</h3>'))

  assert.equal(typeof candidateUtils.candidateHireStatusText, 'function')
  assert.equal(candidateUtils.candidateHireStatusText?.('  无  '), '无')
  assert.equal(candidateUtils.candidateHireStatusText?.('未知'), '未知')
  assert.equal(candidateUtils.candidateHireStatusText?.('暂无'), '暂无')
  assert.equal(candidateUtils.candidateHireStatusText?.('N/A'), 'N/A')
  assert.equal(candidateUtils.candidateHireStatusText?.('   '), '')
  assert.equal(candidateUtils.candidateHireStatusText?.(null), '')
  assert.match(drawerSource, /const hireStatus = candidateHireStatusText\(candidate\?\.hire_status\)/)
  assert.doesNotMatch(drawerSource, /const hireStatus = displayValue\(candidate\?\.hire_status\)/)
  assert.match(drawerSource, /const hireDateText = candidate\?\.hire_date \? formatDate\(candidate\.hire_date\) : ""/)
  assert.match(drawerSource, /<h3 className="tw-section-title">入职信息<\/h3>[\s\S]*入职状态[\s\S]*入职日期[\s\S]*入职职位/)
  assert.match(drawerSource, /hire_status: "入职状态",[\s\S]{0,80}?hire_date: "入职日期",[\s\S]{0,80}?hire_position: "入职职位"/)
  assert.equal(hasHireInformation({ hire_status: '', hire_date: null, hire_position: '' }), false)
  assert.equal(hasHireInformation({ hire_status: '不确定', hire_date: null, hire_position: '' }), true)
  assert.equal(hasHireInformation({ hire_status: '', hire_date: '2026-10-08', hire_position: '' }), true)
  assert.equal(hasHireInformation({ hire_status: '', hire_date: null, hire_position: '工程师' }), true)
})

test('candidate work years preserves raw text while keeping numeric projections nullable', async () => {
  const typesSource = readFileSync(new URL('../../src/types.ts', import.meta.url), 'utf8')
  const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
  const formSource = readFileSync(new URL('../../src/components/CandidateForm.tsx', import.meta.url), 'utf8')
  const drawerSource = readFileSync(new URL('../../src/components/CandidateDrawer.tsx', import.meta.url), 'utf8')
  const importSource = readFileSync(new URL('../../src/components/ImportWizard.tsx', import.meta.url), 'utf8')
  const candidateUtils = await import('../../src/utils.ts')

  assert.match(typesSource, /years_experience: number \| null/)
  assert.match(typesSource, /years_experience_raw: string/)
  assert.match(typesSource, /years_experience_display: string/)
  assert.match(typesSource, /export interface CandidateDraft extends Omit<[\s\S]*years_experience: string/)

  assert.match(apiSource, /const yearsExperience = candidate\.years_experience == null \|\| !Number\.isFinite\(Number\(candidate\.years_experience\)\) \? null : Number\(candidate\.years_experience\)/)
  assert.match(apiSource, /years_experience: yearsExperience/)
  assert.match(apiSource, /const yearsExperienceRaw = candidate\.years_experience_raw \?\? ""/)
  assert.match(apiSource, /years_experience_raw: yearsExperienceRaw/)
  assert.match(apiSource, /years_experience_display: candidate\.years_experience_display \|\| yearsExperienceRaw \|\| \(yearsExperience === null \? "" : String\(yearsExperience\)\)/)
  assert.doesNotMatch(apiSource, /Number\(candidate\.years_experience \?\? 0\)/)

  assert.match(formSource, /years_experience: candidate\.years_experience_raw \|\| candidate\.years_experience_display \|\| ""/)
  assert.match(formSource, /<input value=\{draft\.years_experience\} onChange=\{\(event\) => update\("years_experience", event\.target\.value\)\} \/>/)

  assert.match(drawerSource, /candidate\?\.years_experience_display \|\|\s*candidate\?\.years_experience_raw \|\|\s*\(candidate\?\.years_experience !== null && candidate\?\.years_experience !== undefined \? `\$\{candidate\.years_experience\} 年` : ""\)/)
  assert.match(drawerSource, /\{yearsExperience && \([\s\S]{0,160}?<BriefcaseBusiness size=\{14\} \/>[\s\S]{0,80}?\{yearsExperience\}/)
  assert.match(drawerSource, /工作经验<\/dt>\s*<dd className="tw-row-value">\{yearsExperience\}<\/dd>/)

  assert.equal(typeof candidateUtils.candidateYearsExperienceText, 'function')
  assert.equal(candidateUtils.candidateYearsExperienceText?.({
    years_experience: null,
    years_experience_raw: '经验不详',
    years_experience_display: '经验不详'
  }), '经验不详')
  assert.equal(candidateUtils.candidateYearsExperienceText?.({
    years_experience: 0,
    years_experience_raw: '0',
    years_experience_display: '0'
  }), '0')
  assert.equal(candidateUtils.candidateYearsExperienceText?.({
    years_experience: null,
    years_experience_raw: '',
    years_experience_display: ''
  }), '')
  assert.match(importSource, /if \(field === "years_experience"\) return candidateYearsExperienceText\(row\.candidate\)/)
  assert.match(importSource, /\{ value: "years_experience", label: "工作年限" \}/)
  assert.match(importSource, /candidateYearsExperienceText\(row\.candidate\), row\.source_application_id/)
})
