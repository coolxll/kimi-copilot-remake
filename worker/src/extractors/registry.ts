import type { ExtractedContent } from "../types";
import { isRedditUrl, extractReddit } from "./reddit";
import { isBilibiliUrl, extractBilibili } from "./bilibili";
import { isYoutubeUrl, extractYoutube } from "./youtube";
import { isZhihuUrl, extractZhihu } from "./zhihu";
import { isWechatUrl, extractWechat } from "./wechat";
import { isXiaohongshuUrl, extractXiaohongshu } from "./xiaohongshu";
import { extractWebpage } from "./webpage";

export async function extractFromUrl(url: string): Promise<ExtractedContent> {
  if (isRedditUrl(url)) {
    return extractReddit(url);
  }
  if (isBilibiliUrl(url)) {
    return extractBilibili(url);
  }
  if (isYoutubeUrl(url)) {
    return extractYoutube(url);
  }
  if (isZhihuUrl(url)) {
    return extractZhihu(url);
  }
  if (isWechatUrl(url)) {
    return extractWechat(url);
  }
  if (isXiaohongshuUrl(url)) {
    return extractXiaohongshu(url);
  }
  return extractWebpage(url);
}
