import { describe, expect, it } from "vitest";
import {
  createGeminiDiagnosticRecorder,
  sanitizeDiagnosticDetails,
  summarizeGeminiStructure,
} from "../../src/integrations/web-session/gemini-diagnostics";

describe("Gemini diagnostics", () => {
  it("records live events while redacting request values", () => {
    const events: unknown[] = [];
    const recorder = createGeminiDiagnosticRecorder("background", () => 1_700_000_000_000, (event) => events.push(event));
    recorder.emit("request-build", "success", "请求构造完成", {
      authUser: "2",
      atValue: "secret-at-token",
      payload: "用户 prompt 和 token",
      finalUrl: "https://gemini.google.com/app?conversation=private-id",
    });
    const report = recorder.finish("warning", "收到协议事件");

    expect(events).toHaveLength(1);
    expect(report.events[0]?.details).toMatchObject({
      authUser: "2",
      atValue: "<redacted>",
      payload: "<redacted>",
      finalUrl: "https://gemini.google.com/app?<redacted>",
    });
  });

  it("keeps response samples structural instead of retaining text", () => {
    const summary = summarizeGeminiStructure([["wrb.fr", null, "PROJECT_OK"], { token: "secret" }]);
    expect(summary).toEqual({
      type: "array",
      length: 2,
      items: [
        { type: "array", length: 3, items: [{ type: "string", length: 6 }, null, { type: "string", length: 10 }] },
        { type: "object", keys: ["token"], keyCount: 1 },
      ],
    });
    expect(JSON.stringify(sanitizeDiagnosticDetails({ body: "PROJECT_OK", cookie: "secret" }))).not.toContain("PROJECT_OK");
  });
});
