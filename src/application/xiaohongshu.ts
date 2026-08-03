import { AppError } from "../domain/errors";
import type { ExtractedDocument, ProviderId } from "../domain/types";
import { extractImageUrls, uniqueImageUrls } from "../shared/image-links";
import type { AppServices } from "./services";

export const MD2CARD_EDITOR_URL = "https://md2card.com/zh/editor";
const MAX_REUSABLE_IMAGE_URLS = 12;

/** Repurpose is target-oriented; each target owns its output format and exporter. */
export type RepurposeTarget = "xiaohongshu" | "weibo" | "x";
export type RepurposeFormat = "md2card-long-image" | "native-post-text" | "native-thread-text";
export type RepurposeRenderer = "md2card" | "native";

export const REPURPOSE_TARGETS: Record<RepurposeTarget, { label: string; format: RepurposeFormat; renderer: RepurposeRenderer; editorUrl?: string }> = {
  xiaohongshu: { label: "小红书风格长图文", format: "md2card-long-image", renderer: "md2card", editorUrl: MD2CARD_EDITOR_URL },
  weibo: { label: "微博原生文字/配图", format: "native-post-text", renderer: "native" },
  x: { label: "X 原生短帖/线程", format: "native-thread-text", renderer: "native" },
};

export const XIAOHONGSHU_REPURPOSE_PROMPT = `你是一名小红书内容编辑和 Markdown 长图文排版师。请把输入的文章总结改写成可以直接导入 md2card.com/zh/editor 的小红书风格 Markdown 长图文稿。

请严格遵守以下要求：
1. 只输出最终 Markdown 正文，不要解释你的处理过程，不要使用 Markdown 代码围栏包裹，也不要在正文前后添加“以下是”等套话。
2. 第一行输出一个具体、吸引人但不夸张的一级标题（# ）。正文按 4～8 个短卡片组织，每张卡片使用二级标题（## ）分隔；每张卡片只讲一个重点，适合手机阅读。
3. 保留原总结中的事实、数字、限定条件和因果关系；不确定的内容要明确标注，不要补写输入中没有的事实、案例、数据或结论。
4. 使用短段落、项目符号、少量加粗和自然的 emoji，避免表格、代码块、超长段落和营销腔。结构尽量包含：开场钩子、核心观点、可执行建议、结尾总结。
5. 结尾给出 5～10 个与主题相关的 #话题标签，并保留原文来源链接（如果有）。
6. 只能使用“可复用图片链接”清单中的原始 http(s) 图片 URL，并用标准 Markdown 图片语法 ![图片描述](图片URL) 放在合适的卡片中。必须逐字保留 URL，不得改写、拼接、猜测或生成任何图片 URL；没有可复用图片时不要输出图片占位符。

可复用图片链接：
{{IMAGE_URLS}}

请直接输出 Markdown。`;

export interface RepurposeProgress {
  phase?: string;
  markdown?: string;
  warning?: string;
}

export interface RepurposeResult {
  target: RepurposeTarget;
  format: RepurposeFormat;
  markdown: string;
  imageUrls: string[];
  warnings: string[];
}

export async function generateRepurpose(
  services: AppServices,
  providerId: ProviderId,
  summaryMarkdown: string,
  sourceDocument: ExtractedDocument | undefined,
  signal: AbortSignal,
  onProgress?: (progress: RepurposeProgress) => void,
  target: RepurposeTarget = "xiaohongshu",
): Promise<RepurposeResult> {
  const summary = summaryMarkdown.trim();
  if (!summary) throw new AppError("extraction-failed", "没有可改写的总结内容");

  const imageUrls = uniqueImageUrls([
    ...(sourceDocument?.imageUrls ?? []),
    ...(sourceDocument ? extractImageUrls(sourceDocument.sourceText, sourceDocument.sourceUrl) : []),
    ...extractImageUrls(summary, sourceDocument?.sourceUrl),
  ], sourceDocument?.sourceUrl).slice(0, MAX_REUSABLE_IMAGE_URLS);
  if (target !== "xiaohongshu") {
    throw new AppError("api-contract", `${REPURPOSE_TARGETS[target].label}的输出适配器尚未接入`);
  }
  const prompt = buildRepurposePrompt(target, imageUrls);
  const provider = await services.getProvider(providerId);
  await provider.validateReady();

  const document: ExtractedDocument = {
    kind: "webpage",
    title: sourceDocument?.title || "文章总结",
    sourceUrl: sourceDocument?.sourceUrl || "",
    sourceText: summary,
    warnings: [],
  };
  let output = "";
  const warnings: string[] = [];
  for await (const event of provider.summarize({ document, prompt }, signal)) {
    if (event.type === "phase") {
      onProgress?.({ phase: event.phase });
    } else if (event.type === "delta") {
      output += event.text;
      onProgress?.({ markdown: output });
    } else if (event.type === "snapshot") {
      output = event.text;
      onProgress?.({ markdown: output });
    } else if (event.type === "warning") {
      warnings.push(event.message);
      onProgress?.({ warning: event.message });
    }
  }

  const sanitized = sanitizeXiaohongshuMarkdown(output, imageUrls);
  const markdown = appendMissingImageLinks(sanitized, imageUrls);
  if (!markdown.trim()) throw new AppError("api-contract", "小红书改写没有返回可用的 Markdown");
  const missingImageCount = imageUrls.filter((url) => !extractImageUrls(sanitized).includes(url)).length;
  if (missingImageCount > 0) warnings.push(`已补入 ${missingImageCount} 个原文图片链接，可在 md2card 导出前检查或删改`);
  if (!imageUrls.length) warnings.push("原总结或原文没有检测到可复用的 http(s) 图片链接，改写结果不会自动生成图片占位符");
  return { target, format: REPURPOSE_TARGETS[target].format, markdown, imageUrls, warnings: unique(warnings) };
}

export function buildRepurposePrompt(target: RepurposeTarget, imageUrls: readonly string[]): string {
  if (target !== "xiaohongshu") {
    throw new AppError("api-contract", `${REPURPOSE_TARGETS[target].label}的提示词尚未接入`);
  }
  const imageList = imageUrls.length ? imageUrls.map((url) => `- ${url}`).join("\n") : "（没有检测到可复用图片链接）";
  return XIAOHONGSHU_REPURPOSE_PROMPT.replace("{{IMAGE_URLS}}", imageList);
}

export function sanitizeXiaohongshuMarkdown(markdown: string, allowedImageUrls: readonly string[]): string {
  const allowed = new Set(allowedImageUrls);
  const unwrapped = unwrapMarkdownFence(markdown).trim();
  return unwrapped.replace(/!\[([^\]]*)\]\(\s*<?([^>\s)]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi, (full, _alt: string, url: string) => {
    return allowed.has(url) ? full : "";
  }).replace(/\n{3,}/g, "\n\n").trim();
}

export function appendMissingImageLinks(markdown: string, imageUrls: readonly string[]): string {
  const present = new Set(extractImageUrls(markdown));
  const missing = imageUrls.filter((url) => !present.has(url));
  if (!missing.length) return markdown;
  const images = missing.map((url, index) => `![配图 ${index + 1}](${url})`).join("\n\n");
  return `${markdown.trim()}\n\n## 配图参考\n\n${images}`.trim();
}

function unwrapMarkdownFence(markdown: string): string {
  const match = markdown.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1] ?? markdown;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
