export type CandidateStage =
  | "新候选人"
  | "筛选中"
  | "面试中"
  | "Offer"
  | "已入职"
  | "不合适";

export type PositionStatus = "draft" | "open" | "paused" | "closed";

export interface TalentPool {
  id: string;
  name: string;
  description: string;
  color: string;
  candidate_count: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  linked_at?: string;
}

export interface CandidateProfileSection {
  id: string;
  section_type: string;
  title: string;
  content: string;
  structured_data: Record<string, unknown> | unknown[] | null;
  sort_order: number;
  sensitivity: string;
  source_record_id: string;
  created_at: string;
  updated_at: string;
  raw_payload?: Record<string, unknown> | null;
}

export interface CandidateProfileSectionDraft {
  id?: string;
  section_type: string;
  title: string;
  content: string;
  structured_data?: Record<string, unknown> | unknown[] | null;
  sort_order?: number;
  sensitivity?: "public" | "internal" | "high";
  source_record_id?: string | null;
}

export interface CandidatePreferences {
  candidate_id?: string;
  employment_status: string;
  desired_titles: string[];
  desired_locations: string[];
  employment_type: string;
  expected_salary: string;
  availability: string;
  updated_at?: string;
  raw_payload?: Record<string, unknown> | null;
}

export type CandidatePreferencesDraft = Pick<
  CandidatePreferences,
  | "employment_status"
  | "desired_titles"
  | "desired_locations"
  | "employment_type"
  | "expected_salary"
  | "availability"
>;

export interface CandidateSourceRecord {
  id: string;
  record_type?: string;
  source_system?: string;
  source_record_id?: string;
  source_timestamp?: string;
  source_type?: string;
  source_name?: string;
  channel?: string;
  occurred_at?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown> | null;
}

export interface CandidateAssessment {
  id: string;
  assessment_type?: string;
  title?: string;
  result?: string;
  summary?: string;
  status?: string;
  conclusion?: string;
  score?: string | number | null;
  assessed_at?: string;
  occurred_at?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown> | null;
}

export interface CandidateConsent {
  id: string;
  consent_type?: string;
  agreement_name?: string;
  source_system?: string;
  source_record_id?: string;
  status?: string;
  consented_at?: string;
  expires_at?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown> | null;
}

export interface CandidatePositionSource {
  id: string;
  position_id?: string;
  application_id?: string;
  source_application_id?: string;
  source_system?: string;
  position_title?: string;
  source_name?: string;
  applied_at?: string;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown> | null;
}

export interface Position {
  id: string;
  title: string;
  department: string;
  location: string;
  owner: string;
  headcount: number;
  status: PositionStatus;
  description: string;
  tags: string[];
  candidate_count: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  linked_at?: string;
}

export type PositionDraft = Pick<
  Position,
  | "title"
  | "department"
  | "location"
  | "owner"
  | "headcount"
  | "status"
  | "description"
  | "tags"
>;

export interface Candidate {
  id: string;
  name: string;
  phone: string;
  email: string;
  photo_url: string;
  has_photo: boolean;
  gender: string;
  birth_date: string | null;
  age: number | null;
  current_company: string;
  current_title: string;
  location: string;
  years_experience: number | null;
  years_experience_raw: string;
  years_experience_display: string;
  education: string;
  highest_school: string;
  highest_major: string;
  job_seeking_status: string;
  hire_position: string;
  hire_status: string;
  hire_date: string | null;
  resume_updated_at: string | null;
  self_summary: string;
  source: string;
  stage: CandidateStage;
  owner: string;
  tags: string[];
  expected_salary: string;
  source_system: string;
  source_record_id: string;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  positions: Position[];
  talent_pools: TalentPool[];
  profile_sections?: CandidateProfileSection[];
  preferences?: CandidatePreferences | null;
  source_records?: CandidateSourceRecord[];
  assessments?: CandidateAssessment[];
  consents?: CandidateConsent[];
  position_sources?: CandidatePositionSource[];
}

export type AttachmentParseStatus = "pending" | "parsing" | "ready" | "failed" | string;

export interface CandidateAttachment {
  id: string;
  candidate_id: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  attachment_type: string;
  parse_status: AttachmentParseStatus;
  parser_version: string;
  created_at: string;
  updated_at: string;
  download_url?: string;
}

export interface CandidateAttachmentDeleteResult {
  attachment_id: string;
  candidate_id: string;
  deleted: true;
  cleanup_queued: boolean;
  physical_file_deleted?: boolean;
  cleanup_pending?: boolean;
}

export type AttachmentMatchStatus =
  | "high_confidence"
  | "single_identity"
  | "identity_conflict"
  | "multiple_matches"
  | "not_found";

export interface AttachmentCandidateMatch {
  status: AttachmentMatchStatus;
  candidate_id?: string;
  candidate?: Pick<Candidate, "id" | "name" | "phone" | "email" | "updated_at">;
  resolution?: "created";
  reason: string;
}

export interface AttachmentFieldSuggestion {
  field: string;
  value: unknown;
  confidence: "high" | "medium" | "low";
  evidence: string;
  source?: AttachmentSuggestionSource;
  evidence_status?: "text_verified" | "unverified";
  evidence_refs?: AttachmentEvidenceReference[];
  conflict?: AttachmentSuggestionConflict;
  current_value: unknown;
  default_selected: boolean;
}

export interface AttachmentSectionSuggestion {
  section_id: string;
  section_type: string;
  title: string;
  content: string;
  structured_data: Record<string, unknown> | unknown[] | null;
  confidence: "high" | "medium" | "low";
  evidence: string;
  source?: AttachmentSuggestionSource;
  evidence_status?: "text_verified" | "unverified";
  evidence_refs?: AttachmentEvidenceReference[];
  conflict?: AttachmentSuggestionConflict;
  default_selected: boolean;
}

export type AttachmentSuggestionSource =
  | "deterministic_text"
  | "deterministic_table"
  | "model_text"
  | "visual"
  | "merged";

export interface AttachmentEvidenceReference {
  page: number | null;
  text: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface AttachmentSuggestionConflict {
  code: string;
  source: AttachmentSuggestionSource;
  existing_source?: AttachmentSuggestionSource;
  existing_value?: unknown;
  proposed_value?: unknown;
  evidence_status?: "text_verified" | "unverified";
  evidence_refs?: AttachmentEvidenceReference[];
  message: string;
}

export type AttachmentSchemaMode = "strict" | "compat" | "unknown";

export interface AttachmentPipelineChannel {
  status: string;
  used_fallback?: boolean;
  capability?: string;
  error_code?: string;
  retryable?: boolean;
  schema_mode?: AttachmentSchemaMode;
  parser_version?: string;
  prompt_version?: string;
}

export interface AttachmentParserPipeline {
  /** Older durable previews may omit the text route metadata. */
  text?: { status: string; content_type: string };
  /** Older durable previews may not have a text-model channel. */
  text_model?: AttachmentPipelineChannel;
  visual: AttachmentPipelineChannel & { used_fallback: boolean };
  /** True when the deterministic/visual coverage needs human review. */
  review_required?: boolean;
}

export interface AttachmentAvatarSuggestion {
  status: "ready" | "ambiguous" | "invalid" | "none";
  available: boolean;
  source: "explicit_url" | "docx_embedded_image" | "pdf_embedded_image" | "xlsx_embedded_image" | null;
  confidence: "high" | "medium" | "low" | null;
  candidate_count: number;
  content_type?: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
  sheet_name?: string | null;
  row_number?: number | null;
}

export interface AttachmentPreviewRecord {
  record_id: string;
  row_number: number | null;
  identity: { phone: string; email: string };
  match: AttachmentCandidateMatch;
  suggestions: AttachmentFieldSuggestion[];
  sections: AttachmentSectionSuggestion[];
  avatar?: AttachmentAvatarSuggestion;
}

export interface AttachmentPreview {
  preview_id: string;
  preview_token: string;
  preview_token_reissued?: boolean;
  status: AttachmentParseStatus;
  parser_version?: string;
  pipeline?: AttachmentParserPipeline;
  review_required?: boolean;
  error_code?: string;
  error?: string;
  retryable?: boolean;
  poll_after_ms?: number;
  expires_at: string;
  file: {
    original_filename: string;
    mime_type: string;
    file_size: number;
    sha256: string;
    format: string;
  };
  records: AttachmentPreviewRecord[];
}

export interface AttachmentConfirmRecord {
  record_id: string;
  candidate_id: string;
  expected_updated_at: string;
  selected_fields: string[];
  selected_sections: string[];
  merge_mode: "merge";
}

export type AttachmentBatchItemStatus =
  | "queued"
  | "extracting"
  | "identifying"
  | "parsing"
  | "matching"
  | "awaiting_confirmation"
  | "confirmed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface AttachmentBatchError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface AttachmentBatchItem {
  item_id: string;
  batch_id?: string;
  parent_item_id?: string | null;
  kind: "file" | "archive" | "archive_entry";
  ordinal?: number;
  original_filename: string;
  archive_path?: string | null;
  status: AttachmentBatchItemStatus;
  phase: string;
  progress: number | null;
  attempts: number;
  file?: {
    original_filename?: string | null;
    mime_type: string | null;
    file_size: number | null;
    sha256: string | null;
    format: string | null;
  };
  preview_id?: string | null;
  preview?: AttachmentPreview | null;
  error?: AttachmentBatchError | null;
  confirmation?: AttachmentBatchConfirmation | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface AttachmentBatchConfirmation {
  attachment_ids?: string[];
  attachments?: CandidateAttachment[];
  updated_candidate_ids?: string[];
  committed_records?: number;
}

export interface AttachmentBatchSummary {
  total: number;
  queued: number;
  extracting: number;
  identifying: number;
  parsing: number;
  matching: number;
  awaiting_confirmation: number;
  confirmed: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface AttachmentBatch {
  batch_id: string;
  batch_token?: string;
  status: string;
  phase: string;
  progress: number | null;
  poll_after_ms?: number;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  summary: AttachmentBatchSummary;
  items: AttachmentBatchItem[];
}

export interface AttachmentBatchConfirmResponse {
  item: AttachmentBatchItem;
  confirmation?: AttachmentBatchConfirmation | null;
  next_item_id?: string | null;
  batch: AttachmentBatch;
}

export interface ResumeSearchItem {
  candidate_id: string;
  name: string;
  current_title?: string | null;
  current_company?: string | null;
  condition_status?: "matched" | "unknown" | "partial";
  score: number;
  matched_fields: string[];
  matched_terms?: string[];
  evidence?: ResumeSearchEvidence[];
  snippets: string[];
  reasons: string[];
}

export interface ResumeSearchIndexStatus {
  state: "ready" | "indexing" | "failed" | string;
  ready: boolean;
  available?: boolean;
  progress: number | null;
  remaining?: number | null;
  processed?: number | null;
  queued?: number | null;
  document_count?: number | null;
  indexed_document_count?: number | null;
  retry_after_ms?: number | null;
  search_index?: string;
  updated_at?: string | null;
  error?: { code: string; message: string } | null;
}

export interface ResumeSearchCursorPagination {
  page?: number;
  page_size: number;
  total: number | null;
  total_pages?: number | null;
  has_next?: boolean;
  has_more: boolean;
  next_cursor: string | null;
  current_cursor?: string | null;
}

export interface ResumeSearchResponse {
  items: ResumeSearchItem[];
  pagination: ResumeSearchCursorPagination;
  index?: ResumeSearchIndexStatus;
  condition_summary?: ResumeSearchCondition[];
  completeness?: {
    conditions: "complete" | "partial";
    retrieval: "complete" | "bounded" | "partial" | "index_not_ready";
    ranking: "hybrid_reranked" | "rrf" | "fts";
  };
  degradation?: { code: string; message: string; stage: string }[];
}

export interface ResumeSearchCondition {
  id: string;
  text: string;
  kind: "required" | "excluded" | "preferred" | "unresolved";
}

export interface ResumeSearchOption {
  id: string;
  name: string;
}

export interface ResumeSearchOptionsResponse {
  items: ResumeSearchOption[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
    has_more: boolean;
  };
}

export interface SearchHighlightMatch {
  start: number;
  end: number;
  concept_label?: string;
  actual_term?: string;
  matched_text?: string;
  expanded?: boolean;
}

export interface SearchHighlightRange {
  start: number;
  end: number;
  term?: string;
  actual_term?: string;
  concept_labels?: string[];
  actual_terms?: string[];
  expanded?: boolean;
  matches?: SearchHighlightMatch[];
}

export interface NormalizedSearchHighlightRange {
  start: number;
  end: number;
  actualTerms: string[];
}

export function normalizeSearchHighlightRanges(
  text: string,
  ranges: SearchHighlightRange[] = [],
): NormalizedSearchHighlightRange[] {
  const normalized = ranges
    .map((range) => {
      const rawStart = Number(range.start);
      const rawEnd = Number(range.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
      const start = Math.max(0, Math.min(text.length, Math.trunc(rawStart)));
      const end = Math.max(start, Math.min(text.length, Math.trunc(rawEnd)));
      if (end <= start) return null;
      const actualTerms = [
        ...(range.actual_terms ?? []),
        ...(range.actual_term ? [range.actual_term] : []),
        ...(range.matches ?? []).flatMap((match) => match.actual_term ? [match.actual_term] : []),
      ].map(String).filter(Boolean);
      return { start, end, actualTerms: [...new Set(actualTerms)] };
    })
    .filter((range): range is NormalizedSearchHighlightRange => range !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: NormalizedSearchHighlightRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      previous.actualTerms = [...new Set([...previous.actualTerms, ...range.actualTerms])];
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export interface SearchEvidenceSnippet {
  text: string;
  start: number;
  end: number;
  truncated_before: boolean;
  truncated_after: boolean;
  highlights: SearchHighlightRange[];
  source_match_count?: number;
  omitted_match_count?: number;
}

export interface ResumeSearchEvidence {
  document_id: string;
  entity_type: string;
  entity_id: string;
  candidate_id: string | null;
  source_table: string;
  source_row_id: string;
  field_path: string;
  title: string;
  score: number;
  matched_terms: string[];
  matched_actual_terms: string[];
  has_expanded_matches?: boolean;
  snippet: SearchEvidenceSnippet;
  source_label?: string;
  ownership?: "self" | "related";
  match_kind?: string;
}

export interface AgentSession {
  id: string;
  title: string;
  status: "active" | "archived";
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  status: "processing" | "completed" | "failed";
  client_request_id: string | null;
  reply_to_message_id: string | null;
  model: string | null;
  tools_used: Array<{ name?: string } | string>;
  error_code: string | null;
  input_bytes: number | null;
  output_bytes: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface AgentMessagePagination {
  page_size: number;
  has_more: boolean;
  next_before_sequence: number | null;
}

export type AgentTaskStatus =
  | "queued"
  | "planning"
  | "querying"
  | "retrieving"
  | "composing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "processing";

export interface AgentTaskError {
  code: string;
  stage?: string | null;
  message: string;
  retryable?: boolean;
  retained_result?: boolean;
}

/**
 * A bounded task result. The server may add structured fields as the query
 * planner evolves; the UI only reads the safe, optional fields below.
 */
export interface AgentTaskResult {
  items?: ResumeSearchItem[];
  evidence?: ResumeSearchEvidence[];
  snippets?: string[];
  summary?: string;
  pagination?: Pagination;
  has_more?: boolean;
  result_count?: number;
  [key: string]: unknown;
}

export interface AgentArtifact {
  artifact_id: string;
  kind: "file";
  filename: string;
  mime_type: "text/csv; charset=utf-8";
  bytes: number;
  download_url: string;
}

export interface AgentTask {
  task_id: string;
  trace_id?: string | null;
  session_id?: string | null;
  user_message_id?: string | null;
  client_request_id?: string | null;
  status: AgentTaskStatus;
  stage?: string | null;
  elapsed_ms?: number | null;
  timings?: Record<string, number>;
  tools_used?: Array<{ name?: string } | string>;
  result_count?: number | null;
  result?: AgentTaskResult | null;
  artifacts?: AgentArtifact[];
  has_more?: boolean;
  error?: AgentTaskError | null;
  user_message?: AgentMessage | null;
  assistant_message?: AgentMessage | null;
  created_at?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  heartbeat_at?: string | null;
  deadline_at?: string | null;
  completed_at?: string | null;
  can_cancel?: boolean;
  can_retry_answer?: boolean;
}

export interface AgentSessionTurn {
  state: AgentTaskStatus;
  replayed: boolean;
  session: AgentSession;
  user_message: AgentMessage;
  assistant_message: AgentMessage | null;
  task?: AgentTask | null;
}

export interface CandidateNote {
  id: string;
  candidate_id: string;
  content: string;
  author: string;
  created_at: string;
}

export interface CandidateActivity {
  id: string;
  candidate_id: string;
  type: string;
  description: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CandidateDraft extends Omit<Pick<
  Candidate,
  | "name"
  | "phone"
  | "email"
  | "gender"
  | "birth_date"
  | "age"
  | "current_company"
  | "current_title"
  | "location"
  | "years_experience"
  | "education"
  | "highest_school"
  | "highest_major"
  | "job_seeking_status"
  | "hire_status"
  | "hire_date"
  | "hire_position"
  | "resume_updated_at"
  | "self_summary"
  | "source"
  | "stage"
  | "owner"
  | "tags"
  | "expected_salary"
>, "years_experience"> {
  years_experience: string;
  preferences: CandidatePreferencesDraft;
  /** Optional when an edit payload did not load profile sections. */
  profile_sections?: CandidateProfileSectionDraft[];
}

export interface ImportResult {
  batchId: string;
  total: number;
  imported: number;
  duplicates: number;
  invalid: number;
  candidateCount?: number;
  applicationCount?: number;
  positionCount?: number;
  positionsCreated?: number;
  positionsMatched?: number;
  linksCreated?: number;
  poolsCreated?: number;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next?: boolean;
}

export interface CandidateFacets {
  sources: string[];
  owners: string[];
  tags: string[];
  education: string[];
  schools: string[];
  genders: string[];
  job_seeking_statuses: string[];
  totals: { total: number; active: number; archived: number };
}

export interface PositionFacets {
  departments: string[];
  owners: string[];
  locations: string[];
  totals: { total: number; active: number; archived: number };
  status_counts: Partial<Record<PositionStatus, number>>;
}

export interface CandidateFilters {
  page?: number;
  page_size?: number;
  search?: string;
  stage?: CandidateStage;
  source?: string;
  owner?: string;
  tag?: string;
  position_id?: string;
  exclude_position_id?: string;
  pool_id?: string;
  exclude_pool_id?: string;
  education?: string;
  school?: string;
  major?: string;
  gender?: string;
  job_seeking_status?: string;
  archived?: "exclude" | "include" | "only";
  sort?: "name" | "created_at" | "updated_at" | "stage" | "current_company" | "years_experience";
  order?: "asc" | "desc";
}

export interface PositionFilters {
  page?: number;
  page_size?: number;
  search?: string;
  status?: PositionStatus;
  department?: string;
  owner?: string;
  location?: string;
  archived?: "exclude" | "include" | "only";
  sort?: "updated_at" | "title" | "status" | "department" | "location" | "owner" | "headcount" | "candidate_count";
  order?: "asc" | "desc";
}

export interface DashboardData {
  totals: { total: number; active: number; archived: number };
  position_totals: { total: number; active: number; archived: number; open: number };
  unassigned_candidates: number;
  recent_update_count: number;
  by_stage: Array<{ value: CandidateStage; label: string; color: string; position: number; count: number }>;
  by_source: Array<{ source: string; count: number }>;
  positions_by_status: Array<{ status: PositionStatus; count: number }>;
  recent_candidates: Candidate[];
  recent_positions: Position[];
  talent_summary?: {
    by_pool: Array<{ id: string; name: string; color: string; count: number }>;
    by_education: Array<{ education: string; count: number }>;
    by_job_seeking_status: Array<{ status: string; count: number }>;
    unassigned_pool_count: number;
  };
}

export const STAGES: CandidateStage[] = [
  "新候选人",
  "筛选中",
  "面试中",
  "Offer",
  "已入职",
  "不合适",
];

export const POSITION_STATUS_LABELS: Record<PositionStatus, string> = {
  draft: "草稿",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};

export const POSITION_STATUSES: PositionStatus[] = ["open", "draft", "paused", "closed"];

export const SOURCES = ["北森导入", "猎头推荐", "员工内推", "官网投递", "主动寻访", "手工录入"];

export const OWNERS = ["本人", "未分配"];

export const EDUCATION_OPTIONS = ["博士", "硕士", "本科", "大专", "其他"];

export const emptyDraft: CandidateDraft = {
  name: "",
  phone: "",
  email: "",
  gender: "",
  birth_date: null,
  age: null,
  current_company: "",
  current_title: "",
  location: "",
  years_experience: "",
  education: "本科",
  highest_school: "",
  highest_major: "",
  job_seeking_status: "",
  hire_status: "",
  hire_date: null,
  hire_position: "",
  resume_updated_at: null,
  self_summary: "",
  source: "手工录入",
  stage: "新候选人",
  owner: "未分配",
  tags: [],
  expected_salary: "",
  preferences: {
    employment_status: "",
    desired_titles: [],
    desired_locations: [],
    employment_type: "",
    expected_salary: "",
    availability: "",
  },
  profile_sections: [],
};

export const emptyPositionDraft: PositionDraft = {
  title: "",
  department: "",
  location: "",
  owner: "本人",
  headcount: 1,
  status: "draft",
  description: "",
  tags: [],
};
