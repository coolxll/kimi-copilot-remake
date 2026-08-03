import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { WebSessionCredential, WebSessionProviderId } from "../../domain/types";
import type { SettingsRepository } from "../../platform/chrome/storage";
import { ensureChatGptCookiePermission, ensurePageHostPermission, hasPageHostPermission } from "../../platform/chrome/permissions";
import { abortableDelay, throwIfAborted, withAbort } from "../../shared/abort";
import { WEB_SESSION_PORT_NAME, type WebSessionPortMessage } from "./messages";
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
    const created = existing?.id === undefined;
    const tab = created
      ? await browser.tabs.create({ url: spec.loginUrl, active: true }) as unknown as BrowserTab
      : await browser.tabs.update(existing.id, { active: true }) as unknown as BrowserTab;
    if (typeof tab.id !== "number") throw new AppError("auth-required", `无法打开 ${spec.label} 登录页`);
    try {
      await waitForTabReady(tab.id, signal ?? new AbortController().signal);
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
          finish(() => reject(new AppError(message.error.code, message.error.message, { retryable: message.error.retryable })));
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

  async *stream(providerId: WebSessionProviderId, prompt: string, signal: AbortSignal): AsyncIterable<WebSessionStreamEvent> {
    if (providerId === "chatgpt-web") await ensureChatGptCookiePermission();
    await this.validateReady(providerId);
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const port = browser.runtime.connect({ name: WEB_SESSION_PORT_NAME });
    const requestId = generateRequestId();
    const queue = new AsyncQueue<WebSessionStreamEvent>();
    const onMessage = (message: WebSessionPortMessage) => {
      if (!message || message.requestId !== requestId) return;
      if (message.type === "snapshot") queue.push({ type: "snapshot", text: message.text });
      else if (message.type === "done") {
        queue.push({ type: "done", externalUrl: message.externalUrl });
        queue.end();
      } else {
        queue.fail(new AppError(message.error.code, message.error.message, { retryable: message.error.retryable }));
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
    postMessage({ type: "start", requestId, providerId, prompt });
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
    }
    if (last.status !== "failed" || attempt === 2) return last;
    await delay(250);
  }
  return last;
}

function describeCaptureError(error: unknown, label: string): string {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 180) : "页面脚本执行失败";
  return `${label} 登录凭据采集失败：${detail}`;
}

async function readWebSessionCredential(providerId: WebSessionProviderId): Promise<CaptureResult> {
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
      const currentAccount = /\/u\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1]
        || new URL(location.href).searchParams.get("authuser")
        || "0";
      const accountPrefix = currentAccount !== "0" ? `/u/${currentAccount}` : "";
      const response = await fetch(`${accountPrefix}/app`, { credentials: "include", headers: { Accept: "text/html" } });
      if (response.status === 401 || response.status === 403) return { status: "logged-out" };
      if (!response.ok) return { status: "failed", message: `Gemini 会话检查失败（HTTP ${response.status}）` };
      const html = await response.text();
      // SNlM0e is the `at` token used by the current StreamGenerate contract;
      // thykhd is retained only as a fallback for older/different page builds.
      const atValue = /"SNlM0e"\s*:\s*"([^"]+)"/.exec(html)?.[1]
        || /"thykhd"\s*:\s*"([^"]+)"/.exec(html)?.[1];
      const blValue = /"cfb2h"\s*:\s*"([^"]+)"/.exec(html)?.[1];
      const fSid = /"FdrFJe"\s*:\s*"([^"]+)"/.exec(html)?.[1];
      const responseUrl = new URL(response.url || location.href);
      const lowerHtml = html.toLowerCase();
      const loginPage = (lowerHtml.includes("servicelogin") || lowerHtml.includes("identifier"))
        && (lowerHtml.includes("sign in") || lowerHtml.includes("signin") || lowerHtml.includes("登录"));
      if (!atValue || !blValue || !fSid || loginPage || responseUrl.origin !== location.origin) return { status: "logged-out" };
      const authUser = /\/u\/(\d+)(?:\/|$)/.exec(responseUrl.pathname)?.[1]
        || /data-index="(\d+)"/.exec(html)?.[1]
        || currentAccount;
      return { status: "ok", credential: { providerId: "gemini-web", authUser, capturedAt: Date.now() } };
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

async function waitForTabReady(tabId: number, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const tab = await browser.tabs.get(tabId) as unknown as BrowserTab;
    if (tab.status === "complete" && tab.url) return;
    await abortableDelay(500, signal);
  }
  throw new AppError("api-unavailable", "登录页面加载超时，请稍后重试", { retryable: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `web-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
