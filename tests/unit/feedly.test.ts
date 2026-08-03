import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseFeedlyCandidate,
  chooseFeedlySnapshot,
  chooseFeedlySource,
  compareFeedlyCandidates,
  FeedlyExtractor,
  formatFeedlyList,
  isFeedlyCandidateForEntry,
  isFeedlyArticleUrl,
  type FeedlyFrameSnapshot,
  type FeedlyListItemSnapshot,
} from "../../src/extractors/feedly";
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

function listItem(overrides: Partial<FeedlyListItemSnapshot> = {}): FeedlyListItemSnapshot {
  return {
    frameUrl: "https://feedly.com/i/my/me",
    pageTitle: "Feedly",
    title: "",
    html: "<p></p>",
    text: "",
    score: 0,
    feedlyFrame: true,
    order: 0,
    ...overrides,
  };
}

describe("Feedly article URL detection", () => {
  it("recognizes the entry URL opened in the Feedly reader", () => {
    expect(isFeedlyArticleUrl("https://feedly.com/i/my/me?s=entry:G%2Fexample")).toBe(true);
    expect(isFeedlyArticleUrl("https://feedly.com/i/my/me")).toBe(true);
    expect(isFeedlyArticleUrl("https://example.com/i/my/me?s=entry:G%2Fexample")).toBe(false);
  });

  it("extracts the encoded entry ID for the Feedly API fallback", () => {
    expect(parseFeedlyEntryId("https://feedly.com/i/my/me?s=entry:G%2FGX%2Fk%3D_demo:part")).toBe("G/GX/k=_demo:part");
  });

  it("routes Feedly entry pages to the dedicated extractor", async () => {
    const extractor = await selectExtractor(createExtractorRegistry(), {
      tabId: 1,
      url: "https://feedly.com/i/my/me?s=entry:G%2Fexample",
    });
    expect(extractor).toBeInstanceOf(FeedlyExtractor);
    expect(await selectExtractor(createExtractorRegistry(), {
      tabId: 1,
      url: "https://feedly.com/i/my/me",
    })).toBeInstanceOf(FeedlyExtractor);
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

  it("requires the rendered article to match the current entry before preferring DOM", () => {
    const dom = frame({ entryId: "entry-wrong", text: "页面正文".repeat(20) }).candidate!;
    const api = frame({ entryId: "entry-current", title: "API 标题", text: "API 正文".repeat(40) }).candidate!;
    expect(chooseFeedlySource(dom, api, "entry-current")).toBe(api);
    expect(isFeedlyCandidateForEntry(dom, "entry-current")).toBe(false);
    expect(chooseFeedlySource({ ...dom, entryId: "entry-current" }, api, "entry-current")).not.toBe(api);
    expect(chooseFeedlySource(undefined, api, "entry-current")).toBe(api);
  });

  it("keeps list mode separate from an opened article", () => {
    const list = [
      listItem({ order: 0, entryId: "entry-1", title: "第一篇", text: "第一篇摘要" }),
      listItem({ order: 1, entryId: "entry-2", title: "第二篇", text: "第二篇摘要" }),
    ];
    const snapshot = chooseFeedlySnapshot([
      { frameUrl: "https://feedly.com/i/my/me", pageTitle: "Feedly", listItems: list },
    ]);
    expect(snapshot?.articleCandidate).toBeUndefined();
    expect(snapshot?.listItems.map((item) => item.title)).toEqual(["第一篇", "第二篇"]);

    const opened = frame({ title: "已打开正文", text: "正文".repeat(80) });
    const articleSnapshot = chooseFeedlySnapshot([{ ...opened, articleCandidate: opened.candidate, listItems: list }]);
    expect(articleSnapshot?.articleCandidate?.title).toBe("已打开正文");

    const exact = frame({ entryId: "entry-current", title: "当前正文", text: "当前正文".repeat(20), score: 1 }).candidate!;
    const unrelated = frame({ entryId: "entry-other", title: "推荐正文", text: "推荐正文".repeat(80), score: 500 }).candidate!;
    expect(chooseFeedlyCandidate([
      { frameUrl: exact.frameUrl, pageTitle: exact.pageTitle, articleCandidate: exact },
      { frameUrl: unrelated.frameUrl, pageTitle: unrelated.pageTitle, articleCandidate: unrelated },
    ], "entry-current")).toBe(exact);
    expect(chooseFeedlySnapshot([
      { frameUrl: exact.frameUrl, pageTitle: exact.pageTitle, articleCandidate: exact },
      { frameUrl: unrelated.frameUrl, pageTitle: unrelated.pageTitle, articleCandidate: unrelated },
    ], "entry-current")?.articleCandidate).toBe(exact);
  });

  it("formats every list item in DOM order", () => {
    vi.stubGlobal("DOMParser", class {
      parseFromString() {
        return { querySelectorAll: () => [], body: { innerHTML: "" } };
      }
    });
    const result = formatFeedlyList("稍后阅读", [
      listItem({ order: 0, title: "第一篇", html: "", text: "第一篇正文" }),
      listItem({ order: 1, title: "第二篇", html: "", text: "第二篇正文" }),
    ]);
    expect(result.markdown).toContain("## 1. 第一篇");
    expect(result.markdown).toContain("第一篇正文");
    expect(result.markdown.indexOf("第一篇")).toBeLessThan(result.markdown.indexOf("第二篇"));
    expect(result.html).toContain("data-feedly-list=\"true\"");
    expect(result.html).toContain("第二篇正文");
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
