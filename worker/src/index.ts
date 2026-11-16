import type { Env, ExtractRequest, SummarizeRequest } from "./types";
import { extractFromUrl } from "./extractors/registry";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ ok: false, error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 1. Health check & basic landing info
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "Kimi Copilot Serverless Extractor API",
        version: "0.1.0",
        endpoints: {
          extract: "POST /api/extract or GET /api/extract?url=...",
          summarize: "POST /api/summarize",
        },
        supportedSites: ["Reddit", "Bilibili", "YouTube", "Zhihu", "WeChat", "Xiaohongshu", "Generic Webpage"],
      });
    }

    // 2. Extract content
    if (url.pathname === "/api/extract" || url.pathname === "/extract") {
      let targetUrl = "";

      if (request.method === "GET") {
        targetUrl = url.searchParams.get("url") ?? "";
      } else if (request.method === "POST") {
        try {
          const body = (await request.json()) as ExtractRequest;
          targetUrl = body.url;
        } catch {
          return errorResponse("请求体必须是有效的 JSON，包含 url 字段");
        }
      }

      if (!targetUrl || !targetUrl.startsWith("http")) {
        return errorResponse("请提供有效的 http/https 目标网址参数 (url)");
      }

      try {
        const extracted = await extractFromUrl(targetUrl);
        return jsonResponse({ ok: true, data: extracted });
      } catch (error) {
        return errorResponse(`内容提取失败: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // 3. Summarize endpoint
    if (url.pathname === "/api/summarize" || url.pathname === "/summarize") {
      if (request.method !== "POST") {
        return errorResponse("此接口仅支持 POST 方法", 405);
      }

      let req: SummarizeRequest;
      try {
        req = (await request.json()) as SummarizeRequest;
      } catch {
        return errorResponse("请求体必须是有效的 JSON");
      }

      if (!req.url || !req.url.startsWith("http")) {
        return errorResponse("请提供有效的目标网址 (url)");
      }

      // Step 1: Extract
      let extracted;
      try {
        extracted = await extractFromUrl(req.url);
      } catch (error) {
        return errorResponse(`内容提取失败: ${error instanceof Error ? error.message : String(error)}`, 500);
      }

      // Step 2: Determine AI provider credentials
      const apiKey = req.apiKey || env.OPENAI_API_KEY || env.KIMI_TOKEN;
      if (!apiKey) {
        // Return extracted document directly if no AI key configured
        return jsonResponse({
          ok: true,
          extractedOnly: true,
          notice: "未配置 API Key，已返回提取的纯净 Markdown 内容",
          document: extracted,
        });
      }

      const apiRoot = (req.apiRoot || env.OPENAI_API_ROOT || "https://api.openai.com/v1").replace(/\/+$/, "");
      const model = req.model || env.OPENAI_MODEL || "gpt-4o-mini";
      const prompt = req.prompt || env.DEFAULT_PROMPT || "请用中文对以下提取的网页正文做结构化、信息密集的高质量总结，列出核心观点、背景细节与要点清单：";

      try {
        const completionRes = await fetch(`${apiRoot}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "你是一位专业的内容分析与提炼助手。" },
              { role: "user", content: `${prompt}\n\n# ${extracted.title}\n\n${extracted.markdown}` },
            ],
            temperature: 0.3,
          }),
        });

        if (!completionRes.ok) {
          const errText = await completionRes.text();
          return errorResponse(`AI 接口调用失败 (${completionRes.status}): ${errText}`, 502);
        }

        const completionData = (await completionRes.json()) as any;
        const summary = completionData.choices?.[0]?.message?.content || "";

        return jsonResponse({
          ok: true,
          summary,
          document: extracted,
        });
      } catch (error) {
        return errorResponse(`总结生成异常: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    return errorResponse("未找到对应接口路径", 404);
  },
};
