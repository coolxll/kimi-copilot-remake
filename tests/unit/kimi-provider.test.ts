import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/domain/errors";
import { KimiProvider } from "../../src/integrations/kimi/provider";
import type { SettingsRepository } from "../../src/platform/chrome/storage";
import type { SummaryEvent } from "../../src/domain/types";

describe("KimiProvider", () => {
  const createMockStorage = (tokens: { accessToken?: string; refreshToken: string } | null = { refreshToken: "tok" }): SettingsRepository => {
    return {
      getKimiTokens: vi.fn(async () => tokens),
      saveKimiTokens: vi.fn(async () => undefined),
      clearKimiTokens: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({} as any)),
      saveSettings: vi.fn(async () => undefined),
      getOpenAISecret: vi.fn(async () => null),
      saveOpenAISecret: vi.fn(async () => undefined),
      clearOpenAISecret: vi.fn(async () => undefined),
      getWebSessionCredential: vi.fn(async () => null),
      saveWebSessionCredential: vi.fn(async () => undefined),
      clearWebSessionCredential: vi.fn(async () => undefined),
      getGeminiDiagnosticReports: vi.fn(async () => []),
      saveGeminiDiagnosticReport: vi.fn(async () => undefined),
      clearGeminiDiagnosticReports: vi.fn(async () => undefined),
    };
  };

  it("throws auth-required if no tokens present", async () => {
    const storage = createMockStorage(null);
    const provider = new KimiProvider(storage);
    await expect(provider.validateReady()).rejects.toThrowError(AppError);
  });

  it("summarizes directly with prompt text and skips file upload for normal length pages", async () => {
    const storage = createMockStorage();
    const provider = new KimiProvider(storage);

    const uploadFileSpy = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/token/refresh")) {
        return new Response(JSON.stringify({ access_token: "acc", refresh_token: "tok" }), { status: 200 });
      }
      if (url.includes("/api/chat/") && url.includes("/completion/stream")) {
        const body = JSON.parse(String(init?.body));
        expect(body.refs).toEqual([]);
        expect(body.messages[0].content).toContain("正文：\n这是知乎回答正文");
        const sse = "data: {\"event\": \"cmpl\", \"text\": \"总结回答\"}\n\ndata: {\"event\": \"all_done\"}\n\n";
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.includes("/api/chat")) {
        return new Response(JSON.stringify({ id: "chat_123" }), { status: 200 });
      }
      if (url.includes("/api/pre-sign-url")) {
        uploadFileSpy();
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const events: SummaryEvent[] = [];
    for await (const event of provider.summarize({
      document: {
        kind: "webpage",
        title: "知乎问题讨论",
        sourceUrl: "https://www.zhihu.com/question/123",
        sourceText: "这是知乎回答正文",
        uploadFile: new File(["这是知乎回答正文"], "知乎问题.md", { type: "text/markdown" }),
        warnings: [],
      },
      prompt: "请总结核心观点",
    }, new AbortController().signal)) {
      events.push(event);
    }

    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "phase" && e.phase === "uploading")).toBe(false);
    expect(events.some((e) => e.type === "warning" && e.message.includes("文件上传或解析失败"))).toBe(false);
    expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "总结回答" });
  });

  it("attempts file upload when page text is empty (e.g. PDF)", async () => {
    const storage = createMockStorage();
    const provider = new KimiProvider(storage);

    let uploadCalled = false;
    let parseProgressCalled = false;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/token/refresh")) {
        return new Response(JSON.stringify({ access_token: "acc", refresh_token: "tok" }), { status: 200 });
      }
      if (url.includes("/apiv2-files/file/upload")) {
        uploadCalled = true;
        return new Response(JSON.stringify({ file: { id: "file_pdf_1" } }), { status: 200 });
      }
      if (url.includes("GetFileParseProgress")) {
        parseProgressCalled = true;
        return new Response(JSON.stringify({
          progresses: [{ file_id: "file_pdf_1", status: "SUCCESS" }],
        }), { status: 200 });
      }
      if (url.includes("/api/chat/") && url.includes("/completion/stream")) {
        const body = JSON.parse(String(init?.body));
        expect(body.refs).toEqual(["file_pdf_1"]);
        const sse = "data: {\"event\": \"cmpl\", \"text\": \"PDF 总结\"}\n\ndata: {\"event\": \"all_done\"}\n\n";
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.includes("/api/chat")) {
        return new Response(JSON.stringify({ id: "chat_456" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const events: SummaryEvent[] = [];
    for await (const event of provider.summarize({
      document: {
        kind: "pdf",
        title: "研究报告",
        sourceUrl: "https://example.com/doc.pdf",
        sourceText: "",
        uploadFile: new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }),
        warnings: [],
      },
      prompt: "总结该文档",
    }, new AbortController().signal)) {
      events.push(event);
    }

    expect(uploadCalled).toBe(true);
    expect(parseProgressCalled).toBe(true);
    expect(events.some((e) => e.type === "phase" && e.phase === "uploading")).toBe(true);
    expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "PDF 总结" });
  });

  it("throws error if PDF upload/parse fails and there is no fallback text", async () => {
    const storage = createMockStorage();
    const provider = new KimiProvider(storage);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/auth/token/refresh")) {
        return new Response(JSON.stringify({ access_token: "acc", refresh_token: "tok" }), { status: 200 });
      }
      if (url.includes("/apiv2-files/file/upload")) {
        return new Response(JSON.stringify({ file: { id: "file_pdf_failed" } }), { status: 200 });
      }
      if (url.includes("GetFileParseProgress")) {
        return new Response(JSON.stringify({
          progresses: [{ file_id: "file_pdf_failed", status: "FAILED", error: { message: "文档解析失败" } }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const run = async () => {
      for await (const _event of provider.summarize({
        document: {
          kind: "pdf",
          title: "损坏的PDF",
          sourceUrl: "https://example.com/broken.pdf",
          sourceText: "",
          uploadFile: new File(["bad"], "broken.pdf", { type: "application/pdf" }),
          warnings: [],
        },
        prompt: "总结该文档",
      }, new AbortController().signal)) {
        // iterate
      }
    };

    await expect(run()).rejects.toThrowError("Kimi 文件解析失败（文档解析失败）");
  });
});
