import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseFeedlyCandidate, chooseFeedlySource, compareFeedlyCandidates, FeedlyExtractor, isFeedlyArticleUrl, type FeedlyFrameSnapshot } from "../../src/extractors/feedly";
import { createExtractorRegistry, selectExtractor } from "../../src/extractors/registry";
import { fetchFeedlyEntry, parseFeedlyEntryId } from "../../src/platform/chrome/feedly";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function frame(candidate: Partial<NonNullable<FeedlyFrameSnapshot["candidate"]>>): FeedlyFrameSnapshot {
  return {
    frameUrl: "https://feedly.com/i/my/me?s=entry:test",
    pageTitle: "Feedly",
    candidate: {
      frameUrl: "https://feedly.com/i/my/me?s=entry:test",
      pageTitle: "Feedly",
      title: "",
      html: "<article></article>",
      text: "正文",
      score: 0,
      feedlyFrame: true,
      ...candidate,
    },
  };
}

describe("Feedly article URL detection", () => {
  it("recognizes the entry URL opened in the Feedly reader", () => {
    expect(isFeedlyArticleUrl("https://feedly.com/i/my/me?s=entry:G%2Fexample")).toBe(true);
    expect(isFeedlyArticleUrl("https://feedly.com/i/my/me")).toBe(false);
    expect(isFeedlyArticleUrl("https://example.com/i/my/me?s=entry:G%2Fexample")).toBe(false);
  });

  it("extracts the encoded entry ID for the Feedly API fallback", () => {
    expect(parseFeedlyEntryId("https://feedly.com/i/my/me?s=entry:G%2FGX%2Fk%3D_demo:part")).toBe("G/GX/k=_demo:part");
  });

  it("routes Feedly entry pages to the dedicated extractor", () => {
    const extractor = selectExtractor(createExtractorRegistry(), {
      tabId: 1,
      url: "https://feedly.com/i/my/me?s=entry:G%2Fexample",
    });
    expect(extractor).toBeInstanceOf(FeedlyExtractor);
  });
});

describe("Feedly article candidate selection", () => {
  it("prefers the article body over the reader shell", () => {
    const result = chooseFeedlyCandidate([
      frame({ title: "文章标题", text: "导航\n收藏\n标记为已读\n推荐列表", score: 180 }),
      frame({ title: "文章标题", text: "这是文章正文。".repeat(80), score: 210 }),
    ]);
    expect(result?.title).toBe("文章标题");
    expect(result?.text).toContain("这是文章正文");
  });

  it("keeps a short article candidate when no longer candidate exists", () => {
    const result = chooseFeedlyCandidate([frame({ title: "短文章", text: "这是一个很短但仍然需要读取的文章正文。" })]);
    expect(result?.title).toBe("短文章");
  });

  it("uses text length as the final tie breaker", () => {
    const short = frame({ text: "短正文", score: 100 }).candidate!;
    const long = frame({ text: "长正文".repeat(20), score: 100 }).candidate!;
    expect(compareFeedlyCandidates(short, long)).toBeGreaterThan(0);
  });

  it("prefers the Feedly API article only when it contains more text", () => {
    const dom = frame({ text: "页面正文".repeat(20) }).candidate!;
    const api = frame({ title: "API 标题", text: "API 正文".repeat(40) }).candidate!;
    expect(chooseFeedlySource(dom, api)).toBe(api);
    expect(chooseFeedlySource(dom, frame({ text: "更短 API" }).candidate!)).toBe(dom);
  });
});

describe("Feedly entry API fallback", () => {
  it("reads content first and falls back to summary content", async () => {
    const calls: Array<{ url: string; credentials?: RequestCredentials }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), credentials: init?.credentials });
      return new Response(JSON.stringify({ title: "Feedly 标题", summary: { content: "<p>摘要正文</p>" } }), { status: 200 });
    }));

    const result = await fetchFeedlyEntry("G/GX/k=_demo:part", new AbortController().signal);
    expect(result).toEqual({ title: "Feedly 标题", html: "<p>摘要正文</p>" });
    expect(calls[0]).toMatchObject({
      url: "https://cloud.feedly.com/v3/entries/G%2FGX%2Fk%3D_demo%3Apart",
      credentials: "include",
    });
  });
});
