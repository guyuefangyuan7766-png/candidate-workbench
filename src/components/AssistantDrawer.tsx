import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSearch,
  History,
  LoaderCircle,
  LockKeyhole,
  Minus,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { agentSessionApi, agentTaskApi, candidateApi, getResumeSearchStatus, searchCandidateResumes, ApiError } from "../api";
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
  Candidate,
  Position,
  TalentPool,
} from "../types";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AttachmentBatchWorkflow } from "./AttachmentBatchWorkflow";

const ACTIVE_SESSION_STORAGE_KEY = "candidate-workbench.agent.active-session-id.v1";
const HISTORY_OPEN_STORAGE_KEY = "candidate-workbench.agent.history-open.v1";
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
  onOpenCandidateId?: (candidateId: string) => void;
  onOpenCandidate?: (candidate: Candidate) => void;
  onCandidatesUpdated?: () => void;
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

function readStoredHistoryOpen() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HISTORY_OPEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredHistoryOpen(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HISTORY_OPEN_STORAGE_KEY, String(value));
  } catch {
    // UI preferences safely fall back to their defaults when storage is unavailable.
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
  return <span className="resume-evidence-snippet">{snippet.truncated_before ? "…" : ""}{content}{snippet.truncated_after ? "…" : ""}</span>;
}

function evidenceActualTerms(evidence: ResumeSearchEvidence) {
  return [...new Set([
    ...(evidence.matched_actual_terms ?? []),
    ...(evidence.snippet?.highlights ?? []).flatMap((range) => range.actual_terms ?? (range.actual_term ? [range.actual_term] : [])),
  ].map(String).filter(Boolean))];
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
          {resultEvidence.map((evidence) => <div className="resume-evidence" key={`${evidence.document_id}:${evidence.field_path}:${evidence.snippet.start}:${evidence.snippet.end}`}>
            <span className="resume-evidence-source"><b>{evidence.source_table}</b><code>{evidence.field_path}</code></span>
            {evidenceActualTerms(evidence).length > 0 && <span className="resume-evidence-terms" aria-label="实际命中关键词">{evidenceActualTerms(evidence).map((term) => <mark key={term}>{term}</mark>)}</span>}
            <HighlightedSnippet evidence={evidence} />
          </div>)}
        </div>}
        {more && <small className="assistant-task-result-more">结果已限制在当前批次，可继续分页查看。</small>}
        {(active || canRetry) && <div className="assistant-task-result-actions">
          {active && <button className="button secondary-button" type="button" onClick={() => onCancel(task)} disabled={mutationPending}><X size={13} />取消任务</button>}
          {!active && canRetry && <button className="button secondary-button" type="button" onClick={() => onRetryAnswer(task)} disabled={mutationPending}><RefreshCw size={13} />继续生成结果</button>}
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
  onOpenCandidate,
  onCandidatesUpdated,
}: AssistantDrawerProps) {
  const [tab, setTab] = useState<AssistantTab>("chat");
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
  const [historyOpen, setHistoryOpenState] = useState(() => readStoredHistoryOpen());
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentSession | null>(null);
  const [sessionMutationPending, setSessionMutationPending] = useState(false);
  const [resumeQuery, setResumeQuery] = useState("");
  const [resumeSubmittedQuery, setResumeSubmittedQuery] = useState("");
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState("");
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

  function setHistoryOpen(value: boolean) {
    setHistoryOpenState(value);
    writeStoredHistoryOpen(value);
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
        if (!status.ready) {
          timer = window.setTimeout(() => void check(), Math.min(10_000, Math.max(1_000, Number(status.retry_after_ms) || 2_000)));
        }
      } catch (requestError) {
        if (!active || controller.signal.aborted) return;
        setResumeError(requestError instanceof Error ? requestError.message : "无法读取履历索引状态。");
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

  async function searchResumes(event?: FormEvent, requestedPage = 1) {
    event?.preventDefault();
    const value = (requestedPage === 1 ? resumeQuery : resumeSubmittedQuery).trim();
    if (!value) return;
    const requestId = ++resumeRequest.current;
    resumeAbort.current?.abort();
    const controller = new AbortController();
    resumeAbort.current = controller;
    setResumePending(true);
    setResumeError("");
    const filters: ResumeSearchFilters = {
      archived: resumeArchived,
      fields: resumeField || undefined,
      source_types: resumeSourceType || undefined,
      position_id: resumePositionId || undefined,
      talent_pool_id: resumePoolId || undefined,
    };
    if (requestedPage === 1) resumeCursors.current = new Map([[1, null]]);
    const cursor = requestedPage > 1 ? resumeCursors.current.get(requestedPage) : null;
    try {
      const result = await searchCandidateResumes(value, requestedPage, 20, controller.signal, filters, cursor);
      if (requestId !== resumeRequest.current) return;
      setResumeItems(result.items);
      setResumePagination(result.pagination);
      if (result.index) setResumeIndex(result.index);
      if (result.pagination.next_cursor) resumeCursors.current.set((result.pagination.page ?? requestedPage) + 1, result.pagination.next_cursor);
      setResumeSubmittedQuery(value);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === resumeRequest.current) {
        if (error instanceof ApiError && error.code === "search_index_not_ready" && isResumeIndexStatus(error.details)) {
          setResumeIndex(error.details);
        }
        setResumeError(error instanceof Error ? error.message : "履历检索失败。");
      }
    } finally {
      if (requestId === resumeRequest.current) setResumePending(false);
    }
  }

  async function openResult(item: ResumeSearchItem) {
    if (openingCandidateId) return;
    setOpeningCandidateId(item.candidate_id);
    setResumeError("");
    try {
      if (onOpenCandidateId) {
        onOpenCandidateId(item.candidate_id);
      } else if (onOpenCandidate) {
        onOpenCandidate(await candidateApi.get(item.candidate_id));
      }
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
  const canOpenCandidate = Boolean(onOpenCandidateId || onOpenCandidate);
  const taskAnswerMessageId = activeTask
    ? messages.find((message) => isTaskAnswerMessage(activeTask, message))?.id ?? null
    : null;

  return (
    <div className="drawer-layer assistant-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer assistant-drawer" role="dialog" aria-modal="true" aria-label="智能助手">
        <header className="drawer-header">
          <div><p className="drawer-kicker">Agent</p><h2>智能助手</h2></div>
          <div className="assistant-header-actions">
            <span className="readonly-badge"><ShieldCheck size={13} />受控数据源</span>
            {configured && <button className="icon-button" type="button" onClick={() => setHistoryOpen(!historyOpen)} aria-label={historyOpen ? "收起历史会话" : "打开历史会话"} title={historyOpen ? "收起历史会话" : "历史会话"}><History size={18} /></button>}
            {configured && <button className="icon-button" type="button" onClick={() => void createSession()} disabled={sessionMutationPending} aria-label="新建会话" title="新建会话"><Plus size={18} /></button>}
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭" title="关闭"><X size={19} /></button>
          </div>
        </header>

        <div className="assistant-mode-tabs" role="tablist" aria-label="助手工具">
          <button className={tab === "chat" ? "active" : ""} type="button" onClick={() => setTab("chat")}><Bot size={15} />数据问答</button>
          <button className={tab === "resume-search" ? "active" : ""} type="button" onClick={() => setTab("resume-search")}><FileSearch size={15} />履历检索</button>
          <button className={tab === "attachment" ? "active" : ""} type="button" onClick={() => setTab("attachment")}><Paperclip size={15} />附件更新</button>
        </div>

        {tab === "chat" && (configured ? <div className="assistant-chat-workspace">
          <div className="assistant-session-context">
            <button type="button" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>
              <History size={14} /><span>{activeSession?.title ?? "新对话"}</span><small>{activeSession?.message_count ?? 0} 条消息</small>
            </button>
          </div>

          {historyOpen && <section className="assistant-session-panel" aria-label="历史会话">
            <div className="assistant-session-panel-header"><strong>历史会话</strong><button className="icon-button" type="button" onClick={() => void createSession()} disabled={sessionMutationPending} aria-label="新建会话" title="新建会话"><Plus size={15} /></button></div>
            {sessionPending && !sessions.length ? <div className="assistant-session-loading">正在读取历史会话…</div> : <div className="assistant-session-list">
              {sessions.map((session) => <div className={`assistant-session-item ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
                {editingSessionId === session.id ? <form onSubmit={(event) => void renameSession(event, session)}>
                  <input autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} maxLength={200} aria-label="会话名称" />
                  <button className="icon-button" type="submit" disabled={!editingTitle.trim() || sessionMutationPending} aria-label="保存名称" title="保存"><Check size={14} /></button>
                  <button className="icon-button" type="button" onClick={() => setEditingSessionId(null)} aria-label="取消重命名" title="取消"><X size={14} /></button>
                </form> : <>
                  <button className="assistant-session-select" type="button" onClick={() => { selectSession(session.id); setHistoryOpen(false); }}>
                    <strong>{session.title}</strong><span>{session.message_count} 条消息</span>
                  </button>
                  <button className="icon-button" type="button" onClick={() => { setEditingSessionId(session.id); setEditingTitle(session.title); }} aria-label={`重命名会话：${session.title}`} title="重命名"><Pencil size={13} /></button>
                  <button className="icon-button danger-icon-button" type="button" onClick={() => setDeleteTarget(session)} aria-label={`删除会话：${session.title}`} title="删除"><Trash2 size={13} /></button>
                </>}
              </div>)}
              {!sessions.length && <div className="assistant-session-loading">还没有历史会话</div>}
            </div>}
            {sessionPagination && sessionPagination.total_pages > 1 && <div className="assistant-session-pagination">
              <button className="icon-button" type="button" disabled={sessionPending || sessionPage <= 1} onClick={() => void loadSessions(sessionPage - 1, activeSessionId)} aria-label="上一页会话"><ChevronLeft size={14} /></button>
              <span>{sessionPage} / {sessionPagination.total_pages}</span>
              <button className="icon-button" type="button" disabled={sessionPending || sessionPage >= sessionPagination.total_pages} onClick={() => void loadSessions(sessionPage + 1, activeSessionId)} aria-label="下一页会话"><ChevronRight size={14} /></button>
            </div>}
          </section>}

          <div className="assistant-content" ref={chatListRef}>
            {messagePagination?.has_more && <button className="assistant-load-earlier" type="button" onClick={() => void loadEarlierMessages()} disabled={messagePending}>加载更早消息</button>}
            {!messages.length && !messagePending && !activeTask ? <div className="assistant-welcome">
              <span><Sparkles size={24} /></span>
              <h3>数据库与互联网按问题路由</h3>
              <p className="assistant-boundary-copy">招聘库问题使用本机只读证据，时效问题使用受控联网检索，混合问题会分别标明来源。消息保存在本机 SQLite。</p>
              <div className="quick-query-list">
                {quickQueries.map((item) => <button type="button" key={item} onClick={() => void submit(undefined, item)}><Search size={14} />{item}</button>)}
              </div>
             </div> : <div className="chat-list" aria-live="polite">
            {messages.map((message) => {
              const messageTask = Object.values(agentTasks).find((task) => isTaskAnswerMessage(task, message)) ?? null;
              return <div key={message.id} className="assistant-chat-entry">
                 {activeTask && taskAnswerMessageId === message.id && <TaskResultPreview key={activeTask.task_id} task={activeTask} mutationPending={taskMutationPending === activeTask.task_id} onCancel={(task) => void cancelTask(task)} onRetryAnswer={(task) => void retryTaskAnswer(task)} />}
                 <div className={`chat-message ${message.role}`}>
                   {message.role === "assistant" ? <AssistantMarkdown content={message.content} /> : <span>{message.content}</span>}
                   {message.status === "failed" && <small className="chat-message-status">{messageErrorCopy(message.error_code)}</small>}
                   {message.role === "user" && message.status === "processing" && <small className="chat-message-status is-processing">处理中…</small>}
                 </div>
                 {message.role === "assistant" && messageTask && <AgentArtifactDownloads task={messageTask} />}
               </div>})}
                 {activeTask && !taskAnswerMessageId && <TaskResultPreview key={activeTask.task_id} task={activeTask} mutationPending={taskMutationPending === activeTask.task_id} onCancel={(task) => void cancelTask(task)} onRetryAnswer={(task) => void retryTaskAnswer(task)} />}
                 {activeTask && !taskAnswerMessageId && <AgentArtifactDownloads task={activeTask} />}
                 {(pending && pendingSessionId === activeSessionId || messagePending && !messages.length) && <div className="chat-message assistant pending-message"><span>{pending && pendingSessionId === activeSessionId ? pendingLabel : "正在恢复会话…"}</span></div>}
              </div>}
          </div>
          {chatError && (!activeTask?.error || isActiveTask(activeTask)) && <div className="assistant-chat-error" role="alert">{chatError}</div>}
          <form className="assistant-composer" onSubmit={(event) => void submit(event)}>
            <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} placeholder="询问候选人、职位、履历或招聘统计" />
            <button className="icon-button assistant-send" type="submit" disabled={!query.trim() || pending || sessionMutationPending || hasProcessingMessage || Boolean(activeTask && isActiveTask(activeTask))} aria-label="发送" title="发送"><Send size={17} /></button>
          </form>
        </div> : <div className="agent-empty-state">
          <span className="agent-empty-icon"><Bot size={32} /></span>
          <h3>数据问答尚未配置</h3>
          <p>当前未建立模型连接；本地履历检索与附件更新仍可使用。</p>
          <div className="agent-status-row"><LockKeyhole size={15} /><span>等待连接 Agent Gateway</span></div>
        </div>)}

        {tab === "resume-search" && <div className="assistant-tool-panel resume-search-panel">
          <form className="resume-search-form" onSubmit={(event) => void searchResumes(event)}>
             <Search size={16} /><input value={resumeQuery} onChange={(event) => setResumeQuery(event.target.value)} placeholder="关键词或精确短语" /><button className="button primary-button" type="submit" disabled={!resumeQuery.trim() || resumeIndex?.ready === false}>{resumePending ? "重新检索" : "检索"}</button>
          </form>
          <div className="resume-search-filters">
            <label><span>字段</span><select value={resumeField} onChange={(event) => setResumeField(event.target.value as typeof resumeField)}><option value="">全部字段</option><option value="title">标题</option><option value="content">正文</option></select></label>
            <label><span>来源</span><select value={resumeSourceType} onChange={(event) => setResumeSourceType(event.target.value as typeof resumeSourceType)}><option value="">全部来源</option><option value="candidate">候选人主档</option><option value="profile_section">履历区块</option><option value="attachment">附件简历</option></select></label>
            <label><span>职位</span><select value={resumePositionId} onChange={(event) => setResumePositionId(event.target.value)}><option value="">全部职位</option>{positions.filter((position) => !position.archived_at).map((position) => <option value={position.id} key={position.id}>{position.title}</option>)}</select></label>
            <label><span>人才库</span><select value={resumePoolId} onChange={(event) => setResumePoolId(event.target.value)}><option value="">全部人才库</option>{talentPools.filter((pool) => !pool.archived_at).map((pool) => <option value={pool.id} key={pool.id}>{pool.name}</option>)}</select></label>
            <div className="resume-archive-filter" role="group" aria-label="归档范围">{([['exclude', '活动'], ['include', '全部'], ['only', '归档']] as const).map(([value, label]) => <button className={resumeArchived === value ? "active" : ""} type="button" key={value} onClick={() => setResumeArchived(value)}>{label}</button>)}</div>
          </div>
          {resumeIndex && !resumeIndex.ready && <div className={`resume-index-status is-${resumeIndex.state}`} role="status">
            <LoaderCircle className={resumeIndex.state === "indexing" ? "spin" : ""} size={17} />
            <div><strong>{resumeIndex.state === "failed" ? "履历索引不可用" : "履历索引准备中"}</strong><span>{resumeIndex.remaining == null ? "正在核对索引状态" : `剩余 ${resumeIndex.remaining} 条`}</span>{resumeIndex.progress != null && <progress max={1} value={resumeIndex.progress} />}</div>
            <button className="icon-button compact-icon-button" type="button" onClick={() => { setResumeError(""); setResumeStatusRevision((revision) => revision + 1); }} aria-label="重新检查索引" title="重新检查"><RefreshCw size={14} /></button>
          </div>}
          {resumeError && <div className="assistant-tool-error" role="alert">{resumeError}</div>}
          {!resumeItems.length && !resumePending && !resumeError && <div className="assistant-tool-empty"><FileSearch size={26} /><strong>搜索全部候选人业务字段</strong><span>SQLite 结构化筛选与 FTS5 完成全量召回，界面仅展示排名靠前的候选人与真实命中证据。</span></div>}
          {resumeItems.length > 0 && <div className="resume-search-results" aria-live="polite">
            <div className="resume-results-summary"><span>“{resumeSubmittedQuery}”</span><strong>{resumePagination?.total == null ? `本页 ${resumeItems.length} 位` : `${resumePagination.total} 位匹配候选人`}</strong></div>
            {resumeItems.map((item, index) => <article key={item.candidate_id}>
              <button type="button" onClick={() => void openResult(item)} disabled={!canOpenCandidate || openingCandidateId === item.candidate_id}>
                <span className="resume-result-rank">{(resumePagination?.page ? (resumePagination.page - 1) * resumePagination.page_size : 0) + index + 1}</span>
                <span className="resume-result-main">
                  <span><strong>{item.name}</strong><em>{Number(item.score).toFixed(2)}</em></span>
                  <span className="resume-match-fields">{item.matched_fields.map((field) => <i key={field}>{field}</i>)}</span>
                  {(item.evidence ?? []).map((evidence) => <span className="resume-evidence" key={evidence.document_id}>
                    <span className="resume-evidence-source"><b>{evidence.source_table}</b><code>{evidence.field_path}</code></span>
                    {evidenceActualTerms(evidence).length > 0 && <span className="resume-evidence-terms" aria-label="实际命中关键词">{evidenceActualTerms(evidence).map((term) => <mark key={term}>{term}</mark>)}</span>}
                    <HighlightedSnippet evidence={evidence} />
                  </span>)}
                  {!(item.evidence?.length) && item.snippets.map((snippet, snippetIndex) => <span className="resume-legacy-snippet" key={snippetIndex}>{snippet}</span>)}
                  {item.reasons.length > 0 && <small>{item.reasons.join(" · ")}</small>}
                </span>
              </button>
            </article>)}
            {resumePagination && ((resumePagination.page ?? 1) > 1 || resumePagination.has_more || resumePagination.has_next) && <div className="resume-result-pagination"><button className="icon-button" type="button" disabled={resumePending || (resumePagination.page ?? 1) <= 1} onClick={() => void searchResumes(undefined, Math.max(1, (resumePagination.page ?? 1) - 1))} aria-label="上一页"><ChevronLeft size={16} /></button><span>第 {resumePagination.page ?? 1} 页</span><button className="icon-button" type="button" disabled={resumePending || !(resumePagination.has_more || resumePagination.has_next)} onClick={() => void searchResumes(undefined, (resumePagination.page ?? 1) + 1)} aria-label="下一页"><ChevronRight size={16} /></button></div>}
          </div>}
        </div>}

        {tab === "attachment" && <div className="assistant-tool-panel attachment-tool-panel">
          <div className="assistant-tool-heading"><div><h3>解析并更新候选人</h3><p>系统只按规范化手机号或邮箱定位。所有字段与履历区块必须由你勾选并确认后才会写入。</p></div></div>
          <AttachmentBatchWorkflow
            candidates={candidates}
            onCommitted={() => onCandidatesUpdated?.()}
          />
        </div>}

        {deleteTarget && <div className="assistant-session-confirm-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !sessionMutationPending && setDeleteTarget(null)}>
          <div className="assistant-session-confirm" role="alertdialog" aria-modal="true" aria-labelledby="assistant-session-delete-title">
            <Trash2 size={20} />
            <div><strong id="assistant-session-delete-title">删除“{deleteTarget.title}”？</strong><p>该会话的消息和摘要将从本机 SQLite 永久删除，无法恢复；候选人和其他业务数据不受影响。</p></div>
            <div><button className="button" type="button" onClick={() => setDeleteTarget(null)} disabled={sessionMutationPending}>取消</button><button className="button danger-button" type="button" onClick={() => void deleteSession()} disabled={sessionMutationPending}>{sessionMutationPending ? "删除中…" : "确认删除"}</button></div>
          </div>
        </div>}
      </aside>
    </div>
  );
}
