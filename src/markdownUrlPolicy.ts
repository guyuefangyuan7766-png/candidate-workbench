const MARKDOWN_URL_BASE = "https://candidate-workbench.local/";
const ALLOWED_MARKDOWN_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function markdownUrlBase(): string {
  return typeof window !== "undefined" && window.location?.origin
    ? `${window.location.origin}/`
    : MARKDOWN_URL_BASE;
}

export function sanitizeMarkdownUrl(url: string): string | null {
  const value = url.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value, markdownUrlBase());
    return ALLOWED_MARKDOWN_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? value : null;
  } catch {
    return null;
  }
}

export function transformAssistantMarkdownUrl(url: string, key: string): string | null {
  return key === "href" ? sanitizeMarkdownUrl(url) : null;
}

export function isExternalMarkdownUrl(url: string): boolean {
  const value = sanitizeMarkdownUrl(url);
  if (!value) return false;
  try {
    const base = new URL(markdownUrlBase());
    const parsed = new URL(value, base);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin !== base.origin;
  } catch {
    return false;
  }
}
