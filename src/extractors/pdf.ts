import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";
import { throwIfAborted } from "../shared/abort";

export class PdfExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "pdf",
    label: "PDF",
    outputKind: "pdf",
  };

  canHandle(context: PageContext): boolean {
    return /\.pdf(?:$|[?#])/i.test(context.url) || /arxiv\.org\/pdf\//i.test(context.url);
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    let value: { title: string; buffer: ArrayBuffer } | undefined;
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId: context.tabId },
        func: async () => ({ title: document.title, buffer: await fetch(window.location.href).then((response) => response.arrayBuffer()) }),
      });
      value = result[0]?.result;
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError("extraction-failed", "无法读取 PDF，请检查扩展的网页或文件网址访问权限", { cause: error });
    }
    if (!value?.buffer) throw new AppError("extraction-failed", "无法读取 PDF 文件");
    const text = await extractPdfText(value.buffer, signal);
    const title = value.title || context.title || "file";
    return {
      kind: "pdf",
      title,
      sourceUrl: context.url,
      sourceText: text,
      uploadFile: new File([value.buffer], `${safeFilename(title, "file")}.pdf`, { type: "application/pdf" }),
      warnings: text ? [] : ["该 PDF 没有可提取的文本，兼容 API 无法处理扫描图片"] ,
    };
  }
}

async function extractPdfText(buffer: ArrayBuffer, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  throwIfAborted(signal);
  pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("/pdf.worker.mjs");
  const document = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    throwIfAborted(signal);
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
    if (text) pages.push(`## 第 ${pageNumber} 页\n\n${text}`);
  }
  return pages.join("\n\n");
}
