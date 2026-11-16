import { describe, expect, it, vi } from "vitest";
import {
  formatWechatMarkdown,
  isWechatArticleUrl,
  WechatExtractor,
  type WechatPageSnapshot,
} from "../../src/extractors/wechat";
import { browser } from "wxt/browser";

vi.mock("wxt/browser", () => ({
  browser: {
    scripting: {
      executeScript: vi.fn(),
    },
  },
}));

describe("Wechat extractor", () => {
  it("recognizes valid WeChat article URLs and rejects invalid ones", () => {
    expect(isWechatArticleUrl("https://mp.weixin.qq.com/s/abc123xyz")).toBe(true);
    expect(isWechatArticleUrl("https://mp.weixin.qq.com/s?__biz=MzA1MjA2&mid=265&idx=1")).toBe(true);
    expect(isWechatArticleUrl("https://mp.weixin.qq.com/s")).toBe(true);

    expect(isWechatArticleUrl("https://mp.weixin.qq.com/cgi-bin/home")).toBe(false);
    expect(isWechatArticleUrl("https://mp.weixin.qq.com.evil.com/s/abc123xyz")).toBe(false);
    expect(isWechatArticleUrl("not-a-url")).toBe(false);
  });

  it("formats markdown with article metadata and clean body", () => {
    const snapshot: WechatPageSnapshot = {
      title: "深入理解大模型上下文工程",
      accountName: "架构师技术前线",
      author: "张工",
      publishTime: "2026-11-10T10:00:00.000Z",
      cleanHtml: "<p>上下文工程是决定 Agent 性能的核心。</p>",
      text: "上下文工程是决定 Agent 性能的核心。",
      imageUrls: ["https://mmbiz.qpic.cn/img1.png"],
    };

    const markdown = formatWechatMarkdown(snapshot.title, snapshot, snapshot.text, ["部分图片转存已完成"]);
    expect(markdown).toContain("# 深入理解大模型上下文工程");
    expect(markdown).toContain("公众号：架构师技术前线");
    expect(markdown).toContain("作者：张工");
    expect(markdown).toContain("发布时间：2026-11-10T10:00:00.000Z");
    expect(markdown).toContain("上下文工程是决定 Agent 性能的核心。");
    expect(markdown).toContain("提取提示：部分图片转存已完成");
  });

  it("extracts WeChat article document with clean html upload file and images", async () => {
    const snapshot: WechatPageSnapshot = {
      title: "TypeScript 高级类型体操",
      accountName: "前端工匠",
      author: "李工",
      publishTime: "2026-09-01T04:00:00.000Z",
      cleanHtml: "<div><h2>泛型约束</h2><p>介绍 extends 关键字。</p></div>",
      text: "泛型约束 介绍 extends 关键字。",
      imageUrls: ["https://mmbiz.qpic.cn/demo.png"],
    };

    vi.mocked(browser.scripting.executeScript).mockResolvedValueOnce([{ result: snapshot }] as any);

    const extractor = new WechatExtractor();
    const doc = await extractor.extract(
      { tabId: 1, url: "https://mp.weixin.qq.com/s/sample_token" },
      new AbortController().signal,
    );

    expect(doc.kind).toBe("webpage");
    expect(doc.title).toBe("TypeScript 高级类型体操");
    expect(doc.imageUrls).toEqual(["https://mmbiz.qpic.cn/demo.png"]);
    expect(doc.sourceText).toContain("# TypeScript 高级类型体操");
    expect(doc.sourceText).toContain("公众号：前端工匠");
    expect(doc.sourceText).toContain("## 泛型约束");
    expect(doc.uploadFile?.name).toBe("TypeScript 高级类型体操.html");
  });
});
