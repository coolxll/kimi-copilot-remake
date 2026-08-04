import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChatGptWebRequest,
  generateChatGptProofToken,
  parseChatGptStreamLine,
  prepareChatGptWebConversation,
  readChatGptStream,
  streamChatGptWebRpc,
  testChatGptWebRpc,
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

  it("builds a background conversation request with an in-memory bearer token", () => {
    const request = buildChatGptWebRequest("只回复 PROJECT_OK", "access-token");
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;

    expect(request.url).toBe("https://chatgpt.com/backend-api/conversation");
    expect(request.init.credentials).toBe("include");
    expect((request.init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    expect(body.model).toBe("auto");
    expect(body.conversation_id).toBeNull();
    expect((body.messages as Array<{ content: { parts: string[] } }>)[0].content.parts).toEqual(["只回复 PROJECT_OK"]);
  });

  it("adds an uploaded file reference to the conversation metadata", () => {
    const request = buildChatGptWebRequest("请总结附件", "access-token", {
      fileReference: { id: "file_1", mimeType: "text/plain", name: "notes.txt", size: 128 },
    });
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    const message = (body.messages as Array<{ metadata: { attachments: Array<Record<string, unknown>> } }>)[0];

    expect(message.metadata.attachments).toEqual([{ id: "file_1", mime_type: "text/plain", name: "notes.txt", size: 128 }]);
  });

  it("prepares models, Sentinel requirements and account capabilities", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ models: [{ slug: "auto" }] }), { status: 200 });
      if (url.includes("/sentinel/chat-requirements")) return new Response(JSON.stringify({ token: "requirements-token" }), { status: 200 });
      return new Response("shared_websocket", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareChatGptWebConversation(
      { accessToken: "access-token", deviceId: "device-id", cookieHeader: "session=browser" },
      new AbortController().signal,
    )).resolves.toMatchObject({ model: "auto", sharedWebsocket: true, requirements: { token: "requirements-token" } });

    expect(fetchMock).toHaveBeenCalledWith("https://chatgpt.com/backend-api/models", expect.objectContaining({ method: "GET" }));
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-token");
    expect(headers["Oai-Device-Id"]).toBe("device-id");
    expect(headers.Cookie).toBe("session=browser");
    expect(fetchMock).toHaveBeenCalledWith("https://chatgpt.com/backend-api/sentinel/chat-requirements", expect.objectContaining({ method: "POST" }));
  });

  it("generates a cancellable Sentinel proof token", async () => {
    const token = await generateChatGptProofToken("seed", "ffffffffffffffff", "Mozilla/5.0");
    expect(token.startsWith("gAAAAAB")).toBe(true);
  });

  it("surfaces Arkose as a security check instead of clearing authentication", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ models: [{ slug: "auto" }] }), { status: 200 });
      return new Response(JSON.stringify({ token: "requirements-token", arkose: { required: true } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(testChatGptWebRpc({ accessToken: "access-token" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "security-check-required" });
  });

  it("parses cumulative ChatGPT SSE lines and conversation ids", () => {
    expect(parseChatGptStreamLine('data: {"conversation_id":"conversation-1","message":{"content":{"parts":["PROJECT_OK"]}}}'))
      .toEqual({ done: false, text: "PROJECT_OK", conversationId: "conversation-1" });
    expect(parseChatGptStreamLine("data: [DONE]")).toEqual({ done: true, text: "" });
    expect(parseChatGptStreamLine('data: {"message":{"content":{"content_type":"reasoning","parts":["hidden"]}}}'))
      .toMatchObject({ done: false, text: "" });
  });

  it("keeps the latest full answer from a streamed response", async () => {
    const response = new Response(streamFrom([
      'data: {"conversation_id":"conversation-1","message":{"content":{"parts":["第一段"]}}}\n',
      'data: {"conversation_id":"conversation-1","message":{"content":{"parts":["第一段\\n第二段"]}}}\n',
      "data: [DONE]\n",
    ].join("")));

    await expect(readChatGptStream(response)).resolves.toBe("第一段\n第二段");
  });

  it("reads the current shared-websocket body frames", async () => {
    class FakeWebSocket {
      static readonly instances: FakeWebSocket[] = [];
      readonly url: string;
      readonly protocol?: string;
      readyState = 0;
      private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

      constructor(url: string, protocol?: string) {
        this.url = url;
        this.protocol = protocol;
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open", {});
        });
      }

      addEventListener(type: string, listener: (event: { data?: string }) => void): void {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      send(): void {}

      close(): void {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        this.emit("close", {});
      }

      emit(type: string, event: { data?: string }): void {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
    }

    const encode = (value: string): string => {
      const bytes = new TextEncoder().encode(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) return Promise.resolve(new Response(JSON.stringify({ models: [{ slug: "auto" }] }), { status: 200 }));
      if (url.includes("/sentinel/chat-requirements")) return Promise.resolve(new Response(JSON.stringify({ token: "requirements-token" }), { status: 200 }));
      if (url.includes("/accounts/check/")) return Promise.resolve(new Response("shared_websocket", { status: 200 }));
      if (url.includes("register-websocket")) {
        return Promise.resolve(new Response(JSON.stringify({ wss_url: "wss://stream.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      queueMicrotask(() => {
        const socket = FakeWebSocket.instances[0];
        socket.emit("message", {
          data: JSON.stringify({
            type: "http.response.body",
            conversation_id: "conversation-modern",
            body: encode('data: {"conversation_id":"conversation-modern","message":{"content":{"parts":["PROJECT_OK"]}}}'),
          }),
        });
        socket.emit("message", {
          data: JSON.stringify({
            type: "http.response.body",
            conversation_id: "conversation-modern",
            body: encode("data: [DONE]"),
          }),
        });
      });
      return Promise.resolve(new Response(JSON.stringify({
        conversation_id: "conversation-modern",
        websocket_request_id: "request-modern",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", fetchMock);
    const snapshots: string[] = [];

    await expect(streamChatGptWebRpc(
      "只回复 PROJECT_OK",
      { accessToken: "access-token" },
      new AbortController().signal,
      ({ text }) => snapshots.push(text),
    )).resolves.toEqual({ conversationId: "conversation-modern" });
    expect(snapshots).toEqual(["PROJECT_OK"]);
    expect(FakeWebSocket.instances[0].protocol).toBeUndefined();
  });

  it("sends request-scoped browser session context without changing the bearer token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: "auto" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "requirements-token", proofofwork: { required: true, seed: "seed", difficulty: "ffffffffffffffff" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"conversation_id":"conversation-sse","message":{"content":{"parts":["PROJECT_OK"]}}}\n',
        "data: [DONE]\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamChatGptWebRpc(
      "只回复 PROJECT_OK",
      { accessToken: "access-token", deviceId: "device-id", cookieHeader: "oai-did=device-id; session=browser" },
      new AbortController().signal,
      () => undefined,
    )).resolves.toEqual({ conversationId: "conversation-sse" });
    const headers = fetchMock.mock.calls[3][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-token");
    expect(headers["Oai-Device-Id"]).toBe("device-id");
    expect(headers.Cookie).toBe("oai-did=device-id; session=browser");
    expect(headers["Openai-Sentinel-Chat-Requirements-Token"]).toBe("requirements-token");
    expect(headers["Openai-Sentinel-Proof-Token"]).toMatch(/^gAAAAAB/);
  });

  it("uploads a file before sending the attached conversation", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return Promise.resolve(new Response(JSON.stringify({ models: [{ slug: "auto" }] }), { status: 200 }));
      if (url.includes("/sentinel/chat-requirements")) return Promise.resolve(new Response(JSON.stringify({ token: "requirements-token" }), { status: 200 }));
      if (url.includes("/accounts/check/")) return Promise.resolve(new Response("{}", { status: 200 }));
      if (url.endsWith("/backend-api/files")) return Promise.resolve(new Response(JSON.stringify({ file_id: "file_1", upload_url: "https://blob.example/upload" }), { status: 201 }));
      if (url === "https://blob.example/upload") return Promise.resolve(new Response("", { status: 201 }));
      if (url.endsWith("/files/file_1/uploaded")) return Promise.resolve(new Response(JSON.stringify({ status: "success" }), { status: 200 }));
      expect(init?.method).toBe("POST");
      return Promise.resolve(new Response([
        'data: {"conversation_id":"conversation-file","message":{"content":{"parts":["PROJECT_OK"]}}}\n',
        "data: [DONE]\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = {
      name: "notes.txt",
      type: "text/plain",
      size: 5,
      data: new TextEncoder().encode("hello").buffer as ArrayBuffer,
    };
    await expect(streamChatGptWebRpc("请总结附件", { accessToken: "access-token" }, new AbortController().signal, () => undefined, file))
      .resolves.toEqual({ conversationId: "conversation-file" });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    const completionBody = JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body)) as Record<string, unknown>;
    expect((completionBody.messages as Array<{ metadata: { attachments: unknown[] } }>)[0].metadata.attachments).toHaveLength(1);
    expect(fetchMock.mock.calls[4]?.[1]?.method).toBe("PUT");
  });
});
