import { browser } from "wxt/browser";
import type { DiscourseTopicRef } from "../domain/discourse";
import {
  discoursePostsUrl,
  discourseRepliesUrl,
  discourseTopicJsonUrl,
  parseDiscourseTopicUrl,
} from "../domain/discourse";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { withAbort, throwIfAborted } from "../shared/abort";
import { cleanHtmlForUpload, htmlToMarkdown } from "./html";
import { createMarkdownFile, formatDate } from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { WebpageExtractor } from "./webpage";
import { fetchPageJson, type PageJsonResult } from "../platform/chrome/page-json";

const SHORT_TOPIC_POSTS = 50;
const MAX_POSTS = 200;
const MAX_DISCUSSION_CHARS = 160_000;
const REPLY_EXPANSIONS = 30;
const POST_BATCH_SIZE = 20;

interface DiscoursePost {
  id: string;
  postNumber: number;
  author: string;
  body: string;
  likes?: number;
  score?: number;
  replyCount?: number;
  replyToPostNumber?: number;
  createdAt?: string;
}

interface DiscoursePayload {
  title: string;
  posts: DiscoursePost[];
  streamIds: string[];
}

interface ProbeResult {
  sameTopic: boolean;
  discourseMarker: boolean;
}

export class DiscourseExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "discourse",
    label: "Discourse 论坛",
    outputKind: "webpage",
  };

  private readonly probeCache = new Map<string, DiscoursePayload>();

  canHandle(context: PageContext): boolean {
    return Boolean(parseDiscourseTopicUrl(context.url));
  }

  async probe(context: PageContext, signal: AbortSignal): Promise<boolean> {
    const ref = parseDiscourseTopicUrl(context.url);
    if (!ref) return false;
    throwIfAborted(signal);
    let page: ProbeResult;
    try {
      page = await readDiscoursePageMarkers(context.tabId, ref, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // A restricted/incomplete page may reject the DOM probe even though its
      // same-origin topic JSON is available; let the API shape decide.
      page = { sameTopic: true, discourseMarker: false };
    }
    if (!page.sameTopic) return false;
    const topicUrl = discourseTopicJsonUrl(ref, { include_raw: "true" });
    let topicResult: PageJsonResult;
    try {
      topicResult = await fetchPageJson(context.tabId, topicUrl, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return page.discourseMarker;
    }
    const payload = normalizePayload(topicResult.data);
    if (payload) this.probeCache.set(this.cacheKey(context), payload);
    return Boolean(payload || page.discourseMarker);
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    const ref = parseDiscourseTopicUrl(context.url);
    if (!ref) throw new Error("Invalid Discourse URL");
    const warnings: string[] = [];
    let payload = this.probeCache.get(this.cacheKey(context));
    this.probeCache.delete(this.cacheKey(context));
    if (!payload) {
      const result = await this.fetchJson(context.tabId, discourseTopicJsonUrl(ref, { include_raw: "true" }), signal, false);
      payload = normalizePayload(result.data);
      if (!payload) {
        warnings.push("Discourse 主题接口未返回可识别的主题数据，已退回读取当前页面正文");
        return this.fallback(context, signal, warnings);
      }
    }

    const totalStream = payload.streamIds;
    const posts = new Map<string, DiscoursePost>();
    payload.posts.forEach((post) => posts.set(post.id, post));
    const mainId = payload.posts.find((post) => post.postNumber === 1)?.id ?? payload.streamIds[0];
    let selectedIds = totalStream.slice();
    let summaryMode = false;

    if (totalStream.length > SHORT_TOPIC_POSTS) {
      summaryMode = true;
      const summaryResult = await this.fetchJson(
        context.tabId,
        discourseTopicJsonUrl(ref, { filter: "summary", include_raw: "true" }),
        signal,
        true,
      );
      const summary = normalizePayload(summaryResult.data);
      if (summary) {
        selectedIds = summary.streamIds.length ? summary.streamIds : summary.posts.map((post) => post.id);
        summary.posts.forEach((post) => posts.set(post.id, post));
        warnings.push(`主题较长，按 Discourse 热门摘要选取 ${selectedIds.length} 个帖子`);
      } else {
        selectedIds = totalStream.slice(0, MAX_POSTS);
        warnings.push("Discourse 热门摘要接口不可用，已按主题顺序截取部分帖子");
      }
    }

    if (mainId) selectedIds = [mainId, ...selectedIds.filter((id) => id !== mainId)];
    selectedIds = unique(selectedIds).slice(0, MAX_POSTS);
    if (selectedIds.length < totalStream.length) {
      warnings.push(`主题共有约 ${totalStream.length} 个帖子，本次读取 ${selectedIds.length} 个`);
    }
    const selectedSet = new Set(selectedIds);
    for (const id of posts.keys()) {
      if (!selectedSet.has(id)) posts.delete(id);
    }
    await this.fetchMissingPosts(context.tabId, ref, selectedIds, posts, signal, warnings);
    if (!posts.size) {
      warnings.push("Discourse 主题帖子正文为空，已退回读取当前页面正文");
      return this.fallback(context, signal, warnings);
    }

    if (summaryMode) {
      const candidates = [...posts.values()]
        .filter((post) => post.postNumber !== 1 && (post.replyCount ?? 0) > 0)
        .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity)
          || (right.likes ?? 0) - (left.likes ?? 0)
          || left.postNumber - right.postNumber)
        .slice(0, REPLY_EXPANSIONS);
      for (const candidate of candidates) {
        if (posts.size >= MAX_POSTS) break;
        const result = await this.fetchJson(context.tabId, discourseRepliesUrl(ref, candidate.id), signal, true);
        const replies = extractPosts(result.data);
        if (!replies.length) {
          if (!result.ok) warnings.push("部分热门帖子的回复接口不可用，已保留其余讨论");
          continue;
        }
        replies.forEach((raw) => {
          const post = normalizePost(raw);
          if (post && posts.size < MAX_POSTS) posts.set(post.id, post);
        });
      }
      if (candidates.length) warnings.push(`已为 ${candidates.length} 个热门帖子展开直接回复`);
    }

    const ordered = [...posts.values()].sort((left, right) => left.postNumber - right.postNumber).slice(0, MAX_POSTS);
    const document = this.render(context, payload.title, ordered, totalStream.length, warnings);
    return document;
  }

  private async fetchMissingPosts(
    tabId: number,
    ref: DiscourseTopicRef,
    ids: readonly string[],
    posts: Map<string, DiscoursePost>,
    signal: AbortSignal,
    warnings: string[],
  ): Promise<void> {
    const missing = ids.filter((id) => !posts.has(id));
    for (let offset = 0; offset < missing.length; offset += POST_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + POST_BATCH_SIZE);
      const result = await this.fetchJson(tabId, discoursePostsUrl(ref, batch), signal, true);
      const found = extractPosts(result.data);
      if (!found.length) {
        warnings.push(`有 ${batch.length} 个帖子无法读取`);
        continue;
      }
      found.forEach((raw) => {
        const post = normalizePost(raw);
        if (post) posts.set(post.id, post);
      });
    }
  }

  private async fetchJson(
    tabId: number,
    url: string,
    signal: AbortSignal,
    partial: boolean,
  ): Promise<PageJsonResult> {
    throwIfAborted(signal);
    try {
      const result = await fetchPageJson(tabId, url, signal);
      if (!result.ok && !partial) return result;
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, status: 0, data: null, contentType: "", error: String(error) };
    }
  }

  private render(
    context: PageContext,
    title: string,
    posts: readonly DiscoursePost[],
    streamLength: number,
    warnings: string[],
  ): ExtractedDocument {
    const main = posts.find((post) => post.postNumber === 1);
    const comments = posts.filter((post) => post.postNumber !== 1);
    let discussionChars = 0;
    const sections: string[] = [`# ${title || context.title || "Discourse 主题"}`, `来源：${context.url}`];
    if (main) {
      const body = limitBody(main.body, MAX_DISCUSSION_CHARS);
      discussionChars += body.length;
      sections.push(`## 主楼\n\n${renderPost(main)}\n\n${body}`);
    }
    const renderedComments: string[] = [];
    let budgetReached = false;
    for (const post of comments) {
      const body = post.body.trim();
      if (discussionChars + body.length > MAX_DISCUSSION_CHARS) {
        warnings.push("讨论正文达到安全字符上限，后续帖子未展开");
        budgetReached = true;
        break;
      }
      discussionChars += body.length;
      renderedComments.push(`${renderPost(post)}\n\n${body}`);
    }
    const streamOmitted = streamLength > posts.length;
    if (streamOmitted) warnings.push(`仍有 ${streamLength - posts.length} 个帖子未展开`);
    if (renderedComments.length || streamOmitted || budgetReached) {
      const omission = streamOmitted || budgetReached
        ? "\n\n> 其余讨论因热门筛选或安全上限未展开。"
        : "";
      sections.push(`## 讨论\n\n${renderedComments.join("\n\n")}${omission}`);
    }
    const markdown = sections.join("\n\n").trim();
    return {
      kind: "webpage",
      title: title || context.title || "Discourse 主题",
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: createMarkdownFile(title || context.title || "Discourse 主题", markdown),
      warnings: unique(warnings),
    };
  }

  private async fallback(context: PageContext, signal: AbortSignal, warnings: string[]): Promise<ExtractedDocument> {
    const document = await new WebpageExtractor().extract(context, signal);
    return { ...document, warnings: unique([...document.warnings, ...warnings]) };
  }

  private cacheKey(context: PageContext): string {
    return `${context.tabId}:${context.url}`;
  }
}

function renderPost(post: DiscoursePost): string {
  const metadata = [
    `#${post.postNumber}`,
    `@${post.author}`,
    formatDate(post.createdAt),
    typeof post.likes === "number" ? `${post.likes} 赞` : "",
    post.replyToPostNumber ? `回复 #${post.replyToPostNumber}` : "",
  ].filter(Boolean).join(" · ");
  return `### ${metadata}`;
}

function normalizePayload(value: unknown): DiscoursePayload | undefined {
  if (!isRecord(value)) return undefined;
  const postStream = isRecord(value.post_stream) ? value.post_stream : undefined;
  const posts = extractPosts(postStream?.posts ?? value.posts);
  const streamIdsFromResponse = Array.isArray(postStream?.stream)
    ? postStream.stream.map(toId).filter((id): id is string => Boolean(id))
    : [];
  const streamIds = streamIdsFromResponse.length
    ? streamIdsFromResponse
    : posts.map((post) => String((isRecord(post) && (post.id ?? "")) || "")).filter(Boolean);
  if (!posts.length && !streamIds.length) return undefined;
  return {
    title: typeof value.title === "string" ? value.title.trim() : "",
    posts: posts.map(normalizePost).filter((post): post is DiscoursePost => Boolean(post)),
    streamIds: unique(streamIds),
  };
}

function extractPosts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.posts)) return value.posts;
  if (isRecord(value) && isRecord(value.post_stream) && Array.isArray(value.post_stream.posts)) return value.post_stream.posts;
  return [];
}

function normalizePost(value: unknown): DiscoursePost | undefined {
  if (!isRecord(value)) return undefined;
  const id = toId(value.id);
  const postNumber = toPositiveInt(value.post_number);
  if (!id || !postNumber) return undefined;
  const raw = typeof value.raw === "string" ? value.raw.trim() : "";
  const cooked = typeof value.cooked === "string" ? value.cooked : "";
  const body = raw || htmlToMarkdown(cleanHtmlForUpload(cooked));
  return {
    id,
    postNumber,
    author: typeof value.display_username === "string" && value.display_username.trim()
      ? value.display_username.trim()
      : typeof value.username === "string" ? value.username.trim() : "未知用户",
    body,
    likes: toNonNegativeInt(value.like_count),
    score: typeof value.score === "number" ? value.score : undefined,
    replyCount: toNonNegativeInt(value.reply_count),
    replyToPostNumber: toPositiveInt(value.reply_to_post_number),
    createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
  };
}

function toId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function limitBody(body: string, limit: number): string {
  return body.length > limit ? `${body.slice(0, limit)}\n\n（正文已按安全上限截断）` : body;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

async function readDiscoursePageMarkers(tabId: number, ref: DiscourseTopicRef, signal: AbortSignal): Promise<ProbeResult> {
  const result = await withAbort(browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (origin: string, basePath: string, topicId: string) => {
      const current = new URL(location.href);
      const sameTopic = current.origin === origin
        && current.pathname.includes(`${basePath}/t/`)
        && current.pathname.split("/").includes(topicId);
      const discourseMarker = Boolean(
        document.querySelector("meta[name='generator'][content*='Discourse' i]")
        || document.querySelector("[data-discourse-setup], meta[name='discourse-base-uri']")
        || ("Discourse" in window),
      );
      return { sameTopic, discourseMarker };
    },
    args: [ref.origin, ref.basePath, ref.topicId],
  }) as Promise<Array<{ result?: ProbeResult }>>, signal);
  return result[0]?.result ?? { sameTopic: false, discourseMarker: false };
}
