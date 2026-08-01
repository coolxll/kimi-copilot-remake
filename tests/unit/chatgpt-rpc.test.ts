import { describe, expect, it } from "vitest";
import {
  buildChatGptWebRequest,
  parseChatGptStreamLine,
  readChatGptStream,
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
});
