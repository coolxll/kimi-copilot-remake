import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";
import { cleanHtmlForUpload, htmlToMarkdown, wrapHtml } from "./html";
import { throwIfAborted } from "../shared/abort";
import { extractImageUrls, uniqueImageUrls } from "../shared/image-links";

export class WebpageExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "webpage",
    label: "普通网页",
    outputKind: "webpage",
  };

  canHandle(): boolean {
    return true;
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    let page: { title: string; html: string; text: string; imageUrls: string[] } | undefined;
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        func: () => ({
          title: document.title,
          html: document.body?.outerHTML ?? "",
          text: document.body?.innerText ?? "",
          imageUrls: Array.from(document.images).flatMap((image) => [
            image.currentSrc,
            image.src,
            image.getAttribute("data-src"),
            image.getAttribute("data-original"),
            image.getAttribute("data-lazy-src"),
          ]).filter((value): value is string => Boolean(value)),
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
        imageUrls: uniqueImageUrls(page.imageUrls, context.url),
        warnings: ["网页没有可读取的正文"],
      };
    }
    const uploadFile = new File([wrapHtml(title, cleanHtml)], `${safeFilename(title)}.html`, { type: "text/html" });
    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      imageUrls: uniqueImageUrls([
        ...page.imageUrls,
        ...extractImageUrls(markdown, context.url),
      ], context.url),
      uploadFile,
      warnings: [],
    };
  }
}
