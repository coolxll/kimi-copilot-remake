import type { PageContext, ExtractedDocument } from "../domain/types";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import { BilibiliExtractor } from "./bilibili";
import { FeedlyExtractor } from "./feedly";
import { PdfExtractor } from "./pdf";
import { WebpageExtractor } from "./webpage";
import { YoutubeExtractor } from "./youtube";

export function createExtractorRegistry(): ContentExtractor[] {
  return [new PdfExtractor(), new YoutubeExtractor(), new BilibiliExtractor(), new FeedlyExtractor(), new WebpageExtractor()];
}

export function selectExtractor(extractors: ContentExtractor[], context: PageContext): ContentExtractor {
  const extractor = extractors.find((candidate) => candidate.canHandle(context));
  if (!extractor) throw new AppError("unsupported-page", "当前页面类型暂不支持");
  return extractor;
}

export type { ExtractedDocument };
