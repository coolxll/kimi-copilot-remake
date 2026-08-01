import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { WebSessionProviderId } from "../../domain/types";
import { ensurePageHostPermission, hasPageHostPermission } from "../../platform/chrome/permissions";
import { runChatGptWebRpc, type ChatGptWebPageResult } from "./chatgpt-rpc";
import { completeGeminiWebRpc } from "./gemini-rpc";
import { getWebSessionSpec } from "./specs";

interface BrowserTab {
  id?: number;
  url?: string;
  status?: string;
  active?: boolean;
  lastAccessed?: number;
}

export type WebSessionLoginStatus = "logged-in" | "logged-out" | "no-page" | "permission-required" | "unknown";

type WebSessionPageDetectionResult = {
  status: Exclude<WebSessionLoginStatus, "no-page" | "permission-required">;
};

type WebSessionPageResult =
  | { status: "ok"; text: string }
  | { status: "auth-required"; message: string }
  | { status: "failed"; message: string };

export class WebSessionClient {
  private readonly sessionTabs = new Map<WebSessionProviderId, number>();

  async openLogin(providerId: WebSessionProviderId): Promise<void> {
    const spec = getWebSessionSpec(providerId);
    await ensurePageHostPermission(spec.loginUrl);
    const existing = await this.findProviderTab(providerId);
    if (existing?.id) {
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
    const created = await browser.tabs.create({ url: spec.loginUrl, active: true }) as unknown as BrowserTab;
    if (typeof created.id !== "number") throw new AppError("auth-required", `无法打开 ${spec.label} 登录页`);
    this.sessionTabs.set(providerId, created.id);
  }

  async validateReady(providerId: WebSessionProviderId): Promise<void> {
    const spec = getWebSessionSpec(providerId);
    if (!(await hasPageHostPermission(spec.loginUrl))) {
      throw new AppError("auth-required", `请先点击“登录 ${spec.label}”，授权复用当前浏览器会话`);
    }
  }

  /**
   * Read-only status check for the settings page. It never creates a tab or
   * sends a prompt; the provider page remains the owner of its login state.
   */
  async detectLoginStatus(providerId: WebSessionProviderId): Promise<WebSessionLoginStatus> {
    try {
      const spec = getWebSessionSpec(providerId);
      if (!(await hasPageHostPermission(spec.loginUrl))) return "permission-required";
      const tab = await this.findProviderTab(providerId);
      if (typeof tab?.id !== "number" || !tab.url?.startsWith(spec.origin)) return "no-page";
      const result = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: detectWebSessionPage,
        args: [providerId],
      });
      const status = (result[0]?.result as WebSessionPageDetectionResult | undefined)?.status;
      return status === "logged-in" || status === "logged-out" || status === "unknown" ? status : "unknown";
    } catch {
      return "unknown";
    }
  }

  async complete(providerId: WebSessionProviderId, prompt: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await this.validateReady(providerId);
    const spec = getWebSessionSpec(providerId);
    let rpcError: unknown;
    if (providerId === "gemini-web") {
      try {
        const output = await withAbort(completeGeminiWebRpc(prompt, signal), signal);
        if (output.trim()) return output.trim();
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        rpcError = error;
      }
    }

    const tab = await this.ensureWorkTab(providerId);
    if (typeof tab.id !== "number") throw new AppError("auth-required", `无法打开 ${spec.label} 页面`);
    const tabId = tab.id;
    const readyTab = tab.status === "complete" ? tab : await waitForTabReady(tabId, signal);
    if (typeof readyTab.id !== "number") throw new AppError("auth-required", `无法读取 ${spec.label} 页面`);
    if (providerId === "chatgpt-web") {
      try {
        const result = await this.executeChatGptWebRpc(readyTab.id, prompt, signal);
        if (result?.status === "ok" && result.text.trim()) return result.text.trim();
        if (result?.status === "auth-required") rpcError = new AppError("auth-required", result.message, { retryable: true });
        else if (result?.status === "failed") rpcError = new AppError("api-unavailable", result.message, { retryable: true });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        rpcError = error;
      }
    }
    const pageResult = await this.executePageSession(readyTab.id, providerId, prompt, signal);
    if (!pageResult || pageResult.status === "failed") {
      if (rpcError instanceof AppError && rpcError.code === "auth-required") throw rpcError;
      const detail = (providerId === "gemini-web" || providerId === "chatgpt-web") && rpcError instanceof Error
        ? `；${providerId === "gemini-web" ? "RPC" : "ChatGPT Web API"} 路径：${rpcError.message}`
        : "";
      throw new AppError("api-unavailable", `${pageResult?.message || `${spec.label} 页面会话没有返回结果`}${detail}`, { retryable: true });
    }
    if (pageResult.status === "auth-required") throw new AppError("auth-required", pageResult.message);
    if (!pageResult.text.trim()) throw new AppError("api-contract", `${spec.label} 返回内容为空`);
    return pageResult.text.trim();
  }

  private async executePageSession(
    tabId: number,
    providerId: WebSessionProviderId,
    prompt: string,
    signal: AbortSignal,
  ): Promise<WebSessionPageResult | undefined> {
    const result = await withAbort(
      browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: runWebSessionPage,
        args: [providerId, prompt],
      }),
      signal,
    );
    return result[0]?.result as WebSessionPageResult | undefined;
  }

  private async executeChatGptWebRpc(
    tabId: number,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ChatGptWebPageResult | undefined> {
    const result = await withAbort(
      browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: runChatGptWebRpc,
        args: [prompt],
      }),
      signal,
    );
    return result[0]?.result as ChatGptWebPageResult | undefined;
  }

  private async ensureWorkTab(providerId: WebSessionProviderId): Promise<BrowserTab> {
    const spec = getWebSessionSpec(providerId);
    const existing = await this.findProviderTab(providerId);
    if (existing?.id && existing.url?.startsWith(spec.origin)) return existing;
    const created = await browser.tabs.create({ url: spec.loginUrl, active: false }) as unknown as BrowserTab;
    if (typeof created.id !== "number") throw new AppError("auth-required", `无法打开 ${spec.label} 页面`);
    this.sessionTabs.set(providerId, created.id);
    return created;
  }

  /**
   * Reuse a provider tab that the user already opened in this Chrome profile.
   * For DOM adapters the tab, rather than a copied cookie/token, is the
   * session boundary. Gemini's RPC path can use the browser-managed session
   * without a tab and only needs this tab for its DOM fallback.
   */
  private async findProviderTab(providerId: WebSessionProviderId): Promise<BrowserTab | undefined> {
    const spec = getWebSessionSpec(providerId);
    const cached = await this.getCachedTab(providerId, true);
    if (cached?.id && cached.url?.startsWith(spec.origin)) return cached;

    let tabs: BrowserTab[];
    try {
      tabs = await browser.tabs.query({}) as unknown as BrowserTab[];
    } catch {
      // A missing tabs-sensitive permission should not prevent the fallback
      // path from opening a fresh provider tab.
      return undefined;
    }
    const matches = tabs
      .filter((tab) => typeof tab.id === "number" && tab.url?.startsWith(spec.origin))
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
      });
    const existing = matches[0];
    if (existing?.id !== undefined) this.sessionTabs.set(providerId, existing.id);
    return existing;
  }

  private async getCachedTab(providerId: WebSessionProviderId, requireSameOrigin: boolean): Promise<BrowserTab | undefined> {
    const tabId = this.sessionTabs.get(providerId);
    if (tabId === undefined) return undefined;
    try {
      const tab = await browser.tabs.get(tabId) as unknown as BrowserTab;
      const spec = getWebSessionSpec(providerId);
      if (requireSameOrigin && !tab.url?.startsWith(spec.origin)) return undefined;
      return tab;
    } catch {
      this.sessionTabs.delete(providerId);
      return undefined;
    }
  }
}

async function waitForTabReady(tabId: number, signal: AbortSignal): Promise<BrowserTab> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const tab = await browser.tabs.get(tabId) as unknown as BrowserTab;
    if (tab.status === "complete" && tab.url) return tab;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new AppError("api-unavailable", "网页会话页面加载超时，请稍后重试", { retryable: true });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Runs in the provider page's MAIN world and only observes visible DOM state.
 * Do not add clicks, input events, fetches, or storage reads here: this is the
 * settings-page login indicator, not an authentication flow.
 */
function detectWebSessionPage(providerId: string): WebSessionPageDetectionResult {
  const configs: Record<string, {
    origin: string;
    loggedInSelectors: string[];
    loggedOutSelectors: string[];
    loggedOutMarkers: string[];
  }> = {
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
  const hasVisibleSelector = (selectors: string[]): boolean => selectors.some((selector) =>
    Array.from(document.querySelectorAll(selector)).some(isVisible),
  );
  const bodyText = (document.body?.innerText || "").slice(0, 4_000).toLowerCase();
  const hasLoggedOutMarker = config.loggedOutMarkers.some((marker) => bodyText.includes(marker.toLowerCase()));
  if (hasVisibleSelector(config.loggedOutSelectors)) return { status: "logged-out" };
  if (hasVisibleSelector(config.loggedInSelectors)) return { status: "logged-in" };
  if (hasLoggedOutMarker) return { status: "logged-out" };
  return { status: "unknown" };
}

/**
 * Runs in the target site's MAIN world so fetches and DOM events use the site's
 * existing browser session. Keep this function self-contained: Chrome serializes
 * it before injection and it cannot close over extension-page values.
 */
async function runWebSessionPage(providerId: string, prompt: string): Promise<WebSessionPageResult> {
  const configs: Record<string, {
    origin: string;
    editableSelectors: string[];
    sendSelectors: string[];
    assistantSelectors: string[];
    stopSelectors: string[];
    authText: string[];
  }> = {
    "chatgpt-web": {
      origin: "https://chatgpt.com",
      editableSelectors: ["#prompt-textarea", "textarea#prompt-textarea", "[contenteditable=\"true\"]", "textarea"],
      sendSelectors: ["button[data-testid=\"send-button\"]", "button[aria-label*=\"Send\"]", "button[aria-label*=\"发送\"]"],
      assistantSelectors: ["[data-message-author-role=\"assistant\"]"],
      stopSelectors: ["button[data-testid=\"stop-button\"]"],
      authText: ["log in", "sign up", "登录", "注册"],
    },
    "gemini-web": {
      origin: "https://gemini.google.com",
      editableSelectors: [".ql-editor", "rich-textarea", "textarea", "[contenteditable=\"true\"]"],
      sendSelectors: ["button.send-button", ".send-button", "button[aria-label*=\"Send\"]", "button[aria-label*=\"发送\"]", "button[data-testid*=\"send\"]"],
      assistantSelectors: ["message-content", "model-response", ".response-container"],
      stopSelectors: ["button[aria-label*=\"stop\"]", "button[aria-label*=\"Stop\"]", "button[aria-label*=\"stopp\"]"],
      authText: ["sign in", "log in", "登录", "登入"],
    },
    "deepseek-web": {
      origin: "https://chat.deepseek.com",
      editableSelectors: ["textarea.ds-scroll-area", "textarea#chat-input", "textarea", "[contenteditable=\"true\"]"],
      sendSelectors: ["button[aria-label*=\"Send\"]", "button[aria-label*=\"发送\"]", "button[aria-label*=\"Submit\"]"],
      assistantSelectors: [".ds-markdown", "[class*=\"markdown\"]"],
      stopSelectors: [],
      authText: ["sign in", "log in", "登录", "注册"],
    },
  };
  const config = configs[providerId];
  if (!config || location.origin !== config.origin) return { status: "failed", message: "网页会话页面来源不匹配" };

  const isVisible = (element: Element): boolean => {
    const htmlElement = element as HTMLElement;
    const style = window.getComputedStyle(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const textOf = (element: Element): string => (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || "";
  const findVisible = (selectors: string[]): Element | undefined => {
    for (const selector of selectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (isVisible(element)) return element;
      }
    }
    return undefined;
  };
  const findEditor = (): Element | undefined => {
    const host = findVisible(config.editableSelectors);
    if (!host) return undefined;
    if (host.matches("textarea, input, [contenteditable=\"true\"]")) return host;
    const nested = host.querySelector("textarea, input, [contenteditable=\"true\"]");
    if (nested && isVisible(nested)) return nested;
    const shadowNested = host.shadowRoot?.querySelector("textarea, input, [contenteditable=\"true\"]");
    return shadowNested && isVisible(shadowNested) ? shadowNested : host;
  };
  const assistantTexts = (): string[] => {
    // Prefer the most specific response element. Gemini, for example, nests
    // message-content inside model-response; collecting both makes one answer
    // look like two turns and breaks the before/after count.
    for (const selector of config.assistantSelectors) {
      const values = Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .map(textOf)
        .filter(Boolean);
      if (values.length) return Array.from(new Set(values));
    }
    return [];
  };

  const isStreaming = (): boolean => config.stopSelectors.some((selector) =>
    Array.from(document.querySelectorAll(selector)).some(isVisible),
  );

  const before = assistantTexts();
  let editor = findEditor();
  const editorDeadline = Date.now() + 20_000;
  while (!editor && Date.now() < editorDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    editor = findEditor();
  }
  if (!editor) {
    const pageText = (document.body?.innerText || "").slice(0, 3_000).toLowerCase();
    const looksLoggedOut = config.authText.some((marker) => pageText.includes(marker.toLowerCase()));
    return { status: "auth-required", message: looksLoggedOut ? "页面当前未登录。" : "没有找到可用的输入框，请先登录并等待页面加载完成。" };
  }
  if (isStreaming()) return { status: "failed", message: "页面正在生成上一条回复，请等待完成后重试。" };

  editor.scrollIntoView({ block: "center" });
  (editor as HTMLElement).focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(editor, prompt);
  } else {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, prompt);
    if (textOf(editor) !== prompt) editor.textContent = prompt;
  }
  editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: prompt }));
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));

  let sendButton: Element | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = findVisible(config.sendSelectors);
    const disabled = candidate instanceof HTMLButtonElement
      ? candidate.disabled
      : candidate?.getAttribute("aria-disabled") === "true";
    if (candidate && !disabled) {
      sendButton = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (sendButton) {
    if (sendButton instanceof HTMLElement) sendButton.click();
    else sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } else {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  let latest = "";
  let lastChangedAt = Date.now();
  let sawNewResponse = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = assistantTexts();
    const candidate = current.length > before.length
      ? current[current.length - 1]
      : current.find((value) => !before.includes(value)) || "";
    const streaming = isStreaming();
    if (candidate) {
      sawNewResponse = true;
      if (candidate !== latest) {
        latest = candidate;
        lastChangedAt = Date.now();
      } else if (!streaming && Date.now() - lastChangedAt > 2_500) {
        return { status: "ok", text: latest };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (sawNewResponse && latest) return { status: "ok", text: latest };
  return { status: "failed", message: "页面没有在规定时间内返回可读取的总结" };
}
