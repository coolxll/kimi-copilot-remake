import { describe, expect, it } from "vitest";
import { groupForReduction, splitText, trimSourceToLimit } from "../../src/integrations/openai-compatible/chunking";

describe("compatible provider chunking", () => {
  it("splits on paragraphs and headings before hard boundaries", () => {
    const chunks = splitText("# A\n\nfirst\n\n# B\n\nsecond", 12);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["# A\n\nfirst", "# B\n\nsecond"]);
  });

  it("truncates with both the beginning and end preserved", () => {
    const result = trimSourceToLimit("abcdefghij", 6);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("abc");
    expect(result.text).toContain("ij");
  });

  it("groups summaries without exceeding the requested target where possible", () => {
    expect(groupForReduction(["123", "456", "789"], 8)).toEqual([["123", "456"], ["789"]]);
  });
});
