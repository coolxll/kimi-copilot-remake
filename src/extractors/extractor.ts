import type { ExtractedDocument, PageContext } from "../domain/types";

export type ExtractorId = "webpage" | "pdf" | "youtube" | "bilibili" | "feedly" | "discourse" | "zhihu";

export interface ExtractorDescriptor {
  readonly id: ExtractorId;
  readonly label: string;
  readonly outputKind: ExtractedDocument["kind"];
}

export interface ContentExtractor {
  readonly descriptor: ExtractorDescriptor;
  canHandle(context: PageContext): boolean;
  /**
   * Optional runtime check for extractors whose URL shape is shared by many
   * sites (for example Discourse). A failed probe simply lets the registry
   * continue to the next extractor.
   */
  probe?(context: PageContext, signal: AbortSignal): Promise<boolean>;
  extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument>;
}
