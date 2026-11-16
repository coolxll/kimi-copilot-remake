import type { ExtractedContent } from "../types";

export function cleanGenericHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<(nav|header|footer|aside)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h[3-6][^>]*>(.*?)<\/h[3-6]>/gi, "\n\n### $1\n\n")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "\n- $1")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, "\n\n![]($1)\n\n")
    .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractWebpage(urlStr: string): Promise<ExtractedContent> {
  const response = await fetch(urlStr, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const html = await response.text();

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    || /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html);
  const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() || "网页内容";

  const markdown = cleanGenericHtml(html);

  return {
    title,
    markdown,
    imageUrls: [],
    sourceUrl: urlStr,
    extractor: "webpage",
    warnings: [],
  };
}
