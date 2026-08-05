import { afterEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  scripting: { executeScript: vi.fn() },
}));

vi.mock("wxt/browser", () => ({ browser: browserMock }));

import { TwitterExtractor } from "../../src/extractors/twitter";

afterEach(() => vi.clearAllMocks());

function rawTweet(id: string, text: string, author = "alice", inReplyToId?: string, replies = 2): Record<string, unknown> {
  return {
    rest_id: id,
    legacy: {
      full_text: text,
      favorite_count: 3,
      retweet_count: 2,
      reply_count: replies,
      created_at: "Wed Apr 16 10:00:00 +0000 2026",
      ...(inReplyToId ? { in_reply_to_status_id_str: inReplyToId } : {}),
    },
    core: { user_results: { result: { legacy: { screen_name: author, name: author.toUpperCase() } } } },
  };
}

function tweetEntry(tweet: Record<string, unknown>): Record<string, unknown> {
  return { content: { itemContent: { tweet_results: { result: tweet } } } };
}

function timelinePayload(entries: Record<string, unknown>[]): unknown {
  return { data: { home: { home_timeline_urt: { instructions: [{ entries }] } } } };
}

function detailPayload(root: Record<string, unknown>, comments: Record<string, unknown>[]): unknown {
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [tweetEntry(root), ...comments.map(tweetEntry)] }] } } };
}

describe("TwitterExtractor", () => {
  it("paginates the active For you feed and includes filtered comments", async () => {
    const timelineCursors: Array<string | undefined> = [];
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const args = details.args ?? [];
      if (!args.length) return [{ result: "for-you" }];
      if (typeof args[0] === "string") return [{ result: args[1] }];
      const request = args[0] as { url: string };
      if (request.url.includes("/HomeTimeline")) {
        const variables = JSON.parse(decodeURIComponent(request.url.split("variables=")[1].split("&")[0])) as { cursor?: string };
        timelineCursors.push(variables.cursor);
        return [{ result: {
          ok: true,
          status: 200,
          data: variables.cursor
            ? timelinePayload([tweetEntry(rawTweet("2", "第二条内容", "bob"))])
            : timelinePayload([
                tweetEntry(rawTweet("1", "第一条内容")),
                { entryId: "cursor-top-1", content: { entryType: "TimelineTimelineCursor", cursorType: "Top", value: "cursor-newer" } },
                { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "cursor-2" } },
              ]),
        } }];
      }
      const id = request.url.includes('focalTweetId%22%3A%221%22') || request.url.includes('focalTweetId%22%3A%22') && decodeURIComponent(request.url).includes('"1"') ? "1" : "2";
      return [{ result: {
        ok: true,
        status: 200,
        data: detailPayload(rawTweet(id, `原帖 ${id}`), [
          rawTweet(`${id}-good`, "这是具体且有事实依据的正常评论。", "commenter", id),
          rawTweet(`${id}-spam`, "Join our airdrop on Telegram, DM me", "spammer", id),
        ]),
      } }];
    });

    const document = await new TwitterExtractor().extract(
      { tabId: 5, url: "https://x.com/home", title: "Home" },
      new AbortController().signal,
    );

    expect(document.title).toBe("X For you 推荐时间线");
    expect(document.sourceText).toContain("第一条内容");
    expect(document.sourceText).toContain("第二条内容");
    expect(document.sourceText).toContain("具体且有事实依据");
    expect(document.sourceText).not.toContain("Join our airdrop");
    expect(document.warnings).toEqual([]);
    expect(timelineCursors).toEqual([undefined, "cursor-2"]);
    expect(browserMock.scripting.executeScript.mock.calls.filter((call) => {
      const args = (call[0] as { args?: unknown[] }).args ?? [];
      return args[0] && typeof args[0] === "object" && String((args[0] as { url?: string }).url).includes("/HomeTimeline");
    })).toHaveLength(2);
  });

  it("warns when a later timeline page fails and keeps the first page", async () => {
    let timelineRequests = 0;
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const args = details.args ?? [];
      if (!args.length) return [{ result: "for-you" }];
      if (typeof args[0] === "string") return [{ result: args[1] }];
      const request = args[0] as { url: string };
      if (request.url.includes("/HomeTimeline")) {
        timelineRequests += 1;
        if (timelineRequests > 1) return [{ result: { ok: false, status: 429, data: null } }];
        return [{ result: {
          ok: true,
          status: 200,
          data: timelinePayload([
            tweetEntry(rawTweet("1", "已读取的时间线内容", "alice", undefined, 0)),
            { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "cursor-2" } },
          ]),
        } }];
      }
      throw new Error(`unexpected request: ${request.url}`);
    });

    const document = await new TwitterExtractor().extract(
      { tabId: 5, url: "https://x.com/home" },
      new AbortController().signal,
    );

    expect(document.sourceText).toContain("已读取的时间线内容");
    expect(document.warnings).toContain("X 时间线分页未完整返回，已保留已读取内容");
  });

  it("renders only descendants of a focal reply as comments", async () => {
    browserMock.scripting.executeScript.mockImplementation(async (details: { args?: unknown[] }) => {
      const args = details.args ?? [];
      if (typeof args[0] === "string") return [{ result: args[1] }];
      return [{ result: {
        ok: true,
        status: 200,
        data: detailPayload(rawTweet("100", "上游对话内容", "older"), [
          rawTweet("200", "当前焦点帖子", "alice", "100"),
          rawTweet("300", "焦点帖的直接回复内容", "bob", "200"),
          rawTweet("400", "焦点帖的下级回复内容", "carol", "300"),
          rawTweet("unrelated", "不相关的注入内容", "mallory", "somewhere-else"),
        ]),
      } }];
    });

    const document = await new TwitterExtractor().extract(
      { tabId: 5, url: "https://x.com/alice/status/200" },
      new AbortController().signal,
    );

    expect(document.sourceText).toContain("当前焦点帖子");
    expect(document.sourceText).toContain("焦点帖的直接回复内容");
    expect(document.sourceText).toContain("焦点帖的下级回复内容");
    expect(document.sourceText).not.toContain("上游对话内容");
    expect(document.sourceText).not.toContain("不相关的注入内容");
  });
});
