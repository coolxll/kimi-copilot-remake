import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/chrome/permissions", () => ({
  hasApiHostPermission: vi.fn(async () => true),
  validateApiRoot: (value: string) => new URL(value),
}));

import { OpenAICompatibleProvider } from "../../src/integrations/openai-compatible/provider";

describe("OpenAICompatibleProvider", () => {
  it("maps fragmented Chat Completions SSE deltas", async () => {
    const chunks = [`data: {"choices":[{"delta":{"content":"你`, `好"}}]}\n\n`, "data: [DONE]\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      config: { apiRoot: "https://example.com/v1", model: "demo", chunkChars: 12_000, maxSourceChars: 200_000 },
      secret: { apiToken: "test-token" },
    });
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of provider.summarize({ document: { kind: "webpage", title: "A", sourceUrl: "https://a", sourceText: "body", warnings: [] }, prompt: "summarize" }, new AbortController().signal)) events.push(event as typeof events[number]);
    expect(events).toEqual([{ type: "phase", phase: "summarizing", current: 1, total: 1 }, { type: "delta", text: "你好" }, { type: "done" }]);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/v1/chat/completions", expect.objectContaining({ method: "POST" }));
  });

  it("accepts a non-stream JSON response when the service ignores stream=true", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "普通 JSON 总结" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      config: { apiRoot: "https://example.com/v1", model: "demo", chunkChars: 12_000, maxSourceChars: 200_000 },
      secret: { apiToken: "test-token" },
    });
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of provider.summarize({ document: { kind: "webpage", title: "A", sourceUrl: "https://a", sourceText: "body", warnings: [] }, prompt: "summarize" }, new AbortController().signal)) events.push(event as typeof events[number]);
    expect(events).toEqual([{ type: "phase", phase: "summarizing", current: 1, total: 1 }, { type: "delta", text: "普通 JSON 总结" }, { type: "done" }]);
  });
});
