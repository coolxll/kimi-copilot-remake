import { describe, expect, it, vi } from "vitest";
import { isProviderId, isWebSessionProvider, PROVIDER_LABELS } from "../../src/domain/types";
import { WebSessionProvider } from "../../src/integrations/web-session/provider";
import { WEB_SESSION_PROVIDER_IDS, getWebSessionSpec } from "../../src/integrations/web-session/specs";
import type { WebSessionClient } from "../../src/integrations/web-session/client";

describe("web session providers", () => {
  it("registers the three browser-session services without treating them as API tokens", () => {
    expect(WEB_SESSION_PROVIDER_IDS).toEqual(["chatgpt-web", "gemini-web", "deepseek-web"]);
    for (const providerId of WEB_SESSION_PROVIDER_IDS) {
      expect(isWebSessionProvider(providerId)).toBe(true);
      expect(isProviderId(providerId)).toBe(true);
      expect(getWebSessionSpec(providerId).origin).toMatch(/^https:\/\//);
      expect(PROVIDER_LABELS[providerId]).toContain("Web");
    }
    expect(isProviderId("not-a-provider")).toBe(false);
  });

  it("passes extracted page text through the selected session adapter", async () => {
    const complete = vi.fn(async (_providerId: string, _prompt: string, _signal: AbortSignal) => "session summary");
    const client = { validateReady: vi.fn(async () => undefined), complete } as unknown as WebSessionClient;
    const provider = new WebSessionProvider("chatgpt-web", client);
    const events = [];
    for await (const event of provider.summarize({
      document: {
        kind: "webpage",
        title: "Example",
        sourceUrl: "https://example.com/article",
        sourceText: "Article body",
        warnings: ["source warning"],
      },
      prompt: "Summarize carefully",
    }, new AbortController().signal)) events.push(event);

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toBe("chatgpt-web");
    expect(complete.mock.calls[0]?.[1]).toContain("Article body");
    expect(events).toEqual([
      { type: "warning", message: "source warning" },
      { type: "phase", phase: "summarizing", current: 1, total: 1 },
      { type: "delta", text: "session summary" },
      { type: "done" },
    ]);
  });

  it("lets Gemini handle YouTube URLs directly instead of requiring extracted subtitles", async () => {
    const complete = vi.fn(async (_providerId: string, _prompt: string, _signal: AbortSignal) => "gemini video summary");
    const client = { validateReady: vi.fn(async () => undefined), complete } as unknown as WebSessionClient;
    const provider = new WebSessionProvider("gemini-web", client);
    const events = [];
    for await (const event of provider.summarize({
      document: {
        kind: "youtube",
        title: "Video title",
        sourceUrl: "https://www.youtube.com/watch?v=video-id",
        sourceText: "扩展字幕提取失败，不应被发送给 Gemini",
        warnings: [],
      },
      prompt: "请写详细笔记",
    }, new AbortController().signal)) events.push(event);

    expect(complete.mock.calls[0]?.[1]).toContain("https://www.youtube.com/watch?v=video-id");
    expect(complete.mock.calls[0]?.[1]).not.toContain("扩展字幕提取失败");
    expect(events).toEqual([
      { type: "warning", message: "Gemini Web 将直接读取 YouTube 链接，不依赖扩展字幕提取" },
      { type: "phase", phase: "summarizing", current: 1, total: 1 },
      { type: "delta", text: "gemini video summary" },
      { type: "done" },
    ]);
  });
});
