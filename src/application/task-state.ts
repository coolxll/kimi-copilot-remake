import type { AppError } from "../domain/errors";
import type { ProviderId } from "../domain/types";

export type TaskState =
  | { status: "idle"; provider?: ProviderId }
  | { status: "loading"; provider: ProviderId; phase: string; current?: number; total?: number; markdown: string; warnings: string[] }
  | { status: "success"; provider: ProviderId; markdown: string; warnings: string[]; externalUrl?: string }
  | { status: "auth-required"; provider: ProviderId; message: string }
  | { status: "provider-not-configured"; provider: ProviderId; message: string }
  | { status: "error"; provider: ProviderId; error: AppError; canRetry: boolean };

export type TaskAction =
  | { type: "start"; provider: ProviderId }
  | { type: "phase"; phase: string; current?: number; total?: number }
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "done"; externalUrl?: string }
  | { type: "auth-required"; message: string }
  | { type: "provider-not-configured"; message: string }
  | { type: "error"; error: AppError }
  | { type: "reset" };

export function initialTaskState(): TaskState {
  return { status: "idle" };
}

export function taskReducer(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case "start":
      return { status: "loading", provider: action.provider, phase: "准备中", markdown: "", warnings: [] };
    case "phase":
      return state.status === "loading" ? { ...state, phase: phaseLabel(action.phase), current: action.current, total: action.total } : state;
    case "delta":
      return state.status === "loading" ? { ...state, markdown: state.markdown + action.text } : state;
    case "warning":
      return state.status === "loading" ? { ...state, warnings: [...state.warnings, action.message] } : state;
    case "done":
      return state.status === "loading"
        ? { status: "success", provider: state.provider, markdown: state.markdown, warnings: state.warnings, externalUrl: action.externalUrl }
        : state;
    case "auth-required":
      return { status: "auth-required", provider: state.status === "idle" ? "kimi-web" : state.provider, message: action.message };
    case "provider-not-configured":
      return { status: "provider-not-configured", provider: state.status === "idle" ? "openai-compatible" : state.provider, message: action.message };
    case "error":
      return { status: "error", provider: state.status === "idle" ? "kimi-web" : state.provider, error: action.error, canRetry: action.error.retryable };
    case "reset":
      return initialTaskState();
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "uploading": return "正在上传内容";
    case "chunking": return "正在拆分内容";
    case "summarizing": return "正在生成总结";
    default: return phase;
  }
}
