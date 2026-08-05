import type { PageContext, ExtractedDocument } from "../domain/types";
import { AppError } from "../domain/errors";
import type { ContentExtractor } from "./extractor";
import { BilibiliExtractor } from "./bilibili";
import { DiscourseExtractor } from "./discourse";
import { FeedlyExtractor } from "./feedly";
import { PdfExtractor } from "./pdf";
import { WebpageExtractor } from "./webpage";
import { YoutubeExtractor } from "./youtube";
import { ZhihuExtractor } from "./zhihu";
import { TwitterExtractor } from "./twitter";

type ExtractorFactory = () => ContentExtractor;

// The order is part of the routing contract: specialized extractors must run
// before the generic webpage fallback.
const EXTRACTOR_FACTORIES: readonly ExtractorFactory[] = [
  () => new PdfExtractor(),
  () => new YoutubeExtractor(),
  () => new BilibiliExtractor(),
  () => new FeedlyExtractor(),
  () => new DiscourseExtractor(),
  () => new ZhihuExtractor(),
  () => new TwitterExtractor(),
  () => new WebpageExtractor(),
];

export function createExtractorRegistry(): readonly ContentExtractor[] {
  return EXTRACTOR_FACTORIES.map((create) => create());
}

export async function selectExtractor(
  extractors: readonly ContentExtractor[],
  context: PageContext,
  signal?: AbortSignal,
): Promise<ContentExtractor> {
  const probeSignal = signal ?? new AbortController().signal;
  for (const candidate of extractors) {
    if (!candidate.canHandle(context)) continue;
    if (candidate.probe) {
      try {
        if (!(await candidate.probe(context, probeSignal))) continue;
      } catch (error) {
        if (probeSignal.aborted) throw error;
        continue;
      }
    }
    return candidate;
  }
  throw new AppError("unsupported-page", "当前页面类型暂不支持");
}

export type { ExtractedDocument };
