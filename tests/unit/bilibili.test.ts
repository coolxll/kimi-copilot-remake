import { describe, expect, it } from "vitest";
import {
  chooseBilibiliSubtitleTrack,
  isLikelyMismatchedBilibiliSubtitle,
  parseBilibiliVideoUrl,
  selectBilibiliPage,
} from "../../src/extractors/bilibili";

describe("Bilibili URL and page selection", () => {
  it("preserves the BV id and optional page number", () => {
    expect(parseBilibiliVideoUrl("https://www.bilibili.com/video/BV1LpNd6YEta/?spm_id_from=foo&p=2")).toEqual({
      bvid: "BV1LpNd6YEta",
      aid: undefined,
      pageNumber: 2,
    });
  });

  it("accepts the legacy av URL", () => {
    expect(parseBilibiliVideoUrl("https://www.bilibili.com/video/av123456/?p=1")).toEqual({
      bvid: undefined,
      aid: "123456",
      pageNumber: 1,
    });
  });

  it("uses the explicit p page, then the page CID from the player state", () => {
    const pages = [
      { page: 1, cid: 101, part: "第一集" },
      { page: 2, cid: 202, part: "第二集" },
    ];
    expect(selectBilibiliPage(pages, 2, 101, 101)?.cid).toBe(202);
    expect(selectBilibiliPage(pages, undefined, 202, 101)?.cid).toBe(202);
    expect(selectBilibiliPage(pages, undefined, undefined, 101)?.cid).toBe(101);
  });
});

describe("Bilibili subtitle track selection", () => {
  it("prefers human Chinese over AI or unrelated languages", () => {
    const humanChinese = { lan: "zh-CN", lan_doc: "中文（简体）", subtitle_url: "//manual" };
    expect(chooseBilibiliSubtitleTrack([
      { lan: "en", subtitle_url: "//english" },
      { lan: "ai-zh", lan_doc: "中文", ai_type: 1, subtitle_url: "//ai" },
      humanChinese,
    ])).toEqual(humanChinese);
  });

  it("recognizes ai-zh as AI even when ai_type is zero", () => {
    const humanChinese = { lan: "zh-CN", lan_doc: "中文（简体）", subtitle_url: "//manual" };
    expect(chooseBilibiliSubtitleTrack([
      { lan: "ai-zh", lan_doc: "中文", ai_type: 0, subtitle_url: "//ai" },
      humanChinese,
    ])).toEqual(humanChinese);
  });

  it("ignores placeholder tracks without a downloadable URL", () => {
    const downloadableChinese = { lan: "ai-zh", lan_doc: "中文", ai_type: 0, subtitle_url: "//ai" };
    expect(chooseBilibiliSubtitleTrack([
      { lan: "ai-zh", lan_doc: "中文", ai_type: 0, subtitle_url: "" },
      { lan: "ai-en", lan_doc: "English", ai_type: 1 },
      downloadableChinese,
    ])).toEqual(downloadableChinese);
  });

  it("rejects a subtitle timeline that is much shorter than a long video", () => {
    expect(isLikelyMismatchedBilibiliSubtitle(1283, 182)).toBe(true);
    expect(isLikelyMismatchedBilibiliSubtitle(1283, 756.64)).toBe(true);
    expect(isLikelyMismatchedBilibiliSubtitle(1283, 1180)).toBe(false);
    expect(isLikelyMismatchedBilibiliSubtitle(180, 120)).toBe(false);
  });
});
