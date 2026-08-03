const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*<?([^>\s)]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi;
const HTML_IMAGE_PATTERN = /<img\b[^>]*\b(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * Returns only browser-fetchable image URLs. Data/blob URLs are deliberately
 * excluded because md2card exports remote images by fetching their URL.
 */
export function uniqueImageUrls(values: readonly string[], baseUrl?: string): string[] {
  const urls = new Set<string>();
  for (const value of values) {
    const normalized = normalizeImageUrl(value, baseUrl);
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

export function extractImageUrls(markdownOrHtml: string, baseUrl?: string): string[] {
  const candidates: string[] = [];
  for (const match of markdownOrHtml.matchAll(MARKDOWN_IMAGE_PATTERN)) candidates.push(match[1]);
  for (const match of markdownOrHtml.matchAll(HTML_IMAGE_PATTERN)) candidates.push(match[1]);
  return uniqueImageUrls(candidates, baseUrl);
}

function normalizeImageUrl(value: string, baseUrl?: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
