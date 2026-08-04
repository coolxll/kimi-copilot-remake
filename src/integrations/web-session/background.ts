import { browser } from "wxt/browser";
import { AppError, toAppError } from "../../domain/errors";
import type { WebSessionCredential, WebSessionProviderId } from "../../domain/types";
import { createSettingsRepository } from "../../platform/chrome/storage";
import { streamChatGptWebRpc } from "./chatgpt-rpc";
import { streamDeepSeekWebRpc } from "./deepseek-rpc";
import {
  fetchGeminiPageContext,
  fetchGeminiWebContext,
  runGeminiPageDiagnostic,
  streamGeminiWebRpc,
  type GeminiWebRpcOptions,
} from "./gemini-rpc";
import {
  createGeminiDiagnosticRecorder,
  sanitizeDiagnosticError,
  type GeminiDiagnosticMode,
} from "./gemini-diagnostics";
import {
  isWebSessionPortRequest,
  serializeAppError,
  WEB_SESSION_PORT_NAME,
  type WebSessionFileMetadata,
  type WebSessionFilePayload,
  type WebSessionPortRequest,
  type WebSessionPortMessage,
} from "./messages";

interface WebSessionPortLike {
  name: string;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: WebSessionPortMessage): void;
}

const CONNECTION_TEST_PROMPT = "只回复 PROJECT_OK";
const MAX_WEB_SESSION_FILE_BYTES = 100 * 1024 * 1024;

export function installWebSessionBackground(): void {
  const storage = createSettingsRepository();
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== WEB_SESSION_PORT_NAME) return;
    handlePort(port as unknown as WebSessionPortLike, storage);
  });
}

function handlePort(port: WebSessionPortLike, storage: ReturnType<typeof createSettingsRepository>): void {
  const requests = new Map<string, AbortController>();
  const fileTransfers = new Map<string, PendingFileTransfer>();
  const startRequest = (message: WebSessionStartRequest, file?: WebSessionFilePayload): void => {
    if (requests.has(message.requestId)) return;
    const controller = new AbortController();
    requests.set(message.requestId, controller);
    const task = runRequest(port, storage, message.requestId, message.providerId, message.prompt, controller.signal, file);
    void task.finally(() => requests.delete(message.requestId));
  };
  port.onMessage.addListener((message) => {
    if (!isWebSessionPortRequest(message)) return;
    if (message.type === "heartbeat") return;
    if (message.type === "cancel") {
      fileTransfers.delete(message.requestId);
      requests.get(message.requestId)?.abort(new DOMException("Aborted", "AbortError"));
      return;
    }
    if (message.type === "file-chunk") {
      receiveFileChunk(port, fileTransfers, message.requestId, message.index, message.data, startRequest);
      return;
    }
    if (requests.has(message.requestId) || fileTransfers.has(message.requestId)) return;
    if (message.type === "test") {
      const controller = new AbortController();
      requests.set(message.requestId, controller);
      const task = runTest(port, storage, message.requestId, message.providerId, controller.signal);
      void task.finally(() => requests.delete(message.requestId));
      return;
    }
    if (message.type === "gemini-diagnostic") {
      const controller = new AbortController();
      requests.set(message.requestId, controller);
      const task = runGeminiDiagnostic(port, storage, message.requestId, message.mode, controller.signal);
      void task.finally(() => requests.delete(message.requestId));
      return;
    }
    if (message.file) {
      const transfer = createPendingFileTransfer(message);
      if (transfer instanceof AppError) {
        postMessage(port, { type: "error", requestId: message.requestId, error: serializeAppError(transfer) });
        return;
      }
      fileTransfers.set(message.requestId, transfer);
      if (message.file.size === 0) {
        fileTransfers.delete(message.requestId);
        startRequest(message, toWebSessionFilePayload(message.file, transfer.bytes));
      }
      return;
    }
    startRequest(message);
  });
  port.onDisconnect.addListener(() => {
    for (const controller of requests.values()) controller.abort(new DOMException("Aborted", "AbortError"));
    requests.clear();
    fileTransfers.clear();
  });
}

type WebSessionStartRequest = Extract<WebSessionPortRequest, { type: "start" }>;

interface PendingFileTransfer {
  request: WebSessionStartRequest;
  metadata: WebSessionFileMetadata;
  bytes: Uint8Array;
  nextIndex: number;
  received: number;
}

function createPendingFileTransfer(message: WebSessionStartRequest): PendingFileTransfer | AppError {
  const file = message.file;
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WEB_SESSION_FILE_BYTES) {
    return new AppError("upload-failed", `文件大小无效或超过 ${MAX_WEB_SESSION_FILE_BYTES} 字节限制`, { retryable: true });
  }
  return {
    request: message,
    metadata: file,
    bytes: new Uint8Array(file.size),
    nextIndex: 0,
    received: 0,
  };
}

function receiveFileChunk(
  port: WebSessionPortLike,
  transfers: Map<string, PendingFileTransfer>,
  requestId: string,
  index: number,
  encodedData: string,
  startRequest: (message: WebSessionStartRequest, file?: WebSessionFilePayload) => void,
): void {
  const transfer = transfers.get(requestId);
  if (!transfer) return;
  try {
    if (!Number.isSafeInteger(index) || index !== transfer.nextIndex) throw new Error("文件分块顺序无效");
    const chunk = decodeBase64(encodedData);
    if (transfer.received + chunk.byteLength > transfer.metadata.size) throw new Error("文件分块超过声明大小");
    transfer.bytes.set(chunk, transfer.received);
    transfer.received += chunk.byteLength;
    transfer.nextIndex += 1;
    if (transfer.received !== transfer.metadata.size) return;
    transfers.delete(requestId);
    startRequest(transfer.request, toWebSessionFilePayload(transfer.metadata, transfer.bytes));
  } catch (error) {
    transfers.delete(requestId);
    const appError = new AppError("upload-failed", `文件传输失败：${error instanceof Error ? error.message : "分块无效"}`, { cause: error, retryable: true });
    postMessage(port, { type: "error", requestId, error: serializeAppError(appError) });
  }
}

function toWebSessionFilePayload(metadata: WebSessionFileMetadata, bytes: Uint8Array): WebSessionFilePayload {
  return { ...metadata, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function runTest(
  port: WebSessionPortLike,
  storage: ReturnType<typeof createSettingsRepository>,
  requestId: string,
  providerId: WebSessionProviderId,
  signal: AbortSignal,
): Promise<void> {
  try {
    const credential = await storage.getWebSessionCredential(providerId);
    if (!credential) {
      throw new AppError(
        "auth-required",
        `请先点击“登录 ${providerLabel(providerId)}”采集登录态；当前扩展中没有可用凭据`,
        { retryable: true },
      );
    }
    const result = await executeProviderStream(providerId, credential, CONNECTION_TEST_PROMPT, signal);
    if (!result.text.includes("PROJECT_OK")) {
      throw new AppError("api-contract", `${providerLabel(providerId)} 未返回 PROJECT_OK，实际会话测试失败`, { retryable: true });
    }
    if (!signal.aborted) {
      postMessage(port, {
        type: "done",
        requestId,
        message: `${providerLabel(providerId)} 实际会话测试成功，已收到 PROJECT_OK`,
        ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}),
      });
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return;
    const appError = toAppError(error);
    if (appError.code === "auth-required" || appError.code === "token-refresh-failed") {
      await storage.clearWebSessionCredential(providerId).catch(() => undefined);
    }
    postMessage(port, { type: "error", requestId, error: serializeAppError(appError) });
  }
}

async function runGeminiDiagnostic(
  port: WebSessionPortLike,
  storage: ReturnType<typeof createSettingsRepository>,
  requestId: string,
  mode: GeminiDiagnosticMode,
  signal: AbortSignal,
): Promise<void> {
  const recorder = createGeminiDiagnosticRecorder(mode, () => Date.now(), (event) => {
    if (!signal.aborted) postMessage(port, { type: "diagnostic-event", requestId, event });
  });
  let externalUrl: string | undefined;
  try {
    const credential = await storage.getWebSessionCredential("gemini-web");
    if (!credential || credential.providerId !== "gemini-web") {
      throw new AppError("auth-required", "请先点击“登录 Gemini Web”采集登录态；当前扩展中没有可用凭据", { retryable: true });
    }
    recorder.emit("credential", "success", "已读取 Gemini Web 凭据", {
      providerId: credential.providerId,
      authUser: credential.authUser || "0",
    });

    if (mode === "context") {
      const contextResult = await runGeminiContextDiagnostic(credential.authUser || "0", signal, recorder);
      const outcome = contextResult.pageOk && contextResult.backgroundOk ? "success" : "warning";
      recorder.emit("complete", outcome === "success" ? "success" : "warning", outcome === "success" ? "上下文检查完成" : "上下文检查完成，但两条路径结果不一致");
      const report = recorder.finish(outcome, contextResult.pageOk && contextResult.backgroundOk
        ? "页面参数与后台页面请求均可用"
        : "上下文检查完成，但页面参数与后台页面请求结果不一致");
      if (!signal.aborted) postMessage(port, { type: "diagnostic-done", requestId, report });
      return;
    }

    let result: { text: string; externalUrl?: string };
    if (mode === "page") {
      result = await runGeminiPageDiagnostic(CONNECTION_TEST_PROMPT, credential.authUser || "0", signal, recorder);
    } else {
      const options: GeminiWebRpcOptions = { diagnostic: recorder, contextSource: "background" };
      result = await executeProviderStream("gemini-web", credential, CONNECTION_TEST_PROMPT, signal, undefined, undefined, options);
    }
    externalUrl = result.externalUrl;
    if (!result.text.includes("PROJECT_OK")) {
      throw new AppError("api-contract", "Gemini Web 未返回 PROJECT_OK，实际会话测试失败", { retryable: true });
    }
    recorder.emit("complete", "success", mode === "page" ? "页面同源测试完成" : "后台请求测试完成");
    const report = recorder.finish("success", mode === "page" ? "页面同源测试成功，已收到 PROJECT_OK" : "后台请求测试成功，已收到 PROJECT_OK");
    if (!signal.aborted) {
      postMessage(port, {
        type: "diagnostic-done",
        requestId,
        report,
        ...(externalUrl ? { externalUrl } : {}),
      });
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return;
    const appError = toAppError(error);
    externalUrl = externalUrl || appError.externalUrl;
    recorder.emit("complete", "error", appError.message, sanitizeDiagnosticError(appError));
    const report = recorder.finish("error", appError.message, undefined);
    if (appError.code === "auth-required") await storage.clearWebSessionCredential("gemini-web").catch(() => undefined);
    postMessage(port, {
      type: "error",
      requestId,
      error: serializeAppError(appError),
      diagnostic: report,
      ...(externalUrl ? { externalUrl } : {}),
    });
  }
}

async function runGeminiContextDiagnostic(
  authUser: string,
  signal: AbortSignal,
  recorder: ReturnType<typeof createGeminiDiagnosticRecorder>,
): Promise<{ pageOk: boolean; backgroundOk: boolean }> {
  let pageOk = false;
  let backgroundOk = false;
  let firstError: unknown;
  try {
    await fetchGeminiPageContext(authUser, recorder);
    pageOk = true;
  } catch (error) {
    firstError = error;
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  try {
    await fetchGeminiWebContext(signal, authUser, recorder);
    backgroundOk = true;
  } catch (error) {
    firstError ||= error;
  }
  if (!pageOk && !backgroundOk) throw firstError || new AppError("api-unavailable", "Gemini 上下文检查失败", { retryable: true });
  return { pageOk, backgroundOk };
}

async function runRequest(
  port: WebSessionPortLike,
  storage: ReturnType<typeof createSettingsRepository>,
  requestId: string,
  providerId: WebSessionProviderId,
  prompt: string,
  signal: AbortSignal,
  file?: WebSessionFilePayload,
): Promise<void> {
  try {
    const credential = await storage.getWebSessionCredential(providerId);
    if (!credential) throw new AppError("auth-required", `请先登录 ${providerLabel(providerId)}`);
    const onUpdate = (text: string) => {
      if (!signal.aborted && text) postMessage(port, { type: "snapshot", requestId, text });
    };
    const result = await executeProviderStream(providerId, credential, prompt, signal, onUpdate, file);
    if (!signal.aborted) postMessage(port, { type: "done", requestId, ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}) });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return;
    const appError = toAppError(error);
    if (appError.code === "auth-required" || appError.code === "token-refresh-failed") {
      await storage.clearWebSessionCredential(providerId).catch(() => undefined);
    }
    postMessage(port, { type: "error", requestId, error: serializeAppError(appError) });
  }
}

async function executeProviderStream(
  providerId: WebSessionProviderId,
  credential: WebSessionCredential,
  prompt: string,
  signal: AbortSignal,
  onUpdate: (text: string) => void = () => undefined,
  file?: WebSessionFilePayload,
  geminiOptions?: GeminiWebRpcOptions,
): Promise<{ text: string; externalUrl?: string }> {
  let latestText = "";
  const update = (text: string) => {
    latestText = text;
    onUpdate(text);
  };
  if (providerId === "chatgpt-web") {
    // ChatGPT binds the bearer token to the browser session. Read the current
    // cookies only for this request; never persist or log them.
    const requestContext = await readChatGptRequestContext();
    const result = await streamChatGptWebRpc(prompt, {
      ...credentialForChatGpt(credential),
      ...requestContext,
    }, signal, ({ text }) => update(text), file);
    return {
      text: latestText,
      ...(result.conversationId ? { externalUrl: `https://chatgpt.com/c/${encodeURIComponent(result.conversationId)}` } : {}),
    };
  }
  if (providerId === "gemini-web") {
    const result = await streamGeminiWebRpc(prompt, signal, ({ text }) => update(text), credentialForGemini(credential).authUser, file, geminiOptions);
    return {
      text: latestText,
      ...(result.conversationId ? { externalUrl: `https://gemini.google.com/app/${encodeURIComponent(stripGeminiConversationPrefix(result.conversationId))}` } : {}),
    };
  }
  const result = await streamDeepSeekWebRpc(prompt, credentialForDeepSeek(credential), signal, ({ text }) => update(text), file);
  return {
    text: latestText,
    externalUrl: `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(result.sessionId)}`,
  };
}

function postMessage(port: WebSessionPortLike, message: WebSessionPortMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // A disconnected side panel is expected to abort the request shortly.
  }
}

function credentialForChatGpt(credential: WebSessionCredential): { accessToken: string } {
  if (credential.providerId !== "chatgpt-web") throw new AppError("auth-required", "ChatGPT Web 登录态不存在");
  return { accessToken: credential.accessToken };
}

function credentialForGemini(credential: WebSessionCredential): { authUser: string } {
  if (credential.providerId !== "gemini-web") throw new AppError("auth-required", "Gemini Web 登录态不存在");
  return { authUser: credential.authUser || "0" };
}

interface ChatGptCookie {
  name: string;
  value: string;
}

async function readChatGptRequestContext(): Promise<{ cookieHeader?: string; deviceId?: string }> {
  try {
    const cookieApi = browser.cookies;
    if (!cookieApi?.getAll) return {};
    const cookies = await cookieApi.getAll({ url: "https://chatgpt.com/" }) as ChatGptCookie[];
    const cookieHeader = cookies
      .filter((cookie) => cookie.name && typeof cookie.value === "string")
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const deviceId = cookies.find((cookie) => cookie.name === "oai-did")?.value;
    return {
      ...(cookieHeader ? { cookieHeader } : {}),
      ...(deviceId ? { deviceId } : {}),
    };
  } catch {
    // The extension can still use credentials: include when the optional
    // cookies permission has not been granted yet.
    return {};
  }
}

function credentialForDeepSeek(credential: WebSessionCredential): { userToken: string } {
  if (credential.providerId !== "deepseek-web") throw new AppError("auth-required", "DeepSeek Web 登录态不存在");
  return { userToken: credential.userToken };
}

function stripGeminiConversationPrefix(value: string): string {
  return value.replace(/^c_/, "");
}

function providerLabel(providerId: WebSessionProviderId): string {
  if (providerId === "chatgpt-web") return "ChatGPT Web";
  if (providerId === "gemini-web") return "Gemini Web";
  return "DeepSeek Web";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
