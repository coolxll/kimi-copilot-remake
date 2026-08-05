import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { throwIfAborted } from "../shared/abort";
import { uniqueImageUrls } from "../shared/image-links";
import { appendWarningSection, createMarkdownFile, formatDate } from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { WebpageExtractor } from "./webpage";

const TWITTER_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const HOME_TIMELINE_QUERY_ID = "c-CzHF1LboFilMpsx4ZCrQ";
const HOME_LATEST_TIMELINE_QUERY_ID = "BKB7oi212Fi7kQtCBGE4zA";
const TWEET_DETAIL_QUERY_ID = "nBS-WpgA6ZG0CyNHD517JQ";
const MAX_TIMELINE_PAGES = 5;
const MAX_COMMENT_PAGES = 2;
const MAX_STATUS_COMMENT_PAGES = 5;
const MAX_TIMELINE_TWEETS = 100;
const MAX_COMMENTS_PER_TWEET = 10;
const MAX_STATUS_COMMENTS = 100;
const MAX_SOURCE_CHARS = 120_000;

const TIMELINE_FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_enabled: true,
  profile_label_improvements_pcf_label_improvements_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const DETAIL_FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
};

const DETAIL_FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false };
const TWITTER_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

export type TwitterTarget =
  | { kind: "timeline"; origin: string }
  | { kind: "status"; origin: string; tweetId: string };

export type TwitterTimelineMode = "for-you" | "following";

export interface TwitterTweet {
  id: string;
  author: string;
  displayName: string;
  bio: string;
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  createdAt?: string;
  url: string;
  mediaUrls: string[];
  imageUrls: string[];
  inReplyToId?: string;
  quotedTweet?: Pick<TwitterTweet, "id" | "author" | "displayName" | "text" | "url" | "mediaUrls" | "imageUrls">;
}

export type TwitterComment = TwitterTweet;

interface TwitterApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

interface TimelineParseResult {
  tweets: TwitterTweet[];
  cursors: TwitterCursor[];
}

interface TwitterCursor {
  value: string;
  type: string;
}

interface TimelineFetchResult {
  tweets: TwitterTweet[];
  failed: boolean;
}

interface CommentFetchResult {
  comments: TwitterComment[];
  failed: boolean;
}

export class TwitterExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "twitter",
    label: "X / Twitter",
    outputKind: "webpage",
  };

  canHandle(context: PageContext): boolean {
    return Boolean(parseTwitterTargetUrl(context.url));
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    const target = parseTwitterTargetUrl(context.url);
    if (!target) throw new AppError("unsupported-page", "无效的 X / Twitter 页面地址");
    return target.kind === "status"
      ? this.extractStatus(context, target, signal)
      : this.extractTimeline(context, target, signal);
  }

  private async extractTimeline(context: PageContext, target: Extract<TwitterTarget, { kind: "timeline" }>, signal: AbortSignal): Promise<ExtractedDocument> {
    const warnings: string[] = [];
    const mode = await this.detectTimelineMode(context.tabId, signal);
    const operationName = mode === "following" ? "HomeLatestTimeline" : "HomeTimeline";
    const fallbackQueryId = mode === "following" ? HOME_LATEST_TIMELINE_QUERY_ID : HOME_TIMELINE_QUERY_ID;
    const queryId = await this.resolveQueryId(context.tabId, operationName, fallbackQueryId, signal);
    let timeline: TimelineFetchResult;
    try {
      timeline = await this.fetchTimeline(context.tabId, target.origin, mode, queryId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push(`X ${mode === "following" ? "Following" : "For you"} 时间线接口不可用，已退回当前页面正文`);
      return this.fallback(context, signal, warnings);
    }
    if (!timeline.tweets.length) {
      warnings.push("X 时间线接口未返回可读取内容，已退回当前页面正文");
      return this.fallback(context, signal, warnings);
    }
    if (timeline.failed) warnings.push("X 时间线分页未完整返回，已保留已读取内容");

    const title = mode === "following" ? "X Following 时间线" : "X For you 推荐时间线";
    const selectedTweets = fitTweetsToBudget(context, title, timeline.tweets.slice(0, MAX_TIMELINE_TWEETS));
    const comments = new Map<string, TwitterComment[]>();
    let commentChars = remainingCommentChars(context, title, selectedTweets);
    let failedComments = 0;
    const detailQueryId = await this.resolveQueryId(context.tabId, "TweetDetail", TWEET_DETAIL_QUERY_ID, signal);
    for (const tweet of selectedTweets) {
      throwIfAborted(signal);
      if (commentChars <= 0 || tweet.replies <= 0) continue;
      const fetched = await this.fetchComments(context.tabId, target.origin, tweet.id, detailQueryId, MAX_COMMENT_PAGES, signal);
      if (fetched.failed) failedComments += 1;
      const filtered = fitCommentsToBudget(fetched.comments, Math.max(0, commentChars), MAX_COMMENTS_PER_TWEET, tweet.author);
      if (filtered.length) {
        comments.set(tweet.id, filtered);
        commentChars -= renderComments(filtered).length;
      }
    }
    if (failedComments) warnings.push(`${failedComments} 条 X 帖子的评论接口不可用，已保留其余内容`);
    return this.render(context, title, selectedTweets, comments, warnings);
  }

  private async extractStatus(context: PageContext, target: Extract<TwitterTarget, { kind: "status" }>, signal: AbortSignal): Promise<ExtractedDocument> {
    const warnings: string[] = [];
    const queryId = await this.resolveQueryId(context.tabId, "TweetDetail", TWEET_DETAIL_QUERY_ID, signal);
    let detail: { tweets: TwitterComment[]; failed: boolean };
    try {
      detail = await this.fetchTweetDetail(context.tabId, target.origin, target.tweetId, queryId, MAX_STATUS_COMMENT_PAGES, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push("X 帖子接口不可用，已退回当前页面正文");
      return this.fallback(context, signal, warnings);
    }
    if (!detail.tweets.length) {
      warnings.push("X 帖子接口未返回可读取内容，已退回当前页面正文");
      return this.fallback(context, signal, warnings);
    }
    if (detail.failed) warnings.push("X 帖子评论分页未完整返回，已保留已读取内容");
    const root = detail.tweets.find((tweet) => tweet.id === target.tweetId) ?? detail.tweets[0];
    const title = `@${root.author} 的 X 帖子`;
    const comments = fitCommentsToBudget(selectTweetDescendants(detail.tweets, root.id), remainingCommentChars(context, title, [root]), MAX_STATUS_COMMENTS, root.author);
    return this.render(context, title, [root], new Map([[root.id, comments]]), warnings);
  }

  private async fetchTimeline(tabId: number, origin: string, mode: TwitterTimelineMode, queryId: string, signal: AbortSignal): Promise<TimelineFetchResult> {
    const tweets: TwitterTweet[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let failed = false;
    for (let page = 0; page < MAX_TIMELINE_PAGES && tweets.length < MAX_TIMELINE_TWEETS; page += 1) {
      const url = buildTimelineUrl(origin, queryId, mode, Math.min(20, MAX_TIMELINE_TWEETS - tweets.length), cursor);
      const result = await this.fetchApi(tabId, url, mode === "following" ? "POST" : "GET", signal);
      if (!result.ok || !result.data) {
        if (!tweets.length) throw new AppError("api-unavailable", `X ${mode === "following" ? "Following" : "For you"} 时间线请求失败（HTTP ${result.status || "未知"}）`, { retryable: true });
        failed = true;
        break;
      }
      const parsed = parseTimelinePayload(result.data, seen);
      tweets.push(...parsed.tweets);
      const next = parsed.cursors.find((candidate) => candidate.type === "Bottom")?.value;
      if (!next || next === cursor || !parsed.tweets.length) break;
      cursor = next;
    }
    return { tweets, failed };
  }

  private async fetchComments(tabId: number, origin: string, tweetId: string, queryId: string, maxPages: number, signal: AbortSignal): Promise<CommentFetchResult> {
    const result = await this.fetchTweetDetail(tabId, origin, tweetId, queryId, maxPages, signal);
    const comments = selectTweetDescendants(result.tweets, tweetId);
    return { comments, failed: result.failed };
  }

  private async fetchTweetDetail(tabId: number, origin: string, tweetId: string, queryId: string, maxPages: number, signal: AbortSignal): Promise<{ tweets: TwitterComment[]; failed: boolean }> {
    const tweets: TwitterComment[] = [];
    const seen = new Set<string>();
    const cursors: Array<string | undefined> = [undefined];
    const seenCursors = new Set<string>();
    let failed = false;
    for (let page = 0; page < maxPages && cursors.length; page += 1) {
      const cursor = cursors.shift();
      const url = buildTweetDetailUrl(origin, queryId, tweetId, cursor);
      const result = await this.fetchApi(tabId, url, "GET", signal);
      if (!result.ok || !result.data) {
        failed = true;
        break;
      }
      const parsed = parseTweetDetailPayload(result.data, seen);
      tweets.push(...parsed.tweets);
      for (const next of parsed.cursors) {
        if (next.type !== "Top" && !seenCursors.has(next.value) && next.value !== cursor) {
          seenCursors.add(next.value);
          cursors.push(next.value);
        }
      }
    }
    return { tweets, failed };
  }

  private async detectTimelineMode(tabId: number, signal: AbortSignal): Promise<TwitterTimelineMode> {
    throwIfAborted(signal);
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (): TwitterTimelineMode => {
          const selected = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.toLowerCase() || "";
          if (/following|关注|正在关注/.test(selected)) return "following";
          if (/for you|为你|推荐|recommend/.test(selected)) return "for-you";
          const resources = performance.getEntriesByType("resource").map((entry) => entry.name).reverse();
          const recent = resources.find((url) => url.includes("/HomeLatestTimeline")) || "";
          if (recent) return "following";
          return "for-you";
        },
      }) as unknown as Array<{ result?: TwitterTimelineMode }>;
      return result[0]?.result === "following" ? "following" : "for-you";
    } catch (error) {
      if (signal.aborted) throw error;
      return "for-you";
    }
  }

  private async resolveQueryId(tabId: number, operationName: string, fallback: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (operation: string, defaultId: string): Promise<string> => {
          const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const resources = [...new Set([
            ...Array.from(document.scripts).map((script) => script.src),
            ...performance.getEntriesByType("resource").map((entry) => entry.name),
          ])].filter((url) => url.includes("client-web") && new URL(url, location.href).pathname.endsWith(".js"));
          const patterns = [
            new RegExp(`queryId:["']([A-Za-z0-9_-]+)["'][^}]{0,500}operationName:["']${escaped}["']`),
            new RegExp(`operationName:["']${escaped}["'][^}]{0,500}queryId:["']([A-Za-z0-9_-]+)["']`),
          ];
          for (const url of resources.slice(0, 20)) {
            try {
              const text = await (await fetch(url)).text();
              for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match?.[1]) return match[1];
              }
            } catch {
              // The operation may be in a bundle that is no longer readable.
            }
          }
          return defaultId;
        },
        args: [operationName, fallback],
      }) as unknown as Array<{ result?: string }>;
      return typeof result[0]?.result === "string" && result[0].result ? result[0].result : fallback;
    } catch (error) {
      if (signal.aborted) throw error;
      return fallback;
    }
  }

  private async fetchApi(tabId: number, url: string, method: "GET" | "POST", signal: AbortSignal): Promise<TwitterApiResult> {
    throwIfAborted(signal);
    const result = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (request: { url: string; method: "GET" | "POST"; bearer: string }): Promise<TwitterApiResult> => {
        const csrf = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
        if (!csrf) return { ok: false, status: 401, data: null, error: "missing ct0" };
        try {
          const response = await fetch(request.url, {
            method: request.method,
            credentials: "include",
            headers: {
              Authorization: `Bearer ${decodeURIComponent(request.bearer)}`,
              "X-Csrf-Token": decodeURIComponent(csrf),
              "X-Twitter-Auth-Type": "OAuth2Session",
              "X-Twitter-Active-User": "yes",
              Accept: "application/json",
            },
          });
          const text = await response.text();
          let data: unknown = null;
          try { data = JSON.parse(text) as unknown; } catch { /* login wall or malformed payload */ }
          return { ok: response.ok && data !== null, status: response.status, data, ...(response.ok ? {} : { error: `${response.status} ${response.statusText}` }) };
        } catch (error) {
          return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) };
        }
      },
      args: [{ url, method, bearer: TWITTER_BEARER_TOKEN }],
    }) as unknown as Array<{ result?: TwitterApiResult }>;
    throwIfAborted(signal);
    return result[0]?.result ?? { ok: false, status: 0, data: null, error: "页面脚本没有返回结果" };
  }

  private render(context: PageContext, title: string, tweets: readonly TwitterTweet[], comments: ReadonlyMap<string, readonly TwitterComment[]>, warnings: readonly string[]): ExtractedDocument {
    const markdown = appendWarningSection(renderTwitterContent(context, title, tweets, comments), uniqueWarnings(warnings));
    const imageUrls = uniqueImageUrls(tweets.flatMap((tweet) => [
      ...tweet.imageUrls,
      ...(tweet.quotedTweet?.imageUrls ?? []),
    ]), context.url);
    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      imageUrls,
      uploadFile: createMarkdownFile(title, markdown),
      warnings: uniqueWarnings(warnings),
    };
  }

  private async fallback(context: PageContext, signal: AbortSignal, warnings: string[]): Promise<ExtractedDocument> {
    const document = await new WebpageExtractor().extract(context, signal);
    return { ...document, warnings: uniqueWarnings([...document.warnings, ...warnings]) };
  }
}

export function parseTwitterTargetUrl(value: string): TwitterTarget | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !TWITTER_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if ((parts.length === 0 && url.pathname === "/") || (parts.length === 1 && (parts[0] === "home" || parts[0] === "timeline"))) {
    return { kind: "timeline", origin: url.origin };
  }
  if (parts[0] === "i" && parts[1] === "timeline" && parts.length === 2) return { kind: "timeline", origin: url.origin };
  if (parts.length === 3 && /^\d+$/.test(parts[2]) && parts[1] === "status") {
    return { kind: "status", origin: url.origin, tweetId: parts[2] };
  }
  if (parts.length === 3 && parts[0] === "i" && parts[1] === "status" && /^\d+$/.test(parts[2])) {
    return { kind: "status", origin: url.origin, tweetId: parts[2] };
  }
  return undefined;
}

export function parseTimelinePayload(value: unknown, seen = new Set<string>()): TimelineParseResult {
  const instructions = getTimelineInstructions(value);
  const tweets: TwitterTweet[] = [];
  const cursors: TwitterCursor[] = [];
  for (const instruction of instructions) {
    for (const entry of Array.isArray(instruction?.entries) ? instruction.entries : []) {
      collectTimelineEntry(entry, tweets, cursors, seen);
    }
  }
  return { tweets, cursors: uniqueCursors(cursors) };
}

export function parseTweetDetailPayload(value: unknown, seen = new Set<string>()): TimelineParseResult {
  const instructions = getDetailInstructions(value);
  const tweets: TwitterTweet[] = [];
  const cursors: TwitterCursor[] = [];
  for (const instruction of instructions) {
    for (const entry of Array.isArray(instruction?.entries) ? instruction.entries : []) {
      collectTimelineEntry(entry, tweets, cursors, seen);
    }
  }
  return { tweets, cursors: uniqueCursors(cursors) };
}

export function isLikelyTwitterSpam(tweet: Pick<TwitterTweet, "text" | "bio">, duplicateTexts = new Set<string>()): boolean {
  const text = tweet.text.replace(/\s+/g, " ").trim();
  const normalized = normalizeSpamText(text);
  if (!normalized) return true;
  if (duplicateTexts.has(normalized)) return true;
  duplicateTexts.add(normalized);
  if (/^\p{Extended_Pictographic}{1,24}$/u.test(text)) return true;
  if (/(?:airdrop|giveaway|promo(?:tion)?|casino|betting|free crypto|wallet connect|whatsapp|telegram|discord|dm me|message me|check my profile|follow me|follow back|稳赚|空投|返佣|博彩|加微|私信我|互关|回关|主页.*(?:链接|置顶))/i.test(text)) return true;
  if (/0x[a-f0-9]{20,}|(?:https?:\/\/\S+\s*){2,}/i.test(text)) return true;
  if ((text.match(/https?:\/\//gi) ?? []).length >= 2) return true;
  if ((text.match(/@\w+/g) ?? []).length >= 5 || (text.match(/#\S+/g) ?? []).length >= 7) return true;
  if (text.length < 28 && /^(?:wow|nice|great|awesome|gm|good morning|follow|like|agree|支持|好棒|厉害|顶|绝了)[!.。！～~\s]*$/i.test(text)) return true;
  if (/spam|bot|promo/i.test(tweet.bio) && text.length < 120) return true;
  return false;
}

export const __test__ = {
  buildTimelineUrl,
  buildTweetDetailUrl,
  getTimelineInstructions,
  isLikelyTwitterSpam,
  parseTimelinePayload,
  parseTweetDetailPayload,
  selectTweetDescendants,
};

function getTimelineInstructions(value: unknown): Array<{ entries?: unknown[] }> {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  const home = asRecord(data?.home);
  const timeline = asRecord(home?.home_timeline_urt);
  const nestedTimeline = asRecord(timeline?.timeline);
  const instructions = nestedTimeline?.instructions ?? timeline?.instructions;
  return Array.isArray(instructions) ? instructions as Array<{ entries?: unknown[] }> : [];
}

function getDetailInstructions(value: unknown): Array<{ entries?: unknown[] }> {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  const threaded = asRecord(data?.threaded_conversation_with_injections_v2);
  const threadedTimeline = asRecord(threaded?.timeline);
  const direct = asRecord(data?.tweetResult);
  const directResult = asRecord(direct?.result);
  const directTimeline = asRecord(directResult?.timeline);
  const instructions = threaded?.instructions ?? threadedTimeline?.instructions ?? directTimeline?.instructions;
  return Array.isArray(instructions) ? instructions as Array<{ entries?: unknown[] }> : [];
}

function collectTimelineEntry(value: unknown, tweets: TwitterTweet[], cursors: TwitterCursor[], seen: Set<string>): void {
  const entry = asRecord(value);
  const content = asRecord(entry?.content);
  const cursor = readCursor(entry, content);
  if (cursor) cursors.push(cursor);
  const direct = normalizeTwitterTweet(
    asRecord(asRecord(content?.itemContent)?.tweet_results)?.result
      ?? asRecord(asRecord(asRecord(content?.item)?.itemContent)?.tweet_results)?.result,
    seen,
  );
  if (direct) tweets.push(direct);
  const items = Array.isArray(content?.items) ? content.items : [];
  for (const item of items) {
    const nested = asRecord(asRecord(asRecord(item)?.item)?.itemContent);
    const tweet = normalizeTwitterTweet(asRecord(asRecord(nested)?.tweet_results)?.result, seen);
    if (tweet) tweets.push(tweet);
    const nestedCursor = readCursor(item, asRecord(item));
    if (nestedCursor) cursors.push(nestedCursor);
  }
}

function readCursor(entry: Record<string, unknown> | undefined, content: Record<string, unknown> | undefined): TwitterCursor | undefined {
  const value = typeof content?.value === "string" ? content.value : typeof asRecord(content?.itemContent)?.value === "string" ? asRecord(content?.itemContent)?.value as string : undefined;
  const entryId = typeof entry?.entryId === "string" ? entry.entryId : "";
  const explicitType = typeof content?.cursorType === "string" ? content.cursorType : "";
  const inferredType = entryId.startsWith("cursor-top-")
    ? "Top"
    : entryId.startsWith("cursor-bottom-")
      ? "Bottom"
      : entryId.startsWith("cursor-showMore-")
        ? "ShowMore"
        : "";
  const type = explicitType || inferredType;
  if ((content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor" || entryId.startsWith("cursor-"))
    && (type === "Top" || type === "Bottom" || type.startsWith("ShowMore")) && value) return { value, type };
  return undefined;
}

function normalizeTwitterTweet(value: unknown, seen: Set<string>): TwitterTweet | null {
  const unwrapped = unwrapTweet(value);
  if (!unwrapped) return null;
  const legacy = asRecord(unwrapped.legacy) ?? {};
  const id = typeof unwrapped.rest_id === "string" ? unwrapped.rest_id : typeof legacy.id_str === "string" ? legacy.id_str : "";
  if (!id || seen.has(id)) return null;
  seen.add(id);
  const user = asRecord(asRecord(unwrapped.core)?.user_results)?.result;
  const userLegacy = asRecord(asRecord(user)?.legacy) ?? {};
  const userCore = asRecord(asRecord(user)?.core) ?? {};
  const author = stringValue(userLegacy.screen_name) || stringValue(userCore.screen_name) || "unknown";
  const displayName = stringValue(userLegacy.name) || stringValue(userCore.name) || author;
  const noteText = stringValue(asRecord(asRecord(asRecord(unwrapped.note_tweet)?.note_tweet_results)?.result)?.text);
  const text = noteText || stringValue(legacy.full_text);
  const screenName = author || "unknown";
  const quoted = normalizeQuotedTweet(asRecord(asRecord(unwrapped.quoted_status_result)?.result));
  const media = extractMedia(legacy);
  return {
    id,
    author: screenName,
    displayName,
    bio: stringValue(userLegacy.description),
    text,
    likes: numberValue(legacy.favorite_count),
    retweets: numberValue(legacy.retweet_count),
    replies: numberValue(legacy.reply_count),
    views: numberValue(asRecord(unwrapped.views)?.count),
    createdAt: stringValue(legacy.created_at) || undefined,
    url: `https://x.com/${screenName}/status/${id}`,
    mediaUrls: media.urls,
    imageUrls: media.imageUrls,
    inReplyToId: stringValue(legacy.in_reply_to_status_id_str) || undefined,
    ...(quoted ? { quotedTweet: quoted } : {}),
  };
}

function normalizeQuotedTweet(value: Record<string, unknown> | undefined): TwitterTweet["quotedTweet"] {
  if (!value) return undefined;
  const legacy = asRecord(value.legacy) ?? {};
  const id = stringValue(value.rest_id) || stringValue(legacy.id_str);
  if (!id) return undefined;
  const user = asRecord(asRecord(value.core)?.user_results)?.result;
  const userLegacy = asRecord(asRecord(user)?.legacy) ?? {};
  const userCore = asRecord(asRecord(user)?.core) ?? {};
  const author = stringValue(userLegacy.screen_name) || stringValue(userCore.screen_name) || "unknown";
  const media = extractMedia(legacy);
  return {
    id,
    author,
    displayName: stringValue(userLegacy.name) || stringValue(userCore.name) || author,
    text: stringValue(asRecord(asRecord(asRecord(value.note_tweet)?.note_tweet_results)?.result)?.text) || stringValue(legacy.full_text),
    url: `https://x.com/${author}/status/${id}`,
    mediaUrls: media.urls,
    imageUrls: media.imageUrls,
  };
}

function unwrapTweet(value: unknown): Record<string, unknown> | undefined {
  let current = asRecord(value);
  for (let index = 0; index < 3 && current; index += 1) {
    const nested = asRecord(current.tweet);
    if (nested) current = nested;
    else if (current.__typename === "TweetWithVisibilityResults") current = asRecord(current.tweet);
    else break;
  }
  return current;
}

function extractMedia(legacy: Record<string, unknown>): { urls: string[]; imageUrls: string[] } {
  const extended = asRecord(legacy.extended_entities);
  const entities = asRecord(legacy.entities);
  const media = Array.isArray(extended?.media) ? extended.media : Array.isArray(entities?.media) ? entities.media : [];
  const urls: string[] = [];
  const imageUrls: string[] = [];
  for (const item of media) {
    const record = asRecord(item);
    const type = stringValue(record?.type);
    const thumb = stringValue(record?.media_url_https);
    if (thumb) imageUrls.push(thumb);
    if (type === "photo") {
      if (thumb) urls.push(thumb);
      continue;
    }
    const variants = asRecord(record?.video_info)?.variants;
    const mp4 = (Array.isArray(variants) ? variants : [])
      .map((variant) => asRecord(variant))
      .filter((variant) => stringValue(variant?.content_type) === "video/mp4")
      .sort((left, right) => numberValue(right?.bitrate) - numberValue(left?.bitrate))[0];
    const mediaUrl = stringValue(mp4?.url) || thumb;
    if (mediaUrl) urls.push(mediaUrl);
  }
  return { urls: uniqueStrings(urls), imageUrls: uniqueStrings(imageUrls) };
}

function selectTweetDescendants(tweets: readonly TwitterTweet[], rootId: string): TwitterComment[] {
  const descendantIds = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tweet of tweets) {
      if (!descendantIds.has(tweet.id) && tweet.inReplyToId && descendantIds.has(tweet.inReplyToId)) {
        descendantIds.add(tweet.id);
        changed = true;
      }
    }
  }
  return tweets.filter((tweet) => tweet.id !== rootId && descendantIds.has(tweet.id));
}

function fitTweetsToBudget(context: PageContext, title: string, tweets: readonly TwitterTweet[]): TwitterTweet[] {
  const selected: TwitterTweet[] = [];
  for (const tweet of tweets) {
    const candidate = [...selected, tweet];
    if (selected.length && renderTwitterContent(context, title, candidate, new Map()).length > MAX_SOURCE_CHARS) break;
    selected.push(tweet);
  }
  return selected;
}

function remainingCommentChars(context: PageContext, title: string, tweets: readonly TwitterTweet[]): number {
  return Math.max(0, MAX_SOURCE_CHARS - renderTwitterContent(context, title, tweets, new Map()).length);
}

function fitCommentsToBudget(comments: readonly TwitterComment[], maxChars: number, maxCount = MAX_COMMENTS_PER_TWEET, exemptAuthor?: string): TwitterComment[] {
  const duplicateTexts = new Set<string>();
  const selected: TwitterComment[] = [];
  for (const comment of comments) {
    if (selected.length >= maxCount || (comment.author !== exemptAuthor && isLikelyTwitterSpam(comment, duplicateTexts))) continue;
    const candidate = [...selected, comment];
    if (renderComments(candidate).length > maxChars) break;
    selected.push(comment);
  }
  return selected;
}

function renderTwitterContent(context: PageContext, title: string, tweets: readonly TwitterTweet[], comments: ReadonlyMap<string, readonly TwitterComment[]>): string {
  const sections: string[] = [`# ${title}`, `来源：${context.url}`];
  tweets.forEach((tweet, index) => {
    const metadata = [
      `@${tweet.author}`,
      tweet.displayName && tweet.displayName !== tweet.author ? tweet.displayName : "",
      formatDate(tweet.createdAt),
      `${tweet.likes} 赞同`,
      `${tweet.retweets} 转发`,
      `${tweet.replies} 回复`,
      tweet.views ? `${tweet.views} 浏览` : "",
    ].filter(Boolean).join(" · ");
    const media = tweet.mediaUrls.length ? `\n\n媒体：${tweet.mediaUrls.map((url) => `[${url}](${url})`).join("、")}` : "";
    const quote = tweet.quotedTweet ? `\n\n> 引用 @${tweet.quotedTweet.author}：${tweet.quotedTweet.text}` : "";
    const commentText = renderComments(comments.get(tweet.id) ?? []);
    sections.push(`## ${tweets.length === 1 ? "帖子" : `帖子 ${index + 1}`} · ${metadata}\n\n${tweet.text || "（帖子正文为空）"}${quote}${media}\n\n原帖：${tweet.url}${commentText}`);
  });
  return sections.join("\n\n").trim();
}

function renderComments(comments: readonly TwitterComment[]): string {
  if (!comments.length) return "";
  return `\n\n### 评论区（已读取 ${comments.length} 条，已过滤疑似 spam）\n\n${comments.map((comment, index) => {
    const metadata = [`@${comment.author}`, formatDate(comment.createdAt), `${comment.likes} 赞同`, `${comment.retweets} 转发`].filter(Boolean).join(" · ");
    return `#### 评论 ${index + 1} · ${metadata}\n\n${comment.text || "（评论正文为空）"}\n\n原评论：${comment.url}`;
  }).join("\n\n")}`;
}

function buildTimelineUrl(origin: string, queryId: string, mode: TwitterTimelineMode, count: number, cursor?: string): string {
  const variables: Record<string, unknown> = { count, includePromotedContent: false, latestControlAvailable: true, requestContext: "launch" };
  if (mode === "for-you") variables.withCommunity = true;
  else variables.seenTweetIds = [];
  if (cursor) variables.cursor = cursor;
  const endpoint = mode === "following" ? "HomeLatestTimeline" : "HomeTimeline";
  const methodless = `${origin}/i/api/graphql/${queryId}/${endpoint}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(TIMELINE_FEATURES))}`;
  return methodless;
}

function buildTweetDetailUrl(origin: string, queryId: string, tweetId: string, cursor?: string): string {
  const variables: Record<string, unknown> = {
    focalTweetId: tweetId,
    referrer: "tweet",
    with_rux_injections: false,
    includePromotedContent: false,
    rankingMode: "Recency",
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
  };
  if (cursor) variables.cursor = cursor;
  return `${origin}/i/api/graphql/${queryId}/TweetDetail?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(DETAIL_FEATURES))}&fieldToggles=${encodeURIComponent(JSON.stringify(DETAIL_FIELD_TOGGLES))}`;
}

function normalizeSpamText(value: string): string {
  return value.toLowerCase().replace(/https?:\/\/\S+/g, "<url>").replace(/@\w+/g, "<mention>").replace(/\s+/g, " ").trim();
}

function uniqueWarnings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueCursors(values: readonly TwitterCursor[]): TwitterCursor[] {
  const seen = new Set<string>();
  return values.filter((cursor) => {
    const key = `${cursor.type}\u0000${cursor.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}
