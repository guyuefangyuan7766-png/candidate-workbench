interface PreviewTokenState {
  preview_token: string;
}

export function preserveAttachmentPreviewToken<T extends PreviewTokenState>(
  next: T,
  previous: PreviewTokenState | null | undefined,
): T {
  if (next.preview_token || !previous?.preview_token) return next;
  return { ...next, preview_token: previous.preview_token };
}
