import { describe, expect, it, vi } from "vitest";
import {
  DeclarativeExtractor,
  formatDeclarativeMarkdown,
  matchUrlPattern,
  type DeclarativePageSnapshot,
  type DeclarativeRule,
} from "../../src/extractors/declarative";
import { browser } from "wxt/browser";

vi.mock("wxt/browser", () => ({
  browser: {
    scripting: {
      executeScript: vi.fn(),
    },
  },
}));

describe("Declarative extractor and URL matching", () => {
  it("matches wildcard URL patterns accurately", () => {
    // Scheme wildcard
    expect(matchUrlPattern("*://zhuanlan.zhihu.com/p/*", "https://zhuanlan.zhihu.com/p/12345")).toBe(true);
    expect(matchUrlPattern("*://zhuanlan.zhihu.com/p/*", "http://zhuanlan.zhihu.com/p/12345")).toBe(true);
    expect(matchUrlPattern("https://zhuanlan.zhihu.com/p/*", "http://zhuanlan.zhihu.com/p/12345")).toBe(false);

    // Host wildcard
    expect(matchUrlPattern("*://*.juejin.cn/post/*", "https://juejin.cn/post/999")).toBe(true);
    expect(matchUrlPattern("*://*.juejin.cn/post/*", "https://www.juejin.cn/post/999")).toBe(true);
    expect(matchUrlPattern("*://*.juejin.cn/post/*", "https://evil.com/post/999")).toBe(false);

    // Path wildcard
    expect(matchUrlPattern("*://blog.csdn.net/*/article/details/*", "https://blog.csdn.net/alice/article/details/10001")).toBe(true);
    expect(matchUrlPattern("*://blog.csdn.net/*/article/details/*", "https://blog.csdn.net/alice/article/summary")).toBe(false);

    // <all_urls>
    expect(matchUrlPattern("<all_urls>", "https://example.com/foo")).toBe(true);

    // Invalid URLs
    expect(matchUrlPattern("*://example.com/*", "not-a-url")).toBe(false);
  });

  it("formats markdown with metadata and body content", () => {
    const snapshot: DeclarativePageSnapshot = {
      ok: true,
      title: "Rust 异步编程实践",
      author: "Rustacean",
      publishTime: "2026-11-01T00:00:00.000Z",
      html: "<p>Tokio 运行时详解</p>",
      text: "Tokio 运行时详解",
      imageUrls: ["https://cdn.example.com/tokio.png"],
    };

    const md = formatDeclarativeMarkdown(snapshot.title, snapshot, snapshot.text, ["测试警告"]);
    expect(md).toContain("# Rust 异步编程实践");
    expect(md).toContain("作者：Rustacean");
    expect(md).toContain("发布时间：2026-11-01T00:00:00.000Z");
    expect(md).toContain("Tokio 运行时详解");
    expect(md).toContain("提取提示：测试警告");
  });

  it("extracts document according to declarative rule", async () => {
    const rule: DeclarativeRule = {
      id: "test-blog",
      label: "测试博客",
      matchPatterns: ["*://blog.example.com/p/*"],
      meta: {
        titleSelector: "h1.title",
        authorSelector: ".author",
      },
      content: {
        containerSelector: "#content",
        removeSelectors: [".ads"],
        lazyImageAttrs: ["data-src"],
      },
    };

    const snapshot: DeclarativePageSnapshot = {
      ok: true,
      title: "深入浅出设计模式",
      author: "架构师",
      html: "<div><h2>单例模式</h2><p>确保只有一个实例。</p></div>",
      text: "单例模式 确保只有一个实例。",
      imageUrls: ["https://cdn.example.com/diagram.png"],
    };

    vi.mocked(browser.scripting.executeScript).mockResolvedValueOnce([{ result: snapshot }] as any);

    const extractor = new DeclarativeExtractor(rule);
    expect(extractor.canHandle({ tabId: 1, url: "https://blog.example.com/p/design-patterns" })).toBe(true);
    expect(extractor.canHandle({ tabId: 1, url: "https://other.com/p/123" })).toBe(false);

    const doc = await extractor.extract(
      { tabId: 1, url: "https://blog.example.com/p/design-patterns" },
      new AbortController().signal,
    );

    expect(doc.kind).toBe("webpage");
    expect(doc.title).toBe("深入浅出设计模式");
    expect(doc.sourceText).toContain("# 深入浅出设计模式");
    expect(doc.sourceText).toContain("作者：架构师");
    expect(doc.sourceText).toContain("## 单例模式");
    expect(doc.imageUrls).toEqual(["https://cdn.example.com/diagram.png"]);
    expect(doc.uploadFile?.name).toBe("深入浅出设计模式.html");
  });
});
