import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";

export interface BilibiliVideoRef {
  bvid?: string;
  aid?: string;
  pageNumber?: number;
}

export interface BilibiliPage {
  page?: number;
  cid?: number | string;
  part?: string;
}

/** Parse both normal BV URLs and the older av form, including ?p=2. */
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

/** Select the page that the user is looking at, never silently defaulting to page 1 when ?p is present. */
export function selectBilibiliPage(
  pages: BilibiliPage[],
  requestedPageNumber: number | undefined,
  currentCid: number | string | undefined,
  fallbackCid: number | string | undefined,
): BilibiliPage | undefined {
  if (requestedPageNumber !== undefined) {
    const requested = pages.find((page) => Number(page.page) === requestedPageNumber);
    if (requested) return requested;
  }
  if (currentCid !== undefined && currentCid !== null) {
    const current = pages.find((page) => String(page.cid) === String(currentCid));
    if (current) return current;
  }
  return pages[0] ?? (fallbackCid !== undefined ? { cid: fallbackCid, page: requestedPageNumber } : undefined);
}

interface BilibiliSubtitleTrack {
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  type?: number;
  ai_type?: number;
}

export function chooseBilibiliSubtitleTrack(tracks: BilibiliSubtitleTrack[]): BilibiliSubtitleTrack | undefined {
  return [...tracks]
    .filter((track) => Boolean(track.subtitle_url))
    .sort((a, b) => subtitleTrackScore(b) - subtitleTrackScore(a))[0];
}

/**
 * Reject an obviously unrelated subtitle resource. Bilibili's subtitle JSON
 * does not repeat the video identity, so its timeline is the only cheap
 * integrity signal available after downloading the signed resource.
 */
export function isLikelyMismatchedBilibiliSubtitle(videoDuration: number | undefined, subtitleEnd: number | undefined): boolean {
  if (!(videoDuration && subtitleEnd) || videoDuration < 300 || subtitleEnd >= videoDuration) return false;
  return subtitleEnd < videoDuration * 0.7 && videoDuration - subtitleEnd >= 180;
}

function subtitleTrackScore(track: BilibiliSubtitleTrack): number {
  const language = `${track.lan ?? ""} ${track.lan_doc ?? ""}`.toLowerCase();
  let score = isAiSubtitleTrack(track) ? 0 : 100;
  if (/zh[-_ ]?(cn|hans|简|中)/i.test(language)) score += 4;
  else if (/zh[-_ ]?(tw|hant|繁)/i.test(language)) score += 3;
  else if (/\ben\b|英/.test(language)) score += 2;
  return score;
}

function isAiSubtitleTrack(track: BilibiliSubtitleTrack): boolean {
  // Bilibili has returned ai-zh tracks with ai_type=0, so the language code
  // must be considered as well as the numeric flag.
  return Boolean(track.ai_type) || /^ai[-_]/i.test(track.lan ?? "");
}

interface BilibiliScriptResult {
  title: string;
  description: string;
  subtitles: string;
  pageText: string;
  pageNumber?: number;
  selectedPage?: number;
  pageCount: number;
  subtitleLanguage?: string;
  subtitleIsAi?: boolean;
  subtitleDuration?: number;
  subtitleRejectedReason?: string;
  selectionWarning?: string;
}

export class BilibiliExtractor implements ContentExtractor {
  readonly id = "bilibili" as const;

  canHandle(context: PageContext): boolean {
    return Boolean(parseBilibiliVideoUrl(context.url));
  }

  async extract(context: PageContext): Promise<ExtractedDocument> {
    const videoRef = parseBilibiliVideoUrl(context.url);
    if (!videoRef) throw new AppError("unsupported-page", "无效的 Bilibili 视频地址");

    let value: BilibiliScriptResult | undefined;
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        world: "MAIN",
        func: async (ref: BilibiliVideoRef, pageUrl: string) => {
          type ViewPage = { page?: number; cid?: number | string; part?: string; duration?: number };
          type ViewData = { bvid?: string; title?: string; desc?: string; aid?: number | string; cid?: number | string; duration?: number; pages?: ViewPage[] };
          type ApiResponse<T> = { code?: number; data?: T };
          type InitialState = { videoData?: { bvid?: string; aid?: number | string; cid?: number | string; pages?: ViewPage[] } };

          // A side panel can open while Bilibili is still changing its SPA route. Do not
          // query the old page's state just because the tab URL has already changed.
          if (ref.bvid) {
            const expectedBvid = ref.bvid.toUpperCase();
            for (let attempt = 0; attempt < 10; attempt += 1) {
              const routeBvid = /\/video\/(BV[0-9A-Za-z]+)/i.exec(location.pathname)?.[1]?.toUpperCase();
              const stateBvid = (window as unknown as { __INITIAL_STATE__?: InitialState }).__INITIAL_STATE__?.videoData?.bvid?.toUpperCase();
              if (routeBvid === expectedBvid && (!stateBvid || stateBvid === expectedBvid)) break;
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }

          const query = ref.bvid
            ? `bvid=${encodeURIComponent(ref.bvid)}`
            : `aid=${encodeURIComponent(ref.aid ?? "")}`;
          const viewResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, { credentials: "include" });
          const view = await viewResponse.json() as ApiResponse<ViewData>;
          if (!viewResponse.ok || view.code !== 0 || !view.data) throw new Error("无法读取 Bilibili 视频信息");

          const viewData = view.data;
          if (ref.bvid && viewData.bvid && viewData.bvid.toUpperCase() !== ref.bvid.toUpperCase()) {
            throw new Error("Bilibili 视频 ID 与页面地址不一致");
          }
          const pages = Array.isArray(viewData.pages) ? viewData.pages : [];
          const initialState = (window as unknown as { __INITIAL_STATE__?: InitialState }).__INITIAL_STATE__;
          const currentCid = initialState?.videoData?.cid;
          const requestedPage = ref.pageNumber;
          const selectedPage = requestedPage !== undefined
            ? pages.find((page) => Number(page.page) === requestedPage)
            : (currentCid !== undefined ? pages.find((page) => String(page.cid) === String(currentCid)) : undefined);
          const page = selectedPage ?? pages[0] ?? (viewData.cid !== undefined ? { cid: viewData.cid } : undefined);
          const cid = page?.cid ?? viewData.cid;
          const aid = viewData.aid ?? initialState?.videoData?.aid;
          if (cid === undefined || aid === undefined) throw new Error("无法确定 Bilibili 当前分 P");

          // Bilibili documents aid and bvid as alternatives, not a combined
          // identity. Prefer the numeric aid returned by view (this is also
          // what yt-dlp uses for logged-in subtitle lookup), and fall back to
          // bvid only when an aid was not returned.
          const playerIdentity = aid !== undefined
            ? `aid=${encodeURIComponent(String(aid))}`
            : `bvid=${encodeURIComponent(ref.bvid ?? "")}`;
          const playerQuery = `${playerIdentity}&cid=${encodeURIComponent(String(cid))}`;
          let tracks: BilibiliSubtitleTrack[] = [];
          for (let attempt = 0; attempt < 2 && tracks.length === 0; attempt += 1) {
            for (const endpoint of ["x/player/v2", "x/player/wbi/v2"]) {
              try {
                const cacheBust = attempt > 0 ? `&_=${Date.now()}` : "";
                const playerResponse = await fetch(`https://api.bilibili.com/${endpoint}?${playerQuery}${cacheBust}`, { credentials: "include" });
                const player = await playerResponse.json() as ApiResponse<{
                  bvid?: string;
                  aid?: number | string;
                  cid?: number | string;
                  subtitle?: { subtitles?: BilibiliSubtitleTrack[] };
                }>;
                const playerData = player.data;
                const identityMismatch = Boolean(
                  (ref.bvid && playerData?.bvid && playerData.bvid.toUpperCase() !== ref.bvid.toUpperCase())
                  || (playerData?.aid !== undefined && String(playerData.aid) !== String(aid))
                  || (playerData?.cid !== undefined && String(playerData.cid) !== String(cid)),
                );
                if (identityMismatch) throw new Error("Bilibili 字幕接口返回了不匹配的视频");
                const candidateTracks = Array.isArray(playerData?.subtitle?.subtitles)
                  ? playerData.subtitle.subtitles
                  : [];
                // The legacy endpoint can return language placeholders whose
                // subtitle_url is empty. Keep trying the WBI endpoint instead
                // of treating those placeholders as downloadable subtitles.
                if (candidateTracks.some((track) => Boolean(track.subtitle_url))) {
                  tracks = candidateTracks;
                  break;
                }
              } catch (error) {
                if (error instanceof Error && error.message === "Bilibili 字幕接口返回了不匹配的视频") throw error;
                // The legacy endpoint is still useful for logged-in pages; WBI is a best-effort fallback.
              }
            }
            if (tracks.length === 0 && attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
          }

          const selectedTrack = tracks
            .filter((track) => Boolean(track.subtitle_url))
            .sort((a, b) => {
              const score = (track: BilibiliSubtitleTrack) => {
                const language = `${track.lan ?? ""} ${track.lan_doc ?? ""}`.toLowerCase();
                let result = Boolean(track.ai_type) || /^ai[-_]/i.test(track.lan ?? "") ? 0 : 100;
                if (/zh[-_ ]?(cn|hans|简|中)/i.test(language)) result += 4;
                else if (/zh[-_ ]?(tw|hant|繁)/i.test(language)) result += 3;
                else if (/\ben\b|英/.test(language)) result += 2;
                return result;
              };
              return score(b) - score(a);
            })[0];

          let subtitles = "";
          let subtitleDuration: number | undefined;
          let subtitleRejectedReason: string | undefined;
          if (selectedTrack?.subtitle_url) {
            // The signed subtitle URL is served with Access-Control-Allow-Origin: *.
            // Sending credentials here makes the browser reject the response even
            // though the URL itself already carries its auth_key.
            const subtitleResponse = await fetch(new URL(selectedTrack.subtitle_url, pageUrl).href, { credentials: "omit" });
            if (subtitleResponse.ok) {
              const subtitle = await subtitleResponse.json() as { body?: Array<{ from?: number; to?: number; content?: string }> };
              if (Array.isArray(subtitle.body)) {
                subtitleDuration = subtitle.body.reduce((latest, item) => Math.max(latest, Number(item.to ?? item.from ?? 0)), 0);
                subtitles = subtitle.body.map((item) => item.content?.trim() ?? "").filter(Boolean).join("\n");
              }
            }
          }

          const videoDuration = Number(page?.duration ?? viewData.duration ?? 0) || undefined;
          const subtitleLooksMismatched = Boolean(
            videoDuration && subtitleDuration
            && videoDuration >= 300
            && subtitleDuration < videoDuration * 0.7
            && videoDuration - subtitleDuration >= 180,
          );
          if (subtitles && subtitleLooksMismatched) {
            subtitleRejectedReason = `B 站字幕时间轴仅覆盖约 ${Math.round(subtitleDuration ?? 0)} 秒，但视频时长为 ${Math.round(videoDuration ?? 0)} 秒，已忽略疑似错配字幕`;
            subtitles = "";
          }

          const selectedPageNumber = page?.page ?? (pages.length === 1 ? 1 : undefined);
          const selectionWarning = requestedPage !== undefined && selectedPageNumber !== requestedPage
            ? `URL 指定第 ${requestedPage} P，但页面数据中未找到该分 P，已使用第 ${selectedPageNumber ?? 1} P。`
            : undefined;
          const baseTitle = viewData.title ?? "Bilibili 视频";
          const title = page?.part && pages.length > 1 ? `${baseTitle} - ${page.part}` : baseTitle;
          const pageText = [
            document.querySelector("meta[name='description']")?.getAttribute("content") ?? "",
            ...["#viewbox_report", ".video-desc", ".basic-desc-info", ".bpx-player-subtitle-panel", ".bpx-player-subtitle-wrap"]
              .map((selector) => document.querySelector(selector)?.textContent ?? ""),
          ].map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
          return {
            title,
            description: viewData.desc ?? "",
            subtitles,
            pageText,
            pageNumber: requestedPage,
            selectedPage: selectedPageNumber,
            pageCount: pages.length,
            subtitleLanguage: selectedTrack?.lan,
            subtitleIsAi: selectedTrack ? (Boolean(selectedTrack.ai_type) || /^ai[-_]/i.test(selectedTrack.lan ?? "")) : undefined,
            subtitleDuration,
            subtitleRejectedReason,
            selectionWarning,
          } satisfies BilibiliScriptResult;
        },
        args: [videoRef, context.url],
      });
      value = result[0]?.result;
    } catch (error) {
      throw new AppError("extraction-failed", "无法读取 Bilibili 字幕或页面内容", { cause: error });
    }
    if (!value) throw new AppError("extraction-failed", "无法读取 Bilibili 视频内容");

    const metadata = `# ${value.title}\n\n${value.description}`.trim();
    const markdown = value.subtitles
      ? `${metadata}\n\n## 视频文稿\n\n${value.subtitles}`.trim()
      : `${metadata}\n\n${value.pageText.trim()}`.trim();
    const warnings = [
      ...(value.selectionWarning ? [value.selectionWarning] : []),
      ...(value.subtitleRejectedReason ? [value.subtitleRejectedReason] : []),
      ...(value.subtitles && value.subtitleIsAi ? ["本次使用 B 站 AI 中文字幕，可能存在明显识别错误，请结合原视频核对"] : []),
      ...(value.subtitles ? [] : ["B 站没有返回可用字幕（可能未使用当前页面登录态或视频未提供字幕），仅使用当前视频简介/播放器文本作为降级内容"]),
    ];
    return {
      kind: "bilibili",
      title: value.title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: markdown ? new File([markdown], `${safeFilename(value.title)}.md`, { type: "text/markdown" }) : undefined,
      warnings,
    };
  }
}
