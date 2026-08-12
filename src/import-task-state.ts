const AUTO_RECOVER_IMPORT_STATUSES = new Set([
  "queued",
  "uploaded",
  "validating",
  "parsing",
  "mapping",
  "previewing",
  "preview_ready",
  "committing",
  "cancelling",
  "running",
]);

export function shouldAutoRecoverImportTask(status?: string | null) {
  if (!status) return true;
  return AUTO_RECOVER_IMPORT_STATUSES.has(status.toLowerCase());
}
