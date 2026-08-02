import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import {
  chooseYoutubeCaptionTrack,
  isYoutubeCaptionUrlPoTokenGated,
  isYoutubePageUrl,
  parseYoutubeTranscript,
  stripYoutubeCaptionFormat,
  type YoutubeCaptionTrack,
} from "../domain/youtube";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";

interface YoutubePageSnapshot {
  title: string;
  description: string;
  tracks: YoutubeCaptionTrack[];
  captionRequestUrls: string[];
  playabilityStatus?: string;
  playabilityReason?: string;
}

interface YoutubePlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YoutubeCaptionTrack[];
    };
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    title?: string;
    shortDescription?: string;
  };
}

// `chrome.scripting.executeScript` rejects `undefined` values inside args.
// Keep the format list explicit so every injected argument is serializable.
type YoutubeCaptionFormat = "json3" | "srv1" | "srv2" | "srv3" | "ttml" | "srt" | "vtt" | "strip-format" | null;
const YOUTUBE_CAPTION_FORMATS: readonly YoutubeCaptionFormat[] = [
  // BiliNote/youtube-transcript-api remove a preselected fmt before fetching.
  // Keep the original URL as the second attempt, then ask for the formats that
  // yt-dlp exposes. Never rebuild the full signed URL with URLSearchParams.
  "strip-format", null, "json3", "vtt", "ttml", "srt", "srv1", "srv2", "srv3",
];

interface YoutubeCaptionPayload {
  body: string;
  status: number;
  contentType: string;
}

export {
  chooseYoutubeCaptionTrack,
  isYoutubeCaptionUrlPoTokenGated,
  parseYoutubeTranscript,
  stripYoutubeCaptionFormat,
} from "../domain/youtube";
export type { YoutubeCaptionTrack } from "../domain/youtube";

export class YoutubeExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "youtube",
    label: "YouTube",
    outputKind: "youtube",
  };

  canHandle(context: PageContext): boolean {
    return isYoutubePageUrl(context.url);
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);

    let page: YoutubePageSnapshot | undefined;
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        world: "MAIN",
        func: async (): Promise<YoutubePageSnapshot> => {
          type YoutubeWindow = Window & {
            ytInitialPlayerResponse?: YoutubePlayerResponse;
            ytplayer?: {
              config?: {
                args?: { player_response?: string };
                player_response?: string;
              };
            };
            ytcfg?: {
              get?: (key: string) => unknown;
              data_?: Record<string, unknown>;
            };
          };

          const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
          const parsePlayerResponse = (value: string | undefined): YoutubePlayerResponse | undefined => {
            if (!value) return undefined;
            try {
              const parsed: unknown = JSON.parse(value);
              return parsed && typeof parsed === "object" ? parsed as YoutubePlayerResponse : undefined;
            } catch {
              return undefined;
            }
          };

          const win = window as YoutubeWindow;
          const pageUrl = new URL(location.href);
          const videoId = pageUrl.searchParams.get("v")
            ?? pageUrl.pathname.match(/\/(?:shorts|live|embed)\/([^/?]+)/)?.[1]
            ?? (pageUrl.hostname === "youtu.be" ? pageUrl.pathname.slice(1).split("/")[0] : undefined);
          const app = document.querySelector("ytd-app") as (HTMLElement & { data?: { playerResponse?: YoutubePlayerResponse } }) | null;
          const config = win.ytplayer?.config;
          let playerResponses = [
            app?.data?.playerResponse,
            win.ytInitialPlayerResponse,
            parsePlayerResponse(config?.args?.player_response),
            parsePlayerResponse(config?.player_response),
          ].filter((response): response is YoutubePlayerResponse => Boolean(response));

          const collectTracks = (responses: readonly YoutubePlayerResponse[]): YoutubeCaptionTrack[] => {
            const tracks: YoutubeCaptionTrack[] = [];
            const seenTrackUrls = new Set<string>();
            for (const response of responses) {
              for (const track of response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []) {
                if (!track.baseUrl || seenTrackUrls.has(track.baseUrl)) continue;
                seenTrackUrls.add(track.baseUrl);
                tracks.push(track);
              }
            }
            return tracks;
          };

          let tracks = collectTracks(playerResponses);
          if (!tracks.length) {
            const readYtcfg = (key: string): unknown => {
              try {
                if (typeof win.ytcfg?.get === "function") return win.ytcfg.get(key);
              } catch {
                // Fall through to the data snapshot below.
              }
              return win.ytcfg?.data_?.[key];
            };
            const apiKey = readYtcfg("INNERTUBE_API_KEY");
            const configuredContext = readYtcfg("INNERTUBE_CONTEXT");
            const clientName = readYtcfg("INNERTUBE_CLIENT_NAME");
            const clientVersion = readYtcfg("INNERTUBE_CLIENT_VERSION");
            const context = configuredContext && typeof configuredContext === "object"
              ? configuredContext
              : typeof clientName === "string" && typeof clientVersion === "string"
                ? { client: { clientName, clientVersion } }
                : undefined;
            if (typeof apiKey === "string" && context && videoId) {
              try {
                const headers: Record<string, string> = { "Content-Type": "application/json" };
                if (typeof clientName === "string") headers["X-YouTube-Client-Name"] = clientName;
                if (typeof clientVersion === "string") headers["X-YouTube-Client-Version"] = clientVersion;
                const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
                  method: "POST",
                  credentials: "include",
                  headers,
                  body: JSON.stringify({ context, videoId }),
                });
                if (response.ok) {
                  const fallback = await response.json() as unknown;
                  if (fallback && typeof fallback === "object") {
                    playerResponses = [...playerResponses, fallback as YoutubePlayerResponse];
                    tracks = collectTracks(playerResponses);
                  }
                }
              } catch {
                // The page snapshot is still useful when InnerTube is blocked.
              }
            }
          }

          const descriptionCandidates = [
            ...playerResponses.map((response) => response.videoDetails?.shortDescription ?? ""),
            document.querySelector("meta[name='description']")?.getAttribute("content") ?? "",
            document.querySelector("meta[itemprop='description']")?.getAttribute("content") ?? "",
            ...["#description-inline-expander", "ytd-watch-metadata #description", "ytd-video-primary-info-renderer"]
              .map((selector) => document.querySelector(selector)?.textContent ?? ""),
          ].map(normalize).filter(Boolean);
          const description = [...new Set(descriptionCandidates)].join("\n\n");
          const title = normalize(
            playerResponses.find((response) => response.videoDetails?.title)?.videoDetails?.title
              ?? document.querySelector("h1.ytd-watch-metadata")?.textContent
              ?? document.title,
          );
          const playability = playerResponses.find((response) => response.playabilityStatus?.status)?.playabilityStatus;
          const captionRequestUrls = videoId
            ? [...new Set(performance.getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter((value) => {
                try {
                  const resourceUrl = new URL(value);
                  return /\/api\/timedtext$/i.test(resourceUrl.pathname)
                    && resourceUrl.searchParams.get("v") === videoId;
                } catch {
                  return false;
                }
              }))].slice(-12)
            : [];

          return {
            title,
            description,
            tracks,
            captionRequestUrls,
            playabilityStatus: playability?.status,
            playabilityReason: playability?.reason,
          };
        },
      });
      page = result[0]?.result;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError("extraction-failed", "无法读取 YouTube 播放器数据或页面内容", { cause: error });
    }
    if (!page) throw new AppError("extraction-failed", "无法读取 YouTube 视频信息");

    const track = chooseYoutubeCaptionTrack(page.tracks);
    let transcript = "";
    let captionRequestSucceeded = false;
    let lastCaptionError: unknown;
    let lastCaptionDiagnostic = "";
    const triedTrackUrls = new Set<string>();
    const tryCaptionTrack = async (candidate: YoutubeCaptionTrack | undefined): Promise<void> => {
      if (!candidate?.baseUrl || triedTrackUrls.has(candidate.baseUrl) || transcript) return;
      triedTrackUrls.add(candidate.baseUrl);
      const formats = isYoutubeCaptionUrlPoTokenGated(candidate.baseUrl)
        ? (YOUTUBE_CAPTION_FORMATS.includes("strip-format") ? ["strip-format", null] as const : YOUTUBE_CAPTION_FORMATS)
        : YOUTUBE_CAPTION_FORMATS;
      for (const format of formats) {
        throwIfAborted(signal);
        try {
          const payload = await fetchYoutubeCaptionPayload(context.tabId, candidate.baseUrl, format);
          captionRequestSucceeded = true;
          transcript = parseYoutubeTranscript(payload.body);
          if (transcript) return;
          lastCaptionDiagnostic = describeYoutubeCaptionResponse(payload, candidate.baseUrl, format);
        } catch (error) {
          lastCaptionError = error;
        }
      }
    };

    // If the player has already fetched captions for the current video, the
    // Performance timeline may contain the exact URL with YouTube's page-made
    // PO token. Reuse that URL before touching the unsigned baseUrl.
    for (const captionRequestUrl of page.captionRequestUrls) {
      await tryCaptionTrack({ baseUrl: captionRequestUrl });
      if (transcript) break;
    }
    await tryCaptionTrack(track);
    if (!transcript && (track || page.captionRequestUrls.length > 0)) {
      // The web client can expose a real caption track whose timedtext URL is
      // PO-token gated. YouTube's own transcript panel already has the token
      // and renders the complete transcript in the page, so use that as the
      // browser-native fallback before trying other InnerTube clients.
      try {
        transcript = await fetchYoutubeTranscriptFromPage(context.tabId);
      } catch (error) {
        lastCaptionError = error;
      }
    }
    if (!transcript && track) {
      try {
        // YouTube may expose a web caption track that requires a PO Token while
        // another player client exposes the same subtitles as a plain URL.
        const fallbackTracks = await fetchYoutubeAlternativeCaptionTracks(context.tabId);
        for (const fallbackTrack of fallbackTracks) {
          await tryCaptionTrack(fallbackTrack);
          if (transcript) break;
        }
      } catch (error) {
        lastCaptionError = error;
      }
    }

    const title = page.title || context.title || "YouTube 视频";
    const metadata = [`# ${title}`, page.description.trim()].filter(Boolean).join("\n\n").trim();
    const markdown = transcript ? `${metadata}\n\n## 视频文稿\n\n${transcript}`.trim() : metadata;
    const warnings = buildYoutubeWarnings(page, track, transcript, captionRequestSucceeded, lastCaptionError, lastCaptionDiagnostic);
    return {
      kind: "youtube",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: transcript ? new File([markdown], `${safeFilename(title)}.md`, { type: "text/markdown" }) : undefined,
      warnings,
    };
  }
}

async function fetchYoutubeCaptionPayload(
  tabId: number,
  baseUrl: string,
  format: YoutubeCaptionFormat,
): Promise<YoutubeCaptionPayload> {
  const serializedBaseUrl = format === "strip-format" ? stripYoutubeCaptionFormat(baseUrl) : baseUrl;
  const result = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (url: string, requestedFormat: YoutubeCaptionFormat): Promise<YoutubeCaptionPayload> => {
      // Preserve the signed URL byte-for-byte. Only remove/replace fmt for
      // fallback formats; avoid URLSearchParams because it re-serializes
      // signed query values and YouTube can then return an empty 200 response.
      let targetUrl = requestedFormat === "strip-format"
        ? url.replace(/([?&])fmt=[^&#]*/i, "").replace("?&", "?").replace(/[?&]$/, "")
        : url;
      if (requestedFormat && requestedFormat !== "strip-format") {
        const encodedFormat = encodeURIComponent(requestedFormat);
        const formatPattern = /([?&])fmt=[^&]*/i;
        targetUrl = formatPattern.test(targetUrl)
          ? targetUrl.replace(formatPattern, `$1fmt=${encodedFormat}`)
          : `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}fmt=${encodedFormat}`;
      }
      const target = new URL(targetUrl, location.href);
      const credentials = target.origin === location.origin ? "include" : "omit";
      // Use the raw string for fetch as well; `URL#href` can normalize an
      // otherwise valid signed query before it reaches YouTube.
      const response = await fetch(targetUrl, {
        credentials,
        headers: {
          Accept: "text/plain, text/vtt, application/xml, application/json;q=0.9, */*;q=0.8",
          "Accept-Language": document.documentElement.lang || navigator.language || "en-US",
        },
      });
      if (!response.ok) throw new Error(`YouTube 字幕请求失败（HTTP ${response.status}）`);
      return {
        body: await response.text(),
        status: response.status,
        contentType: response.headers.get("content-type") || "",
      };
    },
    args: [serializedBaseUrl, format],
  });
  const payload = result[0]?.result;
  if (!payload || typeof payload !== "object" || typeof payload.body !== "string") {
    throw new Error("YouTube 字幕响应为空");
  }
  return payload;
}

/**
 * Read YouTube's own transcript panel. This is the important browser fallback
 * for current web tracks: the page can mint/use the PO token internally, while
 * an extension-created fetch of the same baseUrl cannot.
 */
async function fetchYoutubeTranscriptFromPage(tabId: number): Promise<string> {
  const result = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (): Promise<string> => {
      const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const visible = (element: Element): boolean => Boolean((element as HTMLElement).getClientRects().length);

      function* walk(root: Document | Element | ShadowRoot): Generator<Element> {
        if (root instanceof Element) {
          yield root;
          if (root.shadowRoot) yield* walk(root.shadowRoot);
        }
        for (const child of Array.from(root.children)) yield* walk(child);
      }

      const deepElements = (): Element[] => Array.from(walk(document));
      const elementText = (element: Element | undefined): string => {
        if (!element) return "";
        const candidate = element as HTMLElement;
        return normalize(candidate.innerText || element.textContent || "");
      };
      const parseTimestamp = (value: string): number | undefined => {
        const match = value.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s|$)/);
        if (!match) return undefined;
        const parts = match[1].split(":").map(Number);
        if (parts.some((part) => !Number.isFinite(part))) return undefined;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0];
      };
      const formatSeconds = (value: number): string => String(Number(value.toFixed(3)));
      const classContains = (element: Element, value: string): boolean => String((element as HTMLElement).className || "").toLowerCase().includes(value);

      const readTranscriptRows = (): string => {
        const elements = deepElements();
        const rows = elements.filter((element) => {
          const tag = element.tagName.toLowerCase();
          return tag === "ytd-transcript-segment-renderer"
            || tag === "transcript-segment-view-model"
            || classContains(element, "transcript-segment");
        });
        const seen = new Set<string>();
        const lines: Array<{ start: number; text: string }> = [];
        for (const row of rows) {
          const descendants = [row, ...Array.from(walk(row))];
          const textElement = descendants.find((element) => classContains(element, "segment-text"));
          const timestampElement = descendants.find((element) =>
            classContains(element, "segment-timestamp")
              || classContains(element, "cue-group-start-offset")
              || classContains(element, "start-offset"),
          );
          const timestampText = elementText(timestampElement) || elementText(row);
          const start = parseTimestamp(timestampText);
          if (start === undefined) continue;

          let text = elementText(textElement);
          if (!text) {
            const rawText = (row as HTMLElement).innerText || row.textContent || "";
            const inline = rawText.match(/^\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s+([\s\S]+)$/);
            if (inline) text = normalize(inline[1]);
            const rawLines = rawText
              .split(/\r?\n/)
              .map(normalize)
              .filter(Boolean);
            if (!text) text = rawLines.filter((line) => parseTimestamp(line) === undefined).join(" ");
          }
          if (!text || parseTimestamp(text) !== undefined) continue;
          const key = `${start}|${text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push({ start, text });
        }
        lines.sort((left, right) => left.start - right.start);
        return lines.map((line) => `[${formatSeconds(line.start)}] ${line.text}`).join("\n");
      };

      const clickTranscriptEntry = async (): Promise<void> => {
        const expand = document.querySelector("#expand, tp-yt-paper-button#expand, [aria-label='Show more'], [aria-label*='Show more']");
        if (expand && visible(expand)) {
          (expand as HTMLElement).click();
          await sleep(300);
        }

        const descriptionTranscript = document.querySelector("ytd-video-description-transcript-section-renderer");
        if (descriptionTranscript) {
          const button = descriptionTranscript.querySelector("button, yt-button-shape, [role='button']") as HTMLElement | null;
          (button || descriptionTranscript as HTMLElement).click();
          await sleep(700);
          if (readTranscriptRows()) return;
        }

        const transcriptButtons = deepElements().filter((element) => {
          if (element.tagName.toLowerCase() !== "button" || !visible(element)) return false;
          const label = normalize(element.getAttribute("aria-label") || "").toLowerCase();
          const text = elementText(element).toLowerCase();
          return label.includes("transcript") || label.includes("字幕") || label.includes("文字记录")
            || text.includes("transcript") || text.includes("字幕") || text.includes("文字记录");
        });
        for (const button of transcriptButtons) {
          (button as HTMLElement).click();
          await sleep(700);
          if (readTranscriptRows()) return;
        }

        const moreButton = deepElements().find((element) => {
          if (element.tagName.toLowerCase() !== "button" || !visible(element)) return false;
          const label = normalize(element.getAttribute("aria-label") || "").toLowerCase();
          return label.includes("more actions") || label === "more" || label.includes("更多");
        });
        if (moreButton) {
          (moreButton as HTMLElement).click();
          await sleep(400);
          const menuItem = deepElements().find((element) => {
            const tag = element.tagName.toLowerCase();
            if (!visible(element) || !["ytd-menu-service-item-renderer", "tp-yt-paper-item", "ytd-menu-navigation-item-renderer"].includes(tag)) return false;
            const text = elementText(element).toLowerCase();
            const html = element.outerHTML.toLowerCase();
            return text.includes("transcript") || text.includes("字幕") || text.includes("文字记录")
              || html.includes("searchable-transcript") || html.includes("gettranscriptendpoint");
          });
          if (menuItem) {
            (menuItem as HTMLElement).click();
            await sleep(700);
          }
        }
      };

      const scrollTranscript = async (): Promise<string> => {
        const containers = deepElements().filter((element) => element.id === "segments-container");
        const collected = new Map<string, { start: number; text: string }>();
        const collect = () => {
          const raw = readTranscriptRows();
          for (const line of raw.split("\n")) {
            const match = line.match(/^\[([^\]]+)\]\s+(.+)$/);
            if (!match) continue;
            const start = Number(match[1]);
            if (Number.isFinite(start)) collected.set(`${start}|${match[2]}`, { start, text: match[2] });
          }
        };

        if (!containers.length) return readTranscriptRows();
        for (const container of containers.slice(0, 2)) {
          let stablePasses = 0;
          let previousCount = 0;
          for (let attempt = 0; attempt < 18; attempt += 1) {
            collect();
            const currentCount = collected.size;
            (container as HTMLElement).scrollTop = (container as HTMLElement).scrollHeight;
            await sleep(100);
            if (currentCount === previousCount) stablePasses += 1;
            else stablePasses = 0;
            previousCount = currentCount;
            if (stablePasses >= 2) break;
          }
        }
        return Array.from(collected.values())
          .sort((left, right) => left.start - right.start)
          .map((line) => `[${formatSeconds(line.start)}] ${line.text}`)
          .join("\n");
      };

      let transcript = await scrollTranscript();
      if (transcript) return transcript;
      await clickTranscriptEntry();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        transcript = await scrollTranscript();
        if (transcript) return transcript;
        await sleep(300);
      }
      return "";
    },
  });
  const transcript = result[0]?.result;
  return typeof transcript === "string" ? transcript : "";
}

function describeYoutubeCaptionResponse(
  payload: YoutubeCaptionPayload,
  baseUrl: string,
  format: YoutubeCaptionFormat,
): string {
  const formatLabel = format === "strip-format" ? "原始格式" : format || "轨道默认格式";
  if (!payload.body.trim()) {
    return isYoutubeCaptionUrlPoTokenGated(baseUrl)
      ? `字幕 HTTP ${payload.status} 返回空正文（${formatLabel}；该 Web 字幕轨需要 PO Token）`
      : `字幕 HTTP ${payload.status} 返回空正文（${formatLabel}）`;
  }
  const contentType = payload.contentType || "未知 Content-Type";
  return `字幕 HTTP ${payload.status} 返回 ${contentType}（${payload.body.length.toLocaleString()} 字符；${formatLabel}），解析器未识别`;
}

async function fetchYoutubeAlternativeCaptionTracks(tabId: number): Promise<YoutubeCaptionTrack[]> {
  const result = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (): Promise<YoutubeCaptionTrack[]> => {
      type YoutubeWindow = Window & {
        ytcfg?: {
          get?: (key: string) => unknown;
          data_?: Record<string, unknown>;
        };
      };

      const win = window as YoutubeWindow;
      const readYtcfg = (key: string): unknown => {
        try {
          if (typeof win.ytcfg?.get === "function") return win.ytcfg.get(key);
        } catch {
          // Fall through to the data snapshot below.
        }
        return win.ytcfg?.data_?.[key];
      };

      const apiKey = readYtcfg("INNERTUBE_API_KEY");
      const configuredContext = readYtcfg("INNERTUBE_CONTEXT");
      const url = new URL(location.href);
      const videoId = url.searchParams.get("v")
        ?? url.pathname.match(/\/(?:shorts|live|embed)\/([^/?]+)/)?.[1]
        ?? (url.hostname === "youtu.be" ? url.pathname.slice(1).split("/")[0] : undefined);
      if (typeof apiKey !== "string" || !videoId) return [];

      const baseContext = configuredContext && typeof configuredContext === "object"
        ? configuredContext as Record<string, unknown>
        : {};
      const baseClient = baseContext.client && typeof baseContext.client === "object"
        ? baseContext.client as Record<string, unknown>
        : {};
      const clients = [
        {
          clientName: "ANDROID_VR",
          clientVersion: "1.65.10",
          headerName: 28,
          deviceMake: "Oculus",
          deviceModel: "Quest 3",
          androidSdkVersion: 32,
          userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
          osName: "Android",
          osVersion: "12L",
        },
        {
          clientName: "IOS",
          clientVersion: "21.26.4",
          headerName: 5,
          deviceMake: "Apple",
          deviceModel: "iPhone16,2",
          userAgent: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
          osName: "iPhone",
          osVersion: "18.3.2.22D82",
        },
        {
          clientName: "TVHTML5",
          clientVersion: "7.20260707.07.00",
          headerName: 7,
          userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
        },
        {
          clientName: "VISIONOS",
          clientVersion: "1.02",
          headerName: 101,
          deviceMake: "Apple",
          deviceModel: "RealityDevice17,1",
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
          osName: "visionOS",
          osVersion: "26.5.23O471",
        },
      ];
      const tracks: YoutubeCaptionTrack[] = [];
      const seen = new Set<string>();
      for (const client of clients) {
        try {
          const { headerName, ...clientContext } = client;
          const context = {
            ...baseContext,
            client: {
              ...baseClient,
              ...clientContext,
            },
          };
          const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "X-YouTube-Client-Name": String(headerName),
              "X-YouTube-Client-Version": client.clientVersion,
            },
            body: JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true }),
          });
          if (!response.ok) continue;
          const payload = await response.json() as YoutubePlayerResponse;
          for (const track of payload.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []) {
            if (!track.baseUrl || seen.has(track.baseUrl)) continue;
            seen.add(track.baseUrl);
            tracks.push(track);
          }
        } catch {
          // Try the next client. One client being restricted should not hide
          // subtitles exposed by another client.
        }
      }
      return tracks;
    },
  });
  const tracks = result[0]?.result;
  return Array.isArray(tracks) ? tracks : [];
}

function buildYoutubeWarnings(
  page: YoutubePageSnapshot,
  track: YoutubeCaptionTrack | undefined,
  transcript: string,
  captionRequestSucceeded: boolean,
  captionError: unknown,
  captionDiagnostic: string,
): string[] {
  const warnings: string[] = [];
  if (page.playabilityStatus && page.playabilityStatus !== "OK") {
    warnings.push(`YouTube 播放状态异常：${page.playabilityReason || page.playabilityStatus}`);
  }
  if (transcript) return warnings;
  if (!track) {
    warnings.push("YouTube 没有返回可用字幕，仅使用当前视频标题/简介；云端转写尚未接入");
  } else if (!captionRequestSucceeded) {
    warnings.push("YouTube 已发现字幕轨，但当前页面会话无法读取字幕内容，仅使用当前视频标题/简介");
    if (captionError instanceof Error && captionError.message) warnings.push(`字幕读取详情：${captionError.message}`);
  } else {
    warnings.push("YouTube 已发现字幕轨，但字幕响应为空或格式暂不支持，仅使用当前视频标题/简介；云端转写尚未接入");
    if (captionDiagnostic) warnings.push(`字幕读取详情：${captionDiagnostic}`);
  }
  return warnings;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError("cancelled", "已取消");
}
