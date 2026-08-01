export interface FeedlyEntryContent {
  title?: string;
  html: string;
}

interface FeedlyEntryResponse {
  title?: unknown;
  content?: { content?: unknown };
  summary?: { content?: unknown };
}

const FEEDLY_API_ROOT = "https://cloud.feedly.com/v3/entries";

export function parseFeedlyEntryId(value: string): string | undefined {
  try {
    const url = new URL(value);
    const states = [url.searchParams.get("s") ?? "", url.hash];
    for (const state of states) {
      const match = /(?:^|[#&])entry:(.+)$/i.exec(state) ?? /^entry:(.+)$/i.exec(state);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Invalid URLs are handled by the page extractor's normal validation.
  }
  return undefined;
}

export async function fetchFeedlyEntry(entryId: string, signal: AbortSignal): Promise<FeedlyEntryContent | undefined> {
  if (!entryId.trim()) return undefined;
  try {
    const response = await fetch(`${FEEDLY_API_ROOT}/${encodeURIComponent(entryId)}`, {
      credentials: "include",
      signal,
    });
    if (!response.ok) return undefined;
    const data = await response.json() as FeedlyEntryResponse;
    const html = firstString(data.content?.content, data.summary?.content);
    if (!html) return undefined;
    const title = typeof data.title === "string" ? data.title.trim() : undefined;
    return { title: title || undefined, html };
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
}
