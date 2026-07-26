export function safeFilename(value: string, fallback = "webpage"): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, 160);
}
