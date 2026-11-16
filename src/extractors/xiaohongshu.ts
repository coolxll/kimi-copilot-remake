import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { throwIfAborted, withAbort } from "../shared/abort";
import { uniqueImageUrls } from "../shared/image-links";
import { cleanInline, createMarkdownFile, formatDate } from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { WebpageExtractor } from "./webpage";

const XHS_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);

export interface XiaohongshuTarget {
  origin: string;
  noteId: string;
}

export interface XiaohongshuPageSnapshot {
  title: string;
  desc: string;
  author: string;
  publishTime?: string;
  likes?: string;
  collects?: string;
  tags: string[];
  imageUrls: string[];
  hasState: boolean;
}

export function parseXiaohongshuTargetUrl(rawUrl: string): XiaohongshuTarget | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !XHS_HOSTS.has(url.hostname.toLowerCase())) {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  // Matches /explore/{noteId}
  if (parts[0] === "explore" && parts[1] && parts.length === 2) {
    return { origin: url.origin, noteId: parts[1] };
  }
  // Matches /discovery/item/{noteId}
  if (parts[0] === "discovery" && parts[1] === "item" && parts[2] && parts.length === 3) {
    return { origin: url.origin, noteId: parts[2] };
  }
  return undefined;
}

export function formatXiaohongshuMarkdown(
  title: string,
  snapshot: XiaohongshuPageSnapshot,
  warnings: readonly string[],
): string {
  const metaItems = [
    snapshot.author ? `作者：@${cleanInline(snapshot.author)}` : "",
    snapshot.publishTime ? `发布时间：${formatDate(snapshot.publishTime)}` : "",
    snapshot.likes ? `${cleanInline(snapshot.likes)} 赞` : "",
    snapshot.collects ? `${cleanInline(snapshot.collects)} 收藏` : "",
  ].filter(Boolean);

  const sections: string[] = [`# ${title}`];
  if (metaItems.length) {
    sections.push(`> ${metaItems.join(" · ")}`);
  }

  const desc = snapshot.desc.trim();
  if (desc) {
    sections.push(desc);
  }

  if (snapshot.tags.length) {
    sections.push(`### 话题标签\n\n${snapshot.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`);
  }

  if (snapshot.imageUrls.length) {
    const imagesMd = snapshot.imageUrls
      .map((url, idx) => `![配图 ${idx + 1}](${url})`)
      .join("\n\n");
    sections.push(`### 笔记配图\n\n${imagesMd}`);
  }

  if (warnings.length) {
    sections.push(`---\n\n> 提取提示：${warnings.join("；")}`);
  }

  return sections.join("\n\n").trim();
}

export class XiaohongshuExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "xiaohongshu",
    label: "小红书",
    outputKind: "webpage",
  };

  private readonly fallbackExtractor = new WebpageExtractor();

  canHandle(context: PageContext): boolean {
    return Boolean(parseXiaohongshuTargetUrl(context.url));
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    const target = parseXiaohongshuTargetUrl(context.url);
    if (!target) throw new AppError("unsupported-page", "无效的小红书笔记地址");

    const warnings: string[] = [];
    let snapshot: XiaohongshuPageSnapshot | undefined;

    try {
      snapshot = await this.readPageSnapshot(context.tabId, target.noteId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push("小红书页面状态读取中断，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    if (!snapshot || (!snapshot.title && !snapshot.desc && !snapshot.imageUrls.length)) {
      warnings.push("小红书笔记未解析出有效正文，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    const title = snapshot.title || context.title || "小红书笔记";
    const markdown = formatXiaohongshuMarkdown(title, snapshot, warnings);
    const imageUrls = uniqueImageUrls(snapshot.imageUrls, context.url);

    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      imageUrls,
      uploadFile: createMarkdownFile(title, markdown),
      warnings,
    };
  }

  private async readPageSnapshot(tabId: number, noteId: string, signal: AbortSignal): Promise<XiaohongshuPageSnapshot> {
    throwIfAborted(signal);
    const result = await withAbort(
      browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (targetId: string): XiaohongshuPageSnapshot => {
          // 1. Try reading from window.__INITIAL_STATE__
          interface InitialStateNote {
            title?: string;
            desc?: string;
            time?: number;
            user?: { nickname?: string; name?: string };
            tagList?: Array<{ name?: string }>;
            imageList?: Array<{ urlDefault?: string; urlOriginal?: string; infoList?: Array<{ url?: string }> }>;
            interactInfo?: { likedCount?: string | number; collectedCount?: string | number };
          }
          interface GlobalState {
            __INITIAL_STATE__?: {
              note?: {
                noteDetailMap?: Record<string, { note?: InitialStateNote }>;
                currentNote?: { note?: InitialStateNote };
              };
            };
          }

          const state = (window as unknown as GlobalState).__INITIAL_STATE__;
          const noteMap = state?.note?.noteDetailMap;
          const currentNote: InitialStateNote | undefined =
            (targetId && noteMap?.[targetId]?.note) ||
            (noteMap ? Object.values(noteMap)[0]?.note : undefined) ||
            state?.note?.currentNote?.note;

          if (currentNote) {
            const rawImages = (currentNote.imageList ?? []).flatMap((img) => [
              img.urlDefault,
              img.urlOriginal,
              img.infoList?.[0]?.url,
            ]).filter((url): url is string => Boolean(url));

            return {
              title: currentNote.title?.trim() ?? "",
              desc: currentNote.desc?.trim() ?? "",
              author: currentNote.user?.nickname?.trim() || currentNote.user?.name?.trim() || "",
              publishTime: currentNote.time ? new Date(currentNote.time).toISOString() : undefined,
              likes: currentNote.interactInfo?.likedCount != null ? String(currentNote.interactInfo.likedCount) : undefined,
              collects: currentNote.interactInfo?.collectedCount != null ? String(currentNote.interactInfo.collectedCount) : undefined,
              tags: (currentNote.tagList ?? []).map((t) => t.name?.trim() ?? "").filter(Boolean),
              imageUrls: Array.from(new Set(rawImages)),
              hasState: true,
            };
          }

          // 2. DOM fallback
          const title = document.querySelector("#detail-title, .title, [class*='note-container'] [class*='title']")?.textContent?.trim() ?? "";
          const desc = document.querySelector("#detail-desc, .desc, [class*='note-container'] [class*='desc'], .note-text")?.textContent?.trim() ?? "";
          const author = document.querySelector(".author-wrapper .name, [class*='author'] .name, .username")?.textContent?.trim() ?? "";
          const domImages = Array.from(
            document.querySelectorAll<HTMLImageElement>(".media-container img, .swiper-slide img, [class*='note-container'] img"),
          )
            .flatMap((img) => [img.currentSrc, img.src, img.getAttribute("data-src")])
            .filter((url): url is string => typeof url === "string" && url.length > 0 && !url.startsWith("data:"));

          return {
            title,
            desc,
            author,
            tags: [],
            imageUrls: Array.from(new Set(domImages)),
            hasState: false,
          };
        },
        args: [noteId],
      }) as Promise<Array<{ result?: XiaohongshuPageSnapshot }>>,
      signal,
    );

    return result[0]?.result ?? {
      title: "",
      desc: "",
      author: "",
      tags: [],
      imageUrls: [],
      hasState: false,
    };
  }

  private async fallback(context: PageContext, signal: AbortSignal, warnings: string[]): Promise<ExtractedDocument> {
    const doc = await this.fallbackExtractor.extract(context, signal);
    return {
      ...doc,
      warnings: [...warnings, ...doc.warnings],
    };
  }
}
