import type { ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, LoaderCircle, Minus, Wrench } from "lucide-react";
import type { AgentTask } from "../types";

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "partial", "failed", "cancelled"]);

const TASK_STAGE_LABELS: Record<string, string> = {
  queued: "排队中",
  planning: "规划任务",
  querying: "检索和读取数据",
  retrieving: "整理证据",
  composing: "组织回答",
  processing: "处理中",
};

const TASK_WORKFLOW_STAGES = [
  { key: "queued", label: "进入队列", description: "任务已进入本机队列" },
  { key: "planning", label: "规划任务", description: "分析问题并确定只读工具" },
  { key: "querying", label: "检索与读取", description: "检索和读取可验证数据" },
  { key: "retrieving", label: "整理证据", description: "整理证据与来源" },
  { key: "composing", label: "生成回答", description: "组织最终回答" },
] as const;

const TOOL_LABELS: Record<string, string> = {
  get_schema_catalog: "读取数据结构",
  execute_readonly_query: "执行只读查询",
  query_candidates: "查询候选人",
  get_candidate_full: "读取候选人档案",
  query_candidate_notes: "读取候选人备注",
  query_candidate_activities: "读取候选人动态",
  query_candidate_sources: "读取候选人来源",
  query_candidate_assessments: "读取历史评估",
  query_positions: "查询职位",
  get_position_full: "读取职位详情",
  query_talent_pools: "查询人才库",
  aggregate_recruitment_data: "汇总招聘数据",
  search_all_records: "检索本地记录",
  search_candidate_resumes: "检索候选人履历",
  get_candidate_resume: "读取履历",
  query_candidate_attachments: "查询候选人附件",
  get_attachment_text: "读取附件文本",
  export_query_results: "导出查询结果",
  search_web: "检索互联网",
  fetch_web_page: "读取网页",
};

function isActiveTask(task: AgentTask) {
  return !TERMINAL_TASK_STATUSES.has(task.status);
}

function taskStageLabel(task: AgentTask) {
  return TASK_STAGE_LABELS[task.stage ?? task.status] ?? task.stage ?? task.status;
}

export function taskDurationLabel(milliseconds: number) {
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

function toolNameLabel(name: string) {
  return TOOL_LABELS[name] ?? name.replaceAll("_", " ");
}

function taskTools(task: AgentTask) {
  return [...new Set((task.tools_used ?? [])
    .map((tool) => typeof tool === "string" ? tool : tool.name ?? "")
    .filter(Boolean))];
}

export interface AssistantExecutionTimelineProps {
  task: AgentTask;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function AssistantExecutionTimeline({
  task,
  expanded,
  onToggle,
  children,
}: AssistantExecutionTimelineProps) {
  const active = isActiveTask(task);
  const tools = taskTools(task);
  const result = task.result;
  const resultCount = task.result_count ?? result?.result_count;
  const usedWeb = tools.some((name) => name === "search_web" || name === "fetch_web_page");
  const usedDatabase = tools.some((name) => name !== "search_web" && name !== "fetch_web_page");
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
    <section
      className={`assistant-task-result ${active ? "is-active" : ""} ${task.status === "partial" ? "is-partial" : ""}`}
      role={active ? "status" : task.error ? "alert" : undefined}
      aria-live="polite"
    >
      <button
        className="assistant-task-result-header assistant-task-process-toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={processRegionId}
        aria-label={expanded ? "收起执行过程" : "展开执行过程"}
        title={expanded ? "收起执行过程" : "展开执行过程"}
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
          <ChevronDown className={`assistant-task-process-chevron ${expanded ? "is-expanded" : ""}`} size={15} aria-hidden="true" />
        </span>
      </button>
      <div className="assistant-task-process-content" id={processRegionId} hidden={!expanded} role="region" aria-label="执行过程详情">
        <ol className="assistant-task-workflow" aria-label="Agent 工作流程">
          {TASK_WORKFLOW_STAGES.map((step, index) => {
            const state = taskWorkflowStepState(task, index);
            const duration = task.timings?.[step.key];
            const showTools = step.key === "querying" && tools.length > 0;
            return (
              <li className={`is-${state}`} key={step.key} aria-current={state === "current" ? "step" : undefined}>
                <span className="assistant-task-workflow-marker">
                  {state === "complete"
                    ? <Check size={9} />
                    : state === "current"
                      ? <LoaderCircle className="spin" size={9} />
                      : state === "stopped"
                        ? <AlertTriangle size={9} />
                        : state === "skipped"
                          ? <Minus size={9} />
                          : index + 1}
                </span>
                <span className="assistant-task-workflow-label">
                  <span>{step.label}</span>
                  <small>{step.description}</small>
                  {typeof duration === "number" && <small>{taskDurationLabel(duration)}</small>}
                </span>
                {showTools && (
                  <div className="assistant-task-tool-list" aria-label="已调用工具">
                    <span><Wrench size={10} />已调用工具 · {tools.length}</span>
                    <ul>
                      {tools.map((name) => <li key={name}><b>{toolNameLabel(name)}</b><small>已调用</small></li>)}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {typeof task.timings?.first_evidence_ms === "number" && <small className="assistant-task-first-evidence">首批证据 {taskDurationLabel(task.timings.first_evidence_ms)}</small>}
        {children}
      </div>
    </section>
  );
}
