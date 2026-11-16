import type { ExtractedContent } from "../types";

export function isYoutubeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return /youtube\.com$/i.test(url.hostname) || /youtu\.be$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function parseVideoId(urlStr: string): string | undefined {
  const url = new URL(urlStr);
  if (/youtu\.be$/i.test(url.hostname)) {
    return url.pathname.replace(/^\/+/, "").split("/")[0];
  }
  return url.searchParams.get("v") ?? /^\/(?:embed|shorts|v)\/([^/?#]+)/i.exec(url.pathname)?.[1];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export async function extractYoutube(urlStr: string): Promise<ExtractedContent> {
  const videoId = parseVideoId(urlStr);
  if (!videoId) {
    throw new Error("无法从 URL 中解析 YouTube Video ID");
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(watchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  const html = await response.text();

  // Extract ytInitialPlayerResponse
  const match = /var\s+ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/i.exec(html)
    || /ytInitialPlayerResponse\s*=\s*({[\s\S]*?});<\/script>/i.exec(html);

  let playerResponse: any;
  if (match?.[1]) {
    try {
      playerResponse = JSON.parse(match[1]);
    } catch {
      // ignore
    }
  }

  const title: string = playerResponse?.videoDetails?.title || "YouTube 视频";
  const author: string = playerResponse?.videoDetails?.author || "频道";
  const desc: string = playerResponse?.videoDetails?.shortDescription || "";
  const lengthSeconds = Number(playerResponse?.videoDetails?.lengthSeconds) || 0;

  const sections: string[] = [`# ${title}`];
  sections.push(`> 频道：@${author} · 时长：${formatDuration(lengthSeconds)} · [原视频链接](${watchUrl})`);

  if (desc.trim()) {
    sections.push(`### 简介\n\n${desc.trim().slice(0, 2000)}`);
  }

  // Captions
  const tracks: any[] = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const warnings: string[] = [];
  let transcript = "";

  if (tracks.length > 0) {
    // Prefer zh then en
    const track = tracks.find((t) => t.languageCode?.startsWith("zh"))
      || tracks.find((t) => t.languageCode?.startsWith("en"))
      || tracks[0];

    const captionUrl = `${track.baseUrl}&fmt=json3`;
    try {
      const capRes = await fetch(captionUrl);
      const capJson = (await capRes.json()) as any;
      const events: any[] = capJson?.events ?? [];

      const lines: string[] = [];
      for (const ev of events) {
        if (!ev.segs || !ev.tStartMs) continue;
        const text = ev.segs.map((s: any) => s.utf8 || "").join("").trim();
        if (text) {
          const time = formatDuration(ev.tStartMs / 1000);
          lines.push(`[${time}] ${text}`);
        }
      }
      transcript = lines.join("\n");
    } catch {
      warnings.push("字幕拉取失败，保留视频标题与简介");
    }
  } else {
    warnings.push("该视频暂无可读取的字幕轨，仅保留了标题与简介");
  }

  if (transcript) {
    sections.push(`## 视频字幕逐字稿\n\n${transcript}`);
  }

  return {
    title,
    markdown: sections.join("\n\n").trim(),
    imageUrls: [`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`],
    sourceUrl: urlStr,
    extractor: "youtube",
    warnings,
  };
}
