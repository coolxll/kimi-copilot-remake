export interface BilibiliVideoRef {
  bvid?: string;
  aid?: string;
  pageNumber?: number;
}

export interface BilibiliPage {
  page?: number;
  cid?: number | string;
  part?: string;
  duration?: number;
}

export interface BilibiliSubtitleTrack {
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  type?: number;
  ai_type?: number;
}

/** Parse normal BV/av video URLs, including a page number in ?p=. */
export function parseBilibiliVideoUrl(rawUrl: string): BilibiliVideoRef | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!/bilibili\.com$/i.test(url.hostname) && !/\.bilibili\.com$/i.test(url.hostname)) return undefined;

  const pathId = /^\/video\/([^/?#]+)/i.exec(url.pathname)?.[1];
  const bvidParam = url.searchParams.get("bvid") ?? undefined;
  const aidParam = url.searchParams.get("aid") ?? undefined;
  const id = pathId ?? bvidParam ?? aidParam;
  if (!id) return undefined;

  const bvid = /^BV[0-9A-Za-z]+$/i.test(id) ? id : undefined;
  const aid = /^av?\d+$/i.test(id) ? id.replace(/^av/i, "") : (bvid ? undefined : id);
  if (!bvid && !aid) return undefined;

  const parsedPage = Number(url.searchParams.get("p"));
  const pageNumber = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : undefined;
  return { bvid, aid, pageNumber };
}

/** Resolve a page only when the URL or current player state identifies it. */
export function selectBilibiliPage(
  pages: BilibiliPage[],
  requestedPageNumber: number | undefined,
  currentCid: number | string | undefined,
  fallbackCid: number | string | undefined,
): BilibiliPage | undefined {
  if (requestedPageNumber !== undefined) {
    const requested = pages.find((page) => Number(page.page) === requestedPageNumber);
    return requested;
  }
  if (currentCid !== undefined && currentCid !== null) {
    return pages.find((page) => String(page.cid) === String(currentCid));
  }
  if (pages.length === 1) return pages[0];
  if (pages.length > 1) return undefined;
  return fallbackCid !== undefined ? { cid: fallbackCid, page: requestedPageNumber } : undefined;
}

export function chooseBilibiliSubtitleTrack(tracks: BilibiliSubtitleTrack[]): BilibiliSubtitleTrack | undefined {
  return [...tracks]
    .filter((track) => Boolean(track.subtitle_url))
    .sort((a, b) => subtitleTrackScore(b) - subtitleTrackScore(a))[0];
}

/**
 * The subtitle JSON has no video identity. Reject a clearly unrelated track
 * when its timeline ends far before a long video.
 */
export function isLikelyMismatchedBilibiliSubtitle(videoDuration: number | undefined, subtitleEnd: number | undefined): boolean {
  if (!(videoDuration && subtitleEnd) || videoDuration < 300 || subtitleEnd >= videoDuration) return false;
  return subtitleEnd < videoDuration * 0.7 && videoDuration - subtitleEnd >= 180;
}

export function isBilibiliAiSubtitleTrack(track: BilibiliSubtitleTrack): boolean {
  // Bilibili has returned ai-zh tracks with ai_type=0, so inspect both fields.
  return Boolean(track.ai_type) || /^ai[-_]/i.test(track.lan ?? "");
}

function subtitleTrackScore(track: BilibiliSubtitleTrack): number {
  const language = `${track.lan ?? ""} ${track.lan_doc ?? ""}`.toLowerCase();
  let score = isBilibiliAiSubtitleTrack(track) ? 0 : 100;
  if (/zh[-_ ]?(cn|hans|简|中)/i.test(language)) score += 4;
  else if (/zh[-_ ]?(tw|hant|繁)/i.test(language)) score += 3;
  else if (/\ben\b|英/.test(language)) score += 2;
  return score;
}
