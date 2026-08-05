import { describe, expect, it } from "vitest";
import { createExtractorRegistry, selectExtractor } from "../../src/extractors/registry";
import { BilibiliExtractor } from "../../src/extractors/bilibili";
import { DiscourseExtractor } from "../../src/extractors/discourse";
import { FeedlyExtractor } from "../../src/extractors/feedly";
import { PdfExtractor } from "../../src/extractors/pdf";
import { WebpageExtractor } from "../../src/extractors/webpage";
import { YoutubeExtractor } from "../../src/extractors/youtube";
import { ZhihuExtractor } from "../../src/extractors/zhihu";
import { TwitterExtractor } from "../../src/extractors/twitter";

describe("extractor registry contract", () => {
  it("registers unique site identities with explicit output kinds", () => {
    const extractors = createExtractorRegistry();

    expect(new Set(extractors.map((extractor) => extractor.descriptor.id)).size).toBe(extractors.length);
    expect(extractors.map((extractor) => extractor.descriptor)).toEqual([
      { id: "pdf", label: "PDF", outputKind: "pdf" },
      { id: "youtube", label: "YouTube", outputKind: "youtube" },
      { id: "bilibili", label: "Bilibili", outputKind: "bilibili" },
      { id: "feedly", label: "Feedly", outputKind: "webpage" },
      { id: "discourse", label: "Discourse 论坛", outputKind: "webpage" },
      { id: "zhihu", label: "知乎", outputKind: "webpage" },
      { id: "twitter", label: "X / Twitter", outputKind: "webpage" },
      { id: "webpage", label: "普通网页", outputKind: "webpage" },
    ]);
  });

  it("keeps specialized extractors ahead of the generic webpage fallback", async () => {
    const extractors = createExtractorRegistry();

    expect(await selectExtractor(extractors, { tabId: 1, url: "https://arxiv.org/pdf/1234.5678" })).toBeInstanceOf(PdfExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://www.youtube.com/watch?v=demo" })).toBeInstanceOf(YoutubeExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://www.bilibili.com/video/BV1Test" })).toBeInstanceOf(BilibiliExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://feedly.com/i/my/me?s=entry:G%2Fexample" })).toBeInstanceOf(FeedlyExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://example.com/article" })).toBeInstanceOf(WebpageExtractor);
  });

  it("routes exact Zhihu URLs and keeps lookalike hosts generic", async () => {
    const extractors = createExtractorRegistry();

    expect(await selectExtractor(extractors, { tabId: 1, url: "https://www.zhihu.com/question/123" })).toBeInstanceOf(ZhihuExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://x.com/home" })).toBeInstanceOf(TwitterExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://x.com/alice/status/123" })).toBeInstanceOf(TwitterExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://youtube.com.evil.example/watch?v=demo" })).toBeInstanceOf(WebpageExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://www.bilibili.com.evil.example/video/BV1Test" })).toBeInstanceOf(WebpageExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://example.com/i/my/me?s=entry:G%2Fexample" })).toBeInstanceOf(WebpageExtractor);
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://x.com.evil.example/home" })).toBeInstanceOf(WebpageExtractor);
  });

  it("requires a successful runtime Discourse probe before routing a generic /t/ URL", async () => {
    const discourse = new DiscourseExtractor();
    const fallback = new WebpageExtractor();
    const extractors = [discourse, fallback];
    expect(await selectExtractor(extractors, { tabId: 1, url: "https://example.com/t/demo/123" })).toBe(fallback);
  });
});
