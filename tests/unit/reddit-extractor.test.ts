import { describe, expect, it, vi } from "vitest";
import {
  formatRedditMarkdown,
  parseRedditPostData,
  parseRedditTargetUrl,
  RedditExtractor,
  type RedditPost,
} from "../../src/extractors/reddit";
import type { DiscussionItem } from "../../src/extractors/discussion";
import * as pageJsonModule from "../../src/platform/chrome/page-json";

vi.mock("../../src/platform/chrome/page-json", () => ({
  fetchPageJson: vi.fn(),
}));

describe("Reddit extractor", () => {
  it("parses valid Reddit comment thread URLs and rejects others", () => {
    expect(parseRedditTargetUrl("https://www.reddit.com/r/technology/comments/1abcde/new_quantum_breakthrough/")).toEqual({
      origin: "https://www.reddit.com",
      subreddit: "technology",
      postId: "1abcde",
      permalink: "/r/technology/comments/1abcde/new_quantum_breakthrough/",
    });

    expect(parseRedditTargetUrl("https://old.reddit.com/r/programming/comments/2xyz98/rust_vs_cpp/")).toEqual({
      origin: "https://old.reddit.com",
      subreddit: "programming",
      postId: "2xyz98",
      permalink: "/r/programming/comments/2xyz98/rust_vs_cpp/",
    });

    expect(parseRedditTargetUrl("https://www.reddit.com/r/technology/")).toBeUndefined();
    expect(parseRedditTargetUrl("https://reddit.com.evil.example/r/technology/comments/1abcde/test/")).toBeUndefined();
    expect(parseRedditTargetUrl("invalid-url")).toBeUndefined();
  });

  it("parses Reddit JSON payload into post details and threaded comments", () => {
    const rawPayload = [
      {
        data: {
          children: [
            {
              data: {
                id: "post123",
                title: "Show HN / Reddit: We built an open agent framework",
                author: "dev_alice",
                subreddit: "programming",
                selftext: "Here is why we built it with TypeScript and Vite.",
                score: 450,
                num_comments: 12,
                created_utc: 1731500000,
              },
            },
          ],
        },
      },
      {
        data: {
          children: [
            {
              kind: "t1",
              data: {
                id: "c1",
                author: "dev_bob",
                body: "Great work! How does it handle rate limits?",
                score: 35,
                created_utc: 1731500500,
                replies: {
                  data: {
                    children: [
                      {
                        kind: "t1",
                        data: {
                          id: "c2",
                          author: "dev_alice",
                          body: "We implement exponential backoff with jitter.",
                          score: 18,
                          created_utc: 1731501000,
                        },
                      },
                    ],
                  },
                },
              },
            },
            {
              kind: "t1",
              data: {
                id: "c3",
                author: "[deleted]",
                body: "[deleted]",
                score: 0,
              },
            },
          ],
        },
      },
    ];

    const { post, comments } = parseRedditPostData(rawPayload, "programming");
    expect(post).toBeDefined();
    expect(post?.title).toBe("Show HN / Reddit: We built an open agent framework");
    expect(post?.author).toBe("dev_alice");
    expect(post?.score).toBe(450);

    // [deleted] comments should be filtered out
    expect(comments).toHaveLength(2);
    expect(comments[0].author).toBe("dev_bob");
    expect(comments[0].body).toBe("Great work! How does it handle rate limits?");
    expect(comments[1].author).toBe("dev_alice");
    expect(comments[1].replyTo).toBe("dev_bob");
    expect(comments[1].body).toBe("We implement exponential backoff with jitter.");
  });

  it("formats Reddit markdown with discussion items", () => {
    const post: RedditPost = {
      id: "p1",
      title: "Discussing AI Context Engineering",
      author: "prompt_master",
      subreddit: "MachineLearning",
      selftext: "Context compression is more important than raw model size.",
      score: 820,
      numComments: 45,
      createdAt: "2026-11-12T00:00:00.000Z",
    };

    const comments: DiscussionItem[] = [
      {
        id: "c1",
        author: "ml_researcher",
        body: "Fully agree. Information density determines reasoning fidelity.",
        likes: 120,
        createdAt: "2026-11-12T01:00:00.000Z",
        ordinal: 1,
      },
    ];

    const md = formatRedditMarkdown(post, comments, ["已应用安全预算"]);
    expect(md).toContain("# Discussing AI Context Engineering");
    expect(md).toContain("@prompt_master · r/MachineLearning");
    expect(md).toContain("820 upvotes");
    expect(md).toContain("Context compression is more important than raw model size.");
    expect(md).toContain("## 讨论精选（共 1 条评论）");
    expect(md).toContain("@ml_researcher");
    expect(md).toContain("提取提示：已应用安全预算");
  });

  it("extracts Reddit thread document via fetchPageJson", async () => {
    const rawPayload = [
      {
        data: {
          children: [
            {
              data: {
                id: "123",
                title: "WXT Chrome Extension Architecture",
                author: "web_dev",
                subreddit: "webdev",
                selftext: "Exploring MV3 with reactive UI.",
                score: 150,
                num_comments: 5,
                created_utc: 1730000000,
              },
            },
          ],
        },
      },
      {
        data: {
          children: [
            {
              kind: "t1",
              data: {
                id: "c1",
                author: "reviewer",
                body: "WXT makes MV3 so much better.",
                score: 25,
                created_utc: 1730001000,
              },
            },
          ],
        },
      },
    ];

    vi.mocked(pageJsonModule.fetchPageJson).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: rawPayload,
      contentType: "application/json",
    });

    const extractor = new RedditExtractor();
    const doc = await extractor.extract(
      { tabId: 1, url: "https://www.reddit.com/r/webdev/comments/123/wxt_architecture/" },
      new AbortController().signal,
    );

    expect(doc.kind).toBe("webpage");
    expect(doc.title).toBe("WXT Chrome Extension Architecture");
    expect(doc.sourceText).toContain("# WXT Chrome Extension Architecture");
    expect(doc.sourceText).toContain("WXT makes MV3 so much better.");
    expect(doc.uploadFile?.name).toBe("WXT Chrome Extension Architecture.md");
  });
});
