import { AppError } from "../../domain/errors";
import { readSseStream } from "../shared/sse";
import { buildDeepSeekPowResponse, type DeepSeekPowChallenge } from "./deepseek-pow";

const BASE_URL = "https://chat.deepseek.com";
const COMPLETION_PATH = "/api/v0/chat/completion";

export interface DeepSeekWebCredential {
  userToken: string;
  /** Short-lived token returned by /users/current; never persisted. */
  accessToken?: string;
}

export interface DeepSeekStreamUpdate {
  text: string;
  messageId?: number;
}

export function buildDeepSeekCompletionRequest(
  prompt: string,
  sessionId: string,
  parentMessageId: number | null,
  credential: DeepSeekWebCredential,
  powResponse: string,
): { url: string; init: RequestInit } {
  const headers = createHeaders(credential.accessToken || credential.userToken);
  headers["x-ds-pow-response"] = powResponse;
  return {
    url: `${BASE_URL}${COMPLETION_PATH}`,
    init: {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        prompt,
        ref_file_ids: [],
        thinking_enabled: false,
        search_enabled: false,
        action: null,
        preempt: false,
        model_type: "default",
      }),
    },
  };
}

export async function streamDeepSeekWebRpc(
  prompt: string,
  credential: DeepSeekWebCredential,
  signal: AbortSignal,
  onUpdate: (update: DeepSeekStreamUpdate) => void,
): Promise<{ sessionId: string; messageId?: number }> {
  const accessToken = credential.accessToken || await acquireDeepSeekAccessToken(credential, signal);
  const accessCredential = { ...credential, accessToken };
  const sessionId = await createChatSession(accessCredential, signal);
  const challenge = await createPowChallenge(accessCredential, signal);
  const powResponse = await buildDeepSeekPowResponse(challenge, COMPLETION_PATH);
  const request = buildDeepSeekCompletionRequest(prompt, sessionId, null, accessCredential, powResponse);
  const response = await fetch(request.url, { ...request.init, signal });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "DeepSeek Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (response.status === 429) {
    throw new AppError("rate-limit", "DeepSeek Web 请求过于频繁，请稍后重试", { retryable: true });
  }
  if (!response.ok) {
    throw new AppError("api-unavailable", `DeepSeek Web 请求失败（HTTP ${response.status}）`, { retryable: true });
  }
  if (!response.body) throw new AppError("api-contract", "DeepSeek Web 没有返回消息流", { retryable: true });

  let latestText = "";
  let messageId: number | undefined;
  let activePath: string | undefined;
  let receivedResponse = false;
  for await (const event of readSseStream(response.body, signal)) {
    if (!event.data || event.data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const value = payload.v;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const snapshot = value as Record<string, unknown>;
      const responseValue = snapshot.response;
      if (responseValue && typeof responseValue === "object") {
        const responseRecord = responseValue as Record<string, unknown>;
        const candidateMessageId = responseRecord.message_id ?? responseRecord.id;
        if (typeof candidateMessageId === "number") messageId = candidateMessageId;
        const fragments = responseRecord.fragments;
        if (Array.isArray(fragments)) {
          const text = fragments
            .filter((fragment): fragment is Record<string, unknown> => Boolean(fragment && typeof fragment === "object" && (fragment as Record<string, unknown>).type === "RESPONSE"))
            .map((fragment) => typeof fragment.content === "string" ? fragment.content : "")
            .join("");
          if (text) {
            latestText = text;
            receivedResponse = true;
            activePath = "response/fragments/-1/content";
            onUpdate({ text: latestText, messageId });
          }
        }
      }
      continue;
    }
    if (typeof payload.p === "string") {
      activePath = payload.p;
      if (activePath.endsWith("message_id") && typeof value === "number") messageId = value;
      if (payload.o === "APPEND" && typeof value === "string" && activePath.endsWith("content")) {
        latestText += value;
        receivedResponse = true;
        onUpdate({ text: latestText, messageId });
      }
      continue;
    }
    if (typeof value === "string" && activePath?.endsWith("content")) {
      latestText += value;
      receivedResponse = true;
      onUpdate({ text: latestText, messageId });
    }
  }
  if (!receivedResponse || !latestText.trim()) {
    throw new AppError("api-contract", "DeepSeek Web 响应为空或格式暂不支持", { retryable: true });
  }
  return { sessionId, messageId };
}

async function acquireDeepSeekAccessToken(credential: DeepSeekWebCredential, signal: AbortSignal): Promise<string> {
  const cached = deepSeekAccessTokenCache.get(credential.userToken);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(`${BASE_URL}/api/v0/users/current`, {
    method: "GET",
    credentials: "include",
    headers: createHeaders(credential.userToken),
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "DeepSeek Web 登录态已失效，请重新登录", { retryable: true });
  }
  // Older deployments accepted userToken directly. Keep that path available
  // when the short-token endpoint is not present, while preferring the current
  // exchange protocol.
  if (response.status === 404 || response.status === 405) return credential.userToken;
  if (!response.ok) throw new AppError("api-unavailable", `DeepSeek 登录态刷新失败（HTTP ${response.status}）`, { retryable: true });
  const body = await response.json() as Record<string, unknown>;
  const biz = unwrapBiz(body);
  const accessToken = biz.token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new AppError("api-contract", "DeepSeek 没有返回可用的短时 access token", { retryable: true });
  }
  deepSeekAccessTokenCache.set(credential.userToken, { value: accessToken, expiresAt: Date.now() + 50 * 60 * 1_000 });
  return accessToken;
}

async function createChatSession(credential: DeepSeekWebCredential, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/v0/chat_session/create`, {
    method: "POST",
    credentials: "include",
    headers: createHeaders(credential.accessToken || credential.userToken),
    body: JSON.stringify({}),
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "DeepSeek Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (!response.ok) throw new AppError("api-unavailable", `DeepSeek 会话创建失败（HTTP ${response.status}）`, { retryable: true });
  const body = await response.json() as Record<string, unknown>;
  const biz = unwrapBiz(body);
  const chatSession = biz.chat_session;
  const id = chatSession && typeof chatSession === "object" ? (chatSession as Record<string, unknown>).id : undefined;
  if (typeof id !== "string" || !id) throw new AppError("api-contract", "DeepSeek 没有返回会话 ID", { retryable: true });
  return id;
}

async function createPowChallenge(credential: DeepSeekWebCredential, signal: AbortSignal): Promise<DeepSeekPowChallenge> {
  const response = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: "POST",
    credentials: "include",
    headers: createHeaders(credential.accessToken || credential.userToken),
    body: JSON.stringify({ target_path: COMPLETION_PATH }),
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "DeepSeek Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (!response.ok) throw new AppError("api-unavailable", `DeepSeek PoW challenge 请求失败（HTTP ${response.status}）`, { retryable: true });
  const body = await response.json() as Record<string, unknown>;
  const challenge = unwrapBiz(body).challenge;
  if (!challenge || typeof challenge !== "object") throw new AppError("api-contract", "DeepSeek 没有返回 PoW challenge", { retryable: true });
  const value = challenge as Record<string, unknown>;
  if (typeof value.algorithm !== "string" || typeof value.challenge !== "string" || typeof value.difficulty !== "number" || typeof value.salt !== "string" || typeof value.signature !== "string") {
    throw new AppError("api-contract", "DeepSeek PoW challenge 字段不完整", { retryable: true });
  }
  if (value.algorithm === "DeepSeekHashV1" && (!/^[0-9a-f]{64}$/i.test(value.challenge) || typeof value.expire_at !== "number" || !Number.isFinite(value.expire_at))) {
    throw new AppError("api-contract", "DeepSeek PoW challenge 格式不受支持", { retryable: true });
  }
  return value as unknown as DeepSeekPowChallenge;
}

const deepSeekAccessTokenCache = new Map<string, { value: string; expiresAt: number }>();

function createHeaders(bearerToken: string): Record<string, string> {
  return {
    Accept: "*/*",
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearerToken}`,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    "x-client-version": "2.0.0",
    "x-client-platform": "web",
    "x-client-locale": typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US",
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
  };
}

function unwrapBiz(data: Record<string, unknown>): Record<string, unknown> {
  const topLevelCode = data.code === undefined ? 0 : Number(data.code);
  if (topLevelCode !== 0) {
    if (topLevelCode === 401 || topLevelCode === 403 || topLevelCode === 40002 || topLevelCode === 40003) {
      throw new AppError("auth-required", "DeepSeek Web 登录态已失效，请重新登录", { retryable: true });
    }
    throw new AppError("api-auth", typeof data.msg === "string" ? data.msg : "DeepSeek Web 请求被拒绝", { retryable: true });
  }
  const dataValue = data.data;
  const biz = dataValue && typeof dataValue === "object" ? (dataValue as Record<string, unknown>).biz_data : undefined;
  if (!biz || typeof biz !== "object") throw new AppError("api-contract", "DeepSeek 返回结构不完整", { retryable: true });
  const dataRecord = dataValue as Record<string, unknown>;
  if (dataRecord.biz_code !== undefined && Number(dataRecord.biz_code) !== 0) {
    const code = Number(dataRecord.biz_code);
    if (code === 40002 || code === 40003) throw new AppError("auth-required", "DeepSeek Web 登录态已失效，请重新登录", { retryable: true });
    throw new AppError("api-unavailable", `DeepSeek Web 请求被拒绝（业务码 ${String(code)}）`, { retryable: true });
  }
  return biz as Record<string, unknown>;
}
