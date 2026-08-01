import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGeminiWebRequest,
  completeGeminiWebRpc,
  extractGeminiWebContext,
  parseGeminiLine,
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

  it("builds the current StreamGenerate request without conversation credentials", () => {
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
    expect(modelHeader[4]).toBe("fbb127bbb056c959");
    expect(modelHeader[8]).toEqual([4, 5, 6, 8]);
    expect(requestPayload).toEqual([["只回复 PROJECT_OK"], null, ["", "", ""]]);
    expect(request.init.credentials).toBe("include");
  });

  it("parses the prefixed Gemini RPC response line", () => {
    expect(parseGeminiLine(buildGeminiLine("PROJECT_OK"))).toEqual({ text: "PROJECT_OK", thoughts: null });
  });

  it("refreshes page parameters and reads the streamed answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<html lang="en-US">"SNlM0e":"at-token","cfb2h":"bl-token","FdrFJe":"sid-token"</html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamFrom(buildGeminiLine("PROJECT_OK")),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeGeminiWebRpc("只回复 PROJECT_OK", new AbortController().signal)).resolves.toBe("PROJECT_OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://gemini.google.com/app");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: "include", method: "POST" });
  });
});
