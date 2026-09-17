import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  displayApplicantNumber,
  filterPlaceholderData,
  filterPlaceholderLines,
  hasVisibleProfileSection,
  isInternalLineageValue,
  isDisplayableValue,
  profileSectionTitleAfterTypeChange
} from '../../src/profile-section-display.ts'

test('resume display removes exact placeholder rows without damaging legal hyphens', () => {
  const content = [
    '学校名称：匿名大学',
    '学院名称：-',
    '学位：—',
    '开始时间：2018-09',
    '结束时间：2022-06',
    '邮箱：first-last@example.com',
    '职责：维护 B2B-to-C 平台'
  ].join('\n')

  assert.equal(filterPlaceholderLines(content), [
    '学校名称：匿名大学',
    '开始时间：2018-09',
    '结束时间：2022-06',
    '邮箱：first-last@example.com',
    '职责：维护 B2B-to-C 平台'
  ].join('\n'))
  assert.equal(filterPlaceholderLines('-'), '')
  assert.equal(filterPlaceholderLines('导师：－－'), '')
  assert.equal(filterPlaceholderLines('排名：——'), '')
  assert.equal(filterPlaceholderLines('未提取'), '')
  assert.equal(filterPlaceholderLines('状态：N/A'), '')
  assert.equal(filterPlaceholderLines('备注：暂无'), '')
  assert.equal(filterPlaceholderLines('2018-09 - 2022-06'), '2018-09 - 2022-06')
})

test('placeholder-only structured rows and empty resume sections are hidden', () => {
  const structured = filterPlaceholderData({
    school: '匿名大学',
    college: '-',
    courses: ['-', '数据结构'],
    mentor: { name: '－' }
  })
  assert.deepEqual(structured, { school: '匿名大学', courses: ['数据结构'] })
  assert.equal(isDisplayableValue(structured), true)
  assert.equal(hasVisibleProfileSection({
    id: 'placeholder-only',
    section_type: 'education',
    title: '教育经历',
    content: '学校名称：-\n专业：—',
    structured_data: { school: '-', major: '—' },
    sort_order: 0,
    sensitivity: 'internal',
    source_record_id: '',
    created_at: '',
    updated_at: ''
  }), false)
})

test('attachment lineage IDs are never exposed as applicant numbers', () => {
  assert.equal(displayApplicantNumber('attachment_preview', 'attachment-preview:abc:row-1'), '')
  assert.equal(displayApplicantNumber('attachment-batch', 'record-1'), '')
  assert.equal(displayApplicantNumber('manual', '6f0ec0d8-e7d8-4dc0-bf3a-86c4032f42e8'), '')
  assert.equal(displayApplicantNumber('', '6f0ec0d8-e7d8-4dc0-bf3a-86c4032f42e8'), '')
  assert.equal(displayApplicantNumber('beisen', 'CAN-2026-001'), 'CAN-2026-001')
  assert.equal(isInternalLineageValue('attachment-preview:abc:row-1'), true)
  assert.equal(filterPlaceholderLines('source_record_id：attachment-preview:abc:row-1'), '')
  assert.deepEqual(filterPlaceholderData({
    source_record_id: 'attachment-preview:abc:row-1',
    lineage: 'attachment-preview:abc:row-1',
    note: '可展示来源说明'
  }), { note: '可展示来源说明' })
})

test('profile section type changes update only blank or previous default titles', () => {
  assert.equal(profileSectionTitleAfterTypeChange('', '附加信息', '实习经历'), '实习经历')
  assert.equal(profileSectionTitleAfterTypeChange('附加信息', '附加信息', '实习经历'), '实习经历')
  assert.equal(profileSectionTitleAfterTypeChange('  附加信息  ', '附加信息', '实习经历'), '实习经历')
  assert.equal(profileSectionTitleAfterTypeChange('暑期研发实习', '附加信息', '实习经历'), '暑期研发实习')
})

test('candidate form and app persist canonical editable resume sections', () => {
  const formSource = readFileSync(new URL('../../src/components/CandidateForm.tsx', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
  const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
  const drawerSource = readFileSync(new URL('../../src/components/CandidateDrawer.tsx', import.meta.url), 'utf8')

  assert.match(formSource, /value: "internship", label: "实习经历"/)
  assert.match(formSource, /profileSectionTypePatch\(section, event\.target\.value\)/)
  assert.match(formSource, /draft\.profile_sections\?\.map/)
  assert.match(formSource, /function shouldPersistProfileSection[\s\S]*existingSectionId[\s\S]*hasSectionValue\(section\)/)
  assert.equal((formSource.match(/filter\(shouldPersistProfileSection\)/g) ?? []).length, 2)
  assert.match(appSource, /candidateApi\.replaceProfileSections\(created\.id, profile_sections\)/)
  assert.match(appSource, /Array\.isArray\(profile_sections\)[\s\S]*replaceProfileSections\(selectedCandidateId, profile_sections\)/)
  assert.match(appSource, /const retryCandidateId = pendingCreatedCandidateId[\s\S]*replaceProfileSections\(retryCandidateId, profile_sections \?\? \[\]\)/)
  assert.match(appSource, /setPendingCreatedCandidateId\(created\.id\)[\s\S]*候选人已创建，偏好或履历未完整保存/)
  assert.match(appSource, /setPendingCreatedCandidateId\(created\.id\);[\s\S]*await candidateApi\.updatePreferences\(created\.id, preferences\)/)
  assert.match(appSource, /const retryCandidateId = pendingCreatedCandidateId[\s\S]*updatePreferences\(retryCandidateId, preferences\)[\s\S]*replaceProfileSections\(retryCandidateId, profile_sections \?\? \[\]\)/)
  assert.match(appSource, /pendingProfileSave=\{Boolean\(pendingCreatedCandidateId\)\}/)
  assert.match(apiSource, /\/profile-sections`[\s\S]*method: "PUT"/)
  assert.match(drawerSource, /const sections = \(candidate\?\.profile_sections \?\? \[\]\)\.filter\(hasVisibleProfileSection\)/)
  assert.match(drawerSource, /resumeGroups\.map\(\(group\) => \([\s\S]{0,400}?group\.entries\.map\(/)
  assert.match(drawerSource, /sourceRecordId && applicantNumber &&/)
  assert.match(drawerSource, /pendingProfileSave \? "重试保存偏好与履历" : "创建档案"/)
  assert.match(drawerSource, /fieldsDisabled=\{pendingProfileSave\}/)
  assert.match(drawerSource, /\{\(hasContact \|\| hasDemographics \|\| \(!sensitiveLoaded && onRevealSensitive\)\) && \(/)
  assert.match(drawerSource, /\{location && \([\s\S]{0,200}?<MapPin size=\{14\} \/>[\s\S]{0,80}?\{location\}/)
  // Internal attachment lineage keys must not bypass the trusted applicant
  // number projection in the advanced data-lineage view.
  assert.match(drawerSource, /lineageRows\.map\(\(row\) =>/)
  assert.match(drawerSource, /value: applicantNumber && sensitiveLoaded \? applicantNumber : applicantNumber \? "已保护" : ""/)
  assert.match(drawerSource, /!isInternalMetadataKey\(key\)/)
  assert.equal((drawerSource.match(/record\.source_record_id/g) ?? []).length, 1)
  assert.match(drawerSource, /来源记录: sensitiveLoaded \? record\.source_record_id : ""/)
  assert.doesNotMatch(drawerSource, /sensitiveLoaded \? candidate\.source_record_id \|\| "-"/)
  assert.doesNotMatch(drawerSource, /candidate\.location \|\| "-"/)
})
