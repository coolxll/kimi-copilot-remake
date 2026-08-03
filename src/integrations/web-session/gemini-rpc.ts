import { AppError } from "../../domain/errors";

/** Short-lived request parameters exposed by the signed-in Gemini Web page. */
export interface GeminiWebContext {
  atValue: string;
  blValue: string;
  fSid: string;
  locale: string;
  authUser: string;
  /** The account path resolved by the /app redirect, when present. */
  accountPrefix?: string;
}

export interface GeminiParsedLine {
  text: string;
  thoughts: string | null;
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
}

// Current Gemini-Nexus Web catalog default (3.5 Flash). The previous hash
// fbb127bbb056c959 is retained only in historical fixtures/documentation.
export const GEMINI_WEB_MODEL_HASH = "56fdd199312815e2";
const GEMINI_WEB_CAPABILITIES = [4, 5, 6, 8];
const GEMINI_WEB_MODEL_MODE = 1;

export function extractGeminiWebContext(html: string, requestedUser = "0", pageUrl?: string): GeminiWebContext {
  // Gemini-Nexus and gemini-webapi use SNlM0e as the StreamGenerate `at`
  // token. Keep thykhd as a fallback for builds that expose only that key.
  const atValue = extractFromHtml("SNlM0e", html) || extractFromHtml("thykhd", html);
  const blValue = extractFromHtml("cfb2h", html);
  const fSid = extractFromHtml("FdrFJe", html);
  if (!atValue || !blValue || !fSid) {
    throw new AppError("api-contract", "Gemini Web 请求参数缺失，页面协议可能已变化", { retryable: true });
  }
  const locale = html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] || "en-US";
  const accountPrefix = extractGeminiAccountPrefix(pageUrl);
  const authUser = accountPrefix?.match(/^\/u\/(\d+)$/)?.[1]
    || html.match(/data-index="(\d+)"/)?.[1]
    || requestedUser
    || "0";
  return { atValue, blValue, fSid, locale, authUser, ...(accountPrefix ? { accountPrefix } : {}) };
}

export function buildGeminiWebRequest(prompt: string, context: GeminiWebContext): { url: string; init: RequestInit } {
  const requestId = generateRequestId();
  const requestPayload: unknown[] = [[prompt], null, ["", "", ""]];
  const fReq = JSON.stringify([null, JSON.stringify(requestPayload)]);

  const modelHeader: unknown[] = [];
  modelHeader[0] = 1;
  modelHeader[4] = GEMINI_WEB_MODEL_HASH;
  modelHeader[7] = 0;
  modelHeader[8] = GEMINI_WEB_CAPABILITIES;
  modelHeader[11] = GEMINI_WEB_MODEL_MODE;
  modelHeader[14] = GEMINI_WEB_MODEL_MODE;
  modelHeader[15] = 1;
  modelHeader[16] = requestId;
  const query = new URLSearchParams({
    bl: context.blValue,
    "f.sid": context.fSid,
    hl: context.locale || "en-US",
    _reqid: String(Math.floor(Math.random() * 900_000) + 100_000),
    rt: "c",
  });
  const accountPrefix = context.authUser && context.authUser !== "0" ? `/u/${context.authUser}` : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "X-Same-Domain": "1",
    "x-goog-ext-525001261-jspb": JSON.stringify(modelHeader),
    "x-goog-ext-525005358-jspb": JSON.stringify([requestId, 1]),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0,0,0]",
    Origin: "https://gemini.google.com",
    Referer: `https://gemini.google.com${accountPrefix}/app`,
    Accept: "*/*",
    "Accept-Language": context.locale || "en-US",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (context.authUser && context.authUser !== "0") headers["X-Goog-AuthUser"] = context.authUser;

  return {
    url: `https://gemini.google.com${accountPrefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${query.toString()}`,
    init: {
      method: "POST",
      headers,
      credentials: "include",
      body: new URLSearchParams({ at: context.atValue, "f.req": fReq }),
    },
  };
}

export async function completeGeminiWebRpc(prompt: string, signal: AbortSignal, authUser = "0"): Promise<string> {
  let latest = "";
  await streamGeminiWebRpc(prompt, signal, ({ text }) => { latest = text; }, authUser);
  return latest.trim();
}

export async function streamGeminiWebRpc(
  prompt: string,
  signal: AbortSignal,
  onUpdate: (update: GeminiParsedLine) => void,
  authUser = "0",
): Promise<{ conversationId?: string }> {
  let context = await fetchGeminiWebContext(signal, authUser);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = buildGeminiWebRequest(prompt, context);
    const response = await fetch(request.url, { ...request.init, signal });
    if (response.status === 401 || response.status === 403) {
      throw new AppError("auth-required", "Gemini Web 登录态已失效，请重新登录", { retryable: true });
    }
    if (!response.ok) {
      if (attempt === 0) {
        context = await fetchGeminiWebContext(signal, authUser);
        continue;
      }
      throw new AppError("api-unavailable", `Gemini Web 请求失败（HTTP ${response.status}）`, { retryable: true });
    }
    try {
      return await readGeminiWebResponseWithUpdates(response, signal, onUpdate);
    } catch (error) {
      if (attempt === 0 && shouldRefreshGeminiContext(error)) {
        context = await fetchGeminiWebContext(signal, authUser);
        continue;
      }
      throw error;
    }
  }
  throw new AppError("api-unavailable", "Gemini Web 请求重试失败", { retryable: true });
}

export async function fetchGeminiWebContext(signal: AbortSignal, requestedUser = "0"): Promise<GeminiWebContext> {
  const accountPrefix = requestedUser && requestedUser !== "0" ? `/u/${requestedUser}` : "";
  const response = await fetch(`https://gemini.google.com${accountPrefix}/app`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/html" },
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  if (!response.ok) {
    throw new AppError("api-unavailable", `无法读取 Gemini Web 页面（HTTP ${response.status}）`, { retryable: true });
  }
  const html = await response.text();
  if (new URL(response.url || `https://gemini.google.com${accountPrefix}/app`).origin !== "https://gemini.google.com") {
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  if (looksLikeGeminiLoginPage(html) && !hasGeminiWebContext(html)) {
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  const context = extractGeminiWebContext(html, requestedUser, response.url);
  if (requestedUser !== "0" && context.authUser !== requestedUser) {
    throw new AppError("auth-required", `Gemini Web 当前页面是账号 ${context.authUser}，已保存账号 ${requestedUser}，请重新登录绑定`, { retryable: true });
  }
  return context;
}

export async function readGeminiWebResponse(response: Response): Promise<string> {
  let latest = "";
  await readGeminiWebResponseWithUpdates(response, undefined, ({ text }) => { latest = text; });
  return latest.trim();
}

async function readGeminiWebResponseWithUpdates(
  response: Response,
  signal: AbortSignal | undefined,
  onUpdate: (update: GeminiParsedLine) => void,
): Promise<{ conversationId?: string }> {
  if (!response.body) throw new AppError("api-contract", "Gemini Web 返回了空响应流", { retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let latestText = "";
  let conversationId: string | undefined;
  let firstChunk = true;

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (firstChunk) {
        firstChunk = false;
        if (looksLikeGeminiLoginPage(chunk)) {
          throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
        }
      }
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const protocolError = parseGeminiProtocolErrorCode(line);
        if (protocolError !== undefined) {
          throw new AppError("api-contract", formatGeminiProtocolError(protocolError), { retryable: true });
        }
        const parsed = parseGeminiLine(line);
        if (parsed) {
          if (parsed.text) {
            latestText = mergeGeminiText(latestText, parsed.text);
            onUpdate({ ...parsed, text: latestText });
          }
          conversationId = parsed.conversationId || conversationId;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const protocolError = parseGeminiProtocolErrorCode(buffer);
    if (protocolError !== undefined) {
      throw new AppError("api-contract", formatGeminiProtocolError(protocolError), { retryable: true });
    }
    const trailing = parseGeminiLine(buffer);
    if (trailing) {
      if (trailing.text) {
        latestText = mergeGeminiText(latestText, trailing.text);
        onUpdate({ ...trailing, text: latestText });
      }
      conversationId = trailing.conversationId || conversationId;
    }
  } finally {
    reader.releaseLock();
  }

  if (!latestText.trim()) {
    if (looksLikeGeminiLoginPage(buffer)) {
      throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
    }
    throw new AppError("api-contract", "Gemini Web 响应为空或格式暂不支持", { retryable: true });
  }
  return { conversationId };
}

export function parseGeminiLine(line: string): GeminiParsedLine | null {
  try {
    const cleanLine = line.replace(/^\)\]\}'/, "").trim();
    if (!cleanLine) return null;
    const root = JSON.parse(cleanLine) as unknown;
    if (!Array.isArray(root)) return null;

    for (const envelopeEntry of root) {
      if (!Array.isArray(envelopeEntry) || typeof envelopeEntry[2] !== "string") continue;
      const payload = JSON.parse(envelopeEntry[2]) as unknown;
      if (!Array.isArray(payload) || !Array.isArray(payload[4])) continue;
      const candidate = (payload[4] as unknown[]).find((entry): entry is unknown[] => Array.isArray(entry) && typeof entry[1] !== "undefined");
      if (!candidate) continue;
      const textNode = candidate[1];
      const text = Array.isArray(textNode)
        ? textNode.filter((part): part is string => typeof part === "string").join("")
        : typeof textNode === "string" ? textNode : "";
      const thoughtNode = candidate[37];
      const thoughts = Array.isArray(thoughtNode) && Array.isArray(thoughtNode[0]) && typeof thoughtNode[0][0] === "string"
        ? thoughtNode[0][0]
        : null;
      const ids = Array.isArray(payload[1]) ? payload[1] : [];
      const conversationId = typeof ids[0] === "string" ? ids[0] : undefined;
      const responseId = typeof ids[1] === "string" ? ids[1] : undefined;
      const choiceId = typeof candidate[0] === "string" ? candidate[0] : undefined;
      if (text || thoughts) {
        return {
          text,
          thoughts,
          ...(conversationId ? { conversationId } : {}),
          ...(responseId ? { responseId } : {}),
          ...(choiceId ? { choiceId } : {}),
        };
      }
    }
  } catch {
    // Gemini occasionally emits metadata lines that are not chat payloads.
  }
  return null;
}

/** Return the protocol error code from a Gemini RPC event, if present. */
export function parseGeminiProtocolErrorCode(line: string): number | undefined {
  try {
    const cleanLine = line.replace(/^\)\]\}'/, "").trim();
    if (!cleanLine) return undefined;
    const root = JSON.parse(cleanLine) as unknown;
    if (!Array.isArray(root)) return undefined;
    for (const entry of root) {
      if (!Array.isArray(entry) || entry[0] !== "e") continue;
      const code = entry[4] ?? entry.at(-1);
      if (typeof code === "number") return code;
    }
  } catch {
    // Metadata and partial chunks are ignored by the normal parser.
  }
  return undefined;
}

function extractFromHtml(variableName: string, html: string): string | undefined {
  return new RegExp(`"${variableName}"\\s*:\\s*"([^"]+)"`).exec(html)?.[1];
}

function hasGeminiWebContext(html: string): boolean {
  return Boolean((extractFromHtml("SNlM0e", html) || extractFromHtml("thykhd", html))
    && extractFromHtml("cfb2h", html)
    && extractFromHtml("FdrFJe", html));
}

function extractGeminiAccountPrefix(pageUrl: string | undefined): string | undefined {
  if (!pageUrl) return undefined;
  try {
    const match = new URL(pageUrl).pathname.match(/(\/u\/\d+)(?:\/|$)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function formatGeminiProtocolError(code: number): string {
  if (code === 469) {
    return "Gemini Web 后端拒绝了请求（协议码 469），通常表示短期上下文、模型路由或账号权限已变化；已刷新页面参数并重试一次";
  }
  return `Gemini Web 返回协议错误（协议码 ${code}），已刷新页面参数并重试一次`;
}

function shouldRefreshGeminiContext(error: unknown): boolean {
  return error instanceof AppError && error.code === "api-contract" && error.retryable;
}

function mergeGeminiText(previous: string, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return `${previous}${next}`;
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toUpperCase();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (placeholder) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = placeholder === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  }).toUpperCase();
}

function looksLikeGeminiLoginPage(value: string): boolean {
  const lower = value.toLowerCase();
  return (lower.includes("servicelogin") || lower.includes("identifier"))
    && (lower.includes("sign in") || lower.includes("signin") || lower.includes("登录"));
}
