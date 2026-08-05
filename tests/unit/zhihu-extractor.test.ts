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
      const comments: Array<Record<string, unknown>> = Array.from({ length: 101 }, (_, index) => ({
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
    expect(document.sourceText).toContain("顶层评论 100");
    expect(document.sourceText).not.toContain("顶层评论 101");
    expect(document.sourceText).toContain("评论回复");
    expect(document.sourceText).toContain("问题标题");
    expect(document.warnings).toEqual([]);
  });

  it("stops question and comment pagination once display quotas are filled", async () => {
    const requestedUrls: string[] = [];
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const url = String(details.args?.[0] ?? "");
      requestedUrls.push(url);
      if (url.includes("/api/v4/questions/123?") && !url.includes("/answers")) {
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: { title: "问题标题" } } }];
      }
      if (url.includes("/api/v4/questions/123/answers?")) {
        const answers = Array.from({ length: 21 }, (_, index) => ({
          id: `answer-${index + 1}`,
          content: `回答正文 ${index + 1}`,
          author: { name: `答主${index + 1}` },
          question: { id: "123", title: "问题标题" },
        }));
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: {
          data: answers,
          paging: { next: "https://www.zhihu.com/api/v4/questions/123/answers?limit=20&offset=20" },
        } } }];
      }
      const answerId = url.match(/\/answers\/(answer-\d+)\/comments/)?.[1] ?? "answer-unknown";
      const comments = Array.from({ length: 21 }, (_, index) => ({
        id: `${answerId}-comment-${index + 1}`,
        content: `${answerId} 顶层评论 ${index + 1}`,
        author: { name: `评论者${index + 1}` },
        reply_to_author: null,
      }));
      return [{ result: { ok: true, status: 200, contentType: "application/json", data: {
        data: comments,
        paging: { next: `https://www.zhihu.com/api/v4/answers/${answerId}/comments?limit=20&offset=20` },
      } } }];
    });

    const document = await new ZhihuExtractor().extract(
      { tabId: 9, url: "https://www.zhihu.com/question/123" },
      new AbortController().signal,
    );

    expect(document.sourceText).toContain("回答正文 20");
    expect(document.sourceText).not.toContain("回答正文 21");
    expect(document.sourceText).toContain("answer-1 顶层评论 20");
    expect(document.sourceText).not.toContain("answer-1 顶层评论 21");
    expect(document.warnings).toEqual([]);
    const answerListUrl = requestedUrls.find((url) => url.includes("/questions/123/answers?"));
    const commentUrls = requestedUrls.filter((url) => url.includes("/comments"));
    expect(answerListUrl).toContain("limit=20");
    expect(commentUrls).toHaveLength(20);
    expect(commentUrls.every((url) => url.includes("limit=20"))).toBe(true);
  });

  it("prioritizes answer bodies before spending the character budget on comments", async () => {
    const requestedUrls: string[] = [];
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const url = String(details.args?.[0] ?? "");
      requestedUrls.push(url);
      if (url.includes("/api/v4/questions/123?") && !url.includes("/answers")) {
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: { title: "长问题" } } }];
      }
      if (url.includes("/api/v4/questions/123/answers?")) {
        const answers = Array.from({ length: 10 }, (_, index) => ({
          id: `long-answer-${index + 1}`,
          content: `${index + 1}-${"长回答".repeat(10_000)}`,
          author: { name: `答主${index + 1}` },
          question: { id: "123", title: "长问题" },
        }));
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: { data: answers, paging: {} } } }];
      }
      return [{ result: { ok: true, status: 200, contentType: "application/json", data: { data: [], paging: {} } } }];
    });

    const document = await new ZhihuExtractor().extract(
      { tabId: 9, url: "https://www.zhihu.com/question/123" },
      new AbortController().signal,
    );

    expect(document.sourceText).toContain("1-长回答");
    expect(document.sourceText).toContain("3-长回答");
    expect(document.sourceText).not.toContain("4-长回答");
    expect(document.sourceText.length).toBeLessThanOrEqual(120_000);
    expect(document.warnings).toEqual([]);
    expect(requestedUrls.some((url) => url.includes("/comments"))).toBe(true);
  });

  it("truncates an oversized first answer to the hard character budget", async () => {
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const url = String(details.args?.[0] ?? "");
      if (url.includes("/api/v4/questions/123?") && !url.includes("/answers")) {
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: { title: "超长回答问题" } } }];
      }
      if (url.includes("/api/v4/questions/123/answers?")) {
        return [{ result: { ok: true, status: 200, contentType: "application/json", data: { data: [{
          id: "oversized-answer",
          content: `开头-${"超长正文".repeat(40_000)}-结尾`,
          author: { name: "答主" },
          question: { id: "123", title: "超长回答问题" },
        }], paging: {} } } }];
      }
      return [{ result: { ok: true, status: 200, contentType: "application/json", data: { data: [], paging: {} } } }];
    });

    const document = await new ZhihuExtractor().extract(
      { tabId: 9, url: "https://www.zhihu.com/question/123" },
      new AbortController().signal,
    );

    expect(document.sourceText).toContain("开头-超长正文");
    expect(document.sourceText).toContain("回答正文已按字符预算截断");
    expect(document.sourceText).not.toContain("-结尾");
    expect(document.sourceText.length).toBeLessThanOrEqual(120_000);
  });
});
