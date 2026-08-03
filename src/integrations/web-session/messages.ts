import type { AppErrorCode } from "../../domain/errors";
import type { WebSessionProviderId } from "../../domain/types";

export const WEB_SESSION_PORT_NAME = "web-session-stream";

export type WebSessionPortRequest =
  | { type: "start"; requestId: string; providerId: WebSessionProviderId; prompt: string }
  | { type: "test"; requestId: string; providerId: WebSessionProviderId }
  | { type: "cancel"; requestId: string }
  | { type: "heartbeat"; requestId: string };

export type WebSessionPortMessage =
  | { type: "snapshot"; requestId: string; text: string }
  | { type: "done"; requestId: string; externalUrl?: string; message?: string }
  | { type: "error"; requestId: string; error: SerializedAppError };

export interface SerializedAppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}

export function serializeAppError(error: unknown): SerializedAppError {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return {
        code: value.code as AppErrorCode,
        message: value.message,
        retryable: value.retryable === true,
      };
    }
  }
  return { code: "api-unavailable", message: error instanceof Error ? error.message : "网页协议请求失败", retryable: true };
}

export function isWebSessionPortRequest(value: unknown): value is WebSessionPortRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.type === "start" || record.type === "test" || record.type === "cancel" || record.type === "heartbeat")
    && typeof record.requestId === "string";
}
