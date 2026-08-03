import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeepSeekPowResponse } from "../../src/integrations/web-session/deepseek-pow";
import { buildDeepSeekCompletionRequest, streamDeepSeekWebRpc, testDeepSeekWebConnection } from "../../src/integrations/web-session/deepseek-rpc";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("DeepSeek Web RPC", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a completion request with the web bearer token and PoW header", () => {
    const request = buildDeepSeekCompletionRequest("PROJECT_OK", "session-1", null, { userToken: "token-1", accessToken: "access-token-1" }, "pow-1");
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(request.url).toBe("https://chat.deepseek.com/api/v0/chat/completion");
    expect((request.init.headers as Record<string, string>).Authorization).toBe("Bearer access-token-1");
    expect((request.init.headers as Record<string, string>)["x-ds-pow-response"]).toBe("pow-1");
    expect(body).toMatchObject({ chat_session_id: "session-1", parent_message_id: null, prompt: "PROJECT_OK", thinking_enabled: false });
  });

  it("probes the account endpoint without creating a chat session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: { biz_data: { token: "access-token-1" } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(testDeepSeekWebConnection({ userToken: "user-token-1" }, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://chat.deepseek.com/api/v0/users/current");
  });

  it("builds the signed PoW response without network access", async () => {
    const value = await buildDeepSeekPowResponse({
      algorithm: "sha256",
      challenge: "challenge",
      difficulty: 0,
      salt: "salt",
      signature: "signature",
      expire_at: 123,
    }, "/api/v0/chat/completion");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)))) as Record<string, unknown>;
    expect(decoded).toMatchObject({ algorithm: "sha256", challenge: "challenge", salt: "salt", answer: 0, target_path: "/api/v0/chat/completion" });
  });

  it("streams response fragments and captures the assistant message id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { biz_data: { token: "access-token-1" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: "session-1" } } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { biz_data: { challenge: {
        algorithm: "sha256", challenge: "challenge", difficulty: 0, salt: "salt", signature: "signature", expire_at: 123,
      } } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(streamFrom([
        'data: {"v":{"response":{"message_id":9,"fragments":[{"type":"RESPONSE","content":"# 标题"}]}}}\n\n',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"\\n正文"}\n\n',
        "data: [DONE]\n\n",
      ].join("")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const updates: string[] = [];

    await expect(streamDeepSeekWebRpc("PROJECT_OK", { userToken: "token-1" }, new AbortController().signal, ({ text }) => updates.push(text)))
      .resolves.toEqual({ sessionId: "session-1", messageId: 9 });
    expect(updates).toEqual(["# 标题", "# 标题\n正文"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chat.deepseek.com/api/v0/users/current");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect((fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer access-token-1");
  });
});
