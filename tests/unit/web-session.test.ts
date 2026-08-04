import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/domain/errors";
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

  it("passes extracted page text through the selected streaming session adapter", async () => {
    const stream = vi.fn(async function* (_providerId: string, _prompt: string, _signal: AbortSignal) {
      yield { type: "snapshot" as const, text: "session summary" };
      yield { type: "done" as const, externalUrl: "https://chatgpt.com/c/conversation-1" };
    });
    const client = { validateReady: vi.fn(async () => undefined), stream } as unknown as WebSessionClient;
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

    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0]).toBe("chatgpt-web");
    expect(stream.mock.calls[0]?.[1]).toContain("Article body");
    expect(events).toEqual([
      { type: "warning", message: "source warning" },
      { type: "phase", phase: "summarizing", current: 1, total: 1 },
      { type: "snapshot", text: "session summary" },
      { type: "done", externalUrl: "https://chatgpt.com/c/conversation-1" },
    ]);
  });

  it("uploads an extracted file when the page text exceeds the web-session limit", async () => {
    const stream = vi.fn(async function* (_providerId: string, prompt: string, _signal: AbortSignal, file?: File) {
      yield { type: "snapshot" as const, text: "file summary" };
      yield { type: "done" as const, externalUrl: "https://chatgpt.com/c/file-summary" };
      expect(prompt).not.toContain("long-content");
      expect(file?.name).toBe("article.html");
    });
    const client = { validateReady: vi.fn(async () => undefined), stream } as unknown as WebSessionClient;
    const provider = new WebSessionProvider("chatgpt-web", client);
    const events = [];
    for await (const event of provider.summarize({
      document: {
        kind: "webpage",
        title: "Long article",
        sourceUrl: "https://example.com/long",
        sourceText: "long-content ".repeat(10_000),
        uploadFile: new File(["html"], "article.html", { type: "text/html" }),
        warnings: [],
      },
      prompt: "Summarize carefully",
    }, new AbortController().signal)) events.push(event);

    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[3]).toBeInstanceOf(File);
    expect(events.map((event) => event.type)).toEqual(["warning", "phase", "phase", "snapshot", "done"]);
    expect(events.find((event) => event.type === "phase" && event.phase === "uploading")).toBeTruthy();
  });

  it("falls back to truncated text when a long-file upload is rejected", async () => {
    const stream = vi.fn(async function* (_providerId: string, prompt: string, _signal: AbortSignal, file?: File) {
      if (file) throw new AppError("upload-failed", "upload unavailable", { retryable: true });
      expect(prompt).toContain("long-content");
      yield { type: "snapshot" as const, text: "fallback summary" };
      yield { type: "done" as const };
    });
    const client = { validateReady: vi.fn(async () => undefined), stream } as unknown as WebSessionClient;
    const provider = new WebSessionProvider("deepseek-web", client);
    const events = [];
    for await (const event of provider.summarize({
      document: {
        kind: "webpage",
        title: "Long article",
        sourceUrl: "https://example.com/long",
        sourceText: "long-content ".repeat(10_000),
        uploadFile: new File(["html"], "article.html", { type: "text/html" }),
        warnings: [],
      },
      prompt: "Summarize carefully",
    }, new AbortController().signal)) events.push(event);

    expect(stream).toHaveBeenCalledTimes(2);
    expect(events.at(-2)).toMatchObject({ type: "snapshot", text: "fallback summary" });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("lets Gemini handle YouTube URLs directly instead of requiring extracted subtitles", async () => {
    const stream = vi.fn(async function* (_providerId: string, _prompt: string, _signal: AbortSignal) {
      yield { type: "snapshot" as const, text: "gemini video summary" };
      yield { type: "done" as const, externalUrl: "https://gemini.google.com/app/conversation-1" };
    });
    const client = { validateReady: vi.fn(async () => undefined), stream } as unknown as WebSessionClient;
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

    expect(stream.mock.calls[0]?.[1]).toContain("https://www.youtube.com/watch?v=video-id");
    expect(stream.mock.calls[0]?.[1]).not.toContain("扩展字幕提取失败");
    expect(events).toEqual([
      { type: "warning", message: "Gemini Web 将直接读取 YouTube 链接，不依赖扩展字幕提取" },
      { type: "phase", phase: "summarizing", current: 1, total: 1 },
      { type: "snapshot", text: "gemini video summary" },
      { type: "done", externalUrl: "https://gemini.google.com/app/conversation-1" },
    ]);
  });
});
