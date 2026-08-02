import { describe, expect, it } from "vitest";
import { createExtractorRegistry, selectExtractor } from "../../src/extractors/registry";
import { BilibiliExtractor } from "../../src/extractors/bilibili";
import { FeedlyExtractor } from "../../src/extractors/feedly";
import { PdfExtractor } from "../../src/extractors/pdf";
import { WebpageExtractor } from "../../src/extractors/webpage";
import { YoutubeExtractor } from "../../src/extractors/youtube";

describe("extractor registry contract", () => {
  it("registers unique site identities with explicit output kinds", () => {
    const extractors = createExtractorRegistry();

    expect(new Set(extractors.map((extractor) => extractor.descriptor.id)).size).toBe(extractors.length);
    expect(extractors.map((extractor) => extractor.descriptor)).toEqual([
      { id: "pdf", label: "PDF", outputKind: "pdf" },
      { id: "youtube", label: "YouTube", outputKind: "youtube" },
      { id: "bilibili", label: "Bilibili", outputKind: "bilibili" },
      { id: "feedly", label: "Feedly", outputKind: "webpage" },
      { id: "webpage", label: "普通网页", outputKind: "webpage" },
    ]);
  });

  it("keeps specialized extractors ahead of the generic webpage fallback", () => {
    const extractors = createExtractorRegistry();

    expect(selectExtractor(extractors, { tabId: 1, url: "https://arxiv.org/pdf/1234.5678" })).toBeInstanceOf(PdfExtractor);
    expect(selectExtractor(extractors, { tabId: 1, url: "https://www.youtube.com/watch?v=demo" })).toBeInstanceOf(YoutubeExtractor);
    expect(selectExtractor(extractors, { tabId: 1, url: "https://www.bilibili.com/video/BV1Test" })).toBeInstanceOf(BilibiliExtractor);
    expect(selectExtractor(extractors, { tabId: 1, url: "https://feedly.com/i/my/me?s=entry:G%2Fexample" })).toBeInstanceOf(FeedlyExtractor);
    expect(selectExtractor(extractors, { tabId: 1, url: "https://example.com/article" })).toBeInstanceOf(WebpageExtractor);
  });

  it("does not route lookalike hosts to a specialized site extractor", () => {
    const extractors = createExtractorRegistry();

    expect(selectExtractor(extractors, { tabId: 1, url: "https://youtube.com.evil.example/watch?v=demo" })).toBeInstanceOf(WebpageExtractor);
    expect(selectExtractor(extractors, { tabId: 1, url: "https://www.bilibili.com.evil.example/video/BV1Test" })).toBeInstanceOf(WebpageExtractor);
    expect(selectExtractor(extractors, { tabId: 1, url: "https://example.com/i/my/me?s=entry:G%2Fexample" })).toBeInstanceOf(WebpageExtractor);
  });
});
