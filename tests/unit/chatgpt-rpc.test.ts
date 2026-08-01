import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChatGptWebRequest,
  parseChatGptStreamLine,
  readChatGptStream,
  runChatGptWebRpc,
} from "../../src/integrations/web-session/chatgpt-rpc";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("ChatGPT Web session RPC", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a same-origin conversation request with an in-memory bearer token", () => {
    const request = buildChatGptWebRequest("只回复 PROJECT_OK", "access-token");
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;

    expect(request.url).toBe("/backend-api/conversation");
    expect(request.init.credentials).toBe("include");
    expect((request.init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    expect(body.model).toBe("auto");
    expect(body.conversation_id).toBeNull();
    expect((body.messages as Array<{ content: { parts: string[] } }>)[0].content.parts).toEqual(["只回复 PROJECT_OK"]);
  });

  it("parses ChatGPT SSE lines and completion markers", () => {
    expect(parseChatGptStreamLine('data: {"message":{"content":{"parts":["PROJECT_OK"]}}}'))
      .toEqual({ done: false, text: "PROJECT_OK" });
    expect(parseChatGptStreamLine("data: [DONE]")).toEqual({ done: true, text: "" });
  });

  it("keeps the latest full answer from a streamed response", async () => {
    const response = new Response(streamFrom([
      'data: {"message":{"content":{"parts":["第一段"]}}}\n',
      'data: {"message":{"content":{"parts":["第一段\\n第二段"]}}}\n',
      "data: [DONE]\n",
    ].join("")));

    await expect(readChatGptStream(response)).resolves.toBe("第一段\n第二段");
  });

  it("reads the session and conversation response inside the page adapter", async () => {
    vi.stubGlobal("location", { origin: "https://chatgpt.com", href: "https://chatgpt.com/" });
    vi.stubGlobal("navigator", { language: "zh-CN" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "page-only-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(streamFrom([
        'data: {"message":{"content":{"parts":["PROJECT_OK"]}}}\n',
        "data: [DONE]\n",
      ].join("")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runChatGptWebRpc("只回复 PROJECT_OK")).resolves.toEqual({ status: "ok", text: "PROJECT_OK" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/session");
    expect(fetchMock.mock.calls[1][0]).toBe("/backend-api/register-websocket");
    expect(fetchMock.mock.calls[2][0]).toBe("/backend-api/conversation");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ credentials: "include", method: "POST" });
    expect((fetchMock.mock.calls[2][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer page-only-token" });
  });

  it("reads the reliable WebSocket response returned by modern ChatGPT", async () => {
    vi.stubGlobal("location", { origin: "https://chatgpt.com", href: "https://chatgpt.com/" });
    vi.stubGlobal("navigator", { language: "en-US" });
    const body = Buffer.from([
      'data: {"message":{"content":{"parts":["SOCKET_OK"]}}}\n',
      "data: [DONE]\n",
    ].join(""), "utf8").toString("base64");
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = 0;

      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "message", data: { response_id: "response-1", body }, sequenceId: 1 }),
          })), 0);
        }, 0);
      }

      send(): void {}

      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "page-only-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ wss_url: "wss://chatgpt.example/socket" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ wss_url: "wss://chatgpt.example/socket", response_id: "response-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runChatGptWebRpc("只回复 SOCKET_OK")).resolves.toEqual({ status: "ok", text: "SOCKET_OK" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
