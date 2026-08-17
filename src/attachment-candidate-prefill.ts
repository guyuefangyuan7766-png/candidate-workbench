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

function isSelfSummarySection(section: AttachmentPreviewRecord["sections"][number]): boolean {
  if (String(section.section_type ?? "").trim().toLowerCase() === "self_summary") return true;
  const structured = section.structured_data;
  return Boolean(
    structured
    && !Array.isArray(structured)
    && String(structured.semantic_type ?? "").trim().toLowerCase() === "self_summary",
  );
}

export function attachmentProfileSectionDrafts(record: AttachmentPreviewRecord): CandidateProfileSectionDraft[] {
  return record.sections
    .filter((section) => section.default_selected && !isSelfSummarySection(section))
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

export function attachmentSuggestionText(record: AttachmentPreviewRecord, field: string): string {
  const value = attachmentSuggestionValue(record, field);
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function parsedAttachmentCandidateName(record: AttachmentPreviewRecord): string {
  return attachmentSuggestionText(record, "name") || record.match.candidate?.name || "";
}

export function candidateDraftFromAttachmentRecord(record: AttachmentPreviewRecord): CandidateDraft {
  const tags = attachmentSuggestionValue(record, "tags");
  const desiredTitlesValue = attachmentSuggestionValue(record, "desired_titles");
  const desiredTitles = (Array.isArray(desiredTitlesValue) ? desiredTitlesValue : [desiredTitlesValue])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const desiredLocationsValue = attachmentSuggestionValue(record, "desired_locations");
  const desiredLocations = (Array.isArray(desiredLocationsValue) ? desiredLocationsValue : [desiredLocationsValue])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const years = Number(attachmentSuggestionValue(record, "years_experience"));
  const expectedSalary = attachmentSuggestionText(record, "expected_salary");
  const employmentType = attachmentSuggestionText(record, "employment_type");
  const availability = attachmentSuggestionText(record, "availability");

  return {
    ...emptyDraft,
    name: parsedAttachmentCandidateName(record),
    phone: record.identity.phone || attachmentSuggestionText(record, "phone"),
    email: record.identity.email || attachmentSuggestionText(record, "email"),
    gender: attachmentSuggestionText(record, "gender"),
    birth_date: attachmentSuggestionText(record, "birth_date") || null,
    age: (() => {
      const age = Number(attachmentSuggestionValue(record, "age"));
      return Number.isInteger(age) && age >= 0 && age <= 120 ? age : null;
    })(),
    current_company: attachmentSuggestionText(record, "current_company"),
    current_title: attachmentSuggestionText(record, "current_title"),
    location: attachmentSuggestionText(record, "location"),
    years_experience: Number.isFinite(years) && years >= 0 ? years : 0,
    education: attachmentSuggestionText(record, "education"),
    highest_school: attachmentSuggestionText(record, "highest_school"),
    highest_major: attachmentSuggestionText(record, "highest_major"),
    job_seeking_status: attachmentSuggestionText(record, "job_seeking_status"),
    resume_updated_at: attachmentSuggestionText(record, "resume_updated_at") || null,
    self_summary: attachmentSuggestionText(record, "self_summary"),
    source: attachmentSuggestionText(record, "source") || emptyDraft.source,
    owner: attachmentSuggestionText(record, "owner") || emptyDraft.owner,
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 8) : [],
    expected_salary: expectedSalary,
    preferences: {
      ...emptyDraft.preferences,
      desired_locations: desiredLocations,
      employment_status: attachmentSuggestionText(record, "job_seeking_status"),
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
