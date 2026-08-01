import { AppError } from "../../domain/errors";

/** Short-lived request parameters exposed by the signed-in Gemini Web page. */
export interface GeminiWebContext {
  atValue: string;
  blValue: string;
  fSid: string;
  locale: string;
  authUser: string;
}

export interface GeminiParsedLine {
  text: string;
  thoughts: string | null;
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
}

export const GEMINI_WEB_MODEL_HASH = "fbb127bbb056c959";
const GEMINI_WEB_CAPABILITIES = [4, 5, 6, 8];

export function extractGeminiWebContext(html: string, requestedUser = "0"): GeminiWebContext {
  const atValue = extractFromHtml("SNlM0e", html);
  const blValue = extractFromHtml("cfb2h", html);
  const fSid = extractFromHtml("FdrFJe", html);
  if (!atValue || !blValue || !fSid) {
    throw new AppError("api-contract", "Gemini Web 请求参数缺失，页面协议可能已变化", { retryable: true });
  }
  const locale = html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] || "en-US";
  const authUser = html.match(/data-index="(\d+)"/)?.[1] || requestedUser || "0";
  return { atValue, blValue, fSid, locale, authUser };
}

export function buildGeminiWebRequest(prompt: string, context: GeminiWebContext): { url: string; init: RequestInit } {
  const requestId = generateRequestId();
  const modelHeader: unknown[] = [];
  modelHeader[0] = 1;
  modelHeader[4] = GEMINI_WEB_MODEL_HASH;
  modelHeader[7] = 0;
  modelHeader[8] = GEMINI_WEB_CAPABILITIES;
  modelHeader[11] = 1;
  modelHeader[14] = 1;
  modelHeader[15] = 1;
  modelHeader[16] = requestId;

  const requestPayload = [[prompt], null, ["", "", ""]];
  const fReq = JSON.stringify([null, JSON.stringify(requestPayload)]);
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
    Referer: "https://gemini.google.com/",
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

export async function completeGeminiWebRpc(prompt: string, signal: AbortSignal): Promise<string> {
  let latest = "";
  await streamGeminiWebRpc(prompt, signal, ({ text }) => { latest = text; });
  return latest.trim();
}

export async function streamGeminiWebRpc(
  prompt: string,
  signal: AbortSignal,
  onUpdate: (update: GeminiParsedLine) => void,
): Promise<{ conversationId?: string }> {
  const context = await fetchGeminiWebContext(signal);
  const request = buildGeminiWebRequest(prompt, context);
  const response = await fetch(request.url, { ...request.init, signal });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "Gemini Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (!response.ok) {
    throw new AppError("api-unavailable", `Gemini Web 请求失败（HTTP ${response.status}）`, { retryable: true });
  }
  return readGeminiWebResponseWithUpdates(response, signal, onUpdate);
}

export async function fetchGeminiWebContext(signal: AbortSignal): Promise<GeminiWebContext> {
  const response = await fetch("https://gemini.google.com/app", {
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
  if (looksLikeGeminiLoginPage(html) && !hasGeminiWebContext(html)) {
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  return extractGeminiWebContext(html);
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

function extractFromHtml(variableName: string, html: string): string | undefined {
  return new RegExp(`"${variableName}":"([^"]+)"`).exec(html)?.[1];
}

function hasGeminiWebContext(html: string): boolean {
  return Boolean(extractFromHtml("SNlM0e", html) && extractFromHtml("cfb2h", html) && extractFromHtml("FdrFJe", html));
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
