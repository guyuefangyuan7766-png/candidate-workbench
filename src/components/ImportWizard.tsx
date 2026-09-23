import { ChangeEvent, DragEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  Info,
  LoaderCircle,
  RefreshCw,
  TableProperties,
  UploadCloud,
  UsersRound,
  X,
} from "lucide-react";
import {
  ApiError,
  candidateApi,
  type ImportCommitResponse,
  type ImportOperation,
  type ImportPositionAction,
  type ImportPositionValue,
  type ImportPreviewResponse,
  type ImportPreviewRow,
  type ImportTask,
  type ImportUploadProgress,
} from "../api";
import type { Candidate, ImportResult } from "../types";
import { shouldAutoRecoverImportTask } from "../import-task-state";
import { candidateYearsExperienceText } from "../utils";

interface ImportWizardProps {
  onClose: () => void;
  onImported: (result: ImportResult) => void;
  presentation?: "modal" | "page";
}

const IMPORT_TASK_STORAGE_KEY = "candidate-import-task-v1";

interface StoredImportTask {
  taskId?: string;
  operation: ImportOperation;
  clientRequestId: string;
  previewToken?: string;
  location?: string;
  status?: string;
  phase?: string;
  previewTotal?: number;
  createdAt: number;
}

function readStoredImportTask(): StoredImportTask | null {
  try {
    const raw = window.localStorage.getItem(IMPORT_TASK_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredImportTask>;
    if (!value || !["preview", "commit"].includes(String(value.operation)) || typeof value.clientRequestId !== "string") {
      window.localStorage.removeItem(IMPORT_TASK_STORAGE_KEY);
      return null;
    }
    return {
      operation: value.operation as ImportOperation,
      clientRequestId: value.clientRequestId,
      createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
      ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
      ...(typeof value.previewToken === "string" ? { previewToken: value.previewToken } : {}),
      ...(typeof value.location === "string" ? { location: value.location } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
      ...(Number.isFinite(Number(value.previewTotal)) ? { previewTotal: Number(value.previewTotal) } : {}),
    };
  } catch {
    return null;
  }
}

function storeImportTask(task: StoredImportTask | null) {
  try {
    if (task) window.localStorage.setItem(IMPORT_TASK_STORAGE_KEY, JSON.stringify(task));
    else window.localStorage.removeItem(IMPORT_TASK_STORAGE_KEY);
  } catch {
    // Task polling still works in privacy modes that disable localStorage.
  }
}

export function hasRecoverableImportTask() {
  const task = readStoredImportTask();
  if (!task) return false;
  return shouldAutoRecoverImportTask(task.status);
}

function newImportClientRequestId() {
  try {
    const uuid = window.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // Fall back for embedded browsers without randomUUID.
  }
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const IMPORT_PHASE_LABELS: Record<string, string> = {
  upload: "Uploading file",
  uploaded: "Upload accepted",
  validation: "Validating file",
  validating: "Validating file",
  zip_validation: "Checking workbook safety",
  parsing: "Parsing workbook",
  mapping: "Mapping fields",
  preview: "Preparing preview",
  committing: "Writing business data",
  commit: "Writing business data",
  indexing: "Refreshing search index",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

function taskPhaseLabel(task: ImportTask | null) {
  if (!task) return "";
  const phase = String(task.phase || task.status || "processing").toLowerCase();
  return IMPORT_PHASE_LABELS[phase] ?? phase.replaceAll("_", " ");
}

function canCancelImportTask(task: ImportTask | null) {
  if (!task || task.task_id === "pending-recovery") return false;
  return !new Set(["completed", "preview_ready", "failed", "cancelled", "canceled", "timed_out", "timeout", "expired"])
    .has(String(task.status).toLowerCase());
}

type PositionImportField =
  | "position_title"
  | "position_external_code"
  | "position_department"
  | "position_location"
  | "position_owner"
  | "position_source_system"
  | "position_source_record_id";
type CandidateField = keyof Candidate | PositionImportField | "ignore";

const positionImportFields = new Set<CandidateField>([
  "position_title",
  "position_external_code",
  "position_department",
  "position_location",
  "position_owner",
  "position_source_system",
  "position_source_record_id",
]);

const fieldOptions: { value: CandidateField; label: string; required?: boolean }[] = [
  { value: "ignore", label: "不导入" },
  { value: "id", label: "候选人 ID" },
  { value: "name", label: "姓名", required: true },
  { value: "phone", label: "手机号" },
  { value: "email", label: "邮箱" },
  { value: "gender", label: "性别" },
  { value: "birth_date", label: "出生日期" },
  { value: "age", label: "年龄" },
  { value: "current_company", label: "最近公司" },
  { value: "current_title", label: "最近职位" },
  { value: "location", label: "所在地" },
  { value: "years_experience", label: "工作年限" },
  { value: "education", label: "学历" },
  { value: "source", label: "候选人来源" },
  { value: "owner", label: "负责人" },
  { value: "tags", label: "标签" },
  { value: "expected_salary", label: "期望薪资" },
  { value: "highest_school", label: "最高学历学校" },
  { value: "highest_major", label: "最高学历专业" },
  { value: "job_seeking_status", label: "求职状态" },
  { value: "resume_updated_at", label: "简历更新日期" },
  { value: "self_summary", label: "自我评价" },
  { value: "source_system", label: "来源系统" },
  { value: "source_record_id", label: "源记录 ID" },
  { value: "position_title", label: "招聘职位名称" },
  { value: "position_external_code", label: "招聘职位编号" },
  { value: "position_department", label: "招聘职位部门" },
  { value: "position_location", label: "招聘职位地点" },
  { value: "position_owner", label: "招聘职位负责人" },
  { value: "position_source_system", label: "职位来源系统" },
  { value: "position_source_record_id", label: "来源职位 ID" },
  { value: "created_at", label: "创建时间" },
  { value: "updated_at", label: "更新时间" },
];

const steps = ["选择文件", "字段映射", "预览校验", "导入完成"];

function invertServerMapping(headers: string[], mapping: Record<string, string>) {
  const result: Record<string, CandidateField> = Object.fromEntries(headers.map((header) => [header, "ignore"]));
  Object.entries(mapping).forEach(([field, header]) => {
    if (headers.includes(header)) result[header] = field as CandidateField;
  });
  return result;
}

function toServerMapping(mapping: Record<string, CandidateField>) {
  const result: Record<string, string> = {};
  Object.entries(mapping).forEach(([header, field]) => {
    if (field !== "ignore") result[field] = header;
  });
  return result;
}

function importErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const details = error.details && typeof error.details === "object"
      ? error.details as Record<string, unknown>
      : null;
    const phase = typeof details?.phase === "string" ? details.phase : null;
    const status = typeof details?.status === "string" ? details.status : null;
    const suffix = [
      error.code ? `code: ${error.code}` : "",
      phase ? `phase: ${phase}` : "",
      status ? `status: ${status}` : "",
    ].filter(Boolean).join("; ");
    return suffix ? `${error.message} (${suffix})` : error.message;
  }
  return "文件处理失败，请稍后重试";
}

function isAborted(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatFileLimit(bytes: number) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

function detailsFromError(error: unknown): { headers?: string[]; mapping?: Record<string, string> } | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return null;
  return error.details as { headers?: string[]; mapping?: Record<string, string> };
}

function displayValue(value: unknown) {
  if (Array.isArray(value)) return value.join("、");
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

const positionActionLabels = {
  none: "未提供招聘职位",
  match: "匹配已有职位",
  create: "将创建职位",
  ambiguous: "匹配存在歧义",
  archived_conflict: "命中已归档职位",
  invalid: "职位信息无效",
} satisfies Record<ImportPositionAction, string>;

const positionReasonLabels: Record<string, string> = {
  no_position_data: "未提供招聘职位数据",
  no_existing_position: "未找到匹配职位，提交后将新建草稿职位",
  same_planned_position: "与本批次内的同一拟建职位合并",
  stable_id_match: "按来源系统和职位编号精确匹配",
  title_department_location_match: "按职位名称、部门和地点精确匹配",
  unique_title_match: "按唯一的在用职位名称匹配",
  ambiguous_position_match: "命中多个在用职位，需要人工复核",
  archived_position_match: "命中已归档职位，需要人工复核",
  missing_position_title: "缺少职位名称，无法创建职位",
  missing_position_source_system: "职位编号缺少来源系统",
  incomplete_position_identity: "职位部门和地点必须同时提供",
};

function positionReason(reason?: string | null) {
  if (!reason) return undefined;
  return positionReasonLabels[reason] ?? reason;
}

function rowPosition(row: ImportPreviewRow): ImportPositionValue | undefined {
  return row.position_resolution?.position ?? row.position;
}

function rowPositionAction(row: ImportPreviewRow) {
  return row.position_resolution?.action;
}

function PositionResolutionCell({ row, showExternalCode = false }: { row: ImportPreviewRow; showExternalCode?: boolean }) {
  const position = rowPosition(row);
  const action = rowPositionAction(row);
  const reason = positionReason(row.position_resolution?.reason);
  const value = showExternalCode
    ? [position?.external_code, position?.title].filter(Boolean).join(" · ")
    : position?.title;

  return (
    <td title={reason}>
      {displayValue(value)}
      {action && (
        <small className={`inline-position-action position-preview-${action}`}>
          {positionActionLabels[action]}
        </small>
      )}
    </td>
  );
}

export function ImportWizard({ onClose, onImported, presentation = "modal" }: ImportWizardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const taskControllerRef = useRef<AbortController | null>(null);
  const importedBatchRef = useRef<string | null>(null);
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, CandidateField>>({});
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ImportUploadProgress | null>(null);
  const [maxFileSizeBytes, setMaxFileSizeBytes] = useState<number | null>(null);
  const [fileError, setFileError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [activeTask, setActiveTask] = useState<ImportTask | null>(null);
  const [recoverableTask, setRecoverableTask] = useState<StoredImportTask | null>(() => readStoredImportTask());
  const isBeisenPreview = preview?.profile === "beisen_talent";
  const stepLabels = isBeisenPreview
    ? ["上传文件", "北森规则识别", "数据预览", "导入完成"]
    : steps;

  const mappedFields = Object.values(mapping);
  const hasName = mappedFields.includes("name");
  const hasContact = mappedFields.includes("phone") || mappedFields.includes("email");
  const mappingReady = hasName && hasContact;
  function rememberImportTask(task: StoredImportTask | null) {
    setRecoverableTask(task);
    storeImportTask(task);
  }

  function observeTask(record: StoredImportTask, task: ImportTask) {
    setActiveTask(task);
    rememberImportTask({
      ...record,
      taskId: task.task_id,
      previewToken: task.preview_token ?? record.previewToken,
      location: task.location ?? record.location,
      status: task.status,
      phase: task.phase ?? record.phase,
    });
  }

  function nextTaskController() {
    taskControllerRef.current?.abort();
    const controller = new AbortController();
    taskControllerRef.current = controller;
    return controller;
  }

  function applyPreviewResponse(response: ImportPreviewResponse, recovered = false) {
    setPreview(response);
    setHeaders(response.headers);
    setMapping(invertServerMapping(response.headers, response.mapping));
    if (recovered || response.profile === "beisen_talent") setStep(2);
  }

  function finishCommit(committed: ImportCommitResponse, totalFallback?: number) {
    const total = totalFallback
      ?? preview?.summary.total_rows
      ?? committed.imported_rows + committed.updated_rows + committed.skipped_rows + committed.failed_rows;
    const nextResult: ImportResult = {
      batchId: committed.import_batch_id,
      total,
      imported: committed.imported_rows + committed.updated_rows,
      duplicates: committed.skipped_rows,
      invalid: committed.failed_rows,
      candidateCount: committed.candidate_count,
      applicationCount: committed.application_count,
      positionCount: committed.position_count,
      positionsCreated: committed.positions_created,
      positionsMatched: committed.positions_matched,
      linksCreated: committed.links_created,
      poolsCreated: committed.pools_created,
    };
    setResult(nextResult);
    setStep(3);
    setActiveTask(null);
    rememberImportTask(null);
    if (importedBatchRef.current !== nextResult.batchId) {
      importedBatchRef.current = nextResult.batchId;
      onImported(nextResult);
    }
  }

  async function resumeStoredImport(record = recoverableTask) {
    if (!record) return;
    const controller = nextTaskController();
    setLoading(true);
    setFileError("");
    setActiveTask({
      task_id: record.taskId ?? "pending-recovery",
      operation: record.operation,
      status: record.status ?? "queued",
      phase: record.phase ?? "recovery",
      client_request_id: record.clientRequestId,
      location: record.location,
    });
    const options = {
      signal: controller.signal,
      clientRequestId: record.clientRequestId,
      onTask: (task: ImportTask) => observeTask(record, task),
    };
    try {
      const response = record.taskId
        ? await candidateApi.resumeImportTask(record.taskId, record.operation, options)
        : await candidateApi.recoverImportTask(record.clientRequestId, record.operation, options);
      if ("preview_token" in response) {
        applyPreviewResponse(response, true);
      } else {
        finishCommit(response, record.previewTotal);
      }
    } catch (error) {
      if (isAborted(error)) return;
      if (error instanceof ApiError && (error.status === 404 || error.code === "import_task_not_found")) {
        rememberImportTask(null);
        setActiveTask(null);
      }
      setFileError(importErrorMessage(error));
    } finally {
      if (taskControllerRef.current === controller) {
        taskControllerRef.current = null;
        setLoading(false);
      }
    }
  }

  function closeWizard() {
    taskControllerRef.current?.abort();
    onClose();
  }

  async function cancelActiveImport() {
    if (!activeTask || !canCancelImportTask(activeTask)) return;
    try {
      const cancelled = await candidateApi.cancelImportTask(activeTask.task_id);
      if (recoverableTask) observeTask(recoverableTask, cancelled);
      else setActiveTask(cancelled);
    } catch (error) {
      if (!isAborted(error)) setFileError(importErrorMessage(error));
    }
  }

  useEffect(() => {
    let active = true;
    candidateApi.getImportConfig()
      .then((config) => {
        if (active && Number.isFinite(config.max_file_size_bytes) && config.max_file_size_bytes > 0) {
          setMaxFileSizeBytes(config.max_file_size_bytes);
        }
      })
      .catch(() => {
        if (active) setMaxFileSizeBytes(null);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const stored = readStoredImportTask();
    if (stored) void resumeStoredImport(stored);
    return () => taskControllerRef.current?.abort();
  }, []);

  async function uploadForPreview(nextFile: File, override?: Record<string, string>) {
    const controller = nextTaskController();
    const record: StoredImportTask = {
      operation: "preview",
      clientRequestId: newImportClientRequestId(),
      createdAt: Date.now(),
    };
    let observedTask = false;
    rememberImportTask(record);
    setLoading(true);
    setActiveTask(null);
    setUploadProgress(null);
    setFileError("");
    try {
      const response = await candidateApi.previewImport(nextFile, override, setUploadProgress, {
        signal: controller.signal,
        clientRequestId: record.clientRequestId,
        onTask: (task) => {
          observedTask = true;
          observeTask(record, task);
        },
      });
      applyPreviewResponse(response);
      if (!observedTask) rememberImportTask(null);
      return response;
    } catch (error) {
      if (isAborted(error)) return null;
      const details = detailsFromError(error);
      if (details?.headers?.length) {
        setHeaders(details.headers);
        setMapping(invertServerMapping(details.headers, details.mapping ?? {}));
      }
      setPreview(null);
      setFileError(importErrorMessage(error));
      if (!observedTask && error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status)) {
        rememberImportTask(null);
      }
      return null;
    } finally {
      if (taskControllerRef.current === controller) {
        taskControllerRef.current = null;
        setUploadProgress(null);
        setLoading(false);
      }
    }
  }

  async function acceptFile(nextFile: File) {
    taskControllerRef.current?.abort();
    rememberImportTask(null);
    setActiveTask(null);
    setFileError("");
    if (!/\.(xlsx|xlsm|xls|csv)$/i.test(nextFile.name)) {
      setFileError("仅接受 .xlsx、.xlsm、.xls 或 .csv 文件");
      return;
    }
    if (maxFileSizeBytes !== null && nextFile.size > maxFileSizeBytes) {
      setFileError(`文件大小不能超过服务端配置的 ${formatFileLimit(maxFileSizeBytes)}`);
      return;
    }
    setHeaders([]);
    setMapping({});
    setPreview(null);
    setResult(null);
    setFile(nextFile);
    const response = await uploadForPreview(nextFile);
    if (response?.profile === "beisen_talent") setStep(2);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0];
    if (nextFile) void acceptFile(nextFile);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const nextFile = event.dataTransfer.files?.[0];
    if (nextFile) void acceptFile(nextFile);
  }

  async function continueToPreview() {
    if (!file || !mappingReady) return;
    // 展开校验结果前先清空上传阶段的自动映射摘要，避免显示与确认映射不一致的统计
    setPreview(null);
    setExpandedRow(null);
    const response = await uploadForPreview(file, toServerMapping(mapping));
    if (response) setStep(2);
  }

  async function submitImport() {
    if (!preview) return;
    const record: StoredImportTask = {
      operation: "commit",
      clientRequestId: newImportClientRequestId(),
      previewToken: preview.preview_token,
      previewTotal: preview.summary.total_rows,
      createdAt: Date.now(),
    };
    await runCommit(record, preview.preview_token, preview.summary.total_rows);
  }

  async function retryStoredCommit() {
    if (!recoverableTask?.previewToken || recoverableTask.operation !== "commit") return;
    const previewToken = recoverableTask.previewToken;
    const record: StoredImportTask = {
      operation: "commit",
      clientRequestId: newImportClientRequestId(),
      previewToken,
      previewTotal: recoverableTask.previewTotal,
      createdAt: Date.now(),
    };
    await runCommit(record, previewToken, record.previewTotal);
  }

  async function runCommit(record: StoredImportTask, previewToken: string, totalFallback?: number) {
    const controller = nextTaskController();
    let observedTask = false;
    rememberImportTask(record);
    setLoading(true);
    setActiveTask(null);
    setFileError("");
    try {
      const committed = await candidateApi.commitImport(previewToken, {
        signal: controller.signal,
        clientRequestId: record.clientRequestId,
        onTask: (task) => {
          observedTask = true;
          observeTask(record, task);
        },
      });
      finishCommit(committed, totalFallback);
    } catch (error) {
      if (isAborted(error)) return;
      setFileError(importErrorMessage(error));
      if (!observedTask && error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status)) {
        rememberImportTask(null);
      }
    } finally {
      if (taskControllerRef.current === controller) {
        taskControllerRef.current = null;
        setLoading(false);
      }
    }
  }

  const activeTaskStatus = String(activeTask?.status ?? "").toLowerCase();
  const canRetryStoredCommit = Boolean(
    !loading
    && recoverableTask?.operation === "commit"
    && recoverableTask.previewToken
    && activeTask?.error?.retryable
    && ["failed", "timed_out", "timeout"].includes(activeTaskStatus),
  );

  type PreviewTab = "all" | "valid" | "duplicate" | "invalid";
  const [previewTab, setPreviewTab] = useState<PreviewTab>("all");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [sourceKind, setSourceKind] = useState<"generic" | "beisen">("generic");

  const previewRows = preview?.rows ?? [];
  const duplicateTotal = (preview?.summary.existing_duplicates ?? 0) + (preview?.summary.file_duplicates ?? 0);
  const rowKind = (row: ImportPreviewRow): PreviewTab => (row.errors.length ? "invalid" : row.duplicate ? "duplicate" : "valid");
  const filteredRows = previewTab === "all" ? previewRows : previewRows.filter((row) => rowKind(row) === previewTab);
  const tabs: { key: PreviewTab; label: string; count: number }[] = preview ? [
    { key: "all", label: "全部", count: preview.summary.total_rows },
    { key: "valid", label: "可导入", count: preview.summary.valid_rows },
    { key: "duplicate", label: "重复跳过", count: duplicateTotal },
    { key: "invalid", label: "问题行", count: preview.summary.invalid_rows },
  ] : [];
  const mappedColumnCount = headers.filter((header) => (mapping[header] ?? "ignore") !== "ignore").length;
  const ignoredColumnCount = headers.length - mappedColumnCount;

  function fieldLabelFor(key: string) {
    return fieldOptions.find((option) => option.value === key)?.label ?? key;
  }

  function sampleValueFor(field: CandidateField) {
    const row = preview?.rows?.[0];
    if (!row || field === "ignore") return "—";
    if (field === "years_experience") return candidateYearsExperienceText(row.candidate);
    return displayValue((row.candidate as Record<string, unknown>)[field]);
  }

  function rowSummary(row: ImportPreviewRow) {
    if (row.errors.length) return row.errors.map((error) => error.message).join("；");
    if (row.duplicate) {
      return row.duplicate.type === "existing"
        ? `与已有候选人重复${row.duplicate.matched_by ? `（按${row.duplicate.matched_by}匹配）` : ""}，提交时跳过`
        : `与文件第 ${row.duplicate.row_number ?? "?"} 行重复，提交时跳过`;
    }
    if (isBeisenPreview) {
      return [row.candidate_source_id ? `应聘者 ID ${row.candidate_source_id}` : "", candidateYearsExperienceText(row.candidate), row.source_application_id ? `申请 ${row.source_application_id}` : ""].filter(Boolean).join(" · ") || "待写入";
    }
    return [row.candidate.current_title, row.candidate.current_company, row.candidate.location].filter(Boolean).join(" · ") || "基础信息待补充";
  }

  const fileInputNode = (
    <input ref={inputRef} className="sr-only" type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={onFileChange} />
  );

  const stepsNode = (
    <ol className="tw-steps" aria-label="导入进度">
      {stepLabels.map((label, index) => (
        <Fragment key={label}>
          {index > 0 && <span className="tw-step-line" aria-hidden="true" />}
          <li className={`tw-step${index === step ? " active" : ""}${index < step ? " done" : ""}`}>
            <span className="tw-step-index">{index < step ? <Check size={15} /> : index + 1}</span>
            <span className="tw-step-label">{label}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );

  const fileCardNode = (
    <div className="tw-import-file">
      <span className="tw-import-file-icon"><FileSpreadsheet size={22} /></span>
      <span className="tw-import-file-main">
        <strong>{file?.name ?? "未选择文件"}</strong>
        <small>{preview ? `${preview.sheet_name} · ${preview.summary.total_rows} 行 · ${preview.headers.length} 列` : `${headers.length} 列待映射`}</small>
      </span>
      <button className="tw-btn" type="button" disabled={loading} onClick={() => inputRef.current?.click()}>更换文件</button>
    </div>
  );

  const stepZero = (
    <>
      <h2 className="tw-import-section">选择数据来源</h2>
      <div className="tw-choices" role="radiogroup" aria-label="数据来源">
        <button className={`tw-choice${sourceKind === "generic" ? " is-active" : ""}`} type="button" role="radio" aria-checked={sourceKind === "generic"} onClick={() => setSourceKind("generic")}>
          <span className="tw-choice-icon"><FileSpreadsheet size={22} /></span>
          <span className="tw-choice-body"><strong>通用表格</strong><small>支持 Excel 或 CSV 格式，适用于大多数场景</small></span>
        </button>
        <button className={`tw-choice${sourceKind === "beisen" ? " is-active" : ""}`} type="button" role="radio" aria-checked={sourceKind === "beisen"} onClick={() => setSourceKind("beisen")}>
          <span className="tw-choice-icon"><FileText size={22} /></span>
          <span className="tw-choice-body"><strong>北森人才档案</strong><small>支持从北森导出的标准人才档案表格</small></span>
        </button>
      </div>

      <h2 className="tw-import-section">上传文件</h2>
      <div className={`tw-dropzone${file ? " has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop} onClick={() => !loading && inputRef.current?.click()} role="button" tabIndex={0} aria-label="选择或拖入导入文件" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRef.current?.click(); } }}>
        {loading ? <LoaderCircle className="spin" size={32} /> : <span className="tw-dropzone-icon">{file ? <FileSpreadsheet size={26} /> : <UploadCloud size={26} />}</span>}
        {file ? (
          <>
            <strong>{file.name}</strong>
            <span>{loading
              ? activeTask
                ? taskPhaseLabel(activeTask)
                : uploadProgress?.percent === 100
                  ? "上传完成，服务端正在安全解析..."
                  : uploadProgress
                    ? `正在上传 ${uploadProgress.percent}%`
                    : "正在上传并等待服务端解析..."
              : preview
                ? `${preview.sheet_name} · ${preview.profile === "beisen_talent" ? "北森人才档案" : `${preview.summary.total_rows} 行`} · ${preview.headers.length} 列`
                : `${headers.length} 列待映射`}</span>
            {loading && uploadProgress && (
              <span className="tw-progress" role="progressbar" aria-label="候选人导入文件上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress.percent}>
                <span style={{ width: `${uploadProgress.percent}%` }} />
              </span>
            )}
            <button className="tw-btn" type="button" disabled={loading} onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}>重新选择</button>
          </>
        ) : (
          <>
            <strong>拖入文件，或 <span className="tw-dropzone-link">选择文件</span></strong>
            <span>支持 XLSX / XLSM / XLS / CSV 格式 · {maxFileSizeBytes === null ? "文件上限由本机服务配置" : `当前上限 ${formatFileLimit(maxFileSizeBytes)}`}</span>
            <button className="tw-btn tw-btn-primary" type="button" onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}><UploadCloud size={16} />选择文件</button>
          </>
        )}
      </div>
      {fileError && <div className="tw-alert" role="alert"><AlertCircle size={16} /><span>{fileError}</span></div>}

      <ul className="tw-import-hints">
        {sourceKind === "beisen" ? (
          <>
            <li><AlertCircle size={15} />档案需包含应聘者 ID，用于按 ID 增量补充已有候选人</li>
            <li><UsersRound size={15} />可选列：申请 ID、职位编号与名称，用于写入申请来源与关联职位</li>
            <li><FileText size={15} />下一步将先预览并确认字段映射</li>
          </>
        ) : (
          <>
            <li><AlertCircle size={15} />必须包含姓名或手机号等身份信息</li>
            <li><UsersRound size={15} />导入后将按姓名、手机号等信息识别重复记录并跳过，不覆盖已有资料</li>
            <li><FileText size={15} />下一步将先预览并确认字段映射</li>
          </>
        )}
      </ul>
    </>
  );

  const stepOne = (
    <>
      {fileCardNode}
      <div className="tw-import-map">
        <div className="tw-table-scroll tw-import-map-scroll">
          <table className="tw-table tw-map-table">
            <thead>
              <tr><th>原文件列名</th><th>对应系统字段</th><th>示例数据</th></tr>
            </thead>
            <tbody>
              {headers.map((header) => {
                const field = mapping[header] ?? "ignore";
                const option = fieldOptions.find((item) => item.value === field);
                return (
                  <tr key={header}>
                    <td>{header}</td>
                    <td>
                      <div className="tw-map-field">
                        <select value={field} disabled={loading} aria-label={`${header} 对应的系统字段`} onChange={(event) => setMapping((current) => ({ ...current, [header]: event.target.value as CandidateField }))}>
                          {fieldOptions.map((item) => <option value={item.value} key={item.value}>{item.label}{item.required ? " *" : ""}</option>)}
                        </select>
                        {option?.required && <span className="tw-map-flag"><CheckCircle2 size={14} />必填字段已匹配</span>}
                      </div>
                    </td>
                    <td className="tw-map-sample">{sampleValueFor(field)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <aside className="tw-import-aside" aria-label="匹配说明">
          <h3><Info size={16} />匹配说明</h3>
          <p><UsersRound size={16} />系统将根据姓名、手机号等支持的标识匹配已有候选人，避免重复创建。</p>
          <p><FileText size={16} />最近公司与最近职位仅记录候选人的经历信息，不等同于关联招聘职位。</p>
          <div className="tw-import-aside-foot"><TableProperties size={15} />已识别 {mappedColumnCount} 列 · {ignoredColumnCount} 列将忽略</div>
        </aside>
      </div>
      {!mappingReady && <div className="tw-alert tw-alert-warn" role="alert"><AlertCircle size={16} /><span>需映射“姓名”以及“手机号 / 邮箱”中的至少一项</span></div>}
      {fileError && <div className="tw-alert" role="alert"><AlertCircle size={16} /><span>{fileError}</span></div>}
    </>
  );

  const stepTwo = preview ? (
    <>
      <div className="tw-import-stats">
        <div><span className="tw-import-stat-icon"><FileText size={20} /></span><span><strong>{preview.summary.total_rows}</strong><small>文件总行数</small></span></div>
        <div><span className="tw-import-stat-icon is-ok"><CheckCircle2 size={20} /></span><span><strong>{preview.summary.valid_rows}</strong><small>可导入的候选人</small></span></div>
        <div><span className="tw-import-stat-icon is-info"><RefreshCw size={20} /></span><span><strong>{duplicateTotal}</strong><small>重复记录将跳过</small></span></div>
        <div className={preview.summary.invalid_rows > 0 ? "has-warning" : ""}><span className="tw-import-stat-icon is-warn"><AlertCircle size={20} /></span><span><strong>{preview.summary.invalid_rows}</strong><small>存在问题的行</small></span></div>
      </div>

      {isBeisenPreview && (
        <div className="tw-import-stats tw-import-stats-sm">
          <div><span><strong>{preview.summary.candidate_records ?? 0}</strong><small>候选人档案（按应聘者 ID 增量补充）</small></span></div>
          <div><span><strong>{preview.summary.application_records ?? 0}</strong><small>申请来源记录（提供申请 ID 时写入）</small></span></div>
          <div><span><strong>{preview.summary.position_records ?? 0}</strong><small>关联职位（提供职位编号时匹配或创建）</small></span></div>
          <div className={(preview.summary.missing_candidate_id_rows ?? 0) > 0 ? "has-warning" : ""}><span><strong>{preview.summary.missing_candidate_id_rows ?? 0}</strong><small>缺少应聘者 ID（不会写入）</small></span></div>
        </div>
      )}

      <div className="tw-import-preview-head">
        <div className="tw-import-tabs" role="tablist" aria-label="预览筛选">
          {tabs.map((tab) => (
            <button className={previewTab === tab.key ? "active" : ""} type="button" role="tab" aria-selected={previewTab === tab.key} key={tab.key} onClick={() => { setPreviewTab(tab.key); setExpandedRow(null); }}>
              {tab.label}<span>{tab.count}</span>
            </button>
          ))}
        </div>
        <span className="tw-hint"><Info size={14} />问题行不会自动写入，修正后可重新校验</span>
      </div>

      {preview.position_preview && (
        <details className="tw-fold">
          <summary>
            <span className="tw-section-title"><BriefcaseBusiness size={16} />职位处理预览</span>
            <span className="tw-hint">匹配 {preview.position_preview.match_count} · 新建 {preview.position_preview.create_count} · 歧义 {preview.position_preview.ambiguous_count} · 归档冲突 {preview.position_preview.archived_conflict_count} · 无效 {preview.position_preview.invalid_count} · 拟新增关系 {preview.position_preview.link_count}</span>
            <ChevronDown size={16} className="tw-fold-arrow" />
          </summary>
          <div className="tw-import-position-list">
            {preview.position_preview.items.map((item, index) => (
              <p className={`is-${item.action}`} key={`${item.external_code}-${item.title}-${index}`}>
                <span>{item.title || "未提供职位名称"}</span>
                <small>{[item.department, item.location, item.external_code ?? item.source_record_id].filter(Boolean).join(" · ") || "无职位标识"}</small>
                <strong>{positionActionLabels[item.action] ?? item.action}</strong>
                {item.reason && <em>{positionReason(item.reason)}</em>}
              </p>
            ))}
          </div>
        </details>
      )}

      <div className="tw-table-scroll tw-import-scroll">
        <table className="tw-table tw-import-table">
          <thead>
            <tr>
              <th className="tw-col-row">行号</th>
              <th className="tw-col-state">状态</th>
              <th>姓名</th>
              <th>校验与数据说明</th>
              <th className="tw-col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const kind = rowKind(row);
              const open = expandedRow === row.row_number;
              return (
                <Fragment key={row.row_number}>
                  <tr className={kind === "invalid" ? "is-invalid" : undefined}>
                    <td className="tw-col-row">第 {row.row_number} 行</td>
                    <td className="tw-col-state">
                      <span className={`tw-status ${kind === "invalid" ? "tw-status-danger" : kind === "duplicate" ? "tw-status-archived" : "tw-status-active"}`}>
                        <span className="tw-dot" />{kind === "invalid" ? "需处理" : kind === "duplicate" ? "重复跳过" : "可导入"}
                      </span>
                    </td>
                    <td>{row.candidate.name || <span className="tw-empty-inline">—</span>}</td>
                    <td className="tw-import-summary-cell">{rowSummary(row)}</td>
                    <td className="tw-col-actions">
                      <button className="tw-link-btn" type="button" aria-expanded={open} onClick={() => setExpandedRow(open ? null : row.row_number)}>{open ? "收起解析结果" : "查看解析结果"}</button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="tw-import-detail-row">
                      <td colSpan={5}>
                        <dl className="tw-import-detail">
                          {Object.entries(row.candidate)
                            .filter(([, value]) => value !== undefined && value !== null && value !== "" && !Array.isArray(value))
                            .slice(0, 14)
                            .map(([key, value]) => (
                              <div key={key}><dt>{fieldLabelFor(key)}</dt><dd>{displayValue(value)}</dd></div>
                            ))}
                          {row.duplicate && <div><dt>重复判定</dt><dd>{row.duplicate.type === "existing" ? `与已有候选人 ${row.duplicate.id ?? ""} 重复，提交时跳过` : `与文件第 ${row.duplicate.row_number ?? "?"} 行重复，提交时跳过`}</dd></div>}
                          {row.errors.length > 0 && <div className="is-error"><dt>校验问题</dt><dd>{row.errors.map((error) => `${fieldLabelFor(error.field ?? "")}：${error.message}`).join("；")}</dd></div>}
                        </dl>
                        {preview.position_preview && (
                          <p className="tw-import-detail-position">招聘职位解析：<PositionResolutionCell row={row} /></p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!filteredRows.length && (
          <div className="tw-empty tw-empty-sm" role="status">
            <span>{previewTab === "invalid" ? "没有需要处理的问题行" : previewTab === "duplicate" ? "没有重复记录" : "没有可展示的记录"}</span>
          </div>
        )}
      </div>
      {preview.summary.total_rows > preview.rows.length && (
        <p className="tw-hint tw-import-limit-note">当前仅展示前 {preview.rows.length} 条预览；全部 {preview.summary.total_rows} 条记录已由服务端完成校验，提交时仍处理完整批次。</p>
      )}
      {preview.summary.valid_rows === 0 && (
        <div className="tw-alert tw-alert-warn" role="alert"><AlertCircle size={16} /><span>当前文件没有可提交的记录，请返回修正字段或职位冲突后重新预览。</span></div>
      )}
      {fileError && <div className="tw-alert" role="alert"><AlertCircle size={16} /><span>{fileError}</span></div>}
    </>
  ) : loading ? (
    <div className="tw-import-loading" role="status"><LoaderCircle className="spin" size={20} /><span>正在按确认后的字段映射重新校验…</span></div>
  ) : null;

  const stepThree = result ? (
    <div className="tw-import-result">
      <span className="tw-import-result-icon"><CheckCircle2 size={32} /></span>
      <h3>导入完成</h3>
      <p className="tw-hint">批次号 {result.batchId} · 成功写入 {result.imported} 条 · 重复跳过 {result.duplicates} 条{result.invalid ? ` · 问题行 ${result.invalid} 条` : ""}</p>
      <div className="tw-import-stats">
        <div><span><strong>{result.candidateCount ?? result.total}</strong><small>{result.candidateCount === undefined ? "总记录" : "候选人档案"}</small></span></div>
        <div><span><strong>{result.applicationCount ?? result.imported}</strong><small>{result.applicationCount === undefined ? "成功写入" : "申请来源记录"}</small></span></div>
        <div><span><strong>{result.positionCount ?? result.duplicates}</strong><small>{result.positionCount === undefined ? "重复跳过" : "关联职位"}</small></span></div>
        <div><span><strong>{result.linksCreated ?? result.invalid}</strong><small>{result.linksCreated === undefined ? "无效记录" : "新建关联"}</small></span></div>
      </div>
      {result.candidateCount !== undefined && <p className="tw-hint">职位：新建 {result.positionsCreated ?? 0}、匹配 {result.positionsMatched ?? 0}；人才库：新建 {result.poolsCreated ?? 0}。申请和职位为可选信息，仅在文件提供对应 ID 时写入。</p>}
    </div>
  ) : null;

  const taskNodes = (
    <>
      {loading && activeTask && (
        <div className="tw-import-task" role="status" aria-live="polite">
          <div>
            <LoaderCircle className="spin" size={17} />
            <strong>{taskPhaseLabel(activeTask)}</strong>
            {canCancelImportTask(activeTask) && (
              <button className="tw-icon-plain" type="button" onClick={() => void cancelActiveImport()} aria-label="取消导入任务" title="取消导入任务">
                <X size={15} />
              </button>
            )}
          </div>
          <span>{activeTask.message || `任务 ${activeTask.task_id}`}</span>
          {activeTask.progress !== null && activeTask.progress !== undefined && (
            <span className="tw-progress" role="progressbar" aria-label="导入任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={activeTask.progress}>
              <span style={{ width: `${activeTask.progress}%` }} />
            </span>
          )}
        </div>
      )}
      {!loading && recoverableTask && fileError && (
        <div className="tw-import-recover">
          {canRetryStoredCommit
            ? <button className="tw-btn tw-btn-primary" type="button" onClick={() => void retryStoredCommit()}><RefreshCw size={15} />重试提交</button>
            : <button className="tw-btn" type="button" onClick={() => void resumeStoredImport()}><RefreshCw size={15} />刷新任务状态</button>}
        </div>
      )}
    </>
  );

  const footNode = (
    <footer className="tw-import-foot">
      {step === 0 && <span className="tw-import-foot-status">{file ? `已选择 ${file.name}` : "当前未选择文件"}</span>}
      {step === 1 && <button className="tw-btn" type="button" disabled={loading} onClick={() => setStep(0)}><ArrowLeft size={16} />上一步</button>}
      {step === 2 && <button className="tw-btn" type="button" disabled={loading} onClick={() => setStep(isBeisenPreview ? 0 : 1)}><ArrowLeft size={16} />上一步</button>}
      <span className="tw-spacer" />
      {step === 1 && <span className="tw-hint">导入后可在人才库分组中查看</span>}
      {step === 2 && <span className="tw-hint">仅校验通过的记录可提交，错误行将保留并可返回修正</span>}
      {step === 0 && <button className="tw-btn" type="button" onClick={onClose}>取消</button>}
      {step === 0 && (
        <button className="tw-btn tw-btn-primary" type="button" disabled={!file || !headers.length || loading} onClick={() => setStep(isBeisenPreview ? 2 : 1)}>
          {isBeisenPreview ? "查看预览" : "下一步"}<ArrowRight size={15} />
        </button>
      )}
      {step === 1 && (
        <button className="tw-btn tw-btn-primary" type="button" disabled={!mappingReady || loading} onClick={() => void continueToPreview()}>
          {loading && <LoaderCircle className="spin" size={15} />}预览校验<ArrowRight size={15} />
        </button>
      )}
      {step === 2 && (
        <button className="tw-btn tw-btn-primary" type="button" disabled={loading || !preview || preview.summary.valid_rows === 0} onClick={() => void submitImport()}>
          {loading && <LoaderCircle className="spin" size={15} />}确认导入可用记录
        </button>
      )}
      {step === 3 && <button className="tw-btn tw-btn-primary" type="button" onClick={onClose}>完成</button>}
    </footer>
  );

  const bodyByStep = step === 0 ? stepZero : step === 1 ? stepOne : step === 2 ? stepTwo : stepThree;

  if (presentation === "page") {
    return (
      <section className="tw-page" aria-label="导入候选人">
        <header className="tw-page-head">
          <div>
            <h1>导入候选人</h1>
            <p className="tw-sub">导入表格，集中整理人才资料</p>
          </div>
          <div className="tw-page-actions">
            {step === 2 && (
              <div className="tw-import-note">
                <strong><Info size={15} />关于本地人才数据导入</strong>
                <p>支持从 Excel、CSV 等本地文件导入候选人信息。系统将根据文件内容识别字段并进行校验，区分新增候选人与已有候选人的更新。</p>
              </div>
            )}
            <button className="tw-btn" type="button" onClick={onClose}><ArrowLeft size={16} />返回人才库</button>
          </div>
        </header>
        {fileInputNode}
        {stepsNode}
        <div className="tw-scroll-body tw-import-body">
          {bodyByStep}
          {taskNodes}
        </div>
        {footNode}
      </section>
    );
  }

  return (
    <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWizard()}>
      <div className="tw-modal tw-modal-lg" role="dialog" aria-modal="true" aria-label="导入候选人">
        <header className="tw-modal-head">
          <div><h2>导入候选人</h2><p className="tw-modal-sub">导入表格，集中整理人才资料</p></div>
          <button className="tw-icon-plain" type="button" onClick={closeWizard} aria-label="关闭" title="关闭"><X size={18} /></button>
        </header>
        {fileInputNode}
        {stepsNode}
        <div className="tw-modal-body">
          {bodyByStep}
          {taskNodes}
        </div>
        {footNode}
      </div>
    </div>
  );
}