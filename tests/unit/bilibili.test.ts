import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseBilibiliSubtitleTrack,
  formatBilibiliCommentSection,
  isLikelyMismatchedBilibiliSubtitle,
  parseBilibiliVideoUrl,
  selectBilibiliPage,
} from "../../src/extractors/bilibili";
import { fetchBilibiliSubtitleInBackground } from "../../src/platform/chrome/bilibili";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    expect(selectBilibiliPage(pages, undefined, undefined, 101)).toBeUndefined();
    expect(selectBilibiliPage([{ page: 1, cid: 101 }], undefined, undefined, 101)?.cid).toBe(101);
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

describe("Bilibili background subtitle fetch", () => {
  it("uses the WBI API with the page-selected P and omits credentials for signed subtitle URLs", async () => {
    const calls: Array<{ url: string; credentials?: RequestCredentials }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, credentials: init?.credentials });
      if (url.includes("/x/web-interface/view")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            bvid: "BV1Test",
            aid: 123,
            title: "测试视频",
            desc: "视频简介",
            duration: 10,
            pages: [
              { page: 1, cid: 101, part: "第一 P", duration: 280 },
              { page: 2, cid: 202, part: "第二 P", duration: 10 },
            ],
          },
        }), { status: 200 });
      }
      if (url.includes("/x/player/wbi/v2")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            bvid: "BV1Test",
            aid: 123,
            cid: 202,
            subtitle: { subtitles: [
              { lan: "ai-zh", ai_type: 1, subtitle_url: "//aisubtitle.hdslb.com/test.json" },
            ] },
          },
        }), { status: 200 });
      }
      if (url.includes("aisubtitle.hdslb.com")) {
        return new Response(JSON.stringify({ body: [
          { from: 0, to: 5, content: "第一句" },
          { from: 5, to: 10, content: "第二句" },
        ] }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }));

    const result = await fetchBilibiliSubtitleInBackground({
      videoRef: { bvid: "BV1Test", pageNumber: 2 },
      currentCid: 101,
    });

    expect(result).toMatchObject({
      title: "测试视频",
      selectedPage: 2,
      subtitles: "第一句\n第二句",
      subtitleIsAi: true,
    });
    expect(calls.filter((call) => call.url.includes("api.bilibili.com")).every((call) => call.credentials === "include")).toBe(true);
    expect(calls.find((call) => call.url.includes("aisubtitle.hdslb.com"))?.credentials).toBe("omit");
    expect(calls.some((call) => call.url.includes("cid=202"))).toBe(true);
  });

  it("probes the Bilibili login state when no subtitle track is downloadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/x/web-interface/view")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { bvid: "BV1Test", aid: 123, cid: 101, pages: [{ page: 1, cid: 101 }] },
        }), { status: 200 });
      }
      if (url.includes("/x/player/")) {
        return new Response(JSON.stringify({ code: 0, data: { bvid: "BV1Test", aid: 123, cid: 101, subtitle: { subtitles: [] } } }), { status: 200 });
      }
      if (url.includes("/x/web-interface/nav")) {
        return new Response(JSON.stringify({ code: 0, data: { isLogin: false } }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }));

    const result = await fetchBilibiliSubtitleInBackground({ videoRef: { bvid: "BV1Test" } });

    expect(result.subtitles).toBe("");
    expect(result.loginState).toBe("logged-out");
    expect(result.unavailableReason).toBe("B 站没有返回可下载字幕轨");
  });

  it("rejects subtitle data when the player response does not prove the requested video and cid", async () => {
    const subtitleUrl = "https://aisubtitle.hdslb.com/unrelated.json";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/x/web-interface/view")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { bvid: "BV1Test", aid: 123, cid: 101, pages: [{ page: 1, cid: 101 }] },
        }), { status: 200 });
      }
      if (url.includes("/x/player/")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "zh-CN", subtitle_url: subtitleUrl }] } },
        }), { status: 200 });
      }
      if (url.includes("/x/web-interface/nav")) {
        return new Response(JSON.stringify({ code: 0, data: { isLogin: true } }), { status: 200 });
      }
      if (url === subtitleUrl) throw new Error("unrelated subtitle must not be fetched");
      throw new Error(`unexpected URL: ${url}`);
    }));

    const result = await fetchBilibiliSubtitleInBackground({ videoRef: { bvid: "BV1Test" } });

    expect(result.subtitles).toBe("");
    expect(result.unavailableReason).toBe("Bilibili 字幕接口返回了不匹配的视频");
  });
});

describe("Bilibili comment fallback", () => {
  it("labels comments as a limited non-transcript section", () => {
    expect(formatBilibiliCommentSection(["评论一", "评论二"])).toBe(
      "## 评论区摘录（仅部分评论，不代表视频正文）\n\n1. 评论一\n2. 评论二",
    );
    expect(formatBilibiliCommentSection([])).toBe("");
  });
});
