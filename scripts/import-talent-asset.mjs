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
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
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
}

// 资产区块 → 本项目 candidate_profile_sections.section_type（前端只认这几个）
const SECTION_TYPES = {
  education: 'education',
  workExperience: 'experience',
  project: 'project',
  objective: 'other',
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
    INSERT INTO talent_pools(id, name, description, color, source_system, source_record_id, created_at, updated_at)
    VALUES(?, ?, NULL, ?, 'beisen', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
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
      upsert.run(poolId, finalName, '#2563eb', poolId, now, now)
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
    INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at)
    VALUES(?, ?, ?)
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
        insert.run(candidateId, poolId, now)
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const stats = {
    candidates: 0, candidatesExisted: 0, candidatesSkipped: 0, candidatesFailed: 0,
    sections: 0, preferences: 0, attachments: 0, attachmentsSkipped: 0, attachmentsFailed: 0,
    pools: 0, poolsSkipped: 0, poolsFailed: 0, poolsRenamed: 0,
    memberships: 0, membershipsSkipped: 0, membershipsOutside: 0, membershipsFailed: 0,
    errors: [],
  }
  mkdirSync(options.attachmentDir, { recursive: true })
  const db = new DatabaseSync(options.dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  try {
    if (options.reset) {
      const before = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n
      db.exec('DELETE FROM candidates')
      db.exec('DELETE FROM talent_pools')
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
  console.log(`attachments  : ${stats.attachments} (跳过 ${stats.attachmentsSkipped}，失败 ${stats.attachmentsFailed})`)
  console.log(`talent pools : ${stats.pools} (跳过 ${stats.poolsSkipped}，重名改名 ${stats.poolsRenamed}，失败 ${stats.poolsFailed})`)
  console.log(`memberships  : ${stats.memberships} (已删除 ${stats.membershipsSkipped}，候选人不在本次范围 ${stats.membershipsOutside}，失败 ${stats.membershipsFailed})`)
  if (stats.errors.length) {
    console.log(`--- errors (${stats.errors.length}, 前 10 条) ---`)
    for (const line of stats.errors.slice(0, 10)) console.log(`- ${line}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
