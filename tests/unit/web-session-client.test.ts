import { afterEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  permissions: {
    contains: vi.fn(),
    request: vi.fn(),
  },
  tabs: {
    query: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
  runtime: {
    connect: vi.fn(),
  },
}));

vi.mock("wxt/browser", () => ({ browser: browserMock }));

import { readWebSessionCredential, WebSessionClient } from "../../src/integrations/web-session/client";
import type { SettingsRepository } from "../../src/platform/chrome/storage";

function makeStorage(overrides: Partial<SettingsRepository> = {}): SettingsRepository {
  return {
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    getOpenAISecret: vi.fn(),
    saveOpenAISecret: vi.fn(),
    clearOpenAISecret: vi.fn(),
    getKimiTokens: vi.fn(),
    saveKimiTokens: vi.fn(),
    clearKimiTokens: vi.fn(),
    getWebSessionCredential: vi.fn(async () => ({ providerId: "chatgpt-web" as const, accessToken: "saved-token", capturedAt: Date.now() })),
    saveWebSessionCredential: vi.fn(),
    clearWebSessionCredential: vi.fn(),
    getGeminiDiagnosticReports: vi.fn(async () => []),
    saveGeminiDiagnosticReport: vi.fn(),
    clearGeminiDiagnosticReports: vi.fn(),
    ...overrides,
  };
}

describe("WebSessionClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads Gemini credentials from the live page context before requesting /app", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", {
      origin: "https://gemini.google.com",
      pathname: "/u/2/app",
      href: "https://gemini.google.com/u/2/app",
    });
    vi.stubGlobal("window", {
      WIZ_global_data: {
        requestContext: {
          SNlM0e: "page-at",
          cfb2h: "page-bl",
          FdrFJe: "page-sid",
        },
      },
    });
    vi.stubGlobal("document", {
      documentElement: { outerHTML: "<html data-index='2'></html>" },
      scripts: [],
      querySelector: vi.fn(() => null),
    });

    await expect(readWebSessionCredential("gemini-web")).resolves.toMatchObject({
      status: "ok",
      credential: { providerId: "gemini-web", authUser: "2", capturedAt: expect.any(Number) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts compatible Gemini page-field encodings", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", {
      origin: "https://gemini.google.com",
      pathname: "/app",
      href: "https://gemini.google.com/app",
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      documentElement: {
        outerHTML: "<script>{'SNlM0e':'page-at', cfb2h:\"page-bl\", [\"FdrFJe\", \"page-sid\"]}</script>",
      },
      scripts: [],
      querySelector: vi.fn(() => null),
    });

    await expect(readWebSessionCredential("gemini-web")).resolves.toMatchObject({
      status: "ok",
      credential: { providerId: "gemini-web", authUser: "0" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a hydrated Gemini composer as a page-login fallback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", {
      origin: "https://gemini.google.com",
      pathname: "/app",
      href: "https://gemini.google.com/app",
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      documentElement: { outerHTML: "" },
      scripts: [],
      querySelector: vi.fn((selector: string) => selector.includes("rich-textarea") ? {} : null),
    });

    await expect(readWebSessionCredential("gemini-web")).resolves.toMatchObject({
      status: "ok",
      credential: { providerId: "gemini-web", authUser: "0" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to a compatible /app response when the current page is not hydrated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://gemini.google.com/app",
      text: async () => "<script>\"thykhd\":\"fetched-at\", cfb2h:'fetched-bl', [\"FdrFJe\", \"fetched-sid\"]</script>",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", {
      origin: "https://gemini.google.com",
      pathname: "/app",
      href: "https://gemini.google.com/app",
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      documentElement: { outerHTML: "" },
      scripts: [],
      querySelector: vi.fn(() => null),
    });

    await expect(readWebSessionCredential("gemini-web")).resolves.toMatchObject({
      status: "ok",
      credential: { providerId: "gemini-web", authUser: "0" },
    });
    expect(fetchMock).toHaveBeenCalledWith("/app", { credentials: "include", headers: { Accept: "text/html" } });
  });

  it("does not turn a same-origin protocol-shape change into logged-out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://gemini.google.com/app",
      text: async () => "<html><body>Gemini</body></html>",
    }));
    vi.stubGlobal("location", {
      origin: "https://gemini.google.com",
      pathname: "/app",
      href: "https://gemini.google.com/app",
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      documentElement: { outerHTML: "" },
      scripts: [],
      querySelector: vi.fn(() => null),
    });

    await expect(readWebSessionCredential("gemini-web")).resolves.toMatchObject({
      status: "failed",
      message: "Gemini 页面未提供可识别的登录上下文，页面协议可能已变化",
    });
  });

  it("requires a saved credential before opening a background stream", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    const storage = makeStorage({ getWebSessionCredential: vi.fn(async () => null) });
    const client = new WebSessionClient(storage);

    const iterator = client.stream("chatgpt-web", "请总结", new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next())
      .rejects.toMatchObject({ code: "auth-required" });
    expect(browserMock.runtime.connect).not.toHaveBeenCalled();
  });

  it("replaces streamed snapshots and returns the provider continuation URL", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    const listeners: Array<(message: unknown) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const port = {
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
      postMessage: vi.fn((message: { type: string; requestId?: string }) => {
        if (message.type !== "start" || !message.requestId) return;
        listeners.forEach((listener) => listener({ type: "snapshot", requestId: message.requestId, text: "# 标题" }));
        listeners.forEach((listener) => listener({ type: "snapshot", requestId: message.requestId, text: "# 标题\n\n正文" }));
        listeners.forEach((listener) => listener({ type: "done", requestId: message.requestId, externalUrl: "https://chatgpt.com/c/conversation-1" }));
      }),
      disconnect: vi.fn(),
    };
    browserMock.runtime.connect.mockReturnValue(port);
    const events = [];
    for await (const event of new WebSessionClient(makeStorage()).stream("chatgpt-web", "请总结", new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "snapshot", text: "# 标题" },
      { type: "snapshot", text: "# 标题\n\n正文" },
      { type: "done", externalUrl: "https://chatgpt.com/c/conversation-1" },
    ]);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(disconnectListeners).toHaveLength(1);
  });

  it("serializes a long-document file into the background stream request", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    const listeners: Array<(message: unknown) => void> = [];
    const port = {
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn((message: { type: string; requestId?: string; file?: { name: string; type: string; size: number }; data?: string }) => {
        if (message.type === "start" && message.requestId) {
          expect(message.file).toMatchObject({ name: "article.md", type: "text/markdown", size: 5 });
          return;
        }
        if (message.type !== "file-chunk" || !message.requestId) return;
        expect(message.data).toBe("aGVsbG8=");
        listeners.forEach((listener) => listener({ type: "done", requestId: message.requestId }));
      }),
      disconnect: vi.fn(),
    };
    browserMock.runtime.connect.mockReturnValue(port);

    const file = new File(["hello"], "article.md", { type: "text/markdown" });
    const events = [];
    for await (const event of new WebSessionClient(makeStorage()).stream("chatgpt-web", "请总结附件", new AbortController().signal, file)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "done" }]);
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("runs the provider session test through the test port and returns its conversation URL", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    const listeners: Array<(message: unknown) => void> = [];
    const port = {
      onMessage: {
        addListener: (listener: (message: unknown) => void) => listeners.push(listener),
        removeListener: (listener: (message: unknown) => void) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
      onDisconnect: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      postMessage: vi.fn((message: { type: string; requestId?: string }) => {
        if (message.type === "test" && message.requestId) {
          listeners.forEach((listener) => listener({ type: "done", requestId: message.requestId, message: "ChatGPT session ok", externalUrl: "https://chatgpt.com/c/test" }));
        }
      }),
      disconnect: vi.fn(),
    };
    browserMock.runtime.connect.mockReturnValue(port);

    await expect(new WebSessionClient(makeStorage()).testConnection("chatgpt-web"))
      .resolves.toEqual({ ok: true, message: "ChatGPT session ok", externalUrl: "https://chatgpt.com/c/test" });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "test", providerId: "chatgpt-web" }));
    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("captures a page credential before sending a session test when storage is empty", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([
      { id: 78, url: "https://chatgpt.com/", active: true },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: {
      status: "ok",
      credential: { providerId: "chatgpt-web", accessToken: "captured-for-test", capturedAt: 3 },
    } }]);
    const listeners: Array<(message: unknown) => void> = [];
    const port = {
      onMessage: {
        addListener: (listener: (message: unknown) => void) => listeners.push(listener),
        removeListener: (listener: (message: unknown) => void) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
      onDisconnect: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      postMessage: vi.fn((message: { type: string; requestId?: string }) => {
        if (message.type === "test" && message.requestId) {
          listeners.forEach((listener) => listener({ type: "done", requestId: message.requestId, message: "ChatGPT session ok" }));
        }
      }),
      disconnect: vi.fn(),
    };
    browserMock.runtime.connect.mockReturnValue(port);
    const storage = makeStorage({ getWebSessionCredential: vi.fn(async () => null) });

    await expect(new WebSessionClient(storage).testConnection("chatgpt-web"))
      .resolves.toEqual({ ok: true, message: "ChatGPT session ok" });
    expect(storage.saveWebSessionCredential).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "captured-for-test" }));
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "test", providerId: "chatgpt-web" }));
  });

  it("opens a new login tab, captures the page credential, saves it, and closes only that tab", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([]);
    browserMock.tabs.create.mockResolvedValue({ id: 77, url: "https://chatgpt.com/", status: "complete" });
    browserMock.tabs.get.mockResolvedValue({ id: 77, url: "https://chatgpt.com/", status: "complete" });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: {
      status: "ok",
      credential: { providerId: "chatgpt-web", accessToken: "new-token", capturedAt: 1 },
    } }]);
    const storage = makeStorage();

    await new WebSessionClient(storage).openLogin("chatgpt-web");

    expect(storage.saveWebSessionCredential).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "new-token" }));
    expect(browserMock.tabs.remove).toHaveBeenCalledWith(77);
  });

  it("recreates the login tab when the previously found tab disappears", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([
      { id: 199144277, url: "https://gemini.google.com/app", active: true },
    ]);
    browserMock.tabs.update.mockRejectedValueOnce(new Error("No tab with id: 199144277."));
    browserMock.tabs.create.mockResolvedValue({ id: 199144278, url: "https://gemini.google.com/app", status: "complete" });
    browserMock.tabs.get.mockResolvedValue({ id: 199144278, url: "https://gemini.google.com/app", status: "complete" });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: {
      status: "ok",
      credential: { providerId: "gemini-web", authUser: "0", capturedAt: 1 },
    } }]);

    await new WebSessionClient(makeStorage()).openLogin("gemini-web");

    expect(browserMock.tabs.create).toHaveBeenCalledWith({ url: "https://gemini.google.com/", active: true });
    expect(browserMock.tabs.remove).toHaveBeenCalledWith(199144278);
  });

  it("turns a closed login tab into a retryable login error", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([]);
    browserMock.tabs.create.mockResolvedValue({ id: 199144277, url: "https://gemini.google.com/", status: "loading" });
    browserMock.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 199144277"));
    browserMock.tabs.remove.mockResolvedValue(undefined);

    await expect(new WebSessionClient(makeStorage()).openLogin("gemini-web"))
      .rejects.toMatchObject({
        code: "auth-required",
        retryable: true,
        message: "Gemini Web 登录页已关闭，请重新点击登录并保持页面打开",
      });
    expect(browserMock.tabs.remove).toHaveBeenCalledWith(199144277);
  });

  it("ignores lookalike provider tabs outside the exact origin", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([
      { id: 91, url: "https://chatgpt.com.evil.example/", active: true },
    ]);
    const status = await new WebSessionClient(makeStorage({ getWebSessionCredential: vi.fn(async () => null) }))
      .detectLoginStatus("chatgpt-web");
    expect(status).toBe("no-page");
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("does not call a saved credential logged-in until a page is available for verification", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([]);
    const status = await new WebSessionClient(makeStorage()).detectLoginStatus("chatgpt-web");
    expect(status).toBe("saved-unverified");
  });

  it("captures a page login during status detection so the status matches the session test", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([
      { id: 92, url: "https://chatgpt.com/", active: true },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: {
      status: "ok",
      credential: { providerId: "chatgpt-web", accessToken: "page-token", capturedAt: 2 },
    } }]);
    const storage = makeStorage({ getWebSessionCredential: vi.fn(async () => null) });

    await expect(new WebSessionClient(storage).detectLoginStatus("chatgpt-web"))
      .resolves.toBe("logged-in");
    expect(storage.saveWebSessionCredential).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "page-token" }));
  });

  it("distinguishes a visible page login from an extension credential when capture is unavailable", async () => {
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([
      { id: 93, url: "https://chatgpt.com/", active: true },
    ]);
    browserMock.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: "logged-out" } }])
      .mockResolvedValueOnce([{ result: { status: "logged-in" } }]);
    const storage = makeStorage({ getWebSessionCredential: vi.fn(async () => null) });

    await expect(new WebSessionClient(storage).detectLoginStatus("chatgpt-web"))
      .resolves.toBe("page-logged-in");
    expect(storage.saveWebSessionCredential).not.toHaveBeenCalled();
  });

  it("does not open a login tab after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new WebSessionClient(makeStorage()).openLogin("chatgpt-web", 120_000, controller.signal))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });
});
