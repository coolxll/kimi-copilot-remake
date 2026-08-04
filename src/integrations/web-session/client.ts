import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { WebSessionCredential, WebSessionProviderId } from "../../domain/types";
import type { SettingsRepository } from "../../platform/chrome/storage";
import { ensureChatGptCookiePermission, ensurePageHostPermission, hasPageHostPermission } from "../../platform/chrome/permissions";
import { isMissingTabError } from "../../platform/chrome/tab-errors";
import { abortableDelay, throwIfAborted, withAbort } from "../../shared/abort";
import type { GeminiDiagnosticEvent, GeminiDiagnosticMode, GeminiDiagnosticReport } from "./gemini-diagnostics";
import { WEB_SESSION_PORT_NAME, type WebSessionFilePayload, type WebSessionPortMessage } from "./messages";
import { getWebSessionSpec } from "./specs";

interface BrowserTab {
  id?: number;
  url?: string;
  status?: string;
  active?: boolean;
  lastAccessed?: number;
}

export type WebSessionLoginStatus = "logged-in" | "page-logged-in" | "logged-out" | "saved-unverified" | "no-page" | "permission-required" | "unknown";

export type WebSessionStreamEvent =
  | { type: "snapshot"; text: string }
  | { type: "done"; externalUrl?: string };

type CaptureResult =
  | { status: "ok"; credential: WebSessionCredential }
  | { status: "logged-out" }
  | { status: "failed"; message: string };

export class WebSessionClient {
  constructor(private readonly storage: SettingsRepository) {}

  async openLogin(providerId: WebSessionProviderId, timeoutMs = 120_000, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const spec = getWebSessionSpec(providerId);
    if (providerId === "chatgpt-web") await ensureChatGptCookiePermission();
    await ensurePageHostPermission(spec.loginUrl);
    const existing = await this.findProviderTab(providerId);
    let created = false;
    let tab: BrowserTab | undefined;
    if (typeof existing?.id === "number") {
      try {
        tab = await browser.tabs.update(existing.id, { active: true }) as unknown as BrowserTab;
      } catch (error) {
        // The tab may have been closed after tabs.query(). Fall through to a
        // fresh login tab instead of surfacing Chrome's raw tab-id error.
        if (!isMissingTabError(error)) throw error;
      }
    }
    if (!tab) {
      created = true;
      tab = await browser.tabs.create({ url: spec.loginUrl, active: true }) as unknown as BrowserTab;
    }
    if (typeof tab.id !== "number") throw new AppError("auth-required", `无法打开 ${spec.label} 登录页`);
    try {
      await waitForTabReady(tab.id, signal ?? new AbortController().signal, spec.label);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal) throwIfAborted(signal);
        let result: CaptureResult;
        try {
          result = signal
            ? await withAbort(captureWebSessionCredential(tab.id, providerId), signal)
            : await captureWebSessionCredential(tab.id, providerId);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (isMissingTabError(error)) throw closedLoginTabError(spec.label, error);
          result = { status: "logged-out" };
        }
        if (result.status === "ok") {
          if (signal) throwIfAborted(signal);
          await this.storage.saveWebSessionCredential(result.credential);
          return;
        }
        if (result.status === "failed") throw new AppError("api-contract", result.message, { retryable: true });
        if (signal) await abortableDelay(1_000, signal);
        else await delay(1_000);
      }
      throw new AppError("auth-required", `等待 ${spec.label} 登录超时`, { retryable: true });
    } finally {
      if (created) await browser.tabs.remove(tab.id).catch(() => undefined);
    }
  }

  async validateReady(providerId: WebSessionProviderId): Promise<void> {
    const spec = getWebSessionSpec(providerId);
    if (!(await hasPageHostPermission(spec.loginUrl))) {
      throw new AppError("auth-required", `请先点击“登录 ${spec.label}”，授权复用当前浏览器会话`);
    }
    await this.ensureCredential(providerId);
  }

  async testConnection(providerId: WebSessionProviderId, signal?: AbortSignal): Promise<{ ok: true; message: string; externalUrl?: string }> {
    await this.validateReady(providerId);
    if (providerId === "chatgpt-web") await ensureChatGptCookiePermission();
    const activeSignal = signal ?? new AbortController().signal;
    throwIfAborted(activeSignal);
    const port = browser.runtime.connect({ name: WEB_SESSION_PORT_NAME });
    const requestId = generateRequestId();
    return new Promise<{ ok: true; message: string; externalUrl?: string }>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        activeSignal.removeEventListener("abort", onAbort);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        port.disconnect();
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onMessage = (message: WebSessionPortMessage) => {
        if (!message || message.requestId !== requestId) return;
        if (message.type === "done") {
          finish(() => resolve({
            ok: true,
            message: message.message || `${getWebSessionSpec(providerId).label} 连通性正常`,
            ...(message.externalUrl ? { externalUrl: message.externalUrl } : {}),
          }));
        } else if (message.type === "error") {
          finish(() => reject(new AppError(message.error.code, message.error.message, {
            retryable: message.error.retryable,
            ...(message.externalUrl || message.error.externalUrl ? { externalUrl: message.externalUrl || message.error.externalUrl } : {}),
          })));
        }
      };
      const onDisconnect = () => finish(() => reject(new AppError("api-unavailable", "网页协议后台连接已断开", { retryable: true })));
      const onAbort = () => {
        try {
          port.postMessage({ type: "cancel", requestId });
        } catch {
          // The background port may already be gone while the test is aborted.
        }
        finish(() => reject(activeSignal.reason ?? new DOMException("Aborted", "AbortError")));
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      activeSignal.addEventListener("abort", onAbort, { once: true });
      try {
        port.postMessage({ type: "test", requestId, providerId });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  async diagnoseGemini(
    mode: GeminiDiagnosticMode,
    signal?: AbortSignal,
    onEvent?: (event: GeminiDiagnosticEvent) => void,
  ): Promise<GeminiDiagnosticReport> {
    await this.validateReady("gemini-web");
    const activeSignal = signal ?? new AbortController().signal;
    throwIfAborted(activeSignal);
    const port = browser.runtime.connect({ name: WEB_SESSION_PORT_NAME });
    const requestId = generateRequestId();
    return new Promise<GeminiDiagnosticReport>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        activeSignal.removeEventListener("abort", onAbort);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        port.disconnect();
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onMessage = (message: WebSessionPortMessage) => {
        if (!message || message.requestId !== requestId) return;
        if (message.type === "diagnostic-event") {
          onEvent?.(message.event);
        } else if (message.type === "diagnostic-done") {
          const report = message.externalUrl
            ? { ...message.report, externalUrl: message.externalUrl }
            : message.report;
          finish(() => resolve(report));
        } else if (message.type === "error") {
          const diagnostic = message.diagnostic && message.externalUrl
            ? { ...message.diagnostic, externalUrl: message.externalUrl }
            : message.diagnostic;
          finish(() => reject(new AppError(message.error.code, message.error.message, {
            retryable: message.error.retryable,
            ...(diagnostic ? { diagnostic } : {}),
            ...(message.externalUrl || message.error.externalUrl ? { externalUrl: message.externalUrl || message.error.externalUrl } : {}),
          })));
        }
      };
      const onDisconnect = () => finish(() => reject(new AppError("api-unavailable", "Gemini 诊断后台连接已断开", { retryable: true })));
      const onAbort = () => {
        try {
          port.postMessage({ type: "cancel", requestId });
        } catch {
          // The background port may already be gone while the diagnostic is aborted.
        }
        finish(() => reject(activeSignal.reason ?? new DOMException("Aborted", "AbortError")));
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      activeSignal.addEventListener("abort", onAbort, { once: true });
      try {
        port.postMessage({ type: "gemini-diagnostic", requestId, mode });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  async detectLoginStatus(providerId: WebSessionProviderId): Promise<WebSessionLoginStatus> {
    try {
      const spec = getWebSessionSpec(providerId);
      if (!(await hasPageHostPermission(spec.loginUrl))) return "permission-required";
      const credential = await this.storage.getWebSessionCredential(providerId);
      const tab = await this.findProviderTab(providerId);
      if (typeof tab?.id !== "number" || !isTabForOrigin(tab.url, spec.origin)) return credential ? "saved-unverified" : "no-page";
      if (credential) {
        const capture = await captureWebSessionCredentialWithRetry(tab.id, providerId);
        if (capture?.status === "ok") {
          await this.storage.saveWebSessionCredential(capture.credential);
          return "logged-in";
        }
        if (capture?.status === "logged-out") return "logged-out";
        return "unknown";
      }
      const capture = await captureWebSessionCredentialWithRetry(tab.id, providerId);
      if (capture.status === "ok") {
        await this.storage.saveWebSessionCredential(capture.credential);
        return "logged-in";
      }
      const result = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: detectWebSessionPage,
        args: [providerId],
      });
      const status = (result[0]?.result as { status?: unknown } | undefined)?.status;
      if (status === "logged-in") return "page-logged-in";
      return status === "logged-out" || status === "unknown" ? status : "unknown";
    } catch {
      return "unknown";
    }
  }

  async *stream(providerId: WebSessionProviderId, prompt: string, signal: AbortSignal, file?: File): AsyncIterable<WebSessionStreamEvent> {
    if (providerId === "chatgpt-web") await ensureChatGptCookiePermission();
    await this.validateReady(providerId);
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const filePayload = file ? await serializeWebSessionFile(file, signal) : undefined;
    const port = browser.runtime.connect({ name: WEB_SESSION_PORT_NAME });
    const requestId = generateRequestId();
    const queue = new AsyncQueue<WebSessionStreamEvent>();
    const onMessage = (message: WebSessionPortMessage) => {
      if (!message || message.requestId !== requestId) return;
      if (message.type === "snapshot") queue.push({ type: "snapshot", text: message.text });
      else if (message.type === "done") {
        queue.push({ type: "done", externalUrl: message.externalUrl });
        queue.end();
      } else if (message.type === "error") {
        queue.fail(new AppError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
          ...(message.externalUrl || message.error.externalUrl ? { externalUrl: message.externalUrl || message.error.externalUrl } : {}),
        }));
      }
    };
    const onDisconnect = () => queue.fail(new AppError("api-unavailable", "网页协议后台连接已断开", { retryable: true }));
    const postMessage = (message: Parameters<typeof port.postMessage>[0]) => {
      try {
        port.postMessage(message);
      } catch {
        // The background port may disappear at the same time as an abort.
      }
    };
    const onAbort = () => {
      postMessage({ type: "cancel", requestId });
      queue.fail(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    const heartbeat = setInterval(() => {
      if (!signal.aborted) postMessage({ type: "heartbeat", requestId });
    }, 10_000);
    signal.addEventListener("abort", onAbort, { once: true });
    postMessage({
      type: "start",
      requestId,
      providerId,
      prompt,
      ...(filePayload ? { file: { name: filePayload.name, type: filePayload.type, size: filePayload.size } } : {}),
    });
    if (filePayload) {
      const bytes = new Uint8Array(filePayload.data);
      const chunkSize = 256 * 1024;
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkSize, index += 1) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
        postMessage({ type: "file-chunk", requestId, index, data: encodeBase64(chunk) });
      }
    }
    try {
      for await (const event of queue) yield event;
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", onAbort);
      if (!signal.aborted) postMessage({ type: "cancel", requestId });
      port.disconnect();
    }
  }

  private async findProviderTab(providerId: WebSessionProviderId): Promise<BrowserTab | undefined> {
    const spec = getWebSessionSpec(providerId);
    let tabs: BrowserTab[];
    try {
      const result = await browser.tabs.query({});
      tabs = Array.isArray(result) ? result as unknown as BrowserTab[] : [];
    } catch {
      return undefined;
    }
    return tabs
      .filter((tab) => typeof tab.id === "number" && isTabForOrigin(tab.url, spec.origin))
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
      })[0];
  }

  private async ensureCredential(providerId: WebSessionProviderId): Promise<WebSessionCredential> {
    const saved = await this.storage.getWebSessionCredential(providerId);
    if (saved) return saved;

    const spec = getWebSessionSpec(providerId);
    const tab = await this.findProviderTab(providerId);
    if (typeof tab?.id !== "number" || !isTabForOrigin(tab.url, spec.origin)) {
      throw new AppError(
        "auth-required",
        `请先登录 ${spec.label}：扩展未保存登录凭据，也未找到已打开的 ${spec.label} 页面。点击“登录 ${spec.label}”完成采集后再重试`,
        { retryable: true },
      );
    }

    let capture: CaptureResult;
    try {
      capture = await captureWebSessionCredentialWithRetry(tab.id, providerId);
    } catch (error) {
      throw new AppError("api-contract", describeCaptureError(error, spec.label), { cause: error, retryable: true });
    }
    if (capture.status === "ok") {
      await this.storage.saveWebSessionCredential(capture.credential);
      return capture.credential;
    }
    if (capture.status === "logged-out") {
      throw new AppError(
        "auth-required",
        `${spec.label} 当前页面未返回可用登录凭据，请在页面完成登录后点击“更新 ${spec.label}”重试`,
        { retryable: true },
      );
    }
    throw new AppError(
      "api-contract",
      `${spec.label} 登录凭据采集失败：${capture.message}。请保持页面打开并点击“更新 ${spec.label}”重试`,
      { retryable: true },
    );
  }
}

function isTabForOrigin(value: string | undefined, expectedOrigin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.resolve({ done: true, value: undefined as never });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length) return { done: false, value: this.values.shift()! };
        if (this.failure !== undefined) throw this.failure;
        if (this.closed) return { done: true, value: undefined as never };
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

async function captureWebSessionCredential(tabId: number, providerId: WebSessionProviderId): Promise<CaptureResult> {
  const result = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: readWebSessionCredential,
    args: [providerId],
  });
  return result[0]?.result as CaptureResult | undefined || { status: "logged-out" };
}

async function captureWebSessionCredentialWithRetry(tabId: number, providerId: WebSessionProviderId): Promise<CaptureResult> {
  let last: CaptureResult = { status: "logged-out" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      last = await captureWebSessionCredential(tabId, providerId);
    } catch (error) {
      last = { status: "failed", message: describeCaptureError(error, getWebSessionSpec(providerId).label) };
      if (isMissingTabError(error)) return last;
    }
    if (last.status !== "failed" || attempt === 2) return last;
    await delay(250);
  }
  return last;
}

function describeCaptureError(error: unknown, label: string): string {
  if (isMissingTabError(error)) return `${label} 登录页已关闭，请保持页面打开并重试`;
  const detail = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 180) : "页面脚本执行失败";
  return `${label} 登录凭据采集失败：${detail}`;
}

export async function readWebSessionCredential(providerId: WebSessionProviderId): Promise<CaptureResult> {
  if (providerId === "chatgpt-web") {
    try {
      const response = await fetch("/api/auth/session", { credentials: "include", headers: { Accept: "application/json" } });
      if (response.status === 401 || response.status === 403) return { status: "logged-out" };
      if (!response.ok) return { status: "failed", message: `ChatGPT 会话检查失败（HTTP ${response.status}）` };
      const session = await response.json() as { accessToken?: unknown; expires?: unknown };
      if (typeof session.accessToken !== "string" || !session.accessToken) return { status: "logged-out" };
      const expiresAt = typeof session.expires === "string" ? Date.parse(session.expires) : undefined;
      return {
        status: "ok",
        credential: {
          providerId: "chatgpt-web",
          accessToken: session.accessToken,
          capturedAt: Date.now(),
          ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
        },
      };
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 180) : "网络请求或响应解析失败";
      return { status: "failed", message: `ChatGPT 会话检查异常：${detail}` };
    }
  }
  if (providerId === "gemini-web") {
    try {
      const pageUrl = new URL(location.href);
      const pagePath = (pageUrl.pathname + pageUrl.search).toLowerCase();
      if (pageUrl.origin !== "https://gemini.google.com" || pagePath.includes("servicelogin") || pagePath.includes("/signin") || pagePath.includes("/login")) {
        return { status: "logged-out" };
      }

      const currentAccount = /\/u\/(\d+)(?:\/|$)/.exec(pageUrl.pathname)?.[1]
        || (/^\d+$/.test(pageUrl.searchParams.get("authuser") || "") ? pageUrl.searchParams.get("authuser") : undefined)
        || "0";

      const extractToken = (key: string, sourceHtml: string): string | undefined => {
        if (!sourceHtml) return undefined;
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
        const keyPattern = "(?:[\"']" + key + "[\"']|\\b" + key + "\\b)";
        const sourceVariants = [sourceHtml, sourceHtml.replace(/\\(["'])/g, "$1")];
        const patterns = [
          new RegExp(keyPattern + "\\s*(?::|=)\\s*\"((?:\\\\.|[^\"\\\\])*)\""),
          new RegExp(keyPattern + "\\s*(?::|=)\\s*'((?:\\\\.|[^'\\\\])*)'"),
          new RegExp("\\[\\s*[\"']" + key + "[\"']\\s*,\\s*\"((?:\\\\.|[^\"\\\\])*)\""),
          new RegExp("\\[\\s*[\"']" + key + "[\"']\\s*,\\s*'((?:\\\\.|[^'\\\\])*)'"),
        ];
        for (const variant of sourceVariants) {
          for (const pattern of patterns) {
            const raw = pattern.exec(variant)?.[1];
            const value = raw ? decodeJsString(raw).trim() : "";
            if (value) return value;
          }
        }
        return undefined;
      };

      // 1. Priority: Read directly from current page memory and DOM context
      let atValue: string | undefined;
      let blValue: string | undefined;
      let fSid: string | undefined;

      const findGlobalValue = (root: unknown, key: string): string | undefined => {
        const visited = new Set<object>();
        const visit = (value: unknown, depth: number): string | undefined => {
          if (depth > 5 || value === null || typeof value !== "object") return undefined;
          if (visited.has(value)) return undefined;
          visited.add(value);
          const record = value as Record<string, unknown>;
          const direct = record[key];
          if (typeof direct === "string" && direct.trim()) return direct.trim();
          const children = Array.isArray(value) ? value : Object.values(record).slice(0, 200);
          for (const child of children) {
            const result = visit(child, depth + 1);
            if (result) return result;
          }
          return undefined;
        };
        return visit(root, 0);
      };
      const pageWindow = window as unknown as Record<string, unknown>;
      for (const name of ["WIZ_global_data", "__INITIAL_STATE__", "__INITIAL_DATA__", "__NEXT_DATA__"]) {
        try {
          atValue = atValue || findGlobalValue(pageWindow[name], "SNlM0e") || findGlobalValue(pageWindow[name], "thykhd");
          blValue = blValue || findGlobalValue(pageWindow[name], "cfb2h");
          fSid = fSid || findGlobalValue(pageWindow[name], "FdrFJe");
        } catch {
          // A page-owned getter can throw; the embedded script remains usable.
        }
      }
      try {
        const candidateNames = Object.keys(pageWindow)
          .filter((name) => /wiz|gemini|bard|initial|state|config|data/i.test(name))
          .slice(0, 40);
        for (const name of candidateNames) {
          atValue = atValue || findGlobalValue(pageWindow[name], "SNlM0e") || findGlobalValue(pageWindow[name], "thykhd");
          blValue = blValue || findGlobalValue(pageWindow[name], "cfb2h");
          fSid = fSid || findGlobalValue(pageWindow[name], "FdrFJe");
          if (atValue && blValue && fSid) break;
        }
      } catch {
        // Ignore non-enumerable or hostile page globals.
      }

      const outerHtml = document.documentElement?.outerHTML || document.documentElement?.innerHTML || "";
      atValue = atValue || extractToken("SNlM0e", outerHtml) || extractToken("thykhd", outerHtml);
      blValue = blValue || extractToken("cfb2h", outerHtml);
      fSid = fSid || extractToken("FdrFJe", outerHtml);

      const authUser = /\/u\/(\d+)(?:\/|$)/.exec(pageUrl.pathname)?.[1]
        || /data-index\s*=\s*["'](\d+)["']/.exec(outerHtml)?.[1]
        || currentAccount;

      if (atValue && blValue && fSid) {
        return { status: "ok", credential: { providerId: "gemini-web", authUser, capturedAt: Date.now() } };
      }

      // 2. A hydrated Gemini composer is a useful signed-in marker when the
      // short-lived values are held only in page memory. Do not use a generic
      // textarea or the word "Gemini" as proof of login.
      const hasVisibleLoginUi = Boolean(document.querySelector(
        "a[href*='ServiceLogin'], a[href*='signin'], button[aria-label*='Sign in'], button[aria-label*='登录']",
      ));
      const hasGeminiComposer = Boolean(document.querySelector(
        "rich-textarea, .ql-editor, [contenteditable='true'], .send-button, textarea[aria-label*='prompt' i], textarea[placeholder*='message' i]",
      ));

      if (hasGeminiComposer && !hasVisibleLoginUi) {
        return { status: "ok", credential: { providerId: "gemini-web", authUser, capturedAt: Date.now() } };
      }

      // 3. Fallback: Fetch `${accountPrefix}/app` if the current DOM is blank or unhydrated
      const accountPrefix = currentAccount !== "0" ? `/u/${currentAccount}` : "";
      const response = await fetch(accountPrefix + "/app", { credentials: "include", headers: { Accept: "text/html" } });
      if (response.status === 401 || response.status === 403) return { status: "logged-out" };
      if (!response.ok) return { status: "failed", message: "Gemini 会话检查失败（HTTP " + response.status + "）" };
      const html = await response.text();

      const fetchedAt = extractToken("SNlM0e", html) || extractToken("thykhd", html);
      const fetchedBl = extractToken("cfb2h", html);
      const fetchedSid = extractToken("FdrFJe", html);

      const responseUrl = new URL(response.url || pageUrl.href);
      const fetchedAuthUser = /\/u\/(\d+)(?:\/|$)/.exec(responseUrl.pathname)?.[1]
        || /data-index\s*=\s*["'](\d+)["']/.exec(html)?.[1]
        || currentAccount;

      if (fetchedAt && fetchedBl && fetchedSid && responseUrl.origin === "https://gemini.google.com") {
        return { status: "ok", credential: { providerId: "gemini-web", authUser: fetchedAuthUser, capturedAt: Date.now() } };
      }

      const lowerHtml = html.toLowerCase();
      const isLoginPage = (lowerHtml.includes("servicelogin") || lowerHtml.includes("identifier"))
        && (lowerHtml.includes("sign in") || lowerHtml.includes("signin") || lowerHtml.includes("登录"));
      if (isLoginPage || responseUrl.origin !== "https://gemini.google.com") return { status: "logged-out" };

      // A same-origin /app response without the required values is a page
      // contract failure, not proof that the user logged out.
      return { status: "failed", message: "Gemini 页面未提供可识别的登录上下文，页面协议可能已变化" };
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 180) : "网络请求或响应解析失败";
      return { status: "failed", message: `Gemini 会话检查异常：${detail}` };
    }
  }
  try {
    const raw = window.localStorage.getItem("userToken");
    if (!raw) return { status: "logged-out" };
    const parsed = JSON.parse(raw) as unknown;
    const token = typeof parsed === "string"
      ? parsed
      : parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).value === "string"
        ? (parsed as Record<string, string>).value
        : parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).token === "string"
          ? (parsed as Record<string, string>).token
          : raw;
    return typeof token === "string" && token.trim()
      ? { status: "ok", credential: { providerId: "deepseek-web", userToken: token.trim(), capturedAt: Date.now() } }
      : { status: "logged-out" };
  } catch {
    return { status: "logged-out" };
  }
}

function detectWebSessionPage(providerId: string): { status: WebSessionLoginStatus } {
  const configs: Record<string, { origin: string; loggedInSelectors: string[]; loggedOutSelectors: string[]; loggedOutMarkers: string[] }> = {
    "chatgpt-web": {
      origin: "https://chatgpt.com",
      loggedInSelectors: ["#prompt-textarea", "textarea#prompt-textarea", "[data-testid=\"send-button\"]"],
      loggedOutSelectors: ["a[href*=\"/auth/login\"]", "button[aria-label*=\"Log in\"]", "button[aria-label*=\"登录\"]"],
      loggedOutMarkers: ["log in", "sign up", "登录", "注册"],
    },
    "gemini-web": {
      origin: "https://gemini.google.com",
      loggedInSelectors: [".ql-editor", "rich-textarea", ".send-button", "textarea"],
      loggedOutSelectors: ["a[href*=\"ServiceLogin\"]", "a[href*=\"signin\"]", "button[aria-label*=\"Sign in\"]", "button[aria-label*=\"登录\"]"],
      loggedOutMarkers: ["sign in", "log in", "登录", "登入"],
    },
    "deepseek-web": {
      origin: "https://chat.deepseek.com",
      loggedInSelectors: ["textarea.ds-scroll-area", "textarea#chat-input", "[contenteditable=\"true\"]"],
      loggedOutSelectors: ["a[href*=\"login\"]", "button[aria-label*=\"Sign in\"]", "button[aria-label*=\"登录\"]"],
      loggedOutMarkers: ["sign in", "log in", "登录", "注册"],
    },
  };
  const config = configs[providerId];
  if (!config || location.origin !== config.origin) return { status: "unknown" };
  const isVisible = (element: Element): boolean => {
    const htmlElement = element as HTMLElement;
    const style = window.getComputedStyle(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const hasVisibleSelector = (selectors: string[]): boolean => selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisible));
  const bodyText = (document.body?.innerText || "").slice(0, 4_000).toLowerCase();
  if (hasVisibleSelector(config.loggedOutSelectors)) return { status: "logged-out" };
  if (hasVisibleSelector(config.loggedInSelectors)) return { status: "logged-in" };
  if (config.loggedOutMarkers.some((marker) => bodyText.includes(marker.toLowerCase()))) return { status: "logged-out" };
  return { status: "unknown" };
}

async function waitForTabReady(tabId: number, signal: AbortSignal, label: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    let tab: BrowserTab;
    try {
      tab = await browser.tabs.get(tabId) as unknown as BrowserTab;
    } catch (error) {
      if (isMissingTabError(error)) throw closedLoginTabError(label, error);
      throw error;
    }
    if (tab.status === "complete" && tab.url) return;
    await abortableDelay(500, signal);
  }
  throw new AppError("api-unavailable", "登录页面加载超时，请稍后重试", { retryable: true });
}

function closedLoginTabError(label: string, cause: unknown): AppError {
  return new AppError("auth-required", `${label} 登录页已关闭，请重新点击登录并保持页面打开`, { cause, retryable: true });
}

async function serializeWebSessionFile(file: File, signal: AbortSignal): Promise<WebSessionFilePayload> {
  try {
    const data = await file.arrayBuffer();
    throwIfAborted(signal);
    return {
      name: file.name || "document.txt",
      type: file.type || "application/octet-stream",
      size: data.byteLength,
      data,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    throw new AppError("upload-failed", `无法读取待上传文件 ${file.name || "文档"}`, { cause: error, retryable: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `web-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
