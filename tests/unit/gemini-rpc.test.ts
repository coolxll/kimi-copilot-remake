import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGeminiWebRequest,
  completeGeminiWebRpc,
  extractGeminiWebContext,
  parseGeminiLine,
  parseGeminiProtocolErrorCode,
} from "../../src/integrations/web-session/gemini-rpc";

function buildGeminiLine(text: string): string {
  const candidate: unknown[] = [];
  candidate[0] = "choice-1";
  candidate[1] = [text];
  const payload: unknown[] = [];
  payload[1] = ["conversation-1", "response-1"];
  payload[4] = [candidate];
  return `)]}'${JSON.stringify([["wrb.fr", null, JSON.stringify(payload)]])}\n`;
}

function buildGeminiStream(...texts: string[]): string {
  return texts.map((text) => buildGeminiLine(text)).join("");
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("Gemini Web RPC", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts the short-lived request context from Gemini HTML", () => {
    const html = '<html lang="zh-CN"><script>"SNlM0e":"at-token","cfb2h":"bl-token","FdrFJe":"sid-token"</script><div data-index="2"></div></html>';
    expect(extractGeminiWebContext(html)).toEqual({
      atValue: "at-token",
      blValue: "bl-token",
      fSid: "sid-token",
      locale: "zh-CN",
      authUser: "2",
    });
  });

  it("accepts the current thykhd token and account redirect", () => {
    const html = '<html lang="en-US"><script>"thykhd" : "new-at-token", "cfb2h":"bl-token","FdrFJe":"sid-token"</script></html>';
    expect(extractGeminiWebContext(html, "0", "https://gemini.google.com/u/3/app")).toMatchObject({
      atValue: "new-at-token",
      authUser: "3",
      accountPrefix: "/u/3",
    });
  });

  it("prefers the StreamGenerate SNlM0e token when both page token keys exist", () => {
    const html = '<html lang="en-US"><script>"SNlM0e":"stream-at-token", "thykhd":"other-token", "cfb2h":"bl-token", "FdrFJe":"sid-token"</script></html>';
    expect(extractGeminiWebContext(html).atValue).toBe("stream-at-token");
  });

  it("builds the current account-routed StreamGenerate request", () => {
    const request = buildGeminiWebRequest("只回复 PROJECT_OK", {
      atValue: "at-token",
      blValue: "bl-token",
      fSid: "sid-token",
      locale: "zh-CN",
      authUser: "0",
    });
    const body = request.init.body as URLSearchParams;
    const modelHeader = JSON.parse((request.init.headers as Record<string, string>)["x-goog-ext-525001261-jspb"]);
    const requestPayload = JSON.parse(JSON.parse(body.get("f.req") || "[]")[1]);

    expect(request.url).toContain("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?");
    expect(request.url).toContain("bl=bl-token");
    expect(request.url).toContain("f.sid=sid-token");
    expect(request.url).not.toContain("pageId=none");
    expect(modelHeader[4]).toBe("56fdd199312815e2");
    expect(modelHeader[8]).toEqual([4, 5, 6, 8]);
    expect(modelHeader[11]).toBe(1);
    expect(modelHeader[14]).toBe(1);
    expect(modelHeader[15]).toBe(1);
    expect(requestPayload).toHaveLength(3);
    expect(requestPayload[0]).toEqual(["只回复 PROJECT_OK"]);
    expect(requestPayload[2]).toEqual(["", "", ""]);
    expect((request.init.headers as Record<string, string>)["x-goog-ext-525005358-jspb"]).toBeTruthy();
    expect((request.init.headers as Record<string, string>)["x-goog-ext-73010989-jspb"]).toBe("[0]");
    expect((request.init.headers as Record<string, string>)["x-goog-ext-73010990-jspb"]).toBe("[0,0,0]");
    expect(request.init.credentials).toBe("include");
  });

  it("routes non-zero Gemini accounts through the account prefix and header", () => {
    const request = buildGeminiWebRequest("只回复 PROJECT_OK", {
      atValue: "at-token",
      blValue: "bl-token",
      fSid: "sid-token",
      locale: "en-US",
      authUser: "2",
    });
    expect(request.url).toContain("https://gemini.google.com/u/2/_/BardChatUi");
    expect((request.init.headers as Record<string, string>)["X-Goog-AuthUser"]).toBe("2");
  });

  it("parses the prefixed Gemini RPC response line", () => {
    expect(parseGeminiLine(buildGeminiLine("PROJECT_OK"))).toEqual({
      text: "PROJECT_OK",
      thoughts: null,
      conversationId: "conversation-1",
      responseId: "response-1",
      choiceId: "choice-1",
    });
  });

  it("recognizes Gemini protocol error events", () => {
    expect(parseGeminiProtocolErrorCode(`)]}'${JSON.stringify([["e", 5, null, null, 469]])}`)).toBe(469);
  });

  it("refreshes page parameters and reads the streamed answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: "https://gemini.google.com/app",
        text: async () => '<html lang="en-US">"SNlM0e":"at-token","cfb2h":"bl-token","FdrFJe":"sid-token"</html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamFrom(buildGeminiStream("PROJECT", "PROJECT_OK")),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeGeminiWebRpc("只回复 PROJECT_OK", new AbortController().signal)).resolves.toBe("PROJECT_OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://gemini.google.com/app");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: "include", method: "POST" });
  });

  it("refreshes context once after a protocol error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: "https://gemini.google.com/app",
        text: async () => '<html lang="en-US">"thykhd":"at-token-1","cfb2h":"bl-token-1","FdrFJe":"sid-token-1"</html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamFrom(`)]}'${JSON.stringify([["e", 5, null, null, 469]])}\n`),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: "https://gemini.google.com/app",
        text: async () => '<html lang="en-US">"thykhd":"at-token-2","cfb2h":"bl-token-2","FdrFJe":"sid-token-2"</html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamFrom(buildGeminiStream("PROJECT_OK")),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeGeminiWebRpc("只回复 PROJECT_OK", new AbortController().signal)).resolves.toBe("PROJECT_OK");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the requested account when refreshing context", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "https://gemini.google.com/u/2/app",
      text: async () => '<html lang="en-US">"SNlM0e":"at-token","cfb2h":"bl-token","FdrFJe":"sid-token"</html>',
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchGeminiWebContext } = await import("../../src/integrations/web-session/gemini-rpc");
    await expect(fetchGeminiWebContext(new AbortController().signal, "2")).resolves.toMatchObject({ authUser: "2" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gemini.google.com/u/2/app");
  });
});
