import { browser } from "wxt/browser";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { throwIfAborted, withAbort } from "../shared/abort";
import { uniqueImageUrls } from "../shared/image-links";
import { safeFilename } from "../shared/filename";
import { cleanInline, formatDate } from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { cleanHtmlForUpload, htmlToMarkdown, wrapHtml } from "./html";
import { WebpageExtractor } from "./webpage";

export interface DeclarativeRule {
  readonly id: string;
  readonly label: string;
  readonly matchPatterns: readonly string[];
  readonly meta?: {
    readonly titleSelector?: string;
    readonly authorSelector?: string;
    readonly publishTimeSelector?: string;
  };
  readonly content: {
    readonly containerSelector: string;
    readonly removeSelectors?: readonly string[];
    readonly lazyImageAttrs?: readonly string[];
  };
  readonly priority?: number;
}

export interface DeclarativePageSnapshot {
  ok: boolean;
  title: string;
  author: string;
  publishTime?: string;
  html: string;
  text: string;
  imageUrls: string[];
}

export function escapeRegex(str: string): string {
  return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function matchUrlPattern(pattern: string, rawUrl: string): boolean {
  if (pattern === "<all_urls>") return true;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return false;
  }

  const schemeMatch = /^(\*|https?|file|ftp):\/\//i.exec(pattern);
  if (!schemeMatch) return false;
  const scheme = schemeMatch[1];
  if (scheme !== "*" && scheme.toLowerCase() !== parsedUrl.protocol.replace(":", "").toLowerCase()) {
    return false;
  }

  const remainder = pattern.slice(schemeMatch[0].length);
  const slashIdx = remainder.indexOf("/");
  const hostPattern = slashIdx === -1 ? remainder : remainder.slice(0, slashIdx);
  const pathPattern = slashIdx === -1 ? "/*" : remainder.slice(slashIdx);

  // Match host
  const actualHost = parsedUrl.hostname.toLowerCase();
  if (hostPattern === "*") {
    // matches any host
  } else if (hostPattern.startsWith("*.")) {
    const suffix = hostPattern.slice(2).toLowerCase();
    if (actualHost !== suffix && !actualHost.endsWith("." + suffix)) {
      return false;
    }
  } else if (hostPattern.toLowerCase() !== actualHost) {
    return false;
  }

  // Match path
  const regexStr = "^" + pathPattern.split("*").map(escapeRegex).join(".*") + "$";
  const pathRegex = new RegExp(regexStr);
  return pathRegex.test(parsedUrl.pathname);
}

export function formatDeclarativeMarkdown(
  title: string,
  snapshot: DeclarativePageSnapshot,
  markdownBody: string,
  warnings: readonly string[],
): string {
  const metaItems = [
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

export class DeclarativeExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor;
  readonly rule: DeclarativeRule;
  private readonly fallbackExtractor = new WebpageExtractor();

  constructor(rule: DeclarativeRule) {
    this.rule = rule;
    this.descriptor = {
      id: rule.id,
      label: rule.label,
      outputKind: "webpage",
      priority: rule.priority ?? 100,
    };
  }

  canHandle(context: PageContext): boolean {
    return this.rule.matchPatterns.some((pattern) => matchUrlPattern(pattern, context.url));
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    const warnings: string[] = [];
    let snapshot: DeclarativePageSnapshot | undefined;

    try {
      snapshot = await this.readPageSnapshot(context.tabId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push(`${this.rule.label}内容提取中断，已退回普通网页正文提取`);
      return this.fallback(context, signal, warnings);
    }

    if (!snapshot || !snapshot.ok || (!snapshot.html.trim() && !snapshot.text.trim())) {
      warnings.push(`未从${this.rule.label}页面匹配到指定正文容器，已退回普通网页正文提取`);
      return this.fallback(context, signal, warnings);
    }

    const title = snapshot.title || context.title || this.rule.label;
    const cleanHtml = cleanHtmlForUpload(snapshot.html);
    const bodyMarkdown = htmlToMarkdown(cleanHtml) || snapshot.text.trim();
    const markdown = formatDeclarativeMarkdown(title, snapshot, bodyMarkdown, warnings);
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

  private async readPageSnapshot(tabId: number, signal: AbortSignal): Promise<DeclarativePageSnapshot> {
    throwIfAborted(signal);
    const config = {
      content: {
        containerSelector: this.rule.content.containerSelector,
        removeSelectors: this.rule.content.removeSelectors ? Array.from(this.rule.content.removeSelectors) : [],
        lazyImageAttrs: this.rule.content.lazyImageAttrs ? Array.from(this.rule.content.lazyImageAttrs) : [],
      },
      meta: {
        titleSelector: this.rule.meta?.titleSelector ?? "",
        authorSelector: this.rule.meta?.authorSelector ?? "",
        publishTimeSelector: this.rule.meta?.publishTimeSelector ?? "",
      },
    };

    const result = await withAbort(
      browser.scripting.executeScript({
        target: { tabId },
        func: (cfg: typeof config): DeclarativePageSnapshot => {
          const title = (cfg.meta.titleSelector ? document.querySelector(cfg.meta.titleSelector)?.textContent?.trim() : "") || document.title || "";
          const author = cfg.meta.authorSelector ? document.querySelector(cfg.meta.authorSelector)?.textContent?.trim() || "" : "";
          const publishTime = cfg.meta.publishTimeSelector ? document.querySelector(cfg.meta.publishTimeSelector)?.textContent?.trim() || undefined : undefined;

          const container = document.querySelector(cfg.content.containerSelector);
          if (!container) {
            return {
              ok: false,
              title,
              author,
              publishTime,
              html: "",
              text: document.body?.innerText ?? "",
              imageUrls: [],
            };
          }

          const clone = container.cloneNode(true) as HTMLElement;

          // Remove excluded elements
          for (const selector of cfg.content.removeSelectors) {
            clone.querySelectorAll(selector).forEach((el) => el.remove());
          }

          // Promote lazy images
          const imageUrls: string[] = [];
          const lazyAttrs = cfg.content.lazyImageAttrs.length > 0
            ? cfg.content.lazyImageAttrs
            : ["data-src", "data-original", "data-actualsrc"];

          clone.querySelectorAll("img").forEach((img) => {
            let actualSrc = "";
            for (const attr of lazyAttrs) {
              const val = img.getAttribute(attr);
              if (val && !val.startsWith("data:")) {
                actualSrc = val;
                break;
              }
            }
            if (!actualSrc) actualSrc = img.src;
            if (actualSrc && !actualSrc.startsWith("data:")) {
              img.setAttribute("src", actualSrc);
              imageUrls.push(actualSrc);
            }
          });

          return {
            ok: true,
            title,
            author,
            publishTime,
            html: clone.innerHTML,
            text: clone.innerText || "",
            imageUrls: Array.from(new Set(imageUrls)),
          };
        },
        args: [config],
      }) as Promise<Array<{ result?: DeclarativePageSnapshot }>>,
      signal,
    );

    return result[0]?.result ?? {
      ok: false,
      title: "",
      author: "",
      html: "",
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

/** Built-in popular declarative rules */
export const BUILTIN_DECLARATIVE_RULES: readonly DeclarativeRule[] = [
  {
    id: "zhihu-column",
    label: "知乎专栏",
    matchPatterns: ["*://zhuanlan.zhihu.com/p/*"],
    meta: {
      titleSelector: ".Post-Title, .Title",
      authorSelector: ".AuthorInfo-name, .author-name",
      publishTimeSelector: ".ContentItem-time",
    },
    content: {
      containerSelector: ".Post-Main, .Post-RichTextContainer, article.Post-content",
      removeSelectors: [".Reward", ".ColumnPageHeader-Wrapper", ".Post-topicsAndTags"],
      lazyImageAttrs: ["data-original", "data-actualsrc"],
    },
    priority: 150,
  },
  {
    id: "juejin-article",
    label: "掘金文章",
    matchPatterns: ["*://juejin.cn/post/*"],
    meta: {
      titleSelector: ".article-title",
      authorSelector: ".author-name, .username",
      publishTimeSelector: ".time",
    },
    content: {
      containerSelector: "#article-root, .article-content",
      removeSelectors: [".copy-code-btn", ".extension"],
      lazyImageAttrs: ["data-src"],
    },
    priority: 150,
  },
  {
    id: "csdn-blog",
    label: "CSDN 博客",
    matchPatterns: ["*://blog.csdn.net/*/article/details/*"],
    meta: {
      titleSelector: "#articleContentId, .title-article",
      authorSelector: ".follow-nickName",
      publishTimeSelector: ".time",
    },
    content: {
      containerSelector: "#content_views, .article_content",
      removeSelectors: [".hljs-button", ".recommend-box", ".blog-footer-bottom"],
      lazyImageAttrs: ["data-src"],
    },
    priority: 150,
  },
];
