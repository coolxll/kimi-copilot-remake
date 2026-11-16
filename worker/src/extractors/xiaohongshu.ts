import type { ExtractedContent } from "../types";

export function isXiaohongshuUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return /xiaohongshu\.com$/i.test(url.hostname) || /xhslink\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export async function extractXiaohongshu(urlStr: string): Promise<ExtractedContent> {
  const response = await fetch(urlStr, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  const finalUrl = response.url || urlStr;
  const html = await response.text();

  // Try extracting __INITIAL_STATE__
  const match = /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});<\/script>/i.exec(html)
    || /<script>\s*window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/i.exec(html);

  let note: any;
  if (match?.[1]) {
    try {
      const state = JSON.parse(match[1]);
      const noteMap = state?.note?.noteDetailMap;
      if (noteMap) {
        note = Object.values(noteMap)[0] ? (Object.values(noteMap)[0] as any).note : undefined;
      }
      if (!note) {
        note = state?.note?.currentNote?.note;
      }
    } catch {
      // ignore
    }
  }

  let title = note?.title?.trim() || "";
  let desc = note?.desc?.trim() || "";
  const author = note?.user?.nickname || note?.user?.name || "";
  const likes = note?.interactInfo?.likedCount != null ? String(note?.interactInfo?.likedCount) : "";
  const collects = note?.interactInfo?.collectedCount != null ? String(note?.interactInfo?.collectedCount) : "";
  const tags: string[] = (note?.tagList ?? []).map((t: any) => t.name).filter(Boolean);

  const images: string[] = [];
  if (Array.isArray(note?.imageList)) {
    for (const img of note.imageList) {
      const u = img.urlDefault || img.urlOriginal || img.infoList?.[0]?.url;
      if (u) images.push(u);
    }
  }

  // Fallback to meta tags if state is not available
  if (!title) {
    const metaTitle = /<meta[^>]*name="og:title"[^>]*content="([^"]*)"/i.exec(html)
      || /<title>(.*?)<\/title>/i.exec(html);
    title = metaTitle?.[1]?.trim() || "小红书笔记";
  }

  if (!desc) {
    const metaDesc = /<meta[^>]*name="description"[^>]*content="([^"]*)"/i.exec(html)
      || /<meta[^>]*name="og:description"[^>]*content="([^"]*)"/i.exec(html);
    desc = metaDesc?.[1]?.trim() || "";
  }

  const sections: string[] = [`# ${title}`];
  const metaItems = [
    author ? `作者：@${author}` : "",
    likes ? `${likes} 赞` : "",
    collects ? `${collects} 收藏` : "",
  ].filter(Boolean);

  if (metaItems.length > 0) {
    sections.push(`> ${metaItems.join(" · ")}`);
  }

  if (desc) {
    sections.push(desc);
  }

  if (tags.length > 0) {
    sections.push(`### 话题标签\n\n${tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ")}`);
  }

  if (images.length > 0) {
    const imgList = images.map((url, i) => `![配图 ${i + 1}](${url})`).join("\n\n");
    sections.push(`### 笔记配图\n\n${imgList}`);
  }

  return {
    title,
    markdown: sections.join("\n\n").trim(),
    imageUrls: Array.from(new Set(images)),
    sourceUrl: finalUrl,
    extractor: "xiaohongshu",
    warnings: [],
  };
}
