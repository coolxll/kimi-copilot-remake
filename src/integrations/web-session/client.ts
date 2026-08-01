import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { WebSessionCredential, WebSessionProviderId } from "../../domain/types";
import type { SettingsRepository } from "../../platform/chrome/storage";
import { ensurePageHostPermission, hasPageHostPermission } from "../../platform/chrome/permissions";
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

export type WebSessionLoginStatus = "logged-in" | "logged-out" | "no-page" | "permission-required" | "unknown";

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
    if (!(await this.storage.getWebSessionCredential(providerId))) {
      throw new AppError("auth-required", `请先登录 ${spec.label}`);
    }
  }

  async detectLoginStatus(providerId: WebSessionProviderId): Promise<WebSessionLoginStatus> {
    try {
      const spec = getWebSessionSpec(providerId);
      if (!(await hasPageHostPermission(spec.loginUrl))) return "permission-required";
      if (await this.storage.getWebSessionCredential(providerId)) return "logged-in";
      const tab = await this.findProviderTab(providerId);
      if (typeof tab?.id !== "number" || !isTabForOrigin(tab.url, spec.origin)) return "no-page";
      const result = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: detectWebSessionPage,
        args: [providerId],
      });
      const status = (result[0]?.result as { status?: unknown } | undefined)?.status;
      return status === "logged-in" || status === "logged-out" || status === "unknown" ? status : "unknown";
    } catch {
      return "unknown";
    }
  }

  async *stream(providerId: WebSessionProviderId, prompt: string, signal: AbortSignal): AsyncIterable<WebSessionStreamEvent> {
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
      tabs = await browser.tabs.query({}) as unknown as BrowserTab[];
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
    } catch {
      return { status: "logged-out" };
    }
  }
  if (providerId === "gemini-web") {
    try {
      const response = await fetch("/app", { credentials: "include", headers: { Accept: "text/html" } });
      if (!response.ok) return { status: "logged-out" };
      const html = await response.text();
      const atValue = /"SNlM0e":"([^"]+)"/.exec(html)?.[1];
      const blValue = /"cfb2h":"([^"]+)"/.exec(html)?.[1];
      const fSid = /"FdrFJe":"([^"]+)"/.exec(html)?.[1];
      if (!atValue || !blValue || !fSid || html.toLowerCase().includes("accounts.google.com")) return { status: "logged-out" };
      const authUser = /data-index="(\d+)"/.exec(html)?.[1] || "0";
      return { status: "ok", credential: { providerId: "gemini-web", authUser, capturedAt: Date.now() } };
    } catch {
      return { status: "logged-out" };
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
