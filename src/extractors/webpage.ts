import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";
import { cleanHtmlForUpload, htmlToMarkdown, wrapHtml } from "./html";
import { throwIfAborted } from "../shared/abort";

export class WebpageExtractor implements ContentExtractor {
  readonly id = "webpage" as const;

  canHandle(): boolean {
    return true;
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    let page: { title: string; html: string; text: string } | undefined;
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        func: () => ({
          title: document.title,
          html: document.body?.outerHTML ?? "",
          text: document.body?.innerText ?? "",
        }),
      });
      page = result[0]?.result;
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError("extraction-failed", "无法读取页面，请检查扩展的网页或文件网址访问权限", { cause: error });
    }
    if (!page) throw new AppError("extraction-failed", "无法读取网页内容");
    const title = page.title || context.title || "网页";
    const cleanHtml = cleanHtmlForUpload(page.html);
    const markdown = htmlToMarkdown(cleanHtml) || page.text.trim();
    if (!markdown.trim()) {
      return {
        kind: "webpage",
        title,
        sourceUrl: context.url,
        sourceText: "",
        warnings: ["网页没有可读取的正文"],
      };
    }
    const uploadFile = new File([wrapHtml(title, cleanHtml)], `${safeFilename(title)}.html`, { type: "text/html" });
    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile,
      warnings: [],
    };
  }
}
