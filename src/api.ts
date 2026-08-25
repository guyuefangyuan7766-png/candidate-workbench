import type {
  Candidate,
  CandidateActivity,
  CandidateDraft,
  CandidateFilters,
  CandidateFacets,
  CandidateNote,
  CandidatePreferencesDraft,
  CandidateProfileSectionDraft,
  CandidateAttachment,
  CandidateAttachmentDeleteResult,
  AttachmentBatch,
  AttachmentBatchConfirmResponse,
  AttachmentConfirmRecord,
  AttachmentPreview,
  AgentMessagePagination,
  AgentTask,
  AgentSession,
  AgentSessionTurn,
  DashboardData,
  Pagination,
  Position,
  PositionDraft,
  PositionFilters,
  PositionFacets,
  ResumeSearchResponse,
  ResumeSearchIndexStatus,
  TalentPool,
} from "./types";

export interface CandidateDetail extends Candidate {
  notes: CandidateNote[];
  activities: CandidateActivity[];
}

export interface ListResponse<T> {
  items: T[];
  data: T[];
  pagination: Pagination;
}

export type ImportPositionAction =
  | "none"
  | "create"
  | "match"
  | "ambiguous"
  | "invalid"
  | "archived_conflict";

export interface ImportPositionValue {
  title?: string | null;
  external_code?: string | null;
  source_record_id?: string | null;
  source_system?: string | null;
  department?: string | null;
  location?: string | null;
  owner?: string | null;
}

export interface ImportPositionResolution {
  action: ImportPositionAction;
  reason: string;
  strategy?: string;
  match_count?: number;
  matched_position_ids?: string[];
  plan_key?: string;
  position_id?: string | null;
  position?: ImportPositionValue | null;
}

export interface ImportPreviewRow {
  row_number: number;
  candidate: Partial<Candidate>;
  candidate_source_id?: string | null;
  source_application_id?: string | null;
  position?: ImportPositionValue;
  position_resolution?: ImportPositionResolution | null;
  errors: { field?: string; message: string }[];
  duplicate: {
    type: "file" | "existing";
    id?: string;
    row_number?: number;
    matched_by?: string;
  } | null;
}

export interface ImportPreviewResponse {
  preview_token: string;
  expires_at: string;
  filename: string;
  sheet_name: string;
  headers: string[];
  mapping: Record<string, string>;
  unmapped_headers: string[];
  summary: {
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
    existing_duplicates: number;
    file_duplicates: number;
    candidate_records?: number;
    application_records?: number;
    position_records?: number;
    missing_identity_rows?: number;
    missing_candidate_id_rows?: number;
    missing_application_id_rows?: number;
    missing_position_id_rows?: number;
    skipped_application_rows?: number;
    skipped_position_rows?: number;
    position_link_count?: number;
  };
  rows: ImportPreviewRow[];
  preview_row_limit: number;
  profile?: "beisen_talent" | string;
  position_preview?: {
    create_count: number;
    match_count: number;
    ambiguous_count: number;
    invalid_count: number;
    archived_conflict_count: number;
    link_count: number;
    items: Array<{
      external_code: string | null;
      title: string | null;
      source_record_id?: string | null;
      source_system?: string | null;
      department?: string | null;
      location?: string | null;
      owner?: string | null;
      reason?: string | null;
      action: Exclude<ImportPositionAction, "none">;
      position_id?: string | null;
      match_count?: number;
      row_numbers: number[];
    }>;
  };
}

export interface CandidateImportConfig {
  max_file_size_bytes: number;
}

export interface ImportUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface ArchiveCandidatesResult {
  input_count: number;
  requested_count: number;
  duplicate_input_count: number;
  archived_count: number;
  archived_ids: string[];
}

export interface PermanentDeletePreview {
  preview_token: string;
  expires_at: string;
  candidate_count?: number;
  position_count?: number;
  affected_candidate_count?: number;
  impact: unknown;
}

export interface PermanentDeleteResult {
  deleted?: true;
  deleted_count?: number;
  candidate_id?: string;
  position_id?: string;
  candidate_ids?: string[];
  position_ids?: string[];
  deleted_at: string;
  audit_id?: string;
  audit_ids?: string[];
}

export interface ImportCommitResponse {
  import_batch_id: string;
  imported_rows: number;
  updated_rows: number;
  skipped_rows: number;
  failed_rows: number;
  failures: { row_number: number; errors: { field?: string; message: string }[] }[];
  candidate_count?: number;
  application_count?: number;
  position_count?: number;
  positions_created?: number;
  positions_matched?: number;
  links_created?: number;
  pools_created?: number;
}

/**
 * Durable import work is intentionally represented separately from the
 * preview/commit payloads.  The server may return either a task envelope
 * (202) or the legacy synchronous payload (2xx); the helpers below normalize
 * both shapes for callers.
 */
export type ImportOperation = "preview" | "commit";

export type ImportTaskStatus =
  | "queued"
  | "running"
  | "processing"
  | "completed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "canceled"
  | "timeout"
  | "timed_out"
  | "expired"
  | string;

export interface ImportTaskError {
  code?: string;
  message?: string;
  status?: number;
  retryable?: boolean;
  details?: unknown;
}

export interface ImportTask {
  task_id: string;
  operation?: ImportOperation | string;
  status: ImportTaskStatus;
  phase?: string | null;
  progress?: number | null;
  message?: string | null;
  poll_after_ms?: number | null;
  location?: string | null;
  client_request_id?: string | null;
  preview_token?: string | null;
  result?: unknown;
  error?: ImportTaskError | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
}

export interface ImportTaskEnvelope {
  task_id?: string;
  operation?: ImportOperation | string;
  status?: ImportTaskStatus;
  phase?: string | null;
  progress?: number | null;
  message?: string | null;
  poll_after_ms?: number | null;
  location?: string | null;
  client_request_id?: string | null;
  preview_token?: string | null;
  task?: Partial<ImportTask> | null;
  result?: unknown;
  preview?: ImportPreviewResponse | null;
  commit?: ImportCommitResponse | null;
  error?: ImportTaskError | null;
  data?: unknown;
}

export interface ImportTaskOptions {
  signal?: AbortSignal;
  /** Called for every durable task snapshot, including the initial 202. */
  onTask?: (task: ImportTask) => void;
  /** Override the idempotency key used when a request is retried/recovered. */
  clientRequestId?: string;
  /** Request timeout for the short task-creation HTTP call. */
  requestTimeoutMs?: number;
  /** Maximum time spent polling before returning a recoverable timeout. */
  maxWaitMs?: number;
}

export interface ImportTaskRecoveryRecord {
  taskId?: string;
  operation: ImportOperation;
  clientRequestId: string;
  location?: string;
  createdAt: number;
}

export interface ImportTaskWaitOptions extends ImportTaskOptions {
  operation: ImportOperation;
  location?: string;
  /** Internal seed used when a list/recovery response already contains a snapshot. */
  initialPayload?: unknown;
}

export interface TalentPoolDraft {
  name: string;
  description?: string;
  color?: string;
}

export interface TalentPoolFilters {
  page?: number;
  page_size?: number;
  search?: string;
  archived?: "exclude" | "include" | "only";
  sort?: "name" | "updated_at" | "candidate_count";
  order?: "asc" | "desc";
}

export interface TalentPoolLinkResult {
  input_count: number;
  linked_count: number;
  already_linked_count: number;
  linked_ids: string[];
}

export interface TalentPoolUnlinkResult {
  input_count: number;
  unlinked_count: number;
  not_linked_count: number;
  unlinked_ids: string[];
}

export interface VersionedEntityRecord {
  id: string;
  expected_updated_at: string;
}

export interface BatchStateUpdateResult<T> {
  updated_count: number;
  updated_ids: string[];
  items: T[];
}

export interface TalentPoolDeleteResult {
  deleted_count: number;
  deleted_ids: string[];
  affected_candidate_count: number;
  relation_count: number;
}

export interface AgentStatus {
  configured: boolean;
  model: string | null;
  read_only: true;
  tools: string[];
  missing: string[];
}

export interface LinkCandidatesResult {
  position_id: string;
  input_count: number;
  requested_count: number;
  duplicate_input_count: number;
  linked_count: number;
  existing_count: number;
  position: Position;
}

export interface UnlinkCandidatesResult {
  position_id: string;
  input_count: number;
  requested_count: number;
  duplicate_input_count: number;
  removed_count: number;
  existing_count: number;
  absent_count: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  timeoutMs?: number;
  onResponse?: (response: Response) => void;
}

function requestWithTimeout(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  const abortExternal = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", abortExternal, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abortExternal);
    },
  };
}

export async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const timeout = requestWithTimeout(init?.signal, Math.max(1_000, options.timeoutMs ?? 20_000));
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      signal: timeout.signal,
      headers,
    });
    options.onResponse?.(response);

    if (!response.ok) {
      type ErrorPayload = {
        error?: { code?: string; message?: string; details?: unknown };
      };
      let payload: ErrorPayload | null = null;
      try {
        payload = await response.json() as ErrorPayload;
      } catch (error) {
        // Invalid error JSON may fall back to the HTTP status, but an abort
        // while reading the body must still reach the timeout/recovery path.
        if (timeout.signal.aborted) throw error;
      }
      throw new ApiError(
        response.status,
        payload?.error?.code ?? "request_error",
        payload?.error?.message ?? `API ${response.status}: ${path}`,
        payload?.error?.details,
      );
    }

    if (response.status === 204) return undefined as T;
    // A task-acceptance response may legally carry only a Location header.
    // Read the body under the same timeout and treat an empty 2xx body as an
    // absent payload so the caller can derive the task id from Location.
    if (typeof response.text === "function") {
      const text = await response.text();
      return (text.trim() ? JSON.parse(text) : undefined) as T;
    }
    return await response.json() as T;
  } catch (error) {
    if (timeout.timedOut()) {
      throw new ApiError(408, "request_timeout", "请求暂时没有返回。", { path });
    }
    throw error;
  } finally {
    // Keep both the timeout and caller abort wired through the full response
    // body read. Receiving headers alone does not complete a request.
    timeout.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createImportClientRequestId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // Older embedded browsers may expose crypto without randomUUID.
  }
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function numericProgress(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeTaskError(value: unknown): ImportTaskError | null {
  if (!isRecord(value)) return null;
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(Number.isFinite(Number(value.status)) ? { status: Number(value.status) } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
  };
}

interface NormalizedImportTaskPayload {
  task: ImportTask;
  payload: unknown;
}

function normalizeImportTaskPayload(payload: unknown, fallbackTaskId?: string, fallbackLocation?: string): NormalizedImportTaskPayload | null {
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.task) ? payload.task : null;
  const taskIdValue = nested?.task_id ?? nested?.id ?? payload.task_id ?? payload.id ?? fallbackTaskId;
  if (typeof taskIdValue !== "string" || !taskIdValue.trim()) return null;
  const statusValue = nested?.status ?? payload.status ?? (payload.error ? "failed" : "queued");
  const task: ImportTask = {
    task_id: taskIdValue,
    operation: (nested?.operation ?? nested?.task_type ?? payload.operation ?? payload.task_type) as ImportOperation | string | undefined,
    status: typeof statusValue === "string" ? statusValue : String(statusValue),
    phase: (nested?.phase ?? payload.phase) as string | null | undefined,
    progress: numericProgress(nested?.progress ?? payload.progress),
    message: (nested?.message ?? payload.message) as string | null | undefined,
    poll_after_ms: Number.isFinite(Number(nested?.poll_after_ms ?? payload.poll_after_ms))
      ? Number(nested?.poll_after_ms ?? payload.poll_after_ms)
      : null,
    location: (nested?.location ?? payload.location ?? fallbackLocation) as string | null | undefined,
    client_request_id: (nested?.client_request_id ?? payload.client_request_id) as string | null | undefined,
    preview_token: (nested?.preview_token ?? payload.preview_token) as string | null | undefined,
    result: nested?.result ?? payload.result,
    error: normalizeTaskError(nested?.error ?? payload.error),
    created_at: (nested?.created_at ?? payload.created_at) as string | null | undefined,
    updated_at: (nested?.updated_at ?? payload.updated_at) as string | null | undefined,
    completed_at: (nested?.completed_at ?? payload.completed_at) as string | null | undefined,
  };
  return { task, payload };
}

function isImportPreviewPayload(value: unknown): value is ImportPreviewResponse {
  return isRecord(value)
    && typeof value.preview_token === "string"
    && Array.isArray(value.headers)
    && isRecord(value.summary)
    && Array.isArray(value.rows);
}

function isImportCommitPayload(value: unknown): value is ImportCommitResponse {
  return isRecord(value)
    && typeof value.import_batch_id === "string"
    && ["imported_rows", "updated_rows", "skipped_rows", "failed_rows"].some((key) => key in value);
}

function resultCandidates(payload: unknown, task: ImportTask): unknown[] {
  const values: unknown[] = [task.result];
  if (isRecord(payload)) {
    values.push(payload.result, payload.preview, payload.commit, payload.data);
    if (isRecord(payload.task)) {
      values.push(payload.task.result, payload.task.preview, payload.task.commit, payload.task.data);
    }
  }
  // Some workers wrap the useful result in one additional `result`/`data`
  // envelope.  Keep this bounded to avoid traversing candidate payloads.
  for (const value of [...values]) {
    if (!isRecord(value)) continue;
    values.push(value.preview, value.commit, value.result, value.data);
  }
  return values;
}

function extractImportResult(payload: unknown, task: ImportTask, operation: ImportOperation): ImportPreviewResponse | ImportCommitResponse | null {
  for (const candidate of resultCandidates(payload, task)) {
    if (operation === "preview" && isImportPreviewPayload(candidate)) return candidate;
    if (operation === "commit" && isImportCommitPayload(candidate)) return candidate;
  }
  return null;
}

function importTaskStatus(status: unknown): string {
  return String(status ?? "").trim().toLowerCase();
}

function isImportTaskTerminal(status: unknown): boolean {
  return new Set(["completed", "complete", "succeeded", "success", "ready", "preview_ready", "failed", "error", "cancelled", "canceled", "timeout", "timed_out", "expired"])
    .has(importTaskStatus(status));
}

function isTransientImportPollError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof ApiError) {
    return [0, 408, 425, 429].includes(error.status) || error.status >= 500;
  }
  return error instanceof TypeError;
}

function importTaskFailure(task: ImportTask, operation: ImportOperation): ApiError {
  const taskError = task.error;
  const status = Number.isFinite(Number(taskError?.status)) ? Number(taskError?.status) : 422;
  const code = taskError?.code ?? "import_task_failed";
  const message = taskError?.message
    ?? (isImportTaskTerminal(task.status) ? `Import ${operation} task failed (${task.status}).` : `Import ${operation} task did not complete.`);
  return new ApiError(status, code, message, {
    task_id: task.task_id,
    operation,
    phase: task.phase ?? null,
    status: task.status,
    client_request_id: task.client_request_id ?? null,
    ...(taskError?.details !== undefined ? { details: taskError.details } : {}),
  });
}

function waitForImportTaskDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function sameOriginTaskLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  if (raw.startsWith("/")) return raw;
  try {
    const parsed = new URL(raw, globalThis.location?.href ?? "http://localhost/");
    if (globalThis.location && parsed.origin !== globalThis.location.origin) return undefined;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

function importTaskPaths(taskId: string, location?: string): string[] {
  const encoded = encodeURIComponent(taskId);
  const paths = [
    sameOriginTaskLocation(location),
    `/api/candidates/import/tasks/${encoded}`,
    `/api/import/tasks/${encoded}`,
  ].filter((path): path is string => Boolean(path));
  return Array.from(new Set(paths));
}

function taskIdFromLocation(location?: string): string | undefined {
  const path = sameOriginTaskLocation(location);
  if (!path) return undefined;
  const match = path.match(/\/([^/?#]+)(?:[?#].*)?$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

interface FetchedImportTask {
  task: ImportTask;
  payload: unknown;
}

async function fetchImportTask(taskId: string, options: Pick<ImportTaskOptions, "signal" | "requestTimeoutMs"> & { location?: string } = {}): Promise<FetchedImportTask> {
  let lastError: unknown = null;
  for (const path of importTaskPaths(taskId, options.location)) {
    try {
      const payload = await request<unknown>(path, { signal: options.signal }, { timeoutMs: options.requestTimeoutMs ?? 12_000 });
      const normalized = normalizeImportTaskPayload(payload, taskId, path);
      if (normalized) return normalized;
      lastError = new ApiError(502, "import_task_invalid_response", "The import task response was invalid.", { task_id: taskId });
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new ApiError(404, "import_task_not_found", "The import task could not be found.", { task_id: taskId });
}

export async function getImportTask(taskId: string, options: Pick<ImportTaskOptions, "signal" | "requestTimeoutMs"> & { location?: string } = {}): Promise<ImportTask> {
  return (await fetchImportTask(taskId, options)).task;
}

export async function waitForImportTask(taskId: string, options: ImportTaskWaitOptions): Promise<ImportTask> {
  const operation = options.operation;
  const maxWaitMs = Math.max(5_000, options.maxWaitMs ?? 30 * 60 * 1000);
  const deadline = Date.now() + maxWaitMs;
  let location = options.location;
  let latest: ImportTask | null = null;
  let transientFailures = 0;
  let lastTransientError: ApiError | null = null;
  let first = true;
  while (Date.now() <= deadline) {
    const useInitialPayload = first && options.initialPayload !== undefined;
    first = false;
    let fetched: FetchedImportTask;
    try {
      fetched = useInitialPayload
        ? (() => {
            const normalized = normalizeImportTaskPayload(options.initialPayload, taskId, location);
            if (!normalized) throw new ApiError(502, "import_task_invalid_response", "The import task response was invalid.", { task_id: taskId });
            return normalized;
          })()
        : await fetchImportTask(taskId, { signal: options.signal, requestTimeoutMs: options.requestTimeoutMs, location });
      transientFailures = 0;
      lastTransientError = null;
    } catch (error) {
      if (!isTransientImportPollError(error)) throw error;
      transientFailures += 1;
      lastTransientError = error instanceof ApiError
        ? error
        : new ApiError(0, "network_error", "The import task status is temporarily unavailable.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const retryDelay = Math.min(5_000, 250 * (2 ** Math.min(transientFailures - 1, 4)));
      await waitForImportTaskDelay(Math.min(retryDelay, remaining), options.signal);
      continue;
    }
    const normalized = fetched;
    latest = normalized.task;
    location = latest.location ?? location;
    const extracted = extractImportResult(normalized.payload, latest, operation);
    if (extracted && latest.result === undefined) latest.result = extracted;
    options.onTask?.(latest);

    const status = importTaskStatus(latest.status);
    if (isImportTaskTerminal(status)) {
      if (["failed", "error", "cancelled", "canceled", "timeout", "timed_out", "expired"].includes(status)) {
        throw importTaskFailure(latest, operation);
      }
      if (!extractImportResult(normalized.payload, latest, operation) && latest.result === undefined) {
        throw new ApiError(502, "import_task_missing_result", "The import task completed without a result.", {
          task_id: taskId,
          operation,
          phase: latest.phase ?? null,
        });
      }
      return latest;
    }

    const requestedDelay = Number(latest.poll_after_ms);
    const delay = Number.isFinite(requestedDelay)
      ? Math.min(5_000, Math.max(250, requestedDelay))
      : 750;
    await waitForImportTaskDelay(Math.min(delay, Math.max(0, deadline - Date.now())), options.signal);
  }
  throw new ApiError(408, "import_task_poll_timeout", "The import is still running. You can resume status polling safely.", {
    task_id: taskId,
    operation,
    phase: latest?.phase ?? null,
    status: latest?.status ?? "unknown",
    client_request_id: latest?.client_request_id ?? options.clientRequestId ?? null,
    ...(lastTransientError ? {
      last_poll_error_code: lastTransientError.code,
      last_poll_error_status: lastTransientError.status,
    } : {}),
  });
}

/**
 * Recover a task after a lost creation response.  The server may expose either
 * list alias; a missing recovery endpoint is treated as "not found" so the
 * original request error can still be shown to the user.
 */
export async function recoverImportTask(clientRequestId: string, options: ImportTaskWaitOptions): Promise<ImportTask> {
  const query = `?client_request_id=${encodeURIComponent(clientRequestId)}`;
  let lastError: unknown = null;
  for (const path of [`/api/candidates/import/tasks${query}`, `/api/import/tasks${query}`]) {
    try {
      const payload = await request<unknown>(path, { signal: options.signal }, { timeoutMs: options.requestTimeoutMs ?? 12_000 });
      const candidates: unknown[] = isRecord(payload)
        ? [payload.task, payload, ...(Array.isArray(payload.items) ? payload.items : []), ...(Array.isArray(payload.tasks) ? payload.tasks : [])]
        : Array.isArray(payload) ? payload : [];
      const normalizedById = new Map<string, NormalizedImportTaskPayload>();
      candidates
        .map((item) => normalizeImportTaskPayload(item, undefined, undefined))
        .filter((item): item is NormalizedImportTaskPayload => Boolean(item))
        .forEach((item) => normalizedById.set(item.task.task_id, item));
      const normalizedCandidates = Array.from(normalizedById.values());
      const operationMatches = (item: NormalizedImportTaskPayload) => item.task.operation === options.operation;
      const exactMatch = normalizedCandidates.find((item) => (
        item.task.client_request_id === clientRequestId
        && operationMatches(item)
      ));
      const legacyMatch = normalizedCandidates.length === 1
        && !normalizedCandidates[0].task.client_request_id
        && operationMatches(normalizedCandidates[0])
        ? normalizedCandidates[0]
        : null;
      const match = exactMatch ?? legacyMatch;
      if (match) {
        return waitForImportTask(match.task.task_id, {
          ...options,
          clientRequestId,
          location: match.task.location ?? options.location,
          initialPayload: match.payload,
        });
      }
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
    }
  }
  throw new ApiError(404, "import_task_not_found", "No recoverable import task was found for this request.", {
    client_request_id: clientRequestId,
    operation: options.operation,
    ...(lastError instanceof ApiError ? { cause_code: lastError.code } : {}),
  });
}

interface UploadResponse<T> {
  payload: T | null;
  status: number;
  location?: string;
}

interface UploadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function uploadForm<T>(
  path: string,
  body: FormData,
  onProgress?: (progress: ImportUploadProgress) => void,
  options: UploadOptions = {},
): Promise<UploadResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.timeout = Math.max(30_000, options.timeoutMs ?? 15 * 60 * 1000);
    const abortExternal = () => xhr.abort();
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    options.signal?.addEventListener("abort", abortExternal, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", abortExternal);
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
      });
    });
    xhr.addEventListener("load", () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        cleanup();
        resolve({
          payload: payload as T | null,
          status: xhr.status,
          location: xhr.getResponseHeader("Location") ?? undefined,
        });
        return;
      }
      cleanup();
      const errorPayload = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
      reject(new ApiError(
        xhr.status,
        errorPayload?.error?.code ?? "request_error",
        errorPayload?.error?.message ?? `API ${xhr.status}: ${path}`,
        errorPayload?.error?.details,
      ));
    });
    xhr.addEventListener("error", () => reject(new ApiError(0, "network_error", "导入文件上传失败，请检查本机服务状态")));
    xhr.addEventListener("abort", () => reject(new DOMException("导入文件上传已取消", "AbortError")));
    xhr.addEventListener("error", cleanup);
    xhr.addEventListener("abort", cleanup);
    xhr.addEventListener("timeout", () => {
      cleanup();
      reject(new ApiError(408, "import_upload_timeout", "File upload timed out before the server accepted the task."));
    });
    xhr.send(body);
  });
}

function shouldRecoverImportCreation(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return !(error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 409, 425, 429].includes(error.status));
}

async function resolveImportTaskResponse<T extends ImportPreviewResponse | ImportCommitResponse>(
  payload: unknown,
  operation: ImportOperation,
  options: ImportTaskOptions,
  location?: string,
): Promise<T> {
  if (operation === "preview" && isImportPreviewPayload(payload)) return payload as T;
  if (operation === "commit" && isImportCommitPayload(payload)) return payload as T;

  const normalized = normalizeImportTaskPayload(
    payload ?? (taskIdFromLocation(location)
      ? { task_id: taskIdFromLocation(location), status: "queued", operation, location }
      : null),
    taskIdFromLocation(location),
    location,
  );
  if (!normalized) {
    throw new ApiError(502, "import_task_invalid_response", "The import service returned neither a result nor a task.", { operation });
  }
  if (!normalized.task.operation) normalized.task.operation = operation;
  if (!normalized.task.client_request_id && options.clientRequestId) {
    normalized.task.client_request_id = options.clientRequestId;
  }
  const task = await waitForImportTask(normalized.task.task_id, {
    ...options,
    operation,
    location: normalized.task.location ?? location,
    initialPayload: payload,
  });
  const result = task.result;
  if (operation === "preview" && isImportPreviewPayload(result)) return result as T;
  if (operation === "commit" && isImportCommitPayload(result)) return result as T;
  throw new ApiError(502, "import_task_missing_result", "The completed import task did not contain the expected result.", {
    task_id: task.task_id,
    operation,
    phase: task.phase ?? null,
  });
}

async function recoverImportResult<T extends ImportPreviewResponse | ImportCommitResponse>(
  originalError: unknown,
  operation: ImportOperation,
  clientRequestId: string,
  options: ImportTaskOptions,
): Promise<T> {
  if (!shouldRecoverImportCreation(originalError)) throw originalError;
  try {
    const task = await recoverImportTask(clientRequestId, {
      ...options,
      operation,
      clientRequestId,
    });
    const result = task.result;
    if (operation === "preview" && isImportPreviewPayload(result)) return result as T;
    if (operation === "commit" && isImportCommitPayload(result)) return result as T;
    throw new ApiError(502, "import_task_missing_result", "The recovered import task did not contain the expected result.", {
      task_id: task.task_id,
      operation,
    });
  } catch (recoveryError) {
    if (recoveryError instanceof ApiError && recoveryError.code === "import_task_not_found") throw originalError;
    throw recoveryError;
  }
}

function queryString<T extends object>(filters: T): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  const value = params.toString();
  return value ? `?${value}` : "";
}

function normalizePosition(position: Position): Position {
  return {
    ...position,
    department: position.department ?? "",
    location: position.location ?? "",
    owner: position.owner ?? "",
    description: position.description ?? "",
    headcount: Number(position.headcount ?? 1),
    candidate_count: Number(position.candidate_count ?? 0),
    tags: Array.isArray(position.tags) ? position.tags : [],
  };
}

function normalizeCandidate(candidate: Candidate): Candidate {
  const yearsExperience = candidate.years_experience == null || !Number.isFinite(Number(candidate.years_experience)) ? null : Number(candidate.years_experience);
  const yearsExperienceRaw = candidate.years_experience_raw ?? "";
  return {
    ...candidate,
    phone: candidate.phone ?? "",
    email: candidate.email ?? "",
    photo_url: candidate.photo_url ?? "",
    has_photo: Boolean(candidate.has_photo ?? candidate.photo_url),
    gender: candidate.gender ?? "",
    birth_date: candidate.birth_date ?? null,
    age: candidate.age == null || !Number.isFinite(Number(candidate.age)) ? null : Number(candidate.age),
    current_company: candidate.current_company ?? "",
    current_title: candidate.current_title ?? "",
    location: candidate.location ?? "",
    years_experience: yearsExperience,
    years_experience_raw: yearsExperienceRaw,
    years_experience_display: candidate.years_experience_display || yearsExperienceRaw || (yearsExperience === null ? "" : String(yearsExperience)),
    education: candidate.education ?? "",
    highest_school: candidate.highest_school ?? "",
    highest_major: candidate.highest_major ?? "",
    job_seeking_status: candidate.job_seeking_status ?? "",
    hire_position: candidate.hire_position ?? "",
    hire_status: candidate.hire_status ?? "",
    hire_date: candidate.hire_date ?? null,
    resume_updated_at: candidate.resume_updated_at ?? null,
    self_summary: candidate.self_summary ?? "",
    source: candidate.source ?? "",
    owner: candidate.owner ?? "",
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    expected_salary: candidate.expected_salary ?? "",
    source_system: candidate.source_system ?? "",
    source_record_id: candidate.source_record_id ?? "",
    positions: Array.isArray(candidate.positions) ? candidate.positions.map(normalizePosition) : [],
    talent_pools: Array.isArray(candidate.talent_pools) ? candidate.talent_pools.map(normalizeTalentPool) : [],
    profile_sections: Array.isArray(candidate.profile_sections) ? candidate.profile_sections : [],
    preferences: candidate.preferences
      ? {
          ...candidate.preferences,
          employment_status: candidate.preferences.employment_status ?? "",
          desired_titles: Array.isArray(candidate.preferences.desired_titles) ? candidate.preferences.desired_titles : [],
          desired_locations: Array.isArray(candidate.preferences.desired_locations) ? candidate.preferences.desired_locations : [],
          employment_type: candidate.preferences.employment_type ?? "",
          expected_salary: candidate.preferences.expected_salary ?? "",
          availability: candidate.preferences.availability ?? "",
        }
      : null,
    source_records: Array.isArray(candidate.source_records) ? candidate.source_records : [],
    assessments: Array.isArray(candidate.assessments) ? candidate.assessments : [],
    consents: Array.isArray(candidate.consents) ? candidate.consents : [],
    position_sources: Array.isArray(candidate.position_sources) ? candidate.position_sources : [],
  };
}

function normalizeTalentPool(pool: TalentPool): TalentPool {
  return {
    ...pool,
    description: pool.description ?? "",
    color: pool.color ?? "#176b54",
    candidate_count: Number(pool.candidate_count ?? 0),
    archived_at: pool.archived_at ?? null,
  };
}

function normalizeCandidateList(payload: ListResponse<Candidate>): ListResponse<Candidate> {
  const items = (payload.items ?? payload.data ?? []).map(normalizeCandidate);
  return { ...payload, items, data: items };
}

function normalizePositionList(payload: ListResponse<Position>): ListResponse<Position> {
  const items = (payload.items ?? payload.data ?? []).map(normalizePosition);
  return { ...payload, items, data: items };
}

export type CandidateWorkYearsInput = string | number | null;

export type CandidateCreatePayload = Omit<CandidateDraft, "preferences" | "stage" | "expected_salary" | "years_experience"> & {
  years_experience: CandidateWorkYearsInput;
  source_system?: string;
  source_record_id?: string;
};

export type CandidateUpdatePayload = Partial<Omit<CandidateDraft, "preferences" | "years_experience">> & {
  years_experience?: CandidateWorkYearsInput;
};

export const candidateApi = {
  async list(filters: CandidateFilters = {}, signal?: AbortSignal) {
    const payload = await request<ListResponse<Candidate>>(
      `/api/candidates${queryString(filters)}`,
      { signal },
    );
    return normalizeCandidateList(payload);
  },

  facets(filters: Pick<CandidateFilters, "archived"> = {}, signal?: AbortSignal) {
    return request<CandidateFacets>(`/api/candidates/facets${queryString(filters)}`, { signal });
  },

  async get(id: string, includeSensitive = false) {
    const detail = await request<CandidateDetail>(
      `/api/candidates/${encodeURIComponent(id)}${includeSensitive ? "?include_sensitive=true" : ""}`,
    );
    return {
      ...normalizeCandidate(detail),
      notes: detail.notes ?? [],
      activities: detail.activities ?? [],
    } as CandidateDetail;
  },

  async create(candidate: CandidateCreatePayload) {
    return normalizeCandidate(await request<Candidate>("/api/candidates", {
      method: "POST",
      body: JSON.stringify(candidate),
    }));
  },

  async update(id: string, patch: CandidateUpdatePayload) {
    return normalizeCandidate(await request<Candidate>(`/api/candidates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }));
  },

  async archive(id: string) {
    return normalizeCandidate(await request<Candidate>(`/api/candidates/${encodeURIComponent(id)}/archive`, {
      method: "POST",
    }));
  },

  archiveMany(candidateIds: string[]) {
    return request<ArchiveCandidatesResult>("/api/candidates/archive-batch", {
      method: "POST",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    });
  },

  async restore(id: string) {
    return normalizeCandidate(await request<Candidate>(`/api/candidates/${encodeURIComponent(id)}/restore`, {
      method: "POST",
    }));
  },

  previewPermanentDelete(candidateIds: string[]) {
    return request<PermanentDeletePreview>("/api/candidates/permanent-delete/preview", {
      method: "POST",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    });
  },

  commitPermanentDelete(previewToken: string) {
    return request<PermanentDeleteResult>("/api/candidates/permanent-delete/commit", {
      method: "POST",
      body: JSON.stringify({ preview_token: previewToken }),
    });
  },

  addNote(id: string, content: string) {
    return request<CandidateNote>(`/api/candidates/${encodeURIComponent(id)}/notes`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  },

  updatePreferences(id: string, preferences: CandidatePreferencesDraft) {
    return request<NonNullable<Candidate["preferences"]>>(
      `/api/candidates/${encodeURIComponent(id)}/preferences`,
      {
        method: "PUT",
        body: JSON.stringify(preferences ?? {}),
      },
    );
  },

  replaceProfileSections(id: string, sections: CandidateProfileSectionDraft[]) {
    return request<{ data: CandidateProfileSectionDraft[] }>(
      `/api/candidates/${encodeURIComponent(id)}/profile-sections`,
      {
        method: "PUT",
        body: JSON.stringify({ sections: Array.isArray(sections) ? sections : [] }),
      },
    );
  },

  getImportConfig() {
    return request<CandidateImportConfig>("/api/candidates/import/config");
  },

  async previewImport(
    file: File,
    mapping?: Record<string, string>,
    onProgress?: (progress: ImportUploadProgress) => void,
    options: ImportTaskOptions = {},
  ) {
    const clientRequestId = options.clientRequestId ?? createImportClientRequestId();
    const body = new FormData();
    body.append("file", file);
    if (mapping) body.append("mapping", JSON.stringify(mapping));
    body.append("client_request_id", clientRequestId);
    let response: UploadResponse<unknown>;
    try {
      response = await uploadForm<unknown>("/api/candidates/import/preview", body, onProgress, {
        signal: options.signal,
        timeoutMs: options.requestTimeoutMs,
      });
    } catch (error) {
      return recoverImportResult<ImportPreviewResponse>(error, "preview", clientRequestId, options);
    }
    return resolveImportTaskResponse<ImportPreviewResponse>(response.payload, "preview", {
      ...options,
      clientRequestId,
    }, response.location);
  },

  async commitImport(previewToken: string, options: ImportTaskOptions = {}) {
    const clientRequestId = options.clientRequestId ?? createImportClientRequestId();
    let payload: unknown;
    let creationLocation: string | undefined;
    try {
      payload = await request<unknown>("/api/candidates/import/commit", {
        method: "POST",
        signal: options.signal,
        headers: { "Idempotency-Key": clientRequestId },
        body: JSON.stringify({
          preview_token: previewToken,
          on_duplicate: "skip",
          client_request_id: clientRequestId,
        }),
      }, {
        timeoutMs: options.requestTimeoutMs ?? 20_000,
        onResponse: (response) => { creationLocation = response.headers.get("Location") ?? undefined; },
      });
    } catch (error) {
      return recoverImportResult<ImportCommitResponse>(error, "commit", clientRequestId, options);
    }
    return resolveImportTaskResponse<ImportCommitResponse>(payload, "commit", {
      ...options,
      clientRequestId,
    }, creationLocation);
  },

  resumeImportTask(taskId: string, operation: ImportOperation, options: ImportTaskOptions = {}) {
    return waitForImportTask(taskId, { ...options, operation }).then((task) => {
      const result = task.result;
      if (operation === "preview" && isImportPreviewPayload(result)) return result;
      if (operation === "commit" && isImportCommitPayload(result)) return result;
      throw new ApiError(502, "import_task_missing_result", "The completed import task did not contain the expected result.", {
        task_id: task.task_id,
        operation,
      });
    });
  },

  recoverImportTask(clientRequestId: string, operation: ImportOperation, options: ImportTaskOptions = {}) {
    return recoverImportTask(clientRequestId, {
      ...options,
      operation,
      clientRequestId,
    }).then((task) => {
      const result = task.result;
      if (operation === "preview" && isImportPreviewPayload(result)) return result;
      if (operation === "commit" && isImportCommitPayload(result)) return result;
      throw new ApiError(502, "import_task_missing_result", "The recovered import task did not contain the expected result.", {
        task_id: task.task_id,
        operation,
      });
    });
  },

  async cancelImportTask(taskId: string, options: ImportTaskOptions = {}) {
    let lastError: unknown = null;
    for (const path of importTaskPaths(taskId, undefined)) {
      try {
        const payload = await request<unknown>(`${path}/cancel`, {
          method: "POST",
          signal: options.signal,
        }, { timeoutMs: options.requestTimeoutMs ?? 12_000 });
        const normalized = normalizeImportTaskPayload(payload, taskId, path);
        if (!normalized) {
          throw new ApiError(502, "import_task_invalid_response", "The import cancellation response was invalid.", { task_id: taskId });
        }
        options.onTask?.(normalized.task);
        return normalized.task;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new ApiError(404, "import_task_not_found", "The import task could not be found.", { task_id: taskId });
  },
};

export const talentPoolApi = {
  async list(filters: TalentPoolFilters = {}, signal?: AbortSignal) {
    const payload = await request<ListResponse<TalentPool>>(
      `/api/talent-pools${queryString(filters)}`,
      { signal },
    );
    const items = (payload.items ?? payload.data ?? []).map(normalizeTalentPool);
    return { ...payload, items, data: items };
  },

  async listAll(filters: TalentPoolFilters = {}, signal?: AbortSignal): Promise<TalentPool[]> {
    const pools: TalentPool[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const payload = await this.list({ ...filters, page, page_size: 100 }, signal);
      pools.push(...payload.items);
      totalPages = payload.pagination.total_pages;
      page += 1;
    } while (page <= totalPages);
    return pools;
  },

  async get(id: string) {
    return normalizeTalentPool(await request<TalentPool>(`/api/talent-pools/${encodeURIComponent(id)}`));
  },

  async create(draft: TalentPoolDraft) {
    return normalizeTalentPool(await request<TalentPool>("/api/talent-pools", {
      method: "POST",
      body: JSON.stringify(draft),
    }));
  },

  async update(id: string, patch: Partial<TalentPoolDraft>) {
    return normalizeTalentPool(await request<TalentPool>(`/api/talent-pools/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }));
  },

  async archive(id: string, expectedUpdatedAt?: string) {
    return normalizeTalentPool(await request<TalentPool>(`/api/talent-pools/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: expectedUpdatedAt ? JSON.stringify({ expected_updated_at: expectedUpdatedAt }) : undefined,
    }));
  },

  async restore(id: string, expectedUpdatedAt?: string) {
    return normalizeTalentPool(await request<TalentPool>(`/api/talent-pools/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: expectedUpdatedAt ? JSON.stringify({ expected_updated_at: expectedUpdatedAt }) : undefined,
    }));
  },

  async archiveBatch(records: VersionedEntityRecord[]) {
    const result = await request<BatchStateUpdateResult<TalentPool>>("/api/talent-pools/archive-batch", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    return { ...result, items: result.items.map(normalizeTalentPool) };
  },

  async restoreBatch(records: VersionedEntityRecord[]) {
    const result = await request<BatchStateUpdateResult<TalentPool>>("/api/talent-pools/restore-batch", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    return { ...result, items: result.items.map(normalizeTalentPool) };
  },

  permanentDelete(id: string, expectedUpdatedAt: string) {
    return request<TalentPoolDeleteResult>(`/api/talent-pools/${encodeURIComponent(id)}/permanent-delete`, {
      method: "POST",
      body: JSON.stringify({ expected_updated_at: expectedUpdatedAt }),
    });
  },

  permanentDeleteBatch(records: VersionedEntityRecord[]) {
    return request<TalentPoolDeleteResult>("/api/talent-pools/permanent-delete-batch", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
  },

  async candidates(id: string, filters: CandidateFilters = {}, signal?: AbortSignal) {
    const payload = await request<ListResponse<Candidate>>(
      `/api/talent-pools/${encodeURIComponent(id)}/candidates${queryString(filters)}`,
      { signal },
    );
    return normalizeCandidateList(payload);
  },

  linkCandidates(id: string, candidateIds: string[]) {
    return request<TalentPoolLinkResult>(`/api/talent-pools/${encodeURIComponent(id)}/candidates`, {
      method: "POST",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    });
  },

  unlinkCandidates(id: string, candidateIds: string[]) {
    return request<TalentPoolUnlinkResult>(`/api/talent-pools/${encodeURIComponent(id)}/candidates`, {
      method: "DELETE",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    });
  },
};

export const positionApi = {
  async list(filters: PositionFilters = {}, signal?: AbortSignal) {
    return normalizePositionList(await request<ListResponse<Position>>(
      `/api/positions${queryString(filters)}`,
      { signal },
    ));
  },

  async listAll(filters: PositionFilters = {}, signal?: AbortSignal): Promise<Position[]> {
    const positions: Position[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const payload = await this.list({ ...filters, page, page_size: 100 }, signal);
      positions.push(...payload.items);
      totalPages = payload.pagination.total_pages;
      page += 1;
    } while (page <= totalPages);
    return positions;
  },

  facets(filters: Pick<PositionFilters, "archived"> = {}, signal?: AbortSignal) {
    return request<PositionFacets>(`/api/positions/facets${queryString(filters)}`, { signal });
  },

  async get(id: string) {
    return normalizePosition(await request<Position>(`/api/positions/${encodeURIComponent(id)}`));
  },

  async create(draft: PositionDraft) {
    return normalizePosition(await request<Position>("/api/positions", {
      method: "POST",
      body: JSON.stringify(draft),
    }));
  },

  async update(id: string, patch: Partial<PositionDraft>) {
    return normalizePosition(await request<Position>(`/api/positions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }));
  },

  async archive(id: string) {
    return normalizePosition(await request<Position>(`/api/positions/${encodeURIComponent(id)}/archive`, {
      method: "POST",
    }));
  },

  async archiveBatch(records: VersionedEntityRecord[]) {
    const result = await request<BatchStateUpdateResult<Position>>("/api/positions/archive-batch", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    return { ...result, items: result.items.map(normalizePosition) };
  },

  async restore(id: string) {
    return normalizePosition(await request<Position>(`/api/positions/${encodeURIComponent(id)}/restore`, {
      method: "POST",
    }));
  },

  previewPermanentDelete(positionIds: string[]) {
    return request<PermanentDeletePreview>("/api/positions/permanent-delete/preview", {
      method: "POST",
      body: JSON.stringify({ position_ids: positionIds }),
    });
  },

  commitPermanentDelete(previewToken: string) {
    return request<PermanentDeleteResult>("/api/positions/permanent-delete/commit", {
      method: "POST",
      body: JSON.stringify({ preview_token: previewToken }),
    });
  },

  async candidates(id: string, filters: CandidateFilters = {}, signal?: AbortSignal) {
    return normalizeCandidateList(await request<ListResponse<Candidate>>(
      `/api/positions/${encodeURIComponent(id)}/candidates${queryString(filters)}`,
      { signal },
    ));
  },

  linkCandidates(id: string, candidateIds: string[]) {
    return request<LinkCandidatesResult>(`/api/positions/${encodeURIComponent(id)}/candidates`, {
      method: "POST",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    });
  },

  unlinkCandidate(id: string, candidateId: string) {
    return request<{ position_id: string; candidate_id: string; removed: boolean }>(
      `/api/positions/${encodeURIComponent(id)}/candidates/${encodeURIComponent(candidateId)}`,
      { method: "DELETE" },
    );
  },

  unlinkCandidates(id: string, candidateIds: string[]) {
    return request<UnlinkCandidatesResult>(`/api/positions/${encodeURIComponent(id)}/candidates`, {
      method: "DELETE",
      body: JSON.stringify({ candidate_ids: candidateIds }),
    });
  },
};

export function candidateExportUrl(format: "xlsx" | "csv", filters: CandidateFilters = {}) {
  return `/api/candidates/export${queryString({ format, ...filters })}`;
}

export function getDashboard(signal?: AbortSignal) {
  return request<DashboardData>("/api/dashboard", { signal }).then((data) => ({
    ...data,
    recent_candidates: (data.recent_candidates ?? []).map(normalizeCandidate),
    recent_positions: (data.recent_positions ?? []).map(normalizePosition),
  }));
}

export function getAgentStatus(signal?: AbortSignal) {
  return request<AgentStatus>("/api/agent/status", { signal });
}

export async function askReadOnlyAgent(message: string): Promise<string> {
  const response = await request<{ answer: string }>("/api/agent/query", {
    method: "POST",
    body: JSON.stringify({ message, mode: "read_only" }),
  });
  return response.answer;
}

export interface AgentSessionListResponse {
  items: AgentSession[];
  pagination: Pagination;
}

export interface AgentMessageListResponse {
  items: import("./types").AgentMessage[];
  pagination: AgentMessagePagination;
}

export interface AgentTaskListResponse {
  items?: AgentTask[];
  tasks?: AgentTask[];
}

type AgentTaskEnvelope = AgentTask | {
  task?: AgentTask | null;
  data?: AgentTask | null;
  user_message?: import("./types").AgentMessage | null;
  assistant_message?: import("./types").AgentMessage | null;
};

// V9 normally returns an accepted durable task inside its 1s synchronous
// window. Keep a longer compatibility window for a saturated or older service;
// task completion itself is monitored separately until a terminal state.
const AGENT_SEND_TIMEOUT_MS = 15_000;
const AGENT_TASK_REQUEST_TIMEOUT_MS = 20_000;

function unwrapAgentTask(payload: AgentTaskEnvelope): AgentTask {
  if ("task" in payload && payload.task) {
    return {
      ...payload.task,
      ...(payload.user_message && !payload.task.user_message ? { user_message: payload.user_message } : {}),
      ...(payload.assistant_message && !payload.task.assistant_message ? { assistant_message: payload.assistant_message } : {}),
    };
  }
  if ("data" in payload && payload.data) {
    return {
      ...payload.data,
      ...(payload.user_message && !payload.data.user_message ? { user_message: payload.user_message } : {}),
      ...(payload.assistant_message && !payload.data.assistant_message ? { assistant_message: payload.assistant_message } : {}),
    };
  }
  return payload as AgentTask;
}

export const agentSessionApi = {
  create(title?: string) {
    return request<AgentSession>("/api/agent/sessions", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    });
  },

  list(page = 1, pageSize = 20, signal?: AbortSignal) {
    return request<AgentSessionListResponse>(
      `/api/agent/sessions${queryString({ page, page_size: pageSize, status: "active" })}`,
      { signal },
    );
  },

  get(id: string, signal?: AbortSignal) {
    return request<AgentSession>(`/api/agent/sessions/${encodeURIComponent(id)}`, { signal }, { timeoutMs: 10_000 });
  },

  update(id: string, patch: { title?: string; status?: "active" | "archived" }) {
    return request<AgentSession>(`/api/agent/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  delete(id: string) {
    return request<{ deleted: true; session_id: string }>(`/api/agent/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  messages(id: string, beforeSequence?: number | null, pageSize = 50, signal?: AbortSignal) {
    return request<AgentMessageListResponse>(
      `/api/agent/sessions/${encodeURIComponent(id)}/messages${queryString({
        page_size: pageSize,
        before_sequence: beforeSequence ?? undefined,
      })}`,
      { signal },
    );
  },

  send(id: string, message: string, clientRequestId: string, signal?: AbortSignal) {
    return request<AgentSessionTurn>(`/api/agent/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ message, client_request_id: clientRequestId }),
      signal,
    }, { timeoutMs: AGENT_SEND_TIMEOUT_MS });
  },
};

export const agentTaskApi = {
  get(taskId: string, signal?: AbortSignal) {
    return request<AgentTaskEnvelope>(`/api/agent/tasks/${encodeURIComponent(taskId)}`, { signal }, { timeoutMs: AGENT_TASK_REQUEST_TIMEOUT_MS }).then(unwrapAgentTask);
  },

  sessionTasks(sessionId: string, signal?: AbortSignal) {
    return request<AgentTaskListResponse | AgentTask[]>(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?recoverable=1`,
      { signal },
      { timeoutMs: AGENT_TASK_REQUEST_TIMEOUT_MS },
    ).then((payload) => Array.isArray(payload) ? { items: payload } : { items: payload.items ?? payload.tasks ?? [] });
  },

  cancel(taskId: string, signal?: AbortSignal) {
    return request<AgentTaskEnvelope>(`/api/agent/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      signal,
    }, { timeoutMs: 10_000 }).then(unwrapAgentTask);
  },

  retryAnswer(taskId: string, signal?: AbortSignal) {
    return request<AgentTaskEnvelope>(`/api/agent/tasks/${encodeURIComponent(taskId)}/retry-answer`, {
      method: "POST",
      signal,
    }, { timeoutMs: 20_000 }).then(unwrapAgentTask);
  },
};

export interface AttachmentConfirmResponse {
  attachment_ids?: string[];
  attachments?: CandidateAttachment[];
  updated_candidate_ids?: string[];
  committed_records?: number;
}

const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;
const ATTACHMENT_STATUS_TIMEOUT_MS = 15_000;
const ATTACHMENT_MUTATION_TIMEOUT_MS = 30_000;

async function attachmentRequest<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  try {
    return await request<T>(path, init, { timeoutMs });
  } catch (error) {
    if (error instanceof ApiError && error.code === "request_timeout") {
      throw new ApiError(408, "attachment_request_timeout", timeoutMessage, { path });
    }
    if (error instanceof TypeError) {
      throw new ApiError(0, "attachment_network_error", "无法连接附件服务，请检查本机服务后重试。", { path });
    }
    throw error;
  }
}

export const attachmentApi = {
  createPreview(file: File, candidateId?: string) {
    const body = new FormData();
    body.append("file", file);
    if (candidateId) body.append("candidate_id", candidateId);
    return attachmentRequest<AttachmentPreview>(
      "/api/attachments/previews",
      { method: "POST", body },
      ATTACHMENT_UPLOAD_TIMEOUT_MS,
      "附件上传未得到服务确认，请检查服务状态后重试。",
    );
  },

  getPreview(previewId: string, previewToken: string, signal?: AbortSignal) {
    return attachmentRequest<AttachmentPreview>(
      `/api/attachments/previews/${encodeURIComponent(previewId)}`,
      { signal, headers: { "X-Attachment-Preview-Token": previewToken } },
      ATTACHMENT_STATUS_TIMEOUT_MS,
      "附件解析状态获取超时，稍后可继续获取。",
    );
  },

  deletePreview(previewId: string, previewToken: string) {
    return attachmentRequest<void>(
      `/api/attachments/previews/${encodeURIComponent(previewId)}`,
      { method: "DELETE", headers: { "X-Attachment-Preview-Token": previewToken } },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "临时附件清理超时，请稍后重试。",
    );
  },

  async createCandidate(
    previewId: string,
    previewToken: string,
    recordId: string,
    candidate: CandidateCreatePayload,
    profileSections: CandidateProfileSectionDraft[] = [],
    includeAvatar = true,
  ) {
    return normalizeCandidate(await attachmentRequest<Candidate>(
      `/api/attachments/previews/${encodeURIComponent(previewId)}/candidates`,
      {
        method: "POST",
        body: JSON.stringify({
          preview_token: previewToken,
          record_id: recordId,
          candidate,
          profile_sections: profileSections,
          include_avatar: includeAvatar,
        }),
      },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "候选人创建请求超时；重新提交会复用同一附件记录，不会重复创建。",
    ));
  },

  confirmPreview(previewId: string, previewToken: string, records: AttachmentConfirmRecord[]) {
    return attachmentRequest<AttachmentConfirmResponse>(
      `/api/attachments/previews/${encodeURIComponent(previewId)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ preview_token: previewToken, records }),
      },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "附件确认请求超时，请刷新候选人状态后再重试。",
    );
  },

  listForCandidate(candidateId: string) {
    return request<{ items?: CandidateAttachment[]; data?: CandidateAttachment[] } | CandidateAttachment[]>(
      `/api/candidates/${encodeURIComponent(candidateId)}/attachments`,
    ).then((payload) => Array.isArray(payload) ? payload : payload.items ?? payload.data ?? []);
  },

  deleteAttachment(attachmentId: string) {
    return attachmentRequest<CandidateAttachmentDeleteResult>(
      `/api/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "附件删除请求超时，请刷新附件列表确认状态后再重试。",
    );
  },

  downloadUrl(attachment: Pick<CandidateAttachment, "id" | "download_url">) {
    return attachment.download_url || `/api/attachments/${encodeURIComponent(attachment.id)}/download`;
  },
};

const ATTACHMENT_BATCH_UPLOAD_TIMEOUT_MS = 120_000;

function attachmentBatchHeaders(batchToken: string, idempotencyKey?: string) {
  const headers = new Headers({ "X-Attachment-Batch-Token": batchToken });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return headers;
}

export const attachmentBatchApi = {
  create(
    files: File[],
    batchToken: string,
    idempotencyKey: string,
    candidateId?: string,
    signal?: AbortSignal,
  ) {
    const body = new FormData();
    files.forEach((file) => {
      const relativeName = file.webkitRelativePath || file.name;
      body.append("files", file, relativeName);
    });
    if (candidateId) body.append("candidate_id", candidateId);
    return attachmentRequest<AttachmentBatch>(
      "/api/attachment-batches",
      {
        method: "POST",
        body,
        signal,
        headers: attachmentBatchHeaders(batchToken, idempotencyKey),
      },
      ATTACHMENT_BATCH_UPLOAD_TIMEOUT_MS,
      "批次上传尚未得到服务确认。请保留当前页面并重试，幂等键会避免重复批次。",
    );
  },

  get(batchId: string, batchToken: string, signal?: AbortSignal) {
    return attachmentRequest<AttachmentBatch>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}`,
      { signal, headers: attachmentBatchHeaders(batchToken) },
      ATTACHMENT_STATUS_TIMEOUT_MS,
      "批次状态暂时不可用，后台处理仍会继续。",
    );
  },

  async createCandidate(
    batchId: string,
    itemId: string,
    batchToken: string,
    recordId: string,
    candidate: CandidateCreatePayload,
    profileSections: CandidateProfileSectionDraft[] = [],
    includeAvatar = true,
  ) {
    return normalizeCandidate(await attachmentRequest<Candidate>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/candidates`,
      {
        method: "POST",
        headers: attachmentBatchHeaders(batchToken),
        body: JSON.stringify({
          record_id: recordId,
          candidate,
          profile_sections: profileSections,
          include_avatar: includeAvatar,
        }),
      },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "候选人创建请求超时；重新提交会复用同一附件记录，不会重复创建。",
    ));
  },

  confirm(
    batchId: string,
    itemId: string,
    batchToken: string,
    idempotencyKey: string,
    records: AttachmentConfirmRecord[],
    previewToken?: string,
    signal?: AbortSignal,
  ) {
    return attachmentRequest<AttachmentBatchConfirmResponse>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/confirm`,
      {
        method: "POST",
        signal,
        headers: attachmentBatchHeaders(batchToken, idempotencyKey),
        body: JSON.stringify({ records, preview_token: previewToken }),
      },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "确认结果暂时未知。再次提交会使用同一幂等键，不会重复写入。",
    );
  },

  skip(batchId: string, itemId: string, batchToken: string, signal?: AbortSignal) {
    return attachmentRequest<AttachmentBatch>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/skip`,
      { method: "POST", signal, headers: attachmentBatchHeaders(batchToken) },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "跳过操作暂时未确认，请刷新批次状态。",
    );
  },

  retry(batchId: string, itemId: string, batchToken: string, signal?: AbortSignal) {
    return attachmentRequest<AttachmentBatch>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retry`,
      { method: "POST", signal, headers: attachmentBatchHeaders(batchToken) },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "重试请求暂时未确认，请刷新批次状态。",
    );
  },

  cancelItem(batchId: string, itemId: string, batchToken: string, signal?: AbortSignal) {
    return attachmentRequest<AttachmentBatch>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/cancel`,
      { method: "POST", signal, headers: attachmentBatchHeaders(batchToken) },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "取消请求暂时未确认，请刷新批次状态。",
    );
  },

  cancel(batchId: string, batchToken: string, signal?: AbortSignal) {
    return attachmentRequest<AttachmentBatch>(
      `/api/attachment-batches/${encodeURIComponent(batchId)}/cancel`,
      { method: "POST", signal, headers: attachmentBatchHeaders(batchToken) },
      ATTACHMENT_MUTATION_TIMEOUT_MS,
      "批次取消请求暂时未确认，请刷新批次状态。",
    );
  },
};

export interface ResumeSearchFilters {
  archived?: "exclude" | "include" | "only";
  fields?: "title" | "content";
  source_types?: "candidate" | "profile_section" | "attachment";
  position_id?: string;
  talent_pool_id?: string;
}

export function getResumeSearchStatus(signal?: AbortSignal) {
  return request<ResumeSearchIndexStatus>("/api/resume-search/status", { signal });
}

export function searchCandidateResumes(
  query: string,
  page = 1,
  pageSize = 20,
  signal?: AbortSignal,
  filters: ResumeSearchFilters = {},
  cursor?: string | null,
) {
  return request<ResumeSearchResponse>(
    `/api/resume-search${queryString({
      q: query,
      page: cursor ? undefined : page,
      page_size: pageSize,
      cursor: cursor || undefined,
      ...filters,
    })}`,
    { signal },
  );
}
