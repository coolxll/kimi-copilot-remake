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
  entryId?: string;
}

export interface FeedlyListItemSnapshot extends FeedlyCandidateSnapshot {
  order: number;
}

export interface FeedlyFrameSnapshot {
  frameUrl: string;
  pageTitle: string;
  /** Kept for compatibility with callers that model a single article frame. */
  candidate?: FeedlyCandidateSnapshot;
  articleCandidate?: FeedlyCandidateSnapshot;
  listItems?: FeedlyListItemSnapshot[];
}

export interface FeedlyPageSnapshot {
  frameUrl: string;
  pageTitle: string;
  articleCandidate?: FeedlyCandidateSnapshot;
  listItems: FeedlyListItemSnapshot[];
}

export function isFeedlyArticleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!/(^|\.)feedly\.com$/i.test(url.hostname) || !url.pathname.startsWith("/i/")) return false;
    // Feedly keeps both the reader and collection/list views below /i/. A
    // list view has no entry state in the URL, but is still an extractable
    // Feedly page.
    return true;
  } catch {
    return false;
  }
}

/**
 * A rendered Feedly reading pane is authoritative. The API is only a fallback
 * when the page did not expose either an open article or a list.
 */
export function chooseFeedlySource(
  domCandidate: FeedlyCandidateSnapshot | undefined,
  apiCandidate: FeedlyCandidateSnapshot | undefined,
  expectedEntryId?: string,
): FeedlyCandidateSnapshot | undefined {
  if (!expectedEntryId) return domCandidate ?? apiCandidate;
  if (domCandidate && isFeedlyCandidateForEntry(domCandidate, expectedEntryId)) return domCandidate;
  return apiCandidate && isFeedlyCandidateForEntry(apiCandidate, expectedEntryId) ? apiCandidate : undefined;
}

export function chooseFeedlyCandidate(
  frames: FeedlyFrameSnapshot[],
  expectedEntryId?: string,
): FeedlyCandidateSnapshot | undefined {
  const candidates = frames
    .flatMap((frame) => [frame.articleCandidate, frame.listItems?.length ? undefined : frame.candidate])
    .filter((candidate): candidate is FeedlyCandidateSnapshot => Boolean(candidate?.feedlyFrame && candidate.text.trim()))
    .sort(compareFeedlyCandidates);
  return (expectedEntryId
    ? candidates.find((candidate) => isFeedlyCandidateForEntry(candidate, expectedEntryId))
    : undefined)
    ?? candidates.find((candidate) => candidate.text.trim().length >= FEEDLY_MIN_TEXT)
    ?? candidates[0];
}

export function chooseFeedlySnapshot(
  frames: FeedlyFrameSnapshot[],
  expectedEntryId?: string,
): FeedlyPageSnapshot | undefined {
  const articleCandidates = frames
    .flatMap((frame) => [frame.articleCandidate, frame.listItems?.length ? undefined : frame.candidate])
    .filter((candidate): candidate is FeedlyCandidateSnapshot => Boolean(candidate?.feedlyFrame && candidate.text.trim()))
    .sort(compareFeedlyCandidates);
  const listFrame = frames
    .map((frame) => ({ frame, listItems: (frame.listItems ?? []).filter((item) => item.feedlyFrame) }))
    .filter(({ listItems }) => listItems.some((item) => item.feedlyFrame))
    .sort((left, right) => compareFeedlyListFrames(left.listItems, right.listItems))[0];
  const articleCandidate = expectedEntryId
    ? articleCandidates.find((candidate) => isFeedlyCandidateForEntry(candidate, expectedEntryId)) ?? articleCandidates[0]
    : articleCandidates[0];
  if (!articleCandidate && !listFrame) return undefined;
  return {
    frameUrl: articleCandidate?.frameUrl ?? listFrame?.frame.frameUrl ?? "",
    pageTitle: articleCandidate?.pageTitle ?? listFrame?.frame.pageTitle ?? "",
    articleCandidate,
    listItems: listFrame?.listItems ?? [],
  };
}

export function compareFeedlyCandidates(left: FeedlyCandidateSnapshot, right: FeedlyCandidateSnapshot): number {
  const quality = candidateQuality(right) - candidateQuality(left);
  return quality || right.text.length - left.text.length;
}

export function isFeedlyCandidateForEntry(
  candidate: FeedlyCandidateSnapshot | undefined,
  expectedEntryId: string | undefined,
): boolean {
  if (!candidate?.entryId || !expectedEntryId) return false;
  return normalizeFeedlyEntryId(candidate.entryId) === normalizeFeedlyEntryId(expectedEntryId);
}

export function formatFeedlyList(
  title: string,
  items: FeedlyListItemSnapshot[],
): { markdown: string; html: string } {
  const listTitle = title.trim() || "Feedly 列表";
  const markdownItems = items.map((item, index) => {
    const itemTitle = item.title.trim() || `条目 ${index + 1}`;
    const cleanHtml = cleanHtmlForUpload(item.html);
    const body = stripLeadingTitle(htmlToMarkdown(cleanHtml) || item.text.trim(), itemTitle);
    return `## ${index + 1}. ${itemTitle}${body ? `\n\n${body}` : ""}`;
  });
  const htmlItems = items.map((item, index) => {
    const itemTitle = item.title.trim() || `条目 ${index + 1}`;
    const cleanHtml = cleanHtmlForUpload(item.html) || `<p>${escapeHtml(item.text.trim())}</p>`;
    const entryId = item.entryId ? ` data-feedly-entry-id="${escapeHtml(item.entryId)}"` : "";
    return `<article${entryId}><h2>${escapeHtml(`${index + 1}. ${itemTitle}`)}</h2>${cleanHtml}</article>`;
  });
  return {
    markdown: `# ${listTitle}\n\n${markdownItems.join("\n\n")}`.trim(),
    html: `<section data-feedly-list="true">${htmlItems.join("\n")}</section>`,
  };
}

export class FeedlyExtractor implements ContentExtractor {
  readonly id = "webpage" as const;

  canHandle(context: PageContext): boolean {
    return isFeedlyArticleUrl(context.url);
  }

  async extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument> {
    const entryId = parseFeedlyEntryId(context.url);
    const pageSnapshot = await readFeedlySnapshot(context.tabId, entryId, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return undefined;
    });

    // An identity-matched open reading pane wins over every list item. A DOM
    // candidate with another/missing ID is not allowed to turn a list view into
    // an unrelated article; only an exact API fallback may be used then.
    if (pageSnapshot?.articleCandidate && isUsableCandidate(pageSnapshot.articleCandidate)) {
      if (entryId && !isFeedlyCandidateForEntry(pageSnapshot.articleCandidate, entryId) && pageSnapshot.listItems.length) {
        return createListDocument(context, pageSnapshot);
      }
      const apiCandidate = entryId && !isFeedlyCandidateForEntry(pageSnapshot.articleCandidate, entryId)
        ? await fetchFeedlyEntry(entryId, signal).then((entry) => entry ? createApiCandidate(entry, context.url, entryId) : undefined)
        : undefined;
      const candidate = chooseFeedlySource(pageSnapshot.articleCandidate, apiCandidate, entryId);
      if (candidate) return createArticleDocument(context, candidate);
      throw new AppError("extraction-failed", "Feedly 当前正文无法确认对应文章，已拒绝读取不相关内容");
    }
    if (pageSnapshot?.listItems.length) {
      return createListDocument(context, pageSnapshot);
    }

    // If the DOM was unavailable (for example during a Feedly navigation), use
    // the exact entry from the API as a last-resort article fallback.
    if (entryId) {
      const apiEntry = await fetchFeedlyEntry(entryId, signal);
      const apiCandidate = apiEntry ? createApiCandidate(apiEntry, context.url, entryId) : undefined;
      const candidate = chooseFeedlySource(undefined, apiCandidate, entryId);
      if (candidate) return createArticleDocument(context, candidate);
    }

    throw new AppError("extraction-failed", "无法读取 Feedly 当前内容，请确认 Feedly 列表或正文已经完成加载");
  }
}

function createArticleDocument(context: PageContext, candidate: FeedlyCandidateSnapshot): ExtractedDocument {
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

function createListDocument(context: PageContext, snapshot: FeedlyPageSnapshot): ExtractedDocument {
  const title = context.title || snapshot.pageTitle || "Feedly 列表";
  const formatted = formatFeedlyList(title, snapshot.listItems);
  return {
    kind: "webpage",
    title,
    sourceUrl: context.url,
    sourceText: formatted.markdown,
    uploadFile: new File([wrapHtml(title, formatted.html)], `${safeFilename(title)}.html`, { type: "text/html" }),
    warnings: [],
  };
}

function createApiCandidate(entry: FeedlyEntryContent, sourceUrl: string, entryId?: string): FeedlyCandidateSnapshot | undefined {
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
    entryId,
  };
}

async function readFeedlySnapshot(
  tabId: number,
  expectedEntryId: string | undefined,
  signal: AbortSignal,
): Promise<FeedlyPageSnapshot> {
  let bestSnapshot: FeedlyPageSnapshot | undefined;
  let lastError: unknown;
  let tryAllFrames = true;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (signal.aborted) throw new AppError("cancelled", "已取消");

    try {
      const frames = await executeFeedlyScript(tabId, expectedEntryId, tryAllFrames);
      const snapshot = chooseFeedlySnapshot(frames, expectedEntryId);
      if (snapshot) {
        if (!bestSnapshot || pageSnapshotQuality(snapshot) > pageSnapshotQuality(bestSnapshot)) bestSnapshot = snapshot;
        if (snapshot.articleCandidate && isUsableCandidate(snapshot.articleCandidate)) return snapshot;
      }
    } catch (error) {
      lastError = error;
      if (tryAllFrames) {
        tryAllFrames = false;
        try {
          const frames = await executeFeedlyScript(tabId, expectedEntryId, false);
          const snapshot = chooseFeedlySnapshot(frames, expectedEntryId);
          if (snapshot) {
            if (!bestSnapshot || pageSnapshotQuality(snapshot) > pageSnapshotQuality(bestSnapshot)) bestSnapshot = snapshot;
            if (snapshot.articleCandidate && isUsableCandidate(snapshot.articleCandidate)) return snapshot;
          }
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
    }

    if (attempt < 9) await delay(250, signal);
  }

  if (bestSnapshot) return bestSnapshot;
  throw new AppError("extraction-failed", "无法读取 Feedly 当前内容，请确认 Feedly 列表或正文已经完成加载", { cause: lastError });
}

function isUsableCandidate(candidate: FeedlyCandidateSnapshot): boolean {
  return candidate.text.trim().length >= FEEDLY_MIN_TEXT || candidate.score >= 150;
}

async function executeFeedlyScript(
  tabId: number,
  expectedEntryId: string | undefined,
  allFrames: boolean,
): Promise<FeedlyFrameSnapshot[]> {
  const result = await browser.scripting.executeScript({
    target: allFrames ? { tabId, allFrames: true } : { tabId },
    world: "MAIN",
    func: collectFeedlyFrame,
    args: [expectedEntryId ?? null],
  }) as Array<{ result?: FeedlyFrameSnapshot }>;
  return result.map((entry) => entry.result).filter((value): value is FeedlyFrameSnapshot => Boolean(value));
}

function collectFeedlyFrame(expectedEntryId: string | null): FeedlyFrameSnapshot {
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
  const textOf = (element: Element): string => {
    const htmlElement = element as HTMLElement;
    return normalize(htmlElement.innerText || element.textContent || "");
  };
  const feedlyFrame = /(^|\.)feedly\.com$/i.test(location.hostname);
  const pageTitle = normalize(document.querySelector("meta[property='og:title']")?.getAttribute("content") || document.title || "");
  const entrySelectors = feedlyFrame
    ? [
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
      ]
    : ["article", "[role='article']"];
  const entrySelector = entrySelectors.join(",");
  const bodySelectors = feedlyFrame
    ? [
        ".EntryBody",
        ".entryBody",
        ".entry-body",
        ".entry-body-content",
        ".entryBodyContent",
        ".entry__content",
        ".EntryContent",
        ".entryContent",
        ".entry-content",
        ".ArticleBody",
        ".Article__content",
        ".article-body",
        ".articleBody",
        ".article-content",
        ".articleContent",
        "[itemprop='articleBody']",
        ".EntrySummary",
        ".entry__summary",
        ".entrySummary",
        ".content",
      ]
    : ["[itemprop='articleBody']", "article", "[role='article']"];
  const strongBodySelectors = [
    ".EntryBody",
    ".entryBody",
    ".entry-body",
    ".entry-body-content",
    ".entryBodyContent",
    ".entry__content",
    ".EntryContent",
    ".entryContent",
    ".entry-content",
    ".ArticleBody",
    ".Article__content",
    ".article-body",
    ".articleBody",
    ".article-content",
    ".articleContent",
    "[itemprop='articleBody']",
  ];
  const readingSelectors = [
    "#entry-content",
    ".reading-pane",
    ".readingPane",
    ".EntryReader",
    ".entryReader",
    ".entry-reader",
    ".article-reader",
    ".articleReader",
    ".entry-content-expanded",
    "[data-testid*='reader']",
    "[data-test-id*='reader']",
    "[data-testid*='reading']",
    "[data-test-id*='reading']",
  ];
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
    "h2",
    "h3",
  ];
  const matchesAny = (element: Element, selectors: string[]): boolean => selectors.some((selector) => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  });
  const findVisibleElement = (root: Element, selectors: string[]): Element | undefined => {
    for (const selector of selectors) {
      const direct = root.matches(selector) && isVisible(root) ? root : undefined;
      if (direct) return direct;
      const found = Array.from(root.querySelectorAll(selector)).find(isVisible);
      if (found) return found;
    }
    return undefined;
  };
  const findVisibleText = (root: Element, selectors: string[]): string => {
    const element = findVisibleElement(root, selectors);
    return element ? textOf(element) : "";
  };
  const getOwnEntryId = (element: Element | null): string | undefined => {
    if (!element) return undefined;
    const direct = element.getAttribute("data-entry-id")
      || element.getAttribute("data-entryid")
      || element.getAttribute("data-id");
    if (direct?.trim()) return direct.trim();
    const href = element.querySelector("a[href*='/entry/']")?.getAttribute("href") || "";
    const entryMatch = href.match(/\/entry\/([^/?#]+)/i);
    if (entryMatch?.[1]) {
      try {
        return decodeURIComponent(entryMatch[1]);
      } catch {
        return entryMatch[1];
      }
    }
    const id = element.getAttribute("id") || "";
    return /entry/i.test(id) ? id.replace(/_main$/i, "") : undefined;
  };
  const getEntryId = (element: Element | null): string | undefined => {
    const ownId = getOwnEntryId(element);
    if (ownId) return ownId;
    const descendant = element?.querySelector("[data-entry-id], [data-entryid], [data-id]");
    const descendantId = descendant?.getAttribute("data-entry-id")
      || descendant?.getAttribute("data-entryid")
      || descendant?.getAttribute("data-id");
    return descendantId?.trim() || undefined;
  };
  const isSelectedEntry = (element: Element): boolean => {
    const identity = `${element.id} ${element.getAttribute("class") || ""}`.toLowerCase();
    return element.getAttribute("aria-selected") === "true"
      || element.getAttribute("aria-current") === "true"
      || element.getAttribute("data-selected") === "true"
      || element.getAttribute("data-expanded") === "true"
      || /entry[-_ ]?(selected|expanded|active|current)|\b(selected|expanded|active|current)\b/.test(identity);
  };
  const contentQuality = (element: Element, root: Element): number => {
    const text = textOf(element);
    if (!text) return -Infinity;
    const identity = `${element.id} ${element.getAttribute("class") || ""}`.toLowerCase();
    let score = Math.min(text.length, 30_000) / 120;
    if (matchesAny(element, strongBodySelectors)) score += 240;
    if (matchesAny(element, readingSelectors)) score += 260;
    if (/summary/.test(identity)) score += 160;
    if (element === root) score += 20;
    if (/(toolbar|navigation|sidebar|header|footer|menu|button|action)/.test(identity)) score -= 180;
    return score;
  };
  const chooseContentElement = (root: Element): Element => {
    const elements: Element[] = [root];
    const seen = new Set<Element>(elements);
    for (const selector of bodySelectors) {
      for (const element of Array.from(root.querySelectorAll(selector)).slice(0, 8)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        elements.push(element);
      }
    }
    return elements.sort((left, right) => contentQuality(right, root) - contentQuality(left, root))[0] || root;
  };
  const createCandidate = (root: Element, scoreBonus = 0, fallbackToPageTitle = true): FeedlyCandidateSnapshot | undefined => {
    if (!isVisible(root)) return undefined;
    const entryRoot = root.closest(entrySelector);
    const contentElement = chooseContentElement(root);
    const text = textOf(contentElement) || textOf(root);
    if (!text) return undefined;
    const titleRoot = entryRoot || root;
    const title = findVisibleText(titleRoot, titleSelectors)
      || (titleRoot !== root ? findVisibleText(root, titleSelectors) : "")
      || (fallbackToPageTitle ? pageTitle : "");
    const identity = `${root.id} ${root.getAttribute("class") || ""}`.toLowerCase();
    let score = Math.min(text.length, 30_000) / 150 + scoreBonus;
    if (matchesAny(root, strongBodySelectors) || matchesAny(contentElement, strongBodySelectors)) score += 240;
    if (matchesAny(root, readingSelectors) || matchesAny(contentElement, readingSelectors)) score += 260;
    if (entryRoot) score += 80;
    if (entryRoot && isSelectedEntry(entryRoot)) score += 320;
    if (expectedEntryId && getEntryId(entryRoot) === expectedEntryId) score += 100;
    if (/article/.test(identity)) score += 120;
    if (/(toolbar|navigation|sidebar|header|footer|menu|button|action)/.test(identity)) score -= 180;
    return {
      frameUrl: location.href,
      pageTitle,
      title,
      html: contentElement.outerHTML,
      text,
      score,
      feedlyFrame,
      entryId: getEntryId(entryRoot || root),
    };
  };

  const rawEntries = Array.from(document.querySelectorAll(entrySelector)).filter(isVisible);
  const entryRoots: Element[] = [];
  for (const element of rawEntries) {
    const ownEntryId = getOwnEntryId(element);
    const nestedEntryIds = new Set(
      Array.from(element.querySelectorAll(entrySelector))
        .map((child) => getOwnEntryId(child))
        .filter((value): value is string => Boolean(value)),
    );
    if (!ownEntryId && nestedEntryIds.size > 1) continue;
    const entryId = getEntryId(element);
    const containingIndex = entryRoots.findIndex((root) => root.contains(element));
    if (containingIndex >= 0) {
      const containingId = getEntryId(entryRoots[containingIndex]);
      if (!entryId || containingId === entryId) continue;
      if (!containingId && entryId) entryRoots.splice(containingIndex, 1);
      else continue;
    }
    const duplicateIndex = entryRoots.findIndex((root) => entryId && getEntryId(root) === entryId);
    if (duplicateIndex >= 0) continue;
    const nestedDistinctEntry = Array.from(element.querySelectorAll(entrySelector)).some((child) => {
      const childId = getEntryId(child);
      return Boolean(childId && childId !== entryId);
    });
    if (!entryId && nestedDistinctEntry) continue;
    entryRoots.push(element);
  }

  const listItems: FeedlyListItemSnapshot[] = [];
  const seenListKeys = new Set<string>();
  entryRoots.forEach((root, index) => {
    const candidate = createCandidate(root, 0, false);
    if (!candidate || (!candidate.title && candidate.text.length < 20)) return;
    const key = candidate.entryId || `${candidate.title}\n${candidate.text}`;
    if (seenListKeys.has(key)) return;
    seenListKeys.add(key);
    listItems.push({ ...candidate, order: index });
  });

  const articleCandidates: FeedlyCandidateSnapshot[] = [];
  const seenArticleRoots = new Set<Element>();
  const addArticleCandidate = (root: Element | null | undefined, scoreBonus = 0): void => {
    if (!root || seenArticleRoots.has(root) || !isVisible(root)) return;
    const entryRoot = root.closest(entrySelector);
    const openEntry = !entryRoot || isSelectedEntry(entryRoot);
    const directReading = matchesAny(root, readingSelectors);
    const strongBody = matchesAny(root, strongBodySelectors);
    if (!openEntry && !directReading) return;
    if (!entryRoot && !directReading && !strongBody) return;
    const candidate = createCandidate(root, scoreBonus);
    if (!candidate || candidate.text.length < 20) return;
    seenArticleRoots.add(root);
    articleCandidates.push(candidate);
  };

  entryRoots.filter(isSelectedEntry).forEach((root) => addArticleCandidate(root, 180));
  for (const selector of readingSelectors) {
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 12)) addArticleCandidate(element, 160);
  }
  for (const selector of strongBodySelectors) {
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 12)) addArticleCandidate(element);
  }
  if (!articleCandidates.length && !entryRoots.length) {
    for (const selector of ["article", "[role='article']", "main", "[role='main']"]) {
      for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 4)) {
        const candidate = createCandidate(element, 40);
        if (candidate && candidate.text.length >= FEEDLY_READY_TEXT) articleCandidates.push(candidate);
      }
    }
  }
  articleCandidates.sort((left, right) => {
    if (expectedEntryId) {
      const expectedPriority = Number(right.entryId === expectedEntryId) - Number(left.entryId === expectedEntryId);
      if (expectedPriority) return expectedPriority;
    }
    const quality = (right.score + Math.min(right.text.length, 30_000) / 400)
      - (left.score + Math.min(left.text.length, 30_000) / 400);
    return quality || right.text.length - left.text.length;
  });

  return {
    frameUrl: location.href,
    pageTitle,
    articleCandidate: articleCandidates[0],
    listItems,
  };
}

function candidateQuality(candidate: FeedlyCandidateSnapshot): number {
  return candidate.score + Math.min(candidate.text.trim().length, 30_000) / 400;
}

function normalizeFeedlyEntryId(value: string): string {
  return value.trim().replace(/^entry:/i, "");
}

function compareFeedlyListFrames(
  left: FeedlyListItemSnapshot[],
  right: FeedlyListItemSnapshot[],
): number {
  const count = right.length - left.length;
  if (count) return count;
  const text = right.reduce((sum, item) => sum + item.text.length, 0)
    - left.reduce((sum, item) => sum + item.text.length, 0);
  return text;
}

function pageSnapshotQuality(snapshot: FeedlyPageSnapshot): number {
  if (snapshot.articleCandidate) return 1_000_000 + candidateQuality(snapshot.articleCandidate);
  return snapshot.listItems.length * 10_000
    + snapshot.listItems.reduce((sum, item) => sum + Math.min(item.text.length, 30_000) / 100, 0);
}

function stripLeadingTitle(markdown: string, title: string): string {
  const lines = markdown.trim().split("\n");
  const first = lines[0]?.replace(/^#{1,6}\s+/, "").trim();
  return first && first === title.trim() ? lines.slice(1).join("\n").trim() : markdown.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
