import { describe, expect, it } from "vitest";
import { discoursePostsUrl, discourseRepliesUrl, discourseTopicJsonUrl, parseDiscourseTopicUrl } from "../../src/domain/discourse";
import { parseZhihuTargetUrl } from "../../src/extractors/zhihu";

describe("Discourse URL helpers", () => {
  it("parses hosted and sub-path topic URLs without trusting lookalike paths", () => {
    expect(parseDiscourseTopicUrl("https://linux.do/t/example/123/7")).toMatchObject({
      origin: "https://linux.do",
      basePath: "",
      topicId: "123",
      slug: "example",
      postNumber: 7,
    });
    expect(parseDiscourseTopicUrl("https://forum.example.com/forum/t/123")).toMatchObject({
      basePath: "/forum",
      topicId: "123",
    });
    expect(parseDiscourseTopicUrl("https://example.com/topic/123")).toBeUndefined();
    expect(parseDiscourseTopicUrl("https://example.com/t/slug/not-an-id")).toBeUndefined();
  });

  it("builds same-origin topic, post batch, and direct-reply endpoints", () => {
    const ref = parseDiscourseTopicUrl("https://forum.example.com/forum/t/topic/123")!;
    expect(discourseTopicJsonUrl(ref, { filter: "summary", include_raw: "true" }))
      .toBe("https://forum.example.com/forum/t/123.json?filter=summary&include_raw=true");
    expect(discoursePostsUrl(ref, ["1", "2"]))
      .toBe("https://forum.example.com/forum/t/123/posts.json?include_raw=true&post_ids%5B%5D=1&post_ids%5B%5D=2");
    expect(discourseRepliesUrl(ref, "42")).toBe("https://forum.example.com/forum/posts/42/replies.json");
  });
});

describe("Zhihu URL routing", () => {
  it("accepts question and answer pages on exact Zhihu hosts", () => {
    expect(parseZhihuTargetUrl("https://www.zhihu.com/question/123")).toEqual({ kind: "question", origin: "https://www.zhihu.com", questionId: "123" });
    expect(parseZhihuTargetUrl("https://www.zhihu.com/question/123/answer/456")).toEqual({ kind: "answer", origin: "https://www.zhihu.com", questionId: "123", answerId: "456" });
    expect(parseZhihuTargetUrl("https://zhihu.com/answer/456")).toEqual({ kind: "answer", origin: "https://zhihu.com", answerId: "456" });
    expect(parseZhihuTargetUrl("https://www.zhihu.com/zhuanlan/123")).toBeUndefined();
    expect(parseZhihuTargetUrl("https://www.zhihu.com.evil.example/question/123")).toBeUndefined();
  });
});
