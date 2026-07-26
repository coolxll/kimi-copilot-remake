import { browser } from "wxt/browser";
import TurndownService from "turndown";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";

export class WebpageExtractor implements ContentExtractor {
  readonly id = "webpage" as const;

  canHandle(): boolean {
    return true;
  }

  async extract(context: PageContext): Promise<ExtractedDocument> {
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
    } catch (error) {
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

function cleanHtmlForUpload(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,iframe,object,embed,canvas,form,input,textarea,select,button").forEach((node) => node.remove());
  doc.querySelectorAll("[hidden], [aria-hidden='true']").forEach((node) => node.remove());
  doc.querySelectorAll("[srcdoc]").forEach((node) => node.removeAttribute("srcdoc"));
  return doc.body?.innerHTML ?? "";
}

function htmlToMarkdown(html: string): string {
  const service = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  return service.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

function wrapHtml(title: string, html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
