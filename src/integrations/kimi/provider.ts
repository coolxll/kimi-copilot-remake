import { AppError } from "../../domain/errors";
import type { SettingsRepository } from "../../platform/chrome/storage";
import type { SummaryEvent, SummaryProvider, SummaryRequest } from "../../domain/types";
import { KimiClient } from "./client";

export class KimiProvider implements SummaryProvider {
  readonly id = "kimi-web" as const;

  constructor(private readonly storage: SettingsRepository) {}

  async validateReady(): Promise<void> {
    if (!(await this.storage.getKimiTokens())) throw new AppError("auth-required", "请先登录 Kimi");
  }

  async *summarize(request: SummaryRequest, signal: AbortSignal): AsyncIterable<SummaryEvent> {
    const tokens = await this.storage.getKimiTokens();
    if (!tokens) throw new AppError("auth-required", "请先登录 Kimi");
    const client = new KimiClient({
      tokens,
      onTokensRefreshed: (next) => this.storage.saveKimiTokens(next),
    });
    for (const warning of request.document.warnings) yield { type: "warning", message: warning };

    if (!request.document.uploadFile && !request.document.sourceText.trim()) {
      throw new AppError("extraction-failed", "无法获取该页面的可总结内容");
    }

    let fileId: string | undefined;
    if (request.document.uploadFile) {
      yield { type: "phase", phase: "uploading" };
      try {
        const file = await client.uploadFile(request.document.uploadFile, signal);
        const status = await client.waitForParse(file.id, signal);
        if (status !== "parsed") throw new AppError("parse-failed", `Kimi 文件解析状态：${status}`);
        fileId = file.id;
      } catch (error) {
        if (!request.document.sourceText.trim()) throw error;
        yield { type: "warning", message: "文件上传或解析失败，已改用页面文本继续总结" };
      }
    }

    const chat = await client.createChat(signal);
    yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
    const prompt = fileId
      ? `网页链接：${request.document.sourceUrl}\n\n${request.prompt}`
      : `${request.prompt}\n\n网页链接：${request.document.sourceUrl}\n\n正文：\n${request.document.sourceText}`;
    for await (const event of client.sendMessage(chat.id, prompt, fileId, signal)) {
      if (event.type === "message") yield { type: "delta", text: event.data };
    }
    yield { type: "done", externalUrl: `https://www.kimi.com/chat/${encodeURIComponent(chat.id)}?utm_source=copilot_ext` };
  }
}
