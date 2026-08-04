export type AppErrorCode =
  | "auth-required"
  | "token-refresh-failed"
  | "provider-not-configured"
  | "host-permission-denied"
  | "unsupported-page"
  | "extraction-failed"
  | "upload-failed"
  | "parse-failed"
  | "api-contract"
  | "api-auth"
  | "security-check-required"
  | "rate-limit"
  | "context-limit"
  | "api-unavailable"
  | "cancelled";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly cause?: unknown;
  readonly retryable: boolean;
  readonly diagnostic?: unknown;
  readonly externalUrl?: string;

  constructor(code: AppErrorCode, message: string, options: { cause?: unknown; retryable?: boolean; diagnostic?: unknown; externalUrl?: string } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
    this.diagnostic = options.diagnostic;
    this.externalUrl = options.externalUrl;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) return new AppError("cancelled", "已取消");
  if (error instanceof Error) return new AppError("api-unavailable", error.message, { cause: error });
  return new AppError("api-unavailable", "未知错误", { cause: error });
}
