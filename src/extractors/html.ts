import TurndownService from "turndown";

export function cleanHtmlForUpload(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,iframe,object,embed,canvas,form,input,textarea,select,button").forEach((node) => node.remove());
  doc.querySelectorAll("[hidden], [aria-hidden='true']").forEach((node) => node.remove());
  doc.querySelectorAll("[srcdoc]").forEach((node) => node.removeAttribute("srcdoc"));
  return doc.body?.innerHTML ?? "";
}

export function htmlToMarkdown(html: string): string {
  const service = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  return service.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

export function wrapHtml(title: string, html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
