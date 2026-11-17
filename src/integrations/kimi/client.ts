import { AppError } from "../../domain/errors";
import type { KimiTokens } from "../../domain/types";
import { abortableDelay, throwIfAborted } from "../../shared/abort";
import { readSseStream } from "../shared/sse";

interface KimiClientOptions {
  tokens: KimiTokens;
  onTokensRefreshed: (tokens: KimiTokens) => Promise<void>;
}

const refreshFlights = new Map<string, Promise<KimiTokens>>();

export class KimiClient {
  private accessToken?: string;
  private refreshToken?: string;
  private refreshPromise?: Promise<void>;
  private readonly onTokensRefreshed: (tokens: KimiTokens) => Promise<void>;

  constructor(options: KimiClientOptions) {
    this.accessToken = options.tokens.accessToken;
    this.refreshToken = options.tokens.refreshToken;
    this.onTokensRefreshed = options.onTokensRefreshed;
  }

  /**
   * Refresh the current token without creating a chat or sending a prompt.
   * If only an access token is available, verifies connectivity via a lightweight probe.
   */
  async testConnection(signal?: AbortSignal): Promise<void> {
    if (this.refreshToken) {
      await withAbort(this.refreshAccessToken(), signal);
    } else if (this.accessToken) {
      await this.createChat(signal);
    } else {
      throw new AppError("auth-required", "未提供 Kimi 登录凭证");
    }
  }

  async testFileUpload(file?: File, signal?: AbortSignal): Promise<{ ok: true; fileId: string; status: string; message: string }> {
    const testFile = file || new File(
      ["Kimi Copilot 文件上传与解析测试。\n这是一份用于验证 Kimi 网页端 apiv2-files 文件上传协议与解析进度的示例文档。"],
      "kimi-upload-test.txt",
      { type: "text/plain" },
    );
    const uploaded = await this.uploadFile(testFile, signal);
    const probeSignal = signal ?? new AbortController().signal;
    const status = await this.waitForParse(uploaded.id, probeSignal);
    return {
      ok: true,
      fileId: uploaded.id,
      status,
      message: `文件上传成功（ID: ${uploaded.id}），解析状态：${status}`,
    };
  }

  async createChat(signal?: AbortSignal): Promise<{ id: string }> {
    const body = await this.requestJson<{ id?: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ is_example: false, name: "未命名会话" }),
      signal,
    });
    if (!body.id) throw new AppError("api-contract", "Kimi 没有返回会话 ID");
    return { id: body.id };
  }

  async uploadFile(file: File, signal?: AbortSignal): Promise<{ id: string }> {
    const safeName = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80) || "document.txt";
    const formData = new FormData();
    formData.append("file", file, safeName);

    try {
      const body = await this.requestJson<{ file?: { id?: string } }>("/apiv2-files/file/upload", {
        method: "POST",
        body: formData,
        signal,
      });
      if (body.file?.id) return { id: body.file.id };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Fallback to legacy pre-sign-url flow if apiv2-files is rejected or returns an error
      return this.uploadFileLegacy(file, safeName, signal);
    }
    throw new AppError("api-contract", "Kimi 没有返回上传文件 ID");
  }

  private async uploadFileLegacy(file: File, safeName: string, signal?: AbortSignal): Promise<{ id: string }> {
    const presign = await this.requestJson<{ url?: string; object_name?: string }>("/api/pre-sign-url", {
      method: "POST",
      body: JSON.stringify({ action: "file", name: safeName }),
      signal,
    });
    if (!presign.url || !presign.object_name) throw new AppError("api-contract", "Kimi 预签名响应不完整");
    const arrayBuffer = await file.arrayBuffer();
    const uploadResponse = await fetch(presign.url, {
      method: "PUT",
      body: arrayBuffer,
      signal,
    });
    if (!uploadResponse.ok) throw new AppError("upload-failed", `文件上传失败（HTTP ${uploadResponse.status}）`, { retryable: true });
    const registered = await this.requestJson<{ id?: string }>("/api/file", {
      method: "POST",
      body: JSON.stringify({ type: "file", name: safeName, object_name: presign.object_name }),
      signal,
    });
    if (!registered.id) throw new AppError("api-contract", "Kimi 没有返回文件 ID");
    return { id: registered.id };
  }

  async waitForParse(fileId: string, signal: AbortSignal, maxWaitMs = 60_000): Promise<string> {
    const startTime = Date.now();
    let rpcAvailable = true;

    while (Date.now() - startTime < maxWaitMs) {
      throwIfAborted(signal);
      if (rpcAvailable) {
        try {
          const body = await this.requestJson<{
            progresses?: Array<{
              file_id?: string;
              fileId?: string;
              status?: string;
              error?: { message?: string; detail?: string };
            }>;
          }>("/apiv2-files/kimi.gateway.file.v1.FileService/GetFileParseProgress", {
            method: "POST",
            body: JSON.stringify({ file_ids: [fileId] }),
            signal,
          });

          const progress = body.progresses?.find((p) => (p.file_id || p.fileId) === fileId) ?? body.progresses?.[0];
          if (progress?.status) {
            const status = progress.status.toUpperCase();
            if (status.includes("SUCCESS") || status.includes("PARSED") || status === "DONE") {
              return "parsed";
            }
            if (status.includes("FAIL") || status.includes("ERROR")) {
              const detail = progress.error?.message || progress.error?.detail;
              throw new AppError("parse-failed", `Kimi 文件解析失败${detail ? `（${detail}）` : ""}`);
            }
          }
        } catch (error) {
          if (error instanceof AppError && error.code === "parse-failed") throw error;
          if (error instanceof AppError && error.message.includes("404")) {
            rpcAvailable = false;
          } else {
            const isTransient = error instanceof AppError && error.retryable;
            if (!isTransient) throw error;
          }
        }
      }

      if (!rpcAvailable) {
        return this.waitForParseSse(fileId, signal);
      }

      await abortableDelay(1000, signal);
    }
    throw new AppError("parse-failed", "Kimi 文件解析超时");
  }

  private async waitForParseSse(fileId: string, signal: AbortSignal, timeoutMs = 30_000): Promise<string> {
    const sseController = new AbortController();
    const timeoutId = setTimeout(() => {
      sseController.abort(new AppError("parse-failed", "Kimi 文件解析流等待超时"));
    }, timeoutMs);

    const onAbort = () => sseController.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.requestStream("/api/file/parse_process", {
        method: "POST",
        body: JSON.stringify({ ids: [fileId] }),
        signal: sseController.signal,
      });
      if (!response.body) throw new AppError("parse-failed", "Kimi 没有返回文件解析流");
      for await (const event of readSseStream(response.body, sseController.signal)) {
        if (!event.data || !event.data.trim()) continue;
        let payload: any;
        try {
          payload = JSON.parse(event.data);
        } catch {
          continue;
        }
        const status = (payload?.status && payload.status !== "parsing")
          ? payload.status
          : (payload?.[fileId]?.status ?? payload?.data?.status ?? payload?.file_status);
        if (status && status !== "parsing") {
          const upper = String(status).toUpperCase();
          if (upper.includes("SUCCESS") || upper.includes("PARSED") || upper === "DONE") {
            return "parsed";
          }
          const detail = payload?.detail || payload?.message || payload?.error || payload?.reason || payload?.[fileId]?.error;
          throw new AppError("parse-failed", `Kimi 文件解析状态：${status}${detail ? `（${detail}）` : ""}`);
        }
      }
      throw new AppError("parse-failed", "Kimi 文件解析流提前结束");
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async *sendMessage(
    chatId: string,
    prompt: string,
    fileId: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<{ type: "message"; data: string } | { type: "urls"; data: unknown[] }> {
    const response = await this.requestStream(`/api/chat/${encodeURIComponent(chatId)}/completion/stream`, {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        refs: fileId ? [fileId] : [],
        use_search: false,
      }),
      signal,
    });
    if (!response.body) throw new AppError("api-contract", "Kimi 没有返回消息流");
    for await (const event of readSseStream(response.body, signal)) {
      const payload = parseJson(event.data);
      if (payload?.event === "cmpl" && typeof payload.text === "string") {
        yield { type: "message", data: payload.text };
      } else if (payload?.event === "content" && Array.isArray(payload.msg?.url_refs)) {
        yield { type: "urls", data: payload.msg.url_refs };
      } else if (payload?.event === "all_done") {
        break;
      }
    }
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    const body = await response.text();
    if (!response.ok) throw this.errorFromResponse(response.status, body);
    return parseJson(body) as T;
  }

  private async requestStream(path: string, init: RequestInit): Promise<Response> {
    const response = await this.request(path, init);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw this.errorFromResponse(response.status, body);
    }
    return response;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const signal = init.signal;
    await withAbort(this.ensureAccessToken(), signal ?? undefined);
    const defaultHeaders: Record<string, string> = {
      Referer: "https://www.kimi.com/",
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (!(init.body instanceof FormData)) {
      defaultHeaders["Content-Type"] = "application/json";
    }
    const execute = () => fetch(`https://www.kimi.com${path}`, {
      ...init,
      headers: {
        ...defaultHeaders,
        ...init.headers,
      },
    });
    const response = await execute();
    if (response.status !== 401) return response;
    if (!this.refreshToken) {
      throw new AppError("auth-required", "Kimi 登录凭证已失效，请重新登录");
    }
    await withAbort(this.refreshAccessToken(), signal ?? undefined);
    return execute();
  }

  private async ensureAccessToken(): Promise<void> {
    if (!this.accessToken) {
      if (this.refreshToken) {
        await this.refreshAccessToken();
      } else {
        throw new AppError("auth-required", "未提供 Kimi 登录凭据，请先登录");
      }
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshToken = this.refreshToken;
    if (!refreshToken) {
      throw new AppError("auth-required", "缺少 Kimi refresh_token，请重新登录");
    }
    let flight = refreshFlights.get(refreshToken);
    if (!flight) {
      flight = (async () => {
        const response = await fetch("https://www.kimi.com/api/auth/token/refresh", {
          headers: { Authorization: `Bearer ${refreshToken}` },
        });
        const body = await response.text().catch(() => "");
        if (!response.ok) throw this.errorFromResponse(response.status, body);
        const parsed = parseJson(body);
        if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string") {
          throw new AppError("token-refresh-failed", "Kimi 刷新 Token 响应不完整");
        }
        const tokens = { accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
        await this.onTokensRefreshed(tokens);
        return tokens;
      })();
      refreshFlights.set(refreshToken, flight);
      flight.then(() => {
        if (refreshFlights.get(refreshToken) === flight) refreshFlights.delete(refreshToken);
      }, () => {
        if (refreshFlights.get(refreshToken) === flight) refreshFlights.delete(refreshToken);
      });
    }
    this.refreshPromise = flight.then((tokens) => {
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
    }).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private errorFromResponse(status: number, body: string): AppError {
    if (status === 401 || status === 403) return new AppError("auth-required", "Kimi 登录态已失效，请重新登录");
    if (status === 429) return new AppError("rate-limit", "Kimi 请求过于频繁，请稍后重试", { retryable: true });
    if (status >= 500) return new AppError("api-unavailable", `Kimi 服务暂不可用（HTTP ${status}）`, { retryable: true });
    let detail = "";
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.detail || parsed.error?.message || "";
    } catch {
      // not JSON
    }
    return new AppError("api-contract", `Kimi 请求失败（HTTP ${status}${detail ? `：${detail}` : ""}）`);
  }
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AppError("api-contract", "Kimi 返回了无效 JSON", { cause: error });
  }
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
