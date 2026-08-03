export type WebSessionProviderId = "chatgpt-web" | "gemini-web" | "deepseek-web";

export type WebSessionCredential =
  | {
      providerId: "chatgpt-web";
      accessToken: string;
      deviceId?: string;
      capturedAt: number;
      expiresAt?: number;
    }
  | {
      providerId: "gemini-web";
      authUser: string;
      capturedAt: number;
    }
  | {
      providerId: "deepseek-web";
      userToken: string;
      capturedAt: number;
    };
export type ProviderId = "kimi-web" | WebSessionProviderId | "openai-compatible";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "kimi-web": "Kimi Web",
  "chatgpt-web": "ChatGPT Web",
  "gemini-web": "Gemini Web",
  "deepseek-web": "DeepSeek Web",
  "openai-compatible": "OpenAI Compatible",
};

export function isWebSessionProvider(providerId: ProviderId): providerId is WebSessionProviderId {
  return providerId === "chatgpt-web" || providerId === "gemini-web" || providerId === "deepseek-web";
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (value === "kimi-web" || value === "openai-compatible" || isWebSessionProvider(value as ProviderId));
}

export type DocumentKind = "webpage" | "bilibili" | "youtube" | "pdf";

export interface ExtractedDocument {
  kind: DocumentKind;
  title: string;
  sourceUrl: string;
  sourceText: string;
  imageUrls?: string[];
  uploadFile?: File;
  warnings: string[];
}

export interface SummaryRequest {
  document: ExtractedDocument;
  prompt: string;
}

export type SummaryEvent =
  | {
      type: "phase";
      phase: "uploading" | "chunking" | "summarizing";
      current?: number;
      total?: number;
    }
  | { type: "delta"; text: string }
  | { type: "snapshot"; text: string }
  | { type: "warning"; message: string }
  | { type: "done"; externalUrl?: string };

export interface SummaryProvider {
  id: ProviderId;
  validateReady(): Promise<void>;
  summarize(request: SummaryRequest, signal: AbortSignal): AsyncIterable<SummaryEvent>;
}

export interface OpenAICompatibleConfig {
  apiRoot: string;
  model: string;
  chunkChars: number;
  maxSourceChars: number;
}

export interface AppSettingsV2 {
  version: 2;
  defaultProvider: ProviderId;
  promptOverride?: string;
  openAICompatible?: OpenAICompatibleConfig;
}

export interface OpenAICompatibleSecret {
  apiToken: string;
}

export interface KimiTokens {
  accessToken?: string;
  refreshToken: string;
}

export interface PageContext {
  tabId: number;
  url: string;
  title?: string;
}

export const DEFAULT_PROMPT = "请返回您反复阅读正文后精心写成的详尽笔记";
export const DEFAULT_CHUNK_CHARS = 12_000;
export const DEFAULT_MAX_SOURCE_CHARS = 200_000;

export const DEFAULT_OPENAI_CONFIG: OpenAICompatibleConfig = {
  apiRoot: "https://api.openai.com/v1",
  model: "",
  chunkChars: DEFAULT_CHUNK_CHARS,
  maxSourceChars: DEFAULT_MAX_SOURCE_CHARS,
};

export function createDefaultSettings(): AppSettingsV2 {
  return {
    version: 2,
    defaultProvider: "kimi-web",
    promptOverride: undefined,
    openAICompatible: { ...DEFAULT_OPENAI_CONFIG },
  };
}
