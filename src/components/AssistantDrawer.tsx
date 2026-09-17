import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSearch,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { agentSessionApi, agentTaskApi, getResumeSearchStatus, getResumeSearchOptions, searchCandidateResumesWithPlan, ApiError } from "../api";
import type { ResumeSearchFilters } from "../api";
import { normalizeSearchHighlightRanges } from "../types";
import type {
  AgentMessage,
  AgentArtifact,
  AgentMessagePagination,
  AgentSessionTurn,
  AgentTask,
  AgentTaskError,
  AgentTaskResult,
  AgentSession,
  Pagination,
  ResumeSearchCursorPagination,
  ResumeSearchEvidence,
  ResumeSearchItem,
  ResumeSearchIndexStatus,
  ResumeSearchOption,
  ResumeSearchResponse,
  Candidate,
  Position,
  TalentPool,
} from "../types";
import { TwAvatar } from "../views/TwAvatar";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AttachmentBatchWorkflow } from "./AttachmentBatchWorkflow";

const ACTIVE_SESSION_STORAGE_KEY = "candidate-workbench.agent.active-session-id.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "partial", "failed", "cancelled"]);

const TASK_STAGE_LABELS: Record<string, string> = {
  queued: "排队中",
  planning: "分析问题",
  querying: "检索数据源",
  retrieving: "整理证据",
  composing: "生成回答",
  processing: "处理中",
};

const TASK_WORKFLOW_STAGES = [
  { key: "queued", label: "进入队列" },
  { key: "planning", label: "分析问题" },
  { key: "querying", label: "查询数据" },
  { key: "retrieving", label: "整理证据" },
  { key: "composing", label: "生成回答" },
] as const;
const TASK_RECOVERY_INITIAL_DELAY_MS = 700;
const TASK_RECOVERY_MAX_DELAY_MS = 3_000;
const TASK_RECOVERY_RESUBMIT_INTERVAL = 4;
const MESSAGE_RECOVERY_INITIAL_DELAY_MS = 1_000;
const MESSAGE_RECOVERY_MAX_DELAY_MS = 5_000;
const MESSAGE_RECOVERY_COPY = "会话状态暂时无法读取，正在重试；已提交的问题不会重复执行。";

const TASK_ERROR_LABELS: Record<string, string> = {
  query_timeout: "数据库查询超时",
  task_deadline_exceeded: "任务超过整体时间预算",
  model_timeout: "模型回答超时",
  gateway_unavailable: "模型网关暂时不可用",
  agent_gateway_error: "模型网关返回错误",
  agent_gateway_invalid_response: "模型网关返回格式无效",
  readonly_worker_failed: "只读查询进程异常",
  agent_interrupted: "服务重启中断了任务",
  agent_shutting_down: "Agent 服务正在关闭",
  request_timeout: "任务状态恢复中",
  task_overloaded: "当前任务队列已满",
  task_cancelled: "任务已取消",
  invalid_query_plan: "查询规划未通过校验",
  readonly_policy_blocked: "查询被只读策略拦截",
  fts_unavailable: "履历全文索引暂时不可用",
  result_too_large: "结果超过单次展示范围",
  internal_error: "Agent 内部处理失败",
};

interface AssistantDrawerProps {
  open: boolean;
  configured: boolean;
  candidates: Candidate[];
  positions?: Position[];
  talentPools?: TalentPool[];
  onClose: () => void;
  onOpenCandidateId: (candidateId: string, tab?: "profile" | "resume") => void;
  onCandidatesUpdated?: () => void;
  initialTab?: AssistantTab;
  /** 第十二轮：工具页三页互切时同步表面状态与 URL（导航表面互斥）。 */
  onToolChange?: (tool: "assistant" | "resume-search" | "attachment-parser") => void;
}

type AssistantTab = "chat" | "resume-search" | "attachment";

interface PendingRequestRecovery {
  sessionId: string;
  clientRequestId: string;
  message: AgentMessage;
}

const quickQueries = ["查找本周新增候选人", "按人才库统计候选人", "查询候选人的完整联系方式与履历"];

function readStoredSessionId() {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    return value && UUID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSessionId(value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value && UUID_PATTERN.test(value)) window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, value);
    else window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Storage is optional; SQLite remains the source of truth for all chat content.
  }
}

function createClientRequestId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("当前浏览器无法生成安全的请求标识，请升级浏览器后重试。");
  return globalThis.crypto.randomUUID();
}

function mergeMessages(current: AgentMessage[], incoming: Array<AgentMessage | null | undefined>) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (message) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function HighlightedSnippet({ evidence }: { evidence: ResumeSearchEvidence }) {
  const snippet = evidence.snippet;
  const ranges = normalizeSearchHighlightRanges(snippet.text, snippet.highlights);
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) content.push(snippet.text.slice(cursor, range.start));
    content.push(
      <mark key={`${range.start}-${range.end}`} title={range.actualTerms.join("、") || undefined}>
        {snippet.text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < snippet.text.length) content.push(snippet.text.slice(cursor));
  return <span className="tw-evidence-snippet">{snippet.truncated_before ? "…" : ""}{content}{snippet.truncated_after ? "…" : ""}</span>;
}

function evidenceActualTerms(evidence: ResumeSearchEvidence) {
  return [...new Set([
    ...(evidence.matched_actual_terms ?? []),
    ...(evidence.snippet?.highlights ?? []).flatMap((range) => range.actual_terms ?? (range.actual_term ? [range.actual_term] : [])),
  ].map(String).filter(Boolean))];
}

const SEARCH_SOURCE_LABELS: Record<string, string> = {
  candidates: "候选人主档", candidate: "候选人主档",
  candidate_profile_sections: "履历经历", profile_section: "履历经历",
  candidate_attachments: "附件简历", attachment: "附件简历",
  positions: "关联职位", position: "关联职位",
  talent_pools: "人才库分组", talent_pool: "人才库分组",
  candidate_notes: "候选人备注", candidate_preferences: "求职意向",
  candidate_position_links: "职位关系", candidate_talent_pool_links: "人才库关系",
};

function searchSourceLabel(evidence: ResumeSearchEvidence) {
  return evidence.source_label || SEARCH_SOURCE_LABELS[evidence.source_table] || SEARCH_SOURCE_LABELS[evidence.entity_type] || "来源记录";
}

function visiblePages(page: number, pageCount: number): Array<number | "gap"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set<number>([1, pageCount, page, page - 1, page + 1]);
  const sorted = [...pages].filter((value) => value >= 1 && value <= pageCount).sort((left, right) => left - right);
  const result: Array<number | "gap"> = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous && value - previous > 1) result.push("gap");
    result.push(value);
    previous = value;
  }
  return result;
}

function sessionTimeLabel(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const startOfDay = (input: Date) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (dayDiff <= 0) return `今天 ${time}`;
  if (dayDiff === 1) return `昨天 ${time}`;
  return `${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date)} ${time}`;
}

function searchYearsText(person?: Candidate) {
  const display = person?.years_experience_display?.trim() ?? "";
  if (display) return /^d+(.d+)?$/.test(display) ? display + " 年" : display;
  if (person?.years_experience === null || person?.years_experience === undefined) return "未填写";
  return person.years_experience + " 年";
}

function searchFieldLabel(field: string) {
  const labels: Record<string, string> = { title: "标题", content: "正文", name: "姓名", current_title: "最近职位", current_company: "最近公司", location: "所在地", years_experience: "工作年限", skills: "专业技能", work_experience: "工作经历", project_experience: "项目经历" };
  const segments = field.split(/[.\[\]]/).filter(Boolean);
  return labels[field] || SEARCH_SOURCE_LABELS[field] || segments.map((segment) => labels[segment] || SEARCH_SOURCE_LABELS[segment]).find(Boolean) || "履历字段";
}

function searchReasonLabel(reason: string) {
  return reason.startsWith("证据来源：") ? `证据来源：${searchFieldLabel(reason.slice("证据来源：".length))}` : reason;
}

function SearchEvidence({ evidence }: { evidence: ResumeSearchEvidence }) {
  const matchLabels: Record<string, string> = { exact: "精确命中", phrase: "精确短语", concept: "同义表达", semantic: "语义相关", expanded: "同义表达", keyword: "关键词命中", unknown: "待核实" };
  const terms = evidenceActualTerms(evidence);
  const relatedKinds = ["positions", "position", "talent_pools", "talent_pool", "candidate_position_links", "candidate_talent_pool_links"];
  const inferredRelated = evidence.ownership ?? (relatedKinds.includes(evidence.source_table) || relatedKinds.includes(evidence.entity_type) ? "related" : undefined);
  return <div className="tw-evidence-card">
    <span className="tw-evidence-source"><b>{searchSourceLabel(evidence)}</b>
      {inferredRelated === "related" && <span className="tw-evidence-ownership">关联信息，不代表本人能力</span>}
      {inferredRelated === "self" && <span>本人经历</span>}
      {evidence.match_kind && matchLabels[evidence.match_kind] && <span>{matchLabels[evidence.match_kind]}</span>}
    </span>
    <HighlightedSnippet evidence={evidence} />
    <details className="tw-evidence-detail">
      <summary>展开证据片段</summary>
      <div className="tw-evidence-expanded"><HighlightedSnippet evidence={evidence} />
        {terms.length > 0 && <span className="tw-evidence-terms" aria-label="实际命中关键词">{terms.map((term) => <mark key={term}>{term}</mark>)}</span>}
        {(evidence.snippet.truncated_before || evidence.snippet.truncated_after) && <small>此处为命中片段，可打开候选人查看来源记录。</small>}
      </div>
    </details>
  </div>;
}

function isActiveTask(task: AgentTask | null | undefined) {
  return Boolean(task && !TERMINAL_TASK_STATUSES.has(task.status));
}

function defaultTaskProcessExpanded(task: AgentTask) {
  return task.status !== "completed";
}

function isTaskAnswerMessage(task: AgentTask, message: AgentMessage) {
  if (message.role !== "assistant") return false;
  if (task.assistant_message?.id && message.id === task.assistant_message.id) return true;
  if (task.user_message_id && message.reply_to_message_id) return message.reply_to_message_id === task.user_message_id;
  return Boolean(task.client_request_id && message.client_request_id === task.client_request_id);
}

function taskStageLabel(task: AgentTask) {
  return TASK_STAGE_LABELS[task.stage ?? task.status] ?? task.stage ?? task.status;
}

function taskDurationLabel(milliseconds: number) {
  return milliseconds < 1_000
    ? `${Math.max(0, Math.round(milliseconds))} ms`
    : `${(milliseconds / 1_000).toFixed(1)} 秒`;
}

function taskWorkflowStageIndex(task: AgentTask) {
  const current = task.error?.stage ?? task.stage ?? task.status;
  const index = TASK_WORKFLOW_STAGES.findIndex((step) => step.key === current);
  if (index >= 0) return index;
  if (task.status === "completed" || task.status === "partial") {
    const timedStage = [...TASK_WORKFLOW_STAGES]
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step }) => typeof task.timings?.[step.key] === "number")
      .at(-1);
    if (timedStage) return timedStage.stepIndex;
    return TASK_WORKFLOW_STAGES.length - 1;
  }
  return 0;
}

function taskWorkflowStepState(task: AgentTask, stepIndex: number) {
  if (task.status === "completed") {
    const hasTiming = Object.keys(task.timings ?? {}).some((key) => TASK_WORKFLOW_STAGES.some((step) => step.key === key));
    if (!hasTiming) return "complete";
    return typeof task.timings?.[TASK_WORKFLOW_STAGES[stepIndex].key] === "number" ? "complete" : "skipped";
  }
  const currentIndex = taskWorkflowStageIndex(task);
  if (stepIndex < currentIndex) return "complete";
  if (stepIndex > currentIndex) return "pending";
  return isActiveTask(task) ? "current" : "stopped";
}

function taskErrorCopy(error: AgentTaskError | null | undefined) {
  if (!error) return "任务未能完成。";
  const label = TASK_ERROR_LABELS[error.code] ?? "Agent 处理失败";
  const detail = error.message && error.message !== label ? `：${error.message}` : "";
  const stage = error.stage ? `（${TASK_STAGE_LABELS[error.stage] ?? error.stage}）` : "";
  const retained = error.retained_result ? " 已保留已经完成的检索结果。" : "";
  return `${label}${stage}${detail}${retained}`;
}

function messageErrorCopy(errorCode: string | null) {
  if (!errorCode) return "本轮处理未完成，请查看任务状态后重试。";
  return TASK_ERROR_LABELS[errorCode] ?? `本轮处理未完成（${errorCode}）。`;
}

function normalizeTask(task: AgentTask, sessionId?: string | null, clientRequestId?: string | null): AgentTask {
  return {
    ...task,
    session_id: task.session_id ?? sessionId ?? null,
    client_request_id: task.client_request_id ?? clientRequestId ?? null,
  };
}

function isRequestTimeout(error: unknown) {
  return error instanceof ApiError && error.code === "request_timeout";
}

function isRetryableAgentRequest(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (isRequestTimeout(error)) return true;
  // A fetch/network exception has no HTTP status and is ambiguous: the
  // server may have persisted the turn before the connection dropped. Keep
  // the idempotent request identity alive and reconcile it in that case.
  if (!(error instanceof ApiError)) return true;
  if (error.code === "network_error" || error.status === 0) return true;
  // A 429 from the Agent queue is a terminal, persisted turn failure. It is
  // intentionally excluded so the client does not replay it forever.
  return error.status === 408 || error.status >= 500;
}

function waitForRecoveryDelay(signal: AbortSignal, delay: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function withoutOptimisticMessage(messages: AgentMessage[], clientRequestId: string | null | undefined) {
  if (!clientRequestId) return messages;
  const optimisticId = `pending-${clientRequestId}`;
  return messages.filter((message) => !(
    message.id === optimisticId
    || (message.role === "user" && message.client_request_id === clientRequestId && message.id.startsWith("pending-"))
  ));
}

function failProcessingMessages(messages: AgentMessage[], errorCode: string, clientRequestId?: string | null) {
  const completedAt = new Date().toISOString();
  return messages.map((message) => message.status === "processing"
    && (!clientRequestId || message.client_request_id === clientRequestId)
    ? { ...message, status: "failed" as const, error_code: errorCode, completed_at: completedAt }
    : message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isResumeIndexStatus(value: unknown): value is ResumeSearchIndexStatus {
  return isRecord(value)
    && typeof value.state === "string"
    && typeof value.ready === "boolean"
    && (value.progress === null || typeof value.progress === "number");
}

function isResumeEvidence(value: unknown): value is ResumeSearchEvidence {
  if (!isRecord(value) || !isRecord(value.snippet)) return false;
  return typeof value.snippet.text === "string" && Array.isArray(value.snippet.highlights);
}

function taskResultRows(result: AgentTaskResult | null | undefined) {
  if (!result) return [] as Record<string, unknown>[];
  const items = Array.isArray(result.items) ? result.items : result["rows"];
  if (Array.isArray(items)) return items.filter(isRecord).slice(0, 20);
  const toolResults = result["tool_results"];
  if (!Array.isArray(toolResults)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const entry of toolResults) {
    if (!isRecord(entry)) continue;
    if (entry.tool === "export_query_results") continue;
    const payload = entry.result;
    const nested = isRecord(payload) && (Array.isArray(payload.items) ? payload.items : payload.rows);
    if (Array.isArray(nested)) {
      nested.filter(isRecord).slice(0, 20).forEach((row) => rows.push({ ...row, _tool: entry.tool }));
    } else {
      rows.push({ _tool: entry.tool, result: payload });
    }
    if (rows.length >= 20) break;
  }
  return rows.slice(0, 20);
}

const AGENT_EXPORT_ID_PATTERN = /^agent-query-[0-9a-f-]{36}\.csv$/i;

function trustedTaskArtifacts(task: AgentTask) {
  if (!Array.isArray(task.artifacts)) return [];
  return task.artifacts.filter((artifact): artifact is AgentArtifact => {
    if (!artifact || artifact.kind !== "file" || !AGENT_EXPORT_ID_PATTERN.test(artifact.artifact_id)) return false;
    if (!artifact.filename || artifact.filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(artifact.filename)) return false;
    return artifact.mime_type === "text/csv; charset=utf-8"
      && artifact.download_url === `/api/agent/exports/${encodeURIComponent(artifact.artifact_id)}`;
  });
}

function AgentArtifactDownloads({ task }: { task: AgentTask }) {
  const artifacts = trustedTaskArtifacts(task);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!artifacts.length) return null;

  async function downloadArtifact(artifact: AgentArtifact) {
    setPendingId(artifact.artifact_id);
    setError("");
    try {
      const response = await fetch(artifact.download_url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(response.status === 404 ? "文件已过期或不存在，请重新生成导出。" : "文件下载失败，请重试。");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "文件下载失败，请重试。");
    } finally {
      setPendingId(null);
    }
  }

  return <div className="assistant-artifacts" aria-label="导出文件">
    {artifacts.map((artifact) => <button
      className="assistant-artifact-download"
      type="button"
      key={artifact.artifact_id}
      disabled={pendingId === artifact.artifact_id}
      onClick={() => void downloadArtifact(artifact)}
      aria-label={`下载 ${artifact.filename}`}
      title={`下载 ${artifact.filename}`}
    >
      <Download size={16} />
      <span><strong>{artifact.filename}</strong><small>{artifact.bytes > 0 ? `${artifact.bytes.toLocaleString()} bytes` : "CSV 文件"}</small></span>
    </button>)}
    {error && <p className="assistant-artifact-error" role="alert">{error}</p>}
  </div>;
}

function taskResultEvidence(result: AgentTaskResult | null | undefined) {
  if (!result) return [] as ResumeSearchEvidence[];
  const evidence: ResumeSearchEvidence[] = Array.isArray(result.evidence) ? result.evidence.filter(isResumeEvidence) : [];
  const toolResults = result["tool_results"];
  if (Array.isArray(toolResults)) {
    for (const entry of toolResults) {
      if (!isRecord(entry) || !isRecord(entry.result)) continue;
      const payload = entry.result;
      if (Array.isArray(payload.evidence)) evidence.push(...payload.evidence.filter(isResumeEvidence));
      if (Array.isArray(payload.items)) {
        for (const item of payload.items) if (isRecord(item) && Array.isArray(item.evidence)) evidence.push(...item.evidence.filter(isResumeEvidence));
      }
      if (evidence.length >= 20) break;
    }
  }
  const unique = new Map<string, ResumeSearchEvidence>();
  evidence.forEach((item) => {
    const key = `${item.document_id}:${item.field_path}:${item.snippet.start}:${item.snippet.end}`;
    if (!unique.has(key)) unique.set(key, item);
  });
  return [...unique.values()].slice(0, 20);
}

function displayTaskValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return "[结构化值]";
    }
  }
  return String(value).slice(0, 240);
}

interface TaskResultPreviewProps {
  task: AgentTask;
  mutationPending: boolean;
  onCancel: (task: AgentTask) => void;
  onRetryAnswer: (task: AgentTask) => void;
}

function TaskResultCandidates({ task, candidates, canOpen, openingCandidateId, onOpen }: {
  task: AgentTask;
  candidates: Candidate[];
  canOpen: boolean;
  openingCandidateId: string | null;
  onOpen: (item: ResumeSearchItem, tab: "profile" | "resume") => void;
}) {
  const items = Array.isArray(task.result?.items)
    ? task.result.items.filter((item) => item && item.candidate_id && item.name)
    : [];
  if (!items.length) return null;
  return (
    <div className="tw-chat-cards" aria-label="回答涉及的候选人">
      {items.map((item) => {
        const person = candidates.find((candidate) => candidate.id === item.candidate_id);
        return (
          <article className="tw-chat-card" key={item.candidate_id}>
            <TwAvatar size={56} candidate={{ id: item.candidate_id, name: item.name, has_photo: person?.has_photo ?? false, updated_at: person?.updated_at ?? "" }} />
            <div className="tw-chat-card-body">
              <strong>{item.name}</strong>
              <span>{[item.current_title, item.current_company].filter(Boolean).join(" · ") || "最近职位未填写"}</span>
            </div>
            <div className="tw-chat-card-actions">
              <button className="tw-btn tw-btn-sm" type="button" disabled={!canOpen || openingCandidateId === item.candidate_id} onClick={() => onOpen(item, "profile")}><FileText size={14} />档案</button>
              <button className="tw-btn tw-btn-sm" type="button" disabled={!canOpen || openingCandidateId === item.candidate_id} onClick={() => onOpen(item, "resume")}><BookOpen size={14} />履历</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TaskResultPreview({ task, mutationPending, onCancel, onRetryAnswer }: TaskResultPreviewProps) {
  const result = task.result;
  const rows = taskResultRows(result);
  const retained = Boolean(task.error?.retained_result || result);
  const canRetry = Boolean(task.can_retry_answer || (task.status === "partial" && task.result));
  const resultCount = task.result_count ?? result?.result_count ?? rows.length;
  const more = Boolean(task.has_more ?? result?.has_more);
  const resultEvidence = taskResultEvidence(result);
  const active = isActiveTask(task);
  const toolNames = (task.tools_used ?? []).map((tool) => typeof tool === "string" ? tool : tool.name ?? "").filter(Boolean);
  const usedWeb = toolNames.some((name) => name === "search_web" || name === "fetch_web_page");
  const usedDatabase = toolNames.some((name) => name !== "search_web" && name !== "fetch_web_page");
  const [processExpanded, setProcessExpanded] = useState(() => defaultTaskProcessExpanded(task));
  const previousTaskState = useRef({ taskId: task.task_id, status: task.status });

  useEffect(() => {
    const previous = previousTaskState.current;
    const taskChanged = previous.taskId !== task.task_id;
    const enteredTerminalState = previous.status !== task.status && TERMINAL_TASK_STATUSES.has(task.status);
    const resumed = TERMINAL_TASK_STATUSES.has(previous.status) && !TERMINAL_TASK_STATUSES.has(task.status);

    if (taskChanged || enteredTerminalState || resumed) {
      setProcessExpanded(defaultTaskProcessExpanded(task));
    }
    previousTaskState.current = { taskId: task.task_id, status: task.status };
  }, [task.task_id, task.status]);

  const processRegionId = `assistant-task-process-${task.task_id}`;
  const resultLabel = active
    ? taskStageLabel(task)
    : task.status === "partial"
      ? "已保留部分结果"
      : task.status === "completed"
        ? "查询完成"
        : task.status === "cancelled"
          ? "任务已取消"
          : "查询未完成";

  return (
    <section className={`assistant-task-result ${active ? "is-active" : ""} ${task.status === "partial" ? "is-partial" : ""}`} role={active ? "status" : task.error ? "alert" : undefined} aria-live="polite">
      <button
        className="assistant-task-result-header assistant-task-process-toggle"
        type="button"
        onClick={() => setProcessExpanded((expanded) => !expanded)}
        aria-expanded={processExpanded}
        aria-controls={processRegionId}
        aria-label={processExpanded ? "收起执行过程" : "展开执行过程"}
        title={processExpanded ? "收起执行过程" : "展开执行过程"}
      >
        <div className="assistant-task-result-title">
          {active ? <LoaderCircle className="spin" size={14} /> : task.error ? <AlertTriangle size={14} /> : <Check size={14} />}
          <strong>执行过程</strong>
          <small className="assistant-task-result-state">{resultLabel}</small>
          {typeof task.elapsed_ms === "number" && <small>{(task.elapsed_ms / 1000).toFixed(1)} 秒</small>}
        </div>
        <span className="assistant-task-result-meta">
          {usedDatabase && <span className="assistant-task-source is-database">数据库</span>}
          {usedWeb && <span className="assistant-task-source is-web">互联网</span>}
          {typeof resultCount === "number" && resultCount > 0 && <span className="assistant-task-result-count">已找到 {resultCount} 条</span>}
          <ChevronDown className={`assistant-task-process-chevron ${processExpanded ? "is-expanded" : ""}`} size={15} aria-hidden="true" />
        </span>
      </button>
      <div className="assistant-task-process-content" id={processRegionId} hidden={!processExpanded} role="region" aria-label="执行过程详情">
        <ol className="assistant-task-workflow" aria-label="Agent 工作流程">
          {TASK_WORKFLOW_STAGES.map((step, index) => {
            const state = taskWorkflowStepState(task, index);
            const duration = task.timings?.[step.key];
            return <li className={`is-${state}`} key={step.key} aria-current={state === "current" ? "step" : undefined}>
              <span className="assistant-task-workflow-marker">
                {state === "complete" ? <Check size={9} /> : state === "current" ? <LoaderCircle className="spin" size={9} /> : state === "stopped" ? <AlertTriangle size={9} /> : state === "skipped" ? <Minus size={9} /> : index + 1}
              </span>
              <span className="assistant-task-workflow-label">
                <span>{step.label}</span>
                {typeof duration === "number" && <small>{taskDurationLabel(duration)}</small>}
              </span>
            </li>;
          })}
        </ol>
        {typeof task.timings?.first_evidence_ms === "number" && <small className="assistant-task-first-evidence">首批证据 {taskDurationLabel(task.timings.first_evidence_ms)}</small>}
        {task.error && <p className="assistant-task-result-error">{taskErrorCopy(task.error)}</p>}
        {typeof result?.summary === "string" && result.summary && <p className="assistant-task-result-summary">{result.summary}</p>}
        {rows.length > 0 && <div className="assistant-task-result-rows">
          {rows.map((row, index) => {
            const title = row.name ?? row.title ?? row.candidate_name ?? row.id ?? row._tool ?? `结果 ${index + 1}`;
            const fields = Object.entries(row)
              .filter(([key, value]) => !["name", "title", "candidate_name", "id", "_tool", "evidence"].includes(key) && value !== null && value !== undefined && value !== "")
              .slice(0, 5);
            const rowEvidence = Array.isArray(row.evidence) ? row.evidence.filter(isResumeEvidence).slice(0, 2) : [];
            return <article key={`${String(row.id ?? title)}-${index}`}>
              <strong>{displayTaskValue(title)}</strong>
              {fields.map(([key, value]) => <span key={key}><b>{key}</b>{displayTaskValue(value)}</span>)}
              {rowEvidence.map((evidence) => <span className="assistant-task-row-evidence" key={evidence.document_id}><b>{evidence.field_path}</b><HighlightedSnippet evidence={evidence} /></span>)}
            </article>;
          })}
        </div>}
        {resultEvidence.length > 0 && <div className="assistant-task-result-evidence">
          {resultEvidence.map((evidence) => <div className="tw-evidence-card" key={`${evidence.document_id}:${evidence.field_path}:${evidence.snippet.start}:${evidence.snippet.end}`}>
            <span className="tw-evidence-source"><b>{evidence.source_table}</b><code>{evidence.field_path}</code></span>
            {evidenceActualTerms(evidence).length > 0 && <span className="tw-evidence-terms" aria-label="实际命中关键词">{evidenceActualTerms(evidence).map((term) => <mark key={term}>{term}</mark>)}</span>}
            <HighlightedSnippet evidence={evidence} />
          </div>)}
        </div>}
        {more && <small className="assistant-task-result-more">结果已限制在当前批次，可继续分页查看。</small>}
        {(active || canRetry) && <div className="assistant-task-result-actions">
          {active && <button className="tw-btn tw-btn-sm" type="button" onClick={() => onCancel(task)} disabled={mutationPending}><X size={13} />取消任务</button>}
          {!active && canRetry && <button className="tw-btn tw-btn-sm" type="button" onClick={() => onRetryAnswer(task)} disabled={mutationPending}><RefreshCw size={13} />继续生成结果</button>}
        </div>}
        {!active && !task.error && !retained && task.status === "cancelled" && <span className="assistant-task-result-more">没有产生可展示的结果。</span>}
      </div>
    </section>
  );
}

export function AssistantDrawer({
  open,
  configured,
  candidates,
  positions = [],
  talentPools = [],
  onClose,
  onOpenCandidateId,
  onCandidatesUpdated,
  initialTab = "chat",
  onToolChange,
}: AssistantDrawerProps) {
  const [tab, setTab] = useState<AssistantTab>(initialTab);
  const selectTab = (next: AssistantTab) => {
    setTab(next);
    onToolChange?.(next === "chat" ? "assistant" : next === "resume-search" ? "resume-search" : "attachment-parser");
  };
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("正在提交查询…");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [messagePagination, setMessagePagination] = useState<AgentMessagePagination | null>(null);
  const [messagePending, setMessagePending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionPagination, setSessionPagination] = useState<Pagination | null>(null);
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionPending, setSessionPending] = useState(false);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => readStoredSessionId());
  const [historyOpen, setHistoryOpenState] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentSession | null>(null);
  const [sessionMutationPending, setSessionMutationPending] = useState(false);
  const [resumeQuery, setResumeQuery] = useState("");
  const [resumeSubmittedQuery, setResumeSubmittedQuery] = useState("");
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [resumeState, setResumeState] = useState<"idle" | "success" | "cancelled" | "error">("idle");
  const [resumeCriteriaChanged, setResumeCriteriaChanged] = useState(false);
  const [resumeMetadata, setResumeMetadata] = useState<Pick<ResumeSearchResponse, "condition_summary" | "completeness" | "degradation">>({});
  const [resumePositionOptions, setResumePositionOptions] = useState<ResumeSearchOption[] | null>(null);
  const [resumePoolOptions, setResumePoolOptions] = useState<ResumeSearchOption[] | null>(null);
  const [resumeOptionsPending, setResumeOptionsPending] = useState(false);
  const [resumeOptionsError, setResumeOptionsError] = useState("");
  const [resumeOptionsRevision, setResumeOptionsRevision] = useState(0);
  const [resumeIndexError, setResumeIndexError] = useState("");
  const [resumeItems, setResumeItems] = useState<ResumeSearchItem[]>([]);
  const [resumePagination, setResumePagination] = useState<ResumeSearchCursorPagination | null>(null);
  const [resumeIndex, setResumeIndex] = useState<ResumeSearchIndexStatus | null>(null);
  const [resumeStatusRevision, setResumeStatusRevision] = useState(0);
  const [resumeField, setResumeField] = useState<"" | "title" | "content">("");
  const [resumeSourceType, setResumeSourceType] = useState<"" | "candidate" | "profile_section" | "attachment">("");
  const [resumePositionId, setResumePositionId] = useState("");
  const [resumePoolId, setResumePoolId] = useState("");
  const [resumeArchived, setResumeArchived] = useState<"exclude" | "include" | "only">("include");
  const [openingCandidateId, setOpeningCandidateId] = useState<string | null>(null);
  const [agentTasks, setAgentTasks] = useState<Record<string, AgentTask>>({});
  const [taskMutationPending, setTaskMutationPending] = useState<string | null>(null);
  const sessionRequest = useRef(0);
  const messageRequest = useRef(0);
  const resumeRequest = useRef(0);
  const sessionAbort = useRef<AbortController | null>(null);
  const messageAbort = useRef<AbortController | null>(null);
  const resumeAbort = useRef<AbortController | null>(null);
  const resumeStatusAbort = useRef<AbortController | null>(null);
  const resumeCursors = useRef<Map<number, string | null>>(new Map([[1, null]]));
  const resumeInputComposing = useRef(false);
  const sendAbort = useRef<AbortController | null>(null);
  const taskMutationAbort = useRef<AbortController | null>(null);
  const taskRecoveryAbort = useRef<AbortController | null>(null);
  const taskPollAbort = useRef<Map<string, AbortController>>(new Map());
  const taskPollTimer = useRef<Map<string, number>>(new Map());
  const messageRetryTimer = useRef<number | null>(null);
  const messageRetryDelay = useRef(MESSAGE_RECOVERY_INITIAL_DELAY_MS);
  const agentTasksRef = useRef<Record<string, AgentTask>>({});
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const activeSessionRef = useRef(activeSessionId);
  const submitLockRef = useRef(false);
  // Keep an ambiguous POST visible and recoverable until the server gives us
  // an authoritative terminal message. This prevents a dropped response from
  // being replaced by a second client_request_id.
  const pendingRequestRecovery = useRef<Map<string, PendingRequestRecovery>>(new Map());

  function upsertTask(task: AgentTask, fallbackSessionId?: string | null, fallbackClientRequestId?: string | null) {
    const normalized = normalizeTask(task, fallbackSessionId, fallbackClientRequestId);
    const next = { ...agentTasksRef.current, [normalized.task_id]: normalized };
    const entries = Object.entries(next);
    if (entries.length > 200) {
      entries
        .filter(([, item]) => !isActiveTask(item))
        .sort(([, left], [, right]) => String(left.updated_at ?? left.created_at ?? "").localeCompare(String(right.updated_at ?? right.created_at ?? "")))
        .slice(0, Math.max(0, entries.length - 200))
        .forEach(([id]) => delete next[id]);
    }
    agentTasksRef.current = next;
    setAgentTasks(next);
    return normalized;
  }

  function taskForSession(sessionId: string | null) {
    if (!sessionId) return null;
    return Object.values(agentTasksRef.current)
      .filter((task) => task.session_id === sessionId && isActiveTask(task))
      .sort((left, right) => String(right.updated_at ?? right.created_at ?? "").localeCompare(String(left.updated_at ?? left.created_at ?? "")))[0] ?? null;
  }

  function pendingRecoveryForSession(sessionId: string | null) {
    if (!sessionId) return null;
    return [...pendingRequestRecovery.current.values()]
      .find((entry) => entry.sessionId === sessionId) ?? null;
  }

  function forgetPendingRecovery(clientRequestId: string | null | undefined) {
    if (clientRequestId) pendingRequestRecovery.current.delete(clientRequestId);
  }

  function failPendingRecoveryMessage(clientRequestId: string | null | undefined, errorCode: string) {
    if (!clientRequestId) return;
    pendingRequestRecovery.current.delete(clientRequestId);
    setMessages((current) => failProcessingMessages(current, errorCode, clientRequestId));
  }

  function stopTaskPolling(taskId: string) {
    taskPollAbort.current.get(taskId)?.abort();
    taskPollAbort.current.delete(taskId);
    const timer = taskPollTimer.current.get(taskId);
    if (timer !== undefined) window.clearTimeout(timer);
    taskPollTimer.current.delete(taskId);
  }

  function stopSessionTaskPolling(sessionId: string | null) {
    if (!sessionId) return;
    Object.values(agentTasksRef.current).filter((task) => task.session_id === sessionId).forEach((task) => stopTaskPolling(task.task_id));
  }

  function clearMessageRecovery() {
    if (messageRetryTimer.current !== null) {
      window.clearTimeout(messageRetryTimer.current);
      messageRetryTimer.current = null;
    }
  }

  function scheduleMessageRecovery(sessionId: string) {
    if (sessionId !== activeSessionRef.current || messageRetryTimer.current !== null) return;
    const delay = messageRetryDelay.current;
    messageRetryDelay.current = Math.min(MESSAGE_RECOVERY_MAX_DELAY_MS, delay + 500);
    messageRetryTimer.current = window.setTimeout(() => {
      messageRetryTimer.current = null;
      void loadLatestMessages(sessionId, { clearError: false });
    }, delay);
  }

  function setActiveSessionId(value: string | null) {
    activeSessionRef.current = value;
    setActiveSessionIdState(value);
    writeStoredSessionId(value);
  }

  function selectSession(value: string | null) {
    const previousSessionId = activeSessionRef.current;
    if (value !== previousSessionId) {
      stopSessionTaskPolling(previousSessionId);
      sendAbort.current?.abort();
      taskRecoveryAbort.current?.abort();
      taskMutationAbort.current?.abort();
      clearMessageRecovery();
      messageRetryDelay.current = MESSAGE_RECOVERY_INITIAL_DELAY_MS;
      setPending(false);
      setPendingSessionId(null);
      messageAbort.current?.abort();
      messageRequest.current += 1;
      setMessagePending(false);
      setMessages([]);
      setMessagePagination(null);
      setChatError("");
    }
    setActiveSessionId(value);
  }

  function applyTaskUpdate(task: AgentTask, fallbackSessionId?: string | null, fallbackClientRequestId?: string | null) {
    const normalized = upsertTask(task, fallbackSessionId, fallbackClientRequestId);
    if ((normalized.user_message || normalized.assistant_message) && normalized.session_id === activeSessionRef.current) {
      setMessages((current) => mergeMessages(
        withoutOptimisticMessage(current, normalized.client_request_id),
        [normalized.user_message, normalized.assistant_message],
      ));
    }
    if (isActiveTask(normalized)) return normalized;

    stopTaskPolling(normalized.task_id);
    if (normalized.client_request_id) {
      if (normalized.user_message || normalized.assistant_message) {
        forgetPendingRecovery(normalized.client_request_id);
      } else if (normalized.error || normalized.status === "failed" || normalized.status === "cancelled") {
        failPendingRecoveryMessage(
          normalized.client_request_id,
          normalized.error?.code ?? (normalized.status === "cancelled" ? "task_cancelled" : "agent_task_failed"),
        );
      } else {
        forgetPendingRecovery(normalized.client_request_id);
        if (normalized.session_id === activeSessionRef.current) {
          setMessages((current) => withoutOptimisticMessage(current, normalized.client_request_id));
        }
      }
    }
    if (normalized.error && normalized.error.code !== "request_timeout" && normalized.session_id === activeSessionRef.current) {
      setChatError(taskErrorCopy(normalized.error));
    }
    return normalized;
  }

  function applySessionTurnResult(result: AgentSessionTurn, sessionId: string, clientRequestId: string) {
    if (activeSessionRef.current === sessionId) {
      setMessages((current) => mergeMessages(
        withoutOptimisticMessage(current, clientRequestId),
        [result.user_message, result.assistant_message],
      ));
    }
    const task = result.task ? applyTaskUpdate(result.task, sessionId, clientRequestId) : null;
    if (task && isActiveTask(task)) startTaskPolling(task);
    if (result.state !== "processing" && (!task || !isActiveTask(task))) {
      forgetPendingRecovery(clientRequestId);
    }
    setSessions((current) => [
      result.session,
      ...current.filter((session) => session.id !== result.session.id),
    ]);
    return task;
  }

  async function pollTask(taskId: string, delay = 800) {
    const known = agentTasksRef.current[taskId];
    if (!known || !isActiveTask(known)) return;
    const previousTimer = taskPollTimer.current.get(taskId);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      taskPollTimer.current.delete(taskId);
    }
    const previousAbort = taskPollAbort.current.get(taskId);
    previousAbort?.abort();
    const controller = new AbortController();
    taskPollAbort.current.set(taskId, controller);
    try {
      const next = await agentTaskApi.get(taskId, controller.signal);
      if (taskPollAbort.current.get(taskId) !== controller) return;
      const normalized = applyTaskUpdate(next, known.session_id, known.client_request_id);
      if (!normalized.error && normalized.session_id === activeSessionRef.current) {
        setChatError((current) => current.startsWith("任务状态暂时无法读取") ? "" : current);
      }
      if (isActiveTask(normalized)) {
        const nextDelay = Math.min(3_000, Math.max(800, delay + 400));
        const timer = window.setTimeout(() => void pollTask(taskId, nextDelay), nextDelay);
        taskPollTimer.current.set(taskId, timer);
      }
    } catch (error) {
      if (taskPollAbort.current.get(taskId) !== controller) return;
      if ((error as Error).name !== "AbortError") {
        if (typeof error === "object" && error !== null && "status" in error && Number((error as { status?: unknown }).status) === 404) {
          stopTaskPolling(taskId);
          if (known.session_id && known.session_id === activeSessionRef.current) {
            setChatError("正在从会话记录恢复任务状态…");
            void loadLatestMessages(known.session_id, { clearError: false });
          }
          return;
        }
        if (!isRequestTimeout(error) && known.session_id === activeSessionRef.current) {
          setChatError("任务状态暂时无法读取，正在重试；已提交的问题不会重复执行。");
        }
        if (isActiveTask(agentTasksRef.current[taskId])) {
          const nextDelay = Math.min(3_000, Math.max(800, delay + 400));
          const timer = window.setTimeout(() => void pollTask(taskId, nextDelay), nextDelay);
          taskPollTimer.current.set(taskId, timer);
        }
      }
    } finally {
      if (taskPollAbort.current.get(taskId) === controller) taskPollAbort.current.delete(taskId);
    }
  }

  function startTaskPolling(task: AgentTask) {
    if (!task.task_id || !isActiveTask(task) || (task.session_id && task.session_id !== activeSessionRef.current)) return;
    stopTaskPolling(task.task_id);
    const timer = window.setTimeout(() => void pollTask(task.task_id), 800);
    taskPollTimer.current.set(task.task_id, timer);
  }

  async function recoverTaskForRequest(sessionId: string, clientRequestId: string, message: string) {
    taskRecoveryAbort.current?.abort();
    const controller = new AbortController();
    taskRecoveryAbort.current = controller;
    let delay = TASK_RECOVERY_INITIAL_DELAY_MS;
    let attempt = 0;
    try {
      while (!controller.signal.aborted && activeSessionRef.current === sessionId) {
        let taskListRead = false;
        try {
          const result = await agentTaskApi.sessionTasks(sessionId, controller.signal);
          taskListRead = true;
          const recovered = result.items.find((task) => (
            task.client_request_id === clientRequestId
            && (!task.session_id || task.session_id === sessionId)
          ));
          if (recovered) {
            if (controller.signal.aborted || activeSessionRef.current !== sessionId) return null;
            const normalized = applyTaskUpdate(recovered, sessionId, clientRequestId);
            if (isActiveTask(normalized)) startTaskPolling(normalized);
            return normalized;
          }
        } catch (error) {
          if ((error as Error).name === "AbortError") return null;
          const retryable = isRequestTimeout(error) || !(error instanceof ApiError) || error.status >= 500;
          if (!retryable) {
            if (activeSessionRef.current === sessionId) {
              failPendingRecoveryMessage(clientRequestId, error instanceof ApiError ? error.code : "agent_recovery_failed");
            }
            if (activeSessionRef.current === sessionId) setChatError(error instanceof Error ? error.message : "无法恢复 Agent 任务。");
            return null;
          }
        }

        if (controller.signal.aborted || activeSessionRef.current !== sessionId) return null;
        if (taskListRead || attempt % TASK_RECOVERY_RESUBMIT_INTERVAL === 0) {
          setPendingLabel("正在确认任务已受理…");
          try {
             // Reusing the same request identity is safe: the server replays the
             // persisted turn instead of creating a duplicate task.
             const replayed = await agentSessionApi.send(sessionId, message, clientRequestId, controller.signal);
             if (controller.signal.aborted || activeSessionRef.current !== sessionId) return null;
             const task = applySessionTurnResult(replayed, sessionId, clientRequestId);
            if (task) return task;
            if (replayed.state !== "processing") return null;
          } catch (error) {
            if ((error as Error).name === "AbortError") return null;
            const retryable = isRequestTimeout(error) || !(error instanceof ApiError) || error.status >= 500;
            if (!retryable) {
              if (activeSessionRef.current === sessionId) {
                failPendingRecoveryMessage(clientRequestId, error instanceof ApiError ? error.code : "agent_recovery_failed");
              }
              if (activeSessionRef.current === sessionId) setChatError(error instanceof Error ? error.message : "无法确认 Agent 任务。");
              return null;
            }
          }
        }

        setPendingLabel("正在恢复任务状态…");
        await waitForRecoveryDelay(controller.signal, delay);
        delay = Math.min(TASK_RECOVERY_MAX_DELAY_MS, delay + 300);
        attempt += 1;
      }
      return null;
    } finally {
      if (taskRecoveryAbort.current === controller) taskRecoveryAbort.current = null;
    }
  }

  async function loadActiveTasks(sessionId: string, signal?: AbortSignal) {
    try {
      const result = await agentTaskApi.sessionTasks(sessionId, signal);
      if (sessionId !== activeSessionRef.current || signal?.aborted) return null;
      result.items.forEach((task) => {
        const normalized = upsertTask(task, sessionId);
        if (isActiveTask(normalized)) startTaskPolling(normalized);
      });
      return result.items;
    } catch (error) {
      if ((error as Error).name === "AbortError") return null;
      // Older V8 services do not expose the task endpoint. Message history
      // remains fully usable until the service is restarted with the task API.
      if (typeof error === "object" && error !== null && "status" in error && Number((error as { status?: unknown }).status) === 404) return [];
      if (sessionId === activeSessionRef.current) {
        if (isRetryableAgentRequest(error) && !signal?.aborted) {
          setChatError(MESSAGE_RECOVERY_COPY);
          scheduleMessageRecovery(sessionId);
        } else {
          const pendingRecovery = pendingRecoveryForSession(sessionId);
          const errorCode = error instanceof ApiError ? error.code : "message_read_failed";
          if (pendingRecovery) failPendingRecoveryMessage(pendingRecovery.clientRequestId, errorCode);
          else setMessages((current) => failProcessingMessages(current, errorCode));
          setChatError(error instanceof Error ? error.message : "无法读取 Agent 任务状态。");
        }
      }
      return null;
    }
  }

  async function loadSessions(page = sessionPage, preferredId = activeSessionId) {
    const requestId = ++sessionRequest.current;
    sessionAbort.current?.abort();
    const controller = new AbortController();
    sessionAbort.current = controller;
    setSessionPending(true);
    try {
      const [listResult, preferredLookup] = await Promise.all([
        agentSessionApi.list(page, 20, controller.signal),
        preferredId
          ? agentSessionApi.get(preferredId, controller.signal)
            .then((session) => ({ session, authoritative: true }))
            .catch((error: unknown) => {
              if ((error as Error).name === "AbortError") throw error;
              return {
                session: null,
                authoritative: error instanceof ApiError && (error.status === 404 || error.status === 410),
              };
            })
          : Promise.resolve({ session: null, authoritative: true }),
      ]);
      if (requestId !== sessionRequest.current) return;
      const preferredSession = preferredLookup.session;
      const pageItems = preferredSession && !listResult.items.some((session) => session.id === preferredSession.id)
        ? [preferredSession, ...listResult.items]
        : listResult.items;
      setSessions(pageItems);
      setSessionPagination(listResult.pagination);
      setSessionPage(page);
      if (preferredSession?.status === "active") selectSession(preferredSession.id);
      else if (!preferredId || (preferredLookup.authoritative && !pageItems.some((session) => session.id === preferredId && session.status === "active"))) {
        selectSession(pageItems.find((session) => session.status === "active")?.id ?? null);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === sessionRequest.current) {
        setChatError(error instanceof Error ? error.message : "无法读取历史会话。");
      }
    } finally {
      if (requestId === sessionRequest.current) setSessionPending(false);
    }
  }

  async function loadLatestMessages(sessionId: string, options: { clearError?: boolean; recoverTasks?: boolean; preserveRequest?: PendingRequestRecovery | null } = {}) {
    const requestId = ++messageRequest.current;
    clearMessageRecovery();
    messageAbort.current?.abort();
    const controller = new AbortController();
    messageAbort.current = controller;
    setMessagePending(true);
    if (options.clearError !== false) setChatError("");
    try {
      const result = await agentSessionApi.messages(sessionId, null, 50, controller.signal);
      if (requestId !== messageRequest.current || sessionId !== activeSessionRef.current) return null;
      messageRetryDelay.current = MESSAGE_RECOVERY_INITIAL_DELAY_MS;
      const pendingRecovery = options.preserveRequest === undefined
        ? pendingRecoveryForSession(sessionId)
        : options.preserveRequest;
      const persistedPending = pendingRecovery
        ? result.items.find((message) => message.client_request_id === pendingRecovery.clientRequestId)
        : null;
      if (persistedPending && persistedPending.status !== "processing") {
        forgetPendingRecovery(pendingRecovery?.clientRequestId);
      }
      const items = pendingRecovery && !persistedPending
        ? mergeMessages(result.items, [pendingRecovery.message])
        : result.items;
      setMessages(items);
      setMessagePagination(result.pagination);
      const processingTurn = [...items].reverse().find((message) => (
        message.role === "user"
        && message.status === "processing"
        && Boolean(message.client_request_id)
      ));
      if (options.recoverTasks !== false) void loadActiveTasks(sessionId, controller.signal).then((tasks) => {
        if (controller.signal.aborted || sessionId !== activeSessionRef.current || !processingTurn?.client_request_id) return;
        const matchingTask = tasks?.find((task) => task.client_request_id === processingTurn.client_request_id);
        if (matchingTask && !isActiveTask(matchingTask)) {
          void loadLatestMessages(sessionId, { clearError: false, recoverTasks: false });
          return;
        }
        if (!matchingTask && !taskForSession(sessionId)) {
          void recoverTaskForRequest(sessionId, processingTurn.client_request_id, processingTurn.content).then((recovered) => {
            if (sessionId === activeSessionRef.current && (!recovered || !isActiveTask(recovered))) {
              void loadLatestMessages(sessionId, { clearError: false, recoverTasks: false });
            }
          });
        }
      });
      return { ...result, items };
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === messageRequest.current) {
        if (isRetryableAgentRequest(error) && sessionId === activeSessionRef.current) {
          setChatError(MESSAGE_RECOVERY_COPY);
          scheduleMessageRecovery(sessionId);
        } else {
          const pendingRecovery = pendingRecoveryForSession(sessionId);
          const errorCode = error instanceof ApiError ? error.code : "message_read_failed";
          if (pendingRecovery) failPendingRecoveryMessage(pendingRecovery.clientRequestId, errorCode);
          else setMessages((current) => failProcessingMessages(current, errorCode));
          setChatError(error instanceof Error ? error.message : "无法读取会话消息。");
        }
      }
      return null;
    } finally {
      if (requestId === messageRequest.current) setMessagePending(false);
    }
  }

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) {
      setTab("chat");
      return;
    }
    if (configured) void loadSessions(1, readStoredSessionId());
    return () => {
      sessionAbort.current?.abort();
      messageAbort.current?.abort();
      resumeAbort.current?.abort();
      resumeStatusAbort.current?.abort();
      sendAbort.current?.abort();
      taskRecoveryAbort.current?.abort();
      taskMutationAbort.current?.abort();
      taskPollAbort.current.forEach((controller) => controller.abort());
      taskPollAbort.current.clear();
      taskPollTimer.current.forEach((timer) => window.clearTimeout(timer));
      taskPollTimer.current.clear();
      clearMessageRecovery();
    };
    // Session selection is handled separately so list refreshes do not loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, configured]);

  useEffect(() => {
    if (!open || !configured || !activeSessionId) {
      if (!activeSessionId) {
        setMessagePending(false);
        setMessages([]);
        setMessagePagination(null);
      }
      return;
    }
    void loadLatestMessages(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, configured, open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: number | null = null;
    const check = async () => {
      const controller = new AbortController();
      resumeStatusAbort.current?.abort();
      resumeStatusAbort.current = controller;
      try {
        const status = await getResumeSearchStatus(controller.signal);
        if (!active || controller.signal.aborted) return;
        setResumeIndex(status);
        setResumeIndexError("");
        if (!status.ready) {
          timer = window.setTimeout(() => void check(), Math.min(10_000, Math.max(1_000, Number(status.retry_after_ms) || 2_000)));
        }
      } catch (requestError) {
        if (!active || controller.signal.aborted) return;
        setResumeIndexError(requestError instanceof Error ? requestError.message : "无法读取履历索引状态。");
        timer = window.setTimeout(() => void check(), 3_000);
      }
    };
    void check();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      resumeStatusAbort.current?.abort();
    };
  }, [open, resumeStatusRevision]);

  useEffect(() => {
    if (!open || tab !== "resume-search") return;
    let active = true;
    const controller = new AbortController();
    setResumeOptionsPending(true);
    setResumeOptionsError("");
    Promise.all([getResumeSearchOptions("position", controller.signal), getResumeSearchOptions("talent_pool", controller.signal)])
      .then(([positionOptions, poolOptions]) => {
        if (!active) return;
        setResumePositionOptions(positionOptions);
        setResumePoolOptions(poolOptions);
      })
      .catch((error) => {
        if (!active || (error as Error).name === "AbortError") return;
        setResumeOptionsError(error instanceof Error ? error.message : "筛选选项读取失败，当前选项可能不完整。");
      })
      .finally(() => { if (active) setResumeOptionsPending(false); });
    return () => { active = false; controller.abort(); };
  }, [open, tab, resumeOptionsRevision]);

  useEffect(() => {
    if (!chatListRef.current || messagePending) return;
    const frame = requestAnimationFrame(() => chatListRef.current?.scrollTo({ top: chatListRef.current.scrollHeight }));
    return () => cancelAnimationFrame(frame);
  }, [messages.length, messagePending, pending]);

  async function createSession() {
    if (sessionMutationPending) return null;
    setSessionMutationPending(true);
    setChatError("");
    try {
      const session = await agentSessionApi.create();
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      selectSession(session.id);
      setMessages([]);
      setMessagePagination(null);
      setEditingSessionId(null);
      return session;
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "无法新建会话。");
      return null;
    } finally {
      setSessionMutationPending(false);
    }
  }

  async function submit(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const value = (preset ?? query).trim();
    if (!value || submitLockRef.current || pending || !configured || taskForSession(activeSessionId) || hasProcessingMessage) return;
    submitLockRef.current = true;
    let sessionId = activeSessionId;
    if (!sessionId) sessionId = (await createSession())?.id ?? null;
    if (!sessionId) {
      submitLockRef.current = false;
      return;
    }

    messageAbort.current?.abort();
    messageRequest.current += 1;
    setMessagePending(false);
    setQuery("");
    setPending(true);
    setPendingLabel("正在提交查询…");
    setPendingSessionId(sessionId);
    setChatError("");
    let optimisticMessageId: string | null = null;
    let clientRequestId = "";
    const controller = new AbortController();
    sendAbort.current?.abort();
    sendAbort.current = controller;
    try {
      clientRequestId = createClientRequestId();
      optimisticMessageId = `pending-${clientRequestId}`;
      const timestamp = new Date().toISOString();
      const optimisticMessage: AgentMessage = {
        id: optimisticMessageId!,
        session_id: sessionId!,
        // The real sequence is assigned by the state updater below. Keep the
        // recovery copy at the end of a later merged history until then.
        sequence: Number.MAX_SAFE_INTEGER,
        role: "user",
        content: value,
        status: "processing",
        client_request_id: clientRequestId,
        reply_to_message_id: null,
        model: null,
        tools_used: [],
        error_code: null,
        input_bytes: null,
        output_bytes: null,
        created_at: timestamp,
        completed_at: null,
      };
      pendingRequestRecovery.current.set(clientRequestId, {
        sessionId,
        clientRequestId,
        message: optimisticMessage,
      });
      setMessages((current) => [...current, { ...optimisticMessage, sequence: (current.at(-1)?.sequence ?? 0) + 1 }]);
      const result = await agentSessionApi.send(sessionId, value, clientRequestId, controller.signal);
      if (controller.signal.aborted || activeSessionRef.current !== sessionId) return;
      const task = applySessionTurnResult(result, sessionId, clientRequestId);
      if (!task && result.state === "processing") {
        setPendingLabel("正在恢复任务状态…");
        const recovered = await recoverTaskForRequest(sessionId, clientRequestId, value);
        if (!recovered && activeSessionRef.current === sessionId) {
          await loadLatestMessages(sessionId, { clearError: false, recoverTasks: false });
        }
      } else if (!task && result.state === "failed") {
        setChatError("问题在处理阶段失败，请查看会话中的失败原因后重试。");
      }
    } catch (error) {
      const aborted = (error as Error).name === "AbortError";
      const recoverable = isRetryableAgentRequest(error);
      const message = error instanceof Error ? error.message : "Agent 请求未能提交。";
      if (!aborted) {
        if (recoverable && activeSessionRef.current === sessionId && clientRequestId) {
          setPendingLabel("正在恢复任务状态…");
          const recovered = await recoverTaskForRequest(sessionId, clientRequestId, value);
          if ((!recovered || !isActiveTask(recovered)) && activeSessionRef.current === sessionId) {
            // Keep the optimistic turn and its client_request_id while the
            // authoritative message read is unavailable. A later retry can
            // then reconcile the same request instead of creating a duplicate.
            await loadLatestMessages(sessionId, {
              clearError: false,
              recoverTasks: false,
              preserveRequest: pendingRequestRecovery.current.get(clientRequestId) ?? null,
            });
          }
        } else {
          forgetPendingRecovery(clientRequestId);
          if (optimisticMessageId) setMessages((current) => current.filter((message) => message.id !== optimisticMessageId));
          await loadLatestMessages(sessionId, { clearError: false });
          if (activeSessionRef.current === sessionId) setChatError(message);
        }
      }
    } finally {
      if (sendAbort.current === controller) {
        sendAbort.current = null;
        setPending(false);
        setPendingLabel("正在提交查询…");
        setPendingSessionId(null);
      }
      submitLockRef.current = false;
    }
  }

  async function cancelTask(task: AgentTask) {
    if (!task.task_id || taskMutationPending) return;
    setTaskMutationPending(task.task_id);
    const sessionId = task.session_id;
    const controller = new AbortController();
    taskMutationAbort.current?.abort();
    taskMutationAbort.current = controller;
    try {
      stopTaskPolling(task.task_id);
      const cancelled = await agentTaskApi.cancel(task.task_id, controller.signal);
      if (taskMutationAbort.current !== controller || sessionId !== activeSessionRef.current) return;
      applyTaskUpdate(cancelled, task.session_id, task.client_request_id);
      if (isActiveTask(cancelled)) startTaskPolling(cancelled);
      else if (cancelled.session_id === activeSessionRef.current) setChatError(cancelled.error ? taskErrorCopy(cancelled.error) : "任务已取消，已保留会话记录。");
    } catch (error) {
      if ((error as Error).name !== "AbortError" && sessionId === activeSessionRef.current) setChatError(error instanceof Error ? error.message : "取消任务失败。");
      if (sessionId === activeSessionRef.current && isActiveTask(agentTasksRef.current[task.task_id])) startTaskPolling(agentTasksRef.current[task.task_id]);
    } finally {
      if (taskMutationAbort.current === controller) taskMutationAbort.current = null;
      setTaskMutationPending(null);
    }
  }

  async function retryTaskAnswer(task: AgentTask) {
    if (!task.task_id || taskMutationPending) return;
    setTaskMutationPending(task.task_id);
    setChatError("");
    const sessionId = task.session_id;
    const controller = new AbortController();
    taskMutationAbort.current?.abort();
    taskMutationAbort.current = controller;
    try {
      const retriedResponse = await agentTaskApi.retryAnswer(task.task_id, controller.signal);
      if (taskMutationAbort.current !== controller || sessionId !== activeSessionRef.current) return;
      const retried = applyTaskUpdate(retriedResponse, task.session_id, task.client_request_id);
      if (isActiveTask(retried)) startTaskPolling(retried);
      else if (retried.error && retried.session_id === activeSessionRef.current) setChatError(taskErrorCopy(retried.error));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && sessionId === activeSessionRef.current) {
        setChatError(error instanceof Error ? error.message : "重新生成回答失败；已保留原有查询结果。");
        if (task.task_id) {
          try {
            const recovered = await agentTaskApi.get(task.task_id);
            if (sessionId === activeSessionRef.current) {
              const normalized = applyTaskUpdate(recovered, sessionId, task.client_request_id);
              if (isActiveTask(normalized)) startTaskPolling(normalized);
            }
          } catch {}
        }
      }
    } finally {
      if (taskMutationAbort.current === controller) taskMutationAbort.current = null;
      setTaskMutationPending(null);
    }
  }

  async function loadEarlierMessages() {
    if (!activeSessionId || messagePending || !messagePagination?.has_more || !messagePagination.next_before_sequence) return;
    const sessionId = activeSessionId;
    const requestId = ++messageRequest.current;
    const controller = new AbortController();
    messageAbort.current = controller;
    setMessagePending(true);
    try {
      const result = await agentSessionApi.messages(sessionId, messagePagination.next_before_sequence, 50, controller.signal);
      if (requestId !== messageRequest.current || sessionId !== activeSessionRef.current) return;
      setMessages((current) => mergeMessages(result.items, current));
      setMessagePagination(result.pagination);
    } catch (error) {
      if ((error as Error).name !== "AbortError") setChatError(error instanceof Error ? error.message : "无法读取更早消息。");
    } finally {
      if (requestId === messageRequest.current) setMessagePending(false);
    }
  }

  async function renameSession(event: FormEvent, session: AgentSession) {
    event.preventDefault();
    const title = editingTitle.trim();
    if (!title || sessionMutationPending) return;
    setSessionMutationPending(true);
    try {
      const updated = await agentSessionApi.update(session.id, { title });
      setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingSessionId(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "无法重命名会话。");
    } finally {
      setSessionMutationPending(false);
    }
  }

  async function deleteSession() {
    if (!deleteTarget || sessionMutationPending) return;
    const sessionId = deleteTarget.id;
    setSessionMutationPending(true);
    try {
      await agentSessionApi.delete(sessionId);
      Object.values(agentTasksRef.current)
        .filter((task) => task.session_id === sessionId)
        .forEach((task) => stopTaskPolling(task.task_id));
      const remainingTasks = Object.fromEntries(Object.entries(agentTasksRef.current).filter(([, task]) => task.session_id !== sessionId));
      agentTasksRef.current = remainingTasks;
      setAgentTasks(remainingTasks);
      const remaining = sessions.filter((session) => session.id !== sessionId);
      setSessions(remaining);
      if (activeSessionId === sessionId) {
        selectSession(remaining[0]?.id ?? null);
      }
      setDeleteTarget(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "无法删除会话。");
    } finally {
      setSessionMutationPending(false);
    }
  }

  async function searchResumes(event?: FormEvent, requestedPage = 1, useSnapshot = false, explicitQuery?: string) {
    event?.preventDefault();
    if (useSnapshot && resumeCriteriaChanged) return;
    const value = (explicitQuery ?? (useSnapshot ? resumeSubmittedQuery : resumeQuery)).trim();
    if (!value) return;
    const requestId = ++resumeRequest.current;
    resumeAbort.current?.abort();
    const controller = new AbortController();
    resumeAbort.current = controller;
    setResumePending(true);
    setResumeError("");
    setResumeState("idle");
    setResumeCriteriaChanged(false);
    setResumeMetadata({});
    const filters: ResumeSearchFilters = {
      archived: resumeArchived,
      fields: resumeField || undefined,
      source_types: resumeSourceType || undefined,
      position_id: resumePositionId || undefined,
      talent_pool_id: resumePoolId || undefined,
    };
    if (!useSnapshot) resumeCursors.current = new Map([[1, null]]);
    const cursor = useSnapshot ? resumeCursors.current.get(requestedPage) : null;
    try {
      const result = await searchCandidateResumesWithPlan(value, requestedPage, 20, controller.signal, filters, cursor);
      if (controller.signal.aborted || requestId !== resumeRequest.current) return;
      setResumeItems(result.items);
      setResumePagination(result.pagination);
      if (result.index) setResumeIndex(result.index);
      if (result.pagination.current_cursor) resumeCursors.current.set(result.pagination.page ?? requestedPage, result.pagination.current_cursor);
      if (result.pagination.next_cursor) resumeCursors.current.set((result.pagination.page ?? requestedPage) + 1, result.pagination.next_cursor);
      setResumeSubmittedQuery(value);
      setResumeMetadata({ condition_summary: result.condition_summary, completeness: result.completeness, degradation: result.degradation });
      setResumeState("success");
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        if (requestId === resumeRequest.current) setResumeState("cancelled");
      } else if (requestId === resumeRequest.current) {
        if (error instanceof ApiError && error.code === "search_index_not_ready" && isResumeIndexStatus(error.details)) {
          setResumeIndex(error.details);
        }
        setResumeError(error instanceof Error ? error.message : "履历检索失败。");
        setResumeState("error");
        if (error instanceof ApiError && ["search_snapshot_stale", "search_cursor_stale", "search_index_changed", "invalid_cursor"].includes(error.code)) {
          resumeCursors.current = new Map([[1, null]]);
          setResumeCriteriaChanged(true);
        }
      }
    } finally {
      if (requestId === resumeRequest.current) setResumePending(false);
    }
  }

  function jumpToResumePage(target: number) {
    const currentPage = resumePagination?.page ?? 1;
    const totalPages = resumePagination?.total_pages ?? null;
    if (target === currentPage || target < 1) return;
    if (totalPages != null && target > totalPages) return;
    if (resumePending || resumeCriteriaChanged) return;
    const value = resumeSubmittedQuery.trim();
    if (!value) return;
    // A cached cursor keeps this page inside the frozen snapshot. Any other page is
    // requested directly: walking every page in between issued one full search per
    // page, which turned a single page jump into minutes once a search took seconds.
    if (resumeCursors.current.has(target)) {
      void searchResumes(undefined, target, true);
      return;
    }
    void searchResumes(undefined, target, false, value);
  }

  function markResumeCriteriaChanged() {
    resumeAbort.current?.abort();
    resumeRequest.current += 1;
    resumeCursors.current = new Map([[1, null]]);
    setResumePending(false);
    setResumeError("");
    setResumeMetadata({});
    setResumeCriteriaChanged(true);
    setResumeState("idle");
  }

  function cancelResumeSearch() {
    resumeRequest.current += 1;
    resumeAbort.current?.abort();
    setResumePending(false);
    setResumeState("cancelled");
  }

  async function openResult(item: ResumeSearchItem, tab: "profile" | "resume" = "profile") {
    if (openingCandidateId) return;
    setOpeningCandidateId(item.candidate_id);
    setResumeError("");
    try {
      onOpenCandidateId(item.candidate_id, tab);
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : "无法打开候选人详情。");
    } finally {
      setOpeningCandidateId(null);
    }
  }

  if (!open) return null;

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const terminalTask = Object.values(agentTasks)
    .filter((task) => task.session_id === activeSessionId && (task.result || task.error || task.status === "completed" || task.status === "partial" || task.status === "cancelled"))
    .sort((left, right) => String(right.updated_at ?? right.completed_at ?? right.created_at ?? "").localeCompare(String(left.updated_at ?? left.completed_at ?? left.created_at ?? "")))[0] ?? null;
  const activeTask = taskForSession(activeSessionId) ?? terminalTask;
  const hasProcessingMessage = messages.some((message) => (
    message.session_id === activeSessionId
    && message.role === "user"
    && message.status === "processing"
  ));
  const canOpenCandidate = true;
  const taskAnswerMessageId = activeTask
    ? messages.find((message) => isTaskAnswerMessage(activeTask, message))?.id ?? null
    : null;

  const toolTitle = tab === "chat" ? "AI 助手" : tab === "resume-search" ? "履历检索" : "解析并更新候选人";
  const toolSubtitle = tab === "chat"
    ? "基于本地人才库的只读问答，回答只引用可核对的证据"
    : "用自然语言描述你要找的人才";

  const sessionColumn = configured ? (
    <nav className="tw-tool-side" aria-label="历史会话">
      <div className="tw-tool-side-head">
        <h2>会话历史</h2>
        <div className="tw-tool-side-head-actions">
          <button className="tw-btn tw-btn-sm" type="button" onClick={() => void createSession()} disabled={sessionMutationPending}><Plus size={15} />新建会话</button>
          <button className="tw-icon-plain tw-tool-side-close" type="button" onClick={() => setHistoryOpenState(false)} aria-label="收起历史会话" title="收起历史会话"><PanelLeftClose size={16} /></button>
        </div>
      </div>
      {sessionPending && !sessions.length
        ? <div className="tw-tool-side-empty">正在读取历史会话…</div>
        : <div className="tw-tool-side-list">
          {sessions.map((session) => <div className={`tw-session-row${session.id === activeSessionId ? " is-active" : ""}`} key={session.id}>
            {editingSessionId === session.id
              ? <form className="tw-session-rename" onSubmit={(event) => void renameSession(event, session)}>
                <input autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} maxLength={200} aria-label="会话名称" />
                <button className="tw-icon-plain" type="submit" disabled={!editingTitle.trim() || sessionMutationPending} aria-label="保存名称" title="保存"><Check size={14} /></button>
                <button className="tw-icon-plain" type="button" onClick={() => setEditingSessionId(null)} aria-label="取消重命名" title="取消"><X size={14} /></button>
              </form>
              : <>
                <button className="tw-session" type="button" onClick={() => { selectSession(session.id); setHistoryOpenState(false); }} aria-current={session.id === activeSessionId ? "true" : undefined}>
                  <span className="tw-session-text"><strong>{session.title}</strong><small>{sessionTimeLabel(session.last_message_at) || `${session.message_count} 条消息`}</small></span>
                </button>
                <span className="tw-session-actions">
                  <button className="tw-icon-plain" type="button" onClick={() => { setEditingSessionId(session.id); setEditingTitle(session.title); }} aria-label={`重命名会话：${session.title}`} title="重命名"><Pencil size={13} /></button>
                  <button className="tw-icon-plain is-danger" type="button" onClick={() => setDeleteTarget(session)} aria-label={`删除会话：${session.title}`} title="删除"><Trash2 size={13} /></button>
                </span>
              </>}
          </div>)}
          {!sessions.length && <div className="tw-tool-side-empty">还没有历史会话</div>}
        </div>}
      {sessionPagination && sessionPagination.total_pages > 1 && <div className="tw-tool-side-foot">
        <button className="tw-icon-plain" type="button" disabled={sessionPending || sessionPage <= 1} onClick={() => void loadSessions(sessionPage - 1, activeSessionId)} aria-label="上一页会话"><ChevronLeft size={14} /></button>
        <span>{sessionPage} / {sessionPagination.total_pages}</span>
        <button className="tw-icon-plain" type="button" disabled={sessionPending || sessionPage >= sessionPagination.total_pages} onClick={() => void loadSessions(sessionPage + 1, activeSessionId)} aria-label="下一页会话"><ChevronRight size={14} /></button>
      </div>}
    </nav>
  ) : null;

  const chatBody = configured ? <div className="tw-chat-shell">
    <div className="tw-chat" ref={chatListRef}>
      {messagePagination?.has_more && <div className="tw-chat-more"><button className="tw-btn tw-btn-sm" type="button" onClick={() => void loadEarlierMessages()} disabled={messagePending}>加载更早消息</button></div>}
      {!messages.length && !messagePending && !activeTask
        ? <div className="tw-chat-empty">
          <span className="tw-chat-empty-icon"><Sparkles size={22} /></span>
          <h3>拾才助手</h3>
          <p>招聘库问题使用本机只读证据，时效问题使用受控联网检索，混合问题会分别标明来源。</p>
          <div className="tw-chat-quick">
            {quickQueries.map((item) => <button type="button" key={item} onClick={() => void submit(undefined, item)}><Search size={14} />{item}</button>)}
          </div>
        </div>
        : <div className="tw-chat-list" aria-live="polite">
          {messages.map((message) => {
            const messageTask = Object.values(agentTasks).find((task) => isTaskAnswerMessage(task, message)) ?? null;
            return <div key={message.id} className="tw-chat-entry">
              {activeTask && taskAnswerMessageId === message.id && <TaskResultPreview key={activeTask.task_id} task={activeTask} mutationPending={taskMutationPending === activeTask.task_id} onCancel={(task) => void cancelTask(task)} onRetryAnswer={(task) => void retryTaskAnswer(task)} />}
              <div className={`tw-msg ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                {message.role === "assistant" && <span className="tw-msg-avatar" aria-hidden="true"><Sparkles size={16} /></span>}
                <div className="tw-msg-bubble">
                  {message.role === "assistant" ? <AssistantMarkdown content={message.content} /> : <span>{message.content}</span>}
                  {message.status === "failed" && <small className="tw-msg-status">{messageErrorCopy(message.error_code)}</small>}
                  {message.role === "user" && message.status === "processing" && <small className="tw-msg-status is-processing">处理中…</small>}
                  {message.role === "user" && message.status === "completed" && <small className="tw-msg-time">{sessionTimeLabel(message.created_at)}</small>}
                </div>
                {message.role === "user" && <span className="tw-msg-avatar is-user" aria-hidden="true"><UserRound size={16} /></span>}
              </div>
              {message.role === "assistant" && messageTask && <TaskResultCandidates task={messageTask} candidates={candidates} canOpen={canOpenCandidate} openingCandidateId={openingCandidateId} onOpen={(item, tab) => void openResult(item, tab)} />}
              {message.role === "assistant" && messageTask && <AgentArtifactDownloads task={messageTask} />}
            </div>;
          })}
          {activeTask && !taskAnswerMessageId && <TaskResultPreview key={activeTask.task_id} task={activeTask} mutationPending={taskMutationPending === activeTask.task_id} onCancel={(task) => void cancelTask(task)} onRetryAnswer={(task) => void retryTaskAnswer(task)} />}
          {activeTask && !taskAnswerMessageId && <AgentArtifactDownloads task={activeTask} />}
          {(pending && pendingSessionId === activeSessionId || messagePending && !messages.length) && <div className="tw-msg is-assistant is-pending"><span className="tw-msg-pending"><LoaderCircle className="spin" size={15} aria-hidden="true" />{pending && pendingSessionId === activeSessionId ? pendingLabel : "正在恢复会话…"}</span></div>}
        </div>}
    </div>
    {chatError && (!activeTask?.error || isActiveTask(activeTask)) && <div className="tw-alert tw-alert-inline is-danger tw-chat-error" role="alert"><span>{chatError}</span></div>}
    <form className="tw-chat-composer" onSubmit={(event) => void submit(event)}>
      <div className="tw-chat-composer-surface">
        <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} placeholder="继续提问，例如“上海有哪些有产品设计经验的人才？”" aria-label="向拾才助手提问" />
        <button className="tw-chat-send" type="submit" disabled={!query.trim() || pending || sessionMutationPending || hasProcessingMessage || Boolean(activeTask && isActiveTask(activeTask))} aria-label="发送" title="发送"><Send size={17} /></button>
      </div>
      <p className="tw-chat-composer-note">拾才助手不会修改人才资料，回答仅引用本地人才库证据。</p>
    </form>
  </div> : <div className="tw-tool-scroll">
    <div className="tw-empty-card">
      <span className="tw-empty-icon"><Bot size={26} /></span>
      <h3>数据问答尚未配置</h3>
      <p>当前未建立模型连接；本地履历检索与附件更新仍可使用，不会返回任何编造结果。</p>
      <div className="tw-status-row"><LockKeyhole size={15} /><span>等待连接 Agent Gateway</span></div>
      <div className="tw-empty-actions">
        <button className="tw-btn" type="button" onClick={() => selectTab("resume-search")}><FileSearch size={16} />前往履历检索</button>
        <button className="tw-btn" type="button" onClick={() => selectTab("attachment")}><Paperclip size={16} />前往附件更新</button>
      </div>
    </div>
  </div>;

  const resumePageCount = resumePagination?.total_pages ?? Math.max(1, (resumePagination?.page ?? 1) + (resumePagination?.has_more || resumePagination?.has_next ? 1 : 0));

  const resumeBody = <>
    <form className="tw-search-bar" onSubmit={(event) => { if (resumeInputComposing.current) { event.preventDefault(); return; } void searchResumes(event); }} aria-label="履历检索">
      <span className="tw-search-input">
        <Search size={18} />
        <input value={resumeQuery} onChange={(event) => { markResumeCriteriaChanged(); setResumeQuery(event.target.value); }} onCompositionStart={() => { resumeInputComposing.current = true; }} onCompositionEnd={() => { resumeInputComposing.current = false; }} placeholder="上海，3年以上产品设计经验，本科及以上" aria-label="检索候选人履历" />
      </span>
      <button className="tw-btn tw-btn-primary tw-search-submit" type="submit" disabled={!resumeQuery.trim() || resumePending || resumeIndex?.ready === false}>{resumePending ? "检索中…" : "检索"}</button>
    </form>
    <div className="tw-search-filters">
      <div className="tw-seg-field">
        <span>活动</span>
        <div className="tw-seg" role="group" aria-label="归档范围">
          {([["include", "全部"], ["exclude", "在库"], ["only", "归档"]] as const).map(([value, label]) => <button className={resumeArchived === value ? "active" : ""} type="button" key={value} aria-pressed={resumeArchived === value} onClick={() => { markResumeCriteriaChanged(); setResumeArchived(value); }}>{label}</button>)}
        </div>
      </div>
      <label className="tw-select-field"><span>关联职位</span><select value={resumePositionId} onChange={(event) => { markResumeCriteriaChanged(); setResumePositionId(event.target.value); }}><option value="">全部职位</option>{(resumePositionOptions ?? positions.filter((position) => !position.archived_at).map((position) => ({ id: position.id, name: position.title }))).map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
      <label className="tw-select-field"><span>人才库</span><select value={resumePoolId} onChange={(event) => { markResumeCriteriaChanged(); setResumePoolId(event.target.value); }}><option value="">全部人才库</option>{(resumePoolOptions ?? talentPools.filter((pool) => !pool.archived_at).map((pool) => ({ id: pool.id, name: pool.name }))).map((pool) => <option value={pool.id} key={pool.id}>{pool.name}</option>)}</select></label>
      <details className="tw-search-more">
        <summary>更多筛选</summary>
        <div>
          <label className="tw-select-field"><span>字段</span><select value={resumeField} onChange={(event) => { markResumeCriteriaChanged(); setResumeField(event.target.value as typeof resumeField); }}><option value="">全部字段</option><option value="title">标题</option><option value="content">正文</option></select></label>
          <label className="tw-select-field"><span>来源</span><select value={resumeSourceType} onChange={(event) => { markResumeCriteriaChanged(); setResumeSourceType(event.target.value as typeof resumeSourceType); }}><option value="">全部来源</option><option value="candidate">候选人主档</option><option value="profile_section">履历区块</option><option value="attachment">附件简历</option></select></label>
        </div>
      </details>
    </div>
    {resumeOptionsPending && <div className="tw-status-line" role="status">正在更新职位和人才库选项…</div>}
    {resumeOptionsError && <div className="tw-status-line is-error" role="status">{resumeOptionsError} <button type="button" onClick={() => setResumeOptionsRevision((value) => value + 1)}>重试</button></div>}
    {resumeIndex && !resumeIndex.ready && <div className={`tw-status-line is-${resumeIndex.state}`} role="status">
      <LoaderCircle className={resumeIndex.state === "indexing" ? "spin" : ""} size={16} />
      <span>{resumeIndex.state === "failed" ? "履历索引不可用" : "履历索引准备中"}：{resumeIndex.remaining == null ? "正在核对索引状态" : `剩余 ${resumeIndex.remaining} 条`}</span>
      {resumeIndex.progress != null && <progress max={1} value={resumeIndex.progress} />}
      <button className="tw-icon-plain" type="button" onClick={() => { setResumeError(""); setResumeStatusRevision((revision) => revision + 1); }} aria-label="重新检查索引" title="重新检查"><RefreshCw size={14} /></button>
    </div>}
    {resumeIndexError && <div className="tw-status-line is-error" role="status"><span>{resumeIndexError}</span><button className="tw-icon-plain" type="button" onClick={() => setResumeStatusRevision((value) => value + 1)} aria-label="重新读取索引状态" title="重新读取索引状态"><RefreshCw size={14} /></button></div>}
    {resumeCriteriaChanged && resumeSubmittedQuery && <div className="tw-status-line is-warning" role="status">条件已改变，下方仍为上次检索结果。</div>}
    {resumePending && <div className="tw-status-line" role="status"><LoaderCircle className="spin" size={16} /><span>正在检索{resumeItems.length > 0 ? "，暂保留上次结果" : ""}…</span><button className="tw-icon-plain" type="button" onClick={cancelResumeSearch} aria-label="取消检索" title="取消检索"><X size={16} /></button></div>}
    {resumeState === "cancelled" && <div className="tw-status-line" role="status"><span>检索已取消{resumeItems.length > 0 ? "，已保留上次结果" : ""}。</span><button className="tw-icon-plain" type="button" onClick={() => void searchResumes()} aria-label="重新检索" title="重新检索"><RefreshCw size={16} /></button></div>}
    {resumeError && <div className="tw-status-line is-error" role="alert"><span>{resumeError}{resumeItems.length > 0 ? " 已保留上次结果。" : ""}</span>{resumeState === "error" && <button className="tw-icon-plain" type="button" onClick={() => void searchResumes()} aria-label="重试检索" title="重试检索"><RefreshCw size={16} /></button>}</div>}
    {resumeMetadata.condition_summary && resumeMetadata.condition_summary.length > 0 && <details className="tw-conditions">
      <summary>已识别 {resumeMetadata.condition_summary.length} 项条件</summary>
      <div>{resumeMetadata.condition_summary.map((condition) => <span className={`tw-condition is-${condition.kind}`} key={condition.id}>{condition.kind === "required" ? "必需" : condition.kind === "excluded" ? "排除" : condition.kind === "preferred" ? "偏好" : "未解析"}：{condition.text}</span>)}</div>
    </details>}
    {((resumeMetadata.degradation?.length ?? 0) > 0 || (resumeMetadata.completeness && (resumeMetadata.completeness.conditions !== "complete" || resumeMetadata.completeness.retrieval !== "complete"))) && <div className="tw-status-line is-warning is-compact" role="status">
      <AlertTriangle size={14} />
      <span>{[...(resumeMetadata.degradation ?? []).map((item) => item.message), resumeMetadata.completeness && (resumeMetadata.completeness.conditions !== "complete" || resumeMetadata.completeness.retrieval !== "complete") ? `结果可能不完整：${[resumeMetadata.completeness.conditions === "partial" ? "部分条件未执行" : "", resumeMetadata.completeness.retrieval === "index_not_ready" ? "索引尚未就绪" : resumeMetadata.completeness.retrieval === "bounded" ? "召回范围受限" : resumeMetadata.completeness.retrieval === "partial" ? "部分来源尚未检索" : ""].filter(Boolean).join("；")}。` : ""].filter(Boolean).join(" · ")}</span>
    </div>}
    {!resumeItems.length && !resumePending && !resumeError && resumeState !== "cancelled" && <div className="tw-empty-card is-slim">
      <span className="tw-empty-icon"><FileSearch size={22} /></span>
      <h3>{resumeState === "success" ? "未找到符合已执行条件的候选人" : "等待检索条件"}</h3>
      <p>{resumeState === "success" ? `“${resumeSubmittedQuery}”` : "输入自然语言条件后回车即可检索本地履历与档案。"}</p>
    </div>}
    {resumeItems.length > 0 && <div className="tw-results" aria-busy={resumePending}>
      <div className="tw-results-head">
        <h2>{resumePagination?.total == null ? `本页 ${resumeItems.length} 位候选人` : `${resumePagination.total} 位候选人`}</h2>
        <span className="tw-results-query">“{resumeSubmittedQuery}”</span>
      </div>
      {resumePending && <div className="tw-results-loading" role="status"><LoaderCircle className="spin" size={15} />正在检索…</div>}
      <div className="tw-table-scroll">
        <table className="tw-table tw-search-table">
          <thead>
            <tr>
              <th className="tw-col-name" scope="col">候选人</th>
              <th className="tw-col-place" scope="col">所在城市</th>
              <th className="tw-col-education" scope="col">学历</th>
              <th className="tw-col-experience" scope="col">工作经验</th>
              <th className="tw-col-recent" scope="col">最近公司</th>
              <th className="tw-col-evidence" scope="col">匹配证据</th>
              <th className="tw-col-actions" scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {resumeItems.map((item) => {
              const person = candidates.find((candidate) => candidate.id === item.candidate_id);
              const fields = [...new Set(item.matched_fields.map(searchFieldLabel))];
              const hasEvidence = Boolean(item.evidence?.length || item.snippets?.length);
              const statusTag = item.condition_status === "padding"
                ? "仅补足分页"
                : item.condition_status === "unknown"
                  ? "待核实"
                  : item.condition_status === "partial" && hasEvidence
                    ? "部分匹配"
                    : null;
              return (
                <tr key={item.candidate_id}>
                  <td className="tw-col-name">
                    <div className="tw-cell-name">
                      <TwAvatar candidate={{ id: item.candidate_id, name: item.name, has_photo: person?.has_photo ?? false, updated_at: person?.updated_at ?? "" }} size={80} />
                      <span className="tw-stack">
                        <strong>{item.name}</strong>
                        <small>{item.current_title || "最近职位未填写"}</small>
                      </span>
                      {statusTag && <span className="tw-tag is-warning">{statusTag}</span>}
                    </div>
                  </td>
                  <td className="tw-col-place">{person?.location || "未填写"}</td>
                  <td className="tw-col-education">{person?.education || "未填写"}</td>
                  <td className="tw-col-experience">{searchYearsText(person)}</td>
                  <td className="tw-search-company tw-col-recent">{item.current_company || "最近公司未填写"}</td>
                  <td className="tw-col-evidence">
                    <div className="tw-evidence">
                      <div className="tw-result-fields">{fields.map((field) => <i key={field}>{field}</i>)}</div>
                      <span className="tw-evidence-label"><FileSearch size={13} />匹配证据</span>
                      {(item.evidence ?? []).map((evidence, evidenceIndex) => <SearchEvidence evidence={evidence} key={`${evidence.document_id}:${evidenceIndex}`} />)}
                      {!(item.evidence?.length) && item.snippets.map((snippet, snippetIndex) => <span className="tw-evidence-legacy" key={snippetIndex}>{snippet}</span>)}
                      {item.reasons.length > 0 && <small>{[...new Set(item.reasons.map(searchReasonLabel))].join(" · ")}</small>}
                    </div>
                  </td>
                  <td className="tw-col-actions">
                    <button className="tw-btn tw-btn-sm" type="button" onClick={() => void openResult(item)} disabled={!canOpenCandidate || openingCandidateId === item.candidate_id}>{openingCandidateId === item.candidate_id ? "打开中…" : "查看档案"}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tw-pagination">
        <span>共 {resumePagination?.total == null ? `本页 ${resumeItems.length} 位` : `${resumePagination.total} 位候选人`}</span>
        <div className="tw-pages" role="navigation" aria-label="检索结果分页">
          <button type="button" disabled={resumePending || resumeCriteriaChanged || (resumePagination?.page ?? 1) <= 1} onClick={() => void jumpToResumePage((resumePagination?.page ?? 1) - 1)} aria-label="上一页"><ChevronLeft size={16} /></button>
          {resumePageCount > 1
            ? visiblePages(resumePagination?.page ?? 1, resumePageCount).map((value, index) => value === "gap"
              ? <span className="tw-ellipsis" key={`gap-${index}`}>···</span>
              : <button className={value === (resumePagination?.page ?? 1) ? "active" : ""} type="button" key={value} aria-current={value === (resumePagination?.page ?? 1) ? "page" : undefined} disabled={resumePending || resumeCriteriaChanged} onClick={() => void jumpToResumePage(value)}>{value}</button>)
            : <button className="active" type="button" aria-current="page" disabled>{resumePagination?.page ?? 1}</button>}
          <button type="button" disabled={resumePending || resumeCriteriaChanged || !(resumePagination?.has_more || resumePagination?.has_next)} onClick={() => void jumpToResumePage((resumePagination?.page ?? 1) + 1)} aria-label="下一页"><ChevronRight size={16} /></button>
        </div>
        {resumePagination?.total_pages == null && <span className="tw-pagination-note">第 {resumePagination?.page ?? 1} 页</span>}
      </div>
    </div>}
  </>;

  const attachmentBody = <AttachmentBatchWorkflow
    candidates={candidates}
    onCommitted={() => onCandidatesUpdated?.()}
    onCandidateCreated={() => onCandidatesUpdated?.()}
    onExit={onClose}
  />;

  const mainBody = tab === "chat"
    ? chatBody
    : tab === "resume-search"
    ? <div className="tw-tool-scroll">{resumeBody}</div>
    : attachmentBody;

  const deleteDialog = deleteTarget ? (
    <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !sessionMutationPending && setDeleteTarget(null)}>
      <div className="tw-modal tw-modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="assistant-session-delete-title">
        <header className="tw-modal-head">
          <div className="tw-modal-title-row"><Trash2 size={18} /><h2 id="assistant-session-delete-title">删除“{deleteTarget.title}”？</h2></div>
        </header>
        <div className="tw-modal-body"><p>该会话的消息和摘要将从本机 SQLite 永久删除，无法恢复；候选人和其他业务数据不受影响。</p></div>
        <footer className="tw-modal-foot">
          <button className="tw-btn" type="button" onClick={() => setDeleteTarget(null)} disabled={sessionMutationPending}>取消</button>
          <button className="tw-btn tw-btn-danger" type="button" onClick={() => void deleteSession()} disabled={sessionMutationPending}>{sessionMutationPending ? "删除中…" : "确认删除"}</button>
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <section className="tw-page tw-tool-page" aria-label={toolTitle}>
      <div className="tw-tool">
        {tab === "chat" && configured && historyOpen && <>
          <button className="tw-tool-side-scrim" type="button" onClick={() => setHistoryOpenState(false)} aria-label="关闭历史会话" />
          {sessionColumn}
        </>}
        <div className="tw-tool-main">
          {tab !== "attachment" && <header className={`tw-tool-head${tab === "chat" ? " tw-chat-head" : ""}`}>
            <div>
              <h1>{toolTitle}</h1>
              {toolSubtitle && <p className="tw-sub">{toolSubtitle}</p>}
            </div>
            <div className="tw-page-actions">
              {tab === "chat" && <span className="tw-readonly" title="只读数据源：不会修改人才资料"><ShieldCheck size={13} />全量只读</span>}
              {tab === "chat" && configured && <button className="tw-icon-plain" type="button" onClick={() => setHistoryOpenState((current) => !current)} aria-label={historyOpen ? "收起历史会话" : "展开历史会话"} title={historyOpen ? "收起历史会话" : "展开历史会话"} aria-expanded={historyOpen}>{historyOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>}
              <button className="tw-btn" type="button" onClick={onClose}><ArrowLeft size={16} />返回人才库</button>
            </div>
          </header>}
          {mainBody}
        </div>
      </div>
      {deleteDialog}
    </section>
  );
}
