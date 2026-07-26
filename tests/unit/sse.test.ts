import { describe, expect, it } from "vitest";
import { SseParser } from "../../src/integrations/shared/sse";

describe("SseParser", () => {
  it("parses CRLF and LF events across arbitrary chunks", () => {
    const parser = new SseParser();
    const events = [
      ...parser.feed("event: cmpl\r\ndata: {\"text\":\"你"),
      ...parser.feed("好\"}\r\n\r\ndata: [DONE]\n\n"),
    ];
    expect(events).toEqual([
      { event: "cmpl", data: '{"text":"你好"}' },
      { data: "[DONE]" },
    ]);
  });

  it("joins multiple data lines with a newline", () => {
    const parser = new SseParser();
    expect(parser.feed("data: one\ndata: two\n\n")).toEqual([{ data: "one\ntwo" }]);
  });
});
