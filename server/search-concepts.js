export const SEARCH_CONCEPT_GROUPS = [
  { key: 'unity', label: 'Unity', terms: ['Unity', 'Unity3D', 'Unity 3D', 'Unity 引擎'] },
  { key: 'unreal', label: 'Unreal', terms: ['Unreal', 'UE4', 'UE5', '虚幻引擎'] },
  { key: 'frontend', label: '前端', terms: ['前端', '前端工程师', '前端开发', 'frontend', 'front end', 'web 前端'] },
  { key: 'backend', label: '后端', terms: ['后端', '后端工程师', '后端开发', '服务端', '服务端工程师', '服务端开发', 'backend', 'back end', 'server side', 'backend engineer'] },
  { key: 'fullstack', label: '全栈', terms: ['全栈', '全栈工程师', 'fullstack', 'full stack', 'full-stack'] },
  { key: 'client', label: '客户端', terms: ['客户端工程师', '客户端开发', 'client engineer', 'client developer'] },
  { key: 'machine_learning', label: '机器学习', terms: ['机器学习', 'machine learning', 'ML'] },
  { key: 'artificial_intelligence', label: '人工智能', terms: ['人工智能', 'artificial intelligence', 'AI'] },
  { key: 'pm', label: 'PM', terms: ['PM', '产品经理', '产品负责人', '项目经理', '项目管理', 'product manager', 'project manager', 'project management'] },
  { key: 'product_design', label: '产品设计', terms: ['产品设计', '产品设计师', 'product design', 'product designer'] },
  { key: 'ui_ux', label: 'UI/UX', terms: ['UI设计', 'UX设计', 'UI/UX', 'UI UX', '交互设计', 'interaction design', 'user experience design'] },
  { key: 'game', label: '游戏开发', terms: ['游戏', '游戏开发', 'game', 'gaming'] },
  { key: 'game_planning', label: '游戏策划', terms: ['游戏策划', '游戏设计师', 'game designer', 'game design'] },
  { key: 'combat_planning', label: '战斗策划', terms: ['战斗策划', '战斗系统', 'combat designer', 'combat design'] },
  { key: 'numerical_planning', label: '数值策划', terms: ['数值策划', '数值体系设计', '数值平衡设计', '成长曲线设计'] },
  { key: 'level_planning', label: '关卡策划', terms: ['关卡策划', '关卡设计', 'level designer', 'level design'] },
  { key: 'data_analysis', label: '数据分析', terms: ['数据分析', '数据分析师', 'data analysis', 'data analyst'] },
  { key: 'data_science', label: '数据科学', terms: ['数据科学家', 'data scientist'] },
  { key: 'data_engineering', label: '数据工程', terms: ['数据工程师', 'data engineer'] },
  { key: 'quality_assurance', label: 'QA', terms: ['QA', '测试工程师', '测试开发', '质量保证', 'quality assurance', 'qa engineer'] },
  { key: 'devops', label: 'DevOps', terms: ['DevOps', 'SRE', '运维工程师', '网站可靠性工程师', 'site reliability engineer'] },
  { key: 'android', label: 'Android', terms: ['Android', '安卓', '安卓开发', 'android developer'] },
  { key: 'ios', label: 'iOS', terms: ['iOS', '苹果开发', 'ios developer'] },
  { key: 'recruiting', label: '招聘', terms: ['招聘', '招聘专员', '招聘顾问', '招聘经理', 'recruiter', 'recruitment', 'talent acquisition'] },
  { key: 'hrbp', label: 'HRBP', terms: ['HRBP', '人力资源业务伙伴', 'HR business partner'] },
  { key: 'sales', label: '销售', terms: ['销售', '销售代表', '销售经理', 'sales', 'sales representative'] },
  { key: 'marketing', label: '市场营销', terms: ['市场', '市场营销', 'marketing'] },
  { key: 'finance', label: '财务', terms: ['财务', '财务分析', '财务分析师', 'finance', 'financial analyst'] },
  { key: 'legal', label: '法务', terms: ['法务', '法律顾问', 'legal counsel', 'legal'] },
  { key: 'procurement', label: '采购', terms: ['采购', '采购专员', 'procurement', 'purchasing'] },
  { key: 'supply_chain', label: '供应链', terms: ['供应链', 'supply chain'] },
  { key: 'overseas', label: '海外项目', terms: ['海外', '出海', '国际项目', 'overseas', 'international', 'global project'] },
  { key: 'shanghai', label: '上海', terms: ['上海', '上海市', 'shanghai'], location: '上海' },
  { key: 'beijing', label: '北京', terms: ['北京', '北京市', 'beijing'], location: '北京' },
  { key: 'shenzhen', label: '深圳', terms: ['深圳', '深圳市', 'shenzhen'], location: '深圳' },
  { key: 'guangzhou', label: '广州', terms: ['广州', '广州市', 'guangzhou'], location: '广州' },
  { key: 'hangzhou', label: '杭州', terms: ['杭州', '杭州市', 'hangzhou'], location: '杭州' }
]

const GROUP_INDEX = new Map()

export function normalizeConceptText(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

for (const group of SEARCH_CONCEPT_GROUPS) {
  for (const term of group.terms) {
    const normalized = normalizeConceptText(term)
    if (!GROUP_INDEX.has(normalized)) GROUP_INDEX.set(normalized, group)
  }
}

export function conceptGroupFor(value) {
  return GROUP_INDEX.get(normalizeConceptText(value)) ?? null
}

export function conceptTermsFor(value) {
  return conceptGroupFor(value)?.terms ?? [value]
}
