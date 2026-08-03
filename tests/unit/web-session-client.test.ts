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

import { WebSessionClient } from "../../src/integrations/web-session/client";
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
    ...overrides,
  };
}

describe("WebSessionClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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
