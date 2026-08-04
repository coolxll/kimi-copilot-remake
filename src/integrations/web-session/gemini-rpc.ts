import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { WebSessionFilePayload } from "./messages";
import {
  redactUrl,
  sanitizeDiagnosticError,
  summarizeGeminiStructure,
  type GeminiDiagnosticSink,
} from "./gemini-diagnostics";

/** Short-lived request parameters exposed by the signed-in Gemini Web page. */
export interface GeminiWebContext {
  atValue: string;
  blValue: string;
  fSid: string;
  locale: string;
  authUser: string;
  /** File-push namespace exposed by the current Gemini page. */
  pushId?: string;
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

export interface GeminiWebFileReference {
  uploadUrl: string;
  name: string;
}

// Current Gemini Web catalog default, verified against the live reverse contract.
export const GEMINI_WEB_MODEL_HASH = "fbb127bbb056c959";
export const GEMINI_WEB_PAYLOAD_VARIANT = "minimal-v1";
const GEMINI_WEB_CAPABILITIES = [4, 5, 6, 8];
const GEMINI_WEB_MODEL_MODE = 1;

export function extractGeminiWebContext(html: string, requestedUser = "0", pageUrl?: string): GeminiWebContext {
  // Gemini-Nexus and gemini-webapi use SNlM0e as the StreamGenerate `at`
  // token. Keep thykhd as a fallback for builds that expose only that key.
  const atValue = extractFromHtml("SNlM0e", html) || extractFromHtml("thykhd", html);
  const blValue = extractFromHtml("cfb2h", html);
  const fSid = extractFromHtml("FdrFJe", html);
  const pushId = extractFromHtml("qKIAYe", html);
  if (!atValue || !blValue || !fSid) {
    throw new AppError("api-contract", "Gemini Web 请求参数缺失，页面协议可能已变化", { retryable: true });
  }
  const locale = html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] || "en-US";
  const accountPrefix = extractGeminiAccountPrefix(pageUrl);
  const authUser = accountPrefix?.match(/^\/u\/(\d+)$/)?.[1]
    || html.match(/data-index="(\d+)"/)?.[1]
    || requestedUser
    || "0";
  return { atValue, blValue, fSid, locale, authUser, ...(pushId ? { pushId } : {}), ...(accountPrefix ? { accountPrefix } : {}) };
}

export function buildGeminiWebRequest(
  prompt: string,
  context: GeminiWebContext,
  fileReference?: GeminiWebFileReference,
  modelHash = GEMINI_WEB_MODEL_HASH,
): { url: string; init: RequestInit } {
  const requestId = generateRequestId();
  const requestPayload = buildGeminiRequestPayload(prompt, fileReference, context.locale, requestId);
  const fReq = JSON.stringify([null, JSON.stringify(requestPayload)]);

  const modelHeader: unknown[] = [];
  modelHeader[0] = 1;
  modelHeader[4] = modelHash;
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

function buildGeminiRequestPayload(
  prompt: string,
  fileReference: GeminiWebFileReference | undefined,
  _locale: string,
  _requestId: string,
): unknown[] {
  // The current Web client uses the compact Python-compatible envelope. The
  // older 69-slot envelope is accepted by some historical servers but causes
  // protocol errors on the current Gemini Web route.
  const messageContent = fileReference
    ? [prompt, 0, null, [[[fileReference.uploadUrl], fileReference.name]]]
    : [prompt];
  return [messageContent, null, ["", "", ""]];
}

export interface GeminiWebRpcOptions {
  diagnostic?: GeminiDiagnosticSink;
  contextSource?: "auto" | "page" | "background";
}

export async function completeGeminiWebRpc(
  prompt: string,
  signal: AbortSignal,
  authUser = "0",
  options?: GeminiWebRpcOptions,
): Promise<string> {
  let latest = "";
  await streamGeminiWebRpc(prompt, signal, ({ text }) => { latest = text; }, authUser, undefined, options);
  return latest.trim();
}

export async function streamGeminiWebRpc(
  prompt: string,
  signal: AbortSignal,
  onUpdate: (update: GeminiParsedLine) => void,
  authUser = "0",
  file?: WebSessionFilePayload,
  options: GeminiWebRpcOptions = {},
): Promise<{ conversationId?: string; protocolCodes?: number[] }> {
  const context = options.contextSource === "background"
    ? await fetchGeminiWebContext(signal, authUser, options.diagnostic)
    : await getOrFetchGeminiContext(signal, authUser, options.contextSource || "auto", options.diagnostic);
  const fileReference = file ? await uploadGeminiWebFile(file, context, signal) : undefined;
  options.diagnostic?.emit("request-build", "start", "正在构造 Gemini StreamGenerate 请求", {
    modelHash: GEMINI_WEB_MODEL_HASH,
    payloadVariant: GEMINI_WEB_PAYLOAD_VARIANT,
    authUser: context.authUser,
    locale: context.locale,
    hasFile: Boolean(fileReference),
  }, 1);
  const request = buildGeminiWebRequest(prompt, context, fileReference, GEMINI_WEB_MODEL_HASH);
  options.diagnostic?.emit("request-build", "success", "请求构造完成", {
    modelHash: GEMINI_WEB_MODEL_HASH,
    payloadVariant: GEMINI_WEB_PAYLOAD_VARIANT,
  }, 1);
  let response: Response;
  options.diagnostic?.emit("request-send", "start", "正在发送 StreamGenerate", { target: "gemini.google.com/StreamGenerate" }, 1);
  try {
    response = await fetch(request.url, { ...request.init, signal });
  } catch (error) {
    options.diagnostic?.emit("request-send", "error", "StreamGenerate 网络请求失败", sanitizeDiagnosticError(error), 1);
    throw new AppError("api-unavailable", "Gemini StreamGenerate 网络请求失败", { cause: error, retryable: true });
  }
  options.diagnostic?.emit("request-send", response.ok ? "success" : "error", `StreamGenerate 返回 HTTP ${response.status}`, {
    status: response.status,
    redirected: response.redirected,
    finalUrl: redactUrl(response.url || request.url),
  }, 1);
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "Gemini Web 登录态已失效，请重新登录", { retryable: true });
  }
  if (!response.ok) {
    throw new AppError("api-unavailable", `Gemini Web 请求失败（HTTP ${response.status}）`, { retryable: true });
  }
  const result = await readGeminiWebResponseWithUpdates(response, signal, onUpdate, options.diagnostic, 1);
  return {
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(result.protocolCodes.length ? { protocolCodes: result.protocolCodes } : {}),
  };
}

async function uploadGeminiWebFile(
  file: WebSessionFilePayload,
  context: GeminiWebContext,
  signal: AbortSignal,
): Promise<GeminiWebFileReference> {
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.data)], { type: file.type || "application/octet-stream" }), file.name);
    const response = await fetch("https://content-push.googleapis.com/upload", {
      method: "POST",
      credentials: "include",
      headers: {
        Origin: "https://gemini.google.com",
        Referer: "https://gemini.google.com/",
        "X-Tenant-Id": "bard-storage",
        "Push-ID": context.pushId || "feeds/mcudyrk2a4khkz",
      },
      body: form,
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new AppError("auth-required", "Gemini Web 文件上传需要有效登录态，请重新登录", { retryable: true });
    }
    if (!response.ok) throw new AppError("upload-failed", `Gemini 文件上传失败（HTTP ${response.status}）`, { retryable: true });
    const raw = (await response.text()).trim();
    const uploadUrl = parseGeminiUploadResponse(raw);
    if (!uploadUrl) throw new AppError("upload-failed", "Gemini 没有返回文件引用", { retryable: true });
    return { uploadUrl, name: file.name };
  } catch (error) {
    if (error instanceof AppError && (error.code === "auth-required" || error.code === "rate-limit" || error.code === "cancelled" || error.code === "upload-failed")) {
      throw error;
    }
    throw new AppError("upload-failed", `Gemini 文件上传失败：${error instanceof Error ? error.message : "未知错误"}`, { cause: error, retryable: true });
  }
}

function parseGeminiUploadResponse(raw: string): string {
  if (!raw) return "";
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["url", "upload_url", "path", "file_url"]) {
        if (typeof record[key] === "string" && record[key]) return record[key];
      }
    }
  } catch {
    // The current endpoint returns a plain text file reference.
  }
  return raw;
}

export type GeminiContextSource = "auto" | "page" | "background";

/**
 * Read the short-lived request parameters from an already open Gemini tab.
 * This is deliberately kept separate from the background fetch so the
 * options page can compare the two paths when a request is accepted by the
 * page but its response cannot be read from the extension context.
 */
export async function fetchGeminiPageContext(
  requestedUser = "0",
  diagnostic?: GeminiDiagnosticSink,
): Promise<GeminiWebContext> {
  diagnostic?.emit("context-tab-query", "start", "正在查找已打开的 Gemini 页面");
  try {
    const tabs = await browser.tabs.query({ url: "https://gemini.google.com/*" });
    diagnostic?.emit("context-tab-query", "success", `找到 ${Array.isArray(tabs) ? tabs.length : 0} 个 Gemini 页面`, {
      count: Array.isArray(tabs) ? tabs.length : 0,
    });
    if (Array.isArray(tabs) && tabs.length > 0) {
      const activeTab = tabs.find((tab) => tab.active) || tabs[0];
      if (typeof activeTab?.id === "number") {
        diagnostic?.emit("context-page-extract", "start", "正在从 Gemini 页面读取请求参数", {
          tabIdAvailable: true,
        });
        const result = await browser.scripting.executeScript({
          target: { tabId: activeTab.id },
          world: "MAIN",
          func: extractGeminiPageContextInTab,
          args: [requestedUser],
        });
        const tabContext = result[0]?.result as GeminiWebContext | null;
        if (tabContext && tabContext.atValue && tabContext.blValue && tabContext.fSid) {
          diagnostic?.emit("context-page-extract", "success", "已从 Gemini 页面读取到请求参数", {
            authUser: tabContext.authUser,
            locale: tabContext.locale,
            hasPushId: Boolean(tabContext.pushId),
          });
          return tabContext;
        }
        throw new AppError("api-contract", "Gemini 页面未提供完整请求参数", { retryable: true });
      }
      throw new AppError("unsupported-page", "未找到可执行脚本的 Gemini 页面", { retryable: true });
    }
    throw new AppError("unsupported-page", "未找到已打开的 Gemini 页面", { retryable: true });
  } catch (error) {
    diagnostic?.emit("context-page-extract", "error", "无法从 Gemini 页面读取请求参数", sanitizeDiagnosticError(error));
    throw error;
  }
}

export async function getOrFetchGeminiContext(
  signal: AbortSignal,
  requestedUser = "0",
  source: GeminiContextSource = "auto",
  diagnostic?: GeminiDiagnosticSink,
): Promise<GeminiWebContext> {
  if (source !== "background") {
    try {
      return await fetchGeminiPageContext(requestedUser, diagnostic);
    } catch (error) {
      if (source === "page") throw error;
      diagnostic?.emit("context-page-extract", "warning", "页面参数读取失败，将尝试后台页面请求", sanitizeDiagnosticError(error));
    }
  }
  return fetchGeminiWebContext(signal, requestedUser, diagnostic);
}

function extractGeminiPageContextInTab(requestedUser: string): GeminiWebContext | null {
  try {
    if (location.origin !== "https://gemini.google.com" || location.pathname.includes("ServiceLogin")) {
      return null;
    }
    const wizData = (window as unknown as { WIZ_global_data?: Record<string, string> }).WIZ_global_data;
    const outerHtml = document.documentElement?.outerHTML || "";
    const extractToken = (key: string): string | undefined => {
      if (wizData && typeof wizData[key] === "string" && wizData[key].trim()) {
        return wizData[key].trim();
      }
      return new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(outerHtml)?.[1]
        || new RegExp(`'${key}'\\s*:\\s*'([^']+)'`).exec(outerHtml)?.[1]
        || new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`).exec(outerHtml)?.[1]
        || new RegExp(`\\[\\s*["']${key}["']\\s*,\\s*["']([^"']+)["']\\s*\\]`).exec(outerHtml)?.[1];
    };
    const atValue = extractToken("SNlM0e") || extractToken("thykhd");
    const blValue = extractToken("cfb2h");
    const fSid = extractToken("FdrFJe");
    const pushId = extractToken("qKIAYe");
    if (!atValue || !blValue || !fSid) return null;

    const locale = document.documentElement?.lang || "en-US";
    const currentAccount = /\/u\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1]
      || new URL(location.href).searchParams.get("authuser")
      || /data-index="(\d+)"/.exec(outerHtml)?.[1]
      || requestedUser
      || "0";
    const accountPrefix = currentAccount !== "0" ? `/u/${currentAccount}` : "";

    return {
      atValue,
      blValue,
      fSid,
      locale,
      authUser: currentAccount,
      ...(pushId ? { pushId } : {}),
      ...(accountPrefix ? { accountPrefix } : {}),
    };
  } catch {
    return null;
  }
}

interface GeminiPageDiagnosticExecutionResult {
  status: number;
  redirected: boolean;
  finalPath: string;
  hasAtValue: boolean;
  hasBlValue: boolean;
  hasFSid: boolean;
  authUser: string;
  locale: string;
  requestStarted: boolean;
  bytes: number;
  chunks: number;
  lines: number;
  parsedCandidates: number;
  protocolCodes: number[];
  textLength: number;
  hasExpectedText: boolean;
  conversationId?: string;
  errorName?: string;
}

/**
 * Execute the actual StreamGenerate request in the Gemini page's MAIN world.
 * A page-origin fetch is useful as a control because it carries the same
 * cookies and origin as the composer, avoiding extension-page CORS rules.
 * Only response shape/length metadata is returned to the extension.
 */
async function executeGeminiPageDiagnosticInTab(
  prompt: string,
  requestedUser: string,
  modelHash: string,
): Promise<GeminiPageDiagnosticExecutionResult> {
  const emptyResult = (overrides: Partial<GeminiPageDiagnosticExecutionResult> = {}): GeminiPageDiagnosticExecutionResult => ({
    status: 0,
    redirected: false,
    finalPath: location.pathname,
    hasAtValue: false,
    hasBlValue: false,
    hasFSid: false,
    authUser: requestedUser || "0",
    locale: document.documentElement?.lang || "en-US",
    requestStarted: false,
    bytes: 0,
    chunks: 0,
    lines: 0,
    parsedCandidates: 0,
    protocolCodes: [],
    textLength: 0,
    hasExpectedText: false,
    ...overrides,
  });
  try {
    if (location.origin !== "https://gemini.google.com") return emptyResult({ errorName: "unsupported-origin" });
    const wizData = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data;
    const outerHtml = document.documentElement?.outerHTML || "";
    const extractToken = (key: string): string | undefined => {
      const direct = wizData?.[key];
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(`"${escapedKey}"\\s*:\\s*"([^"\\\\]+)"`),
        new RegExp(`'${escapedKey}'\\s*:\\s*'([^'\\\\]+)'`),
        new RegExp(`\\[\\s*["']${escapedKey}["']\\s*,\\s*["']([^"']+)["']`),
      ];
      for (const pattern of patterns) {
        const value = pattern.exec(outerHtml)?.[1];
        if (value) return value.trim();
      }
      return undefined;
    };
    const atValue = extractToken("SNlM0e") || extractToken("thykhd");
    const blValue = extractToken("cfb2h");
    const fSid = extractToken("FdrFJe");
    const currentAccount = /\/u\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1]
      || new URL(location.href).searchParams.get("authuser")
      || /data-index=["'](\d+)["']/.exec(outerHtml)?.[1]
      || requestedUser
      || "0";
    const locale = document.documentElement?.lang || "en-US";
    const baseResult = emptyResult({
      hasAtValue: Boolean(atValue),
      hasBlValue: Boolean(blValue),
      hasFSid: Boolean(fSid),
      authUser: currentAccount,
      locale,
    });
    if (!atValue || !blValue || !fSid) return { ...baseResult, errorName: "missing-context" };

    const requestId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID().toUpperCase()
      : `page-${Date.now()}-${Math.random().toString(36).slice(2)}`.toUpperCase();
    const modelHeader: unknown[] = [];
    modelHeader[0] = 1;
    modelHeader[4] = modelHash;
    modelHeader[7] = 0;
    modelHeader[8] = [4, 5, 6, 8];
    modelHeader[11] = 1;
    modelHeader[14] = 1;
    modelHeader[15] = 1;
    modelHeader[16] = requestId;
    const accountPrefix = currentAccount && currentAccount !== "0" ? `/u/${currentAccount}` : "";
    const query = new URLSearchParams({
      bl: blValue,
      "f.sid": fSid,
      hl: locale,
      _reqid: String(Math.floor(Math.random() * 900_000) + 100_000),
      rt: "c",
    });
    const payload = [[prompt], null, ["", "", ""]];
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Same-Domain": "1",
      "x-goog-ext-525001261-jspb": JSON.stringify(modelHeader),
      "x-goog-ext-525005358-jspb": JSON.stringify([requestId, 1]),
      "x-goog-ext-73010989-jspb": "[0]",
      "x-goog-ext-73010990-jspb": "[0,0,0]",
      Origin: "https://gemini.google.com",
      Referer: `https://gemini.google.com${accountPrefix}/app`,
    };
    if (currentAccount && currentAccount !== "0") headers["X-Goog-AuthUser"] = currentAccount;

    let response: Response;
    try {
      response = await fetch(`https://gemini.google.com${accountPrefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${query.toString()}`, {
        method: "POST",
        headers,
        credentials: "include",
        body: new URLSearchParams({ at: atValue, "f.req": JSON.stringify([null, JSON.stringify(payload)]) }),
      });
    } catch (error) {
      return { ...baseResult, requestStarted: true, errorName: error instanceof Error ? error.name : "fetch-error" };
    }
    const result: GeminiPageDiagnosticExecutionResult = {
      ...baseResult,
      status: response.status,
      redirected: response.redirected,
      finalPath: (() => { try { return new URL(response.url).pathname; } catch { return location.pathname; } })(),
      requestStarted: true,
    };
    if (!response.body) return { ...result, errorName: "empty-body" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let latestText = "";
    let conversationId: string | undefined;
    const protocolCodes: number[] = [];
    let bytes = 0;
    let chunks = 0;
    let lines = 0;
    let parsedCandidates = 0;
    const mergeText = (previous: string, next: string): string => {
      if (!previous) return next;
      if (next.startsWith(previous)) return next;
      if (previous.endsWith(next)) return previous;
      return previous + next;
    };
    const parseLine = (line: string): void => {
      lines += 1;
      try {
        const cleanLine = line.replace(/^\)\]\}'/, "").trim();
        if (!cleanLine) return;
        const root = JSON.parse(cleanLine) as unknown;
        if (!Array.isArray(root)) return;
        for (const event of root) {
          if (Array.isArray(event) && event[0] === "e") {
            const code = event[4] ?? event[event.length - 1];
            if (typeof code === "number") protocolCodes.push(code);
          }
          if (!Array.isArray(event) || typeof event[2] !== "string") continue;
          const payloadValue = JSON.parse(event[2]) as unknown;
          if (!Array.isArray(payloadValue) || !Array.isArray(payloadValue[4])) continue;
          const candidate = (payloadValue[4] as unknown[]).find((entry): entry is unknown[] => Array.isArray(entry) && typeof entry[1] !== "undefined");
          if (!candidate) continue;
          const textNode = candidate[1];
          const text = Array.isArray(textNode)
            ? textNode.filter((part): part is string => typeof part === "string").join("")
            : typeof textNode === "string" ? textNode : "";
          const ids = Array.isArray(payloadValue[1]) ? payloadValue[1] : [];
          conversationId = typeof ids[0] === "string" ? ids[0] : conversationId;
          if (!text) continue;
          parsedCandidates += 1;
          latestText = mergeText(latestText, text);
        }
      } catch {
        // Metadata lines are intentionally ignored by the page control.
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      bytes += value?.byteLength || 0;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        parseLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseLine(buffer);
    return {
      ...result,
      bytes,
      chunks,
      lines,
      parsedCandidates,
      protocolCodes,
      textLength: latestText.length,
      hasExpectedText: latestText.includes("PROJECT_OK"),
      ...(conversationId ? { conversationId } : {}),
    };
  } catch (error) {
    return emptyResult({ errorName: error instanceof Error ? error.name : "page-diagnostic-error" });
  }
}

export async function runGeminiPageDiagnostic(
  prompt: string,
  requestedUser: string,
  signal: AbortSignal,
  diagnostic?: GeminiDiagnosticSink,
): Promise<{ text: string; externalUrl?: string }> {
  diagnostic?.emit("context-tab-query", "start", "正在查找用于同源对照的 Gemini 页面");
  let tabs: Array<{ id?: number; active?: boolean }>;
  try {
    tabs = await browser.tabs.query({ url: "https://gemini.google.com/*" }) as Array<{ id?: number; active?: boolean }>;
  } catch (error) {
    diagnostic?.emit("context-tab-query", "error", "无法查询 Gemini 页面", sanitizeDiagnosticError(error));
    throw new AppError("api-unavailable", "无法查询已打开的 Gemini 页面", { cause: error, retryable: true });
  }
  diagnostic?.emit("context-tab-query", "success", `找到 ${tabs.length} 个 Gemini 页面`, { count: tabs.length });
  const activeTab = tabs.find((tab) => tab.active) || tabs[0];
  if (typeof activeTab?.id !== "number") {
    throw new AppError("unsupported-page", "未找到可执行脚本的 Gemini 页面，请先在浏览器中打开 Gemini", { retryable: true });
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  diagnostic?.emit("context-page-extract", "start", "正在 Gemini 页面内发起同源请求", { tabIdAvailable: true });
  let result: GeminiPageDiagnosticExecutionResult | undefined;
  try {
    const scriptResult = await browser.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: "MAIN",
      func: executeGeminiPageDiagnosticInTab,
      args: [prompt, requestedUser, GEMINI_WEB_MODEL_HASH],
    });
    result = scriptResult[0]?.result as GeminiPageDiagnosticExecutionResult | undefined;
  } catch (error) {
    diagnostic?.emit("context-page-extract", "error", "Gemini 页面脚本执行失败", sanitizeDiagnosticError(error));
    throw new AppError("api-unavailable", "无法在 Gemini 页面中执行同源测试", { cause: error, retryable: true });
  }
  if (!result) throw new AppError("api-contract", "Gemini 页面没有返回同源测试结果", { retryable: true });
  diagnostic?.emit("context-page-extract", result.hasAtValue && result.hasBlValue && result.hasFSid ? "success" : "warning", "Gemini 页面参数检查完成", {
    hasAtValue: result.hasAtValue,
    hasBlValue: result.hasBlValue,
    hasFSid: result.hasFSid,
    authUser: result.authUser,
    locale: result.locale,
  });
  const pageContextAvailable = result.hasAtValue && result.hasBlValue && result.hasFSid;
  diagnostic?.emit("request-build", pageContextAvailable ? "success" : "error", pageContextAvailable ? "页面同源请求构造完成" : "页面同源请求未构造（缺少页面参数）", {
    modelHash: GEMINI_WEB_MODEL_HASH,
    payloadVariant: GEMINI_WEB_PAYLOAD_VARIANT,
  });
  diagnostic?.emit("request-send", result.errorName ? "error" : result.status >= 200 && result.status < 300 ? "success" : "error", result.errorName ? "页面同源请求失败" : `页面同源请求返回 HTTP ${result.status}`, {
    status: result.status,
    redirected: result.redirected,
    finalPath: result.finalPath,
    errorName: result.errorName,
  });
  diagnostic?.emit("response-headers", result.errorName ? "error" : "success", result.errorName ? "页面同源响应头不可用" : "已收到页面同源响应头", {
    status: result.status,
    redirected: result.redirected,
    finalPath: result.finalPath,
  });
  diagnostic?.emit("response-stream", result.errorName ? "error" : "success", "页面同源响应读取完成", {
    bytes: result.bytes,
    chunks: result.chunks,
    lines: result.lines,
    parsedCandidates: result.parsedCandidates,
  });
  diagnostic?.emit("response-parse", result.hasExpectedText ? "success" : "error", result.hasExpectedText ? "页面同源响应包含 PROJECT_OK" : "页面同源响应未包含 PROJECT_OK", {
    textLength: result.textLength,
    protocolCodes: result.protocolCodes,
  });
  if (result.errorName) {
    throw new AppError("api-unavailable", `Gemini 页面同源请求失败（${result.errorName}）`, { retryable: true });
  }
  if (result.status === 401 || result.status === 403) {
    throw new AppError("auth-required", "Gemini 页面同源请求需要有效登录态，请重新登录", { retryable: true });
  }
  if (!result.hasExpectedText) {
    const codeSuffix = result.protocolCodes.length ? `（协议码 ${result.protocolCodes[0]}）` : "";
    throw new AppError("api-contract", `Gemini 页面同源响应未返回 PROJECT_OK${codeSuffix}`, { retryable: true });
  }
  const conversationId = result.conversationId;
  return {
    text: "PROJECT_OK",
    ...(conversationId ? { externalUrl: `https://gemini.google.com/app/${encodeURIComponent(stripGeminiConversationPrefix(conversationId))}` } : {}),
  };
}

export async function fetchGeminiWebContext(
  signal: AbortSignal,
  requestedUser = "0",
  diagnostic?: GeminiDiagnosticSink,
): Promise<GeminiWebContext> {
  const accountPrefix = requestedUser && requestedUser !== "0" ? `/u/${requestedUser}` : "";
  let response: Response;
  diagnostic?.emit("context-background-fetch", "start", "正在从后台读取 Gemini 页面参数", {
    accountPath: accountPrefix || "/app",
  });
  try {
    response = await fetch(`https://gemini.google.com${accountPrefix}/app`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html" },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    diagnostic?.emit("context-background-fetch", "error", "后台读取 Gemini 页面失败", sanitizeDiagnosticError(error));
    throw new AppError(
      "api-unavailable",
      "无法建立 Gemini 后端连接。请先在浏览器中打开 https://gemini.google.com 页面",
      { cause: error, retryable: true },
    );
  }
  diagnostic?.emit("context-background-fetch", response.ok ? "success" : "error", `Gemini 页面返回 HTTP ${response.status}`, {
    status: response.status,
    redirected: response.redirected,
    finalUrl: redactUrl(response.url || `https://gemini.google.com${accountPrefix}/app`),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  if (!response.ok) {
    throw new AppError("api-unavailable", `无法读取 Gemini Web 页面（HTTP ${response.status}）`, { retryable: true });
  }
  const html = await response.text();
  if (response.url?.includes("google.com/sorry")) {
    diagnostic?.emit("context-background-fetch", "error", "Google 返回了人机验证页面", {
      finalUrl: redactUrl(response.url),
    });
    throw new AppError(
      "security-check-required",
      "Google 触发了人机验证，请在浏览器中打开 https://gemini.google.com 完成验证",
      { retryable: true },
    );
  }
  if (new URL(response.url || `https://gemini.google.com${accountPrefix}/app`).origin !== "https://gemini.google.com") {
    diagnostic?.emit("context-background-fetch", "error", "Gemini 页面请求被重定向到非 Gemini 域名", {
      finalUrl: redactUrl(response.url || ""),
    });
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  if (looksLikeGeminiLoginPage(html) && !hasGeminiWebContext(html)) {
    diagnostic?.emit("context-background-fetch", "error", "Gemini 页面返回登录页且没有请求参数");
    throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
  }
  let context: GeminiWebContext;
  try {
    context = extractGeminiWebContext(html, requestedUser, response.url);
  } catch (error) {
    diagnostic?.emit("context-background-fetch", "error", "Gemini 页面缺少可用请求参数", sanitizeDiagnosticError(error));
    throw error;
  }
  if (requestedUser !== "0" && context.authUser !== requestedUser) {
    diagnostic?.emit("context-background-fetch", "error", "Gemini 页面账号与保存的账号不一致", {
      requestedUser,
      resolvedUser: context.authUser,
    });
    throw new AppError("auth-required", `Gemini Web 当前页面是账号 ${context.authUser}，已保存账号 ${requestedUser}，请重新登录绑定`, { retryable: true });
  }
  diagnostic?.emit("context-background-fetch", "success", "后台 Gemini 请求参数解析完成", {
    authUser: context.authUser,
    locale: context.locale,
    hasPushId: Boolean(context.pushId),
  });
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
  diagnostic?: GeminiDiagnosticSink,
  attempt?: number,
): Promise<{ conversationId?: string; protocolCodes: number[] }> {
  if (!response.body) {
    diagnostic?.emit("response-stream", "error", "Gemini Web 返回了空响应流", {
      status: response.status,
    }, attempt);
    throw new AppError("api-contract", "Gemini Web 返回了空响应流", { retryable: true });
  }
  diagnostic?.emit("response-headers", "success", `已收到 Gemini HTTP ${response.status} 响应`, {
    status: response.status,
    contentType: response.headers?.get?.("content-type") || "",
    redirected: response.redirected,
  }, attempt);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let latestText = "";
  let conversationId: string | undefined;
  let firstChunk = true;
  let bytes = 0;
  let chunks = 0;
  let lines = 0;
  let parsedCandidates = 0;
  const protocolCodes: number[] = [];
  let structureSamples = 0;

  const processLine = (line: string): void => {
    lines += 1;
    const protocolError = parseGeminiProtocolErrorCode(line);
    if (protocolError !== undefined) {
      protocolCodes.push(protocolError);
      diagnostic?.emit("response-parse", "warning", `收到 Gemini 协议事件（协议码 ${protocolError}）`, {
        protocolCode: protocolError,
        structure: summarizeGeminiLine(line),
      }, attempt);
    }
    const parsed = parseGeminiLine(line);
    if (parsed) {
      parsedCandidates += 1;
      if (parsed.text) {
        latestText = mergeGeminiText(latestText, parsed.text);
        onUpdate({ ...parsed, text: latestText });
      }
      conversationId = parsed.conversationId || conversationId;
    } else if (structureSamples < 3 && line.trim() && protocolError === undefined) {
      structureSamples += 1;
      diagnostic?.emit("response-parse", "warning", "收到未识别的 Gemini 响应事件", {
        structure: summarizeGeminiLine(line),
      }, attempt);
    }
  };

  try {
    diagnostic?.emit("response-stream", "start", "正在读取 Gemini 响应流", undefined, attempt);
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      bytes += value?.byteLength || 0;
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
        processLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } catch (error) {
    diagnostic?.emit("response-stream", "error", "读取 Gemini 响应流时发生异常", sanitizeDiagnosticError(error), attempt);
    throw error;
  } finally {
    reader.releaseLock();
  }

  diagnostic?.emit("response-stream", latestText.trim() ? "success" : "error", "Gemini 响应流读取完成", {
    bytes,
    chunks,
    lines,
    parsedCandidates,
    protocolCodes,
  }, attempt);

  if (!latestText.trim()) {
    if (looksLikeGeminiLoginPage(buffer)) {
      throw new AppError("auth-required", "Gemini Web 当前未登录，请先登录 Gemini", { retryable: true });
    }
    const protocolSuffix = protocolCodes.length > 0 ? `（协议码 ${protocolCodes[0]}）` : "";
    const error = new AppError("api-contract", `Gemini Web 响应为空或格式暂不支持${protocolSuffix}`, {
      retryable: true,
      ...(conversationId ? { externalUrl: geminiConversationUrl(conversationId) } : {}),
    });
    diagnostic?.emit("response-parse", "error", error.message, {
      bytes,
      chunks,
      lines,
      parsedCandidates,
      protocolCodes,
    }, attempt);
    throw error;
  }
  diagnostic?.emit("response-parse", protocolCodes.length > 0 ? "warning" : "success", "Gemini 响应已解析出文本", {
    bytes,
    chunks,
    lines,
    parsedCandidates,
    protocolCodes,
  }, attempt);
  return { conversationId, protocolCodes };
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
      if (text || thoughts || conversationId || responseId || choiceId) {
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

export function extractFromHtml(variableName: string, html: string): string | undefined {
  if (!html) return undefined;
  const decodeJsString = (value: string): string => {
    let decoded = "";
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== "\\" || index === value.length - 1) {
        decoded += value[index];
        continue;
      }
      const escaped = value[++index];
      if (escaped === "u") {
        const unicode = value.slice(index + 1, index + 5);
        if (/^[0-9a-f]{4}$/i.test(unicode)) {
          decoded += String.fromCharCode(Number.parseInt(unicode, 16));
          index += 4;
          continue;
        }
      }
      if (escaped === "x") {
        const hex = value.slice(index + 1, index + 3);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          decoded += String.fromCharCode(Number.parseInt(hex, 16));
          index += 2;
          continue;
        }
      }
      const escapedCharacters: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
      decoded += escapedCharacters[escaped] ?? escaped;
    }
    return decoded;
  };
  const keyPattern = "(?:[\"']" + variableName + "[\"']|\\b" + variableName + "\\b)";
  const sourceVariants = [html, html.replace(/\\(["'])/g, "$1")];
  const patterns = [
    new RegExp(keyPattern + "\\s*(?::|=)\\s*\"((?:\\\\.|[^\"\\\\])*)\""),
    new RegExp(keyPattern + "\\s*(?::|=)\\s*'((?:\\\\.|[^'\\\\])*)'"),
    new RegExp("\\[\\s*[\"']" + variableName + "[\"']\\s*,\\s*\"((?:\\\\.|[^\"\\\\])*)\""),
    new RegExp("\\[\\s*[\"']" + variableName + "[\"']\\s*,\\s*'((?:\\\\.|[^'\\\\])*)'"),
  ];
  for (const variant of sourceVariants) {
    for (const pattern of patterns) {
      const raw = pattern.exec(variant)?.[1];
      const value = raw ? decodeJsString(raw).trim() : "";
      if (value) return value;
    }
  }
  return undefined;
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

function summarizeGeminiLine(line: string): unknown {
  try {
    const cleanLine = line.replace(/^\)\]\}'/, "").trim();
    return summarizeGeminiStructure(JSON.parse(cleanLine));
  } catch {
    return { type: "text", length: line.length };
  }
}

function mergeGeminiText(previous: string, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return `${previous}${next}`;
}

function stripGeminiConversationPrefix(value: string): string {
  return value.replace(/^c_/, "");
}

function geminiConversationUrl(value: string): string {
  return `https://gemini.google.com/app/${encodeURIComponent(stripGeminiConversationPrefix(value))}`;
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
