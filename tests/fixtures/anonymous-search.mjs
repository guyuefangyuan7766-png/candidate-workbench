import { insertCandidate } from '../../server/candidates.js'

export function seedAnonymousSearch(db) {
  const facts = []
  const timestamp = '2026-09-10T00:00:00.000Z'
  const profiles = [
    {
      role: '游戏策划',
      text: '负责游戏策划与战斗系统设计，使用 Unity 制作战斗原型。',
      unity: true,
      combat: true,
      game: true
    },
    {
      role: '后端工程师',
      text: '负责后端工程师工作，设计接口、数据库与服务端系统。',
      backend: true
    },
    {
      role: '数值策划',
      text: '负责数值策划，设计数值体系设计、成长曲线设计与游戏经济系统。',
      numeric: true,
      game: true
    },
    {
      role: '客户端工程师',
      text: '使用 Unreal 制作游戏客户端及渲染工具。',
      unreal: true
    },
    {
      role: 'Unity 工程师',
      text: '使用 Unity 开发客户端及关卡工具。',
      unity: true
    },
    {
      role: 'Unity 工程师',
      text: '在外包公司负责 Unity 外包项目开发。',
      unity: true,
      outsourcing: true
    },
    { role: '物流专员', text: '负责仓库与物流调度，整理入库记录。' },
    {
      role: '系统设计师',
      text: '主导数值体系设计与成长曲线设计，负责概率和数值平衡。',
      numeric: true
    }
  ]
  for (let i = 0; i < 80; i++) {
    const p = profiles[i % profiles.length]
    const years = Math.floor(i / 8) % 8
    const location = i % 3 === 0 ? '上海' : i % 3 === 1 ? '北京' : '杭州'
    const c = insertCandidate(db, {
      name: `匿名人才 ${String(i + 1).padStart(3, '0')}`,
      current_title: p.role,
      location,
      years_experience: years
    })
    const id = `anonymous-section-${i}`
    db.prepare(
      "INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) VALUES(?,?,'project','项目经历',?,?,?)"
    ).run(id, c.id, p.text, timestamp, timestamp)
    facts.push({
      ...p,
      id: c.id,
      years,
      location,
      archived: false,
      section: id
    })
  }
  return facts
}

const term = (text) => ({
  kind: 'term',
  text,
  match: 'concept',
  evidence_scope: 'self'
})
const filter = (field, op, value) => ({ kind: 'filter', field, op, value })
export function anonymousQueries(facts) {
  const templates = [
    {
      q: '上海 游戏策划 战斗系统',
      must: [
        filter('current_location', 'eq', '上海'),
        term('游戏策划'),
        term('战斗系统')
      ],
      test: (f) => f.location === '上海' && f.game && f.combat
    },
    {
      q: '找3到5年经验的后端工程师',
      must: [
        filter('years', 'gte', 3),
        filter('years', 'lte', 5),
        term('后端工程师')
      ],
      test: (f) => f.backend && f.years >= 3 && f.years <= 5
    },
    {
      q: '找3年以下经验的后端工程师',
      must: [filter('years', 'lte', 3), term('后端工程师')],
      test: (f) => f.backend && f.years <= 3
    },
    {
      q: 'Unity 或 Unreal',
      must: [
        {
          kind: 'any',
          scope: 'candidate',
          children: [term('Unity'), term('Unreal')]
        }
      ],
      test: (f) => f.unity || f.unreal
    },
    {
      q: 'Unity 不要外包',
      must: [term('Unity')],
      must_not: [term('外包')],
      test: (f) => f.unity && !f.outsourcing
    },
    {
      q: '找熟悉数值策划的人',
      must: [term('数值策划')],
      test: (f) => f.numeric
    }
  ]
  const cases = [...templates]
  for (const years of [0, 1, 2, 3, 4, 5, 6, 7]) {
    cases.push({
      q: `请找${years}年以下经验的后端工程师`,
      must: [filter('years', 'lte', years), term('后端工程师')],
      test: (f) => f.backend && f.years <= years
    })
    cases.push({
      q: `找${years}年以上经验的后端工程师`,
      must: [filter('years', 'gte', years), term('后端工程师')],
      test: (f) => f.backend && f.years >= years
    })
    cases.push({
      q: `找${years}到${years + 1}年经验的后端工程师`,
      must: [
        filter('years', 'gte', years),
        filter('years', 'lte', years + 1),
        term('后端工程师')
      ],
      test: (f) => f.backend && f.years >= years && f.years <= years + 1
    })
  }
  for (const city of ['上海', '北京', '杭州'])
    for (const [word, predicate] of [
      ['Unity', (f) => f.unity],
      ['Unreal', (f) => f.unreal],
      ['后端工程师', (f) => f.backend],
      ['数值策划', (f) => f.numeric]
    ])
      cases.push({
        q: `${city} ${word}`,
        must: [filter('current_location', 'eq', city), term(word)],
        test: (f) => f.location === city && predicate(f)
      })
  for (const city of ['上海', '北京', '杭州']) {
    cases.push({
      q: `${city} Unity 不要外包`,
      must: [filter('current_location', 'eq', city), term('Unity')],
      must_not: [term('外包')],
      test: (f) => f.location === city && f.unity && !f.outsourcing
    })
    cases.push({
      q: `请找 ${city} 游戏策划 战斗系统`,
      must: [
        filter('current_location', 'eq', city),
        term('游戏策划'),
        term('战斗系统')
      ],
      test: (f) => f.location === city && f.game && f.combat
    })
  }
  for (const years of [1, 2, 3, 4, 5, 6]) {
    cases.push({
      q: `不足${years}年经验的后端工程师`,
      must: [filter('years', 'lt', years), term('后端工程师')],
      test: (f) => f.backend && f.years < years
    })
    cases.push({
      q: `超过${years}年经验的后端工程师`,
      must: [filter('years', 'gt', years), term('后端工程师')],
      test: (f) => f.backend && f.years > years
    })
  }
  return cases.map((t, i) => ({
    id: `q-${i}`,
    query: t.q,
    must: t.must,
    must_not: t.must_not ?? [],
    expected: facts.filter(t.test).map((f) => f.id)
  }))
}
