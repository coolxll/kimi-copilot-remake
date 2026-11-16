import { describe, expect, it } from "vitest";
import { isRedditUrl } from "../../worker/src/extractors/reddit";
import { isBilibiliUrl } from "../../worker/src/extractors/bilibili";
import { isYoutubeUrl } from "../../worker/src/extractors/youtube";
import { isZhihuUrl } from "../../worker/src/extractors/zhihu";
import { isWechatUrl } from "../../worker/src/extractors/wechat";
import { isXiaohongshuUrl } from "../../worker/src/extractors/xiaohongshu";
import { cleanGenericHtml } from "../../worker/src/extractors/webpage";
import workerHandler from "../../worker/src/index";

describe("Cloudflare Worker serverless extractors", () => {
  it("correctly identifies target URLs across all supported sites", () => {
    expect(isRedditUrl("https://www.reddit.com/r/technology/comments/123/ai_breakthrough/")).toBe(true);
    expect(isRedditUrl("https://example.com")).toBe(false);

    expect(isBilibiliUrl("https://www.bilibili.com/video/BV1xx411c7mD")).toBe(true);
    expect(isBilibiliUrl("https://bilibili.com/read/cv123")).toBe(false);

    expect(isYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYoutubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);

    expect(isZhihuUrl("https://www.zhihu.com/question/123456")).toBe(true);
    expect(isZhihuUrl("https://www.zhihu.com/question/123/answer/456")).toBe(true);

    expect(isWechatUrl("https://mp.weixin.qq.com/s/abcdef123456")).toBe(true);
    expect(isWechatUrl("https://mp.weixin.qq.com/other")).toBe(false);

    expect(isXiaohongshuUrl("https://www.xiaohongshu.com/explore/65df2085000000000b031c26")).toBe(true);
    expect(isXiaohongshuUrl("https://xhslink.com/a/abcde")).toBe(true);
  });

  it("cleans HTML into markdown properly", () => {
    const rawHtml = `
      <html>
        <head><title>Test Title</title></head>
        <body>
          <nav><a href="/">Home</a></nav>
          <h1>Main Title</h1>
          <p>Paragraph 1 with <b>bold text</b> and <a href="https://example.com">link</a>.</p>
          <script>alert(1);</script>
        </body>
      </html>
    `;

    const md = cleanGenericHtml(rawHtml);
    expect(md).toContain("# Main Title");
    expect(md).toContain("Paragraph 1 with **bold text** and [link](https://example.com).");
    expect(md).not.toContain("alert(1)");
    expect(md).not.toContain("Home");
  });

  it("serves health check and handles CORS OPTIONS preflight", async () => {
    const optionsRes = await workerHandler.fetch(
      new Request("https://worker.test/api/extract", { method: "OPTIONS" }),
      {},
    );
    expect(optionsRes.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const healthRes = await workerHandler.fetch(
      new Request("https://worker.test/health", { method: "GET" }),
      {},
    );
    expect(healthRes.status).toBe(200);
    const body = (await healthRes.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.service).toContain("Kimi Copilot");
  });
});
