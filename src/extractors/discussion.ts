import { safeFilename } from "../shared/filename";

export interface DiscussionItem {
  id: string;
  author: string;
  body: string;
  likes?: number;
  score?: number;
  createdAt?: string;
  ordinal?: number;
  replyTo?: string;
  replyToLabel?: string;
}
export function createMarkdownFile(title: string, markdown: string): File {
  return new File([markdown], `${safeFilename(title)}.md`, { type: "text/markdown" });
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function cleanInline(value: unknown, fallback = "未知用户"): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || fallback;
}

export function renderDiscussionItem(item: DiscussionItem, label: string): string {
  const metadata = [
    `@${cleanInline(item.author)}`,
    formatDate(item.createdAt),
    typeof item.likes === "number" ? `${item.likes} 赞` : "",
    item.replyToLabel || (item.replyTo ? `回复 ${item.replyTo}` : ""),
  ].filter(Boolean).join(" · ");
  return `### ${label}${metadata ? ` · ${metadata}` : ""}\n\n${item.body.trim() || "（无正文）"}`;
}

export function appendWarningSection(markdown: string, warnings: readonly string[]): string {
  if (!warnings.length) return markdown;
  return `${markdown.trim()}\n\n---\n\n> 提取提示：${warnings.join("；")}`;
}
