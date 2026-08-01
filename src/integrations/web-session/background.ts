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
    void runRequest(port, storage, message.requestId, message.providerId, message.prompt, controller.signal)
      .finally(() => requests.delete(message.requestId));
  });
  port.onDisconnect.addListener(() => {
    for (const controller of requests.values()) controller.abort(new DOMException("Aborted", "AbortError"));
    requests.clear();
  });
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
    let externalUrl: string | undefined;
    if (providerId === "chatgpt-web") {
      const result = await streamChatGptWebRpc(prompt, credentialForChatGpt(credential), signal, ({ text }) => onUpdate(text));
      externalUrl = result.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(result.conversationId)}` : undefined;
    } else if (providerId === "gemini-web") {
      const result = await streamGeminiWebRpc(prompt, signal, ({ text }) => onUpdate(text));
      externalUrl = result.conversationId ? `https://gemini.google.com/app/${encodeURIComponent(stripGeminiConversationPrefix(result.conversationId))}` : undefined;
    } else {
      const result = await streamDeepSeekWebRpc(prompt, credentialForDeepSeek(credential), signal, ({ text }) => onUpdate(text));
      externalUrl = `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(result.sessionId)}`;
    }
    if (!signal.aborted) postMessage(port, { type: "done", requestId, ...(externalUrl ? { externalUrl } : {}) });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return;
    const appError = toAppError(error);
    if (appError.code === "auth-required" || appError.code === "token-refresh-failed") {
      await storage.clearWebSessionCredential(providerId).catch(() => undefined);
    }
    postMessage(port, { type: "error", requestId, error: serializeAppError(appError) });
  }
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
