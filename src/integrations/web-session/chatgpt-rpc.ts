import { AppError } from "../../domain/errors";

export type ChatGptWebPageResult =
  | { status: "ok"; text: string }
  | { status: "auth-required"; message: string }
  | { status: "failed"; message: string };

export interface ChatGptWebRequest {
  url: string;
  init: RequestInit;
}

/**
 * Build the same-origin ChatGPT Web request used by the page-world adapter.
 * The access token is deliberately passed only to the in-memory request; the
 * extension never persists or returns it.
 */
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
    url: "/backend-api/conversation",
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
}

export function parseChatGptStreamLine(line: string): ChatGptStreamLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (data === "[DONE]") return { done: true, text: "" };
  try {
    const parsed = JSON.parse(data) as unknown;
    return { done: false, text: extractChatGptText(parsed) };
  } catch {
    return null;
  }
}

/**
 * This function is serialized into the ChatGPT tab's MAIN world. Keep it
 * self-contained: it must not close over extension state or imported helpers.
 * The session endpoint and conversation request therefore run with the page's
 * own cookies, while only the final text crosses the scripting boundary.
 */
export async function runChatGptWebRpc(prompt: string): Promise<ChatGptWebPageResult> {
  if (location.origin !== "https://chatgpt.com") return { status: "failed", message: "ChatGPT 页面来源不匹配" };

  let registeredSocket: WebSocket | null = null;
  try {
    const sessionResponse = await fetch("/api/auth/session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (sessionResponse.status === 401 || sessionResponse.status === 403) {
      return { status: "auth-required", message: "ChatGPT Web 当前未登录或登录态已失效" };
    }
    if (!sessionResponse.ok) return { status: "failed", message: `ChatGPT 会话检查失败（HTTP ${sessionResponse.status}）` };

    const session = await sessionResponse.json() as { accessToken?: unknown };
    const accessToken = typeof session.accessToken === "string" ? session.accessToken : "";
    if (!accessToken) return { status: "auth-required", message: "ChatGPT Web 未返回可用会话" };

    const parentMessageId = crypto.randomUUID();
    const authHeaders = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "OAI-Language": navigator.language || "en-US",
      Origin: location.origin,
      Referer: location.href,
    };
    registeredSocket = await openRegisteredSocket(authHeaders);
    const body = {
      action: "next",
      messages: [{
        id: crypto.randomUUID(),
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt] },
        metadata: {},
      }],
      model: "auto",
      parent_message_id: parentMessageId,
      conversation_id: null,
      timezone_offset_min: new Date().getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      websocket_request_id: crypto.randomUUID(),
      force_parallel_switch: "auto",
      force_paragen: false,
      force_nulligen: false,
      force_rate_limit: false,
      force_paragen_model_slug: "",
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
    };
    const response = await fetch("/backend-api/conversation", {
      method: "POST",
      credentials: "include",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      registeredSocket?.close();
      return { status: "auth-required", message: "ChatGPT Web 登录态已失效，请重新登录" };
    }
    if (response.status === 429) {
      registeredSocket?.close();
      return { status: "failed", message: "ChatGPT Web 请求过于频繁，请稍后重试" };
    }
    if (response.status === 418) {
      registeredSocket?.close();
      return { status: "failed", message: "ChatGPT Web 暂时要求完成安全校验" };
    }
    if (!response.ok) {
      registeredSocket?.close();
      return { status: "failed", message: `ChatGPT Web 请求失败（HTTP ${response.status}）` };
    }

    const contentType = response.headers.get("content-type") || "";
    let text = "";
    if (contentType.includes("application/json")) {
      let handshake: { wss_url?: unknown; response_id?: unknown } | null = null;
      try {
        handshake = await response.json() as { wss_url?: unknown; response_id?: unknown };
      } catch {
        handshake = null;
      }
      const wssUrl = typeof handshake?.wss_url === "string" ? handshake.wss_url : "";
      const responseId = typeof handshake?.response_id === "string" ? handshake.response_id : "";
      if (wssUrl && responseId) {
        const socket = registeredSocket?.url === wssUrl ? registeredSocket : await connectWebSocket(wssUrl);
        if (socket) {
          if (registeredSocket && socket !== registeredSocket) registeredSocket.close();
          text = await readWebSocketStream(socket, responseId);
        }
      }
    } else {
      text = await readStream(response);
    }
    if (registeredSocket && registeredSocket.readyState !== WebSocket.CLOSED) registeredSocket.close();
    return text.trim() ? { status: "ok", text: text.trim() } : { status: "failed", message: "ChatGPT Web 返回内容为空或格式暂不支持" };
  } catch (error) {
    registeredSocket?.close();
    return { status: "failed", message: error instanceof Error ? error.message : "ChatGPT Web 请求失败" };
  }

  async function openRegisteredSocket(headers: Record<string, string>): Promise<WebSocket | null> {
    try {
      const registration = await fetch("/backend-api/register-websocket", {
        method: "POST",
        credentials: "include",
        headers: { ...headers, Accept: "application/json" },
      });
      if (!registration.ok) return null;
      const payload = await registration.json() as { wss_url?: unknown };
      return typeof payload.wss_url === "string" ? await connectWebSocket(payload.wss_url) : null;
    } catch {
      return null;
    }
  }

  async function connectWebSocket(url: string): Promise<WebSocket | null> {
    try {
      const socket = new WebSocket(url, "json.reliable.webpubsub.azure.v1");
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("ChatGPT WebSocket 连接超时")), 5_000);
        socket.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("ChatGPT WebSocket 连接失败"));
        }, { once: true });
      });
      return socket;
    } catch {
      return null;
    }
  }

  async function readWebSocketStream(socket: WebSocket, responseId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let latestText = "";
      let finished = false;
      let lastSequenceId = 0;
      const timeout = setTimeout(() => finish(new Error("ChatGPT WebSocket 响应超时")), 90_000);
      const cleanup = () => {
        clearTimeout(timeout);
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
        else resolve(latestText);
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
          const bodyText = decodeBase64(envelope.data.body);
          for (const line of bodyText.split("\n")) {
            const parsed = parseStreamLine(line);
            if (!parsed) continue;
            if (parsed.text) latestText = mergeText(latestText, parsed.text);
            if (parsed.done) return finish();
          }
        } catch {
          // Ignore unrelated reliable-protocol frames.
        }
      };
      const onError = () => finish(new Error("ChatGPT WebSocket 响应失败"));
      const onClose = () => finish();
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  function parseStreamLine(line: string): { done: boolean; text: string } | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return null;
    const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (data === "[DONE]") return { done: true, text: "" };
    try {
      const parsed = JSON.parse(data) as unknown;
      return { done: false, text: extractText(parsed) };
    } catch {
      return null;
    }
  }

  function decodeBase64(value: string): string {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function extractText(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const message = record.message && typeof record.message === "object"
      ? record.message as Record<string, unknown>
      : record;
    const content = message.content;
    if (content && typeof content === "object") {
      const contentRecord = content as Record<string, unknown>;
      if (Array.isArray(contentRecord.parts)) {
        return contentRecord.parts.filter((part): part is string => typeof part === "string").join("");
      }
      if (typeof contentRecord.text === "string") return contentRecord.text;
    }
    return typeof record.text === "string" ? record.text : "";
  }

  function mergeText(previous: string, next: string): string {
    if (!previous) return next;
    if (next.startsWith(previous)) return next;
    if (previous.endsWith(next)) return previous;
    return `${previous}${next}`;
  }

  async function readStream(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let latestText = "";

    const consume = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) return false;
      const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (data === "[DONE]") return true;
      try {
        const parsed = JSON.parse(data) as unknown;
        const text = extractText(parsed);
        if (text) latestText = mergeText(latestText, text);
      } catch {
        // Ignore heartbeat and non-JSON stream lines.
      }
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (consume(line)) return latestText;
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    return latestText;
  }

}

export async function readChatGptStream(response: Response): Promise<string> {
  if (!response.body) throw new AppError("api-contract", "ChatGPT Web 返回了空响应流", { retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let latestText = "";

  const consume = (line: string): boolean => {
    const parsed = parseChatGptStreamLine(line);
    if (!parsed) return false;
    if (parsed.text) latestText = mergeChatGptText(latestText, parsed.text);
    return parsed.done;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (consume(line)) return latestText;
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  consume(buffer);
  return latestText;
}

function extractChatGptText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : record;
  const content = message.content;
  if (content && typeof content === "object") {
    const contentRecord = content as Record<string, unknown>;
    if (Array.isArray(contentRecord.parts)) {
      return contentRecord.parts.filter((part): part is string => typeof part === "string").join("");
    }
    if (typeof contentRecord.text === "string") return contentRecord.text;
  }
  return typeof record.text === "string" ? record.text : "";
}

function mergeChatGptText(previous: string, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return `${previous}${next}`;
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (placeholder) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = placeholder === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });
}
