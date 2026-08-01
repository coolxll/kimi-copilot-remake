import { browser } from "wxt/browser";
import {
  chooseBilibiliSubtitleTrack,
  isBilibiliAiSubtitleTrack,
  isLikelyMismatchedBilibiliSubtitle,
  selectBilibiliPage,
} from "../../domain/bilibili";
import type { BilibiliPage, BilibiliSubtitleTrack, BilibiliVideoRef } from "../../domain/bilibili";

export type BilibiliLoginState = "logged-in" | "logged-out" | "unknown";

export interface BilibiliSubtitleFetchRequest {
  videoRef: BilibiliVideoRef;
  currentCid?: number | string;
}

export interface BilibiliSubtitleFetchResponse {
  title?: string;
  description?: string;
  subtitles: string;
  subtitleLanguage?: string;
  subtitleIsAi?: boolean;
  subtitleDuration?: number;
  subtitleRejectedReason?: string;
  selectedPage?: number;
  selectedPagePart?: string;
  pageCount: number;
  loginState: BilibiliLoginState;
  unavailableReason?: string;
}

export const BILIBILI_SUBTITLE_MESSAGE = "kimi-copilot:fetch-bilibili-subtitle" as const;

export interface BilibiliSubtitleMessage {
  type: typeof BILIBILI_SUBTITLE_MESSAGE;
  request: BilibiliSubtitleFetchRequest;
}

interface ApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface ViewData {
  bvid?: string;
  title?: string;
  desc?: string;
  aid?: number | string;
  cid?: number | string;
  duration?: number;
  pages?: BilibiliPage[];
}

interface PlayerData {
  bvid?: string;
  aid?: number | string;
  cid?: number | string;
  subtitle?: { subtitles?: BilibiliSubtitleTrack[] };
}

interface SubtitleBody {
  body?: Array<{ from?: number; to?: number; content?: string }>;
}

interface NavData {
  isLogin?: boolean | number;
}

interface JsonResult<T> {
  ok: boolean;
  data?: T;
}

const API_ROOT = "https://api.bilibili.com";

/** The side panel asks the extension service worker to perform the privileged fetch. */
export async function requestBilibiliSubtitle(
  request: BilibiliSubtitleFetchRequest,
): Promise<BilibiliSubtitleFetchResponse> {
  const result = await browser.runtime.sendMessage({
    type: BILIBILI_SUBTITLE_MESSAGE,
    request,
  } satisfies BilibiliSubtitleMessage);
  if (!result || typeof result !== "object" || typeof (result as BilibiliSubtitleFetchResponse).subtitles !== "string") {
    throw new Error("Bilibili 后台字幕请求返回了无效结果");
  }
  return result as BilibiliSubtitleFetchResponse;
}

export function isBilibiliSubtitleMessage(value: unknown): value is BilibiliSubtitleMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === BILIBILI_SUBTITLE_MESSAGE
    && Boolean(record.request && typeof record.request === "object");
}

/** Runs only in the extension service worker, where host permissions enable cross-origin fetch. */
export async function fetchBilibiliSubtitleInBackground(
  request: BilibiliSubtitleFetchRequest,
): Promise<BilibiliSubtitleFetchResponse> {
  const { videoRef } = request;
  const viewQuery = new URLSearchParams();
  if (videoRef.bvid) viewQuery.set("bvid", videoRef.bvid);
  else if (videoRef.aid) viewQuery.set("aid", videoRef.aid);
  if (videoRef.pageNumber !== undefined) viewQuery.set("p", String(videoRef.pageNumber));

  const viewResult = await getJson<ApiResponse<ViewData>>(`${API_ROOT}/x/web-interface/view?${viewQuery.toString()}`, "include");
  const view = viewResult.data;
  if (!viewResult.ok || view?.code !== 0 || !view.data) {
    return unavailable("B 站视频信息接口请求失败");
  }

  const viewData = view.data;
  if (videoRef.bvid && viewData.bvid && viewData.bvid.toUpperCase() !== videoRef.bvid.toUpperCase()) {
    return unavailable("Bilibili 视频 ID 与页面地址不一致");
  }

  const pages = Array.isArray(viewData.pages) ? viewData.pages : [];
  const selectedPage = selectBilibiliPage(pages, videoRef.pageNumber, request.currentCid, viewData.cid);
  const cid = selectedPage?.cid ?? viewData.cid;
  const aid = viewData.aid ?? videoRef.aid;
  const bvid = viewData.bvid ?? videoRef.bvid;
  if (cid === undefined || (aid === undefined && bvid === undefined)) {
    return unavailable({
      title: viewData.title,
      description: viewData.desc,
      pageCount: pages.length,
    }, "无法确定 Bilibili 当前分 P");
  }

  const partial: Partial<BilibiliSubtitleFetchResponse> = {
    title: viewData.title,
    description: viewData.desc,
    pageCount: pages.length,
    selectedPage: selectedPage?.page ?? (pages.length === 1 ? 1 : undefined),
    selectedPagePart: selectedPage?.part,
  };

  let tracks: BilibiliSubtitleTrack[] = [];
  let identityMismatch = false;
  const identities: Array<{ key: "bvid" | "aid"; value: string }> = [];
  if (bvid) identities.push({ key: "bvid", value: String(bvid) });
  if (aid && !identities.some((identity) => identity.key === "aid" && identity.value === String(aid))) {
    identities.push({ key: "aid", value: String(aid) });
  }

  // Match BiliNote's working WBI path first, then retain the legacy endpoint
  // and numeric aid fallback for videos where only one form is accepted.
  outer:
  for (let attempt = 0; attempt < 2 && tracks.length === 0; attempt += 1) {
    for (const endpoint of ["x/player/wbi/v2", "x/player/v2"]) {
      for (const identity of identities) {
        const playerQuery = new URLSearchParams({ [identity.key]: identity.value, cid: String(cid) });
        if (attempt > 0) playerQuery.set("_", String(Date.now()));
        const playerResult = await getJson<ApiResponse<PlayerData>>(
          `${API_ROOT}/${endpoint}?${playerQuery.toString()}`,
          "include",
        );
        const player = playerResult.data;
        if (!playerResult.ok || player?.code !== 0 || !player.data) continue;
        const playerData = player.data;
        if (
          (bvid && playerData.bvid && playerData.bvid.toUpperCase() !== String(bvid).toUpperCase())
          || (aid !== undefined && playerData.aid !== undefined && String(playerData.aid) !== String(aid))
          || (playerData.cid !== undefined && String(playerData.cid) !== String(cid))
        ) {
          identityMismatch = true;
          break outer;
        }
        const candidateTracks = Array.isArray(playerData.subtitle?.subtitles)
          ? playerData.subtitle.subtitles
          : [];
        if (candidateTracks.some((track) => Boolean(track.subtitle_url))) {
          tracks = candidateTracks;
          break outer;
        }
      }
    }
    if (tracks.length === 0 && attempt === 0) await delay(250);
  }

  if (identityMismatch) return unavailable(partial, "Bilibili 字幕接口返回了不匹配的视频");

  const selectedTrack = chooseBilibiliSubtitleTrack(tracks);
  if (!selectedTrack?.subtitle_url) {
    return unavailable(partial, "B 站没有返回可下载字幕轨");
  }

  const subtitleUrl = normalizeSubtitleUrl(selectedTrack.subtitle_url);
  if (!subtitleUrl) return unavailable(partial, "B 站字幕资源地址无效");
  const subtitleResult = await getJson<SubtitleBody>(subtitleUrl, "omit");
  const body = subtitleResult.data?.body;
  if (!subtitleResult.ok || !Array.isArray(body)) {
    return unavailable(partial, "B 站字幕资源下载失败");
  }

  const segments = body
    .map((item) => ({
      start: Number(item.from ?? 0),
      end: Number(item.to ?? item.from ?? 0),
      text: item.content?.trim() ?? "",
    }))
    .filter((item) => item.text && Number.isFinite(item.start) && Number.isFinite(item.end));
  if (!segments.length) return unavailable(partial, "B 站字幕内容为空");

  const subtitleDuration = segments.reduce((latest, item) => Math.max(latest, item.end), 0);
  const videoDuration = Number(selectedPage?.duration ?? viewData.duration ?? 0) || undefined;
  if (isLikelyMismatchedBilibiliSubtitle(videoDuration, subtitleDuration)) {
    return {
      ...partial,
      subtitles: "",
      subtitleLanguage: selectedTrack.lan,
      subtitleIsAi: isBilibiliAiSubtitleTrack(selectedTrack),
      subtitleDuration,
      subtitleRejectedReason: `B 站字幕时间轴仅覆盖约 ${Math.round(subtitleDuration)} 秒，但视频时长为 ${Math.round(videoDuration ?? 0)} 秒，已忽略疑似错配字幕`,
      pageCount: pages.length,
      loginState: "unknown",
      unavailableReason: "字幕时间轴疑似与当前视频不匹配",
    };
  }

  return {
    ...partial,
    subtitles: segments.map((item) => item.text).join("\n"),
    subtitleLanguage: selectedTrack.lan,
    subtitleIsAi: isBilibiliAiSubtitleTrack(selectedTrack),
    subtitleDuration,
    pageCount: pages.length,
    loginState: "unknown",
  };

  async function unavailable(
    partialOrReason: Partial<BilibiliSubtitleFetchResponse> | string,
    maybeReason?: string,
  ): Promise<BilibiliSubtitleFetchResponse> {
    const metadata = typeof partialOrReason === "string" ? {} : partialOrReason;
    const reason = typeof partialOrReason === "string" ? partialOrReason : (maybeReason ?? "B 站字幕不可用");
    return {
      ...metadata,
      subtitles: "",
      pageCount: metadata.pageCount ?? 0,
      loginState: await probeBilibiliLoginState(),
      unavailableReason: reason,
    };
  }
}

async function probeBilibiliLoginState(): Promise<BilibiliLoginState> {
  const result = await getJson<ApiResponse<NavData>>(`${API_ROOT}/x/web-interface/nav`, "include");
  const value = result.data?.data?.isLogin;
  if (!result.ok || result.data?.code !== 0 || value === undefined) return "unknown";
  return value === true || value === 1 ? "logged-in" : "logged-out";
}

async function getJson<T>(url: string, credentials: RequestCredentials): Promise<JsonResult<T>> {
  try {
    const response = await fetch(url, {
      credentials,
      headers: { Accept: "application/json" },
      referrer: "https://www.bilibili.com/",
    });
    let data: T | undefined;
    try {
      data = await response.json() as T;
    } catch {
      data = undefined;
    }
    return { ok: response.ok, data };
  } catch {
    return { ok: false };
  }
}

function normalizeSubtitleUrl(rawUrl: string): string | undefined {
  try {
    const value = rawUrl.startsWith("//") ? `https:${rawUrl}` : new URL(rawUrl, "https://www.bilibili.com/").href;
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
