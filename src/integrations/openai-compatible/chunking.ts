import { AppError } from "../../domain/errors";

export interface TextChunk {
  index: number;
  text: string;
}

export function trimSourceToLimit(source: string, maxChars: number): { text: string; truncated: boolean } {
  if (source.length <= maxChars) return { text: source, truncated: false };
  const marker = "\n\n[内容已截断]\n\n";
  const available = Math.max(0, maxChars - marker.length);
  if (available === 0) {
    const half = Math.max(1, Math.floor(maxChars / 2));
    return { text: `${source.slice(0, half)}${marker}${source.slice(-half)}`, truncated: true };
  }
  const headChars = Math.floor(available * 0.8);
  const tailChars = available - headChars;
  return {
    text: `${source.slice(0, headChars).replace(/\s+$/, "")}${marker}${source.slice(-tailChars).replace(/^\s+/, "")}`,
    truncated: true,
  };
}

export function splitText(source: string, chunkChars: number): TextChunk[] {
  if (chunkChars < 1) throw new AppError("provider-not-configured", "chunkChars 必须大于 0");
  const chunks: string[] = [];
  let current = "";
  const paragraphs = source.split(/(?=\n#{1,6}\s)|\n{2,}|\n/g);
  const append = (part: string) => {
    const value = part.trim();
    if (!value) return;
    if (current && current.length + value.length + 2 > chunkChars) {
      chunks.push(current.trim());
      current = "";
    }
    if (value.length <= chunkChars) {
      current = current ? `${current}\n\n${value}` : value;
      return;
    }
    if (current) {
      chunks.push(current.trim());
      current = "";
    }
    for (let offset = 0; offset < value.length; offset += chunkChars) {
      const hardChunk = value.slice(offset, offset + chunkChars).trim();
      if (hardChunk) chunks.push(hardChunk);
    }
  };
  for (const paragraph of paragraphs) append(paragraph);
  if (current.trim()) chunks.push(current.trim());
  return chunks.map((text, index) => ({ index, text }));
}

export function groupForReduction(texts: string[], chunkChars: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const text of texts) {
    const nextLength = currentLength + text.length + (current.length ? 2 : 0);
    if (current.length && nextLength > chunkChars) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(text);
    currentLength += text.length + (current.length > 1 ? 2 : 0);
  }
  if (current.length) groups.push(current);
  return groups;
}
