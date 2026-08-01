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
  },
  scripting: {
    executeScript: vi.fn(),
  },
}));

vi.mock("wxt/browser", () => ({ browser: browserMock }));

import { WebSessionClient } from "../../src/integrations/web-session/client";

describe("WebSessionClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses an already-open provider tab and lets the page own authentication", async () => {
    const tab = { id: 77, url: "https://chatgpt.com/c/existing", status: "complete", active: true };
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([tab]);
    browserMock.tabs.get.mockResolvedValue(tab);
    browserMock.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: "ok", text: "ChatGPT Web API 总结" } }]);

    const result = await new WebSessionClient().complete("chatgpt-web", "请总结", new AbortController().signal);

    expect(result).toBe("ChatGPT Web API 总结");
    expect(browserMock.tabs.query).toHaveBeenCalledWith({});
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(browserMock.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 77 },
      world: "MAIN",
      args: ["请总结"],
    }));
  });

  it("falls back to the ChatGPT page DOM when its Web API path is unavailable", async () => {
    const tab = { id: 78, url: "https://chatgpt.com/", status: "complete", active: true };
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([tab]);
    browserMock.tabs.get.mockResolvedValue(tab);
    browserMock.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: "failed", message: "安全校验未通过" } }])
      .mockResolvedValueOnce([{ result: { status: "ok", text: "页面 DOM 总结" } }]);

    await expect(new WebSessionClient().complete("chatgpt-web", "请总结", new AbortController().signal)).resolves.toBe("页面 DOM 总结");
    expect(browserMock.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 78 },
      world: "MAIN",
      args: ["chatgpt-web", "请总结"],
    }));
  });

  it("falls back to the Gemini page when the reverse Web RPC is unavailable", async () => {
    const tab = { id: 88, url: "https://gemini.google.com/app", status: "complete", active: true };
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([tab]);
    browserMock.tabs.get.mockResolvedValue(tab);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("protocol drift")));
    browserMock.scripting.executeScript.mockResolvedValue([{ result: { status: "ok", text: "页面兜底总结" } }]);

    await expect(new WebSessionClient().complete("gemini-web", "请总结", new AbortController().signal)).resolves.toBe("页面兜底总结");
    expect(browserMock.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 88 },
      world: "MAIN",
      args: ["gemini-web", "请总结"],
    }));
  });

  it("detects an existing provider page as logged in using read-only DOM execution", async () => {
    const tab = { id: 99, url: "https://gemini.google.com/app", status: "complete", active: true };
    browserMock.permissions.contains.mockResolvedValue(true);
    browserMock.tabs.query.mockResolvedValue([tab]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: { status: "logged-in" } }]);

    await expect(new WebSessionClient().detectLoginStatus("gemini-web")).resolves.toBe("logged-in");
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 99 },
      world: "MAIN",
      args: ["gemini-web"],
    }));
  });

  it("reports missing permission without opening a page or reading credentials", async () => {
    browserMock.permissions.contains.mockResolvedValue(false);

    await expect(new WebSessionClient().detectLoginStatus("chatgpt-web")).resolves.toBe("permission-required");
    expect(browserMock.tabs.query).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});
