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
});
