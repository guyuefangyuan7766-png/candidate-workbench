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
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
// 只补简历附件：导入过一次之后差集会归零，但分片下载可能晚于导入完成，
// 这时用 --refresh-resumes --apply 按 manifest 的 sha256 对比本地附件，补/换简历文件。
const refreshResumes = process.argv.includes('--refresh-resumes')
// 字段口径修复后按导入时间窗重跑一批候选人（例如修 SchoolName/EducationLevel 被写成代码的问题）。
const refreshSinceIndex = process.argv.indexOf('--refresh-since')
const refreshSince = refreshSinceIndex >= 0 ? String(process.argv[refreshSinceIndex + 1] ?? '').trim() : ''
const options = {
  index: resolve(MANIFEST_DIR, 'asset-candidates.jsonl'),
  profilesDirs: [
    INCREMENTAL_PROFILES_DIR,
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
    if (!name || name === '_id') continue
    // 与 import-talent-asset.mjs 的 textOf 对齐：优先 text（显示名），
    // 否则 SchoolName/EducationLevel/Gender 这类字段会写成北森内部代码（10335 / 1 / 0）。
    map.set(name, toText(entry?.text) || toText(entry?.value))
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

// --refresh-since：按 candidate_asset_index.imported_at 选出一批已入库的人，按新口径重跑导入。
const refreshRows = []
if (refreshSince) {
  const wanted = new Set(db.prepare(`
    SELECT c.source_record_id AS candidateId
    FROM candidate_asset_index i JOIN candidates c ON c.id = i.candidate_id
    WHERE i.imported_at >= ?
  `).all(refreshSince).map((row) => String(row.candidateId)))
  const refreshReader = createInterface({ input: createReadStream(options.index, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of refreshReader) {
    const text = line.trim()
    if (!text) continue
    const row = JSON.parse(text)
    if (wanted.has(String(row.candidateId))) refreshRows.push(row)
  }
}

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  index: options.index,
  added: added.length,
  changed: changed.length,
  refreshRows: refreshRows.length,
  same,
  unkeyable,
  removed: removed.length,
  details: []
}

function resolveProfilePath(row) {
  const relativeDir = toText(row.relativeDir)
  if (!relativeDir) return null
  return options.profilesDirs
    .map((base) => join(base, relativeDir, 'profile.json'))
    .find((candidatePath) => existsSync(candidatePath)) ?? null
}

if (!apply) {
  const pendingRows = [...added, ...changed]
  summary.profilesResolvable = pendingRows.filter((row) => resolveProfilePath(row)).length
  summary.profilesMissing = pendingRows.length - summary.profilesResolvable
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
    SELECT id, storage_path, sha256 FROM candidate_attachments WHERE candidate_id = ? AND attachment_type = ? LIMIT 1
  `),
  deleteAttachment: db.prepare('DELETE FROM candidate_attachments WHERE id = ?'),
  countByPath: db.prepare('SELECT COUNT(*) AS n FROM candidate_attachments WHERE storage_path = ?'),
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

// 分片 zip 里的路径：candidates/<xx>/<xx>/<id>/resumes/standard.pdf 与
// candidates/<xx>/<xx>/<id>/resumes/origin/origin.pdf（relativeDir 已含 candidates/）。
function resumeSpecs(relativeDir) {
  return [
    { type: 'resume', path: join(RESUMES_DIR, relativeDir, 'resumes', 'standard.pdf'), filename: 'standard.pdf' },
    { type: 'resume_origin', path: join(RESUMES_DIR, relativeDir, 'resumes', 'origin', 'origin.pdf'), filename: 'origin.pdf' }
  ]
}

// 返回 'inserted' / 'replaced' / 'same' / 'too_large' / null（文件不存在）。
function importResumeFile(candidateId, spec, timestamp) {
  if (!existsSync(spec.path)) return null
  if (statSync(spec.path).size > MAX_ATTACHMENT_BYTES) return 'too_large'
  const existing = statements.findAttachment.get(candidateId, spec.type)
  const buffer = readFileSync(spec.path)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (existing) {
    // 内容没变就跳过；变了就替换——否则本地永远留着旧简历，
    // 重新解析拿到的还是旧内容（增量链路的必要一环）。
    if (existing.sha256 === sha256) return 'same'
    statements.deleteAttachment.run(existing.id)
    if (!Number(statements.countByPath.get(existing.storage_path).n) && existsSync(existing.storage_path)) {
      try { unlinkSync(existing.storage_path) } catch {}
    }
  }
  const detected = detectMime(buffer, 'pdf')
  const target = join(ATTACHMENT_DIR, `${randomUUID()}.${detected.extension}`)
  writeFileSync(target, buffer)
  statements.insertAttachment.run(
    randomUUID(), candidateId, spec.filename, target, detected.mime,
    buffer.length, sha256, spec.type, timestamp, timestamp
  )
  return existing ? 'replaced' : 'inserted'
}

function importResumeFiles(candidateId, relativeDir, timestamp) {
  const imported = []
  for (const spec of resumeSpecs(relativeDir)) {
    const result = importResumeFile(candidateId, spec, timestamp)
    if (result === 'inserted' || result === 'replaced') imported.push(`${spec.type}:${result}`)
  }
  return imported
}

// ── 简历附件补录（--refresh-resumes --apply）───────────────────────────────
// 场景：profiles 先到、简历分片后到，导入已经跑过一轮，差集归零，
// 此时按 manifest 的 asset-files.jsonl 与本地 candidate_attachments.sha256
// 对比，只补/换「缺的或指纹变了」的简历文件，不动候选人档案与区块。
if (refreshResumes) {
  const wanted = new Map()
  const fileReader = createInterface({ input: createReadStream(resolve(MANIFEST_DIR, 'asset-files.jsonl'), { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of fileReader) {
    const text = line.trim()
    if (!text) continue
    const file = JSON.parse(text)
    if (file.kind !== 'resume-standard' && file.kind !== 'resume-origin') continue
    const current = wanted.get(file.applicantId) ?? {}
    current[file.kind === 'resume-standard' ? 'standard' : 'origin'] = toText(file.sha256)
    wanted.set(file.applicantId, current)
  }

  const localAttachments = new Map()
  for (const row of db.prepare(`
    SELECT c.source_record_id AS candidateId, a.attachment_type AS type, a.sha256 AS sha
    FROM candidate_attachments a JOIN candidates c ON c.id = a.candidate_id
    WHERE a.attachment_type IN ('resume', 'resume_origin')
  `).all()) {
    localAttachments.set(`${row.candidateId}|${row.type}`, row.sha)
  }
  // 附件表用内部候选人 id（candidates.id），manifest 用北森 candidateId，两者要分开。
  const internalIds = new Map(db.prepare("SELECT id, source_record_id FROM candidates WHERE source_system = 'beisen'").all().map((row) => [String(row.source_record_id), row.id]))

  const plan = []
  let alreadySame = 0
  let fileMissing = 0
  const indexReader = createInterface({ input: createReadStream(options.index, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of indexReader) {
    const text = line.trim()
    if (!text) continue
    const row = JSON.parse(text)
    const candidateId = toText(row.candidateId)
    const relativeDir = toText(row.relativeDir)
    if (!candidateId || !relativeDir) continue
    const internalId = internalIds.get(candidateId)
    if (!internalId) continue
    const files = wanted.get(toText(row.applicantId)) ?? {}
    for (const spec of resumeSpecs(relativeDir)) {
      const want = spec.type === 'resume' ? files.standard : files.origin
      if (!want) continue
      if (localAttachments.get(`${candidateId}|${spec.type}`) === want) { alreadySame += 1; continue }
      if (!existsSync(spec.path)) { fileMissing += 1; continue }
      plan.push({ candidateId: internalId, spec })
    }
  }

  summary.mode = 'refresh-resumes'
  summary.refresh = { planned: plan.length, alreadySame, fileMissing }
  if (!plan.length) {
    console.log(JSON.stringify(summary, null, 1))
    db.close()
    process.exit(0)
  }

  let inserted = 0
  let replaced = 0
  let tooLarge = 0
  const timestamp = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const item of plan) {
      const result = importResumeFile(item.candidateId, item.spec, timestamp)
      if (result === 'inserted') inserted += 1
      else if (result === 'replaced') replaced += 1
      else if (result === 'too_large') tooLarge += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  summary.refresh.inserted = inserted
  summary.refresh.replaced = replaced
  summary.refresh.tooLarge = tooLarge
  console.log(JSON.stringify(summary, null, 1))
  db.close()
  process.exit(0)
}

let processed = 0
db.exec('BEGIN IMMEDIATE')
try {
  for (const row of (refreshRows.length ? refreshRows : [...added, ...changed])) {
    const relativeDir = toText(row.relativeDir)
    const profilePath = resolveProfilePath(row)
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
// 消失态（2026-10-08 定档 B）：上游新索引里没有的 applicantId 只标记 is_deleted=1，
// **不写 archived_at、不删候选人、不删附件**，因此他们仍然出现在检索结果里。
// 再次出现在索引里的候选人会在上面的 upsert 里用 row.isDeleted 覆盖回 0。
if (removed.length && !refreshRows.length) {
  const markDeleted = db.prepare('UPDATE candidate_asset_index SET is_deleted = 1 WHERE applicant_id = ?')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const applicantId of removed) markDeleted.run(String(applicantId))
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  summary.removedMarked = removed.length
  summary.details.push({ kind: 'removed_marked', applicantIds: removed.slice(0, 50), truncated: removed.length > 50 })
}
summary.profilesDirPresent = existsSync(join(MANIFEST_DIR, 'profiles'))
summary.resumesDirPresent = existsSync(join(RESUMES_DIR, 'candidates'))
writeFileSync(resolve(DATA, 'incremental-import-report.json'), `${JSON.stringify(summary, null, 2)}\n`)
db.close()
console.log(JSON.stringify({ ...summary, details: `${summary.details.length} 条（见 data/incremental-import-report.json）` }, null, 1))
