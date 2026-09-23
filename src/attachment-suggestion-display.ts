const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  phone: "手机号",
  email: "邮箱",
  gender: "性别",
  birth_date: "出生日期",
  age: "年龄",
  current_company: "最近公司",
  current_title: "最近职位",
  location: "所在地",
  years_experience: "工作年限",
  education: "最高学历",
  highest_school: "学校",
  highest_major: "专业",
  job_seeking_status: "求职状态",
  hire_status: "入职状态",
  hire_date: "入职日期",
  hire_position: "入职职位",
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

const PROVENANCE_LABELS: Record<string, string> = {
  deterministic_text: "文本解析",
  deterministic_table: "表格解析",
  model_text: "文本模型建议",
  visual: "视觉解析",
  merged: "双通道合并",
};

const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  text_verified: "文本层已核对",
  unverified: "页面证据待人工核对",
};

const PIPELINE_CONTENT_LABELS: Record<string, string> = {
  text: "文本型文档",
  scanned: "扫描文档",
  mixed: "混合文档",
};

interface AttachmentPipelineChannelLike {
  status?: unknown;
  error_code?: unknown;
  retryable?: unknown;
  schema_mode?: unknown;
}

const PIPELINE_STATUS_LABELS: Record<string, string> = {
  ready: "已完成",
  fallback: "已降级",
  pending: "处理中",
  not_run: "未运行",
  not_applicable: "不适用",
  disabled: "未启用",
  unavailable: "不可用",
  error: "失败",
};

function safePipelineErrorCode(value: unknown): string {
  const code = String(value ?? "").trim().replace(/[^A-Za-z0-9_.-]/g, "");
  return code.slice(0, 80);
}

function pipelineSchemaModeLabel(value: unknown): string | null {
  if (value === "strict") return "严格模式";
  if (value === "compat") return "兼容模式";
  if (value === "unknown") return "模式未知";
  return null;
}

export function attachmentPipelineChannelLabel(channel: AttachmentPipelineChannelLike | undefined): string {
  if (!channel) return "未记录";
  const status = String(channel.status ?? "").trim().toLowerCase();
  return PIPELINE_STATUS_LABELS[status] ?? (status ? "状态未知" : "未记录");
}

export function attachmentPipelineChannelDetail(channel: AttachmentPipelineChannelLike | undefined): string {
  if (!channel) return "";
  const details: string[] = [];
  const schemaMode = pipelineSchemaModeLabel(channel.schema_mode);
  const errorCode = safePipelineErrorCode(channel.error_code);
  if (schemaMode) details.push(schemaMode);
  if (errorCode) details.push(`错误码：${errorCode}`);
  if (typeof channel.retryable === "boolean") details.push(channel.retryable ? "可重试" : "不可重试");
  return details.join(" · ");
}

export function attachmentPipelineChannelTone(channel: AttachmentPipelineChannelLike | undefined): string {
  const status = String(channel?.status ?? "").trim().toLowerCase();
  if (status === "ready") return "is-ready";
  if (["fallback", "disabled", "unavailable"].includes(status)) return "is-warning";
  if (["error"].includes(status)) return "is-error";
  if (["pending"].includes(status)) return "is-pending";
  return "is-muted";
}

export function attachmentFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function attachmentValueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未填写";
  if (Array.isArray(value)) return value.map(attachmentValueText).join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function attachmentConflictValueText(value: unknown, maximum = 240): string {
  const text = attachmentValueText(value);
  if (text.length <= maximum) return text;
  const contentLength = Math.max(0, maximum - 3);
  return `${text.slice(0, contentLength)}...`;
}

export function attachmentProvenanceLabel(source: string | undefined): string {
  return source ? PROVENANCE_LABELS[source] ?? "受控解析" : "文本解析";
}

export function attachmentEvidenceStatusLabel(status: string | undefined): string | null {
  return status ? EVIDENCE_STATUS_LABELS[status] ?? null : null;
}

export function attachmentParserPipelineLabel(contentType: string | undefined): string {
  return contentType ? PIPELINE_CONTENT_LABELS[contentType] ?? "附件解析" : "附件解析";
}

interface EvidenceRefInput {
  page?: unknown;
  text?: unknown;
}

interface EvidenceInput {
  evidence?: unknown;
  evidence_refs?: EvidenceRefInput[];
}

export function attachmentSuggestionEvidenceRefs(item: EvidenceInput): Array<{ page: number | null; text: string }> {
  const refs = (Array.isArray(item.evidence_refs) ? item.evidence_refs : [])
    .flatMap((ref) => {
      const text = typeof ref?.text === "string" ? ref.text.trim() : "";
      if (!text) return [];
      const page = typeof ref.page === "number" && Number.isFinite(ref.page) && ref.page > 0
        ? Math.floor(ref.page)
        : null;
      return [{ page, text }];
    });
  if (refs.length) return refs;
  const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
  return evidence ? [{ page: null, text: evidence }] : [];
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
