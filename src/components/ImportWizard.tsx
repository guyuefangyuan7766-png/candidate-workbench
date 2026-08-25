import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, FileSpreadsheet, LoaderCircle, RefreshCw, UploadCloud, X } from "lucide-react";
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
  { value: "current_company", label: "当前公司" },
  { value: "current_title", label: "当前职位" },
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

const steps = ["上传文件", "字段映射", "数据预览", "导入结果"];

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

export function ImportWizard({ onClose, onImported }: ImportWizardProps) {
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
    ? ["上传文件", "北森规则识别", "数据预览", "导入结果"]
    : steps;

  const mappedFields = Object.values(mapping);
  const hasName = mappedFields.includes("name");
  const hasContact = mappedFields.includes("phone") || mappedFields.includes("email");
  const mappingReady = hasName && hasContact;
  const previewFields = useMemo(
    () => Array.from(new Set(mappedFields.filter((field): field is keyof Candidate => field !== "ignore" && !positionImportFields.has(field)))),
    [mappedFields],
  );

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

  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWizard()}>
      <section className="modal import-modal" role="dialog" aria-modal="true" aria-label="导入候选人">
        <header className="modal-header">
          <div><p className="drawer-kicker">数据管理</p><h2>导入候选人</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭" title="关闭"><X size={19} /></button>
        </header>

        <ol className="stepper" aria-label="导入进度">
          {stepLabels.map((label, index) => (
            <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}>
              <span>{index < step ? <CheckCircle2 size={16} /> : index + 1}</span>
              <small>{label}</small>
            </li>
          ))}
        </ol>

        <div className="modal-body import-body">
          {step === 0 && (
            <div className="upload-step">
              <input ref={inputRef} className="sr-only" type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={onFileChange} />
              <div className={`upload-zone ${file ? "has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                {loading ? <LoaderCircle className="spin" size={34} /> : file ? <FileSpreadsheet size={34} /> : <UploadCloud size={34} />}
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
                    {loading && uploadProgress && <div className="import-upload-progress" role="progressbar" aria-label="候选人导入文件上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress.percent}><span style={{ width: `${uploadProgress.percent}%` }} /></div>}
                    <button className="button secondary-button" type="button" disabled={loading} onClick={() => inputRef.current?.click()}>重新选择</button>
                  </>
                ) : (
                  <>
                    <strong>选择 Excel 或 CSV 文件</strong>
                    <span>.xlsx、.xlsm、.xls、.csv · {maxFileSizeBytes === null ? "文件上限由本机服务配置" : `当前上限 ${formatFileLimit(maxFileSizeBytes)}`}；.xls 支持 Excel 97-2003 BIFF8</span>
                    <button className="button primary-button" type="button" onClick={() => inputRef.current?.click()}>
                      <UploadCloud size={16} />选择文件
                    </button>
                  </>
                )}
              </div>
              {fileError && <div className="inline-alert error-alert"><AlertCircle size={16} /><span>{fileError}</span></div>}
            </div>
          )}

          {step === 1 && (
            <div className="mapping-step">
              <div className="import-summary-line">
                <span><FileSpreadsheet size={16} />{file?.name}</span>
                <strong>{headers.length} 个源字段</strong>
              </div>
              <div className="mapping-head"><span>源文件字段</span><span>平台字段</span></div>
              <div className="mapping-list">
                {headers.map((header: string) => (
                  <div className="mapping-row" key={header}>
                    <span title={header}>{header}</span>
                    <ArrowRight size={15} />
                    <select value={mapping[header] ?? "ignore"} onChange={(event) => setMapping((current) => ({ ...current, [header]: event.target.value as CandidateField }))}>
                      {fieldOptions.map((option) => <option value={option.value} key={option.value}>{option.label}{option.required ? " *" : ""}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {!mappingReady && <div className="inline-alert warning-alert"><AlertCircle size={16} /><span>需映射“姓名”以及“手机号 / 邮箱”中的至少一项</span></div>}
              {fileError && <div className="inline-alert error-alert"><AlertCircle size={16} /><span>{fileError}</span></div>}
            </div>
          )}

          {step === 2 && preview && (
            <div className="preview-step">
              <div className="import-summary-line">
                <span>数据预览</span>
                <strong>{preview.profile === "beisen_talent" ? "北森人才数据审计" : `有效 ${preview.summary.valid_rows} · 无效 ${preview.summary.invalid_rows} · 重复 ${preview.summary.existing_duplicates + preview.summary.file_duplicates}`}</strong>
              </div>
              {preview.profile === "beisen_talent" && (
                <div className="beisen-import-summary">
                  <div><span>候选人档案</span><strong>{preview.summary.candidate_records ?? 0}</strong><small>按应聘者 ID 定位并增量补充</small></div>
                  <div><span>申请来源记录</span><strong>{preview.summary.application_records ?? 0}</strong><small>提供申请 ID 时写入</small></div>
                  <div><span>关联职位</span><strong>{preview.summary.position_records ?? 0}</strong><small>提供职位编号时匹配或创建</small></div>
                  <div className={(preview.summary.missing_candidate_id_rows ?? 0) > 0 ? "has-warning" : ""}><span>缺少应聘者 ID</span><strong>{preview.summary.missing_candidate_id_rows ?? 0}</strong><small>不会创建或更新候选人</small></div>
                </div>
              )}
              {preview.position_preview && (
                <details className="position-import-preview">
                  <summary>
                    职位处理预览：匹配 {preview.position_preview.match_count} 个 · 新建 {preview.position_preview.create_count} 个 · 歧义 {preview.position_preview.ambiguous_count} 条 · 归档冲突 {preview.position_preview.archived_conflict_count} 条 · 无效 {preview.position_preview.invalid_count} 条 · 拟新增关系 {preview.position_preview.link_count} 条
                  </summary>
                  <div>{preview.position_preview.items.map((item, index) => (
                    <p className={`position-preview-${item.action}`} key={`${item.external_code}-${item.title}-${index}`}>
                      <span>{item.title || "未提供职位名称"}</span>
                      <small>{[item.department, item.location, item.external_code ?? item.source_record_id].filter(Boolean).join(" · ") || "无职位标识"}</small>
                      <strong>{positionActionLabels[item.action] ?? item.action}</strong>
                      {item.reason && <em>{positionReason(item.reason)}</em>}
                    </p>
                  ))}</div>
                </details>
              )}
              <div className="preview-table-wrap">
                <table className="preview-table">
                  {isBeisenPreview ? (
                    <>
                      <thead><tr><th>状态</th><th>应聘者 ID</th><th>姓名</th><th>工作年限</th><th>申请 ID（可选）</th><th>职位编号 / 名称（可选）</th></tr></thead>
                      <tbody>
                        {preview.rows.map((row) => (
                          <tr key={row.row_number}>
                            <td title={row.errors.map((error) => error.message).join("；")}>{row.errors.length ? "无效" : row.duplicate ? "重复" : "可导入"}</td>
                            <td>{displayValue(row.candidate_source_id)}</td>
                            <td>{displayValue(row.candidate.name)}</td>
                            <td>{candidateYearsExperienceText(row.candidate)}</td>
                            <td>{displayValue(row.source_application_id)}</td>
                            <PositionResolutionCell row={row} showExternalCode />
                          </tr>
                        ))}
                      </tbody>
                    </>
                  ) : (
                    <>
                      <thead><tr><th>状态</th>{previewFields.map((field) => <th key={field}>{fieldOptions.find((option) => option.value === field)?.label ?? field}</th>)}{preview.position_preview && <th>招聘职位</th>}</tr></thead>
                      <tbody>
                        {preview.rows.map((row) => (
                          <tr key={row.row_number}>
                            <td title={row.errors.map((error) => error.message).join("；")}>{row.errors.length ? "无效" : row.duplicate ? "重复" : "可导入"}</td>
                            {previewFields.map((field) => <td key={field}>{field === "years_experience" ? candidateYearsExperienceText(row.candidate) : displayValue(row.candidate[field])}</td>)}
                            {preview.position_preview && <PositionResolutionCell row={row} />}
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
              {preview.summary.total_rows > preview.rows.length && (
                <p className="import-preview-limit-note">
                  当前仅展示前 {preview.rows.length} 条预览；全部 {preview.summary.total_rows} 条记录已由服务端完成校验，提交时仍处理完整批次。
                </p>
              )}
              <div className="validation-strip">
                <span><CheckCircle2 size={16} />服务端校验已完成</span>
                <span>{preview.profile === "beisen_talent" ? "应聘者 ID 用于增量补充；职位在确认提交后精确匹配或创建" : "重复记录将跳过；招聘职位仅使用明确映射字段，不读取候选人的当前职位"}</span>
              </div>
              {preview.summary.valid_rows === 0 && (
                <div className="inline-alert warning-alert">
                  <AlertCircle size={16} />
                  <span>当前文件没有可提交的记录，请返回修正字段或职位冲突后重新预览。</span>
                </div>
              )}
              {fileError && <div className="inline-alert error-alert"><AlertCircle size={16} /><span>{fileError}</span></div>}
            </div>
          )}

          {step === 3 && result && (
            <div className="result-step">
              <span className="result-icon"><CheckCircle2 size={34} /></span>
              <h3>导入批次已完成</h3>
              <p>{result.batchId}</p>
              <div className="result-stats">
                <div><span>{result.candidateCount === undefined ? "总记录" : "候选人档案"}</span><strong>{result.candidateCount ?? result.total}</strong></div>
                <div><span>{result.applicationCount === undefined ? "成功写入" : "申请来源记录"}</span><strong>{result.applicationCount ?? result.imported}</strong></div>
                <div><span>{result.positionCount === undefined ? "重复跳过" : "关联职位"}</span><strong>{result.positionCount ?? result.duplicates}</strong></div>
                <div><span>{result.linksCreated === undefined ? "无效记录" : "新建关联"}</span><strong>{result.linksCreated ?? result.invalid}</strong></div>
              </div>
              {result.candidateCount !== undefined && <p className="beisen-result-note">职位：新建 {result.positionsCreated ?? 0}、匹配 {result.positionsMatched ?? 0}；人才库：新建 {result.poolsCreated ?? 0}。申请和职位为可选信息，仅在文件提供对应 ID 时写入。</p>}
            </div>
          )}

          {loading && activeTask && (
            <div className="import-task-progress" role="status" aria-live="polite">
              <div>
                <LoaderCircle className="spin" size={17} />
                <strong>{taskPhaseLabel(activeTask)}</strong>
                {canCancelImportTask(activeTask) && (
                  <button className="icon-button import-task-cancel" type="button" onClick={() => void cancelActiveImport()} aria-label="Cancel import task" title="Cancel import task">
                    <X size={15} />
                  </button>
                )}
              </div>
              <span>{activeTask.message || `Task ${activeTask.task_id}`}</span>
              {activeTask.progress !== null && activeTask.progress !== undefined && (
                <div
                  className="import-upload-progress"
                  role="progressbar"
                  aria-label="Import task progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={activeTask.progress}
                >
                  <span style={{ width: `${activeTask.progress}%` }} />
                </div>
              )}
            </div>
          )}

          {!loading && recoverableTask && fileError && (
            <div className="import-task-recovery">
              {canRetryStoredCommit ? (
                <button className="button primary-button" type="button" onClick={() => void retryStoredCommit()}>
                  <RefreshCw size={16} />重试提交
                </button>
              ) : (
                <button className="button secondary-button" type="button" onClick={() => void resumeStoredImport()}>
                  <RefreshCw size={16} />刷新任务状态
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="modal-footer">
          {step > 0 && step < 3 && <button className="button secondary-button" type="button" disabled={loading} onClick={() => setStep((current) => current === 2 && isBeisenPreview ? 0 : current - 1)}><ArrowLeft size={16} />上一步</button>}
          {step === 0 && <button className="button secondary-button" type="button" onClick={onClose}>取消</button>}
          <span className="modal-footer-spacer" />
          {step === 0 && <button className="button primary-button" type="button" disabled={!file || !headers.length || loading} onClick={() => setStep(isBeisenPreview ? 2 : 1)}>{isBeisenPreview ? "查看预览" : "开始映射"}<ArrowRight size={16} /></button>}
          {step === 1 && <button className="button primary-button" type="button" disabled={!mappingReady || loading} onClick={() => void continueToPreview()}>{loading ? <LoaderCircle className="spin" size={16} /> : null}预览数据<ArrowRight size={16} /></button>}
          {step === 2 && <button className="button primary-button" type="button" disabled={loading || !preview || preview.summary.valid_rows === 0} onClick={() => void submitImport()}>{loading ? <LoaderCircle className="spin" size={16} /> : null}确认导入</button>}
          {step === 3 && <button className="button primary-button" type="button" onClick={onClose}>完成</button>}
        </footer>
      </section>
    </div>
  );
}
