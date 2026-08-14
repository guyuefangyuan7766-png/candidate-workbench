const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  phone: "手机号",
  email: "邮箱",
  gender: "性别",
  birth_date: "出生日期",
  age: "年龄",
  current_company: "当前公司",
  current_title: "当前职位",
  location: "所在地",
  years_experience: "工作年限",
  education: "最高学历",
  highest_school: "学校",
  highest_major: "专业",
  job_seeking_status: "求职状态",
  resume_updated_at: "简历更新时间",
  self_summary: "个人概述",
  expected_salary: "期望薪资",
  desired_titles: "意向岗位",
  owner: "负责人",
  source: "来源",
  tags: "标签",
};

const CONTACT_LABELS: Record<string, RegExp> = {
  phone: /^(?:手机号(?:码)?|手机|联系电话|电话|phone|mobile)\s*[:：]\s*/i,
  email: /^(?:电子邮箱|电子邮件|邮箱|e-?mail)\s*[:：]\s*/i,
};

export function attachmentFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function attachmentValueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未填写";
  if (Array.isArray(value)) return value.map(attachmentValueText).join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function attachmentSuggestionEvidence(field: string, evidence: string, value: unknown): string | null {
  const trimmed = evidence.trim();
  if (!trimmed) return null;

  const contactLabel = CONTACT_LABELS[field];
  if (!contactLabel) return trimmed;

  const originalValue = trimmed.replace(contactLabel, "").trim();
  if (!originalValue || originalValue.toLocaleLowerCase() === attachmentValueText(value).trim().toLocaleLowerCase()) {
    return null;
  }
  return `原文：${originalValue}`;
}
