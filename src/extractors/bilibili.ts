import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import { parseBilibiliVideoUrl } from "../domain/bilibili";
import type { BilibiliVideoRef } from "../domain/bilibili";
import type { ContentExtractor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { requestBilibiliSubtitle, type BilibiliSubtitleFetchResponse } from "../platform/chrome/bilibili";
import { safeFilename } from "../shared/filename";

// Keep the existing public test/import surface stable while the shared helpers
// are also used by the background subtitle client.
export {
  chooseBilibiliSubtitleTrack,
  isLikelyMismatchedBilibiliSubtitle,
  parseBilibiliVideoUrl,
  selectBilibiliPage,
} from "../domain/bilibili";
export type { BilibiliPage, BilibiliSubtitleTrack, BilibiliVideoRef } from "../domain/bilibili";

interface BilibiliPageSnapshot {
  title: string;
  description: string;
  pageText: string;
  comments: string[];
  currentCid?: number | string;
}

export function formatBilibiliCommentSection(comments: string[]): string {
  if (!comments.length) return "";
  return `## 评论区摘录（仅部分评论，不代表视频正文）\n\n${comments.map((comment, index) => `${index + 1}. ${comment}`).join("\n")}`;
}

export class BilibiliExtractor implements ContentExtractor {
  readonly id = "bilibili" as const;

  canHandle(context: PageContext): boolean {
    return Boolean(parseBilibiliVideoUrl(context.url));
  }

  async extract(context: PageContext): Promise<ExtractedDocument> {
    const videoRef = parseBilibiliVideoUrl(context.url);
    if (!videoRef) throw new AppError("unsupported-page", "无效的 Bilibili 视频地址");

    let page: BilibiliPageSnapshot | undefined;
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        world: "MAIN",
        func: async (ref: BilibiliVideoRef): Promise<BilibiliPageSnapshot> => {
          type InitialState = { videoData?: { bvid?: string; aid?: number | string; cid?: number | string } };

          // A side panel can open while Bilibili is still changing its SPA route.
          // Only inspect the page after its route/state has caught up.
          if (ref.bvid) {
            const expectedBvid = ref.bvid.toUpperCase();
            for (let attempt = 0; attempt < 10; attempt += 1) {
              const routeBvid = /\/video\/(BV[0-9A-Za-z]+)/i.exec(location.pathname)?.[1]?.toUpperCase();
              const stateBvid = (window as unknown as { __INITIAL_STATE__?: InitialState }).__INITIAL_STATE__?.videoData?.bvid?.toUpperCase();
              if (routeBvid === expectedBvid && (!stateBvid || stateBvid === expectedBvid)) break;
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }

          const state = (window as unknown as { __INITIAL_STATE__?: InitialState }).__INITIAL_STATE__;
          const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
          const description = normalize(document.querySelector("meta[name='description']")?.getAttribute("content") ?? "");
          const pageText = [
            ...["#viewbox_report", ".video-desc", ".basic-desc-info", ".bpx-player-subtitle-panel", ".bpx-player-subtitle-wrap"]
              .map((selector) => document.querySelector(selector)?.textContent ?? ""),
          ].map(normalize).filter(Boolean).join("\n\n");

          const commentRoot = document.querySelector("#comment, #commentapp, .comment-container");
          const commentSelectors = [
            ".root-reply-container .reply-content",
            ".reply-item .reply-content",
            ".reply-content",
            "[class*='reply-content']",
          ];
          const comments: string[] = [];
          const seen = new Set<string>();
          if (commentRoot) {
            for (const selector of commentSelectors) {
              for (const node of commentRoot.querySelectorAll(selector)) {
                const element = node as HTMLElement;
                if (!element.getClientRects().length) continue;
                const text = normalize(element.innerText || element.textContent || "");
                if (!text || seen.has(text)) continue;
                seen.add(text);
                comments.push(text.slice(0, 320));
                if (comments.length >= 12) break;
              }
              if (comments.length >= 12) break;
            }
          }

          return {
            title: normalize(document.title) || "Bilibili 视频",
            description,
            pageText,
            comments,
            currentCid: state?.videoData?.cid,
          };
        },
        args: [videoRef],
      });
      page = result[0]?.result;
    } catch (error) {
      throw new AppError("extraction-failed", "无法读取 Bilibili 页面内容", { cause: error });
    }
    if (!page) throw new AppError("extraction-failed", "无法读取 Bilibili 页面内容");

    let subtitles: BilibiliSubtitleFetchResponse;
    try {
      subtitles = await requestBilibiliSubtitle({ videoRef, currentCid: page.currentCid });
    } catch (error) {
      throw new AppError("extraction-failed", "无法读取 Bilibili 字幕接口", { cause: error });
    }

    const title = subtitles.title || page.title || context.title || "Bilibili 视频";
    const description = subtitles.description?.trim() || page.description.trim();
    const metadata = [`# ${title}`, description].filter(Boolean).join("\n\n").trim();
    const commentSection = subtitles.subtitles ? "" : formatBilibiliCommentSection(page.comments);
    const fallbackSections = [metadata, page.pageText.trim(), commentSection].filter(Boolean);
    const markdown = subtitles.subtitles
      ? `${metadata}\n\n## 视频文稿\n\n${subtitles.subtitles}`.trim()
      : fallbackSections.join("\n\n").trim();

    const warnings = [
      ...(subtitles.selectedPage !== undefined && videoRef.pageNumber !== undefined && subtitles.selectedPage !== videoRef.pageNumber
        ? [`URL 指定第 ${videoRef.pageNumber} P，但页面数据中未找到该分 P，已使用第 ${subtitles.selectedPage} P。`]
        : []),
      ...(subtitles.subtitleRejectedReason ? [subtitles.subtitleRejectedReason] : []),
      ...(subtitles.subtitles && subtitles.subtitleIsAi ? ["本次使用 B 站 AI 中文字幕，可能存在明显识别错误，请结合原视频核对"] : []),
      ...(!subtitles.subtitles
        ? [
            subtitles.loginState === "logged-out"
              ? "B 站当前浏览器会话未登录，AI 字幕可能不可用"
              : subtitles.loginState === "unknown"
                ? "未能确认 B 站登录态，字幕结果可能受浏览器权限或 Cookie 限制"
                : "B 站没有返回可用字幕",
            ...(subtitles.unavailableReason ? [`字幕获取路径：${subtitles.unavailableReason}`] : []),
            ...(page.comments.length ? ["未获取到字幕，已补充页面可见评论区的少量摘录；评论不代表视频正文"] : []),
          ]
        : []),
    ];

    return {
      kind: "bilibili",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: markdown ? new File([markdown], `${safeFilename(title)}.md`, { type: "text/markdown" }) : undefined,
      warnings,
    };
  }
}
