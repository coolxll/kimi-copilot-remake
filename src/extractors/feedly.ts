import { browser } from "wxt/browser";
import { AppError } from "../domain/errors";
import type { ExtractedDocument, PageContext } from "../domain/types";
import { safeFilename } from "../shared/filename";
import { cleanHtmlForUpload, htmlToMarkdown, wrapHtml } from "./html";
import type { ContentExtractor } from "./extractor";
import { fetchFeedlyEntry, parseFeedlyEntryId, type FeedlyEntryContent } from "../platform/chrome/feedly";

const FEEDLY_MIN_TEXT = 80;
const FEEDLY_READY_TEXT = 180;

export interface FeedlyCandidateSnapshot {
  frameUrl: string;
  pageTitle: string;
  title: string;
  html: string;
  text: string;
  score: number;
  feedlyFrame: boolean;
}

export interface FeedlyFrameSnapshot {
  frameUrl: string;
  pageTitle: string;
  candidate?: FeedlyCandidateSnapshot;
}

export function isFeedlyArticleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!/(^|\.)feedly\.com$/i.test(url.hostname) || !url.pathname.startsWith("/i/")) return false;
    const state = `${url.searchParams.get("s") ?? ""} ${url.hash}`.toLowerCase();
    return state.includes("entry:") || /\/read(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function chooseFeedlySource(
  domCandidate: FeedlyCandidateSnapshot | undefined,
  apiCandidate: FeedlyCandidateSnapshot | undefined,
): FeedlyCandidateSnapshot | undefined {
  if (!domCandidate) return apiCandidate;
  if (!apiCandidate) return domCandidate;
  return apiCandidate.text.length > domCandidate.text.length ? apiCandidate : domCandidate;
}

export function chooseFeedlyCandidate(frames: FeedlyFrameSnapshot[]): FeedlyCandidateSnapshot | undefined {
  const candidates = frames
    .map((frame) => frame.candidate)
    .filter((candidate): candidate is FeedlyCandidateSnapshot => Boolean(candidate && candidate.text.trim()))
    .sort(compareFeedlyCandidates);
  return candidates.find((candidate) => candidate.text.trim().length >= FEEDLY_MIN_TEXT) ?? candidates[0];
}

export function compareFeedlyCandidates(left: FeedlyCandidateSnapshot, right: FeedlyCandidateSnapshot): number {
  const quality = candidateQuality(right) - candidateQuality(left);
  return quality || right.text.length - left.text.length;
}

export class FeedlyExtractor implements ContentExtractor {
  readonly id = "webpage" as const;

  canHandle(context: PageContext): boolean {
    return isFeedlyArticleUrl(context.url);
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    const entryId = parseFeedlyEntryId(context.url);
    const [domCandidate, apiEntry] = await Promise.all([
      readFeedlyCandidate(context.tabId, signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return undefined;
      }),
      entryId ? fetchFeedlyEntry(entryId, signal) : Promise.resolve(undefined),
    ]);
    const apiCandidate = apiEntry ? createApiCandidate(apiEntry, context.url) : undefined;
    const candidate = chooseFeedlySource(domCandidate, apiCandidate);
    if (!candidate) throw new AppError("extraction-failed", "无法读取 Feedly 当前文章，请确认文章已经打开并完成加载");
    const title = candidate.title || context.title || candidate.pageTitle || "Feedly 文章";
    const cleanHtml = cleanHtmlForUpload(candidate.html);
    const bodyMarkdown = htmlToMarkdown(cleanHtml) || candidate.text.trim();
    const markdown = bodyMarkdown && title && !bodyMarkdown.startsWith(`# ${title}`)
      ? `# ${title}\n\n${bodyMarkdown}`
      : bodyMarkdown;
    if (!markdown.trim()) {
      return {
        kind: "webpage",
        title,
        sourceUrl: context.url,
        sourceText: "",
        warnings: ["Feedly 当前文章没有可读取的正文"],
      };
    }

    return {
      kind: "webpage",
      title,
      sourceUrl: context.url,
      sourceText: markdown,
      uploadFile: new File([wrapHtml(title, cleanHtml)], `${safeFilename(title)}.html`, { type: "text/html" }),
      warnings: [],
    };
  }
}

function createApiCandidate(entry: FeedlyEntryContent, sourceUrl: string): FeedlyCandidateSnapshot | undefined {
  const cleanHtml = cleanHtmlForUpload(entry.html);
  const text = htmlToMarkdown(cleanHtml);
  if (!text.trim()) return undefined;
  return {
    frameUrl: sourceUrl,
    pageTitle: entry.title || "",
    title: entry.title || "",
    html: entry.html,
    text,
    score: 0,
    feedlyFrame: true,
  };
}

async function readFeedlyCandidate(tabId: number, signal: AbortSignal): Promise<FeedlyCandidateSnapshot> {
  let lastCandidate: FeedlyCandidateSnapshot | undefined;
  let lastError: unknown;
  let tryAllFrames = true;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (signal.aborted) throw new AppError("cancelled", "已取消");

    try {
      const frames = await executeFeedlyScript(tabId, tryAllFrames);
      const candidate = chooseFeedlyCandidate(frames);
      if (candidate && isUsableCandidate(candidate)) {
        lastCandidate = candidate;
        if (candidate.text.trim().length >= FEEDLY_READY_TEXT) return candidate;
      }
    } catch (error) {
      lastError = error;
      if (tryAllFrames) {
        tryAllFrames = false;
        try {
          const frames = await executeFeedlyScript(tabId, false);
          const candidate = chooseFeedlyCandidate(frames);
          if (candidate && isUsableCandidate(candidate)) {
            lastCandidate = candidate;
            if (candidate.text.trim().length >= FEEDLY_READY_TEXT) return candidate;
          }
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
    }

    if (attempt < 9) await delay(250, signal);
  }

  if (lastCandidate) return lastCandidate;
  throw new AppError("extraction-failed", "无法读取 Feedly 当前文章，请确认文章已经打开并完成加载", { cause: lastError });
}

function isUsableCandidate(candidate: FeedlyCandidateSnapshot): boolean {
  return candidate.text.trim().length >= FEEDLY_MIN_TEXT || candidate.score >= 150;
}

async function executeFeedlyScript(tabId: number, allFrames: boolean): Promise<FeedlyFrameSnapshot[]> {
  const result = await browser.scripting.executeScript({
    target: allFrames ? { tabId, allFrames: true } : { tabId },
    world: "MAIN",
    func: collectFeedlyFrame,
  }) as Array<{ result?: FeedlyFrameSnapshot }>;
  return result.map((entry) => entry.result).filter((value): value is FeedlyFrameSnapshot => Boolean(value));
}

function collectFeedlyFrame(): FeedlyFrameSnapshot {
  const normalize = (value: string): string => value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const isVisible = (element: Element): boolean => {
    const htmlElement = element as HTMLElement;
    const style = getComputedStyle(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && rect.width > 20
      && rect.height > 20;
  };
  const feedlyFrame = /(^|\.)feedly\.com$/i.test(location.hostname);
  const pageTitle = normalize(document.querySelector("meta[property='og:title']")?.getAttribute("content") || document.title || "");
  const selectors = feedlyFrame
    ? [
        // These are the entry and reading-pane selectors used by the old
        // Feedly Curator extension. Keep the exact casing: class selectors
        // are case-sensitive in CSS.
        "[data-entry-id]",
        "[data-entryid]",
        "article.entry",
        ".Entry",
        ".entry--titleOnly",
        ".entry--magazine",
        ".entry--cards",
        ".Article",
        ".entry--overlay",
        "article.Article",
        ".EntryBody",
        ".content",
        ".entryContent",
        ".entryBody",
        ".entry__content",
        ".ArticleBody",
        ".Article__content",
        ".entry-content",
        "[data-testid*='article']",
        "[data-test-id*='article']",
        "[aria-label*='Article']",
        ".entry-body-content",
        ".entryBodyContent",
        ".entry-body",
        ".entryBody",
        ".entry-content",
        ".entryContent",
        ".article-body",
        ".articleBody",
        ".article-content",
        ".articleContent",
        "[class*='entry-body']",
        "[class*='entry-content']",
        "[class*='article-body']",
        "[class*='article-content']",
        "article",
        "[role='article']",
        "main",
      ]
    : [
        "[itemprop='articleBody']",
        "article",
        "[role='article']",
        "main",
        "[role='main']",
      ];
  const candidates: FeedlyCandidateSnapshot[] = [];
  const seen = new Set<Element>();
  const entrySelector = [
    "[data-entry-id]",
    "[data-entryid]",
    "article.entry",
    ".Entry",
    ".entry--titleOnly",
    ".entry--magazine",
    ".entry--cards",
    ".Article",
    ".entry--overlay",
    "article.Article",
  ].join(",");
  const titleSelectors = [
    ".EntryTitleLink",
    ".entry-title-link",
    ".entry__title",
    ".ArticleTitle",
    ".EntryTitle",
    ".entry-title",
    "[class*='entry-title']",
    "[class*='article-title']",
    "[data-testid*='title']",
    "[data-test-id*='title']",
    "h1",
  ];
  const findVisibleText = (root: Element, selectorsToTry: string[]): string => {
    for (const titleSelector of selectorsToTry) {
      const titleElement = root.querySelector(titleSelector);
      if (!titleElement || !isVisible(titleElement)) continue;
      const text = normalize((titleElement as HTMLElement).innerText || titleElement.textContent || "");
      if (text) return text;
    }
    return "";
  };
  const addCandidate = (element: Element, selector: string): void => {
    if (seen.has(element) || !isVisible(element)) return;
    seen.add(element);
    const htmlElement = element as HTMLElement;
    const text = normalize(htmlElement.innerText || htmlElement.textContent || "");
    if (!text) return;
    const identity = `${element.id} ${element.getAttribute("class") || ""} ${selector}`.toLowerCase();
    const compactIdentity = identity.replace(/[-_ ]/g, "");
    const rect = htmlElement.getBoundingClientRect();
    const paragraphCount = element.querySelectorAll("p").length;
    const headingCount = element.querySelectorAll("h1,h2,h3").length;
    const linkCount = element.querySelectorAll("a").length;
    let score = Math.min(text.length, 30_000) / 150;
    score += Math.min(rect.width * rect.height, 500_000) / 1_000;
    if (/(entry|article)[-_ ]?(body|content)/.test(identity) || /(entry|article)(body|content)/.test(compactIdentity)) score += 240;
    else if (/\barticle\b/.test(identity)) score += 150;
    else if (/\bentry\b/.test(identity)) score += 80;
    if (/entry--selected|entry--expanded/.test(identity)) score += 200;
    if (/^article$|\[role='article'\]/.test(selector)) score += 120;
    if (/\bmain\b/.test(selector)) score += 20;
    if (/(sidebar|toolbar|navigation|nav|feed[-_ ]?list|stream|card|header|footer|menu|button|action)/.test(identity)) score -= 180;
    score += Math.min(paragraphCount, 30) * 5 + Math.min(headingCount, 4) * 12;
    if (linkCount > paragraphCount * 3 + 10) score -= 80;
    if (element === document.body) score -= 180;

    const entryRoot = element.closest(entrySelector);
    let title = findVisibleText(element, titleSelectors);
    if (!title && entryRoot && entryRoot !== element) title = findVisibleText(entryRoot, titleSelectors);
    if (!title) title = normalize(document.querySelector("meta[property='og:title']")?.getAttribute("content") || "");
    candidates.push({ frameUrl: location.href, pageTitle, title, html: element.outerHTML, text, score, feedlyFrame });
  };

  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 12)) addCandidate(element, selector);
  }
  if (!candidates.length || !feedlyFrame) addCandidate(document.body, "body");

  candidates.sort((left, right) => {
    const quality = (right.score + Math.min(right.text.length, 30_000) / 400)
      - (left.score + Math.min(left.text.length, 30_000) / 400);
    return quality || right.text.length - left.text.length;
  });
  return { frameUrl: location.href, pageTitle, candidate: candidates[0] };
}

function candidateQuality(candidate: FeedlyCandidateSnapshot): number {
  return candidate.score + Math.min(candidate.text.trim().length, 30_000) / 400;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new AppError("cancelled", "已取消"));
    }, { once: true });
  });
}
