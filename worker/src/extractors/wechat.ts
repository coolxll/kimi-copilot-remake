import type { ExtractedContent } from "../types";

export function isWechatUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return /mp\.weixin\.qq\.com$/i.test(url.hostname) && url.pathname.startsWith("/s");
  } catch {
    return false;
  }
}

function extractRegex(text: string, regex: RegExp): string {
  const match = regex.exec(text);
  return match?.[1]?.trim() || "";
}

function cleanHtmlToMarkdown(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n### $1\n\n")
    .replace(/<section[^>]*class="[^"]*code-snippet[^"]*"[^>]*>([\s\S]*?)<\/section>/gi, "\n\n```\n$1\n```\n\n")
    .replace(/<ul[^>]*class="[^"]*code-snippet__line-index[^"]*"[^>]*>[\s\S]*?<\/ul>/gi, "")
    .replace(/<img[^>]*data-src="([^"]*)"[^>]*>/gi, "\n\n![]($1)\n\n")
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

export async function extractWechat(urlStr: string): Promise<ExtractedContent> {
  const response = await fetch(urlStr, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    },
  });

  const html = await response.text();

  const title = extractRegex(html, /<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/i)
    || extractRegex(html, /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i)
    || "微信公众号文章";

  const account = extractRegex(html, /id="js_name"[^>]*>([\s\S]*?)<\//i)
    || extractRegex(html, /<meta[^>]*property="og:article:author"[^>]*content="([^"]*)"/i)
    || "";

  const contentHtml = extractRegex(html, /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || extractRegex(html, /<div[^>]*class="rich_media_content"[^>]*>([\s\S]*?)<\/div>/i);

  if (!contentHtml) {
    throw new Error("未能提取出微信文章正文，页面可能已被删除或包含验证码");
  }

  // Extract images
  const imageUrls: string[] = [];
  const imgMatches = contentHtml.matchAll(/data-src="([^"]+)"/gi);
  for (const m of imgMatches) {
    if (m[1] && !m[1].startsWith("data:")) {
      imageUrls.push(m[1]);
    }
  }

  const markdownBody = cleanHtmlToMarkdown(contentHtml);

  const sections: string[] = [`# ${title.replace(/\s+/g, " ")}`];
  if (account) {
    sections.push(`> 公众号：${account}`);
  }
  sections.push(markdownBody);

  return {
    title: title.replace(/\s+/g, " "),
    markdown: sections.join("\n\n").trim(),
    imageUrls: Array.from(new Set(imageUrls)),
    sourceUrl: urlStr,
    extractor: "wechat",
    warnings: [],
  };
}
