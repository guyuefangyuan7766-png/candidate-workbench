#!/usr/bin/env node
// 增量导入：只处理「新增 / 指纹变化」的候选人，不重跑整份快照。
//
//   node scripts/import-incremental.mjs                    # 预演：只列差集，不写库
//   node scripts/import-incremental.mjs --apply            # 写库
//
// 输入：
//   data/incremental/manifest/asset-candidates.jsonl   （最新索引，由 incremental-sync --check 拉取）
//   data/incremental/manifest/profiles/...             （本次增量档案目录）
//   data/incremental/resumes/...                       （本次增量简历目录）
//
// 写入口径与 scripts/import-talent-asset.mjs 保持一致：候选人在主表按
// (source_system='beisen', source_record_id=candidateId) 对齐；档案区块重建前
// 先归档旧的「北森来源」区块，保留后续由模型解析出来的区块（parser=origin-section-parse-v1）。
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
const MANIFEST_DIR = resolve(DATA, 'incremental', 'manifest')
const RESUMES_DIR = resolve(DATA, 'incremental', 'resumes')
// 增量档案可能来自两处：随 manifest 一起落地的，或按分片单独下载后解压的
// data/incremental/profiles/candidates/<xx>/<xx>/<applicantId>/profile.json。
const INCREMENTAL_PROFILES_DIR = resolve(DATA, 'incremental', 'profiles')
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(DATA, 'recruitment.db')
const ATTACHMENT_DIR = resolve(DATA, 'private', 'attachments', 'files')
const PARSER_VERSION = 'origin-section-parse-v1'
const MAX_ATTACHMENT_BYTES = 15_728_640

const apply = process.argv.includes('--apply')
const options = {
  index: resolve(MANIFEST_DIR, 'asset-candidates.jsonl'),
  profilesDirs: [
    resolve(INCREMENTAL_PROFILES_DIR, 'candidates'),
    resolve(MANIFEST_DIR, 'profiles'),
    resolve(DATA, 'incremental', 'delta-fixture', 'profiles')
  ]
}
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--index') options.index = resolve(process.argv[index + 1])
  if (process.argv[index] === '--profiles-dir') options.profilesDirs.unshift(resolve(process.argv[index + 1]))
}

mkdirSync(ATTACHMENT_DIR, { recursive: true })

function toText(value) {
  return value == null ? '' : String(value).trim()
}

function profileValueMap(entries) {
  const map = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = toText(entry?.name)
    if (!name) continue
    map.set(name, toText(entry?.value) || toText(entry?.text))
  }
  return map
}

function blocksOf(value) {
  if (!Array.isArray(value)) return []
  return value.filter((block) => Array.isArray(block))
}

function normalizeDate(value) {
  const text = toText(value)
  const match = text.match(/(19|20)\d{2}(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/)
  if (!match) return null
  const [year, month, day] = match[0].split(/[-/.]/)
  return [year, month, day].filter(Boolean).map((part) => part.padStart(2, '0')).join('-')
}

function yearsFrom(value) {
  const match = toText(value).match(/(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

const BLOCK_LABELS = {
  Name: '姓名', Gender: '性别', Mobile: '手机', Email: '邮箱', Birthday: '出生日期',
  YearsOfWork: '工作年限', LastCompany: '最近任职公司', IDPhoto: '证件照',
  SchoolName: '学校', MajorName: '专业', EducationLevel: '学历',
  StartDate: '开始时间', EndDate: '结束时间', CompanyName: '公司', JobTitle: '职位',
  JobDuty: '工作内容', ProjectName: '项目名称', ProjectInfo: '项目描述', Position: '角色',
  ExpectSalary: '期望薪资', ExpectOccupation: '期望职位', ExpectWorkAreas: '期望工作地',
  ExpectIndustry: '期望行业', AvailableDate: '到岗时间'
}

const SECTION_TYPES = { education: 'education', workExperience: 'experience', project: 'project', objective: 'other' }
const PRIMARY_FIELDS = {
  education: ['SchoolName', 'MajorName', 'EducationLevel'],
  workExperience: ['CompanyName', 'JobTitle'],
  project: ['ProjectName', 'Position'],
  objective: ['ExpectOccupation', 'ExpectWorkAreas']
}

function renderBlock(block) {
  const map = profileValueMap(block)
  const entries = [...map.entries()].filter(([key, value]) => key !== '_id' && value)
  const body = entries.map(([key, value]) => `${BLOCK_LABELS[key] ?? key}：${value}`).join('\n')
  return { map, entries, body }
}

function sectionsOf(profile) {
  const sections = []
  for (const [key, type] of Object.entries(SECTION_TYPES)) {
    for (const block of blocksOf(profile[key])) {
      const { map, entries, body } = renderBlock(block)
      if (!body) continue
      const title = (PRIMARY_FIELDS[key] ?? []).map((field) => map.get(field)).filter(Boolean).join(' · ')
      const structured = Object.fromEntries(entries.map(([field, value]) => [BLOCK_LABELS[field] ?? field, value]))
      sections.push({ type, title: title || BLOCK_LABELS[key] || key, body, structured })
    }
  }
  return sections
}

function candidateValues(profile, row) {
  const person = profileValueMap(Array.isArray(profile.personProfile) ? profile.personProfile : [])
  const educationBlocks = blocksOf(profile.education)
  const firstEducation = educationBlocks.length ? profileValueMap(educationBlocks[0]) : new Map()
  return {
    name: (person.get('Name') || String(row.candidateId || row.applicantId).slice(0, 60)).slice(0, 200),
    phone: (person.get('Mobile') ?? '').slice(0, 60) || null,
    email: (person.get('Email') ?? '').slice(0, 200) || null,
    gender: (person.get('Gender') ?? '').slice(0, 20) || null,
    current_company: (person.get('LastCompany') ?? '').slice(0, 300) || null,
    birth_date: normalizeDate(person.get('Birthday')),
    years_experience: yearsFrom(person.get('YearsOfWork')),
    years_experience_raw: (person.get('YearsOfWork') ?? '').slice(0, 100),
    education: (firstEducation.get('EducationLevel') ?? '').slice(0, 100) || null,
    highest_school: (firstEducation.get('SchoolName') ?? '').slice(0, 300) || null,
    highest_major: (firstEducation.get('MajorName') ?? '').slice(0, 300) || null
  }
}

function preferenceValues(profile) {
  const blocks = blocksOf(profile.objective)
  if (!blocks.length) return null
  const map = profileValueMap(blocks.flat())
  const asArray = (value) => (value ? JSON.stringify([value]) : '[]')
  return {
    desired_titles: asArray(map.get('ExpectOccupation')),
    desired_locations: asArray(map.get('ExpectWorkAreas')),
    expected_salary: (map.get('ExpectSalary') ?? map.get('Salary') ?? '').slice(0, 200) || null,
    availability: (map.get('AvailableDate') ?? '').slice(0, 200) || null,
    raw_payload: JSON.stringify(Object.fromEntries(map))
  }
}

// ── 1. 读取最新索引并与本地指纹比对 ────────────────────────────────────────
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA busy_timeout = 15000')
db.exec('PRAGMA foreign_keys = ON')

const localIndex = new Map()
for (const row of db.prepare('SELECT candidate_id, applicant_id, profile_sha256 FROM candidate_asset_index').all()) {
  localIndex.set(String(row.applicant_id), { candidateId: row.candidate_id, sha: row.profile_sha256 })
}
const localCandidateIds = new Set(db.prepare("SELECT id, source_record_id FROM candidates WHERE source_system = 'beisen'").all().map((row) => String(row.source_record_id)))

const added = []
const changed = []
let same = 0
let unkeyable = 0
const incoming = new Set()

const reader = createInterface({ input: createReadStream(options.index, { encoding: 'utf8' }), crlfDelay: Infinity })
for await (const line of reader) {
  const text = line.trim()
  if (!text) continue
  const row = JSON.parse(text)
  const applicantId = toText(row.applicantId)
  const candidateId = toText(row.candidateId)
  if (!candidateId) { unkeyable += 1; continue }
  incoming.add(applicantId)
  const local = localIndex.get(applicantId)
  if (!local && !localCandidateIds.has(candidateId)) added.push(row)
  else if (local && local.sha !== row.profileSha256) changed.push(row)
  else same += 1
}
const removed = [...localIndex.keys()].filter((id) => !incoming.has(id))

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  index: options.index,
  added: added.length,
  changed: changed.length,
  same,
  unkeyable,
  removed: removed.length,
  details: []
}

if (!apply) {
  summary.details = [...added.slice(0, 10).map((row) => ({ kind: 'added', candidateId: row.candidateId, relativeDir: row.relativeDir })),
    ...changed.slice(0, 10).map((row) => ({ kind: 'changed', candidateId: row.candidateId, relativeDir: row.relativeDir }))]
  console.log(JSON.stringify(summary, null, 1))
  db.close()
  process.exit(0)
}

// ── 2. 写库 ───────────────────────────────────────────────────────────────
const statements = {
  findCandidate: db.prepare("SELECT id FROM candidates WHERE source_system = 'beisen' AND source_record_id = ?"),
  insertCandidate: db.prepare(`
    INSERT INTO candidates(id, name, phone, email, current_company, gender, birth_date,
      years_experience, years_experience_raw, education, highest_school, highest_major,
      source, stage, tags, source_system, source_record_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '北森人才库资产', '新候选人', '[]', 'beisen', ?, ?, ?)
  `),
  touchCandidate: db.prepare(`
    UPDATE candidates SET name = ?, phone = ?, email = ?, current_company = ?, gender = ?,
      birth_date = ?, years_experience = ?, years_experience_raw = ?, education = ?,
      highest_school = ?, highest_major = ?, updated_at = ?
    WHERE id = ?
  `),
  upsertSource: db.prepare(`
    INSERT INTO candidate_source_records(id, candidate_id, source_system, source_record_id, record_type,
      source_name, source_timestamp, raw_payload, sensitivity, created_at, updated_at)
    VALUES(?, ?, 'beisen', ?, 'talent_profile', '北森人才库共享资产', NULL, ?, 'high', ?, ?)
    ON CONFLICT(source_system, source_record_id, record_type) DO UPDATE SET
      raw_payload = excluded.raw_payload, updated_at = excluded.updated_at
  `),
  archiveImportedSections: db.prepare(`
    UPDATE candidate_profile_sections SET archived_at = ?, updated_at = ?
    WHERE candidate_id = ? AND archived_at IS NULL
      AND (source_record_id IS NULL OR source_record_id NOT LIKE 'origin-section-parse-v1:%')
  `),
  insertSection: db.prepare(`
    INSERT INTO candidate_profile_sections(id, candidate_id, section_type, title, content, structured_data,
      sort_order, sensitivity, source_record_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?, ?)
  `),
  upsertPreferences: db.prepare(`
    INSERT INTO candidate_preferences(candidate_id, desired_titles, desired_locations, expected_salary,
      availability, raw_payload, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET desired_titles = excluded.desired_titles,
      desired_locations = excluded.desired_locations, expected_salary = excluded.expected_salary,
      availability = excluded.availability, raw_payload = excluded.raw_payload, updated_at = excluded.updated_at
  `),
  upsertAssetIndex: db.prepare(`
    INSERT INTO candidate_asset_index(candidate_id, applicant_id, relative_dir, profile_sha256,
      profile_size_bytes, catalog_source, has_standard_resume, has_origin_resume, is_deleted,
      apply_count, interview_count, evaluation_count, imported_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET applicant_id = excluded.applicant_id,
      relative_dir = excluded.relative_dir, profile_sha256 = excluded.profile_sha256,
      profile_size_bytes = excluded.profile_size_bytes, catalog_source = excluded.catalog_source,
      has_standard_resume = excluded.has_standard_resume, has_origin_resume = excluded.has_origin_resume,
      is_deleted = excluded.is_deleted, apply_count = excluded.apply_count,
      interview_count = excluded.interview_count, evaluation_count = excluded.evaluation_count,
      imported_at = excluded.imported_at
  `),
  findAttachment: db.prepare(`
    SELECT id FROM candidate_attachments WHERE candidate_id = ? AND attachment_type = ? LIMIT 1
  `),
  insertAttachment: db.prepare(`
    INSERT INTO candidate_attachments(id, candidate_id, original_filename, storage_path, mime_type,
      file_size, sha256, attachment_type, parse_status, parser_version, extracted_text, source,
      import_batch_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'none', '', 'beisen_asset', NULL, ?, ?)
  `)
}

function detectMime(buffer, fallbackExtension) {
  if (buffer.length > 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return { mime: 'application/pdf', extension: 'pdf' }
  const head = buffer.subarray(0, 512).toString('utf8').trim().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return { mime: 'text/html', extension: 'html' }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return { mime: 'image/jpeg', extension: 'jpg' }
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return { mime: 'image/png', extension: 'png' }
  return { mime: 'application/octet-stream', extension: fallbackExtension || 'bin' }
}

function importResumeFiles(candidateId, relativeDir, timestamp) {
  const candidates = [
    { type: 'resume', path: join(RESUMES_DIR, 'candidates', relativeDir, 'resume-standard.pdf'), filename: 'standard.pdf' },
    { type: 'resume_origin', path: join(RESUMES_DIR, 'candidates', relativeDir, 'origin.pdf'), filename: 'origin.pdf' }
  ]
  const imported = []
  for (const item of candidates) {
    if (!existsSync(item.path)) continue
    if (statSync(item.path).size > MAX_ATTACHMENT_BYTES) continue
    const existing = statements.findAttachment.get(candidateId, item.type)
    if (existing) continue
    const buffer = readFileSync(item.path)
    const detected = detectMime(buffer, 'pdf')
    const target = join(ATTACHMENT_DIR, `${randomUUID()}.${detected.extension}`)
    writeFileSync(target, buffer)
    statements.insertAttachment.run(
      randomUUID(), candidateId, item.filename, target, detected.mime,
      buffer.length, createHash('sha256').update(buffer).digest('hex'), item.type, timestamp, timestamp
    )
    imported.push(item.type)
  }
  return imported
}

let processed = 0
db.exec('BEGIN IMMEDIATE')
try {
  for (const row of [...added, ...changed]) {
    const relativeDir = toText(row.relativeDir)
    const profilePath = relativeDir
      ? options.profilesDirs
          .map((base) => join(base, relativeDir, 'profile.json'))
          .find((candidatePath) => existsSync(candidatePath))
      : null
    if (!profilePath) {
      summary.details.push({ kind: 'skipped', candidateId: row.candidateId, reason: 'profile_missing' })
      continue
    }
    const raw = readFileSync(profilePath)
    const profile = JSON.parse(raw.toString('utf8'))
    const timestamp = new Date().toISOString()
    const values = candidateValues(profile, row)
    const existing = statements.findCandidate.get(String(row.candidateId))
    const candidateId = existing?.id ?? randomUUID()
    if (existing) {
      statements.touchCandidate.run(
        values.name, values.phone, values.email, values.current_company, values.gender,
        values.birth_date, values.years_experience, values.years_experience_raw, values.education,
        values.highest_school, values.highest_major, timestamp, candidateId
      )
    } else {
      statements.insertCandidate.run(
        candidateId, values.name, values.phone, values.email, values.current_company, values.gender,
        values.birth_date, values.years_experience, values.years_experience_raw, values.education,
        values.highest_school, values.highest_major, String(row.candidateId), timestamp, timestamp
      )
    }
    statements.upsertSource.run(
      randomUUID(), candidateId, String(row.candidateId), raw.toString('utf8'), timestamp, timestamp
    )
    // 只归档「北森导入/手工」区块；模型解析出的区块（origin-section-parse-v1）保留。
    statements.archiveImportedSections.run(timestamp, timestamp, candidateId)
    let sortOrder = 0
    for (const section of sectionsOf(profile)) {
      statements.insertSection.run(
        randomUUID(), candidateId, section.type, section.title, section.body,
        JSON.stringify(section.structured), sortOrder, `beisen-asset:${row.candidateId}`, timestamp, timestamp
      )
      sortOrder += 1
    }
    const preferences = preferenceValues(profile)
    if (preferences) {
      statements.upsertPreferences.run(
        candidateId, preferences.desired_titles, preferences.desired_locations,
        preferences.expected_salary, preferences.availability, preferences.raw_payload, timestamp
      )
    }
    statements.upsertAssetIndex.run(
      candidateId, toText(row.applicantId), relativeDir, toText(row.profileSha256) || null,
      Number.isFinite(row.profileSizeBytes) ? row.profileSizeBytes : null,
      toText(row.catalogSource) || null, row.hasStandardResume ? 1 : 0, row.hasOriginResume ? 1 : 0,
      row.isDeleted ? 1 : 0,
      Number.isFinite(row.applyCount) ? row.applyCount : null,
      Number.isFinite(row.interviewCount) ? row.interviewCount : null,
      Number.isFinite(row.evaluationCount) ? row.evaluationCount : null,
      timestamp
    )
    const attachments = importResumeFiles(candidateId, relativeDir, timestamp)
    processed += 1
    summary.details.push({
      kind: existing ? 'updated' : 'added',
      candidateId: String(row.candidateId),
      name: values.name,
      sections: sortOrder,
      attachments
    })
  }
  db.exec('COMMIT')
} catch (error) {
  try { db.exec('ROLLBACK') } catch {}
  throw error
}

summary.processed = processed
summary.profilesDirPresent = existsSync(join(MANIFEST_DIR, 'profiles'))
summary.resumesDirPresent = existsSync(join(RESUMES_DIR, 'candidates'))
writeFileSync(resolve(DATA, 'incremental-import-report.json'), `${JSON.stringify(summary, null, 2)}\n`)
db.close()
console.log(JSON.stringify({ ...summary, details: `${summary.details.length} 条（见 data/incremental-import-report.json）` }, null, 1))
