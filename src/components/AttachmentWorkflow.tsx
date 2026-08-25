import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  UserPlus,
  UserRoundCheck,
  X,
} from "lucide-react";
import { ApiError, attachmentApi, candidateApi } from "../api";
import {
  candidateDraftFromRecord,
  candidateFieldValue,
  defaultFieldsForCandidate,
  attachmentSuggestionHasEvidence,
  isAttachmentSelfSummarySection,
  parsedCandidateName,
  suggestionChangesCandidate,
} from "../attachment-candidate-prefill";
import { preserveAttachmentPreviewToken } from "../attachment-preview-state";
import {
  attachmentConflictValueText,
  attachmentFieldLabel,
  attachmentEvidenceStatusLabel,
  attachmentPipelineChannelDetail,
  attachmentPipelineChannelLabel,
  attachmentPipelineChannelTone,
  attachmentParserPipelineLabel,
  attachmentProvenanceLabel,
  attachmentSuggestionEvidenceRefs,
  attachmentSuggestionEvidence,
  attachmentValueText,
} from "../attachment-suggestion-display";
import type {
  AttachmentConfirmRecord,
  AttachmentPreview,
  AttachmentPreviewRecord,
  AttachmentSuggestionConflict,
  Candidate,
  CandidateAttachment,
  CandidateDraft,
} from "../types";
import { formatDateTime } from "../utils";
import { CandidateForm, type CandidateFormSubmitOptions } from "./CandidateForm";
import { CandidatePickerDialog } from "./CandidatePickerDialog";

const ACCEPTED_EXTENSIONS = ["pdf", "docx", "xlsx", "xlsm", "xls", "csv", "txt"];
const ACCEPT = ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(",");
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const STATUS_POLL_DELAY_MS = 900;
const STATUS_POLL_MAX_FAILURES = 4;
const STATUS_POLL_FALLBACK_WINDOW_MS = 15 * 60 * 1000;
const PROCESSING_STATUSES = new Set(["pending", "parsing"]);
const READY_STATUSES = new Set(["ready", "parsed"]);

function AttachmentConflictNotice({ conflict }: { conflict?: AttachmentSuggestionConflict }) {
  if (!conflict) return null;
  const evidenceStatus = attachmentEvidenceStatusLabel(conflict.evidence_status);
  return <small className="attachment-conflict">
    <AlertTriangle size={12} />
    <span>
      <span>{conflict.message}</span>
      {conflict.existing_value !== undefined && <span className="attachment-conflict-value">{attachmentProvenanceLabel(conflict.existing_source)}：{attachmentConflictValueText(conflict.existing_value)}</span>}
      {conflict.proposed_value !== undefined && <span className="attachment-conflict-value">{attachmentProvenanceLabel(conflict.source)}建议：{attachmentConflictValueText(conflict.proposed_value)}</span>}
      {evidenceStatus && <span className={`attachment-evidence-status is-${conflict.evidence_status}`}>{evidenceStatus}</span>}
      {attachmentSuggestionEvidenceRefs(conflict).map((reference, index) => <span className="attachment-conflict-evidence" key={`${reference.page ?? "none"}-${index}`}>{reference.page ? `第 ${reference.page} 页：` : "证据："}{reference.text}</span>)}
    </span>
  </small>;
}

const MATCH_COPY: Record<AttachmentPreviewRecord["match"]["status"], { label: string; tone: string }> = {
  high_confidence: { label: "手机号与邮箱一致", tone: "success" },
  single_identity: { label: "单一身份字段唯一匹配", tone: "notice" },
  identity_conflict: { label: "手机号与邮箱命中不同候选人", tone: "danger" },
  multiple_matches: { label: "身份字段命中多位候选人", tone: "danger" },
  not_found: { label: "未自动匹配候选人", tone: "warning" },
};

interface RecordSelection {
  candidateId: string;
  fields: Set<string>;
  sections: Set<string>;
}

interface AttachmentWorkflowProps {
  candidateId?: string;
  candidates: Candidate[];
  disabled?: boolean;
  deletedAttachment?: Pick<CandidateAttachment, "id" | "sha256"> | null;
  onCommitted?: (candidateIds: string[]) => void;
  onCandidateCreated?: (candidateId: string) => void;
}

type ErrorRecovery = "none" | "upload" | "status";

function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function previewFailureMessage(preview: AttachmentPreview): string {
  if (preview.error?.trim()) return preview.error.trim();
  const fallbackByCode: Record<string, string> = {
    attachment_empty: "附件中没有可识别的候选人信息。",
    attachment_encrypted: "附件已加密，无法解析，请先移除密码保护。",
    attachment_invalid_signature: "文件内容与扩展名不一致或文件已经损坏。",
    attachment_parse_timeout: "附件内容较复杂，解析未能在限定时间内完成。",
    attachment_unsupported: "暂不支持该附件格式。",
  };
  return fallbackByCode[preview.error_code ?? ""] ?? "附件解析失败，请检查文件是否损坏、加密或需要 OCR。";
}

function previewPollDelay(preview: AttachmentPreview): number {
  const delay = Number(preview.poll_after_ms);
  return Number.isFinite(delay) ? Math.min(5_000, Math.max(300, delay)) : STATUS_POLL_DELAY_MS;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message.trim()) return error.message.trim();
  if (error instanceof DOMException && error.name === "AbortError") return "请求已取消。";
  return fallback;
}

function isTerminalClientError(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 429].includes(error.status);
}

function isAmbiguousConfirmError(error: unknown): boolean {
  return error instanceof ApiError
    && ["attachment_request_timeout", "attachment_network_error"].includes(error.code);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

async function getCandidateWithRetry(candidateId: string, attempts = 4): Promise<Candidate> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await candidateApi.get(candidateId, true);
    } catch (error) {
      lastError = error;
      if ((error instanceof ApiError && [401, 403].includes(error.status)) || attempt === attempts - 1) break;
      await wait(Math.min(250 * 2 ** attempt, 1_500));
    }
  }
  throw lastError;
}

function mergeCandidates(primary: Candidate[], additional: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const candidate of [...primary, ...additional]) byId.set(candidate.id, candidate);
  return Array.from(byId.values()).filter((candidate) => !candidate.archived_at);
}

function initialSelections(preview: AttachmentPreview, candidates: Candidate[], forcedCandidateId?: string) {
  const next: Record<string, RecordSelection> = {};
  for (const record of preview.records) {
    const matchedId = record.match.candidate_id ?? record.match.candidate?.id ?? "";
    const allowForcedCandidate = preview.records.length === 1 && record.match.status === "not_found";
    next[record.record_id] = {
      candidateId: matchedId || (allowForcedCandidate ? forcedCandidateId ?? "" : ""),
      fields: new Set(record.match.resolution === "created"
        ? []
        : record.suggestions.filter((item) => item.default_selected && item.confidence !== "low" && item.conflict === undefined
          && item.evidence_status !== "unverified"
          && attachmentSuggestionHasEvidence(item)).map((item) => item.field)),
      sections: new Set(record.match.resolution === "created"
        ? []
        : record.sections.filter((item) => !isAttachmentSelfSummarySection(item) && item.default_selected && item.confidence !== "low" && item.conflict === undefined
          && item.evidence_status !== "unverified"
          && attachmentSuggestionHasEvidence(item)).map((item) => item.section_id)),
    };
    const selectedCandidate = candidates.find((candidate) => candidate.id === next[record.record_id].candidateId);
    if (selectedCandidate?.archived_at) next[record.record_id].candidateId = "";
  }
  return next;
}

export function AttachmentWorkflow({
  candidateId,
  candidates,
  disabled = false,
  deletedAttachment = null,
  onCommitted,
  onCandidateCreated,
}: AttachmentWorkflowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFileRef = useRef<File | null>(null);
  const workflowGenerationRef = useRef(0);
  const confirmedAttachmentIdsRef = useRef<Set<string>>(new Set());
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [selections, setSelections] = useState<Record<string, RecordSelection>>({});
  const [state, setState] = useState<"idle" | "uploading" | "parsing" | "ready" | "confirming" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [errorRecovery, setErrorRecovery] = useState<ErrorRecovery>("none");
  const [dragActive, setDragActive] = useState(false);
  const [resolvedCandidates, setResolvedCandidates] = useState<Candidate[]>([]);
  const [candidateBaselines, setCandidateBaselines] = useState<Record<string, Candidate>>({});
  const [searchRecordId, setSearchRecordId] = useState<string | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [createRecordId, setCreateRecordId] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [pendingCreatedCandidateId, setPendingCreatedCandidateId] = useState<string | null>(null);
  const [pendingCreateWarning, setPendingCreateWarning] = useState("");
  const [confirmOutcomeUnknown, setConfirmOutcomeUnknown] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const activeCandidates = useMemo(
    () => mergeCandidates(candidates, resolvedCandidates),
    [candidates, resolvedCandidates],
  );

  function resetCompletedWorkflow() {
    workflowGenerationRef.current += 1;
    confirmedAttachmentIdsRef.current.clear();
    lastFileRef.current = null;
    setPreview(null);
    setSelections({});
    setResolvedCandidates([]);
    setCandidateBaselines({});
    setPendingCreatedCandidateId(null);
    setPendingCreateWarning("");
    setConfirmOutcomeUnknown(false);
    setError("");
    setErrorRecovery("none");
    setState("idle");
  }

  useEffect(() => {
    if (!deletedAttachment || state !== "done" || !preview) return;
    const confirmedIds = confirmedAttachmentIdsRef.current;
    const matchesConfirmedAttachment = confirmedIds.has(deletedAttachment.id)
      || (confirmedIds.size === 0 && preview.file.sha256 === deletedAttachment.sha256);
    if (matchesConfirmedAttachment) resetCompletedWorkflow();
  }, [deletedAttachment, preview, state]);

  useEffect(() => {
    if (!preview || !PROCESSING_STATUSES.has(preview.status) || state !== "parsing") return;
    const previewId = preview.preview_id;
    const parsedExpiry = Date.parse(preview.expires_at);
    const deadline = Number.isFinite(parsedExpiry)
      ? parsedExpiry
      : Date.now() + STATUS_POLL_FALLBACK_WINDOW_MS;
    const controller = new AbortController();
    let cancelled = false;
    let timer: number | undefined;
    let failureCount = 0;

    const schedule = (delay: number) => {
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setError("附件解析未在预览有效期内完成，请重试当前文件。");
        setErrorRecovery("upload");
        setState("error");
        return;
      }
      try {
        const next = await attachmentApi.getPreview(previewId, preview.preview_token, controller.signal);
        if (cancelled) return;
        failureCount = 0;
        const nextWithToken = preserveAttachmentPreviewToken(next, preview);
        if (READY_STATUSES.has(nextWithToken.status)) {
          setPreview(nextWithToken);
          setSelections(initialSelections(nextWithToken, activeCandidates, candidateId));
          setError("");
          setErrorRecovery("none");
          setState("ready");
        } else if (nextWithToken.status === "failed") {
          setPreview(nextWithToken);
          setError(previewFailureMessage(nextWithToken));
          setErrorRecovery(nextWithToken.retryable === false ? "none" : "upload");
          setState("error");
        } else if (PROCESSING_STATUSES.has(nextWithToken.status)) {
          setPreview(nextWithToken);
          schedule(previewPollDelay(nextWithToken));
        } else {
          setPreview(nextWithToken);
          setError(nextWithToken.status === "expired"
            ? "附件预览已过期，请重新上传文件。"
            : `附件解析已停止（状态：${nextWithToken.status}），请重试当前文件。`);
          setErrorRecovery("upload");
          setState("error");
        }
      } catch (requestError) {
        if (cancelled || controller.signal.aborted) return;
        if (isTerminalClientError(requestError)) {
          setError(safeErrorMessage(requestError, "附件预览已不可用，请重新上传文件。"));
          setErrorRecovery([404, 409, 410].includes(requestError.status) ? "upload" : "none");
          setState("error");
          return;
        }
        failureCount += 1;
        if (failureCount < STATUS_POLL_MAX_FAILURES && Date.now() < deadline) {
          schedule(Math.min(STATUS_POLL_DELAY_MS * 2 ** failureCount, 5_000));
          return;
        }
        setError(safeErrorMessage(requestError, "附件解析状态连续获取失败，请检查服务状态后重试。"));
        setErrorRecovery("status");
        setState("error");
      }
    };

    schedule(previewPollDelay(preview));
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeCandidates, candidateId, pollRevision, preview?.expires_at, preview?.preview_id, preview?.status, state]);

  async function upload(file: File) {
    if (disabled || state === "uploading" || state === "parsing" || state === "confirming") return;
    const generation = ++workflowGenerationRef.current;
    const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      setError("仅支持 PDF、DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV 和 TXT。旧版 DOC 与其他格式无法解析。");
      setErrorRecovery("none");
      setState("error");
      return;
    }
    if (file.size <= 0) {
      setError("附件为空，请重新选择包含内容的文件。");
      setErrorRecovery("none");
      setState("error");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError("单个附件不能超过 15 MB。");
      setErrorRecovery("none");
      setState("error");
      return;
    }
    lastFileRef.current = file;
    confirmedAttachmentIdsRef.current.clear();
    setError("");
    setErrorRecovery("none");
    setPreview(null);
    setSelections({});
    setResolvedCandidates([]);
    setCandidateBaselines({});
    setSearchRecordId(null);
    setCreateRecordId(null);
    setPendingCreatedCandidateId(null);
    setPendingCreateWarning("");
    setConfirmOutcomeUnknown(false);
    setState("uploading");
    try {
      const next = await attachmentApi.createPreview(file, candidateId);
      if (workflowGenerationRef.current !== generation) return;
      setPreview(next);
      if (READY_STATUSES.has(next.status)) {
        setSelections(initialSelections(next, activeCandidates, candidateId));
        setState("ready");
      } else if (next.status === "failed") {
        setError(previewFailureMessage(next));
        setErrorRecovery(next.retryable === false ? "none" : "upload");
        setState("error");
      } else if (PROCESSING_STATUSES.has(next.status)) {
        setState("parsing");
      } else {
        setError(`附件服务返回了无法继续的状态：${next.status}`);
        setErrorRecovery("upload");
        setState("error");
      }
    } catch (requestError) {
      if (workflowGenerationRef.current !== generation) return;
      setError(safeErrorMessage(requestError, "附件上传或校验失败，请检查文件后重试。"));
      setErrorRecovery("upload");
      setState("error");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function discard({ keepFile = false }: { keepFile?: boolean } = {}): Promise<boolean> {
    const generation = ++workflowGenerationRef.current;
    const current = preview;
    confirmedAttachmentIdsRef.current.clear();
    setPreview(null);
    setSelections({});
    setResolvedCandidates([]);
    setCandidateBaselines({});
    setSearchRecordId(null);
    setCreateRecordId(null);
    setPendingCreatedCandidateId(null);
    setPendingCreateWarning("");
    setConfirmOutcomeUnknown(false);
    setError("");
    setErrorRecovery("none");
    setState("idle");
    if (!keepFile) lastFileRef.current = null;
    if (current) {
      try {
        await attachmentApi.deletePreview(current.preview_id, current.preview_token);
      } catch (requestError) {
        if (workflowGenerationRef.current !== generation) return true;
        setError(safeErrorMessage(requestError, "临时附件清理失败，请稍后重试。"));
        setErrorRecovery(keepFile ? "upload" : "none");
        setState("error");
        return false;
      }
    }
    return true;
  }

  async function retryCurrentFile() {
    const file = lastFileRef.current;
    if (!file) return;
    if (preview && !await discard({ keepFile: true })) return;
    await upload(file);
  }

  async function chooseAnotherFile() {
    await discard();
    window.setTimeout(() => inputRef.current?.click(), 0);
  }

  function retryStatus() {
    setError("");
    setErrorRecovery("none");
    setState("parsing");
    setPollRevision((value) => value + 1);
  }

  function updateRecord(recordId: string, update: (current: RecordSelection) => RecordSelection) {
    setSelections((current) => ({
      ...current,
      [recordId]: update(current[recordId] ?? { candidateId: "", fields: new Set(), sections: new Set() }),
    }));
  }

  function toggleField(recordId: string, field: string) {
    updateRecord(recordId, (current) => {
      const fields = new Set(current.fields);
      fields.has(field) ? fields.delete(field) : fields.add(field);
      return { ...current, fields };
    });
  }

  function toggleSection(recordId: string, sectionId: string) {
    updateRecord(recordId, (current) => {
      const sections = new Set(current.sections);
      sections.has(sectionId) ? sections.delete(sectionId) : sections.add(sectionId);
      return { ...current, sections };
    });
  }

  function selectCandidate(recordId: string, candidate: Candidate, source: "existing" | "created") {
    setResolvedCandidates((current) => mergeCandidates(current, [candidate]));
    setCandidateBaselines((current) => ({ ...current, [recordId]: candidate }));
    const record = preview?.records.find((item) => item.record_id === recordId);
    updateRecord(recordId, (current) => ({
      ...current,
      candidateId: candidate.id,
      fields: !record ? current.fields : source === "existing" ? defaultFieldsForCandidate(record, candidate) : new Set(),
      sections: source === "created" ? new Set() : current.sections,
    }));
  }

  function openCandidateSearch(recordId: string) {
    setSearchError("");
    setSearchRecordId(recordId);
  }

  async function selectExistingCandidate(candidateIds: string[]) {
    const recordId = searchRecordId;
    const selectedId = candidateIds[0];
    if (!recordId || !selectedId || searchBusy) return;
    setSearchBusy(true);
    setSearchError("");
    try {
      const candidate = await candidateApi.get(selectedId, true);
      if (candidate.archived_at) {
        setSearchError("该候选人已归档，请返回并选择在库候选人。");
        return;
      }
      const usedByAnotherRecord = Object.entries(selections).some(([otherRecordId, selection]) => (
        otherRecordId !== recordId && selection.candidateId === candidate.id
      ));
      if (usedByAnotherRecord) {
        setSearchError("同一批附件记录不能重复选择同一候选人。");
        return;
      }
      selectCandidate(recordId, candidate, "existing");
      setSearchRecordId(null);
    } catch (requestError) {
      setSearchError(safeErrorMessage(requestError, "候选人详情获取失败，请重试。"));
    } finally {
      setSearchBusy(false);
    }
  }

  function openCandidateCreate(recordId: string) {
    setCreateError("");
    setPendingCreatedCandidateId(null);
    setPendingCreateWarning("");
    setCreateRecordId(recordId);
  }

  function closeCandidateCreate() {
    setCreateRecordId(null);
    setCreateError("");
    setPendingCreatedCandidateId(null);
    setPendingCreateWarning("");
  }

  async function createCandidate(draft: CandidateDraft, options: CandidateFormSubmitOptions) {
    const recordId = createRecordId;
    if (!recordId || !preview || createBusy) return;
    setCreateBusy(true);
    setCreateError("");
    let createdId = pendingCreatedCandidateId;
    const wasPending = Boolean(createdId);
    const {
      preferences,
      profile_sections,
      stage: _legacyStage,
      expected_salary: _legacySalary,
      ...candidateFields
    } = draft;
    const hasPreferences = Boolean(
      preferences.employment_status
      || preferences.desired_titles.length
      || preferences.desired_locations.length
      || preferences.employment_type
      || preferences.expected_salary
      || preferences.availability,
    );
    try {
      let preferenceWarning = pendingCreateWarning;
      if (!createdId) {
        const created = await attachmentApi.createCandidate(
          preview.preview_id,
          preview.preview_token,
          recordId,
          candidateFields,
          profile_sections ?? [],
          options.includeAttachmentAvatar,
        );
        createdId = created.id;
        setPendingCreatedCandidateId(created.id);
        onCandidateCreated?.(created.id);
      }

      // The attachment endpoint commits the candidate, avatar and profile
      // sections atomically. Preferences are the only follow-up write; keep
      // the modal open when that step fails so the same form can retry it.
      if (hasPreferences && (!wasPending || pendingCreateWarning)) {
        try {
          await candidateApi.updatePreferences(createdId, preferences);
          preferenceWarning = "";
          setPendingCreateWarning("");
        } catch (preferenceError) {
          preferenceWarning = safeErrorMessage(preferenceError, "请稍后在候选人档案中补充。");
          setPendingCreateWarning(preferenceWarning);
          setCreateError(`候选人已创建，但求职偏好未完整保存：${preferenceWarning}`);
          return;
        }
      }
      const selected = await getCandidateWithRetry(createdId);
      selectCandidate(recordId, selected, "created");
      setCreateRecordId(null);
      setPendingCreatedCandidateId(null);
      setPendingCreateWarning("");
      if (preferenceWarning) setError(`候选人已创建，但求职偏好未完整保存：${preferenceWarning}`);
    } catch (requestError) {
      setCreateError(createdId
        ? `候选人已创建，但最新版本暂时无法获取。请点击“重新获取并选择”：${safeErrorMessage(requestError, "候选人详情获取失败。")}`
        : safeErrorMessage(requestError, "候选人创建失败，请检查填写内容后重试。"));
    } finally {
      setCreateBusy(false);
    }
  }

  const searchRecord = preview?.records.find((record) => record.record_id === searchRecordId) ?? null;
  const createRecord = preview?.records.find((record) => record.record_id === createRecordId) ?? null;
  const createInitialDraft = useMemo(
    () => createRecord ? candidateDraftFromRecord(createRecord) : undefined,
    [createRecord],
  );

  const confirmRecords = useMemo<AttachmentConfirmRecord[]>(() => {
    if (!preview) return [];
    return preview.records.flatMap((record) => {
      if (["identity_conflict", "multiple_matches"].includes(record.match.status)) return [];
      const selection = selections[record.record_id];
      if (!selection?.candidateId) return [];
      const expectedUpdatedAt = record.match.candidate?.id === selection.candidateId
        ? record.match.candidate.updated_at
        : activeCandidates.find((candidate) => candidate.id === selection.candidateId)?.updated_at;
      if (!expectedUpdatedAt) return [];
      const candidateBaseline = candidateBaselines[record.record_id];
      const selectedFields = Array.from(selection.fields).filter((field) => {
        if (!candidateBaseline) return true;
        const suggestion = record.suggestions.find((item) => item.field === field);
        return Boolean(suggestion && suggestionChangesCandidate(candidateBaseline, field, suggestion.value));
      });
      return [{
        record_id: record.record_id,
        candidate_id: selection.candidateId,
        expected_updated_at: expectedUpdatedAt,
        selected_fields: selectedFields,
        selected_sections: Array.from(selection.sections),
        merge_mode: "merge" as const,
      }];
    });
  }, [activeCandidates, candidateBaselines, preview, selections]);

  const duplicateCandidateIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of preview?.records ?? []) {
      const selectedId = selections[record.record_id]?.candidateId;
      if (selectedId) counts.set(selectedId, (counts.get(selectedId) ?? 0) + 1);
    }
    return new Set(Array.from(counts).filter(([, count]) => count > 1).map(([candidateId]) => candidateId));
  }, [preview, selections]);

  const blockedRecordCount = preview?.records.filter((record) => {
    if (["identity_conflict", "multiple_matches"].includes(record.match.status)) return true;
    const selectedId = selections[record.record_id]?.candidateId;
    return !selectedId || duplicateCandidateIds.has(selectedId);
  }).length ?? 0;
  const canConfirm = Boolean(preview?.records.length && !blockedRecordCount && confirmRecords.length === preview.records.length);

  function completeConfirmation(updatedCandidateIds?: string[], attachmentIds: string[] = []) {
    const updatedIds = updatedCandidateIds?.length
      ? updatedCandidateIds
      : Array.from(new Set(confirmRecords.map((record) => record.candidate_id)));
    confirmedAttachmentIdsRef.current = new Set(attachmentIds.filter(Boolean));
    setConfirmOutcomeUnknown(false);
    setError("");
    setErrorRecovery("none");
    setState("done");
    onCommitted?.(updatedIds);
  }

  async function recoverConfirmOutcome() {
    if (!preview) return;
    const originalPreview = preview;
    setState("confirming");
    setError("");
    try {
      const latest = await attachmentApi.getPreview(originalPreview.preview_id, originalPreview.preview_token);
      if (latest.status === "confirmed") {
        setPreview(latest);
        completeConfirmation();
        return;
      }
      if (READY_STATUSES.has(latest.status)) {
        setPreview(preserveAttachmentPreviewToken(latest, originalPreview));
        setConfirmOutcomeUnknown(false);
        setError("服务端确认本次更新尚未提交，可以重新确认。");
        setErrorRecovery("none");
        setState("ready");
        return;
      }
      setConfirmOutcomeUnknown(false);
      setError(latest.status === "expired"
        ? "附件预览已过期，请重新上传并核对更新。"
        : `无法确认附件更新结果（状态：${latest.status}），请重新上传并核对。`);
      setErrorRecovery("upload");
      setState("error");
    } catch (requestError) {
      if (isTerminalClientError(requestError)) {
        setConfirmOutcomeUnknown(false);
        setError(safeErrorMessage(requestError, "附件预览已不可用，请重新上传并核对更新。"));
        setErrorRecovery([404, 409, 410].includes(requestError.status) ? "upload" : "none");
        setState("error");
        return;
      }
      setConfirmOutcomeUnknown(true);
      setError("暂时无法确认上一次提交是否完成。请先检查确认结果，系统不会重复提交。");
      setErrorRecovery("none");
      setState("ready");
    }
  }

  async function confirm() {
    if (!preview || !canConfirm || state === "confirming" || confirmOutcomeUnknown) return;
    setState("confirming");
    setError("");
    setConfirmOutcomeUnknown(false);
    try {
      const result = await attachmentApi.confirmPreview(preview.preview_id, preview.preview_token, confirmRecords);
      completeConfirmation(
        result.updated_candidate_ids,
        result.attachment_ids ?? result.attachments?.map((attachment) => attachment.id) ?? [],
      );
    } catch (requestError) {
      if (isAmbiguousConfirmError(requestError)
        || requestError instanceof ApiError && requestError.code === "attachment_preview_replayed") {
        setConfirmOutcomeUnknown(true);
        await recoverConfirmOutcome();
        return;
      }
      if (requestError instanceof ApiError && requestError.code === "version_conflict") {
        setError(`${requestError.message} 请重新上传当前文件，以最新候选人档案重新计算差异。`);
        setErrorRecovery("upload");
        setState("error");
        return;
      }
      setError(safeErrorMessage(requestError, "附件确认失败，请刷新候选人状态后重试。"));
      setErrorRecovery("none");
      setState("ready");
    }
  }

  if (state === "idle" || (state === "error" && !preview)) {
    return (
      <div className="attachment-workflow">
        <button
          className={`attachment-drop-zone${dragActive ? " is-dragging" : ""}`}
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            const file = event.dataTransfer.files[0];
            if (file) void upload(file);
          }}
        >
          <UploadCloud size={24} />
          <strong>{disabled ? "已归档候选人不能上传附件" : "拖放简历，或点击选择文件"}</strong>
          <span>PDF、DOCX、XLSX、XLSM、XLS、CSV、TXT · 最大 15 MB</span>
        </button>
        <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} disabled={disabled} onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
        {error && <div className="attachment-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button className="icon-button compact-icon-button" type="button" onClick={() => { setError(""); setErrorRecovery("none"); setState("idle"); }} aria-label="关闭错误"><X size={14} /></button></div>}
        {state === "error" && !disabled && <div className="attachment-error-actions">
          {errorRecovery === "upload" && lastFileRef.current && <button className="button secondary-button" type="button" onClick={() => void retryCurrentFile()}><RefreshCw size={15} />重试当前文件</button>}
          <button className="button secondary-button" type="button" onClick={() => inputRef.current?.click()}><UploadCloud size={15} />重新选择文件</button>
        </div>}
      </div>
    );
  }

  if ((state === "uploading" || state === "parsing") && !preview?.records.length) {
    return (
      <div className="attachment-processing" role="status" aria-live="polite">
        <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} disabled={disabled} onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
        <LoaderCircle className="spin" size={22} />
        <div><strong>{state === "uploading" ? "正在安全上传" : "正在本地解析简历"}</strong><span>校验文件签名并提取身份字段与履历内容...</span></div>
        {preview && <button className="button secondary-button" type="button" onClick={() => void discard()}>取消</button>}
      </div>
    );
  }

  if (!preview) return null;
  const pipelineRetryable = Boolean(
    preview.pipeline?.text_model?.retryable === true
    || preview.pipeline?.visual?.retryable === true,
  );

  return (
    <>
    <div className="attachment-workflow attachment-preview-workflow">
      <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} disabled={disabled} onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
      <div className="attachment-preview-file">
        {preview.file.format.includes("xls") || preview.file.format === "csv" ? <FileSpreadsheet size={18} /> : <FileText size={18} />}
        <div><strong title={preview.file.original_filename}>{preview.file.original_filename}</strong><span>{preview.file.format.toLocaleUpperCase()} · {fileSize(preview.file.file_size)} · {preview.records.length} 条记录</span></div>
        {state !== "done" && <button className="icon-button compact-icon-button" type="button" onClick={() => void discard()} disabled={state === "confirming"} aria-label="取消并清理临时附件" title="取消上传"><Trash2 size={15} /></button>}
      </div>
      <div className="attachment-parser-status" aria-live="polite">
        <span>{attachmentParserPipelineLabel(preview.pipeline?.text?.content_type)}</span>
        <span>解析器：{preview.parser_version ?? "未提供"}</span>
        <span className={`attachment-pipeline-channel ${attachmentPipelineChannelTone(preview.pipeline?.text_model)}`}>
          文本模型：{attachmentPipelineChannelLabel(preview.pipeline?.text_model)}
          {attachmentPipelineChannelDetail(preview.pipeline?.text_model) && <small>{attachmentPipelineChannelDetail(preview.pipeline?.text_model)}</small>}
        </span>
        <span className={`attachment-pipeline-channel ${attachmentPipelineChannelTone(preview.pipeline?.visual)}`}>
          视觉通道：{attachmentPipelineChannelLabel(preview.pipeline?.visual)}
          {attachmentPipelineChannelDetail(preview.pipeline?.visual) && <small>{attachmentPipelineChannelDetail(preview.pipeline?.visual)}</small>}
        </span>
        {preview.pipeline?.visual?.used_fallback && <span className="is-warning">视觉解析已降级，已保留文本解析结果{preview.pipeline?.visual?.error_code ? `（${preview.pipeline.visual.error_code}）` : ""}</span>}
        {preview.pipeline?.text_model?.status === "fallback" && <span className="is-warning">文本模型已降级，当前结果仍需人工核对{preview.pipeline.text_model.error_code ? `（${preview.pipeline.text_model.error_code}）` : ""}</span>}
        {pipelineRetryable && lastFileRef.current && state === "ready" && <button className="button secondary-button attachment-channel-retry" type="button" onClick={() => void retryCurrentFile()}><RefreshCw size={14} />重新运行解析通道</button>}
      </div>

      {state === "error" ? (
        <div className="attachment-failure" role="alert">
          <AlertTriangle size={23} />
          <div><strong>附件处理未完成</strong><span>{error || "附件处理失败，请重试。"}</span></div>
          <div className="attachment-failure-actions">
            {errorRecovery === "status" && <button className="button secondary-button" type="button" onClick={retryStatus}><RefreshCw size={15} />重新获取状态</button>}
            {errorRecovery === "upload" && lastFileRef.current && <button className="button secondary-button" type="button" onClick={() => void retryCurrentFile()}><RefreshCw size={15} />重试当前文件</button>}
            <button className="button secondary-button" type="button" onClick={() => void chooseAnotherFile()}><UploadCloud size={15} />重新选择文件</button>
          </div>
        </div>
      ) : state === "done" ? (
        <div className="attachment-complete"><CheckCircle2 size={25} /><div><strong>附件已保存，所选字段已更新</strong><span>重复提交不会再次写入附件、字段或活动。</span></div><button className="button secondary-button" type="button" onClick={resetCompletedWorkflow}>继续上传</button></div>
      ) : (
        <>
          <div className="attachment-record-list">
            {preview.records.map((record) => {
              const matchCopy = MATCH_COPY[record.match.status];
              const selection = selections[record.record_id] ?? { candidateId: "", fields: new Set<string>(), sections: new Set<string>() };
              const selectedCandidate = activeCandidates.find((item) => item.id === selection.candidateId);
              const matchedCandidate = record.match.candidate ?? selectedCandidate;
              const candidateBaseline = candidateBaselines[record.record_id]
                ?? (record.match.resolution === "created" ? selectedCandidate : undefined);
              const hasDuplicateCandidate = Boolean(selection.candidateId && duplicateCandidateIds.has(selection.candidateId));
              const rowLabel = record.row_number ? `第 ${record.row_number} 行` : "简历记录";
              const parsedName = parsedCandidateName(record);
              const visibleSections = record.sections.filter((section) => !isAttachmentSelfSummarySection(section));
              return (
                <article className="attachment-record" key={record.record_id}>
                  <header>
                    <div><strong>{rowLabel}</strong><span className={`match-badge is-${matchCopy.tone}`}>{matchCopy.label}</span></div>
                    <small>{record.match.reason}</small>
                  </header>
                  <div className="attachment-identity-line">
                    <span>手机：{record.identity.phone || "未提取"}</span><span>邮箱：{record.identity.email || "未提取"}</span>
                  </div>
                  {record.avatar?.available && <div className="attachment-avatar-detection is-ready"><ImageIcon size={15} /><span>{record.avatar.source === "explicit_url" ? "已识别外部头像地址，创建时需确认是否使用" : "已识别附件头像，创建候选人时默认使用"}</span></div>}
                  {record.avatar?.status === "ambiguous" && <div className="attachment-avatar-detection is-warning"><AlertTriangle size={15} /><span>检测到多张可能的头像，已停止自动选择</span></div>}
                  {matchedCandidate && record.match.status !== "not_found" && (
                    <div className="attachment-match-candidate"><UserRoundCheck size={16} /><span>匹配到 <strong>{matchedCandidate.name}</strong></span></div>
                  )}
                  {record.match.status === "not_found" && (
                    <div className="attachment-match-fallback">
                      <div>
                        <strong>{matchedCandidate ? `已选择 ${matchedCandidate.name}` : "需要确认候选人"}</strong>
                        <span>{matchedCandidate
                          ? [selectedCandidate?.current_title, selectedCandidate?.current_company].filter(Boolean).join(" · ") || "候选人档案"
                          : `手机号和邮箱均未匹配${parsedName ? `，可按“${parsedName}”搜索` : ""}`}</span>
                      </div>
                      <div>
                        <button className="button secondary-button" type="button" onClick={() => openCandidateSearch(record.record_id)}><Search size={15} />按姓名搜索</button>
                        <button className="button secondary-button" type="button" onClick={() => openCandidateCreate(record.record_id)}><UserPlus size={15} />创建新候选人</button>
                      </div>
                    </div>
                  )}
                  {hasDuplicateCandidate && <div className="attachment-blocked"><AlertTriangle size={15} /><span>同一批附件记录不能重复关联同一候选人，请为每条记录选择不同候选人。</span></div>}
                  {["identity_conflict", "multiple_matches"].includes(record.match.status) && <div className="attachment-blocked"><AlertTriangle size={15} /><span>身份冲突已阻断，不能猜测或覆盖候选人。</span></div>}

                  {record.suggestions.length > 0 && <div className="attachment-diff-list"><h4>字段更新</h4>{record.suggestions.map((suggestion) => {
                    const currentValue = candidateBaseline
                      ? candidateFieldValue(candidateBaseline, suggestion.field)
                      : suggestion.current_value;
                    const hasRealChange = !candidateBaseline
                      || suggestionChangesCandidate(candidateBaseline, suggestion.field, suggestion.value);
                    const selected = hasRealChange && selection.fields.has(suggestion.field);
                    const evidence = hasRealChange
                      ? attachmentSuggestionEvidence(suggestion.field, suggestion.evidence, suggestion.value)
                      : "与现有档案一致，不会提交更新";
                    return (
                      <label className={`attachment-diff${selected ? " is-selected" : ""}${hasRealChange ? "" : " is-unchanged"}`} key={suggestion.field}>
                        <input type="checkbox" checked={selected} onChange={() => toggleField(record.record_id, suggestion.field)} disabled={!selection.candidateId || !hasRealChange} />
                        <span className="attachment-diff-main"><span><strong>{attachmentFieldLabel(suggestion.field)}</strong><span className="attachment-suggestion-meta"><em className="attachment-provenance">{attachmentProvenanceLabel(suggestion.source)}</em>{attachmentEvidenceStatusLabel(suggestion.evidence_status) && <em className={`attachment-evidence-status is-${suggestion.evidence_status}`}>{attachmentEvidenceStatusLabel(suggestion.evidence_status)}</em>}<em className={`confidence is-${suggestion.confidence}`}>{suggestion.confidence === "high" ? "高" : suggestion.confidence === "medium" ? "中" : "低"}置信</em></span></span><span className="attachment-values"><del>{attachmentValueText(currentValue)}</del><b>→</b><ins>{attachmentValueText(suggestion.value)}</ins></span>{evidence && <small>{evidence}</small>}{attachmentSuggestionEvidenceRefs(suggestion).map((reference, index) => <small className="attachment-evidence-ref" key={`${reference.page ?? "none"}-${index}`}>{reference.page ? `第 ${reference.page} 页：` : "证据："}{reference.text}</small>)}<AttachmentConflictNotice conflict={suggestion.conflict} /></span>
                      </label>
                    );
                  })}</div>}

                  {visibleSections.length > 0 && <div className="attachment-section-suggestions"><h4>履历区块</h4>{visibleSections.map((section) => {
                    const selected = selection.sections.has(section.section_id);
                    return <label className={selected ? "is-selected" : ""} key={section.section_id}>
                      <input type="checkbox" checked={selected} onChange={() => toggleSection(record.record_id, section.section_id)} disabled={!selection.candidateId} />
                      <span><strong>{section.title || section.section_type}</strong><span className="attachment-suggestion-meta"><em className="attachment-provenance">{attachmentProvenanceLabel(section.source)}</em>{attachmentEvidenceStatusLabel(section.evidence_status) && <em className={`attachment-evidence-status is-${section.evidence_status}`}>{attachmentEvidenceStatusLabel(section.evidence_status)}</em>}<em className={`confidence is-${section.confidence}`}>{section.confidence === "high" ? "高" : section.confidence === "medium" ? "中" : "低"}置信</em></span><small>{section.content || section.evidence}</small>{attachmentSuggestionEvidenceRefs(section).map((reference, index) => <small className="attachment-evidence-ref" key={`${reference.page ?? "none"}-${index}`}>{reference.page ? `第 ${reference.page} 页：` : "证据："}{reference.text}</small>)}<AttachmentConflictNotice conflict={section.conflict} /></span>
                    </label>
                  })}</div>}
                </article>
              );
            })}
          </div>
          {error && <div className="attachment-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
          <div className="attachment-confirm-bar">
            <span>{blockedRecordCount ? `${blockedRecordCount} 条记录尚未解决匹配` : `将保存 ${confirmRecords.length} 条记录`}</span>
            <button
              className="button primary-button"
              type="button"
              disabled={state === "confirming" || (!confirmOutcomeUnknown && !canConfirm)}
              onClick={() => void (confirmOutcomeUnknown ? recoverConfirmOutcome() : confirm())}
            ><Check size={16} />{state === "confirming" ? (confirmOutcomeUnknown ? "正在检查结果..." : "正在确认...") : confirmOutcomeUnknown ? "检查确认结果" : "确认更新并保存附件"}</button>
          </div>
        </>
      )}
    </div>
    <CandidatePickerDialog
      open={Boolean(searchRecord)}
      linkedCandidateIds={Object.entries(selections)
        .filter(([recordId]) => recordId !== searchRecordId)
        .map(([, selection]) => selection.candidateId)
        .filter(Boolean)}
      loading={false}
      busy={searchBusy}
      maxSelection={1}
      eyebrow="附件候选人匹配"
      title={searchRecord && parsedCandidateName(searchRecord)
        ? `搜索“${parsedCandidateName(searchRecord)}”`
        : "按姓名搜索候选人"}
      helperText="选择后将返回附件预览，由你确认字段与履历更新"
      confirmLabel="选择"
      initialQuery={searchRecord ? parsedCandidateName(searchRecord) : ""}
      externalError={searchError}
      onClose={() => { if (!searchBusy) { setSearchRecordId(null); setSearchError(""); } }}
      onConfirm={(candidateIds) => void selectExistingCandidate(candidateIds)}
    />
    {createRecord && createInitialDraft && <div className="modal-layer attachment-candidate-create-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !createBusy && closeCandidateCreate()}>
      <section className="modal attachment-candidate-create-dialog" role="dialog" aria-modal="true" aria-label="创建候选人并关联附件" aria-busy={createBusy || undefined}>
        <header className="modal-header">
          <div><p className="drawer-kicker">附件候选人匹配</p><h2>创建新候选人</h2></div>
          <button className="icon-button" type="button" onClick={closeCandidateCreate} disabled={createBusy} aria-label="关闭" title="关闭"><X size={19} /></button>
        </header>
        {createError && <div className="attachment-create-error" role="alert"><AlertTriangle size={15} /><span>{createError}</span></div>}
        <CandidateForm
          initialDraft={createInitialDraft}
          attachmentAvatar={createRecord.avatar}
          submitLabel={pendingCreatedCandidateId ? "重新获取并选择" : "创建并选择"}
          busy={createBusy}
          fieldsDisabled={Boolean(pendingCreatedCandidateId)}
          requireContact={false}
          statusMessage={pendingCreateWarning || undefined}
          onCancel={closeCandidateCreate}
          onSubmit={(draft, options) => void createCandidate(draft, options)}
        />
      </section>
    </div>}
    </>
  );
}

interface CandidateAttachmentsPanelProps {
  candidate: Candidate;
  disabled?: boolean;
  onCandidateUpdated?: () => void;
  onCandidateCreated?: (candidateId: string) => void;
}

export function CandidateAttachmentsPanel({ candidate, disabled = false, onCandidateUpdated, onCandidateCreated }: CandidateAttachmentsPanelProps) {
  const [attachments, setAttachments] = useState<CandidateAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CandidateAttachment | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deletedAttachment, setDeletedAttachment] = useState<Pick<CandidateAttachment, "id" | "sha256"> | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setAttachments(await attachmentApi.listForCandidate(candidate.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "附件列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setDeleteTarget(null);
    setDeletingAttachmentId(null);
    setDeleteError("");
    setDeletedAttachment(null);
    void load();
  }, [candidate.id]);

  function requestAttachmentDelete(attachment: CandidateAttachment) {
    if (disabled || deletingAttachmentId) return;
    setDeleteError("");
    setDeleteTarget(attachment);
  }

  function cancelAttachmentDelete() {
    if (deletingAttachmentId) return;
    setDeleteError("");
    setDeleteTarget(null);
  }

  async function deleteAttachment() {
    const target = deleteTarget;
    if (!target || disabled || deletingAttachmentId) return;
    setDeletingAttachmentId(target.id);
    setDeleteError("");
    try {
      await attachmentApi.deleteAttachment(target.id);
      setAttachments((current) => current.filter((attachment) => attachment.id !== target.id));
      setDeletedAttachment({ id: target.id, sha256: target.sha256 });
      setDeleteTarget(null);
      onCandidateUpdated?.();
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 404) {
        setDeletedAttachment({ id: target.id, sha256: target.sha256 });
        setDeleteTarget(null);
        await load();
        onCandidateUpdated?.();
        return;
      }
      setDeleteError(safeErrorMessage(requestError, "附件删除失败，请稍后重试。"));
    } finally {
      setDeletingAttachmentId(null);
    }
  }

  const deleteBusy = Boolean(deleteTarget && deletingAttachmentId === deleteTarget.id);

  return (
    <section className="detail-section candidate-attachment-section">
      <div className="detail-section-heading"><h4>简历附件</h4><span>{attachments.length} 个文件</span></div>
      {!disabled && <AttachmentWorkflow
        candidateId={candidate.id}
        candidates={[candidate]}
        deletedAttachment={deletedAttachment}
        onCandidateCreated={(candidateId) => onCandidateCreated?.(candidateId)}
        onCommitted={(candidateIds) => {
          setDeletedAttachment(null);
          if (candidateIds.includes(candidate.id)) void load();
          onCandidateUpdated?.();
        }}
      />}
      {loading ? <div className="attachment-list-state"><LoaderCircle className="spin" size={17} /><span>正在加载附件...</span></div> : error ? <div className="attachment-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button className="icon-button compact-icon-button" type="button" onClick={() => void load()} aria-label="重试"><RefreshCw size={14} /></button></div> : attachments.length ? <div className="candidate-attachment-list">{attachments.map((attachment) => (
        <article key={attachment.id}>
          <span className="attachment-file-icon"><FileText size={17} /></span>
          <div><strong title={attachment.original_filename}>{attachment.original_filename}</strong><span>{attachment.mime_type || attachment.attachment_type} · {fileSize(attachment.file_size)} · {formatDateTime(attachment.created_at)}</span></div>
          <span className={`attachment-status is-${attachment.parse_status}`}>{["ready", "parsed"].includes(attachment.parse_status) ? "解析完成" : attachment.parse_status === "failed" ? "解析失败" : "处理中"}</span>
          <span className="linked-position-actions attachment-file-actions">
            <a className="icon-button compact-icon-button" href={attachmentApi.downloadUrl(attachment)} download aria-label={`下载 ${attachment.original_filename}`} title="下载附件"><Download size={15} /></a>
            <button
              className="icon-button compact-icon-button danger-quiet-button"
              type="button"
              onClick={() => requestAttachmentDelete(attachment)}
              disabled={disabled || deletingAttachmentId !== null}
              aria-label={`删除 ${attachment.original_filename}`}
              title={disabled ? "已归档候选人的附件不可删除" : "删除附件"}
            >{deletingAttachmentId === attachment.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>
          </span>
        </article>
      ))}</div> : <div className="section-empty"><FileText size={21} /><span>暂无简历附件</span></div>}
      {deleteTarget && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && cancelAttachmentDelete()}>
          <div
            className="modal confirm-modal attachment-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="attachment-delete-title"
            aria-describedby="attachment-delete-description"
            aria-busy={deleteBusy || undefined}
          >
            <header className="modal-header">
              <div><p className="drawer-kicker danger-kicker">删除附件</p><h2 id="attachment-delete-title">确认删除“{deleteTarget.original_filename}”？</h2></div>
              <button className="icon-button" type="button" onClick={cancelAttachmentDelete} disabled={deleteBusy} aria-label="关闭附件删除确认" title="关闭"><X size={19} /></button>
            </header>
            <div className="modal-body confirm-body">
              <span className="confirm-icon danger">{deleteBusy ? <LoaderCircle className="spin" size={22} /> : <Trash2 size={22} />}</span>
              <div>
                <p id="attachment-delete-description">附件记录、正文索引和物理文件将被清理。候选人不会被删除，已经确认写入的字段和履历也不会回滚。</p>
                {deleteError && <div className="attachment-error" role="alert"><AlertTriangle size={15} /><span>{deleteError}</span></div>}
              </div>
            </div>
            <footer className="modal-footer">
              <button className="button secondary-button" type="button" onClick={cancelAttachmentDelete} disabled={deleteBusy}>取消</button>
              <button className="button danger-button" type="button" onClick={() => void deleteAttachment()} disabled={deleteBusy || disabled}><Trash2 size={16} />{deleteBusy ? "正在删除..." : deleteError ? "重试删除" : "确认删除附件"}</button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
