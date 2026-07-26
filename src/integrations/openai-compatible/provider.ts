import { AppError } from "../../domain/errors";
import type {
  OpenAICompatibleConfig,
  OpenAICompatibleSecret,
  SummaryEvent,
  SummaryProvider,
  SummaryRequest,
} from "../../domain/types";
import { readSseStream, SseParser } from "../shared/sse";
import { groupForReduction, splitText, trimSourceToLimit } from "./chunking";
import { hasApiHostPermission, validateApiRoot } from "../../platform/chrome/permissions";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OpenAICompatibleProviderOptions {
  config: OpenAICompatibleConfig;
  secret: OpenAICompatibleSecret | null;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  models?: string[];
}

const MIN_CONTEXT_CHARS = 2_000;

export class OpenAICompatibleProvider implements SummaryProvider {
  readonly id = "openai-compatible" as const;
  private readonly config: OpenAICompatibleConfig;
  private readonly secret: OpenAICompatibleSecret | null;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.config = options.config;
    this.secret = options.secret;
  }

  async validateReady(): Promise<void> {
    const url = validateApiRoot(this.config.apiRoot);
    if (!this.config.model.trim()) throw new AppError("provider-not-configured", "请填写兼容 API 的 Model");
    if (!Number.isInteger(this.config.chunkChars) || this.config.chunkChars < 4_000 || this.config.chunkChars > 50_000) {
      throw new AppError("provider-not-configured", "单块字符数必须在 4000～50000 之间");
    }
    if (!Number.isInteger(this.config.maxSourceChars) || this.config.maxSourceChars < 20_000 || this.config.maxSourceChars > 500_000) {
      throw new AppError("provider-not-configured", "最大源文本必须在 20000～500000 之间");
    }
    const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (!isLoopback && !this.secret?.apiToken.trim()) {
      throw new AppError("provider-not-configured", "远程兼容 API 必须配置 Token");
    }
    if (!(await hasApiHostPermission(this.config.apiRoot))) {
      throw new AppError("host-permission-denied", `请先授权访问 ${url.origin}`);
    }
  }

  async *summarize(request: SummaryRequest, signal: AbortSignal): AsyncIterable<SummaryEvent> {
    await this.validateReady();
    const warnings = [...request.document.warnings];
    if (!request.document.sourceText.trim()) throw new AppError("extraction-failed", "无法获取该页面的可总结文本");
    const limited = trimSourceToLimit(request.document.sourceText, this.config.maxSourceChars);
    if (limited.truncated) warnings.push(`正文超过 ${this.config.maxSourceChars} 字符，已按首尾内容截断`);
    for (const warning of warnings) yield { type: "warning", message: warning };

    const chunks = splitText(limited.text, this.config.chunkChars);
    if (chunks.length <= 1) {
      yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
      yield* this.streamChat(this.buildMessages(request.prompt, this.documentEnvelope(request, limited.text)), signal);
      yield { type: "done" };
      return;
    }

    yield { type: "phase", phase: "chunking", current: 0, total: chunks.length };
    const summaries: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      yield { type: "phase", phase: "summarizing", current: index + 1, total: chunks.length };
      summaries.push(await this.summarizeChunk(chunks[index].text, request.prompt, signal));
    }

    let reductionRound = 0;
    while (summaries.length > 1) {
      reductionRound += 1;
      const groups = groupForReduction(summaries, this.config.chunkChars);
      summaries.length = 0;
      for (let index = 0; index < groups.length; index += 1) {
        yield { type: "phase", phase: "summarizing", current: index + 1, total: groups.length };
        const merged = groups[index].join("\n\n--- 局部摘要分隔 ---\n\n");
        summaries.push(await this.summarizeChunk(
          `这是第 ${index + 1} 组局部摘要（归并轮次 ${reductionRound}）：\n\n${merged}`,
          `${request.prompt}\n\n请合并局部摘要，保留事实、关键结构和重要细节，不要提及“局部摘要”。`,
          signal,
        ));
      }
    }

    yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
    yield* this.streamChat(
      this.buildMessages(request.prompt, `以下是网页内容的分块归纳结果：\n\n${summaries[0]}`),
      signal,
    );
    yield { type: "done" };
  }

  async testConnection(): Promise<TestConnectionResult> {
    await this.validateReady();
    const response = await this.fetchWithRetry(`${this.apiRoot()}/models`, { method: "GET" }, undefined, true);
    if (response.status === 404 || response.status === 405) {
      return { ok: true, message: "服务不支持模型探测，已跳过模型列表校验" };
    }
    if (!response.ok) {
      throw await this.errorFromResponse(response, "模型探测失败");
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = Array.isArray(body.data) ? body.data.map((item) => item.id).filter((id): id is string => Boolean(id)) : [];
    if (models.length > 0 && !models.includes(this.config.model)) {
      return { ok: true, message: `连接成功，但模型列表中没有 ${this.config.model}`, models };
    }
    return { ok: true, message: "连接成功", models };
  }

  private async summarizeChunk(text: string, prompt: string, signal: AbortSignal): Promise<string> {
    try {
      return await this.completeText(
        this.buildMessages(
          `${prompt}\n\n请只处理下面这一部分内容，提取事实、结构和可供最终总结使用的细节。`,
          text,
        ),
        signal,
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "context-limit" || text.length < MIN_CONTEXT_CHARS * 2) throw error;
      const middle = Math.floor(text.length / 2);
      const first = await this.summarizeChunk(text.slice(0, middle), prompt, signal);
      const second = await this.summarizeChunk(text.slice(middle), prompt, signal);
      return this.completeText(
        this.buildMessages(`${prompt}\n\n请合并两段局部摘要。`, `${first}\n\n${second}`),
        signal,
      );
    }
  }

  private async *streamChat(messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<SummaryEvent> {
    const response = await this.fetchWithRetry(
      `${this.apiRoot()}/chat/completions`,
      { method: "POST", body: JSON.stringify({ model: this.config.model, stream: true, messages }) },
      signal,
    );
    if (!response.ok) throw await this.errorFromResponse(response, "兼容 API 请求失败");
    if (!response.body) throw new AppError("api-contract", "兼容 API 没有返回响应流");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      const bodyText = await response.text();
      if (bodyText.trimStart().startsWith("data:")) {
        const parser = new SseParser();
        let sawBufferedDelta = false;
        for (const event of [...parser.feed(bodyText), ...parser.end()]) {
          if (event.data === "[DONE]") break;
          const parsed = this.parseJson(event.data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            sawBufferedDelta = true;
            yield { type: "delta", text: delta };
          }
        }
        if (!sawBufferedDelta) throw new AppError("api-contract", "兼容 API 没有返回可显示的文本");
        return;
      }
      const body = this.parseJson(bodyText);
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content) throw new AppError("api-contract", "兼容 API 返回内容为空");
      yield { type: "delta", text: content };
      return;
    }
    let sawDelta = false;
    for await (const event of readSseStream(response.body, signal)) {
      if (event.data === "[DONE]") break;
      const parsed = this.parseJson(event.data);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        sawDelta = true;
        yield { type: "delta", text: delta };
      }
    }
    if (!sawDelta) throw new AppError("api-contract", "兼容 API 没有返回可显示的文本");
  }

  private async completeText(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const response = await this.fetchWithRetry(
      `${this.apiRoot()}/chat/completions`,
      { method: "POST", body: JSON.stringify({ model: this.config.model, stream: false, messages }) },
      signal,
    );
    if (!response.ok) throw await this.errorFromResponse(response, "兼容 API 请求失败");
    const parsed = this.parseJson(await response.text());
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content) throw new AppError("api-contract", "兼容 API 返回内容为空");
    return content;
  }

  private buildMessages(prompt: string, content: string): ChatMessage[] {
    return [
      { role: "system", content: prompt },
      { role: "user", content },
    ];
  }

  private documentEnvelope(request: SummaryRequest, text: string): string {
    return `标题：${request.document.title}\n来源：${request.document.sourceUrl}\n\n正文：\n${text}`;
  }

  private apiRoot(): string {
    return this.config.apiRoot.trim().replace(/\/+$/, "");
  }

  private headers(): HeadersInit {
    const token = this.secret?.apiToken.trim();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async fetchWithRetry(
    input: string,
    init: RequestInit,
    signal?: AbortSignal,
    allowNotFound = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.headers())) headers.set(key, value);
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      try {
        const response = await fetch(input, { ...init, headers, signal });
        if (allowNotFound && (response.status === 404 || response.status === 405)) return response;
        if ((response.status !== 429 && response.status < 500) || attempt === 2) return response;
        await response.body?.cancel().catch(() => undefined);
        await waitBeforeRetry(response, attempt, signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        lastError = error;
        if (attempt === 2) break;
        await waitBeforeRetry(undefined, attempt, signal);
      }
    }
    throw new AppError("api-unavailable", "兼容 API 网络请求失败", { cause: lastError, retryable: true });
  }

  private async errorFromResponse(response: Response, fallback: string): Promise<AppError> {
    const body = await response.text().catch(() => "");
    const lower = body.toLowerCase();
    if (response.status === 401 || response.status === 403) return new AppError("api-auth", "兼容 API Token 无效或无权限");
    if (response.status === 429) return new AppError("rate-limit", "兼容 API 请求过于频繁，请稍后重试", { retryable: true });
    if (lower.includes("context") || lower.includes("maximum") && lower.includes("token")) {
      return new AppError("context-limit", "兼容 API 上下文长度不足");
    }
    return new AppError("api-unavailable", `${fallback}（HTTP ${response.status}）`, { retryable: response.status >= 500 });
  }

  private parseJson(value: string): any {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new AppError("api-contract", "兼容 API 返回了无效 JSON", { cause: error });
    }
  }
}

async function waitBeforeRetry(response: Response | undefined, attempt: number, signal?: AbortSignal): Promise<void> {
  const retryAfter = response?.headers.get("Retry-After");
  const parsedSeconds = retryAfter ? Number(retryAfter) : NaN;
  const parsedDate = retryAfter && !Number.isFinite(parsedSeconds) ? Date.parse(retryAfter) : NaN;
  const retryAfterMs = Number.isFinite(parsedSeconds)
    ? parsedSeconds * 1000
    : Number.isFinite(parsedDate)
      ? Math.max(0, parsedDate - Date.now())
      : NaN;
  const delay = Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, 30_000) : attempt === 0 ? 1_000 : 3_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
