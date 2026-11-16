export interface ExtractedContent {
  title: string;
  markdown: string;
  imageUrls: string[];
  sourceUrl: string;
  extractor: string;
  warnings: string[];
}

export interface ExtractRequest {
  url: string;
}

export interface SummarizeRequest {
  url: string;
  prompt?: string;
  provider?: "kimi" | "openai-compatible";
  apiKey?: string;
  apiRoot?: string;
  model?: string;
}

export interface Env {
  KIMI_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_API_ROOT?: string;
  OPENAI_MODEL?: string;
  DEFAULT_PROMPT?: string;
}
