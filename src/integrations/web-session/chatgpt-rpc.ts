import { AppError } from "../../domain/errors";

export interface ChatGptWebRequest {
  url: string;
  init: RequestInit;
}

export interface ChatGptStreamUpdate {
  text: string;
  conversationId?: string;
}

export interface ChatGptWebCredential {
  accessToken: string;
}

/** Build the Web conversation request used by the background protocol client. */
export function buildChatGptWebRequest(prompt: string, accessToken: string): ChatGptWebRequest {
  const parentMessageId = generateRequestId();
  const body = {
    action: "next",
    messages: [{
      id: generateRequestId(),
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
      metadata: {},
    }],
    model: "auto",
    parent_message_id: parentMessageId,
    conversation_id: null,
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    websocket_request_id: generateRequestId(),
    force_parallel_switch: "auto",
    force_paragen: false,
    force_nulligen: false,
    force_rate_limit: false,
    force_paragen_model_slug: "",
    history_and_training_disabled: false,
    conversation_mode: { kind: "primary_assistant" },
  };

  return {
    url: "https://chatgpt.com/backend-api/conversation",
    init: {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "OAI-Language": "en-US",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
      },
      body: JSON.stringify(body),
    },
  };
}

export interface ChatGptStreamLine {
  done: boolean;
  text: string;
  conversationId?: string;
}

export function parseChatGptStreamLine(line: string): ChatGptStreamLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (data === "[DONE]") return { done: true, text: "" };
  try {
    const parsed = JSON.parse(data) as unknown;
    return {
      done: false,
      text: extractChatGptText(parsed),
      conversationId: extractConversationId(parsed),
    };
  } catch {
    return null;
  }
}

export async function streamChatGptWebRpc(
  prompt: string,
  credential: ChatGptWebCredential,
  signal: AbortSignal,
  onUpdate: (update: ChatGptStreamUpdate) => void,
): Promise<{ conversationId?: string }> {
  let registeredSocket: WebSocket | null = null;
  try {
    const authHeaders = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.accessToken}`,
      "OAI-Language": typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    };

    registeredSocket = await openRegisteredSocket(authHeaders, signal);
    const request = buildChatGptWebRequest(prompt, credential.accessToken);
    const response = await fetch(request.url, { ...request.init, signal, headers: authHeaders });
    if (response.status === 401 || response.status === 403) {
      throw new AppError("auth-required", "ChatGPT Web 登录态已失效，请重新登录", { retryable: true });
    }
    if (response.status === 429) {
      throw new AppError("rate-limit", "ChatGPT Web 请求过于频繁，请稍后重试", { retryable: true });
    }
    if (response.status === 418) {
      throw new AppError("auth-required", "ChatGPT Web 暂时要求完成安全校验，请重新打开页面验证", { retryable: true });
    }
    if (!response.ok) {
      throw new AppError("api-unavailable", `ChatGPT Web 请求失败（HTTP ${response.status}）`, { retryable: true });
    }

    const contentType = response.headers.get("content-type") || "";
    let conversationId: string | undefined;
    if (contentType.includes("application/json")) {
      const handshake = await response.json() as { wss_url?: unknown; response_id?: unknown };
      const wssUrl = typeof handshake.wss_url === "string" ? handshake.wss_url : "";
      const responseId = typeof handshake.response_id === "string" ? handshake.response_id : "";
      if (!wssUrl || !responseId) throw new AppError("api-contract", "ChatGPT Web 没有返回可用的流连接信息", { retryable: true });
      const socket = registeredSocket?.url === wssUrl
        ? registeredSocket
        : await connectWebSocket(wssUrl, signal);
      if (!socket) throw new AppError("api-unavailable", "ChatGPT Web 流连接失败", { retryable: true });
      if (registeredSocket && socket !== registeredSocket) registeredSocket.close();
      const result = await readWebSocketStream(socket, responseId, signal, onUpdate);
      conversationId = result.conversationId;
    } else {
      const result = await readChatGptStreamWithUpdates(response, signal, onUpdate);
      conversationId = result.conversationId;
    }
    if (!conversationId) throw new AppError("api-contract", "ChatGPT Web 没有返回会话 ID", { retryable: true });
    return { conversationId };
  } finally {
    if (registeredSocket && registeredSocket.readyState !== WebSocket.CLOSED) registeredSocket.close();
  }
}

export async function readChatGptStream(response: Response, signal?: AbortSignal): Promise<string> {
  let latest = "";
  await readChatGptStreamWithUpdates(response, signal, ({ text }) => { latest = text; });
  return latest;
}

async function readChatGptStreamWithUpdates(
  response: Response,
  signal: AbortSignal | undefined,
  onUpdate: (update: ChatGptStreamUpdate) => void,
): Promise<{ text: string; conversationId?: string }> {
  if (!response.body) throw new AppError("api-contract", "ChatGPT Web 返回了空响应流", { retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let latestText = "";
  let conversationId: string | undefined;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const result = consumeChatGptLines(buffer, latestText, conversationId, onUpdate);
      buffer = result.buffer;
      latestText = result.text;
      conversationId = result.conversationId;
      if (result.done) break;
    }
    buffer += decoder.decode();
    const result = consumeChatGptLines(`${buffer}\n`, latestText, conversationId, onUpdate);
    latestText = result.text;
    conversationId = result.conversationId;
  } finally {
    reader.releaseLock();
  }
  if (!latestText.trim()) throw new AppError("api-contract", "ChatGPT Web 返回内容为空或格式暂不支持", { retryable: true });
  return { text: latestText, conversationId };
}

function consumeChatGptLines(
  input: string,
  previousText: string,
  previousConversationId: string | undefined,
  onUpdate: (update: ChatGptStreamUpdate) => void,
): { buffer: string; text: string; conversationId?: string; done: boolean } {
  let buffer = input;
  let latestText = previousText;
  let conversationId = previousConversationId;
  let done = false;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    const parsed = parseChatGptStreamLine(line);
    if (parsed?.conversationId) conversationId = parsed.conversationId;
    if (parsed?.text) {
      const nextText = mergeChatGptText(latestText, parsed.text);
      if (nextText !== latestText) {
        latestText = nextText;
        onUpdate({ text: latestText, conversationId });
      }
    }
    if (parsed?.done) {
      done = true;
      break;
    }
    newlineIndex = buffer.indexOf("\n");
  }
  return { buffer, text: latestText, conversationId, done };
}

async function openRegisteredSocket(headers: Record<string, string>, signal: AbortSignal): Promise<WebSocket | null> {
  try {
    const response = await fetch("https://chatgpt.com/backend-api/register-websocket", {
      method: "POST",
      credentials: "include",
      headers: { ...headers, Accept: "application/json" },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new AppError("auth-required", "ChatGPT Web 登录态已失效，请重新登录", { retryable: true });
    }
    if (!response.ok) return null;
    const payload = await response.json() as { wss_url?: unknown };
    return typeof payload.wss_url === "string" ? connectWebSocket(payload.wss_url, signal) : null;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof AppError) throw error;
    // Registration is an optimization. The conversation endpoint can still
    // return a normal SSE response when WebSocket registration is unavailable.
    return null;
  }
}

async function connectWebSocket(url: string, signal: AbortSignal): Promise<WebSocket | null> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const socket = new WebSocket(url, "json.reliable.webpubsub.azure.v1");
  try {
    await waitForSocket(socket, signal, 5_000);
    return socket;
  } catch (error) {
    socket.close();
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof AppError) throw error;
    return null;
  }
}

async function waitForSocket(socket: WebSocket, signal: AbortSignal, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("ChatGPT WebSocket 连接超时")); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("ChatGPT WebSocket 连接失败")); };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function readWebSocketStream(
  socket: WebSocket,
  responseId: string,
  signal: AbortSignal,
  onUpdate: (update: ChatGptStreamUpdate) => void,
): Promise<{ conversationId?: string }> {
  return new Promise<{ conversationId?: string }>((resolve, reject) => {
    let latestText = "";
    let conversationId: string | undefined;
    let lastSequenceId = 0;
    let sawDone = false;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("ChatGPT WebSocket 响应超时")), 120_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close();
      if (error) reject(error);
      else if (!latestText.trim()) reject(new AppError("api-contract", "ChatGPT Web 返回内容为空", { retryable: true }));
      else resolve({ conversationId });
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    const onError = () => finish(new Error("ChatGPT WebSocket 响应失败"));
    const onClose = () => {
      if (!sawDone) {
        finish(new AppError("api-contract", "ChatGPT Web 流连接提前关闭", { retryable: true }));
        return;
      }
      finish();
    };
    const onMessage = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as {
          sequenceId?: unknown;
          type?: unknown;
          data?: { response_id?: unknown; body?: unknown };
        };
        if (typeof envelope.sequenceId === "number" && envelope.sequenceId > lastSequenceId) {
          lastSequenceId = envelope.sequenceId;
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "sequenceAck", sequenceId: lastSequenceId }));
        }
        if (envelope.type !== "message" || envelope.data?.response_id !== responseId || typeof envelope.data.body !== "string") return;
        for (const line of decodeBase64(envelope.data.body).split("\n")) {
          const parsed = parseChatGptStreamLine(line);
          if (!parsed) continue;
          if (parsed.conversationId) conversationId = parsed.conversationId;
          if (parsed.text) {
            const nextText = mergeChatGptText(latestText, parsed.text);
            if (nextText !== latestText) {
              latestText = nextText;
              onUpdate({ text: latestText, conversationId });
            }
          }
          if (parsed.done) {
            sawDone = true;
            return finish();
          }
        }
      } catch {
        // Ignore unrelated reliable-protocol frames.
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function extractChatGptText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : record;
  const content = message.content;
  if (content && typeof content === "object") {
    const contentRecord = content as Record<string, unknown>;
    const contentType = typeof contentRecord.content_type === "string" ? contentRecord.content_type : "";
    if (["analysis", "reasoning", "reasoning_recap", "thoughts"].includes(contentType)) return "";
    if (Array.isArray(contentRecord.parts)) return contentRecord.parts.filter((part): part is string => typeof part === "string").join("");
    if (typeof contentRecord.text === "string") return contentRecord.text;
  }
  return typeof record.text === "string" ? record.text : "";
}

function extractConversationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : undefined;
  const metadata = message?.metadata && typeof message.metadata === "object" ? message.metadata as Record<string, unknown> : undefined;
  const response = record.response && typeof record.response === "object" ? record.response as Record<string, unknown> : undefined;
  for (const candidate of [
    record.conversation_id,
    record.conversationId,
    message?.conversation_id,
    message?.conversationId,
    metadata?.conversation_id,
    response?.conversation_id,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function mergeChatGptText(previous: string, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return `${previous}${next}`;
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8").decode(bytes);
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (placeholder) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = placeholder === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });
}
