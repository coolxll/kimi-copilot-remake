import type { ExtractedContent } from "../types";

export function isZhihuUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return /zhihu\.com$/i.test(url.hostname) && (/\/question\//i.test(url.pathname) || /\/answer\//i.test(url.pathname));
  } catch {
    return false;
  }
}

function parseTarget(urlStr: string): { questionId?: string; answerId?: string } {
  const url = new URL(urlStr);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "question" && parts[1]) {
    const questionId = parts[1];
    const answerId = parts[2] === "answer" ? parts[3] : undefined;
    return { questionId, answerId };
  }
  if (parts[0] === "answer" && parts[1]) {
    return { answerId: parts[1] };
  }
  return {};
}

function simpleHtmlToMarkdown(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n### $1\n\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<img[^>]*data-original="([^"]*)"[^>]*>/gi, "\n\n![]($1)\n\n")
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, "\n\n![]($1)\n\n")
    .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractZhihu(urlStr: string): Promise<ExtractedContent> {
  const { questionId, answerId } = parseTarget(urlStr);
  if (!questionId && !answerId) {
    throw new Error("无法从 URL 解析知乎问题或回答 ID");
  }

  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  };

  const sections: string[] = [];
  let title = "知乎内容";

  // 1. Single Answer mode
  if (answerId) {
    const ansRes = await fetch(`https://api.zhihu.com/answers/${answerId}`, { headers });
    if (ansRes.ok) {
      const ansData = (await ansRes.json()) as any;
      title = ansData.question?.title || "知乎回答";
      const author = ansData.author?.name || "知乎用户";
      const voteup = ansData.voteup_count ?? 0;
      const content = simpleHtmlToMarkdown(ansData.content || ansData.excerpt || "");

      sections.push(`# ${title}`);
      sections.push(`> 回答者：@${author} · ${voteup} 赞同 · [原回答链接](${urlStr})`);
      sections.push(content);

      return {
        title,
        markdown: sections.join("\n\n").trim(),
        imageUrls: [],
        sourceUrl: urlStr,
        extractor: "zhihu",
        warnings: [],
      };
    }
  }

  // 2. Question mode
  if (questionId) {
    const qRes = await fetch(`https://api.zhihu.com/questions/${questionId}`, { headers });
    let questionDetail = "";
    if (qRes.ok) {
      const qData = (await qRes.json()) as any;
      title = qData.title || "知乎问题";
      questionDetail = simpleHtmlToMarkdown(qData.detail || "");
    }

    sections.push(`# ${title}`);
    if (questionDetail) {
      sections.push(`> 问题描述：\n${questionDetail}`);
    }

    // Answers
    const answersRes = await fetch(`https://api.zhihu.com/questions/${questionId}/answers?limit=5`, { headers });
    if (answersRes.ok) {
      const answersData = (await answersRes.json()) as any;
      const answers: any[] = answersData.data || [];

      if (answers.length > 0) {
        sections.push(`## 精选高赞回答（共 ${answers.length} 个回答）`);
        for (let i = 0; i < answers.length; i++) {
          const ans = answers[i];
          const author = ans.author?.name || "知乎用户";
          const voteup = ans.voteup_count ?? 0;
          const body = simpleHtmlToMarkdown(ans.content || ans.excerpt || "");
          sections.push(`### 回答 ${i + 1} · @${author} · ${voteup} 赞同\n\n${body}`);
        }
      }
    }

    return {
      title,
      markdown: sections.join("\n\n").trim(),
      imageUrls: [],
      sourceUrl: urlStr,
      extractor: "zhihu",
      warnings: [],
    };
  }

  throw new Error("知乎内容接口读取失败");
}
