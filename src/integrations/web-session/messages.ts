import type { AppErrorCode } from "../../domain/errors";
import type { WebSessionProviderId } from "../../domain/types";
import type { GeminiDiagnosticEvent, GeminiDiagnosticMode, GeminiDiagnosticReport } from "./gemini-diagnostics";

export const WEB_SESSION_PORT_NAME = "web-session-stream";

/** File metadata sent in the JSON-safe start message. */
export interface WebSessionFileMetadata {
  name: string;
  type: string;
  size: number;
}

/** The reconstructed file payload used by provider-specific upload adapters. */
export interface WebSessionFilePayload extends WebSessionFileMetadata {
  data: ArrayBuffer;
}

export type WebSessionPortRequest =
  | { type: "start"; requestId: string; providerId: WebSessionProviderId; prompt: string; file?: WebSessionFileMetadata }
  | { type: "file-chunk"; requestId: string; index: number; data: string }
  | { type: "test"; requestId: string; providerId: WebSessionProviderId }
  | { type: "gemini-diagnostic"; requestId: string; mode: GeminiDiagnosticMode }
  | { type: "cancel"; requestId: string }
  | { type: "heartbeat"; requestId: string };

export type WebSessionPortMessage =
  | { type: "snapshot"; requestId: string; text: string }
  | { type: "done"; requestId: string; externalUrl?: string; message?: string }
  | { type: "diagnostic-event"; requestId: string; event: GeminiDiagnosticEvent }
  | { type: "diagnostic-done"; requestId: string; report: GeminiDiagnosticReport; externalUrl?: string }
  | { type: "error"; requestId: string; error: SerializedAppError; diagnostic?: GeminiDiagnosticReport; externalUrl?: string };

export interface SerializedAppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  externalUrl?: string;
}

export function serializeAppError(error: unknown): SerializedAppError {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown; externalUrl?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return {
        code: value.code as AppErrorCode,
        message: value.message,
        retryable: value.retryable === true,
        ...(typeof value.externalUrl === "string" ? { externalUrl: value.externalUrl } : {}),
      };
    }
  }
  return { code: "api-unavailable", message: error instanceof Error ? error.message : "网页协议请求失败", retryable: true };
}

export function isWebSessionPortRequest(value: unknown): value is WebSessionPortRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!(record.type === "start" || record.type === "file-chunk" || record.type === "test" || record.type === "gemini-diagnostic" || record.type === "cancel" || record.type === "heartbeat")
    || typeof record.requestId !== "string") return false;
  if (record.type === "gemini-diagnostic") {
    return record.mode === "context" || record.mode === "background" || record.mode === "page";
  }
  return true;
}
