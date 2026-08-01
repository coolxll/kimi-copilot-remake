export interface YoutubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
}

export function isYoutubePageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "youtu.be"
      || (hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
        && /^\/(?:watch|shorts|live|embed)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

const PREFERRED_LANGUAGE_CODES = ["zh-hans", "zh", "zh-cn", "zh-tw", "zh-hant", "en", "en-us", "ja"];

export function chooseYoutubeCaptionTrack(
  tracks: readonly YoutubeCaptionTrack[],
): YoutubeCaptionTrack | undefined {
  const available = tracks.filter((track) => Boolean(track.baseUrl?.trim()));
  const manuallyCreated = available.filter((track) => !isYoutubeGeneratedCaptionTrack(track));
  const generated = available.filter((track) => isYoutubeGeneratedCaptionTrack(track));

  // Match BiliNote/youtube-transcript-api: requested languages first, manual
  // captions before generated captions, then the first remaining track.
  for (const languageCode of PREFERRED_LANGUAGE_CODES) {
    const manual = manuallyCreated.find((track) => trackLanguageCode(track) === languageCode);
    if (manual) return manual;
  }
  for (const languageCode of PREFERRED_LANGUAGE_CODES) {
    const automatic = generated.find((track) => trackLanguageCode(track) === languageCode);
    if (automatic) return automatic;
  }
  return available[0];
}

export function isYoutubeGeneratedCaptionTrack(track: YoutubeCaptionTrack): boolean {
  const vssId = track.vssId?.trim().toLowerCase().replace(/^\.+/, "") ?? "";
  return track.kind?.trim().toLowerCase() === "asr" || vssId.startsWith("a.") || vssId.startsWith("a-");
}

/**
 * YouTube marks web caption URLs that participate in the PO-token rollout with
 * exp=xpe/xpv. Fetching those URLs without the page-generated token commonly
 * returns HTTP 200 with an empty body instead of an HTTP error.
 */
export function isYoutubeCaptionUrlPoTokenGated(baseUrl: string): boolean {
  try {
    const expValues = new URL(baseUrl).searchParams.getAll("exp");
    return expValues.some((value) => value.toLowerCase() === "xpe" || value.toLowerCase() === "xpv");
  } catch {
    return /[?&]exp=xp[ev](?:&|$)/i.test(baseUrl);
  }
}

/** Match youtube-transcript-api's first fetch: remove a preselected fmt. */
export function stripYoutubeCaptionFormat(baseUrl: string): string {
  return baseUrl
    .replace(/([?&])fmt=[^&#]*/i, "")
    .replace("?&", "?")
    .replace(/[?&]$/, "");
}

function trackLanguageCode(track: YoutubeCaptionTrack): string {
  const languageCode = normalizeLanguageCode(track.languageCode);
  if (languageCode) return languageCode;
  const vssId = track.vssId?.trim().toLowerCase().replace(/^\.+/, "").replace(/^a[.-]/, "");
  return normalizeLanguageCode(vssId?.replaceAll(".", "-"));
}

function normalizeLanguageCode(languageCode?: string): string {
  return languageCode?.trim().toLowerCase().replaceAll("_", "-") ?? "";
}

export function parseYoutubeTranscript(payload: string): string {
  const source = payload.replace(/^\uFEFF/, "").trim();
  if (!source) return "";

  const jsonSource = source.replace(/^\)\]\}'\s*/, "");
  if (jsonSource.startsWith("{") || jsonSource.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(jsonSource);
      const jsonTranscript = parseJson3Transcript(value);
      if (jsonTranscript) return jsonTranscript;
    } catch {
      // Fall through to the other caption formats. Some error responses are
      // JSON while the actual caption endpoint normally returns XML/VTT.
    }
  }

  const vttTranscript = parseVttTranscript(source);
  if (vttTranscript) return vttTranscript;

  const srtTranscript = parseSrtTranscript(source);
  if (srtTranscript) return srtTranscript;

  return parseXmlTranscript(source);
}

function parseJson3Transcript(value: unknown): string {
  if (Array.isArray(value)) return parseJsonSnippetArray(value);
  if (!isRecord(value)) return "";
  const events = Array.isArray(value.events) ? value.events : [];
  return events
    .map((event) => {
      if (!isRecord(event) || !Array.isArray(event.segs)) return "";
      const text = event.segs
        .map((segment) => (isRecord(segment) && typeof segment.utf8 === "string" ? segment.utf8 : ""))
        .join("");
      if (!text.trim()) return "";
      const startMs = typeof event.tStartMs === "number" ? event.tStartMs : 0;
      return `[${formatSeconds(startMs / 1000)}] ${decodeXmlEntities(normalizeCaptionText(text))}`;
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonSnippetArray(value: unknown[]): string {
  return value
    .map((item) => {
      if (!isRecord(item) || typeof item.text !== "string") return "";
      const start = typeof item.start === "number"
        ? item.start
        : typeof item.startMs === "number" ? item.startMs / 1000 : 0;
      const text = decodeXmlEntities(normalizeCaptionText(item.text));
      return text ? `[${formatSeconds(start)}] ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseVttTranscript(source: string): string {
  if (!/^WEBVTT(?:\s|$)/i.test(source)) return "";

  const cues: Array<{ start: number; text: string }> = [];
  let start: number | undefined;
  let textLines: string[] = [];
  let ignoredBlock = false;

  const flush = () => {
    if (start === undefined) {
      textLines = [];
      return;
    }
    const text = decodeXmlEntities(normalizeCaptionText(textLines.join(" ")));
    if (text) cues.push({ start, text });
    start = undefined;
    textLines = [];
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      ignoredBlock = false;
      continue;
    }
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) {
      flush();
      ignoredBlock = true;
      continue;
    }
    if (ignoredBlock) continue;

    const timing = line.match(/^([^\s]+)\s+-->\s+([^\s]+)/);
    if (timing) {
      flush();
      start = parseVttTimestamp(timing[1]);
      continue;
    }
    if (start !== undefined) textLines.push(stripCaptionTags(line));
  }
  flush();

  return formatYoutubeCues(compactYoutubeCues(cues));
}

function parseVttTimestamp(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function stripCaptionTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function parseSrtTranscript(source: string): string {
  if (!/^\s*(?:\d+\s*\r?\n)?\d{2}:\d{2}:\d{2}[,.]\d{3}\s+--> /m.test(source)) return "";

  const cues: Array<{ start: number; text: string }> = [];
  let start: number | undefined;
  let textLines: string[] = [];
  const flush = () => {
    if (start === undefined) {
      textLines = [];
      return;
    }
    const text = decodeXmlEntities(normalizeCaptionText(textLines.join(" ")));
    if (text) cues.push({ start, text });
    start = undefined;
    textLines = [];
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const timing = line.match(/^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+([^\s]+)/);
    if (timing) {
      flush();
      start = parseVttTimestamp(timing[1].replace(",", "."));
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (start !== undefined) textLines.push(stripCaptionTags(line));
  }
  flush();

  return formatYoutubeCues(compactYoutubeCues(cues));
}

function compactYoutubeCues(cues: Array<{ start: number; text: string }>): Array<{ start: number; text: string }> {
  const compacted: Array<{ start: number; text: string }> = [];
  for (const cue of cues) {
    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(cue);
    } else if (cue.text === previous.text || previous.text.startsWith(cue.text)) {
      continue;
    } else if (cue.text.startsWith(previous.text)) {
      compacted[compacted.length - 1] = cue;
    } else {
      compacted.push(cue);
    }
  }
  return compacted;
}

function formatYoutubeCues(cues: Array<{ start: number; text: string }>): string {
  return cues.map((cue) => `[${formatSeconds(cue.start)}] ${cue.text}`).join("\n");
}

function parseXmlTranscript(source: string): string {
  const lines: string[] = [];
  const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const match of source.matchAll(textPattern)) {
    const attributes = match[1] ?? "";
    const rawText = (match[2] ?? "").replace(/<[^>]+>/g, "");
    const text = normalizeCaptionText(decodeXmlEntities(rawText));
    if (!text) continue;
    const start = readXmlAttribute(attributes, "start");
    lines.push(`[${formatSeconds(parseCaptionTime(start, "seconds"))}] ${text}`);
  }
  if (lines.length) return lines.join("\n");

  // TTML uses <p begin="..."> rather than YouTube's legacy <text start="...">.
  const paragraphPattern = /<(?:(?:[\w.-]+):)?p\b([^>]*)>([\s\S]*?)<\/(?:(?:[\w.-]+):)?p>/gi;
  for (const match of source.matchAll(paragraphPattern)) {
    const attributes = match[1] ?? "";
    const rawText = (match[2] ?? "").replace(/<[^>]+>/g, "");
    const text = normalizeCaptionText(decodeXmlEntities(rawText));
    if (!text) continue;
    const start = readXmlAttribute(attributes, "begin")
      ?? readXmlAttribute(attributes, "start")
      ?? readXmlAttribute(attributes, "t");
    const unit = readXmlAttribute(attributes, "begin") || readXmlAttribute(attributes, "start") ? "seconds" : "milliseconds";
    lines.push(`[${formatSeconds(parseCaptionTime(start, unit))}] ${text}`);
  }
  return lines.join("\n");
}

function parseCaptionTime(value: string | undefined, defaultUnit: "seconds" | "milliseconds"): number {
  if (!value) return 0;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes(":")) return parseVttTimestamp(normalized);
  if (normalized.endsWith("ms")) return Number.parseFloat(normalized.slice(0, -2)) / 1000;
  if (normalized.endsWith("s")) return Number.parseFloat(normalized.slice(0, -1));
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? (defaultUnit === "milliseconds" ? numeric / 1000 : numeric) : 0;
}

function readXmlAttribute(attributes: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attributes)?.[1];
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    if (normalized.startsWith("#x")) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    if (normalized.startsWith("#")) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    return entity;
  });
}

function normalizeCaptionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return String(Number(value.toFixed(3)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
