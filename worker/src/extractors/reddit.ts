import type { ExtractedContent } from "../types";

export function isRedditUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return /reddit\.com$/i.test(url.hostname) && /\/comments\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function extractReddit(urlStr: string): Promise<ExtractedContent> {
  const url = new URL(urlStr);
  const cleanPath = url.pathname.replace(/\/+$/, "");
  const jsonUrl = `https://www.reddit.com${cleanPath}.json?limit=50&depth=3&raw_json=1`;

  const response = await fetch(jsonUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Reddit API 返回错误: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as any[];
  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new Error("无法从 Reddit API 解析主帖内容");
  }

  const title: string = post.title?.trim() || "Reddit 讨论";
  const author: string = post.author?.trim() || "未知用户";
  const subreddit: string = post.subreddit?.trim() || "";
  const selftext: string = post.selftext?.trim() || "";
  const score: number = post.score ?? post.ups ?? 0;
  const numComments: number = post.num_comments ?? 0;
  const createdDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().split("T")[0] : "";

  const sections: string[] = [`# ${title}`];
  sections.push(`> @${author} · r/${subreddit} · ${createdDate} · ${score} upvotes · ${numComments} 条评论`);

  if (selftext) {
    sections.push(selftext);
  } else if (post.url && !post.url.includes(post.id)) {
    sections.push(`🔗 关联链接：[${post.url}](${post.url})`);
  }

  // Comments
  const commentsList: string[] = [];
  const commentChildren = data?.[1]?.data?.children ?? [];

  for (const child of commentChildren.slice(0, 30)) {
    const cData = child?.data;
    if (!cData || !cData.body || cData.body === "[deleted]" || cData.body === "[removed]") continue;
    const cAuthor = cData.author || "匿名";
    const cScore = cData.score ?? cData.ups ?? 0;
    commentsList.push(`### @${cAuthor} · ${cScore} 赞\n\n${cData.body.trim()}`);
  }

  if (commentsList.length > 0) {
    sections.push(`## 讨论精选（精选 ${commentsList.length} 条评论）\n\n${commentsList.join("\n\n")}`);
  }

  return {
    title,
    markdown: sections.join("\n\n").trim(),
    imageUrls: [],
    sourceUrl: urlStr,
    extractor: "reddit",
    warnings: [],
  };
}
