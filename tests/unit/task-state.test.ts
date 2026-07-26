import { describe, expect, it } from "vitest";
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

  it("does not turn a cancelled task into an error", () => {
    let state = initialTaskState();
    state = taskReducer(state, { type: "start", provider: "kimi-web" });
    state = taskReducer(state, { type: "reset" });
    expect(state).toEqual({ status: "idle" });
  });
});
