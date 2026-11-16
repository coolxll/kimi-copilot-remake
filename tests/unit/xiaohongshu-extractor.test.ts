import { describe, expect, it, vi } from "vitest";
import {
  formatXiaohongshuMarkdown,
  parseXiaohongshuTargetUrl,
  XiaohongshuExtractor,
  type XiaohongshuPageSnapshot,
} from "../../src/extractors/xiaohongshu";
import { browser } from "wxt/browser";

vi.mock("wxt/browser", () => ({
  browser: {
    scripting: {
      executeScript: vi.fn(),
    },
  },
}));

describe("Xiaohongshu extractor", () => {
  it("parses valid explore and discovery item URLs and rejects invalid ones", () => {
    expect(parseXiaohongshuTargetUrl("https://www.xiaohongshu.com/explore/65df2085000000000b031c26")).toEqual({
      origin: "https://www.xiaohongshu.com",
      noteId: "65df2085000000000b031c26",
    });

    expect(parseXiaohongshuTargetUrl("https://xiaohongshu.com/discovery/item/65df2085000000000b031c26")).toEqual({
      origin: "https://xiaohongshu.com",
      noteId: "65df2085000000000b031c26",
    });

    expect(parseXiaohongshuTargetUrl("https://www.xiaohongshu.com/user/profile/123")).toBeUndefined();
    expect(parseXiaohongshuTargetUrl("https://xiaohongshu.com.evil.com/explore/123")).toBeUndefined();
    expect(parseXiaohongshuTargetUrl("not-a-url")).toBeUndefined();
  });

  it("formats markdown with metadata, tags, images and warnings", () => {
    const snapshot: XiaohongshuPageSnapshot = {
      title: "京都赏枫保姆级攻略",
      desc: "秋天的京都太美了！整理了3天2晚路线与拍照机位。",
      author: "旅行家小李",
      publishTime: "2026-11-15T08:00:00.000Z",
      likes: "1.5w",
      collects: "3800",
      tags: ["京都", "日本旅行", "红叶季"],
      imageUrls: ["https://ci.xiaohongshu.com/img1.jpg", "https://ci.xiaohongshu.com/img2.jpg"],
      hasState: true,
    };

    const markdown = formatXiaohongshuMarkdown(snapshot.title, snapshot, ["图片来源于官方展示"]);
    expect(markdown).toContain("# 京都赏枫保姆级攻略");
    expect(markdown).toContain("作者：@旅行家小李");
    expect(markdown).toContain("1.5w 赞");
    expect(markdown).toContain("3800 收藏");
    expect(markdown).toContain("#京都 #日本旅行 #红叶季");
    expect(markdown).toContain("![配图 1](https://ci.xiaohongshu.com/img1.jpg)");
    expect(markdown).toContain("![配图 2](https://ci.xiaohongshu.com/img2.jpg)");
    expect(markdown).toContain("提取提示：图片来源于官方展示");
  });

  it("extracts note document from page state", async () => {
    const snapshot: XiaohongshuPageSnapshot = {
      title: "我的摄影装备推荐",
      desc: "常用机身与镜头清单。",
      author: "摄影小张",
      publishTime: "2026-10-01T12:00:00.000Z",
      likes: "2300",
      collects: "890",
      tags: ["摄影器材"],
      imageUrls: ["https://ci.xiaohongshu.com/cam1.jpg"],
      hasState: true,
    };

    vi.mocked(browser.scripting.executeScript).mockResolvedValueOnce([{ result: snapshot }] as any);

    const extractor = new XiaohongshuExtractor();
    const doc = await extractor.extract(
      { tabId: 1, url: "https://www.xiaohongshu.com/explore/65df2085000000000b031c26" },
      new AbortController().signal,
    );

    expect(doc.kind).toBe("webpage");
    expect(doc.title).toBe("我的摄影装备推荐");
    expect(doc.imageUrls).toEqual(["https://ci.xiaohongshu.com/cam1.jpg"]);
    expect(doc.sourceText).toContain("# 我的摄影装备推荐");
    expect(doc.sourceText).toContain("作者：@摄影小张");
    expect(doc.uploadFile?.name).toBe("我的摄影装备推荐.md");
  });
});
