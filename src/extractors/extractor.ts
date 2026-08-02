import type { ExtractedDocument, PageContext } from "../domain/types";

export type ExtractorId = "webpage" | "pdf" | "youtube" | "bilibili" | "feedly";

export interface ExtractorDescriptor {
  readonly id: ExtractorId;
  readonly label: string;
  readonly outputKind: ExtractedDocument["kind"];
}

export interface ContentExtractor {
  readonly descriptor: ExtractorDescriptor;
  canHandle(context: PageContext): boolean;
  extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument>;
}
