import type { ExtractedContent } from "../types";

export function isBilibiliUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return /bilibili\.com$/i.test(url.hostname) && (/\/video\//i.test(url.pathname) || url.searchParams.has("bvid"));
  } catch {
    return false;
  }
}

function parseBvid(urlStr: string): string | undefined {
  const url = new URL(urlStr);
  const match = /\/video\/(BV[0-9A-Za-z]+)/i.exec(url.pathname);
  if (match?.[1]) return match[1];
  return url.searchParams.get("bvid") ?? undefined;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export async function extractBilibili(urlStr: string): Promise<ExtractedContent> {
  const bvid = parseBvid(urlStr);
  if (!bvid) {
    throw new Error("无法从 URL 中解析 Bilibili BV 号");
  }

  // 1. Fetch video metadata
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://www.bilibili.com/",
    },
  });

  const viewData = (await viewRes.json()) as any;
  if (viewData?.code !== 0 || !viewData?.data) {
    throw new Error(`B站视频信息获取失败: ${viewData?.message || "未知错误"}`);
  }

  const data = viewData.data;
  const title: string = data.title || "Bilibili 视频";
  const desc: string = data.desc || "";
  const owner: string = data.owner?.name || "UP主";
  const cid: number = data.cid;
  const duration: number = data.duration || 0;
  const coverUrl: string = data.pic || "";

  const sections: string[] = [`# ${title}`];
  sections.push(`> UP主：@${owner} · 时长：${formatDuration(duration)} · BV号：${bvid}`);

  if (desc.trim()) {
    sections.push(`### 简介\n\n${desc.trim()}`);
  }

  // 2. Fetch subtitles
  const warnings: string[] = [];
  let transcript = "";

  if (cid) {
    try {
      const playerRes = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Referer: "https://www.bilibili.com/",
        },
      });
      const playerData = (await playerRes.json()) as any;
      const subtitles: any[] = playerData?.data?.subtitle?.subtitles ?? [];

      if (subtitles.length > 0) {
        // Preferred subtitle: zh-CN or ai-zh
        const sub = subtitles.find((s) => s.lan === "zh-CN") || subtitles[0];
        const subUrl = sub.subtitle_url.startsWith("http") ? sub.subtitle_url : `https:${sub.subtitle_url}`;

        const subRes = await fetch(subUrl);
        const subJson = (await subRes.json()) as any;
        const body: Array<{ from: number; to: number; content: string }> = subJson?.body ?? [];

        if (body.length > 0) {
          transcript = body
            .map((item) => `[${formatDuration(item.from)}] ${item.content.trim()}`)
            .join("\n");
        }
      }
    } catch {
      warnings.push("字幕获取失败，已使用视频标题与简介");
    }
  }

  if (transcript) {
    sections.push(`## 视频字幕逐字稿\n\n${transcript}`);
  } else {
    warnings.push("该视频未提供官方或AI字幕，仅保留了视频标题与简介");
  }

  return {
    title,
    markdown: sections.join("\n\n").trim(),
    imageUrls: coverUrl ? [coverUrl] : [],
    sourceUrl: urlStr,
    extractor: "bilibili",
    warnings,
  };
}
