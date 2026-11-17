import { AppError } from "../../domain/errors";
import type { SettingsRepository } from "../../platform/chrome/storage";
import type { SummaryEvent, SummaryProvider, SummaryRequest } from "../../domain/types";
import { trimSourceToLimit } from "../openai-compatible/chunking";
import { KimiClient } from "./client";

const MAX_KIMI_SOURCE_CHARS = 100_000;

export class KimiProvider implements SummaryProvider {
  readonly id = "kimi-web" as const;

  constructor(private readonly storage: SettingsRepository) {}

  async validateReady(): Promise<void> {
    if (!(await this.storage.getKimiTokens())) throw new AppError("auth-required", "请先登录 Kimi");
  }

  async testConnection(signal?: AbortSignal): Promise<{ ok: true; message: string }> {
    const tokens = await this.storage.getKimiTokens();
    if (!tokens) throw new AppError("auth-required", "请先登录 Kimi");
    const client = new KimiClient({
      tokens,
      onTokensRefreshed: (next) => this.storage.saveKimiTokens(next),
    });
    await client.testConnection(signal);
    return { ok: true, message: "Kimi Web Token 刷新成功，连通性正常" };
  }

  async testFileUpload(file?: File, signal?: AbortSignal): Promise<{ ok: true; fileId: string; status: string; message: string }> {
    const tokens = await this.storage.getKimiTokens();
    if (!tokens) throw new AppError("auth-required", "请先登录 Kimi");
    const client = new KimiClient({
      tokens,
      onTokensRefreshed: (next) => this.storage.saveKimiTokens(next),
    });
    return client.testFileUpload(file, signal);
  }

  async *summarize(request: SummaryRequest, signal: AbortSignal): AsyncIterable<SummaryEvent> {
    const tokens = await this.storage.getKimiTokens();
    if (!tokens) throw new AppError("auth-required", "请先登录 Kimi");
    const client = new KimiClient({
      tokens,
      onTokensRefreshed: (next) => this.storage.saveKimiTokens(next),
    });
    for (const warning of request.document.warnings) yield { type: "warning", message: warning };

    const sourceText = request.document.sourceText;
    const shouldUpload = shouldUploadKimiFile(request.document.uploadFile, sourceText);

    if (!shouldUpload && !sourceText.trim()) {
      throw new AppError("extraction-failed", "无法获取该页面的可总结内容");
    }

    let fileId: string | undefined;
    if (shouldUpload && request.document.uploadFile) {
      yield { type: "phase", phase: "uploading", current: 1, total: 1 };
      try {
        const file = await client.uploadFile(request.document.uploadFile, signal);
        const status = await client.waitForParse(file.id, signal);
        if (status !== "parsed") throw new AppError("parse-failed", `Kimi 文件解析状态：${status}`);
        fileId = file.id;
      } catch (error) {
        if (!sourceText.trim()) throw error;
        console.warn("Kimi 文件上传解析失败，已退回正文截断方式:", error);
        const detail = error instanceof Error ? error.message : String(error);
        yield { type: "warning", message: `文件上传或解析失败（${detail}），已改用页面文本继续总结` };
      }
    }

    const limited = trimSourceToLimit(sourceText, MAX_KIMI_SOURCE_CHARS);
    if (!fileId && limited.truncated) {
      yield { type: "warning", message: `正文超过 ${MAX_KIMI_SOURCE_CHARS} 字符，已按首尾内容截断` };
    }

    const chat = await client.createChat(signal);
    yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
    const prompt = fileId
      ? `网页链接：${request.document.sourceUrl}\n\n${request.prompt}`
      : `${request.prompt}\n\n网页链接：${request.document.sourceUrl}\n\n正文：\n${limited.text}`;
    for await (const event of client.sendMessage(chat.id, prompt, fileId, signal)) {
      if (event.type === "message") yield { type: "delta", text: event.data };
    }
    yield { type: "done", externalUrl: `https://www.kimi.com/chat/${encodeURIComponent(chat.id)}?utm_source=copilot_ext` };
  }
}

function shouldUploadKimiFile(file: File | undefined, _sourceText?: string): file is File {
  return Boolean(file);
}
