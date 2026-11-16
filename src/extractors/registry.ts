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
import { XiaohongshuExtractor } from "./xiaohongshu";
import { WechatExtractor } from "./wechat";
import { RedditExtractor } from "./reddit";
import {
  BUILTIN_DECLARATIVE_RULES,
  DeclarativeExtractor,
  type DeclarativeRule,
} from "./declarative";

export interface RegisterOptions {
  priority?: number;
  enabled?: boolean;
}

export class ExtractorRegistry {
  private readonly items = new Map<string, ContentExtractor>();
  private readonly priorities = new Map<string, number>();
  private readonly disabledIds = new Set<string>();

  constructor() {
    this.registerDefaults();
  }

  register(extractor: ContentExtractor, options?: RegisterOptions): this {
    const id = extractor.descriptor.id;
    this.items.set(id, extractor);

    const priority = options?.priority ?? extractor.descriptor.priority ?? 100;
    this.priorities.set(id, priority);

    if (options?.enabled === false || extractor.descriptor.enabled === false) {
      this.disabledIds.add(id);
    } else if (options?.enabled === true) {
      this.disabledIds.delete(id);
    }
    return this;
  }

  registerRule(rule: DeclarativeRule): this {
    const extractor = new DeclarativeExtractor(rule);
    return this.register(extractor, { priority: rule.priority ?? 100 });
  }

  unregister(id: string): boolean {
    this.priorities.delete(id);
    this.disabledIds.delete(id);
    return this.items.delete(id);
  }

  enable(id: string): this {
    this.disabledIds.delete(id);
    return this;
  }

  disable(id: string): this {
    this.disabledIds.add(id);
    return this;
  }

  isEnabled(id: string): boolean {
    return this.items.has(id) && !this.disabledIds.has(id);
  }

  getExtractors(): readonly ContentExtractor[] {
    const active = Array.from(this.items.values()).filter((item) => !this.disabledIds.has(item.descriptor.id));
    return active.sort((a, b) => {
      const pA = this.priorities.get(a.descriptor.id) ?? 100;
      const pB = this.priorities.get(b.descriptor.id) ?? 100;
      return pB - pA;
    });
  }

  async select(context: PageContext, signal?: AbortSignal): Promise<ContentExtractor> {
    return selectExtractor(this.getExtractors(), context, signal);
  }

  private registerDefaults(): void {
    // 1. Specialized code extractors (ordered by priority descending)
    this.register(new PdfExtractor(), { priority: 200 });
    this.register(new YoutubeExtractor(), { priority: 190 });
    this.register(new BilibiliExtractor(), { priority: 180 });
    this.register(new FeedlyExtractor(), { priority: 170 });
    this.register(new DiscourseExtractor(), { priority: 160 });
    this.register(new ZhihuExtractor(), { priority: 150 });
    this.register(new TwitterExtractor(), { priority: 140 });
    this.register(new XiaohongshuExtractor(), { priority: 130 });
    this.register(new WechatExtractor(), { priority: 120 });
    this.register(new RedditExtractor(), { priority: 110 });

    // 2. Built-in declarative rule extractors
    for (const rule of BUILTIN_DECLARATIVE_RULES) {
      this.registerRule(rule);
    }

    // 3. Fallback generic webpage extractor (lowest priority)
    this.register(new WebpageExtractor(), { priority: 0 });
  }
}

/** Global default registry singleton */
let defaultRegistryInstance: ExtractorRegistry | undefined;

export function getDefaultRegistry(): ExtractorRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new ExtractorRegistry();
  }
  return defaultRegistryInstance;
}

/**
 * Creates an array of active extractors for routing.
 * Preserves backward compatibility with existing tests and callers.
 */
export function createExtractorRegistry(): readonly ContentExtractor[] {
  return new ExtractorRegistry().getExtractors();
}

/**
 * Evaluates candidate extractors in priority order and returns the first matching one.
 */
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
