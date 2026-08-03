import { browser } from "wxt/browser";
import { AppError, toAppError } from "../../domain/errors";
import type { WebSessionCredential, WebSessionProviderId } from "../../domain/types";
import { createSettingsRepository } from "../../platform/chrome/storage";
import { streamChatGptWebRpc } from "./chatgpt-rpc";
import { streamDeepSeekWebRpc } from "./deepseek-rpc";
import { streamGeminiWebRpc } from "./gemini-rpc";
import {
  isWebSessionPortRequest,
  serializeAppError,
  WEB_SESSION_PORT_NAME,
  type WebSessionPortMessage,
} from "./messages";

interface WebSessionPortLike {
  name: string;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: WebSessionPortMessage): void;
}

const CONNECTION_TEST_PROMPT = "只回复 PROJECT_OK";

export function installWebSessionBackground(): void {
  const storage = createSettingsRepository();
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== WEB_SESSION_PORT_NAME) return;
    handlePort(port as unknown as WebSessionPortLike, storage);
  });
}

function handlePort(port: WebSessionPortLike, storage: ReturnType<typeof createSettingsRepository>): void {
  const requests = new Map<string, AbortController>();
  port.onMessage.addListener((message) => {
    if (!isWebSessionPortRequest(message)) return;
    if (message.type === "heartbeat") return;
    if (message.type === "cancel") {
      requests.get(message.requestId)?.abort(new DOMException("Aborted", "AbortError"));
      return;
    }
    if (requests.has(message.requestId)) return;
    const controller = new AbortController();
    requests.set(message.requestId, controller);
    const task = message.type === "test"
      ? runTest(port, storage, message.requestId, message.providerId, controller.signal)
      : runRequest(port, storage, message.requestId, message.providerId, message.prompt, controller.signal);
    void task.finally(() => requests.delete(message.requestId));
  });
  port.onDisconnect.addListener(() => {
    for (const controller of requests.values()) controller.abort(new DOMException("Aborted", "AbortError"));
    requests.clear();
  });
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

async function runRequest(
  port: WebSessionPortLike,
  storage: ReturnType<typeof createSettingsRepository>,
  requestId: string,
  providerId: WebSessionProviderId,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const credential = await storage.getWebSessionCredential(providerId);
    if (!credential) throw new AppError("auth-required", `请先登录 ${providerLabel(providerId)}`);
    const onUpdate = (text: string) => {
      if (!signal.aborted && text) postMessage(port, { type: "snapshot", requestId, text });
    };
    const result = await executeProviderStream(providerId, credential, prompt, signal, onUpdate);
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
    }, signal, ({ text }) => update(text));
    return {
      text: latestText,
      ...(result.conversationId ? { externalUrl: `https://chatgpt.com/c/${encodeURIComponent(result.conversationId)}` } : {}),
    };
  }
  if (providerId === "gemini-web") {
    const result = await streamGeminiWebRpc(prompt, signal, ({ text }) => update(text), credentialForGemini(credential).authUser);
    return {
      text: latestText,
      ...(result.conversationId ? { externalUrl: `https://gemini.google.com/app/${encodeURIComponent(stripGeminiConversationPrefix(result.conversationId))}` } : {}),
    };
  }
  const result = await streamDeepSeekWebRpc(prompt, credentialForDeepSeek(credential), signal, ({ text }) => update(text));
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
