import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { addNote, archiveCandidate, insertCandidate } from '../../server/candidates.js'
import { insertPosition, linkCandidates } from '../../server/positions.js'
import {
  insertTalentPool,
  linkCandidatesToTalentPool,
  replaceCandidatePreferences,
  replaceCandidateProfileSections
} from '../../server/talent.js'

// Fictional, deterministic dataset for the talent-workspace redesign preview
// and browser QA. Never seed real candidate data here.

const NAMES = [
  '林悦', '陈思远', '周宁', '赵可', '王昊', '许安', '沈嘉', '李然',
  '苏晴', '孙莉', '张晨', '刘洋', '何静', '郑凯', '吴桐', '周雨薇',
  '秦朗', '冯雪', '程一鸣', '邓可欣', '高远', '韩雪松', '蒋亦凡', '赖俊',
  '林泽宇', '卢晓', '罗子涵', '马思远', '潘婷', '彭博', '邱雨', '施远',
  '宋佳', '唐睿', '田甜', '汪洋', '王梦', '魏来', '夏雨', '谢宇',
  '徐静', '许飞', '杨帆', '姚远', '叶琳', '于磊', '曾诚', '张伟豪'
]

const TITLES = [
  '产品设计师', '高级产品经理', 'UX 设计师', '数据分析师', '产品专家', '研究员',
  '前端工程师', '后端工程师', '产品运营', '交互设计师', '用户研究员', '数值策划'
]

const COMPANIES = [
  '云启科技', '星河数科', '智行互联', '北辰网络', '澄明科技',
  '美刻科技', '灵图智能', '华宇数据', '天工软件', '蓝湖设计'
]

const LOCATIONS = ['北京', '上海', '深圳', '杭州', '广州', '成都']

const SCHOOLS = [
  ['清华大学', '工业设计'], ['浙江大学', '计算机科学与技术'], ['同济大学', '工业设计'],
  ['北京邮电大学', '数字媒体艺术'], ['复旦大学', '信息管理'], ['中山大学', '视觉传达'],
  ['华中科技大学', '软件工程'], ['北京理工大学', '计算机科学与技术']
]

const TAG_POOL = [
  'UI/UX', 'Figma', '用户研究', '设计系统', '产品规划', '数据分析',
  'React', 'TypeScript', '交互设计', '用户体验', 'Sketch', '用户增长',
  'SQL', 'B端产品', '内容策略', '社区运营', '视觉设计', 'A/B 测试'
]

const SOURCES = ['主动添加', '履历导入', '人才推荐', '职位关联']
const OWNERS = ['演示负责人', '招聘协作甲', '招聘协作乙']
const STATUS = ['在职', '在职', '在职', '离职', '看机会']
const EDUCATION = ['本科', '本科', '硕士', '硕士', '博士', '大专']

function pick(list, index) {
  return list[index % list.length]
}

export function seedAnonymousTalentWorkspace(db, { attachmentRoot } = {}) {
  const timestamp = '2026-09-10T08:00:00.000Z'
  const candidates = []

  for (let i = 0; i < NAMES.length; i++) {
    const [school, major] = pick(SCHOOLS, i * 3 + (i % 2))
    const years = i % 9 === 0 ? null : (i * 7) % 12
    const raw = i % 9 === 0 ? (i % 18 === 0 ? '经验不详' : '5年以上') : String(years)
    const record = insertCandidate(db, {
      id: 'anon-tw-candidate-' + String(i + 1).padStart(3, '0'),
      name: NAMES[i],
      phone: '1390000' + String(1000 + i).slice(-4),
      email: 'anon' + (i + 1) + '@example.com',
      current_title: pick(TITLES, i),
      current_company: pick(COMPANIES, i * 3 + 1),
      location: pick(LOCATIONS, i + (i % 3)),
      education: pick(EDUCATION, i * 5),
      highest_school: school,
      highest_major: major,
      years_experience: years,
      years_experience_raw: raw,
      job_seeking_status: pick(STATUS, i + (i % 2)),
      gender: i % 2 === 0 ? '女' : '男',
      birth_date: String(1988 + (i % 10)) + '-0' + ((i % 9) + 1) + '-1' + (i % 9),
      age: 26 + (i % 12),
      self_summary: pick(TITLES, i) + '，累计 ' + (years ?? '多年') + ' 年相关经验，覆盖需求分析、方案设计与落地协作，重视业务价值与用户体验的平衡。',
      source: pick(SOURCES, i * 2 + (i % 3)),
      owner: pick(OWNERS, i),
      tags: [pick(TAG_POOL, i), pick(TAG_POOL, i + 5), pick(TAG_POOL, i + 11)],
      expected_salary: (20 + (i % 15)) + '-' + (30 + (i % 20)) + 'K',
      resume_updated_at: '2026-09-' + String((i % 9) + 1).padStart(2, '0')
    })
    candidates.push(record)
  }

  for (const index of [1, 4, 7]) {
    db.prepare('UPDATE candidates SET hire_status = ?, hire_date = ?, hire_position = ? WHERE id = ?')
      .run(index === 1 ? '已入职' : '待入职', '2026-10-0' + (index % 9), pick(TITLES, index + 4), candidates[index].id)
  }

  for (const index of [40, 41, 42, 43, 44, 45]) archiveCandidate(db, candidates[index].id)

  const pools = [
    { id: 'anon-tw-pool-product', name: '产品与设计', color: '#3370ff', description: '长期关注优秀产品与设计人才。' },
    { id: 'anon-tw-pool-tech', name: '技术研发', color: '#36b37e', description: '前后端、数据与测试方向。' },
    { id: 'anon-tw-pool-growth', name: '市场运营', color: '#ff991f', description: '市场、内容与增长运营储备。' },
    { id: 'anon-tw-pool-high', name: '高潜人才', color: '#ff5630', description: '跨方向高潜力候选人。' },
    { id: 'anon-tw-pool-campus', name: '校招人才', color: '#6554c0', description: '校园招聘渠道沉淀。' },
    { id: 'anon-tw-pool-contacted', name: '已联系候选人', color: '#00b8d9', description: '已建立联系、待持续跟进。' },
    { id: 'anon-tw-pool-starred', name: '收藏的人才', color: '#ffab00', description: '需要重点关注的人才。' }
  ]
  const poolRecords = pools.map((pool) => insertTalentPool(db, pool))
  const archivedPool = insertTalentPool(db, { id: 'anon-tw-pool-archive', name: '设计储备（演示归档）', color: '#5e6c84', description: '演示用已归档分组。' })
  db.prepare('UPDATE talent_pools SET archived_at = ? WHERE id = ?').run(timestamp, archivedPool.id)

  const link = (poolId, indexes) => linkCandidatesToTalentPool(db, poolId, indexes.map((index) => candidates[index].id))
  link(poolRecords[0].id, [0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 20])
  link(poolRecords[1].id, [6, 7, 8, 9, 10, 11, 19, 23, 27, 31])
  link(poolRecords[2].id, [2, 5, 14, 18, 22, 26, 30])
  link(poolRecords[3].id, [0, 4, 9, 13, 21, 29])
  link(poolRecords[4].id, [33, 34, 35, 36, 37])
  link(poolRecords[5].id, [1, 3, 7, 11, 15, 24, 28])
  link(poolRecords[6].id, [0, 6, 12, 25])

  const positions = [
    { id: 'anon-tw-pos-product-designer', title: '产品设计师', department: '设计中心', location: '北京', owner: '演示负责人', headcount: 2, status: 'open', description: '负责企业产品的体验设计与界面规范建设，协同产品和研发推进设计落地。', tags: ['设计系统', 'B端产品'] },
    { id: 'anon-tw-pos-product-manager', title: '高级产品经理', department: '产品中心', location: '上海', owner: '招聘协作甲', headcount: 3, status: 'open', description: '负责产品规划与需求管理，推动跨团队协作与版本迭代。', tags: ['产品规划'] },
    { id: 'anon-tw-pos-frontend', title: '前端工程师', department: '技术研发', location: '深圳', owner: '招聘协作甲', headcount: 4, status: 'open', description: '负责 Web 前端开发与工程化建设。', tags: ['React', 'TypeScript'] },
    { id: 'anon-tw-pos-backend', title: '后端工程师', department: '技术研发', location: '杭州', owner: '招聘协作乙', headcount: 3, status: 'open', description: '负责服务端系统设计与接口开发。', tags: ['Node.js'] },
    { id: 'anon-tw-pos-analyst', title: '数据分析师', department: '数据智能', location: '上海', owner: '演示负责人', headcount: 2, status: 'open', description: '负责业务数据分析与指标体系搭建。', tags: ['SQL'] },
    { id: 'anon-tw-pos-ux', title: 'UX 设计师', department: '设计中心', location: '深圳', owner: '招聘协作甲', headcount: 1, status: 'open', description: '负责核心流程的交互体验设计与研究。', tags: ['交互设计'] },
    { id: 'anon-tw-pos-operations', title: '产品运营', department: '市场运营', location: '北京', owner: '招聘协作乙', headcount: 2, status: 'paused', description: '负责产品运营策略与用户增长。', tags: ['用户增长'] },
    { id: 'anon-tw-pos-qa', title: '测试工程师', department: '技术研发', location: '杭州', owner: '招聘协作乙', headcount: 2, status: 'open', description: '负责产品质量保障与自动化测试建设。', tags: [] },
    { id: 'anon-tw-pos-solution', title: '解决方案专家', department: '解决方案', location: '北京', owner: '演示负责人', headcount: 1, status: 'draft', description: '面向企业客户提供解决方案设计与支持。', tags: [] },
    { id: 'anon-tw-pos-ui', title: 'UI 设计师', department: '设计中心', location: '深圳', owner: '招聘协作甲', headcount: 1, status: 'paused', description: '负责产品视觉表现与设计规范落地。', tags: ['视觉设计'] },
    { id: 'anon-tw-pos-marketing', title: '市场运营', department: '市场运营', location: '北京', owner: '招聘协作乙', headcount: 1, status: 'closed', description: '负责市场活动策划与品牌传播。', tags: [] },
    { id: 'anon-tw-pos-researcher', title: '用户研究员', department: '用户体验', location: '北京', owner: '演示负责人', headcount: 2, status: 'open', description: '负责用户研究与可用性测试。', tags: ['用户研究'] }
  ]
  const positionRecords = positions.map((position) => insertPosition(db, position))
  const archivedPosition = insertPosition(db, { id: 'anon-tw-pos-archive', title: '视觉设计师（演示归档）', department: '设计中心', location: '上海', headcount: 1, status: 'closed', description: '演示用已归档职位。' })
  db.prepare('UPDATE positions SET archived_at = ? WHERE id = ?').run(timestamp, archivedPosition.id)

  const attach = (positionId, indexes) => linkCandidates(db, positionId, indexes.map((index) => candidates[index].id))
  attach(positionRecords[0].id, [0, 1, 3, 5, 12])
  attach(positionRecords[1].id, [1, 4, 16, 20])
  attach(positionRecords[2].id, [7, 9, 23, 27, 31])
  attach(positionRecords[3].id, [8, 10, 19])
  attach(positionRecords[4].id, [2, 3, 21])
  attach(positionRecords[5].id, [2, 14])
  attach(positionRecords[11].id, [5, 15, 24])

  replaceCandidateProfileSections(db, candidates[0].id, {
    sections: [
      { id: 'anon-tw-sec-0-work-1', section_type: 'experience', title: '云启科技 · 产品设计师', content: '2022.07 - 至今\n负责 B 端产品的整体设计体验，主导设计系统建设，协同推进产品迭代。' },
      { id: 'anon-tw-sec-0-work-2', section_type: 'experience', title: '明日无限 · UI 设计师', content: '2020.06 - 2022.06\n参与移动端产品设计，完成核心功能模块的界面与交互设计。' },
      { id: 'anon-tw-sec-0-edu', section_type: 'education', title: '同济大学 · 工业设计', content: '2016.09 - 2020.06\n本科，工业设计专业。' },
      { id: 'anon-tw-sec-0-project', section_type: 'project', title: '企业服务平台', content: '2021.03 - 2022.06\n负责信息架构、核心流程与组件规范设计。' },
      { id: 'anon-tw-sec-0-skill', section_type: 'skill', title: '专业技能', content: 'UI/UX、Figma、用户研究、交互设计、设计系统' }
    ]
  })
  for (const index of [1, 2, 4, 6, 9, 12]) {
    replaceCandidateProfileSections(db, candidates[index].id, {
      sections: [
        { id: 'anon-tw-sec-' + index + '-work', section_type: 'experience', title: candidates[index].current_company + ' · ' + candidates[index].current_title, content: '2021.03 - 至今\n负责' + candidates[index].current_title + '相关职责，覆盖需求分析、方案设计与落地推进。' },
        { id: 'anon-tw-sec-' + index + '-edu', section_type: 'education', title: candidates[index].highest_school + ' · ' + candidates[index].highest_major, content: '本科阶段系统学习' + candidates[index].highest_major + '方向课程。' }
      ]
    })
  }

  for (const index of [0, 1, 3, 6, 9]) {
    replaceCandidatePreferences(db, candidates[index].id, {
      employment_status: candidates[index].job_seeking_status,
      desired_titles: [candidates[index].current_title],
      desired_locations: [candidates[index].location],
      employment_type: '全职',
      expected_salary: candidates[index].expected_salary,
      availability: index % 2 === 0 ? '1 个月内' : '随时到岗'
    })
  }

  for (const index of [0, 2, 5]) {
    addNote(db, candidates[index].id, '已完成电话沟通，候选人关注' + (index === 0 ? '企业服务方向' : '团队规模与业务阶段') + '，后续安排深入沟通。')
  }

  if (attachmentRoot) {
    const filesRoot = resolve(attachmentRoot, 'files')
    mkdirSync(filesRoot, { recursive: true })
    const seeds = [
      { index: 0, filename: '林悦-简历.txt', text: '林悦 产品设计师\n5 年产品设计经验，主导 B 端产品设计系统建设。' },
      { index: 1, filename: '陈思远-简历.txt', text: '陈思远 高级产品经理\n8 年产品经验，负责产品规划与跨团队协作。' },
      { index: 2, filename: '周宁-简历.txt', text: '周宁 UX 设计师\n4 年交互设计经验，参与移动端产品与用户研究。' },
      { index: 6, filename: '李然-简历.txt', text: '李然 前端工程师\n6 年前端开发经验，React 与工程化方向。' }
    ]
    for (const seed of seeds) {
      const content = Buffer.from(seed.text, 'utf8')
      const sha256 = createHash('sha256').update(content).digest('hex')
      const storagePath = resolve(filesRoot, sha256.slice(0, 8) + '-anon.txt')
      writeFileSync(storagePath, content)
      db.prepare(`
        INSERT INTO candidate_attachments(
          id, candidate_id, original_filename, storage_path, mime_type, file_size, sha256,
          attachment_type, parse_status, parser_version, extracted_text, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'text/plain', ?, ?, 'resume', 'parsed', 'anonymous-fixture-v1', ?, 'user_upload', ?, ?)
      `).run(
        'anon-tw-attachment-' + seed.index,
        candidates[seed.index].id,
        seed.filename,
        storagePath,
        content.byteLength,
        sha256,
        seed.text,
        timestamp,
        timestamp
      )
    }
  }

  const assessmentSeeds = [
    {
      id: 'anon-tw-assess-0-1',
      index: 0,
      assessment_type: 'professional',
      title: '专业能力评估',
      score: 'A',
      occurred_at: '2025-11-20',
      conclusion: '候选人具备扎实的产品设计基础，用户研究、交互设计和视觉表达能力较强，过往项目中展示出良好的问题拆解与方案落地能力。',
      raw_payload: { 评估维度: '专业能力', 评估方式: '作品集评审 + 专业面谈', 评估结论: '高于岗位平均水平' }
    },
    {
      id: 'anon-tw-assess-0-2',
      index: 0,
      assessment_type: 'interview',
      title: '综合沟通记录',
      score: '',
      occurred_at: '2025-11-22',
      conclusion: '候选人沟通表达清晰，逻辑性强，对产品和用户有深入思考，团队协作意识良好，整体匹配度较高。',
      raw_payload: { 面试轮次: '二面', 面试官: '演示面试官', 记录方式: '结构化面谈记录' }
    },
    {
      id: 'anon-tw-assess-9-1',
      index: 9,
      assessment_type: 'professional',
      title: '专业能力评估',
      score: 'B+',
      occurred_at: '2025-10-18',
      conclusion: '候选人交互设计经验完整，能够独立承担中等复杂度的体验设计工作，建议补充设计系统的沉淀能力。',
      raw_payload: { 评估维度: '专业能力', 评估方式: '作品集评审' }
    }
  ]
  const insertAssessment = db.prepare(`
    INSERT INTO candidate_assessments (
      id, candidate_id, assessment_type, title, status, score, conclusion, occurred_at,
      source_system, source_record_id, raw_payload, sensitivity, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const assessment of assessmentSeeds) {
    insertAssessment.run(
      assessment.id,
      candidates[assessment.index].id,
      assessment.assessment_type,
      assessment.title,
      'completed',
      assessment.score,
      assessment.conclusion,
      assessment.occurred_at,
      'beisen',
      assessment.id,
      JSON.stringify(assessment.raw_payload),
      'internal',
      timestamp,
      timestamp
    )
  }

  return {
    candidateIds: candidates.map((candidate) => candidate.id),
    poolIds: poolRecords.map((pool) => pool.id),
    archivedPoolId: archivedPool.id,
    positionIds: positionRecords.map((position) => position.id),
    archivedPositionId: archivedPosition.id
  }
}
