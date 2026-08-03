import { afterEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  scripting: { executeScript: vi.fn() },
}));

vi.mock("wxt/browser", () => ({ browser: browserMock }));

import { ZhihuExtractor } from "../../src/extractors/zhihu";

afterEach(() => vi.clearAllMocks());

describe("ZhihuExtractor", () => {
  it("keeps the full answer and applies separate top-level/reply limits", async () => {
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const url = String(details.args?.[0] ?? "");
      if (url.includes("/api/v4/answers/456?") && !url.includes("/comments")) {
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: {
          id: "456",
          content: "回答正文",
          voteup_count: 18,
          comment_count: 30,
          author: { name: "答主" },
          created_time: 1_700_000_000,
          question: { id: "123", title: "问题标题" },
        } } }];
      }
      const comments: Array<Record<string, unknown>> = Array.from({ length: 21 }, (_, index) => ({
        id: String(index + 1),
        content: `顶层评论 ${index + 1}`,
        author: { name: `评论者${index + 1}` },
        reply_to_author: null,
      }));
      comments.push({ id: "reply-1", content: "评论回复", author: { name: "回复者" }, reply_to_author: { name: "评论者1" } });
      return [{ result: { ok: true, status: 200, contentType: "application/json", data: { data: comments, paging: {} } } }];
    });

    const document = await new ZhihuExtractor().extract(
      { tabId: 9, url: "https://www.zhihu.com/question/123/answer/456" },
      new AbortController().signal,
    );
    expect(document.sourceText).toContain("回答正文");
    expect(document.sourceText).toContain("顶层评论 20");
    expect(document.sourceText).not.toContain("顶层评论 21");
    expect(document.sourceText).toContain("评论回复");
    expect(document.sourceText).toContain("问题标题");
  });
});
