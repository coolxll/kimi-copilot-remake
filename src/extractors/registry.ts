import type { PageContext, ExtractedDocument } from "../domain/types";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import { BilibiliExtractor } from "./bilibili";
import { FeedlyExtractor } from "./feedly";
import { PdfExtractor } from "./pdf";
import { WebpageExtractor } from "./webpage";
import { YoutubeExtractor } from "./youtube";

type ExtractorFactory = () => ContentExtractor;

// The order is part of the routing contract: specialized extractors must run
// before the generic webpage fallback.
const EXTRACTOR_FACTORIES: readonly ExtractorFactory[] = [
  () => new PdfExtractor(),
  () => new YoutubeExtractor(),
  () => new BilibiliExtractor(),
  () => new FeedlyExtractor(),
  () => new WebpageExtractor(),
];

export function createExtractorRegistry(): readonly ContentExtractor[] {
  return EXTRACTOR_FACTORIES.map((create) => create());
}

export function selectExtractor(extractors: readonly ContentExtractor[], context: PageContext): ContentExtractor {
  const extractor = extractors.find((candidate) => candidate.canHandle(context));
  if (!extractor) throw new AppError("unsupported-page", "当前页面类型暂不支持");
  return extractor;
}

export type { ExtractedDocument };
