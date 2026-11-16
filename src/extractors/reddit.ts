import { AppError } from "../domain/errors";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { fetchPageJson, type PageJsonResult } from "../platform/chrome/page-json";
import { throwIfAborted } from "../shared/abort";
import {
  appendWarningSection,
  cleanInline,
  createMarkdownFile,
  type DiscussionItem,
  formatDate,
  renderDiscussionItem,
} from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { WebpageExtractor } from "./webpage";

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "sh.reddit.com"]);
const MAX_SOURCE_CHARS = 120_000;
const MAX_COMMENTS = 60;
const MAX_REPLY_DEPTH = 3;

export interface RedditTarget {
  origin: string;
  subreddit: string;
  postId: string;
  permalink: string;
}

export interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  selftext: string;
  url?: string;
  score?: number;
  numComments?: number;
  createdAt?: string;
}

export function parseRedditTargetUrl(rawUrl: string): RedditTarget | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !REDDIT_HOSTS.has(url.hostname.toLowerCase())) {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  // Matches /r/:subreddit/comments/:postId/...
  if (parts[0] === "r" && parts[1] && parts[2] === "comments" && parts[3]) {
    return {
      origin: url.origin,
      subreddit: parts[1],
      postId: parts[3],
      permalink: url.pathname,
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRedditPostData(payload: unknown, fallbackSubreddit: string): { post?: RedditPost; comments: DiscussionItem[] } {
  if (!Array.isArray(payload) || payload.length === 0) {
    return { comments: [] };
  }

  const postListing = payload[0];
  const commentListing = payload[1];

  let post: RedditPost | undefined;
  if (isRecord(postListing) && isRecord(postListing.data) && Array.isArray(postListing.data.children)) {
    const postChild = postListing.data.children[0];
    if (isRecord(postChild) && isRecord(postChild.data)) {
      const data = postChild.data;
      const id = typeof data.id === "string" ? data.id : "";
      const title = typeof data.title === "string" ? data.title.trim() : "";
      const author = typeof data.author === "string" ? data.author.trim() : "未知用户";
      const subreddit = typeof data.subreddit === "string" ? data.subreddit : fallbackSubreddit;
      const selftext = typeof data.selftext === "string" ? data.selftext.trim() : "";
      const url = typeof data.url === "string" ? data.url : undefined;
      const score = typeof data.score === "number" ? data.score : typeof data.ups === "number" ? data.ups : undefined;
      const numComments = typeof data.num_comments === "number" ? data.num_comments : undefined;
      const createdAt = typeof data.created_utc === "number" ? new Date(data.created_utc * 1000).toISOString() : undefined;

      post = { id, title, author, subreddit, selftext, url, score, numComments, createdAt };
    }
  }

  const comments: DiscussionItem[] = [];
  if (isRecord(commentListing) && isRecord(commentListing.data) && Array.isArray(commentListing.data.children)) {
    collectRedditComments(commentListing.data.children, comments, undefined, 0);
  }

  return { post, comments };
}

function collectRedditComments(
  children: unknown[],
  out: DiscussionItem[],
  parentAuthor?: string,
  depth = 0,
): void {
  if (depth > MAX_REPLY_DEPTH || out.length >= MAX_COMMENTS) return;

  for (const child of children) {
    if (out.length >= MAX_COMMENTS) break;
    if (!isRecord(child) || child.kind !== "t1" || !isRecord(child.data)) continue;

    const data = child.data;
    const body = typeof data.body === "string" ? data.body.trim() : "";
    if (!body || body === "[deleted]" || body === "[removed]") continue;

    const id = typeof data.id === "string" ? data.id : String(out.length + 1);
    const author = typeof data.author === "string" ? cleanInline(data.author) : "未知用户";
    const score = typeof data.score === "number" ? data.score : typeof data.ups === "number" ? data.ups : undefined;
    const createdAt = typeof data.created_utc === "number" ? new Date(data.created_utc * 1000).toISOString() : undefined;

    out.push({
      id,
      author,
      body,
      likes: score,
      createdAt,
      ordinal: out.length + 1,
      replyTo: parentAuthor,
    });

    if (isRecord(data.replies) && isRecord(data.replies.data) && Array.isArray(data.replies.data.children)) {
      collectRedditComments(data.replies.data.children, out, author, depth + 1);
    }
  }
}

export function formatRedditMarkdown(
  post: RedditPost,
  comments: readonly DiscussionItem[],
  warnings: readonly string[],
): string {
  const meta = [
    `@${cleanInline(post.author)}`,
    `r/${cleanInline(post.subreddit)}`,
    formatDate(post.createdAt),
    post.score != null ? `${post.score} upvotes` : "",
    post.numComments != null ? `${post.numComments} 条评论` : "",
  ].filter(Boolean).join(" · ");

  const sections: string[] = [`# ${post.title || "Reddit 讨论"}`];
  if (meta) {
    sections.push(`> ${meta}`);
  }

  if (post.selftext) {
    sections.push(post.selftext);
  } else if (post.url && !post.url.includes(post.id)) {
    sections.push(`🔗 关联链接：[${post.url}](${post.url})`);
  }

  if (comments.length) {
    sections.push(`## 讨论精选（共 ${comments.length} 条评论）`);
    for (const comment of comments) {
      sections.push(renderDiscussionItem(comment, `评论 ${comment.ordinal ?? ""}`.trim()));
    }
  }

  return appendWarningSection(sections.join("\n\n").trim(), warnings);
}

export class RedditExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "reddit",
    label: "Reddit",
    outputKind: "webpage",
  };

  private readonly fallbackExtractor = new WebpageExtractor();

  canHandle(context: PageContext): boolean {
    return Boolean(parseRedditTargetUrl(context.url));
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    const target = parseRedditTargetUrl(context.url);
    if (!target) throw new AppError("unsupported-page", "无效的 Reddit 讨论页面地址");

    const warnings: string[] = [];
    const cleanPath = target.permalink.replace(/\/+$/, "");
    const jsonUrl = `${target.origin}${cleanPath}.json?limit=${MAX_COMMENTS}&depth=${MAX_REPLY_DEPTH}&raw_json=1`;

    let result: PageJsonResult;
    try {
      result = await fetchPageJson(context.tabId, jsonUrl, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push("Reddit 接口读取失败，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    if (!result.ok || !result.data) {
      warnings.push("Reddit 接口未返回数据，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    const { post, comments } = parseRedditPostData(result.data, target.subreddit);
    if (!post) {
      warnings.push("未能解析出 Reddit 主帖正文，已退回普通网页正文提取");
      return this.fallback(context, signal, warnings);
    }

    // Budget enforcement
    const selectedComments = this.fitCommentsToBudget(post, comments);
    if (selectedComments.length < comments.length) {
      warnings.push("讨论内容达到字符预算上限，部分较后评论已省略");
    }

    const title = post.title || context.title || "Reddit 讨论";
    const markdown = formatRedditMarkdown(post, selectedComments, warnings);

    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: createMarkdownFile(title, markdown),
      warnings,
    };
  }

  private fitCommentsToBudget(post: RedditPost, comments: readonly DiscussionItem[]): DiscussionItem[] {
    const postLen = (post.title?.length ?? 0) + (post.selftext?.length ?? 0) + 500;
    let remaining = Math.max(0, MAX_SOURCE_CHARS - postLen);
    const selected: DiscussionItem[] = [];

    for (const comment of comments) {
      const itemLen = comment.body.length + 150;
      if (remaining - itemLen < 0 && selected.length > 0) {
        break;
      }
      remaining -= itemLen;
      selected.push(comment);
    }

    return selected;
  }

  private async fallback(context: PageContext, signal: AbortSignal, warnings: string[]): Promise<ExtractedDocument> {
    const doc = await this.fallbackExtractor.extract(context, signal);
    return {
      ...doc,
      warnings: [...warnings, ...doc.warnings],
    };
  }
}
