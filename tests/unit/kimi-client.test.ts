import { describe, expect, it, vi } from "vitest";
import { KimiClient } from "../../src/integrations/kimi/client";

describe("KimiClient token refresh", () => {
  it("shares one refresh request across concurrent clients", async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/api/auth/token/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "rotated" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "chat" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onTokensRefreshed = vi.fn(async () => undefined);
    const tokens = { refreshToken: "shared-refresh" };
    const first = new KimiClient({ tokens, onTokensRefreshed });
    const second = new KimiClient({ tokens, onTokensRefreshed: vi.fn(async () => undefined) });
    await Promise.all([first.createChat(), second.createChat()]);
    expect(refreshCalls).toBe(1);
    expect(onTokensRefreshed).toHaveBeenCalledTimes(1);
  });

  it("probes connectivity by refreshing tokens without creating a chat", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/api/auth/token/refresh");
      return new Response(JSON.stringify({ access_token: "access", refresh_token: "rotated" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onTokensRefreshed = vi.fn(async () => undefined);

    await new KimiClient({ tokens: { refreshToken: "refresh" }, onTokensRefreshed }).testConnection();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onTokensRefreshed).toHaveBeenCalledWith({ accessToken: "access", refreshToken: "rotated" });
  });

  it("uploads a file through apiv2-files FormData upload", async () => {
    const urlsRequested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urlsRequested.push(url);
      if (url.includes("/api/auth/token/refresh")) {
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), { status: 200 });
      }
      if (url.includes("/apiv2-files/file/upload")) {
        expect(init?.method).toBe("POST");
        expect(init?.body instanceof FormData).toBe(true);
        return new Response(JSON.stringify({ file: { id: "file_v2_123" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new KimiClient({ tokens: { accessToken: "access", refreshToken: "refresh" }, onTokensRefreshed: async () => undefined });
    const file = new File(["# Title"], "doc.md", { type: "text/markdown" });
    const result = await client.uploadFile(file);

    expect(result).toEqual({ id: "file_v2_123" });
    expect(urlsRequested.some((u) => u.includes("/apiv2-files/file/upload"))).toBe(true);
  });

  it("falls back to legacy pre-sign-url upload when apiv2-files is rejected", async () => {
    const urlsRequested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urlsRequested.push(url);
      if (url.includes("/api/auth/token/refresh")) {
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), { status: 200 });
      }
      if (url.includes("/apiv2-files/file/upload")) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("/api/pre-sign-url")) {
        return new Response(JSON.stringify({ url: "https://tos.volces.com/upload-target", object_name: "obj_123" }), { status: 200 });
      }
      if (url.includes("upload-target")) {
        expect(init?.method).toBe("PUT");
        return new Response("", { status: 200 });
      }
      if (url.includes("/api/file")) {
        return new Response(JSON.stringify({ id: "file_legacy_456" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new KimiClient({ tokens: { accessToken: "access", refreshToken: "refresh" }, onTokensRefreshed: async () => undefined });
    const file = new File(["# Title"], "doc.md", { type: "text/markdown" });
    const result = await client.uploadFile(file);

    expect(result).toEqual({ id: "file_legacy_456" });
    expect(urlsRequested.some((u) => u.includes("/apiv2-files/file/upload"))).toBe(true);
    expect(urlsRequested.some((u) => u.includes("/api/pre-sign-url"))).toBe(true);
  });

  it("waits for file parsing via GetFileParseProgress RPC endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("GetFileParseProgress")) {
        return new Response(JSON.stringify({
          progresses: [{ file_id: "file_456", status: "SUCCESS" }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new KimiClient({ tokens: { accessToken: "access", refreshToken: "refresh" }, onTokensRefreshed: async () => undefined });
    const status = await client.waitForParse("file_456", new AbortController().signal);

    expect(status).toBe("parsed");
  });

  it("falls back to legacy SSE parse_process when RPC endpoint fails", async () => {
    const sseChunks = [
      ":heartbeat\n\n",
      "data: \n\n",
      "data: {\"status\": \"parsing\"}\n\n",
      "data: {\"status\": \"parsed\"}\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("GetFileParseProgress")) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("/api/file/parse_process")) {
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new KimiClient({ tokens: { accessToken: "access", refreshToken: "refresh" }, onTokensRefreshed: async () => undefined });
    const status = await client.waitForParse("file_456", new AbortController().signal);

    expect(status).toBe("parsed");
  });
});
