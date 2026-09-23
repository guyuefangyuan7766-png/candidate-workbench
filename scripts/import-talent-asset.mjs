#!/usr/bin/env node
// 把人才库共享资产的导出目录导入本项目的库。
//
//   node scripts/import-talent-asset.mjs --limit 50
//   node scripts/import-talent-asset.mjs            # 全量
//
// 数据来源：data/asset-export/{asset-candidates.jsonl, asset-pools.jsonl,
// asset-pool-members.jsonl, profiles/, resumes/}
// 附件落盘：data/private/attachments/files/<uuid>.pdf（parse_status=pending，不解析）
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BLOCK_LABELS = {
  Name: '姓名',
  Gender: '性别',
  Mobile: '手机',
  MobileType: '手机归属地',
  Email: '邮箱',
  Birthday: '出生日期',
  YearsOfWork: '工作年限',
  LastCompany: '最近任职公司',
  IDPhoto: '证件照',
  CertificateType: '证件类型',
  CertificateNumber: '证件号码',
  SchoolName: '学校',
  MajorName: '专业',
  EducationLevel: '学历',
  StartDate: '开始时间',
  EndDate: '结束时间',
  CompanyName: '公司',
  JobTitle: '职位',
  JobDuty: '工作内容',
  ProjectName: '项目名称',
  ProjectInfo: '项目描述',
  Position: '角色',
  ExpectSalary: '期望薪资',
  Salary: '当前薪资',
  ExpectOccupation: '期望职位',
  ExpectWorkAreas: '期望工作地',
  ExpectIndustry: '期望行业',
  AvailableDate: '到岗时间',
  Attachment: '附件',
  fileName: '文件名',
  fileSize: '文件大小',
  mediaType: '文件类型',
  createdByName: '上传人',
  createdTime: '上传时间',
  createdBy: '上传人ID',
  dfsPath: '来源路径',
  blockName: '所属区块',
  field: '对应字段',
  materialId: '素材ID',
  jobId: '职位ID',
  jobName: '职位名称',
  applyId: '申请ID',
  interviewId: '面试ID',
  content: '备注正文',
  remarkStatus: '私密备注',
  callUserIds: '可见人',
  phaseId: '阶段ID',
  statusId: '状态ID',
}

// 资产区块 → 本项目 candidate_profile_sections.section_type（前端只认这几个）
const SECTION_TYPES = {
  education: 'education',
  workExperience: 'experience',
  project: 'project',
  objective: 'other',
  attachments: 'other',
}

// 每个区块用于生成标题的优先字段
const PRIMARY_FIELDS = {
  education: ['SchoolName', 'MajorName', 'EducationLevel'],
  workExperience: ['CompanyName', 'JobTitle'],
  project: ['ProjectName', 'Position'],
  objective: ['ExpectOccupation', 'ExpectWorkAreas'],
}

const SECTION_HEADINGS = {
  education: '教育经历',
  workExperience: '工作经历',
  project: '项目经历',
  objective: '求职意向',
  attachments: '简历附件（来源登记）',
}

function parseArgs(argv) {
  const options = {
    exportDir: join(ROOT, 'data', 'asset-export'),
    dbPath: process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(ROOT, 'data', 'recruitment.db'),
    attachmentDir: null,
    limit: 0,
    attachmentMode: 'copy',
    reset: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`缺少参数值：${arg}`)
      return argv[index]
    }
    if (arg === '--export') options.exportDir = resolve(next())
    else if (arg === '--db') options.dbPath = resolve(next())
    else if (arg === '--attachments') options.attachmentDir = resolve(next())
    else if (arg === '--limit') options.limit = Number(next())
    else if (arg === '--attachment-mode') options.attachmentMode = next()
    else if (arg === '--reset') options.reset = true
    else throw new Error(`未知参数：${arg}`)
  }
  options.attachmentDir = options.attachmentDir ?? join(dirname(options.dbPath), 'private', 'attachments', 'files')
  if (!['copy', 'move'].includes(options.attachmentMode)) throw new Error('--attachment-mode 只能是 copy 或 move')
  return options
}

async function readJsonl(path, onRow) {
  if (!existsSync(path)) throw new Error(`缺少文件：${path}`)
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let count = 0
  for await (const line of reader) {
    const text = line.trim()
    if (!text) continue
    count += 1
    await onRow(JSON.parse(text))
  }
  return count
}

/**
 * 资产侧元数据的落点。这些表由导入器自建，不进应用的 schema_migrations 链：
 * 它们记录的是「这份数据从哪来」的事实，应用本身不需要理解。
 */
function ensureAssetSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_sync_revisions (
      id TEXT PRIMARY KEY,
      generation_id TEXT,
      tree_hash TEXT,
      entry_count INTEGER,
      base_revision_id TEXT,
      export_dir TEXT NOT NULL,
      candidate_rows INTEGER NOT NULL DEFAULT 0,
      file_rows INTEGER NOT NULL DEFAULT 0,
      pool_rows INTEGER NOT NULL DEFAULT 0,
      member_rows INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidate_asset_index (
      candidate_id TEXT PRIMARY KEY,
      applicant_id TEXT NOT NULL,
      relative_dir TEXT NOT NULL,
      profile_sha256 TEXT,
      profile_size_bytes INTEGER,
      catalog_source TEXT,
      has_standard_resume INTEGER,
      has_origin_resume INTEGER,
      is_deleted INTEGER,
      apply_count INTEGER,
      interview_count INTEGER,
      evaluation_count INTEGER,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS candidate_asset_index_applicant_idx
      ON candidate_asset_index(applicant_id);
    CREATE INDEX IF NOT EXISTS candidate_asset_index_sha_idx
      ON candidate_asset_index(profile_sha256);

    CREATE TABLE IF NOT EXISTS asset_file_index (
      path TEXT PRIMARY KEY,
      applicant_id TEXT,
      candidate_id TEXT,
      kind TEXT,
      sha256 TEXT,
      size_bytes INTEGER,
      content_type TEXT,
      classification TEXT,
      source TEXT,
      source_id TEXT,
      source_modified_time TEXT,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS asset_file_index_kind_idx ON asset_file_index(kind);
    CREATE INDEX IF NOT EXISTS asset_file_index_applicant_idx ON asset_file_index(applicant_id);
  `)

  const addColumn = (table, column, definition) => {
    const columns = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name))
    if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
  // 人才池层级与来源时间戳：本地表原本没有这些列，不补就只能丢
  addColumn('talent_pools', 'parent_pool_id', 'TEXT')
  addColumn('talent_pools', 'pool_level', 'INTEGER')
  addColumn('talent_pools', 'pool_type', 'INTEGER')
  addColumn('talent_pools', 'source_created_by', 'TEXT')
  addColumn('talent_pools', 'source_created_at', 'TEXT')
  addColumn('talent_pools', 'source_modified_by', 'TEXT')
  addColumn('talent_pools', 'source_modified_at', 'TEXT')
  // 成员关系的源时间戳
  addColumn('candidate_talent_pools', 'source_created_at', 'TEXT')
  addColumn('candidate_talent_pools', 'last_reserve_at', 'TEXT')
  addColumn('candidate_talent_pools', 'source_modified_at', 'TEXT')
}

function readAssetRevision(exportDir) {
  const statePath = join(exportDir, '_download-state.json')
  if (!existsSync(statePath)) return null
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    for (const value of Object.values(state.done ?? {})) {
      if (value && value.revision) return value.revision
    }
  } catch {
    return null
  }
  return null
}

function textOf(row) {
  const value = row?.text ?? row?.value
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function labelOf(name) {
  return BLOCK_LABELS[name] ?? String(name)
}

function normalizeDate(value) {
  const text = String(value ?? '').trim().replace(/[/.]/g, '-')
  const match = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/)
  if (!match) return ''
  const [, year, month, day] = match
  const padded = `${year}-${String(month).padStart(2, '0')}${day ? `-${String(day).padStart(2, '0')}` : ''}`
  return day ? padded : ''
}

function yearsFrom(raw) {
  const match = String(raw ?? '').match(/\d+(?:\.\d+)?/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) && value >= 0 && value <= 80 ? value : null
}

function profileValueMap(rows) {
  const map = new Map()
  for (const row of rows) {
    const name = String(row?.name ?? '').trim()
    if (!name || name === '_id') continue
    const text = textOf(row)
    if (!map.has(name) && text) map.set(name, text)
  }
  return map
}

function renderBlock(rows) {
  const map = profileValueMap(rows)
  const structured = {}
  const lines = []
  for (const [name, text] of map) {
    const label = labelOf(name)
    if (!(label in structured)) structured[label] = text
    lines.push(`${label}：${text}`)
  }
  const start = map.get('StartDate') ?? ''
  const end = map.get('EndDate') ?? ''
  const range = start || end ? `${start || '未知'} - ${end || '至今'}` : ''
  const body = range ? `${range}\n${lines.join('\n')}` : lines.join('\n')
  return { map, structured, body }
}

function blockTitle(key, map) {
  const fields = PRIMARY_FIELDS[key] ?? []
  const parts = fields.map((field) => map.get(field)).filter(Boolean)
  if (parts.length) return parts.slice(0, 2).join(' · ')
  const fallback = [...map.values()].slice(0, 2)
  return fallback.join(' · ') || SECTION_HEADINGS[key] || '来源资料'
}

function blocksOf(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((block) => Array.isArray(block))
    .map((block) => block.filter((row) => row && typeof row === 'object'))
    .filter((rows) => profileValueMap(rows).size > 0)
}

function toText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value).trim()
}

// applications[] 与 interviews.applys[] 里的职位信息合起来，按 applyId 去重。
function collectApplications(profile) {
  const found = new Map()
  const push = (applyId, job, source) => {
    const key = toText(applyId)
    if (!key || !job || typeof job !== 'object') return
    if (found.has(key)) return
    // 只留申请本身的信息；interviews/applicantLite/fieldValues 另有落点或体积过大
    const raw = {}
    if (source && typeof source === 'object') {
      for (const [field, value] of Object.entries(source)) {
        if (['interviews', 'applicantLite', 'fieldValues', 'job', 'jobLite'].includes(field)) continue
        raw[field] = value
      }
    }
    found.set(key, { applyId: key, job, raw })
  }
  if (Array.isArray(profile.applications)) {
    for (const item of profile.applications) {
      if (item && typeof item === 'object') push(item.applyId, item.jobLite, item)
    }
  }
  const interviews = profile.interviews
  if (interviews && typeof interviews === 'object' && Array.isArray(interviews.applys)) {
    for (const item of interviews.applys) {
      if (item && typeof item === 'object') push(item.applyId, item.job, item)
    }
  }
  return [...found.values()]
}

// 展开 interviews.applys[].interviews[]，每条面试记录带上它所属的申请与职位。
function collectInterviewRecords(profile) {
  const records = []
  const interviews = profile.interviews
  if (!interviews || typeof interviews !== 'object' || !Array.isArray(interviews.applys)) return records
  for (const apply of interviews.applys) {
    if (!apply || typeof apply !== 'object') continue
    const applyId = toText(apply.applyId)
    const job = apply.job && typeof apply.job === 'object' ? apply.job : null
    const list = Array.isArray(apply.interviews) ? apply.interviews : []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      records.push({ applyId, job, interview: item })
    }
  }
  return records
}

function renderFlatObjects(items) {
  const structured = {}
  const lines = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const parts = []
    for (const [key, value] of Object.entries(item)) {
      const text = toText(value)
      if (!text) continue
      const label = BLOCK_LABELS[key] ?? key
      parts.push(`${label}：${text}`)
      if (!(label in structured)) structured[label] = text
    }
    if (parts.length) lines.push(parts.join('；'))
  }
  return { structured, body: lines.join('\n') }
}

/**
 * 面试记录的可读摘要。只把有明确含义的字段翻译成人话；
 * status/replyStatus 这类北森内部状态码不做猜测，原样标注为「…状态码」。
 */
function interviewSummary(interview, evaluations) {
  const parts = []
  const overviews = evaluations.map((item) => toText(item?.evaluation?.overview)).filter(Boolean)
  if (overviews.length) parts.push(`评语：${overviews.join(' / ')}`.slice(0, 1200))
  const type = toText(interview.interviewType?.name)
  if (type) parts.push(`面试类型：${type}`)
  const location = toText(interview.interviewLocation)
  if (location) parts.push(`地点：${location}`)
  const creator = toText(interview.createdByUserInfo?.name)
  if (creator) parts.push(`创建人：${creator}`)
  const interviewers = [...new Set(evaluations.map((item) => toText(item?.interviewerInfo?.name)).filter(Boolean))]
  if (interviewers.length) parts.push(`面试官：${interviewers.join('、')}`)
  const scores = evaluations.map((item) => toText(item?.evaluation?.score)).filter(Boolean)
  if (scores.length) parts.push(`评分：${scores.join(' / ')}`)
  const conclusions = evaluations.map((item) => toText(item?.evaluation?.evaluationConclusion)).filter(Boolean)
  if (conclusions.length) parts.push(`评价结论码：${conclusions.join(' / ')}`)
  if (interview.status !== null && interview.status !== undefined) parts.push(`面试状态码：${toText(interview.status)}`)
  if (interview.replyStatus !== null && interview.replyStatus !== undefined) parts.push(`回复状态码：${toText(interview.replyStatus)}`)
  const refuse = toText(interview.customRefuseReason)
  if (refuse) parts.push(`拒绝原因：${refuse}`)
  return parts.join(' · ').slice(0, 2000)
}

// profile.json 里除三段式区块外还有内容、但没有专门落表的部分，
// 统一做成区块，保证在「履历」里看得见，而不是只躺在 raw_payload。
function extraSectionsFor(profile, indexRow) {
  const sections = []

  const materials = profile.additionalMaterials
  if (materials && typeof materials === 'object') {
    const upload = Array.isArray(materials.addittionalUpload) ? materials.addittionalUpload : []
    const resumeFiles = Array.isArray(materials.standardResumesFiles) ? materials.standardResumesFiles : []
    const rendered = renderFlatObjects([...upload, ...resumeFiles])
    if (rendered.body) {
      sections.push({
        type: 'other',
        title: '附加资料与素材',
        structured: { ...rendered.structured, 上传件数量: String(upload.length), 简历素材数量: String(resumeFiles.length) },
        body: rendered.body,
      })
    }
  }

  const person = profileValueMap(Array.isArray(profile.personProfile) ? profile.personProfile : [])
  const residual = {}
  for (const [name, value] of person) {
    if (['Name', 'Gender', 'Mobile', 'Email', 'Birthday', 'YearsOfWork', 'LastCompany'].includes(name)) continue
    residual[BLOCK_LABELS[name] ?? name] = value
  }
  if (Object.keys(residual).length) {
    sections.push({
      type: 'other',
      title: '身份与证件',
      structured: residual,
      body: Object.entries(residual).map(([label, value]) => `${label}：${value}`).join('\n'),
    })
  }

  // 目录索引侧才有的事实，profile.json 里没有
  const indexFacts = {
    应聘者ID: toText(indexRow.applicantId),
    应聘者编号: toText(indexRow.candidateId),
    投递数: toText(indexRow.applyCount),
    面试数: toText(indexRow.interviewCount),
    评价数: toText(indexRow.evaluationCount),
    有标准简历: indexRow.hasStandardResume ? '是' : '否',
    有原始简历: indexRow.hasOriginResume ? '是' : '否',
    已删除: indexRow.isDeleted ? '是' : '否',
    档案指纹: toText(indexRow.profileSha256).slice(0, 16) || '无',
    档案字节数: toText(indexRow.profileSizeBytes),
  }
  sections.push({
    type: 'other',
    title: '来源索引',
    structured: indexFacts,
    body: Object.entries(indexFacts).map(([label, value]) => `${label}：${value}`).join('\n'),
  })

  return sections
}

function sha256Of(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function importPools(db, options, stats) {
  const findByName = db.prepare('SELECT id FROM talent_pools WHERE name = ? COLLATE NOCASE')
  const upsert = db.prepare(`
    INSERT INTO talent_pools(id, name, description, color, source_system, source_record_id, created_at, updated_at,
      parent_pool_id, pool_level, pool_type, source_created_by, source_created_at, source_modified_by, source_modified_at)
    VALUES(?, ?, NULL, ?, 'beisen', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
      parent_pool_id = excluded.parent_pool_id, pool_level = excluded.pool_level, pool_type = excluded.pool_type,
      source_created_by = excluded.source_created_by, source_created_at = excluded.source_created_at,
      source_modified_by = excluded.source_modified_by, source_modified_at = excluded.source_modified_at
  `)
  const now = new Date().toISOString()
  const seen = new Set()
  await readJsonl(join(options.exportDir, 'asset-pools.jsonl'), (row) => {
    const poolId = String(row.talentPoolId ?? '').trim()
    const name = String(row.talentPoolName ?? '').trim().slice(0, 200)
    if (!poolId || !name || row.stdIsDeleted) {
      stats.poolsSkipped += 1
      return
    }
    if (seen.has(poolId)) return
    seen.add(poolId)
    // 本地 talent_pools.name 是唯一索引，资产里存在同名池：加 ID 后缀区分，避免丢池。
    let finalName = name
    const clash = findByName.get(finalName)
    if (clash && clash.id !== poolId) {
      finalName = `${name}（${poolId.slice(0, 8)}）`.slice(0, 200)
      stats.poolsRenamed += 1
    }
    try {
      upsert.run(
        poolId, finalName, '#2563eb', poolId, now, now,
        toText(row.parentPoolId) || null,
        // 资产里 level 是整数、type 是字符串（"1"），都按数值存
        Number.isFinite(Number(row.talentPoolLevel)) && row.talentPoolLevel !== null
          ? Number(row.talentPoolLevel)
          : null,
        Number.isFinite(Number(row.talentPoolType)) && row.talentPoolType !== null
          ? Number(row.talentPoolType)
          : null,
        toText(row.createdBy) || null,
        toText(row.createdTime) || null,
        toText(row.modifiedBy) || null,
        toText(row.modifiedTime) || null,
      )
      stats.pools += 1
    } catch (error) {
      stats.poolsFailed += 1
      stats.errors.push(`pool ${poolId}: ${error.message}`)
    }
  })
  return seen
}

function candidateValues(profile, indexRow) {
  const person = profileValueMap(Array.isArray(profile.personProfile) ? profile.personProfile : [])
  const educationBlocks = blocksOf(profile.education)
  const firstEducation = educationBlocks.length ? profileValueMap(educationBlocks[0]) : new Map()
  const yearsRaw = person.get('YearsOfWork') ?? ''
  const name = person.get('Name') || String(indexRow.candidateId || indexRow.applicantId).slice(0, 60)
  return {
    name: name.slice(0, 200),
    phone: (person.get('Mobile') ?? '').slice(0, 60) || null,
    email: (person.get('Email') ?? '').slice(0, 200) || null,
    gender: (person.get('Gender') ?? '').slice(0, 20) || null,
    current_company: (person.get('LastCompany') ?? '').slice(0, 300) || null,
    birth_date: normalizeDate(person.get('Birthday')) || null,
    years_experience: yearsFrom(yearsRaw),
    years_experience_raw: yearsRaw.slice(0, 100),
    education: (firstEducation.get('EducationLevel') ?? '').slice(0, 100) || null,
    highest_school: (firstEducation.get('SchoolName') ?? '').slice(0, 300) || null,
    highest_major: (firstEducation.get('MajorName') ?? '').slice(0, 300) || null,
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
    raw_payload: JSON.stringify(Object.fromEntries(map)),
  }
}

async function importCandidates(db, options, stats) {
  const statements = {
    findCandidate: db.prepare('SELECT id FROM candidates WHERE source_system = ? AND source_record_id = ?'),
    insertCandidate: db.prepare(`
      INSERT INTO candidates(id, name, phone, email, current_company, gender, birth_date,
        years_experience, years_experience_raw, education, highest_school, highest_major,
        source, stage, tags, source_system, source_record_id, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '北森人才库资产', '新候选人', '[]', 'beisen', ?, ?, ?)
    `),
    insertSource: db.prepare(`
      INSERT INTO candidate_source_records(id, candidate_id, source_system, source_record_id, record_type,
        source_name, source_timestamp, raw_payload, sensitivity, created_at, updated_at)
      VALUES(?, ?, 'beisen', ?, 'talent_profile', '北森人才库共享资产', NULL, ?, 'high', ?, ?)
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
    insertAttachment: db.prepare(`
      INSERT INTO candidate_attachments(id, candidate_id, original_filename, storage_path, mime_type,
        file_size, sha256, attachment_type, parse_status, parser_version, extracted_text, source,
        import_batch_id, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'application/pdf', ?, ?, 'resume', 'pending', 'none', '', 'beisen_asset', NULL, ?, ?)
    `),
    findPositionByCode: db.prepare(
      "SELECT id FROM positions WHERE source_system = 'beisen' AND external_code = ? AND external_code <> ''",
    ),
    upsertPosition: db.prepare(`
      INSERT INTO positions(id, title, headcount, status, tags, created_at, updated_at,
        source_system, source_record_id, external_code, category)
      VALUES(?, ?, 1, 'open', '[]', ?, ?, 'beisen', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `),
    linkCandidatePosition: db.prepare(
      'INSERT OR IGNORE INTO candidate_positions(candidate_id, position_id, created_at) VALUES(?, ?, ?)',
    ),
    insertPositionSource: db.prepare(`
      INSERT OR IGNORE INTO candidate_position_sources(id, candidate_id, position_id, source_system,
        source_application_id, applied_at, raw_payload, sensitivity, created_at, updated_at)
      VALUES(?, ?, ?, 'beisen', ?, NULL, ?, 'high', ?, ?)
    `),
    insertAssessment: db.prepare(`
      INSERT OR IGNORE INTO candidate_assessments(id, candidate_id, position_id, assessment_type, title,
        status, score, conclusion, occurred_at, source_system, source_record_id, raw_payload,
        sensitivity, created_at, updated_at)
      VALUES(?, ?, ?, 'beisen_interview', ?, NULL, ?, ?, ?, 'beisen', ?, ?, 'high', ?, ?)
    `),
    findNote: db.prepare('SELECT id FROM notes WHERE candidate_id = ? AND content = ?'),
    insertNote: db.prepare(
      'INSERT INTO notes(id, candidate_id, content, author, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)',
    ),
    insertActivity: db.prepare(
      'INSERT INTO activities(id, candidate_id, type, description, metadata, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    ),
    insertAssetIndex: db.prepare(`
      INSERT OR REPLACE INTO candidate_asset_index(candidate_id, applicant_id, relative_dir, profile_sha256,
        profile_size_bytes, catalog_source, has_standard_resume, has_origin_resume, is_deleted,
        apply_count, interview_count, evaluation_count, imported_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  }

  const applicantToCandidate = new Map()
  let processed = 0
  db.exec('BEGIN')
  try {
    await readJsonl(join(options.exportDir, 'asset-candidates.jsonl'), async (row) => {
      if (options.limit && processed >= options.limit) return
      const applicantId = String(row.applicantId ?? '').trim()
      const candidateId = String(row.candidateId ?? '').trim()
      const relativeDir = String(row.relativeDir ?? '').trim()
      if (!applicantId || !candidateId || !relativeDir) {
        stats.candidatesSkipped += 1
        return
      }
      const existing = statements.findCandidate.get('beisen', candidateId)
      if (existing) {
        applicantToCandidate.set(applicantId, existing.id)
        stats.candidatesExisted += 1
        processed += 1
        return
      }

      const profilePath = join(options.exportDir, 'profiles', relativeDir, 'profile.json')
      if (!existsSync(profilePath)) {
        stats.candidatesFailed += 1
        stats.errors.push(`缺少档案 ${relativeDir}`)
        return
      }
      const raw = await readFile(profilePath)
      const profile = JSON.parse(raw.toString('utf8'))
      const now = new Date().toISOString()
      const values = candidateValues(profile, row)
      const id = randomUUID()

      statements.insertCandidate.run(
        id, values.name, values.phone, values.email, values.current_company, values.gender,
        values.birth_date, values.years_experience, values.years_experience_raw, values.education,
        values.highest_school, values.highest_major, candidateId, now, now,
      )
      statements.insertSource.run(randomUUID(), id, candidateId, raw.toString('utf8'), now, now)
      // 资产侧索引事实：profile 指纹是下一轮增量判断「这个人变没变」的唯一依据
      statements.insertAssetIndex.run(
        id,
        applicantId,
        relativeDir,
        toText(row.profileSha256) || null,
        Number.isFinite(row.profileSizeBytes) ? row.profileSizeBytes : null,
        toText(row.catalogSource) || null,
        row.hasStandardResume ? 1 : 0,
        row.hasOriginResume ? 1 : 0,
        row.isDeleted ? 1 : 0,
        Number.isFinite(row.applyCount) ? row.applyCount : null,
        Number.isFinite(row.interviewCount) ? row.interviewCount : null,
        Number.isFinite(row.evaluationCount) ? row.evaluationCount : null,
        now,
      )

      let sortOrder = 0
      for (const [key, sectionType] of Object.entries(SECTION_TYPES)) {
        let order = 0
        for (const block of blocksOf(profile[key])) {
          const rendered = renderBlock(block)
          statements.insertSection.run(
            randomUUID(), id, sectionType, blockTitle(key, rendered.map).slice(0, 200),
            rendered.body, JSON.stringify(rendered.structured), order, candidateId, now, now,
          )
          order += 1
          sortOrder += 1
          stats.sections += 1
        }
      }

      const preferences = preferenceValues(profile)
      if (preferences) {
        statements.upsertPreferences.run(
          id, preferences.desired_titles, preferences.desired_locations,
          preferences.expected_salary, preferences.availability, preferences.raw_payload, now,
        )
        stats.preferences += 1
      }

      // 申请与职位：applications[] 和 interviews.applys[] 合并，按 applyId 去重
      const knownPositionIds = new Set()
      for (const application of collectApplications(profile)) {
        const job = application.job
        const jobGuid = toText(job.jobGuid)
        const jobTitle = toText(job.jobTitle).slice(0, 200)
        if (!jobGuid || !jobTitle) {
          stats.applicationsSkipped += 1
          continue
        }
        const positionId = `beisen-job-${jobGuid}`
        const jobCode = toText(job.jobCode)
        const taken = jobCode ? statements.findPositionByCode.get(jobCode) : null
        // positions 对 (source_system, external_code) 也有唯一索引，编号撞车时放弃写编号而不是丢职位
        const externalCode = jobCode && (!taken || taken.id === positionId) ? jobCode : null
        try {
          statements.upsertPosition.run(
            positionId, jobTitle, now, now, jobGuid, externalCode, toText(job.category) || null,
          )
          statements.linkCandidatePosition.run(id, positionId, now)
          statements.insertPositionSource.run(
            randomUUID(), id, positionId, application.applyId, JSON.stringify(application.raw), now, now,
          )
          knownPositionIds.add(positionId)
          stats.applications += 1
        } catch (error) {
          stats.applicationsFailed += 1
          stats.errors.push(`application ${application.applyId}: ${error.message}`)
        }
      }

      // 面试与评价：一条面试一行，评价明细整体进 raw_payload
      for (const record of collectInterviewRecords(profile)) {
        const interview = record.interview
        const interviewId =
          toText(interview.id) || toText(interview.interviewScheduleId) || toText(interview.interviewArrangementId)
        if (!interviewId) {
          stats.interviewsSkipped += 1
          continue
        }
        const evaluations = Array.isArray(interview.evaluations) ? interview.evaluations : []
        const first = evaluations.find((item) => item && typeof item.evaluation === 'object' && item.evaluation) || {}
        const evaluation = first.evaluation || {}
        const jobTitle = record.job ? toText(record.job.jobTitle) : ''
        const jobGuid = record.job ? toText(record.job.jobGuid) : ''
        const positionId = jobGuid && knownPositionIds.has(`beisen-job-${jobGuid}`) ? `beisen-job-${jobGuid}` : null
        try {
          const summary = interviewSummary(interview, evaluations)
          statements.insertAssessment.run(
            randomUUID(),
            id,
            positionId,
            (toText(interview.interviewSubject) || (jobTitle ? `${jobTitle} 面试` : '面试')).slice(0, 200),
            toText(evaluation.score) || null,
            summary || null,
            toText(interview.startTime) || null,
            interviewId,
            JSON.stringify(interview),
            now,
            now,
          )
          stats.interviews += 1
        } catch (error) {
          stats.interviewsFailed += 1
          stats.errors.push(`interview ${interviewId}: ${error.message}`)
        }
      }

      // 备注：正文写 notes，整条对象写 activities，保证关联字段也能看见
      const comments = Array.isArray(profile.comments) ? profile.comments : []
      for (const comment of comments) {
        if (!comment || typeof comment !== 'object') continue
        const content = toText(comment.content)
        if (!content) {
          stats.commentsSkipped += 1
          continue
        }
        try {
          if (!statements.findNote.get(id, content)) {
            statements.insertNote.run(randomUUID(), id, content.slice(0, 5000), '北森备注', now, now)
          }
          statements.insertActivity.run(
            randomUUID(), id, 'beisen_comment', content.slice(0, 500), JSON.stringify(comment), now,
          )
          stats.comments += 1
        } catch (error) {
          stats.commentsFailed += 1
          stats.errors.push(`comment: ${error.message}`)
        }
      }

      // 其余没有专门落表的字段，做成区块
      let extraOrder = 900
      for (const extra of extraSectionsFor(profile, row)) {
        statements.insertSection.run(
          randomUUID(), id, extra.type, extra.title.slice(0, 200), extra.body,
          JSON.stringify(extra.structured), extraOrder, candidateId, now, now,
        )
        extraOrder += 1
        stats.sections += 1
      }

      const resumePath = join(options.exportDir, 'resumes', relativeDir, 'resumes', 'standard.pdf')
      if (row.hasStandardResume && existsSync(resumePath)) {
        try {
          const size = statSync(resumePath).size
          if (size > 0 && size <= 15728640) {
            const sha256 = await sha256Of(resumePath)
            const storagePath = `${randomUUID()}.pdf`
            const destination = join(options.attachmentDir, storagePath)
            copyFileSync(resumePath, destination)
            // 应用把 storage_path 当绝对路径使用（assertInside 用 resolve(path) 校验），
            // 所以这里存落盘后的完整路径，而不是文件名。
            statements.insertAttachment.run(
              randomUUID(), id, 'standard.pdf', destination, size, sha256, now, now,
            )
            stats.attachments += 1
          } else {
            stats.attachmentsSkipped += 1
          }
        } catch (error) {
          stats.attachmentsFailed += 1
          stats.errors.push(`附件 ${relativeDir}: ${error.message}`)
        }
      }

      applicantToCandidate.set(applicantId, id)
      stats.candidates += 1
      processed += 1
      if (processed % 200 === 0) {
        db.exec('COMMIT')
        db.exec('BEGIN')
      }
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return applicantToCandidate
}

async function importMemberships(db, options, applicantToCandidate, stats) {
  const insert = db.prepare(`
    INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at,
      source_created_at, last_reserve_at, source_modified_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(candidate_id, talent_pool_id) DO NOTHING
  `)
  const now = new Date().toISOString()
  db.exec('BEGIN')
  try {
    await readJsonl(join(options.exportDir, 'asset-pool-members.jsonl'), (row) => {
      const candidateId = applicantToCandidate.get(String(row.applicantId ?? '').trim())
      const poolId = String(row.talentPoolId ?? '').trim()
      if (!candidateId || !poolId || row.isDeleted) {
        if (row.isDeleted) stats.membershipsSkipped += 1
        else stats.membershipsOutside += 1
        return
      }
      try {
        insert.run(
          candidateId, poolId, now,
          toText(row.createdTime) || null,
          toText(row.lastReserveTime) || null,
          toText(row.modifiedTime) || null,
        )
        stats.memberships += 1
      } catch (error) {
        stats.membershipsFailed += 1
        stats.errors.push(`membership ${poolId}: ${error.message}`)
      }
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// 文件索引：每个 resume/standard/origin 文件一行，共 22 万行；只记元数据，不搬字节
async function importFileIndex(db, options, applicantToCandidate, stats) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO asset_file_index(path, applicant_id, candidate_id, kind, sha256, size_bytes,
      content_type, classification, source, source_id, source_modified_time, imported_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const now = new Date().toISOString()
  db.exec('BEGIN')
  try {
    await readJsonl(join(options.exportDir, 'asset-files.jsonl'), (row) => {
      const path = toText(row.path)
      if (!path) {
        stats.fileRowsSkipped += 1
        return
      }
      const applicantId = toText(row.applicantId)
      try {
        insert.run(
          path,
          applicantId || null,
          applicantToCandidate.get(applicantId) ?? null,
          toText(row.kind) || null,
          toText(row.sha256) || null,
          Number.isFinite(row.sizeBytes) ? row.sizeBytes : null,
          toText(row.contentType) || null,
          toText(row.classification) || null,
          toText(row.source) || null,
          toText(row.sourceId) || null,
          toText(row.sourceModifiedTime) || null,
          now,
        )
        stats.fileRows += 1
      } catch (error) {
        stats.fileRowsFailed += 1
        stats.errors.push(`file ${path}: ${error.message}`)
      }
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function recordRevision(db, options, stats) {
  const revision = readAssetRevision(options.exportDir)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO asset_sync_revisions(id, generation_id, tree_hash, entry_count, base_revision_id, export_dir,
      candidate_rows, file_rows, pool_rows, member_rows, imported_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    revision?.generationId ?? null,
    revision?.treeHash ?? null,
    Number.isInteger(revision?.entryCount) ? revision.entryCount : null,
    revision?.baseRevisionId ?? null,
    options.exportDir,
    stats.candidates,
    stats.fileRows,
    stats.pools,
    stats.memberships,
    now,
  )
  stats.revisionRecorded = revision ? 1 : 0
}

const ATTACHMENT_MAX_BYTES = 15728640 // candidate_attachments.file_size 的 CHECK 上限

/**
 * 按文件魔数判真实类型。上游 origin 目录里约 61% 是 markup、只有约 27% 真是 PDF，
 * 扩展名和 contentType 都不可信，入库前必须自己看字节。
 */
function sniffFileType(path) {
  const head = Buffer.alloc(16)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, head, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  const ascii = head.toString('latin1')
  if (ascii.startsWith('%PDF')) return { mime: 'application/pdf', ext: 'pdf' }
  if (head[0] === 0xd0 && head[1] === 0xcf) return { mime: 'application/msword', ext: 'doc' }
  if (head[0] === 0x50 && head[1] === 0x4b) return { mime: 'application/zip', ext: 'zip' }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' }
  const trimmed = ascii.trimStart().toLowerCase()
  if (trimmed.startsWith('<')) return { mime: 'text/html', ext: 'html' }
  if (ascii.includes('{') || ascii.includes('[')) {
    const text = ascii.trimStart()
    if (text.startsWith('{') || text.startsWith('[')) return { mime: 'application/json', ext: 'json' }
  }
  if (!head.includes(0x00)) return { mime: 'text/plain', ext: 'txt' }
  return { mime: 'application/octet-stream', ext: 'bin' }
}

/** 原始简历：落 candidate_attachments（attachment_type=resume_origin），超出单文件上限的单独记录。 */
async function importOriginFiles(db, options, stats) {
  const root = join(options.exportDir, 'origin')
  if (!existsSync(root)) {
    stats.originMissing = 1
    return
  }
  const insert = db.prepare(`
    INSERT OR IGNORE INTO candidate_attachments(id, candidate_id, original_filename, storage_path, mime_type,
      file_size, sha256, attachment_type, parse_status, parser_version, extracted_text, source,
      import_batch_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'resume_origin', 'pending', 'none', '', 'beisen_asset', NULL, ?, ?)
  `)
  const insertSection = db.prepare(`
    INSERT INTO candidate_profile_sections(id, candidate_id, section_type, title, content, structured_data,
      sort_order, sensitivity, source_record_id, created_at, updated_at)
    VALUES(?, ?, 'other', ?, ?, ?, 950, 'internal', ?, ?, ?)
  `)
  const candidates = db.prepare(`
    SELECT candidate_id AS candidateId, applicant_id AS applicantId, relative_dir AS relativeDir
    FROM candidate_asset_index WHERE has_origin_resume = 1
  `).all()
  const now = new Date().toISOString()

  db.exec('BEGIN')
  try {
    for (const candidate of candidates) {
      const source = join(root, candidate.relativeDir, 'resumes', 'origin', 'origin.pdf')
      if (!existsSync(source)) {
        stats.originSkipped += 1
        continue
      }
      const size = statSync(source).size
      const kind = sniffFileType(source)
      if (size <= 0 || size > ATTACHMENT_MAX_BYTES) {
        // 超过本地单附件上限：字节留在导出目录，元数据记成区块，保证看得见
        insertSection.run(
          randomUUID(),
          candidate.candidateId,
          '原始简历（未入库）',
          `文件大小 ${(size / 1048576).toFixed(1)} MB，超过本地附件单文件上限 15 MB，未写入附件表。\n` +
            `实际类型：${kind.mime}\n原始位置：${source}`,
          JSON.stringify({ 大小字节: size, 类型: kind.mime, 原路径: source }),
          candidate.applicantId,
          now,
          now,
        )
        stats.originOversize += 1
        stats.sections += 1
        continue
      }
      try {
        const sha256 = await sha256Of(source)
        const destination = join(options.attachmentDir, `${randomUUID()}.${kind.ext}`)
        copyFileSync(source, destination)
        insert.run(
          randomUUID(), candidate.candidateId, `origin.${kind.ext}`, destination, kind.mime,
          size, sha256, now, now,
        )
        stats.origin += 1
      } catch (error) {
        stats.originFailed += 1
        stats.errors.push(`origin ${candidate.applicantId}: ${error.message}`)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const stats = {
    candidates: 0, candidatesExisted: 0, candidatesSkipped: 0, candidatesFailed: 0,
    sections: 0, preferences: 0, attachments: 0, attachmentsSkipped: 0, attachmentsFailed: 0,
    applications: 0, applicationsSkipped: 0, applicationsFailed: 0,
    interviews: 0, interviewsSkipped: 0, interviewsFailed: 0,
    comments: 0, commentsSkipped: 0, commentsFailed: 0,
    pools: 0, poolsSkipped: 0, poolsFailed: 0, poolsRenamed: 0,
    fileRows: 0, fileRowsSkipped: 0, fileRowsFailed: 0, revisionRecorded: 0,
    origin: 0, originOversize: 0, originSkipped: 0, originFailed: 0, originMissing: 0,
    memberships: 0, membershipsSkipped: 0, membershipsOutside: 0, membershipsFailed: 0,
    errors: [],
  }
  mkdirSync(options.attachmentDir, { recursive: true })
  const db = new DatabaseSync(options.dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  try {
    ensureAssetSchema(db)
    if (options.reset) {
      const before = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n
      db.exec('DELETE FROM candidates')
      db.exec('DELETE FROM talent_pools')
      // 只清本次导入产生的北森职位，不碰手工建的职位
      db.exec("DELETE FROM positions WHERE source_system = 'beisen'")
      db.exec('DELETE FROM asset_file_index')
      db.exec('DELETE FROM asset_sync_revisions')
      db.exec('DELETE FROM candidate_asset_index')
      // 数据库行删掉后，磁盘上已经没有引用的附件文件也要清掉，否则重复导入会成倍占用空间。
      const referenced = new Set(
        db.prepare('SELECT storage_path FROM candidate_attachments').all().map((row) => String(row.storage_path)),
      )
      let removed = 0
      for (const name of readdirSync(options.attachmentDir)) {
        const full = join(options.attachmentDir, name)
        if (referenced.has(full)) continue
        try {
          if (statSync(full).isFile()) {
            unlinkSync(full)
            removed += 1
          }
        } catch {
          // 单个文件删不掉不影响导入
        }
      }
      console.log(`--reset: 清空 ${before} 位候选人及其关联数据，清理无引用附件 ${removed} 个`)
    }
    await importPools(db, options, stats)
    const mapping = await importCandidates(db, options, stats)
    await importMemberships(db, options, mapping, stats)
    await importFileIndex(db, options, mapping, stats)
    await importOriginFiles(db, options, stats)
    recordRevision(db, options, stats)
  } finally {
    db.close()
  }

  console.log(`db: ${options.dbPath}`)
  console.log(`export: ${options.exportDir}`)
  console.log(`attachments: ${options.attachmentDir}`)
  console.log('--- imported ---')
  console.log(`candidates   : ${stats.candidates} (已存在 ${stats.candidatesExisted}，跳过 ${stats.candidatesSkipped}，失败 ${stats.candidatesFailed})`)
  console.log(`sections     : ${stats.sections}`)
  console.log(`preferences  : ${stats.preferences}`)
  console.log(`applications : ${stats.applications}（职位与申请血缘；跳过 ${stats.applicationsSkipped}，失败 ${stats.applicationsFailed}）`)
  console.log(`interviews   : ${stats.interviews}（面试与评价；跳过 ${stats.interviewsSkipped}，失败 ${stats.interviewsFailed}）`)
  console.log(`comments     : ${stats.comments}（备注；跳过 ${stats.commentsSkipped}，失败 ${stats.commentsFailed}）`)
  console.log(`attachments  : ${stats.attachments} (跳过 ${stats.attachmentsSkipped}，失败 ${stats.attachmentsFailed})`)
  console.log(`talent pools : ${stats.pools} (跳过 ${stats.poolsSkipped}，重名改名 ${stats.poolsRenamed}，失败 ${stats.poolsFailed})`)
  console.log(`memberships  : ${stats.memberships} (已删除 ${stats.membershipsSkipped}，候选人不在本次范围 ${stats.membershipsOutside}，失败 ${stats.membershipsFailed})`)
  console.log(`文件索引     : ${stats.fileRows} (跳过 ${stats.fileRowsSkipped}，失败 ${stats.fileRowsFailed})`)
  if (stats.originMissing) {
    console.log('原始简历     : 未找到 origin 导出目录，已跳过（先跑 sync-download.py origin）')
  } else {
    console.log(`原始简历     : ${stats.origin} 入库（超 15 MB 未入库 ${stats.originOversize}，缺文件 ${stats.originSkipped}，失败 ${stats.originFailed}）`)
  }
  console.log(`资产版本记录 : ${stats.revisionRecorded ? '已写入 asset_sync_revisions' : '未找到 _download-state.json，未写入'}`)
  if (stats.errors.length) {
    console.log(`--- errors (${stats.errors.length}, 前 10 条) ---`)
    for (const line of stats.errors.slice(0, 10)) console.log(`- ${line}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
