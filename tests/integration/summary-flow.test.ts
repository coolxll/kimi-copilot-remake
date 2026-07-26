import { describe, expect, it, vi } from "vitest";
import { runSummary } from "../../src/application/summarize-page";
import { initialTaskState, taskReducer, type TaskState } from "../../src/application/task-state";
import type { AppServices } from "../../src/application/services";
import type { SummaryProvider } from "../../src/domain/types";
import { FakeProvider } from "../support/fake-provider";

function makeServices(provider: SummaryProvider): AppServices {
  return {
    storage: { getSettings: vi.fn(async () => ({ version: 2, defaultProvider: "kimi-web" })) } as never,
    auth: {} as never,
    extractors: [{
      id: "webpage",
      canHandle: () => true,
      extract: vi.fn(async () => ({ kind: "webpage" as const, title: "A", sourceUrl: "https://example.com", sourceText: "text", warnings: [] as string[] })),
    }],
    getProvider: vi.fn(async () => provider),
    testOpenAIConnection: vi.fn(async () => ({ ok: true, message: "ok" })),
  };
}

describe("summary application flow", () => {
  it("streams one selected provider into the task reducer", async () => {
    const provider: SummaryProvider = new FakeProvider("openai-compatible", "summary");
    const services = makeServices(provider);
    let state: TaskState = initialTaskState();
    await runSummary(services, "openai-compatible", { tabId: 1, url: "https://example.com" }, new AbortController().signal, (action) => {
      state = taskReducer(state, action);
    });
    expect(state).toMatchObject({ status: "success", provider: "openai-compatible", markdown: "summary" });
    expect(services.getProvider).toHaveBeenCalledTimes(1);
  });

  it("reports a provider error without asking for a fallback provider", async () => {
    const provider: SummaryProvider = {
      id: "openai-compatible",
      validateReady: vi.fn(async () => { throw new Error("upstream down"); }),
      summarize: async function* () { yield { type: "done" }; },
    };
    const services = makeServices(provider);
    let state: TaskState = initialTaskState();
    await runSummary(services, "openai-compatible", { tabId: 1, url: "https://example.com" }, new AbortController().signal, (action) => {
      state = taskReducer(state, action);
    });
    expect(state.status).toBe("error");
    expect(services.getProvider).toHaveBeenCalledTimes(1);
  });
});
