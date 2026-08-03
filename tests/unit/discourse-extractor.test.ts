import { afterEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  scripting: { executeScript: vi.fn() },
}));

vi.mock("wxt/browser", () => ({ browser: browserMock }));

import { DiscourseExtractor } from "../../src/extractors/discourse";

afterEach(() => {
  vi.clearAllMocks();
});

function post(id: number, postNumber: number, body: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    post_number: postNumber,
    username: `user-${postNumber}`,
    raw: body,
    like_count: postNumber,
    created_at: "2026-01-01T00:00:00Z",
    ...extras,
  };
}

function installPageResponses(responses: Record<string, unknown>) {
  browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
    if (details.args?.length === 3) return [{ result: { sameTopic: true, discourseMarker: true } }];
    const url = String(details.args?.[0] ?? "");
    return [{ result: { ok: true, status: 200, data: responses[url] ?? null, contentType: "application/json" } }];
  });
}

describe("DiscourseExtractor", () => {
  it("keeps every post and direct reply for short topics", async () => {
    const topicUrl = "https://linux.do/t/123.json?include_raw=true";
    installPageResponses({
      [topicUrl]: {
        title: "Demo",
        post_stream: {
          stream: [1, 2, 3],
          posts: [post(1, 1, "主楼"), post(2, 2, "评论", { reply_to_post_number: 1 }), post(3, 3, "评论的评论", { reply_to_post_number: 2 })],
        },
      },
    });
    const extractor = new DiscourseExtractor();
    const context = { tabId: 7, url: "https://linux.do/t/demo/123" };
    expect(await extractor.probe!(context, new AbortController().signal)).toBe(true);
    const document = await extractor.extract(context, new AbortController().signal);
    expect(document.sourceText).toContain("评论的评论");
    expect(document.sourceText.indexOf("评论") < document.sourceText.indexOf("评论的评论")).toBe(true);
    expect(document.uploadFile?.name).toBe("Demo.md");
  });

  it("uses the native summary and expands only hot reply threads for long topics", async () => {
    const initialUrl = "https://linux.do/t/123.json?include_raw=true";
    const summaryUrl = "https://linux.do/t/123.json?filter=summary&include_raw=true";
    const repliesUrl = "https://linux.do/posts/51/replies.json";
    installPageResponses({
      [initialUrl]: {
        title: "Long demo",
        post_stream: {
          stream: Array.from({ length: 51 }, (_, index) => index + 1),
          posts: [post(1, 1, "主楼")],
        },
      },
      [summaryUrl]: {
        title: "Long demo",
        post_stream: { stream: [1, 51], posts: [post(1, 1, "主楼"), post(51, 51, "热门", { reply_count: 1, score: 99 })] },
      },
      [repliesUrl]: { post_stream: { posts: [post(52, 52, "热门回复", { reply_to_post_number: 51 })] } },
    });
    const extractor = new DiscourseExtractor();
    const context = { tabId: 7, url: "https://linux.do/t/demo/123" };
    expect(await extractor.probe!(context, new AbortController().signal)).toBe(true);
    const document = await extractor.extract(context, new AbortController().signal);
    expect(document.sourceText).toContain("热门回复");
    expect(document.warnings.join(";")).toContain("热门摘要");
    expect(browserMock.scripting.executeScript.mock.calls.some((call) => String(call[0]?.args?.[0] ?? "").includes("filter=summary"))).toBe(true);
  });
});
