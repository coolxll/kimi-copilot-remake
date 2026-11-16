import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { throwIfAborted, withAbort } from "../shared/abort";
import { uniqueImageUrls } from "../shared/image-links";
import { safeFilename } from "../shared/filename";
import { cleanInline, formatDate } from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { cleanHtmlForUpload, htmlToMarkdown, wrapHtml } from "./html";
import { WebpageExtractor } from "./webpage";

const WECHAT_HOSTS = new Set(["mp.weixin.qq.com"]);

export function isWechatArticleUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !WECHAT_HOSTS.has(url.hostname.toLowerCase())) {
    return false;
  }
  return url.pathname.startsWith("/s/") || url.pathname === "/s" || url.pathname.startsWith("/s?");
}

export interface WechatPageSnapshot {
  title: string;
  accountName: string;
  author: string;
  publishTime?: string;
  cleanHtml: string;
  text: string;
  imageUrls: string[];
}

export function formatWechatMarkdown(
  title: string,
  snapshot: WechatPageSnapshot,
  markdownBody: string,
  warnings: readonly string[],
): string {
  const metaItems = [
    snapshot.accountName ? `公众号：${cleanInline(snapshot.accountName)}` : "",
    snapshot.author ? `作者：${cleanInline(snapshot.author)}` : "",
    snapshot.publishTime ? `发布时间：${formatDate(snapshot.publishTime)}` : "",
  ].filter(Boolean);

  const sections: string[] = [`# ${title}`];
  if (metaItems.length) {
    sections.push(`> ${metaItems.join(" · ")}`);
  }

  if (markdownBody.trim()) {
    sections.push(markdownBody.trim());
  }

  if (warnings.length) {
    sections.push(`---\n\n> 提取提示：${warnings.join("；")}`);
  }

  return sections.join("\n\n").trim();
}

export class WechatExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "wechat",
    label: "微信公众号",
    outputKind: "webpage",
  };

  private readonly fallbackExtractor = new WebpageExtractor();

  canHandle(context: PageContext): boolean {
    return isWechatArticleUrl(context.url);
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    if (!isWechatArticleUrl(context.url)) {
      throw new AppError("unsupported-page", "无效的微信公众号文章地址");
    }

    const warnings: string[] = [];
    let snapshot: WechatPageSnapshot | undefined;

    try {
      snapshot = await this.readPageSnapshot(context.tabId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push("微信文章内容提取中断，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    if (!snapshot || (!snapshot.cleanHtml && !snapshot.text.trim())) {
      warnings.push("未从微信公众号页面解析出文章正文，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    const title = snapshot.title || context.title || "微信公众号文章";
    const cleanHtml = cleanHtmlForUpload(snapshot.cleanHtml);
    const bodyMarkdown = htmlToMarkdown(cleanHtml) || snapshot.text.trim();
    const markdown = formatWechatMarkdown(title, snapshot, bodyMarkdown, warnings);
    const imageUrls = uniqueImageUrls(snapshot.imageUrls, context.url);
    const uploadFile = new File([wrapHtml(title, cleanHtml)], `${safeFilename(title)}.html`, { type: "text/html" });

    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      imageUrls,
      uploadFile,
      warnings,
    };
  }

  private async readPageSnapshot(tabId: number, signal: AbortSignal): Promise<WechatPageSnapshot> {
    throwIfAborted(signal);
    const result = await withAbort(
      browser.scripting.executeScript({
        target: { tabId },
        func: (): WechatPageSnapshot => {
          const title = document.querySelector("#activity-name")?.textContent?.trim() || document.title || "";
          const accountName = document.querySelector("#js_name")?.textContent?.trim() || "";
          const author = document.querySelector("#js_author_name, .rich_media_meta_text")?.textContent?.trim() || "";

          // Resolve publish time
          let publishTime: string | undefined = document.querySelector("#publish_time")?.textContent?.trim();
          if (!publishTime) {
            const pageScripts = Array.from(document.querySelectorAll("script")).map((s) => s.textContent || "");
            for (const scriptContent of pageScripts) {
              const ctMatch = /var\s+ct\s*=\s*["']?(\d+)["']?/i.exec(scriptContent);
              if (ctMatch?.[1]) {
                const ts = Number(ctMatch[1]);
                if (Number.isFinite(ts) && ts > 0) {
                  publishTime = new Date(ts * 1000).toISOString();
                  break;
                }
              }
            }
          }

          const contentEl = document.querySelector("#js_content");
          if (!contentEl) {
            return {
              title,
              accountName,
              author,
              publishTime,
              cleanHtml: "",
              text: document.body?.innerText ?? "",
              imageUrls: [],
            };
          }

          const clone = contentEl.cloneNode(true) as HTMLElement;

          // Remove noise elements
          clone.querySelectorAll(
            "script, style, noscript, .reward_area, #js_sponsor_ad_area, #js_tags, #js_profile_qrcode, .rich_media_tool, .like_comment_wraper, [style*='display: none']",
          ).forEach((node) => node.remove());

          // Clean line index lists in code snippets
          clone.querySelectorAll("ul.code-snippet__line-index").forEach((node) => node.remove());

          // Promote lazy loaded images
          const imageUrls: string[] = [];
          clone.querySelectorAll("img").forEach((img) => {
            const actualSrc = img.getAttribute("data-src") || img.getAttribute("data-original") || img.src;
            if (actualSrc && !actualSrc.startsWith("data:")) {
              img.setAttribute("src", actualSrc);
              img.removeAttribute("data-src");
              img.removeAttribute("data-original");
              imageUrls.push(actualSrc);
            }
          });

          return {
            title,
            accountName,
            author,
            publishTime,
            cleanHtml: clone.innerHTML,
            text: clone.innerText || "",
            imageUrls: Array.from(new Set(imageUrls)),
          };
        },
      }) as Promise<Array<{ result?: WechatPageSnapshot }>>,
      signal,
    );

    return result[0]?.result ?? {
      title: "",
      accountName: "",
      author: "",
      cleanHtml: "",
      text: "",
      imageUrls: [],
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
