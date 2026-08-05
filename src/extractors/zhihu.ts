import type { ExtractedDocument, PageContext } from "../domain/types";
import { throwIfAborted } from "../shared/abort";
import { cleanHtmlForUpload, htmlToMarkdown } from "./html";
import { appendWarningSection, cleanInline, createMarkdownFile, formatDate } from "./discussion";
import type { ContentExtractor, ExtractorDescriptor } from "./extractor";
import { WebpageExtractor } from "./webpage";
import { fetchPageJson, type PageJsonResult } from "../platform/chrome/page-json";

const ZHIHU_HOSTS = new Set(["zhihu.com", "www.zhihu.com"]);
const QUESTION_ANSWER_LIMIT = 20;
const QUESTION_COMMENT_LIMIT = 20;
const ANSWER_COMMENT_LIMIT = 100;
const REPLY_LIMIT = 5;
const COMMENT_PAGE_LIMIT = 10;
const MAX_SOURCE_CHARS = 120_000;

interface ZhihuTarget {
  kind: "question" | "answer";
  origin: string;
  questionId?: string;
  answerId?: string;
}

interface ZhihuAnswer {
  id: string;
  body: string;
  author: string;
  likes?: number;
  commentCount?: number;
  createdAt?: string;
  updatedAt?: string;
  questionId?: string;
  questionTitle?: string;
}

interface ZhihuComment {
  id: string;
  body: string;
  author: string;
  likes?: number;
  createdAt?: string;
  replyToId?: string;
  replyToAuthor?: string;
  isReply: boolean;
}

interface CommentLimits {
  top: number;
  replies: number;
  maxChars: number;
}

export class ZhihuExtractor implements ContentExtractor {
  readonly descriptor: ExtractorDescriptor = {
    id: "zhihu",
    label: "知乎",
    outputKind: "webpage",
  };

  canHandle(context: PageContext): boolean {
    return Boolean(parseZhihuTargetUrl(context.url));
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    throwIfAborted(signal);
    const target = parseZhihuTargetUrl(context.url);
    if (!target) throw new Error("Invalid Zhihu URL");
    const warnings: string[] = [];

    if (target.kind === "answer" && target.answerId) {
      const answer = await this.fetchAnswer(context.tabId, target.origin, target.answerId, signal);
      if (!answer) {
        warnings.push("知乎回答接口未返回完整数据，已退回读取当前页面正文");
        return this.fallback(context, signal, warnings);
      }
      const title = answer.questionTitle || context.title || "知乎回答";
      const maxChars = remainingCommentChars(context, title, [answer]);
      const comments = maxChars > 0
        ? await this.fetchComments(context.tabId, target.origin, answer.id, { top: ANSWER_COMMENT_LIMIT, replies: REPLY_LIMIT, maxChars }, signal, warnings)
        : [];
      return this.render(context, title, answer ? [answer] : [], new Map([[answer.id, comments]]), warnings);
    }

    if (!target.questionId) throw new Error("Invalid Zhihu question URL");
    const question = await this.fetchQuestion(context.tabId, target.origin, target.questionId, signal);
    const answers = await this.fetchAnswers(context.tabId, target.origin, target.questionId, signal, warnings);
    if (!answers.length) {
      warnings.push("知乎问题回答接口未返回可读取的回答，已退回读取当前页面正文");
      return this.fallback(context, signal, warnings);
    }
    const title = question?.title || answers.find((answer) => answer.questionTitle)?.questionTitle || context.title || "知乎问题";
    const selectedAnswers = fitAnswersToBudget(context, title, answers.slice(0, QUESTION_ANSWER_LIMIT), question?.detail);
    const comments = new Map<string, ZhihuComment[]>();
    let commentChars = remainingCommentChars(context, title, selectedAnswers, question?.detail);
    for (const answer of selectedAnswers) {
      if (commentChars <= 0) break;
      const answerComments = await this.fetchComments(
        context.tabId,
        target.origin,
        answer.id,
        { top: QUESTION_COMMENT_LIMIT, replies: REPLY_LIMIT, maxChars: commentChars },
        signal,
        warnings,
      );
      comments.set(answer.id, answerComments);
      commentChars -= renderComments(answerComments).length;
    }
    return this.render(context, title, selectedAnswers, comments, warnings, question?.detail);
  }

  private async fetchAnswer(tabId: number, origin: string, answerId: string, signal: AbortSignal): Promise<ZhihuAnswer | undefined> {
    const include = "content,voteup_count,comment_count,author,created_time,updated_time,question";
    const result = await this.fetchJson(tabId, `${origin}/api/v4/answers/${encodeURIComponent(answerId)}?include=${include}`, signal);
    return result.ok ? normalizeAnswer(result.data) : undefined;
  }

  private async fetchAnswers(tabId: number, origin: string, questionId: string, signal: AbortSignal, warnings: string[]): Promise<ZhihuAnswer[]> {
    const include = "data[*].content,url,voteup_count,comment_count,author,created_time,updated_time,question";
    let next = `${origin}/api/v4/questions/${encodeURIComponent(questionId)}/answers?limit=${QUESTION_ANSWER_LIMIT}&offset=0&sort_by=default&include=${encodeURIComponent(include)}`;
    const answers: ZhihuAnswer[] = [];
    const ids = new Set<string>();
    for (let page = 0; page < COMMENT_PAGE_LIMIT && next; page += 1) {
      const result = await this.fetchJson(tabId, next, signal);
      if (!result.ok || !isRecord(result.data)) {
        if (!answers.length) warnings.push("知乎回答列表请求失败");
        else warnings.push("知乎回答列表分页中断，保留已读取的回答");
        break;
      }
      const data = Array.isArray(result.data.data) ? result.data.data : [];
      data.forEach((item) => {
        const answer = normalizeAnswer(item);
        if (answer && !ids.has(answer.id)) {
          ids.add(answer.id);
          answers.push(answer);
        }
      });
      const candidate = isRecord(result.data.paging) && typeof result.data.paging.next === "string"
        ? result.data.paging.next
        : "";
      const validated = validateZhihuAnswersNext(candidate, origin, questionId);
      if (candidate && !validated) warnings.push("知乎回答列表包含不属于当前问题的分页地址，已停止分页");
      next = validated;
      if (answers.length >= QUESTION_ANSWER_LIMIT) {
        next = "";
        break;
      }
    }
    if (next) warnings.push("知乎回答列表达到分页安全上限，保留已读取回答");
    return answers;
  }

  private async fetchQuestion(tabId: number, origin: string, questionId: string, signal: AbortSignal): Promise<{ title?: string; detail?: string } | undefined> {
    const result = await this.fetchJson(tabId, `${origin}/api/v4/questions/${encodeURIComponent(questionId)}?include=detail,title`, signal);
    if (!result.ok || !isRecord(result.data)) return undefined;
    const title = typeof result.data.title === "string" ? result.data.title.trim() : undefined;
    const detail = typeof result.data.detail === "string" ? toMarkdown(result.data.detail) : undefined;
    return title || detail ? { title, detail } : undefined;
  }

  private async fetchComments(
    tabId: number,
    origin: string,
    answerId: string,
    limits: CommentLimits,
    signal: AbortSignal,
    warnings: string[],
  ): Promise<ZhihuComment[]> {
    const pageSize = Math.min(20, limits.top);
    let next = `${origin}/api/v4/answers/${encodeURIComponent(answerId)}/comments?order=normal&limit=${pageSize}&offset=0&status=open`;
    const all: ZhihuComment[] = [];
    const ids = new Set<string>();
    for (let page = 0; page < COMMENT_PAGE_LIMIT && next; page += 1) {
      const result = await this.fetchJson(tabId, next, signal);
      if (!result.ok || !isRecord(result.data)) {
        warnings.push(`回答 ${answerId} 的评论读取在第 ${page + 1} 页中断`);
        break;
      }
      const data = Array.isArray(result.data.data) ? result.data.data : [];
      data.flatMap((item) => flattenComment(item)).forEach((comment) => {
        if (!ids.has(comment.id)) {
          ids.add(comment.id);
          all.push(comment);
        }
      });
      const candidate = isRecord(result.data.paging) && typeof result.data.paging.next === "string"
        ? result.data.paging.next
        : "";
      const validated = validateZhihuCommentsNext(candidate, origin, answerId);
      if (candidate && !validated) warnings.push(`回答 ${answerId} 的评论分页地址不匹配，已停止分页`);
      next = validated;
      const selected = selectComments(all, limits);
      if (selected.filter((comment) => !comment.isReply).length >= limits.top || renderComments(selected).length >= limits.maxChars) {
        next = "";
        break;
      }
    }
    if (next) warnings.push(`回答 ${answerId} 的评论达到分页安全上限，保留已读取内容`);

    return fitCommentsToBudget(selectComments(all, limits), limits.maxChars);
  }

  private async fetchJson(tabId: number, url: string, signal: AbortSignal): Promise<PageJsonResult> {
    throwIfAborted(signal);
    try {
      return await fetchPageJson(tabId, url, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, status: 0, data: null, contentType: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private render(
    context: PageContext,
    title: string,
    answers: readonly ZhihuAnswer[],
    comments: Map<string, ZhihuComment[]>,
    warnings: string[],
    questionDetail?: string,
  ): ExtractedDocument {
    const markdown = limitZhihuSource(appendWarningSection(renderZhihuContent(context, title, answers, comments, questionDetail), unique(warnings)));
    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: createMarkdownFile(title, markdown),
      warnings: unique(warnings),
    };
  }

  private async fallback(context: PageContext, signal: AbortSignal, warnings: string[]): Promise<ExtractedDocument> {
    const document = await new WebpageExtractor().extract(context, signal);
    return { ...document, warnings: unique([...document.warnings, ...warnings]) };
  }
}

export function parseZhihuTargetUrl(value: string): ZhihuTarget | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !ZHIHU_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "answer" && /^\d+$/.test(parts[1] ?? "") && parts.length === 2) {
    return { kind: "answer", origin: url.origin, answerId: parts[1] };
  }
  if (parts[0] !== "question" || !/^\d+$/.test(parts[1] ?? "")) return undefined;
  const questionId = parts[1];
  if (parts.length === 2) return { kind: "question", origin: url.origin, questionId };
  if (parts.length === 4 && parts[2] === "answer" && /^\d+$/.test(parts[3])) {
    return { kind: "answer", origin: url.origin, questionId, answerId: parts[3] };
  }
  return undefined;
}

function normalizeAnswer(value: unknown): ZhihuAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const id = toId(value.id);
  if (!id) return undefined;
  const body = toMarkdown(typeof value.content === "string" ? value.content : typeof value.excerpt === "string" ? value.excerpt : "");
  const author = isRecord(value.author) ? cleanInline(value.author.name || value.author.url_token) : "未知用户";
  const question = isRecord(value.question) ? value.question : undefined;
  return {
    id,
    body,
    author,
    likes: toNonNegativeInt(value.voteup_count),
    commentCount: toNonNegativeInt(value.comment_count),
    createdAt: toDate(value.created_time),
    updatedAt: toDate(value.updated_time),
    questionId: toId(question?.id),
    questionTitle: typeof question?.title === "string" ? question.title.trim() : undefined,
  };
}

function flattenComment(value: unknown, inheritedReplyTo?: ZhihuComment): ZhihuComment[] {
  const comment = normalizeComment(value, inheritedReplyTo);
  if (!comment) return [];
  const children = isRecord(value) && Array.isArray(value.child_comments) ? value.child_comments.flatMap((child) => flattenComment(child, comment)) : [];
  return [comment, ...children];
}

function normalizeComment(value: unknown, inheritedReplyTo?: ZhihuComment): ZhihuComment | undefined {
  if (!isRecord(value)) return undefined;
  const id = toId(value.id);
  if (!id) return undefined;
  const replyAuthor = isRecord(value.reply_to_author)
    ? cleanInline(value.reply_to_author.name || value.reply_to_author.url_token, "")
    : typeof value.reply_to_author === "string" ? value.reply_to_author.trim() : inheritedReplyTo?.author;
  const replyToId = toId(value.reply_to_comment_id) || inheritedReplyTo?.id;
  return {
    id,
    body: toMarkdown(typeof value.content === "string" ? value.content : ""),
    author: isRecord(value.author) ? cleanInline(value.author.name || value.author.url_token) : "未知用户",
    likes: toNonNegativeInt(value.like_count),
    createdAt: toDate(value.created_time),
    replyToId,
    replyToAuthor: replyAuthor || undefined,
    isReply: Boolean(replyAuthor || replyToId || inheritedReplyTo),
  };
}

function selectComments(all: readonly ZhihuComment[], limits: Pick<CommentLimits, "top" | "replies">): ZhihuComment[] {
  const topLevel = all.filter((comment) => !comment.isReply).slice(0, limits.top);
  const selectedIds = new Set(topLevel.map((comment) => comment.id));
  const result: ZhihuComment[] = [...topLevel];
  for (const top of topLevel) {
    const replies = all.filter((comment) => comment.isReply && (comment.replyToId === top.id || comment.replyToAuthor === top.author));
    replies.slice(0, limits.replies).forEach((reply) => {
      if (!selectedIds.has(reply.id)) {
        selectedIds.add(reply.id);
        result.push(reply);
      }
    });
  }
  return result;
}

function fitCommentsToBudget(comments: readonly ZhihuComment[], maxChars: number): ZhihuComment[] {
  const selected: ZhihuComment[] = [];
  for (const comment of comments) {
    const candidate = [...selected, comment];
    if (renderComments(candidate).length > maxChars) break;
    selected.push(comment);
  }
  return selected;
}

function fitAnswersToBudget(
  context: PageContext,
  title: string,
  answers: readonly ZhihuAnswer[],
  questionDetail?: string,
): ZhihuAnswer[] {
  const selected: ZhihuAnswer[] = [];
  for (const answer of answers) {
    const candidate = [...selected, answer];
    const length = renderZhihuContent(context, title, candidate, new Map(), questionDetail).length;
    if (length > MAX_SOURCE_CHARS) {
      if (!selected.length) {
        const fitted = fitFirstAnswerToBudget(context, title, answer, questionDetail);
        if (fitted) selected.push(fitted);
      }
      break;
    }
    selected.push(answer);
  }
  return selected;
}

function fitFirstAnswerToBudget(
  context: PageContext,
  title: string,
  answer: ZhihuAnswer,
  questionDetail?: string,
): ZhihuAnswer | undefined {
  const notice = "\n\n（回答正文已按字符预算截断）";
  let low = 0;
  let high = answer.body.length;
  let fitted: ZhihuAnswer | undefined;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const body = length < answer.body.length ? `${answer.body.slice(0, length).trimEnd()}${notice}` : answer.body;
    const candidate = { ...answer, body };
    if (renderZhihuContent(context, title, [candidate], new Map(), questionDetail).length <= MAX_SOURCE_CHARS) {
      fitted = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return fitted;
}

function remainingCommentChars(
  context: PageContext,
  title: string,
  answers: readonly ZhihuAnswer[],
  questionDetail?: string,
): number {
  const baseLength = renderZhihuContent(context, title, answers, new Map(), questionDetail).length;
  return Math.max(0, MAX_SOURCE_CHARS - baseLength);
}

function renderZhihuContent(
  context: PageContext,
  title: string,
  answers: readonly ZhihuAnswer[],
  comments: ReadonlyMap<string, readonly ZhihuComment[]>,
  questionDetail?: string,
): string {
  const sections: string[] = [`# ${title}`, `来源：${context.url}`];
  if (questionDetail?.trim()) sections.push(`## 问题正文\n\n${questionDetail.trim()}`);
  answers.forEach((answer, index) => {
    const heading = answers.length === 1 ? "## 回答" : `## 回答 ${index + 1}`;
    const metadata = [
      `@${answer.author}`,
      formatDate(answer.createdAt),
      typeof answer.likes === "number" ? `${answer.likes} 赞同` : "",
      typeof answer.commentCount === "number" ? `${answer.commentCount} 评论` : "",
    ].filter(Boolean).join(" · ");
    const commentText = renderComments(comments.get(answer.id) ?? []);
    sections.push(`${heading}${metadata ? ` · ${metadata}` : ""}\n\n${answer.body || "（回答正文为空）"}${commentText}`);
  });
  return sections.join("\n\n").trim();
}

function limitZhihuSource(source: string): string {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  const marker = "\n\n[内容已截断]\n\n";
  const available = MAX_SOURCE_CHARS - marker.length;
  const headChars = Math.floor(available * 0.8);
  const tailChars = available - headChars;
  return `${source.slice(0, headChars).replace(/\s+$/, "")}${marker}${source.slice(-tailChars).replace(/^\s+/, "")}`;
}

function renderComments(comments: readonly ZhihuComment[]): string {
  if (!comments.length) return "";
  const lines = comments.map((comment, index) => {
    const level = comment.isReply ? "####" : "###";
    const label = comment.isReply ? `回复 ${index + 1}` : `评论 ${index + 1}`;
    const metadata = [
      `@${comment.author}`,
      formatDate(comment.createdAt),
      typeof comment.likes === "number" ? `${comment.likes} 赞` : "",
      comment.replyToAuthor ? `回复 @${comment.replyToAuthor}` : "",
    ].filter(Boolean).join(" · ");
    return `${level} ${label}${metadata ? ` · ${metadata}` : ""}\n\n${comment.body || "（评论正文为空）"}`;
  });
  return `\n\n### 评论区（已读取 ${comments.length} 条）\n\n${lines.join("\n\n")}`;
}

function toMarkdown(value: string): string {
  if (!value.trim()) return "";
  return /<\/?[a-z][\s\S]*>/i.test(value) ? htmlToMarkdown(cleanHtmlForUpload(value)) : value.trim();
}

function validateZhihuAnswersNext(value: string, origin: string, questionId: string): string {
  return validateZhihuNext(value, origin, new RegExp(`/api/v4/questions/${escapeRegExp(questionId)}/answers(?:$|\\?)`));
}

function validateZhihuCommentsNext(value: string, origin: string, answerId: string): string {
  return validateZhihuNext(value, origin, new RegExp(`/api/v4/answers/${escapeRegExp(answerId)}/comments(?:$|\\?)`));
}

function validateZhihuNext(value: string, origin: string, pathPattern: RegExp): string {
  if (!value) return "";
  try {
    const url = new URL(value, origin);
    return url.origin === origin && pathPattern.test(url.pathname + url.search) ? url.toString() : "";
  } catch {
    return "";
  }
}

function toId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function toNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toDate(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
