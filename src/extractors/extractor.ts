import type { ExtractedDocument, PageContext } from "../domain/types";

export interface ContentExtractor {
  id: ExtractedDocument["kind"];
  canHandle(context: PageContext): boolean;
  extract(context: PageContext, signal: AbortSignal): Promise<ExtractedDocument>;
}
