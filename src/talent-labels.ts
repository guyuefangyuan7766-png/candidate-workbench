// 候选人职业事实的显示文案。只改展示层；数据库列、API 键与导入兼容表头保持
// current_title / current_company 原名。正在查看的招聘职位不属于本模块范围。
export const TALENT_LABELS = {
  current_title: "最近职位",
  current_company: "最近公司",
  experience: "最近经历",
  experienceEducation: "最近经历与教育摘要",
  titleCompany: "最近职位 / 公司",
  currentTitleEmpty: "最近职位未填写",
  currentCompanyEmpty: "最近公司未填写",
  currentTitlePending: "最近职位待补充"
} as const
