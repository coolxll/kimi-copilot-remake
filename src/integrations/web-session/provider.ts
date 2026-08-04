import { AppError } from "../../domain/errors";
import type { SummaryEvent, SummaryProvider, SummaryRequest, WebSessionProviderId } from "../../domain/types";
import { trimSourceToLimit } from "../openai-compatible/chunking";
import { WebSessionClient } from "./client";
import { getWebSessionSpec } from "./specs";

const MAX_WEB_SESSION_SOURCE_CHARS = 100_000;

export class WebSessionProvider implements SummaryProvider {
  readonly id: WebSessionProviderId;
  private readonly client: WebSessionClient;

  constructor(providerId: WebSessionProviderId, client: WebSessionClient) {
    this.id = providerId;
    this.client = client;
  }

  async validateReady(): Promise<void> {
    await this.client.validateReady(this.id);
  }

  async *summarize(request: SummaryRequest, signal: AbortSignal): AsyncIterable<SummaryEvent> {
    await this.validateReady();
    const warnings = [...request.document.warnings];
    if (this.id === "gemini-web" && request.document.kind === "youtube") {
      warnings.push("Gemini Web 将直接读取 YouTube 链接，不依赖扩展字幕提取");
      for (const warning of warnings) yield { type: "warning", message: warning };
      yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
      const prompt = `${request.prompt}

请直接打开并分析下面的 YouTube 视频链接，使用 Gemini 可用的视频理解、字幕或页面能力完成总结。不要依赖扩展提供的正文，也不要说明你无法读取扩展正文；如果视频确实无法访问，再明确说明原因。

YouTube 视频标题：${request.document.title}
YouTube 视频链接：${request.document.sourceUrl}`;
      for await (const event of this.client.stream(this.id, prompt, signal)) {
        if (event.type === "snapshot") yield { type: "snapshot", text: event.text };
        else yield { type: "done", externalUrl: event.externalUrl };
      }
      return;
    }

    const label = getWebSessionSpec(this.id).label;
    const sourceText = request.document.sourceText;
    const uploadFile = shouldUploadWebSessionFile(request.document.uploadFile, sourceText)
      ? request.document.uploadFile
      : undefined;
    if (!sourceText.trim() && !uploadFile) throw new AppError("extraction-failed", `${label} 需要可读取的正文文本或文件`);
    const limited = trimSourceToLimit(sourceText, MAX_WEB_SESSION_SOURCE_CHARS);
    if (uploadFile) {
      warnings.push(`${label} 将把超长正文作为文件上传，避免把完整正文塞入对话上下文`);
    } else if (limited.truncated) {
      warnings.push(`正文超过 ${MAX_WEB_SESSION_SOURCE_CHARS} 字符，已按首尾内容截断`);
    }
    for (const warning of warnings) yield { type: "warning", message: warning };

    if (uploadFile) yield { type: "phase", phase: "uploading", current: 1, total: 1 };
    yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
    const prompt = uploadFile
      ? `${request.prompt}\n\n请阅读随附文件并完成总结。保留事实、结构和关键细节，不要提及“页面内容”、文件上传或本次提取过程。\n\n标题：${request.document.title}\n来源：${request.document.sourceUrl}\n文件名：${request.document.uploadFile?.name || "document"}`
      : `${request.prompt}\n\n请基于以下页面内容完成总结。保留事实、结构和关键细节，不要提及“页面内容”或本次提取过程。\n\n标题：${request.document.title}\n来源：${request.document.sourceUrl}\n\n正文：\n${limited.text}`;
    try {
      for await (const event of this.client.stream(this.id, prompt, signal, uploadFile || undefined)) {
        if (event.type === "snapshot") yield { type: "snapshot", text: event.text };
        else yield { type: "done", externalUrl: event.externalUrl };
      }
    } catch (error) {
      if (!uploadFile || !sourceText.trim() || !(error instanceof AppError) || error.code !== "upload-failed") throw error;
      yield { type: "warning", message: `${label} 文件上传失败，已退回正文截断方式` };
      yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
      const fallbackPrompt = `${request.prompt}\n\n请基于以下页面内容完成总结。保留事实、结构和关键细节，不要提及“页面内容”或本次提取过程。\n\n标题：${request.document.title}\n来源：${request.document.sourceUrl}\n\n正文：\n${limited.text}`;
      for await (const event of this.client.stream(this.id, fallbackPrompt, signal)) {
        if (event.type === "snapshot") yield { type: "snapshot", text: event.text };
        else yield { type: "done", externalUrl: event.externalUrl };
      }
    }
  }
}

function shouldUploadWebSessionFile(file: File | undefined, sourceText: string): file is File {
  return Boolean(file && (!sourceText.trim() || sourceText.length > MAX_WEB_SESSION_SOURCE_CHARS));
}
