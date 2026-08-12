import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  FileText,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { ApiError, attachmentBatchApi, candidateApi } from "../api";
import type {
  AttachmentBatch,
  AttachmentBatchItem,
  AttachmentConfirmRecord,
  AttachmentPreviewRecord,
  Candidate,
} from "../types";
import { CandidatePickerDialog } from "./CandidatePickerDialog";

const STORAGE_KEY = "candidate-workbench.attachment-batch.v1";
const ACCEPTED_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "xlsm", "xls", "csv", "zip"]);
const ACCEPT = Array.from(ACCEPTED_EXTENSIONS, (extension) => `.${extension}`).join(",");
const POLLING_STATUSES = new Set(["queued", "extracting", "identifying", "parsing", "matching"]);
const TERMINAL_BATCH_STATUSES = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);
const MAX_CLIENT_FILES = 100;

interface StoredBatch {
  batchId: string;
  batchToken: string;
  uploadIdempotencyKey: string;
  confirmKeys: Record<string, string>;
}

interface RecordSelection {
  candidateId: string;
  fields: Set<string>;
  sections: Set<string>;
}

interface AttachmentBatchWorkflowProps {
  candidates: Candidate[];
  disabled?: boolean;
  onCommitted?: (candidateIds: string[]) => void;
}

interface LegacyFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: LegacyFileEntry[]) => void, failure?: (error: DOMException) => void) => void;
  };
}

const STATUS_COPY: Record<string, string> = {
  queued: "排队中",
  extracting: "解压中",
  identifying: "识别中",
  parsing: "解析中",
  matching: "匹配中",
  awaiting_confirmation: "待确认",
  confirmed: "已确认",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

const MATCH_COPY: Record<string, string> = {
  high_confidence: "手机号与邮箱一致",
  single_identity: "单一身份字段匹配",
  identity_conflict: "身份字段冲突",
  multiple_matches: "存在多个匹配",
  not_found: "未匹配候选人",
};

function newOpaqueId(prefix: string) {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function readStoredBatch(): StoredBatch | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StoredBatch> | null;
    if (!parsed?.batchId || !parsed.batchToken) return null;
    return {
      batchId: parsed.batchId,
      batchToken: parsed.batchToken,
      uploadIdempotencyKey: parsed.uploadIdempotencyKey || newOpaqueId("attachment-upload"),
      confirmKeys: parsed.confirmKeys && typeof parsed.confirmKeys === "object" ? parsed.confirmKeys : {},
    };
  } catch {
    return null;
  }
}

function writeStoredBatch(value: StoredBatch | null) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The active in-memory batch remains usable when storage is unavailable.
  }
}

function displayFilename(item: AttachmentBatchItem) {
  return item.archive_path || item.original_filename;
}

function fileExtension(file: File) {
  return file.name.split(".").pop()?.toLowerCase() ?? "";
}

function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readEntryFile(entry: LegacyFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectory(entry: LegacyFileEntry): Promise<File[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const entries: LegacyFileEntry[] = [];
  while (true) {
    const page = await new Promise<LegacyFileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!page.length) break;
    entries.push(...page);
    if (entries.length > MAX_CLIENT_FILES) throw new Error(`单次最多选择 ${MAX_CLIENT_FILES} 个文件。`);
  }
  const nested = await Promise.all(entries.map((child) => filesFromEntry(child)));
  return nested.flat();
}

async function filesFromEntry(entry: LegacyFileEntry): Promise<File[]> {
  if (entry.isFile) return [await readEntryFile(entry)];
  if (entry.isDirectory) return readDirectory(entry);
  return [];
}

async function filesFromDrop(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items)
    .map((item) => {
      const getter = (item as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
      return (getter?.call(item) ?? null) as LegacyFileEntry | null;
    })
    .filter((entry): entry is LegacyFileEntry => Boolean(entry));
  if (!entries.length) return Array.from(dataTransfer.files);
  const files = (await Promise.all(entries.map(filesFromEntry))).flat();
  if (files.length > MAX_CLIENT_FILES) throw new Error(`单次最多选择 ${MAX_CLIENT_FILES} 个文件。`);
  return files;
}

function initialSelections(records: AttachmentPreviewRecord[], knownCandidates: Candidate[]) {
  return Object.fromEntries(records.map((record) => {
    const candidateId = record.match.candidate_id ?? record.match.candidate?.id ?? "";
    const archived = knownCandidates.find((candidate) => candidate.id === candidateId)?.archived_at;
    return [record.record_id, {
      candidateId: archived ? "" : candidateId,
      fields: new Set(record.suggestions.filter((item) => item.default_selected).map((item) => item.field)),
      sections: new Set(record.sections.filter((item) => item.default_selected).map((item) => item.section_id)),
    } satisfies RecordSelection];
  }));
}

function batchNeedsPolling(batch: AttachmentBatch | null) {
  return Boolean(batch && !TERMINAL_BATCH_STATUSES.has(batch.status) && batch.items.some((item) => POLLING_STATUSES.has(item.status)));
}

export function AttachmentBatchWorkflow({ candidates, disabled = false, onCommitted }: AttachmentBatchWorkflowProps) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const lastFilesRef = useRef<File[]>([]);
  const storedRef = useRef<StoredBatch | null>(readStoredBatch());
  const [batch, setBatch] = useState<AttachmentBatch | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, RecordSelection>>({});
  const [resolvedCandidates, setResolvedCandidates] = useState<Candidate[]>([]);
  const [pickerRecordId, setPickerRecordId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const [pickerError, setPickerError] = useState("");

  const knownCandidates = useMemo(() => {
    const byId = new Map<string, Candidate>();
    [...candidates, ...resolvedCandidates].forEach((candidate) => byId.set(candidate.id, candidate));
    return Array.from(byId.values());
  }, [candidates, resolvedCandidates]);

  const selectedItem = batch?.items.find((item) => item.item_id === selectedItemId) ?? null;
  const preview = selectedItem?.preview ?? null;
  const pickerRecord = preview?.records.find((record) => record.record_id === pickerRecordId) ?? null;

  function acceptBatch(next: AttachmentBatch) {
    setBatch(next);
    const stored = storedRef.current;
    if (stored && next.batch_token && next.batch_token !== stored.batchToken) {
      stored.batchToken = next.batch_token;
      writeStoredBatch(stored);
    }
    setSelectedItemId((current) => {
      if (current && next.items.some((item) => item.item_id === current)) return current;
      return next.items.find((item) => item.status === "awaiting_confirmation")?.item_id
        ?? next.items.find((item) => item.status === "failed")?.item_id
        ?? next.items[0]?.item_id
        ?? null;
    });
  }

  async function refresh(signal?: AbortSignal) {
    const stored = storedRef.current;
    if (!stored) return null;
    const next = await attachmentBatchApi.get(stored.batchId, stored.batchToken, signal);
    acceptBatch(next);
    return next;
  }

  useEffect(() => {
    const stored = storedRef.current;
    if (!stored) return;
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setPending(true);
    void refresh(controller.signal).catch((requestError) => {
      if (controller.signal.aborted) return;
      if (requestError instanceof ApiError && [403, 404, 410].includes(requestError.status)) {
        storedRef.current = null;
        writeStoredBatch(null);
      }
      setError(requestError instanceof Error ? requestError.message : "无法恢复附件批次。");
    }).finally(() => {
      if (!controller.signal.aborted) setPending(false);
    });
    return () => controller.abort();
  }, []);

  const shouldPollBatch = batchNeedsPolling(batch);
  useEffect(() => {
    if (!shouldPollBatch || !batch) return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    let lastPollError = "";

    const schedule = (snapshot: AttachmentBatch, overrideDelay?: number) => {
      const normalDelay = Math.min(5_000, Math.max(500, Number(snapshot.poll_after_ms) || 900));
      timer = window.setTimeout(() => {
        const controller = new AbortController();
        pollAbortRef.current?.abort();
        pollAbortRef.current = controller;
        void refresh(controller.signal).then((next) => {
          if (stopped || controller.signal.aborted || !next) return;
          failures = 0;
          if (lastPollError) {
            setError((current) => current === lastPollError ? "" : current);
            lastPollError = "";
          }
          if (batchNeedsPolling(next)) schedule(next);
        }).catch((requestError) => {
          if (stopped || controller.signal.aborted) return;
          failures += 1;
          lastPollError = requestError instanceof Error ? requestError.message : "批次状态暂时不可用。";
          setError(lastPollError);
          const retryDelay = Math.min(10_000, normalDelay * (2 ** Math.min(failures, 4)));
          schedule(snapshot, retryDelay);
        });
      }, overrideDelay ?? normalDelay);
    };

    schedule(batch);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      pollAbortRef.current?.abort();
    };
  }, [batch?.batch_id, shouldPollBatch]);

  useEffect(() => {
    const records = preview?.records ?? [];
    setSelections(initialSelections(records, knownCandidates));
    setPickerRecordId(null);
    setPickerError("");
  }, [selectedItem?.item_id, preview?.preview_id]);

  useEffect(() => () => {
    pollAbortRef.current?.abort();
    mutationAbortRef.current?.abort();
  }, []);

  async function upload(files: File[], reuseIdentity = false) {
    if (!reuseIdentity) lastFilesRef.current = [];
    const accepted = files.filter((file) => file.size > 0 && ACCEPTED_EXTENSIONS.has(fileExtension(file)));
    if (!accepted.length) {
      setError("未找到可处理的 PDF、Word、Excel、CSV 或 ZIP 文件。");
      return;
    }
    if (accepted.length > MAX_CLIENT_FILES) {
      setError(`单次最多选择 ${MAX_CLIENT_FILES} 个文件。`);
      return;
    }
    lastFilesRef.current = accepted;
    const stored: StoredBatch = reuseIdentity && storedRef.current && !storedRef.current.batchId
      ? storedRef.current
      : {
          batchId: "",
          batchToken: newOpaqueId("attachment-batch-token"),
          uploadIdempotencyKey: newOpaqueId("attachment-batch"),
          confirmKeys: {},
        };
    storedRef.current = stored;
    setPending(true);
    setError("");
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    try {
      const next = await attachmentBatchApi.create(
        accepted,
        stored.batchToken,
        stored.uploadIdempotencyKey,
        undefined,
        controller.signal,
      );
      stored.batchId = next.batch_id;
      if (next.batch_token) stored.batchToken = next.batch_token;
      writeStoredBatch(stored);
      acceptBatch(next);
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "批次上传失败。");
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (filesRef.current) filesRef.current.value = "";
      if (folderRef.current) folderRef.current.value = "";
    }
  }

  function updateSelection(recordId: string, update: (selection: RecordSelection) => RecordSelection) {
    setSelections((current) => ({
      ...current,
      [recordId]: update(current[recordId] ?? { candidateId: "", fields: new Set(), sections: new Set() }),
    }));
  }

  async function chooseCandidate(candidateIds: string[]) {
    const candidateId = candidateIds[0];
    const recordId = pickerRecordId;
    if (!candidateId || !recordId) return;
    setPickerError("");
    try {
      const candidate = knownCandidates.find((item) => item.id === candidateId) ?? await candidateApi.get(candidateId, true);
      if (candidate.archived_at) throw new Error("已归档候选人不能接收附件更新。");
      setResolvedCandidates((current) => current.some((item) => item.id === candidate.id) ? current : [...current, candidate]);
      updateSelection(recordId, (selection) => ({ ...selection, candidateId }));
      setPickerRecordId(null);
    } catch (requestError) {
      setPickerError(requestError instanceof Error ? requestError.message : "候选人读取失败。");
    }
  }

  const duplicateCandidateIds = useMemo(() => {
    const counts = new Map<string, number>();
    Object.values(selections).forEach((selection) => {
      if (selection.candidateId) counts.set(selection.candidateId, (counts.get(selection.candidateId) ?? 0) + 1);
    });
    return new Set(Array.from(counts).filter(([, count]) => count > 1).map(([id]) => id));
  }, [selections]);

  const confirmRecords = useMemo<AttachmentConfirmRecord[]>(() => (preview?.records ?? []).flatMap((record) => {
    const selection = selections[record.record_id];
    if (!selection?.candidateId || duplicateCandidateIds.has(selection.candidateId)) return [];
    const candidate = record.match.candidate?.id === selection.candidateId
      ? record.match.candidate
      : knownCandidates.find((item) => item.id === selection.candidateId);
    if (!candidate?.updated_at) return [];
    return [{
      record_id: record.record_id,
      candidate_id: selection.candidateId,
      expected_updated_at: candidate.updated_at,
      selected_fields: Array.from(selection.fields),
      selected_sections: Array.from(selection.sections),
      merge_mode: "merge" as const,
    }];
  }), [duplicateCandidateIds, knownCandidates, preview, selections]);

  async function confirmAndNext() {
    const stored = storedRef.current;
    if (!stored || !selectedItem || !preview || confirmRecords.length !== preview.records.length || pending) return;
    let idempotencyKey = stored.confirmKeys[selectedItem.item_id];
    if (!idempotencyKey) {
      idempotencyKey = newOpaqueId("attachment-confirm");
      stored.confirmKeys[selectedItem.item_id] = idempotencyKey;
      writeStoredBatch(stored);
    }
    setPending(true);
    setError("");
    const controller = new AbortController();
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = controller;
    try {
      const result = await attachmentBatchApi.confirm(
        stored.batchId,
        selectedItem.item_id,
        stored.batchToken,
        idempotencyKey,
        confirmRecords,
        preview.preview_token,
        controller.signal,
      );
      acceptBatch(result.batch);
      const updatedIds = result.confirmation?.updated_candidate_ids ?? confirmRecords.map((record) => record.candidate_id);
      onCommitted?.(Array.from(new Set(updatedIds)));
      setSelectedItemId(result.next_item_id
        ?? result.batch.items.find((item) => item.status === "awaiting_confirmation")?.item_id
        ?? selectedItem.item_id);
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "确认失败。");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  async function mutate(action: "skip" | "retry" | "cancelItem" | "cancel") {
    const stored = storedRef.current;
    if (!stored || pending || (action !== "cancel" && !selectedItem)) return;
    setPending(true);
    setError("");
    const controller = new AbortController();
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = controller;
    try {
      const next = action === "cancel"
        ? await attachmentBatchApi.cancel(stored.batchId, stored.batchToken, controller.signal)
        : action === "skip"
        ? await attachmentBatchApi.skip(stored.batchId, selectedItem!.item_id, stored.batchToken, controller.signal)
        : action === "retry"
        ? await attachmentBatchApi.retry(stored.batchId, selectedItem!.item_id, stored.batchToken, controller.signal)
        : await attachmentBatchApi.cancelItem(stored.batchId, selectedItem!.item_id, stored.batchToken, controller.signal);
      acceptBatch(next);
      if (action === "skip" || action === "cancelItem") {
        setSelectedItemId(next.items.find((item) => item.status === "awaiting_confirmation")?.item_id
          ?? next.items.find((item) => item.status === "failed")?.item_id
          ?? selectedItem!.item_id);
      }
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "批次操作失败。");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  function startNewBatch() {
    pollAbortRef.current?.abort();
    storedRef.current = null;
    writeStoredBatch(null);
    setBatch(null);
    setSelectedItemId(null);
    setSelections({});
    setError("");
  }

  if (!batch) {
    return (
      <div className={`attachment-batch-drop ${dragActive ? "is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }} onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void filesFromDrop(event.dataTransfer).then(upload).catch((dropError) => setError(dropError instanceof Error ? dropError.message : "无法读取拖放目录。"));
      }}>
        <input ref={filesRef} className="sr-only" type="file" accept={ACCEPT} multiple disabled={disabled || pending} onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
        <input ref={(node) => { folderRef.current = node; node?.setAttribute("webkitdirectory", ""); }} className="sr-only" type="file" multiple disabled={disabled || pending} onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
        {pending ? <LoaderCircle className="spin" size={25} /> : <UploadCloud size={25} />}
        <strong>{pending ? "正在创建持久批次" : "拖入文件或文件夹"}</strong>
        <span>PDF、Word、Excel、CSV、ZIP</span>
        <div>
          <button className="button secondary-button" type="button" disabled={disabled || pending} onClick={() => filesRef.current?.click()}><FileText size={15} />选择文件</button>
          <button className="button secondary-button" type="button" disabled={disabled || pending} onClick={() => folderRef.current?.click()}><FolderOpen size={15} />选择文件夹</button>
        </div>
        {error && <div className="attachment-error" role="alert"><AlertTriangle size={15} /><span>{error}</span>{lastFilesRef.current.length > 0 && <button className="button secondary-button" type="button" disabled={pending} onClick={() => void upload(lastFilesRef.current, true)}><RefreshCw size={14} />重试上传</button>}</div>}
      </div>
    );
  }

  const summary = batch.summary;
  const completedCount = summary.confirmed + summary.failed + summary.skipped + summary.cancelled;
  const computedProgress = batch.progress == null
    ? Math.round(completedCount / Math.max(1, summary.total) * 100)
    : Math.max(0, Math.min(100, Math.round(batch.progress * 100)));
  const canConfirm = Boolean(preview?.records.length && confirmRecords.length === preview.records.length);

  return (
    <div className="attachment-batch-workflow">
      <div className="attachment-batch-header">
        <div><strong>批次进度</strong><span>{completedCount} / {summary.total} 已处理</span></div>
        <div className="attachment-batch-header-actions">
          {!TERMINAL_BATCH_STATUSES.has(batch.status) && <button className="icon-button compact-icon-button" type="button" disabled={pending} onClick={() => void mutate("cancel")} aria-label="取消整个批次" title="取消批次"><Trash2 size={15} /></button>}
          <button className="icon-button compact-icon-button" type="button" disabled={pending} onClick={() => void refresh()} aria-label="刷新批次" title="刷新"><RefreshCw className={batchNeedsPolling(batch) ? "spin-slow" : ""} size={15} /></button>
          {TERMINAL_BATCH_STATUSES.has(batch.status) && <button className="button secondary-button" type="button" onClick={startNewBatch}><UploadCloud size={15} />新批次</button>}
        </div>
      </div>
      <div className="attachment-batch-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={computedProgress}><span style={{ width: `${computedProgress}%` }} /></div>
      <div className="attachment-batch-summary">
        <span>待确认 <strong>{summary.awaiting_confirmation}</strong></span>
        <span>已确认 <strong>{summary.confirmed}</strong></span>
        <span>失败 <strong>{summary.failed}</strong></span>
        <span>跳过 <strong>{summary.skipped}</strong></span>
      </div>
      {error && <div className="attachment-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button className="icon-button compact-icon-button" type="button" onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div>}

      <div className="attachment-batch-layout">
        <div className="attachment-batch-items" aria-label="批次文件">
          {batch.items.map((item) => <button className={`attachment-batch-item ${item.item_id === selectedItemId ? "is-active" : ""} is-${item.status}`} type="button" key={item.item_id} onClick={() => setSelectedItemId(item.item_id)}>
            <span className="attachment-batch-item-icon">{item.kind === "archive" ? <Archive size={16} /> : item.status === "confirmed" ? <CheckCircle2 size={16} /> : POLLING_STATUSES.has(item.status) ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}</span>
            <span><strong title={displayFilename(item)}>{displayFilename(item)}</strong><small>{STATUS_COPY[item.status] ?? item.status}{item.attempts > 1 ? ` · 第 ${item.attempts} 次` : ""}</small></span>
            {item.error && <AlertTriangle size={15} />}
          </button>)}
        </div>

        <div className="attachment-batch-detail">
          {!selectedItem ? <div className="attachment-batch-empty">批次中暂无文件</div> : POLLING_STATUSES.has(selectedItem.status) ? <div className="attachment-processing"><LoaderCircle className="spin" size={22} /><div><strong>{STATUS_COPY[selectedItem.status]}</strong><span>{displayFilename(selectedItem)}</span></div><button className="button secondary-button" type="button" disabled={pending} onClick={() => void mutate("cancelItem")}>取消此文件</button></div> : selectedItem.status === "failed" ? <div className="attachment-failure" role="alert"><AlertTriangle size={22} /><div><strong>{selectedItem.error?.code ?? "处理失败"}</strong><span>{selectedItem.error?.message ?? "文件未能完成处理。"}</span></div><div className="attachment-failure-actions"><button className="button secondary-button" type="button" disabled={pending || selectedItem.error?.retryable === false} onClick={() => void mutate("retry")}><RotateCcw size={15} />重试</button><button className="button secondary-button" type="button" disabled={pending} onClick={() => void mutate("skip")}><SkipForward size={15} />跳过</button></div></div> : selectedItem.status === "confirmed" ? <div className="attachment-complete"><CheckCircle2 size={24} /><div><strong>此文件已确认</strong><span>重复确认不会新增附件、活动或候选人更新。</span></div></div> : selectedItem.status === "skipped" || selectedItem.status === "cancelled" ? <div className="attachment-batch-empty">{STATUS_COPY[selectedItem.status]}</div> : preview ? <>
            <div className="attachment-preview-file"><FileText size={18} /><div><strong>{preview.file.original_filename}</strong><span>{preview.file.format.toUpperCase()} · {fileSize(preview.file.file_size)} · {preview.records.length} 条记录</span></div></div>
            <div className="attachment-record-list">
              {preview.records.map((record) => {
                const selection = selections[record.record_id] ?? { candidateId: "", fields: new Set<string>(), sections: new Set<string>() };
                const candidate = record.match.candidate?.id === selection.candidateId ? record.match.candidate : knownCandidates.find((item) => item.id === selection.candidateId);
                const duplicate = Boolean(selection.candidateId && duplicateCandidateIds.has(selection.candidateId));
                return <article className="attachment-record" key={record.record_id}>
                  <header><div><strong>{record.row_number ? `第 ${record.row_number} 行` : "简历记录"}</strong><span className="match-badge is-notice">{MATCH_COPY[record.match.status] ?? record.match.status}</span></div><small>{record.match.reason}</small></header>
                  <div className="attachment-identity-line"><span>手机：{record.identity.phone || "未提取"}</span><span>邮箱：{record.identity.email || "未提取"}</span></div>
                  <div className="attachment-match-fallback"><div><strong>{candidate ? `已选择 ${candidate.name}` : "需要确认候选人"}</strong><span>{candidate?.updated_at ? `档案更新时间 ${candidate.updated_at}` : "选择候选人后才能确认"}</span></div><button className="button secondary-button" type="button" onClick={() => setPickerRecordId(record.record_id)}><Search size={15} />选择候选人</button></div>
                  {duplicate && <div className="attachment-blocked"><AlertTriangle size={15} /><span>同一文件中的记录不能重复关联同一候选人。</span></div>}
                  {record.suggestions.length > 0 && <div className="attachment-diff-list"><h4>字段更新</h4>{record.suggestions.map((suggestion) => <label className={selection.fields.has(suggestion.field) ? "attachment-diff is-selected" : "attachment-diff"} key={suggestion.field}><input type="checkbox" checked={selection.fields.has(suggestion.field)} disabled={!selection.candidateId} onChange={() => updateSelection(record.record_id, (current) => { const fields = new Set(current.fields); if (fields.has(suggestion.field)) fields.delete(suggestion.field); else fields.add(suggestion.field); return { ...current, fields }; })} /><span className="attachment-diff-main"><span><strong>{suggestion.field}</strong><em className={`confidence is-${suggestion.confidence}`}>{suggestion.confidence}</em></span><small>{suggestion.evidence}</small></span></label>)}</div>}
                  {record.sections.length > 0 && <div className="attachment-section-suggestions"><h4>履历区块</h4>{record.sections.map((section) => <label className={selection.sections.has(section.section_id) ? "is-selected" : ""} key={section.section_id}><input type="checkbox" checked={selection.sections.has(section.section_id)} disabled={!selection.candidateId} onChange={() => updateSelection(record.record_id, (current) => { const sections = new Set(current.sections); if (sections.has(section.section_id)) sections.delete(section.section_id); else sections.add(section.section_id); return { ...current, sections }; })} /><span><strong>{section.title || section.section_type}</strong><small>{section.evidence}</small></span></label>)}</div>}
                </article>;
              })}
            </div>
            <div className="attachment-confirm-bar"><button className="button secondary-button" type="button" disabled={pending} onClick={() => void mutate("skip")}><SkipForward size={15} />跳过</button><button className="button primary-button" type="button" disabled={pending || !canConfirm} onClick={() => void confirmAndNext()}>{pending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}确认并处理下一条</button></div>
          </> : <div className="attachment-batch-empty">等待解析结果</div>}
        </div>
      </div>

      <CandidatePickerDialog
        open={Boolean(pickerRecord)}
        maxSelection={1}
        title="选择附件对应候选人"
        eyebrow="批次附件匹配"
        helperText="选择后仍需确认字段与履历区块"
        confirmLabel="选择"
        initialQuery={pickerRecord?.match.candidate?.name ?? ""}
        externalError={pickerError}
        onClose={() => { setPickerRecordId(null); setPickerError(""); }}
        onConfirm={(candidateIds) => void chooseCandidate(candidateIds)}
      />
    </div>
  );
}
