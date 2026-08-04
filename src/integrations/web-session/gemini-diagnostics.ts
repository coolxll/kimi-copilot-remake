import type { AppErrorCode } from "../../domain/errors";

export type GeminiDiagnosticMode = "context" | "background" | "page";

export type GeminiDiagnosticStage =
  | "credential"
  | "context-tab-query"
  | "context-page-extract"
  | "context-background-fetch"
  | "request-build"
  | "request-send"
  | "response-headers"
  | "response-stream"
  | "response-parse"
  | "complete";

export type GeminiDiagnosticStatus = "start" | "success" | "warning" | "error";

export interface GeminiDiagnosticEvent {
  sequence: number;
  at: number;
  stage: GeminiDiagnosticStage;
  status: GeminiDiagnosticStatus;
  attempt?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface GeminiDiagnosticReport {
  version: 1;
  runId: string;
  mode: GeminiDiagnosticMode;
  startedAt: number;
  endedAt: number;
  outcome: "success" | "warning" | "error";
  summary: string;
  events: GeminiDiagnosticEvent[];
  externalUrl?: string;
}

export interface GeminiDiagnosticSink {
  emit(
    stage: GeminiDiagnosticStage,
    status: GeminiDiagnosticStatus,
    message: string,
    details?: Record<string, unknown>,
    attempt?: number,
  ): void;
}

const MAX_EVENTS = 96;
const MAX_DETAIL_DEPTH = 5;
const MAX_TEXT_LENGTH = 240;

export function createGeminiDiagnosticRecorder(
  mode: GeminiDiagnosticMode,
  now = () => Date.now(),
  onEvent?: (event: GeminiDiagnosticEvent) => void,
): GeminiDiagnosticRecorder {
  return new GeminiDiagnosticRecorder(mode, now, onEvent);
}

export class GeminiDiagnosticRecorder implements GeminiDiagnosticSink {
  readonly runId = createRunId();
  readonly startedAt: number;
  private sequence = 0;
  private readonly events: GeminiDiagnosticEvent[] = [];

  constructor(
    readonly mode: GeminiDiagnosticMode,
    private readonly now: () => number = () => Date.now(),
    private readonly onEvent?: (event: GeminiDiagnosticEvent) => void,
  ) {
    this.startedAt = now();
  }

  emit(
    stage: GeminiDiagnosticStage,
    status: GeminiDiagnosticStatus,
    message: string,
    details?: Record<string, unknown>,
    attempt?: number,
  ): void {
    if (this.events.length >= MAX_EVENTS) return;
    const event: GeminiDiagnosticEvent = {
      sequence: ++this.sequence,
      at: this.now(),
      stage,
      status,
      ...(typeof attempt === "number" ? { attempt } : {}),
      message: sanitizeDiagnosticText(message),
      ...(details ? { details: sanitizeDiagnosticDetails(details) as Record<string, unknown> } : {}),
    };
    this.events.push(event);
    this.onEvent?.(event);
  }

  finish(outcome: GeminiDiagnosticReport["outcome"], summary: string, externalUrl?: string): GeminiDiagnosticReport {
    return {
      version: 1,
      runId: this.runId,
      mode: this.mode,
      startedAt: this.startedAt,
      endedAt: this.now(),
      outcome,
      summary: sanitizeDiagnosticText(summary),
      events: this.events.slice(),
      ...(externalUrl ? { externalUrl } : {}),
    };
  }
}

export function sanitizeDiagnosticError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; code?: unknown; retryable?: unknown };
    return {
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      message: typeof value.message === "string" ? sanitizeDiagnosticText(value.message) : "未知错误",
      ...(typeof value.code === "string" ? { code: value.code as AppErrorCode } : {}),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    };
  }
  return { message: sanitizeDiagnosticText(String(error || "未知错误")) };
}

/** Preserve RPC array shape without retaining tokens, prompt, answer, or ids. */
export function summarizeGeminiStructure(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DETAIL_DEPTH) return { type: "truncated" };
  if (value === null) return null;
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 12).map((item) => summarizeGeminiStructure(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 24);
    return { type: "object", keys, keyCount: Object.keys(value as Record<string, unknown>).length };
  }
  return { type: typeof value };
}

export function sanitizeDiagnosticDetails(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DETAIL_DEPTH) return { type: "truncated" };
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => sanitizeDiagnosticDetails(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 48)) {
      if (/cookie|authorization|token|secret|password|prompt|body|payload|request|response|content|text|f\.req|atvalue|blvalue|fsid/i.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = sanitizeDiagnosticDetails(child, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, (url) => redactUrl(url))
    .replace(/(cookie|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .slice(0, MAX_TEXT_LENGTH);
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?<redacted>" : ""}`;
  } catch {
    return value.replace(/[?&][^\s)]+/g, "?<redacted>");
  }
}

export function isGeminiDiagnosticReport(value: unknown): value is GeminiDiagnosticReport {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.runId === "string"
    && (record.mode === "context" || record.mode === "background" || record.mode === "page")
    && typeof record.startedAt === "number"
    && typeof record.endedAt === "number"
    && (record.outcome === "success" || record.outcome === "warning" || record.outcome === "error")
    && typeof record.summary === "string"
    && Array.isArray(record.events);
}

function createRunId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
