// The explicit extension keeps this pure helper directly importable by Node's TypeScript test runner.
// @ts-ignore TS5097 is safe here because this project is no-emit and Vite resolves TypeScript modules.
import { emptyDraft } from "./types.ts";
import type {
  AttachmentPreviewRecord,
  Candidate,
  CandidateDraft,
  CandidateProfileSectionDraft,
} from "./types";

const CANONICAL_PROFILE_SECTION_TYPES = new Set([
  "education",
  "experience",
  "project",
  "internship",
  "skill",
  "campus",
  "language",
  "certificate",
  "award",
  "training",
  "publication",
  "management",
  "other",
]);

const PROFILE_SECTION_TYPE_ALIASES: Record<string, string> = {
  education_experience: "education",
  work_experience: "experience",
  project_experience: "project",
  skills: "skill",
  additional: "other",
  additional_information: "other",
  resume_summary: "other",
};

function canonicalProfileSectionType(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  const canonical = PROFILE_SECTION_TYPE_ALIASES[raw] ?? raw;
  return CANONICAL_PROFILE_SECTION_TYPES.has(canonical) ? canonical : "other";
}

export function isAttachmentSelfSummarySection(section: AttachmentPreviewRecord["sections"][number]): boolean {
  const sectionType = String(section.section_type ?? "").trim().toLowerCase();
  if (sectionType === "self_summary" || sectionType === "resume_summary") return true;
  const structured = section.structured_data;
  return Boolean(
    structured
    && !Array.isArray(structured)
    && String(structured.semantic_type ?? "").trim().toLowerCase() === "self_summary",
  );
}

function sectionHasEvidence(section: AttachmentPreviewRecord["sections"][number]): boolean {
  if (typeof section.evidence === "string" && section.evidence.trim()) return true;
  return Array.isArray(section.evidence_refs) && section.evidence_refs.some((reference) => (
    typeof reference?.text === "string" && reference.text.trim().length > 0
  ));
}

export function attachmentProfileSectionDrafts(record: AttachmentPreviewRecord): CandidateProfileSectionDraft[] {
  return record.sections
    .filter((section) => section.default_selected
      && !isAttachmentSelfSummarySection(section)
      && section.confidence !== "low"
      && section.evidence_status !== "unverified"
      && section.conflict === undefined
      && sectionHasEvidence(section))
    .map((section, index) => ({
      section_type: canonicalProfileSectionType(section.section_type),
      title: String(section.title ?? "").trim(),
      content: String(section.content ?? "").trim(),
      structured_data: section.structured_data ?? null,
      sort_order: index,
      sensitivity: "internal" as const,
    }));
}

export function attachmentSuggestionValue(record: AttachmentPreviewRecord, field: string): unknown {
  return record.suggestions.find((item) => item.field === field)?.value;
}

export function attachmentSafeSuggestionValue(record: AttachmentPreviewRecord, field: string): unknown {
  const suggestion = record.suggestions.find((item) => item.field === field);
  if (!suggestion
    || suggestion.default_selected !== true
    || suggestion.confidence === "low"
    || suggestion.evidence_status === "unverified"
    || suggestion.conflict !== undefined
    || !attachmentSuggestionHasEvidence(suggestion)) return undefined;
  return suggestion.value;
}

export function attachmentSuggestionText(record: AttachmentPreviewRecord, field: string): string {
  const value = attachmentSuggestionValue(record, field);
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function attachmentSafeSuggestionText(record: AttachmentPreviewRecord, field: string): string {
  const value = attachmentSafeSuggestionValue(record, field);
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function attachmentSuggestionHasEvidence(item: { evidence?: unknown; evidence_refs?: unknown }): boolean {
  if (typeof item.evidence === "string" && item.evidence.trim()) return true;
  return Array.isArray(item.evidence_refs) && item.evidence_refs.some((reference) => (
    Boolean(reference)
    && typeof (reference as { text?: unknown }).text === "string"
    && Boolean((reference as { text: string }).text.trim())
  ));
}

export function parsedAttachmentCandidateName(record: AttachmentPreviewRecord): string {
  return attachmentSuggestionText(record, "name") || record.match.candidate?.name || "";
}

export function candidateDraftFromAttachmentRecord(record: AttachmentPreviewRecord): CandidateDraft {
  const tags = attachmentSafeSuggestionValue(record, "tags");
  const desiredTitlesValue = attachmentSafeSuggestionValue(record, "desired_titles");
  const desiredTitles = (Array.isArray(desiredTitlesValue) ? desiredTitlesValue : [desiredTitlesValue])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const desiredLocationsValue = attachmentSafeSuggestionValue(record, "desired_locations");
  const desiredLocations = (Array.isArray(desiredLocationsValue) ? desiredLocationsValue : [desiredLocationsValue])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const years = Number(attachmentSafeSuggestionValue(record, "years_experience"));
  const expectedSalary = attachmentSafeSuggestionText(record, "expected_salary");
  const employmentType = attachmentSafeSuggestionText(record, "employment_type");
  const availability = attachmentSafeSuggestionText(record, "availability");

  return {
    ...emptyDraft,
    name: attachmentSafeSuggestionText(record, "name"),
    phone: record.identity.phone,
    email: record.identity.email,
    gender: attachmentSafeSuggestionText(record, "gender"),
    birth_date: attachmentSafeSuggestionText(record, "birth_date") || null,
    age: (() => {
      const age = Number(attachmentSafeSuggestionValue(record, "age"));
      return Number.isInteger(age) && age >= 0 && age <= 120 ? age : null;
    })(),
    current_company: attachmentSafeSuggestionText(record, "current_company"),
    current_title: attachmentSafeSuggestionText(record, "current_title"),
    location: attachmentSafeSuggestionText(record, "location"),
    years_experience: Number.isFinite(years) && years >= 0 ? years : 0,
    education: attachmentSafeSuggestionText(record, "education"),
    highest_school: attachmentSafeSuggestionText(record, "highest_school"),
    highest_major: attachmentSafeSuggestionText(record, "highest_major"),
    job_seeking_status: attachmentSafeSuggestionText(record, "job_seeking_status"),
    resume_updated_at: attachmentSafeSuggestionText(record, "resume_updated_at") || null,
    self_summary: attachmentSafeSuggestionText(record, "self_summary"),
    source: attachmentSafeSuggestionText(record, "source") || emptyDraft.source,
    owner: attachmentSafeSuggestionText(record, "owner") || emptyDraft.owner,
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 8) : [],
    expected_salary: expectedSalary,
    preferences: {
      ...emptyDraft.preferences,
      desired_locations: desiredLocations,
      employment_status: attachmentSafeSuggestionText(record, "job_seeking_status"),
      desired_titles: desiredTitles,
      employment_type: employmentType,
      expected_salary: expectedSalary,
      availability,
    },
    profile_sections: attachmentProfileSectionDrafts(record),
  };
}

export function hasCandidateValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const text = value.trim();
    return Boolean(text) && !/^(?:[-‐‑‒–—−－]+|未填写|未填|未提供|未提取|未知|暂无|无|n\/a|na|null|none)$/iu.test(text);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

export function candidateFieldValue(candidate: Candidate, field: string): unknown {
  if (field === "tags") return candidate.tags ?? [];
  if (field === "desired_titles") return candidate.preferences?.desired_titles ?? [];
  if (field === "desired_locations") return candidate.preferences?.desired_locations ?? [];
  if (field === "employment_type") return candidate.preferences?.employment_type ?? null;
  if (field === "availability") return candidate.preferences?.availability ?? null;
  if (field === "job_seeking_status") {
    return candidate.job_seeking_status || candidate.preferences?.employment_status || null;
  }
  if (field === "expected_salary") {
    return candidate.preferences?.expected_salary || candidate.expected_salary || null;
  }
  return (candidate as unknown as Record<string, unknown>)[field] ?? null;
}

export function sameCandidateFieldValue(field: string, left: unknown, right: unknown): boolean {
  if (field === "tags" || field === "desired_titles" || field === "desired_locations") {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  }
  return (left ?? null) === (right ?? null);
}

export function attachmentSuggestionChangesCandidate(
  candidate: Candidate,
  field: string,
  suggested: unknown,
): boolean {
  const current = candidateFieldValue(candidate, field);
  if (field === "tags") {
    const existing = Array.isArray(current) ? current.map(String) : [];
    const incoming = Array.isArray(suggested) ? suggested.map(String) : [];
    const merged = Array.from(new Set([...existing, ...incoming])).slice(0, 50);
    return !sameCandidateFieldValue(field, existing, merged);
  }
  return !sameCandidateFieldValue(field, current, suggested);
}

export function defaultAttachmentFieldsForCandidate(
  record: AttachmentPreviewRecord,
  candidate: Candidate,
): Set<string> {
  return new Set(record.suggestions
    .filter((suggestion) => (
      attachmentSuggestionChangesCandidate(candidate, suggestion.field, suggestion.value)
      && !hasCandidateValue(candidateFieldValue(candidate, suggestion.field))
      && suggestion.confidence !== "low"
      && suggestion.conflict === undefined
      && suggestion.evidence_status !== "unverified"
      && attachmentSuggestionHasEvidence(suggestion)
    ))
    .map((suggestion) => suggestion.field));
}

export {
  attachmentSuggestionChangesCandidate as suggestionChangesCandidate,
  attachmentSuggestionText as suggestionText,
  attachmentSuggestionValue as suggestionValue,
  candidateDraftFromAttachmentRecord as candidateDraftFromRecord,
  defaultAttachmentFieldsForCandidate as defaultFieldsForCandidate,
  parsedAttachmentCandidateName as parsedCandidateName,
  sameCandidateFieldValue as sameCandidateValue,
};
