import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors";
import { initialTaskState, taskReducer } from "../../src/application/task-state";

describe("summary task state", () => {
  it("accumulates deltas and preserves warnings in the success state", () => {
    let state = initialTaskState();
    state = taskReducer(state, { type: "start", provider: "openai-compatible" });
    state = taskReducer(state, { type: "phase", phase: "summarizing", current: 1, total: 1 });
    state = taskReducer(state, { type: "warning", message: "truncated" });
    state = taskReducer(state, { type: "delta", text: "hello" });
    state = taskReducer(state, { type: "done" });
    expect(state).toMatchObject({ status: "success", provider: "openai-compatible", markdown: "hello", warnings: ["truncated"] });
  });

  it("replaces cumulative web snapshots and keeps partial Markdown on failure", () => {
    let state = initialTaskState();
    state = taskReducer(state, { type: "start", provider: "chatgpt-web" });
    state = taskReducer(state, { type: "snapshot", text: "# title" });
    state = taskReducer(state, { type: "snapshot", text: "# title\n\nfinal" });
    expect(state).toMatchObject({ status: "loading", markdown: "# title\n\nfinal" });
    state = taskReducer(state, { type: "error", error: new AppError("api-unavailable", "stream stopped", { retryable: true }) });
    expect(state).toMatchObject({ status: "error", markdown: "# title\n\nfinal", warnings: [] });
  });

  it("does not turn a cancelled task into an error", () => {
    let state = initialTaskState();
    state = taskReducer(state, { type: "start", provider: "kimi-web" });
    state = taskReducer(state, { type: "reset" });
    expect(state).toEqual({ status: "idle" });
  });
});
