import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

export class YoutubeExtractor implements ContentExtractor {
  readonly id = "youtube" as const;

  canHandle(context: PageContext): boolean {
    return /(?:youtube\.com\/watch|youtu\.be\/)/i.test(context.url);
  }

  async extract(context: PageContext): Promise<ExtractedDocument> {
    let player: { title: string; tracks: CaptionTrack[]; pageText: string } | undefined;
    try {
      const playerResult = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        world: "MAIN",
        func: () => {
        const app = document.querySelector("ytd-app") as (HTMLElement & { data?: { playerResponse?: { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } } } }) | null;
        const tracks = app?.data?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        const pageText = [
          document.querySelector("meta[name='description']")?.getAttribute("content") ?? "",
          ...["#description-inline-expander", "ytd-watch-metadata #description", "ytd-video-primary-info-renderer"]
            .map((selector) => document.querySelector(selector)?.textContent ?? ""),
        ].map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
        return { title: document.title, tracks, pageText };
        },
      });
      player = playerResult[0]?.result;
    } catch (error) {
      throw new AppError("extraction-failed", "无法读取 YouTube 字幕或页面内容", { cause: error });
    }
    if (!player) throw new AppError("extraction-failed", "无法读取 YouTube 视频信息");
    const track = [...(player.tracks ?? [])].sort(compareTracks)[0];
    let transcript = "";
    if (track?.baseUrl) {
      let transcriptResult: Array<{ result?: unknown }>;
      try {
        transcriptResult = await browser.scripting.executeScript({
          target: { tabId: context.tabId },
          world: "MAIN",
          func: async (url: string) => {
            const target = new URL(url, location.href);
            // Same-origin timedtext requests can use the current YouTube page
            // session; signed cross-origin caption URLs must not receive
            // credentials because they commonly allow wildcard CORS.
            const credentials = target.origin === location.origin ? "include" : "omit";
            return fetch(target.href, { credentials }).then((response) => response.text());
          },
          args: [track.baseUrl],
        });
      } catch (error) {
        throw new AppError("extraction-failed", "无法读取 YouTube 字幕", { cause: error });
      }
      const xml = transcriptResult[0]?.result;
      if (typeof xml === "string") transcript = parseTranscript(xml);
    }
    const title = player.title || context.title || "YouTube 视频";
    const metadata = `# ${title}\n\n${player.pageText.trim()}`.trim();
    const markdown = transcript ? `${metadata}\n\n## 视频文稿\n\n${transcript}`.trim() : metadata;
    const warnings = transcript ? [] : ["YouTube 没有返回可用字幕，仅使用当前视频标题/简介；音频转写待优化"];
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

function compareTracks(a: CaptionTrack, b: CaptionTrack): number {
  return trackScore(b) - trackScore(a);
}

function trackScore(track: CaptionTrack): number {
  let score = track.kind === "asr" ? 0 : 100;
  if (track.languageCode === "zh-CN" || track.languageCode === "zh-Hans") score += 3;
  else if (track.languageCode === "zh-Hant") score += 2;
  else if (track.languageCode === "en") score += 1;
  return score;
}

function parseTranscript(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return [...doc.querySelectorAll("text")].map((node) => {
    const start = node.getAttribute("start") ?? "0";
    return `[${start}] ${(node.textContent ?? "").replace(/\s+/g, " ").trim()}`;
  }).filter(Boolean).join("\n");
}
