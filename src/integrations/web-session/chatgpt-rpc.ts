import { AppError } from "../../domain/errors";
import { sha3_512 } from "js-sha3";

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
  /** The browser-issued device id, when it is available to the caller. */
  deviceId?: string;
  /** A request-scoped Cookie header; never persist this in WebSessionCredential. */
  cookieHeader?: string;
}

export interface ChatGptConversationRequirements {
  token: string;
  proofofwork?: {
    required?: boolean;
    seed?: string;
    difficulty?: string | number;
  };
  arkose?: { required?: boolean };
}

export interface ChatGptConversationContext {
  model: string;
  requirements: ChatGptConversationRequirements;
  proofToken?: string;
  sharedWebsocket: boolean;
}

export interface ChatGptWebRequestOptions {
  model?: string;
  deviceId?: string;
  requirementsToken?: string;
  proofToken?: string;
  arkoseToken?: string;
  websocketRequestId?: string;
}

/** Build the Web conversation request used by the background protocol client. */
export function buildChatGptWebRequest(
  prompt: string,
  accessToken: string,
  options: ChatGptWebRequestOptions = {},
): ChatGptWebRequest {
  const parentMessageId = generateRequestId();
  const body = {
    action: "next",
    messages: [{
      id: generateRequestId(),
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
      metadata: {},
    }],
    model: options.model || "auto",
    parent_message_id: parentMessageId,
    conversation_id: null,
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(options.websocketRequestId ? { websocket_request_id: options.websocketRequestId } : {}),
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
        ...(options.deviceId ? { "Oai-Device-Id": options.deviceId } : {}),
        ...(options.requirementsToken ? { "Openai-Sentinel-Chat-Requirements-Token": options.requirementsToken } : {}),
        ...(options.proofToken ? { "Openai-Sentinel-Proof-Token": options.proofToken } : {}),
        ...(options.arkoseToken ? { "Openai-Sentinel-Arkose-Token": options.arkoseToken } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Prepare the same session prerequisites used by /conversation. This is kept
 * exported for diagnostics and tests; the options-page test uses the real
 * conversation stream below so it cannot report a models-only false positive.
 */
export async function testChatGptWebRpc(credential: ChatGptWebCredential, signal: AbortSignal): Promise<void> {
  await prepareChatGptWebConversation(credential, signal);
}

export async function prepareChatGptWebConversation(
  credential: ChatGptWebCredential,
  signal: AbortSignal,
): Promise<ChatGptConversationContext> {
  const headers = buildChatGptAuthHeaders(credential);
  const modelsResponse = await fetch("https://chatgpt.com/backend-api/models", {
    method: "GET",
    credentials: "include",
    headers: { ...headers, Accept: "application/json" },
    signal,
  });
  const modelsPayload = await readChatGptJsonResponse(modelsResponse, "模型列表", signal);
  const model = selectChatGptModel(modelsPayload);

  const requirementsResponse = await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements", {
    method: "POST",
    credentials: "include",
    headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" },
    signal,
  });
  const requirementsPayload = await readChatGptJsonResponse(requirementsResponse, "会话安全要求", signal);
  const requirements = parseChatGptRequirements(requirementsPayload);
  if (requirements.arkose?.required) {
    throw new AppError(
      "security-check-required",
      "ChatGPT Web 要求完成安全校验，请在 ChatGPT 页面完成验证后重试",
      { retryable: true },
    );
  }
  let proofToken: string | undefined;
  if (requirements.proofofwork?.required) {
    const seed = requirements.proofofwork.seed;
    const difficulty = requirements.proofofwork.difficulty;
    if (!seed || difficulty === undefined || difficulty === null) {
      throw new AppError("api-contract", "ChatGPT Web Proof-of-Work 参数缺失", { retryable: true });
    }
    proofToken = await generateChatGptProofToken(
      seed,
      String(difficulty),
      typeof navigator !== "undefined" ? navigator.userAgent : "Mozilla/5.0",
      signal,
    );
  }

  let sharedWebsocket = false;
  const accountResponse = await fetch("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", {
    method: "GET",
    credentials: "include",
    headers: { ...headers, Accept: "application/json" },
    signal,
  });
  if (accountResponse.status === 401 || accountResponse.status === 403) {
    throw new AppError("auth-required", "ChatGPT Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (accountResponse.ok) {
    const accountText = await accountResponse.text();
    sharedWebsocket = accountText.includes("shared_websocket");
  }
  return { model, requirements, ...(proofToken ? { proofToken } : {}), sharedWebsocket };
}

export async function generateChatGptProofToken(
  seed: string,
  difficulty: string,
  userAgent: string,
  signal?: AbortSignal,
): Promise<string> {
  const cores = [1, 2, 4];
  const screens = [3008, 4010, 6000];
  const reacts = [
    "_reactListeningcfilawjnerp",
    "_reactListening9ne2dfo1i47",
    "_reactListening410nzwhan2a",
  ];
  const acts = ["alert", "ontransitionend", "onprogress"];
  const randomIndex = (length: number): number => {
    if (globalThis.crypto?.getRandomValues) {
      const value = new Uint32Array(1);
      globalThis.crypto.getRandomValues(value);
      return value[0] % length;
    }
    return Math.floor(Math.random() * length);
  };
  const config: unknown[] = [
    screens[randomIndex(screens.length)] + cores[randomIndex(cores.length)],
    new Date().toString(),
    4294705152,
    0,
    userAgent,
    "https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js",
    "dpl=1440a687921de39ff5ee56b92807faaadce73f13",
    "en",
    "en-US",
    4294705152,
    "plugins−[object PluginArray]",
    reacts[randomIndex(reacts.length)],
    acts[randomIndex(acts.length)],
  ];
  const normalizedDifficulty = difficulty.toLowerCase();
  for (let attempt = 0; attempt < 200_000; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    config[3] = attempt;
    const base = encodeBase64(JSON.stringify(config));
    const hash = sha3_512(seed + base);
    if (hash.slice(0, normalizedDifficulty.length) <= normalizedDifficulty) return `gAAAAAB${base}`;
    if (attempt % 512 === 511) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return `gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${encodeBase64(JSON.stringify(seed))}`;
}

function buildChatGptAuthHeaders(credential: ChatGptWebCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    "Oai-Device-Id": credential.deviceId || generateRequestId(),
    "OAI-Language": typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    ...(credential.cookieHeader ? { Cookie: credential.cookieHeader } : {}),
  };
}

async function readChatGptJsonResponse(response: Response, label: string, signal: AbortSignal): Promise<unknown> {
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "ChatGPT Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (response.status === 418) {
    throw new AppError("security-check-required", "ChatGPT Web 要求完成安全校验，请在 ChatGPT 页面完成验证后重试", { retryable: true });
  }
  if (response.status === 429) {
    throw new AppError("rate-limit", "ChatGPT Web 请求过于频繁，请稍后重试", { retryable: true });
  }
  if (!response.ok) {
    throw new AppError("api-unavailable", `ChatGPT Web ${label}失败（HTTP ${response.status}）`, { retryable: true });
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const text = await response.text();
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (contentType.includes("text/html") || /<html[\s>]/i.test(text)) {
    throw new AppError("auth-required", "ChatGPT Web 返回了登录页面，请重新登录", { retryable: true });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError("api-contract", `ChatGPT Web ${label}响应不是有效 JSON`, { cause: error, retryable: true });
  }
}

function selectChatGptModel(value: unknown): string {
  const models: unknown[] = value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).models)
    ? (value as Record<string, unknown>).models as unknown[]
    : Array.isArray(value) ? value : [];
  const slugs = models
    .map((model) => typeof model === "string" ? model : model && typeof model === "object" ? (model as Record<string, unknown>).slug : undefined)
    .filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0);
  if (slugs.includes("auto")) return "auto";
  if (slugs[0]) return slugs[0];
  throw new AppError("api-contract", "ChatGPT Web 没有返回可用模型", { retryable: true });
}

function parseChatGptRequirements(value: unknown): ChatGptConversationRequirements {
  if (!value || typeof value !== "object") {
    throw new AppError("api-contract", "ChatGPT Web 会话安全要求为空", { retryable: true });
  }
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || !record.token) {
    throw new AppError("api-contract", "ChatGPT Web 会话安全 Token 缺失", { retryable: true });
  }
  const proof = record.proofofwork && typeof record.proofofwork === "object"
    ? record.proofofwork as Record<string, unknown>
    : undefined;
  const arkose = record.arkose && typeof record.arkose === "object"
    ? record.arkose as Record<string, unknown>
    : undefined;
  return {
    token: record.token,
    ...(proof ? {
      proofofwork: {
        required: proof.required === true,
        ...(typeof proof.seed === "string" ? { seed: proof.seed } : {}),
        ...((typeof proof.difficulty === "string" || typeof proof.difficulty === "number") ? { difficulty: proof.difficulty } : {}),
      },
    } : {}),
    ...(arkose ? { arkose: { required: arkose.required === true } } : {}),
  };
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
  let socketStream: Promise<{ conversationId?: string }> | undefined;
  const socketExpected: { responseId?: string; conversationId?: string } = {};
  try {
    const context = await prepareChatGptWebConversation(credential, signal);
    const authHeaders: Record<string, string> = {
      ...buildChatGptAuthHeaders(credential),
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Openai-Sentinel-Chat-Requirements-Token": context.requirements.token,
      ...(context.proofToken ? { "Openai-Sentinel-Proof-Token": context.proofToken } : {}),
    };
    let websocketRequestId: string | undefined;
    if (context.sharedWebsocket) {
      registeredSocket = await openRegisteredSocket(authHeaders, signal, true);
      if (!registeredSocket) throw new AppError("api-unavailable", "ChatGPT Web 共享流连接未建立", { retryable: true });
      websocketRequestId = generateRequestId();
    }
    // The shared websocket can start delivering frames as soon as it opens.
    // Attach the reader before POST /conversation so the first body frame is
    // not lost while the handshake response is in flight.
    if (registeredSocket) socketStream = readWebSocketStream(registeredSocket, signal, onUpdate, socketExpected);
    const request = buildChatGptWebRequest(prompt, credential.accessToken, {
      model: context.model,
      deviceId: authHeaders["Oai-Device-Id"],
      requirementsToken: context.requirements.token,
      proofToken: context.proofToken,
      websocketRequestId,
    });
    const response = await fetch(request.url, { ...request.init, signal, headers: authHeaders });
    if (response.status === 401 || response.status === 403) {
      throw new AppError("auth-required", "ChatGPT Web 登录态已失效，请重新登录", { retryable: true });
    }
    if (response.status === 429) {
      throw new AppError("rate-limit", "ChatGPT Web 请求过于频繁，请稍后重试", { retryable: true });
    }
    if (response.status === 418) {
      throw new AppError("security-check-required", "ChatGPT Web 要求完成安全校验，请在 ChatGPT 页面完成验证后重试", { retryable: true });
    }
    if (!response.ok) {
      throw new AppError("api-unavailable", `ChatGPT Web 请求失败（HTTP ${response.status}）`, { retryable: true });
    }

    const contentType = response.headers.get("content-type") || "";
    let conversationId: string | undefined;
    if (contentType.includes("application/json")) {
      const handshake = await response.json() as {
        wss_url?: unknown;
        response_id?: unknown;
        conversation_id?: unknown;
        websocket_request_id?: unknown;
      };
      const wssUrl = typeof handshake.wss_url === "string" ? handshake.wss_url : "";
      const responseId = typeof handshake.response_id === "string" ? handshake.response_id : "";
      const handshakeConversationId = typeof handshake.conversation_id === "string"
        ? handshake.conversation_id
        : undefined;
      const websocketRequestId = typeof handshake.websocket_request_id === "string"
        ? handshake.websocket_request_id
        : undefined;

      Object.assign(socketExpected, {
        ...(responseId ? { responseId } : {}),
        ...(handshakeConversationId ? { conversationId: handshakeConversationId } : {}),
      });

      // Modern shared-websocket responses return conversation_id and
      // websocket_request_id. Older deployments returned wss_url/response_id
      // and required a second websocket connection, so keep that path too.
      if (socketStream && (!wssUrl || registeredSocket?.url === wssUrl)) {
        const result = await socketStream;
        conversationId = result.conversationId || handshakeConversationId;
      } else if (wssUrl) {
        const socket = await connectWebSocket(wssUrl, signal, "json.reliable.webpubsub.azure.v1");
        if (!socket) throw new AppError("api-unavailable", "ChatGPT Web 流连接失败", { retryable: true });
        const result = await readWebSocketStream(socket, signal, onUpdate, {
          responseId: responseId || undefined,
          conversationId: handshakeConversationId,
        });
        conversationId = result.conversationId || handshakeConversationId;
      } else if (handshakeConversationId && websocketRequestId) {
        throw new AppError("api-unavailable", "ChatGPT Web 共享流连接未建立", { retryable: true });
      } else {
        throw new AppError("api-contract", "ChatGPT Web 没有返回可用的流连接信息", { retryable: true });
      }
    } else {
      if (registeredSocket) {
        registeredSocket.close();
        await socketStream?.catch(() => undefined);
        socketStream = undefined;
      }
      const result = await readChatGptStreamWithUpdates(response, signal, onUpdate);
      conversationId = result.conversationId;
    }
    if (!conversationId) throw new AppError("api-contract", "ChatGPT Web 没有返回会话 ID", { retryable: true });
    return { conversationId };
  } finally {
    if (registeredSocket && registeredSocket.readyState !== WebSocket.CLOSED) registeredSocket.close();
    await socketStream?.catch(() => undefined);
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

async function openRegisteredSocket(
  headers: Record<string, string>,
  signal: AbortSignal,
  required = false,
): Promise<WebSocket | null> {
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
    if (!response.ok) {
      if (required) throw new AppError("api-unavailable", `ChatGPT Web 共享流注册失败（HTTP ${response.status}）`, { retryable: true });
      return null;
    }
    const payload = await response.json() as { wss_url?: unknown };
    if (typeof payload.wss_url !== "string") {
      if (required) throw new AppError("api-contract", "ChatGPT Web 共享流地址缺失", { retryable: true });
      return null;
    }
    const socket = await connectWebSocket(payload.wss_url, signal);
    if (!socket && required) throw new AppError("api-unavailable", "ChatGPT Web 共享流连接失败", { retryable: true });
    return socket;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof AppError) throw error;
    if (required) {
      if (error instanceof AppError) throw error;
      throw new AppError("api-unavailable", "ChatGPT Web 共享流注册失败", { cause: error, retryable: true });
    }
    // Registration is optional when the account does not require shared WebSocket.
    return null;
  }
}

async function connectWebSocket(url: string, signal: AbortSignal, protocol?: string): Promise<WebSocket | null> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const socket = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
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
  signal: AbortSignal,
  onUpdate: (update: ChatGptStreamUpdate) => void,
  expected: { responseId?: string; conversationId?: string } = {},
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
          conversation_id?: unknown;
          body?: unknown;
          data?: { response_id?: unknown; conversation_id?: unknown; body?: unknown };
        };
        if (typeof envelope.sequenceId === "number" && envelope.sequenceId > lastSequenceId) {
          lastSequenceId = envelope.sequenceId;
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "sequenceAck", sequenceId: lastSequenceId }));
        }
        const isLegacyMessage = envelope.type === "message";
        const isSharedBody = envelope.type === "http.response.body";
        if (!isLegacyMessage && !isSharedBody) return;
        const responseId = typeof envelope.data?.response_id === "string" ? envelope.data.response_id : undefined;
        const frameConversationId = typeof envelope.conversation_id === "string"
          ? envelope.conversation_id
          : typeof envelope.data?.conversation_id === "string" ? envelope.data.conversation_id : undefined;
        const frameBody = typeof envelope.body === "string"
          ? envelope.body
          : typeof envelope.data?.body === "string" ? envelope.data.body : undefined;
        if (!frameBody) return;
        if (expected.responseId && responseId && responseId !== expected.responseId) return;
        if (expected.conversationId && frameConversationId && frameConversationId !== expected.conversationId) return;
        if (frameConversationId) conversationId = frameConversationId;
        for (const line of decodeChatGptWebSocketBody(frameBody).split("\n")) {
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
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeChatGptWebSocketBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("data:") || trimmed === "[DONE]" || trimmed.startsWith("{")) return trimmed;
  try {
    const decoded = decodeBase64(trimmed);
    return decoded || trimmed;
  } catch {
    // A few compatible gateways forward the SSE body without base64.
    return trimmed;
  }
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (placeholder) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = placeholder === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });
}
