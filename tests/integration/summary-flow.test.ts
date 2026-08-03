import { describe, expect, it, vi } from "vitest";
import { runSummary } from "../../src/application/summarize-page";
import { initialTaskState, taskReducer, type TaskState } from "../../src/application/task-state";
import type { AppServices } from "../../src/application/services";
import type { ExtractedDocument, PageContext, SummaryProvider } from "../../src/domain/types";
import { FakeProvider } from "../support/fake-provider";

type ExtractFn = (context: PageContext, signal: AbortSignal) => Promise<ExtractedDocument>;

function makeServices(provider: SummaryProvider, extract: ExtractFn = vi.fn(async (): Promise<ExtractedDocument> => ({ kind: "webpage", title: "A", sourceUrl: "https://example.com", sourceText: "text", warnings: [] }))): AppServices {
  return {
    storage: { getSettings: vi.fn(async () => ({ version: 2, defaultProvider: "kimi-web" })) } as never,
    auth: {} as never,
    webSessions: {} as never,
    extractors: [{
      descriptor: {
        id: "webpage",
        label: "普通网页",
        outputKind: "webpage",
      },
      canHandle: () => true,
      extract,
    }],
    getProvider: vi.fn(async () => provider),
    testOpenAIConnection: vi.fn(async () => ({ ok: true, message: "ok" })),
    testProviderConnection: vi.fn(async () => ({ ok: true, message: "ok" })),
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

  it("skips extension extraction when Gemini summarizes a YouTube URL directly", async () => {
    const extract = vi.fn(async (): Promise<ExtractedDocument> => ({ kind: "youtube", title: "Video", sourceUrl: "https://www.youtube.com/watch?v=video-id", sourceText: "字幕", warnings: [] }));
    const services = makeServices(new FakeProvider("gemini-web", "summary"), extract);
    let state: TaskState = initialTaskState();
    await runSummary(services, "gemini-web", { tabId: 1, title: "Video", url: "https://www.youtube.com/watch?v=video-id" }, new AbortController().signal, (action) => {
      state = taskReducer(state, action);
    });
    expect(extract).not.toHaveBeenCalled();
    expect(state).toMatchObject({ status: "success", provider: "gemini-web", markdown: "summary" });
  });
});
