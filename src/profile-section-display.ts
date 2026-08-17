import type { CandidateProfileSection } from "./types";

/** Values used by imported resumes to mean "not supplied". */
const PLACEHOLDER_VALUE_PATTERN = /^(?:[-\u2010\u2011\u2012\u2013\u2014\u2212\uff0d]+|未填写|未填|未提供|未提取|未知|暂无|无|n\/a|na|null|none)$/iu;

// These keys are parser/lineage bookkeeping rather than resume content.  They
// may remain in the database for audit and idempotency, but must not make an
// otherwise empty section look populated or leak implementation identifiers in
// the user-facing resume view.
const INTERNAL_METADATA_KEYS = new Set([
  "id",
  "candidate_id",
  "attachment_id",
  "attachment_preview_id",
  "attachment_batch_id",
  "canonical_type",
  "fallback",
  "lineage_id",
  "parser",
  "parser_version",
  "preview_id",
  "preview_token",
  "record_id",
  "section_id",
  "profile_section_id",
  "source_offset",
  "source_order",
  "source_record_id",
  "source_record_key",
  "semantic_type",
]);

function normalizedMetadataKey(key: string): string {
  return key.trim().replace(/[\s-]+/g, "_").toLowerCase();
}

export function isInternalMetadataKey(key: string): boolean {
  const normalized = normalizedMetadataKey(key);
  if (INTERNAL_METADATA_KEYS.has(normalized)) return true;
  // Keep this deliberately narrow: fields such as `source` and `source_name`
  // can be legitimate resume values and must remain visible.
  return /^(?:attachment|preview|lineage)[-_]?(?:id|key|token|offset|order)$/i.test(normalized)
    || /^source[-_]?(?:offset|order|record[_-]?id|record[_-]?key)$/i.test(normalized);
}

export function isInternalLineageValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return /^(?:attachment[-_](?:preview|batch)[:_]|source[-_]?offset[:_]|preview[-_:]|record[-_:])/i.test(normalized);
}

export function isPlaceholderValue(value: unknown): boolean {
  return typeof value === "string" && PLACEHOLDER_VALUE_PATTERN.test(value.trim());
}

export function profileSectionTitleAfterTypeChange(
  currentTitleValue: unknown,
  currentDefaultTitleValue: unknown,
  nextDefaultTitleValue: unknown,
): string {
  const currentTitle = typeof currentTitleValue === "string" ? currentTitleValue : "";
  const currentDefaultTitle = typeof currentDefaultTitleValue === "string" ? currentDefaultTitleValue.trim() : "";
  const nextDefaultTitle = typeof nextDefaultTitleValue === "string" ? nextDefaultTitleValue.trim() : "";
  return !currentTitle.trim() || currentTitle.trim() === currentDefaultTitle
    ? nextDefaultTitle
    : currentTitle;
}

export function displayApplicantNumber(sourceSystemValue: unknown, sourceRecordIdValue: unknown): string {
  const sourceSystem = typeof sourceSystemValue === "string" ? sourceSystemValue.trim().toLowerCase() : "";
  const source = typeof sourceRecordIdValue === "string" ? sourceRecordIdValue.trim() : "";
  if (!source || isPlaceholderValue(source)) return "";
  // Only the importer that owns an external applicant-number contract is
  // trusted here.  Attachment/manual/unknown sources use source_record_id for
  // internal idempotency and must never render it as an applicant number.
  if (sourceSystem !== "beisen") return "";
  if (isInternalLineageValue(source)) return "";
  // A bare UUID is an implementation identifier unless it arrived through a
  // named external import source that owns the identifier contract.  Beisen
  // IDs are allowed to be UUID-shaped because they are explicitly sourced.
  return source;
}

/**
 * Remove rows whose value is only an empty placeholder while preserving the
 * original text and line order for all meaningful content.
 */
export function filterPlaceholderLines(value: unknown): string {
  if (typeof value !== "string") return "";
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const visible = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || isPlaceholderValue(trimmed)) return Boolean(trimmed) === false;

    // Typical imported section rows use either a Chinese or ASCII label
    // followed by a colon. Only remove an exact placeholder value; legal
    // hyphens in dates, emails, IDs, and prose remain untouched.
    const labeled = trimmed.match(/^([^:：\n]{1,160})\s*[:：]\s*(.*?)\s*$/);
    if (labeled && (
      isInternalMetadataKey(labeled[1])
      || isPlaceholderValue(labeled[2])
      || isInternalLineageValue(labeled[2])
    )) return false;
    if (isInternalLineageValue(trimmed)) return false;
    return true;
  });
  return visible.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function displayScalarValue(value: unknown): string {
  if (typeof value === "string") return filterPlaceholderLines(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(displayScalarValue).filter(Boolean).join("、");
  return "";
}

/** Recursively remove placeholder leaves from structured resume data. */
export function filterPlaceholderData(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    if (isInternalLineageValue(value)) return undefined;
    const cleaned = filterPlaceholderLines(value);
    return cleaned || undefined;
  }
  if (Array.isArray(value)) {
    const cleaned = value.map(filterPlaceholderData).filter((item) => isDisplayableValue(item));
    return cleaned.length ? cleaned : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isInternalMetadataKey(key))
      .map(([key, item]) => [key, filterPlaceholderData(item)] as const)
      .filter(([, item]) => isDisplayableValue(item));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function isDisplayableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(filterPlaceholderLines(value));
  if (Array.isArray(value)) return value.some(isDisplayableValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(isDisplayableValue);
  return true;
}

export function visibleProfileSection(section: CandidateProfileSection): CandidateProfileSection & {
  displayContent: string;
  displayStructuredData: unknown;
} {
  return {
    ...section,
    displayContent: filterPlaceholderLines(section.content),
    displayStructuredData: filterPlaceholderData(section.structured_data),
  };
}

export function hasVisibleProfileSection(section: CandidateProfileSection): boolean {
  const visible = visibleProfileSection(section);
  return Boolean(visible.displayContent || isDisplayableValue(visible.displayStructuredData));
}
