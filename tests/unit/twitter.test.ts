import { describe, expect, it } from "vitest";
import {
  isLikelyTwitterSpam,
  parseTimelinePayload,
  parseTweetDetailPayload,
  parseTwitterTargetUrl,
} from "../../src/extractors/twitter";

function tweet(id: string, text: string, author = "alice"): Record<string, unknown> {
  return {
    rest_id: id,
    legacy: { full_text: text, favorite_count: 3, retweet_count: 2, reply_count: 4, created_at: "Wed Apr 16 10:00:00 +0000 2026" },
    core: { user_results: { result: { legacy: { screen_name: author, name: author.toUpperCase(), description: "normal bio" } } } },
  };
}

function item(id: string, text: string, author = "alice"): Record<string, unknown> {
  return { content: { itemContent: { tweet_results: { result: tweet(id, text, author) } } } };
}

describe("Twitter/X extractor", () => {
  it("routes supported home and status URLs while rejecting lookalikes", () => {
    expect(parseTwitterTargetUrl("https://x.com/home")).toEqual({ kind: "timeline", origin: "https://x.com" });
    expect(parseTwitterTargetUrl("https://x.com/i/timeline")).toEqual({ kind: "timeline", origin: "https://x.com" });
    expect(parseTwitterTargetUrl("https://twitter.com/alice/status/123")).toEqual({ kind: "status", origin: "https://twitter.com", tweetId: "123" });
    expect(parseTwitterTargetUrl("https://x.com.evil.example/home")).toBeUndefined();
    expect(parseTwitterTargetUrl("https://x.com/alice/profile")).toBeUndefined();
  });

  it("parses timeline pages, nested modules, and bottom cursors with de-duplication", () => {
    const result = parseTimelinePayload({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              entries: [
                item("1", "first"),
                {
                  content: {
                    items: [{ item: { itemContent: { tweet_results: { result: tweet("2", "second", "bob") } } } }],
                  },
                },
                item("1", "duplicate"),
                { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "cursor-2" } },
              ],
            }],
          },
        },
      },
    });
    expect(result.tweets.map((value) => value.id)).toEqual(["1", "2"]);
    expect(result.cursors).toEqual([{ type: "Bottom", value: "cursor-2" }]);
    expect(result.tweets[0]).toMatchObject({ author: "alice", text: "first", likes: 3, replies: 4 });
  });

  it("parses TweetDetail replies and show-more cursors", () => {
    const result = parseTweetDetailPayload({
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [{
            entries: [
              item("root", "root"),
              item("reply", "reply", "bob"),
              { entryId: "cursor-showMore-1", content: { entryType: "TimelineTimelineCursor", cursorType: "ShowMore", value: "cursor-replies" } },
            ],
          }],
        },
      },
    });
    expect(result.tweets.map((value) => value.id)).toEqual(["root", "reply"]);
    expect(result.cursors).toEqual([{ type: "ShowMore", value: "cursor-replies" }]);
  });

  it("keeps video links separate from image thumbnails", () => {
    const video = tweet("video", "video post");
    (video.legacy as Record<string, unknown>).extended_entities = {
      media: [{
        type: "video",
        media_url_https: "https://pbs.twimg.com/video_thumb.jpg",
        video_info: { variants: [
          { content_type: "video/mp4", bitrate: 256_000, url: "https://video.twimg.com/low.mp4" },
          { content_type: "video/mp4", bitrate: 2_176_000, url: "https://video.twimg.com/high.mp4" },
        ] },
      }],
    };
    const result = parseTimelinePayload({
      data: { home: { home_timeline_urt: { instructions: [{ entries: [item("1", "photo"), { content: { itemContent: { tweet_results: { result: video } } } }] }] } } },
    });

    expect(result.tweets[1].mediaUrls).toEqual(["https://video.twimg.com/high.mp4"]);
    expect(result.tweets[1].imageUrls).toEqual(["https://pbs.twimg.com/video_thumb.jpg"]);
  });

  it("filters obvious promotional and duplicate spam while preserving concrete comments", () => {
    const seen = new Set<string>();
    expect(isLikelyTwitterSpam({ text: "Join our airdrop on Telegram, DM me", bio: "normal" }, seen)).toBe(true);
    expect(isLikelyTwitterSpam({ text: "这是一个有具体事实和观点的正常回复。", bio: "normal" }, seen)).toBe(false);
    expect(isLikelyTwitterSpam({ text: "这是一个有具体事实和观点的正常回复。", bio: "normal" }, seen)).toBe(true);
    expect(isLikelyTwitterSpam({ text: "😀😀😀", bio: "normal" }, new Set())).toBe(true);
  });

  it("filters repeated sexual-bait templates with emoji and account variations", () => {
    const templates = [
      "比她好看的X没她骚Y比她骚的没她好看 @YYkd88",
      "应该没人比我玩的开了吧😏 我福不黑不信你看",
      "我果然太涩了🥵有人想锐评一下我的福嘛",
    ];
    for (const text of templates) {
      expect(isLikelyTwitterSpam({ text, bio: "normal" }, new Set()), text).toBe(true);
    }
    expect(isLikelyTwitterSpam({
      text: "这位演员把角色演得很放得开，但对剧情的处理仍然很克制。",
      bio: "normal",
    }, new Set())).toBe(false);
  });
});
