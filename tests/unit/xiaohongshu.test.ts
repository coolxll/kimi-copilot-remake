import { describe, expect, it } from "vitest";
import { appendMissingImageLinks, buildRepurposePrompt, generateRepurpose, sanitizeXiaohongshuMarkdown } from "../../src/application/repurpose";
import { extractImageUrls } from "../../src/shared/image-links";
import type { AppServices } from "../../src/application/services";
import type { ExtractedDocument, SummaryProvider } from "../../src/domain/types";

describe("Xiaohongshu Markdown workflow", () => {
  it("extracts remote image URLs from Markdown and HTML while ignoring data URLs", () => {
    expect(extractImageUrls(
      '![a](/images/a.png) ![b](https://cdn.example.com/b.png "title") <img src="https://cdn.example.com/c.webp"> <img src="data:image/png;base64,abc">',
      "https://example.com/article",
    )).toEqual([
      "https://example.com/images/a.png",
      "https://cdn.example.com/b.png",
      "https://cdn.example.com/c.webp",
    ]);
  });

  it("includes the image allow-list and factual constraints in the prompt", () => {
    const prompt = buildRepurposePrompt("xiaohongshu", ["https://cdn.example.com/cover.jpg"]);
    expect(prompt).toContain("https://cdn.example.com/cover.jpg");
    expect(prompt).toContain("不得改写、拼接、猜测或生成任何图片 URL");
    expect(prompt).toContain("4～8 个短卡片");
  });

  it("unwraps model fences and removes image URLs outside the source allow-list", () => {
    const result = sanitizeXiaohongshuMarkdown(
      "```markdown\n# 标题\n\n![保留](https://cdn.example.com/ok.jpg)\n\n![移除](https://made-up.example/bad.jpg)\n```",
      ["https://cdn.example.com/ok.jpg"],
    );
    expect(result).toBe("# 标题\n\n![保留](https://cdn.example.com/ok.jpg)");
  });

  it("adds allowed source images that the model forgot to reference", () => {
    expect(appendMissingImageLinks("# 标题", ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"])).toContain("![配图 1](https://cdn.example.com/a.jpg)");
    expect(appendMissingImageLinks("# 标题\n\n![已有](https://cdn.example.com/a.jpg)", ["https://cdn.example.com/a.jpg"])).toBe("# 标题\n\n![已有](https://cdn.example.com/a.jpg)");
  });

  it("passes the original image URL list to the provider and cleans its output", async () => {
    let requestPrompt = "";
    const provider: SummaryProvider = {
      id: "openai-compatible",
      validateReady: async () => undefined,
      summarize: async function* (request) {
        requestPrompt = request.prompt;
        yield { type: "delta", text: "# 小红书标题\n\n![原图](https://cdn.example.com/a.jpg)\n\n![假图](https://made-up.example/b.jpg)" };
        yield { type: "done" };
      },
    };
    const document: ExtractedDocument = {
      kind: "webpage",
      title: "原文",
      sourceUrl: "https://example.com/article",
      sourceText: "![原图](https://cdn.example.com/a.jpg)\n正文",
      warnings: [],
    };
    const services = {
      getProvider: async () => provider,
    } as unknown as AppServices;

    const result = await generateRepurpose(services, "openai-compatible", "# 总结\n\n正文", document, new AbortController().signal);

    expect(requestPrompt).toContain("https://cdn.example.com/a.jpg");
    expect(result.markdown).toContain("https://cdn.example.com/a.jpg");
    expect(result.markdown).not.toContain("made-up.example");
    expect(result.imageUrls).toEqual(["https://cdn.example.com/a.jpg"]);
    expect(result.format).toBe("md2card-long-image");
  });
});
