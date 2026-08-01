import { describe, expect, it } from "vitest";
import {
  chooseYoutubeCaptionTrack,
  isYoutubeCaptionUrlPoTokenGated,
  isYoutubePageUrl,
  parseYoutubeTranscript,
  stripYoutubeCaptionFormat,
} from "../../src/domain/youtube";
import { YoutubeExtractor } from "../../src/extractors/youtube";

describe("YouTube page detection", () => {
  it("recognizes video pages across supported URL forms", () => {
    expect(isYoutubePageUrl("https://www.youtube.com/watch?v=demo")).toBe(true);
    expect(isYoutubePageUrl("https://youtu.be/demo")).toBe(true);
    expect(isYoutubePageUrl("https://www.youtube.com/shorts/demo")).toBe(true);
    expect(isYoutubePageUrl("https://www.youtube.com/channel/demo")).toBe(false);
  });

  it("does not treat a lookalike hostname as a YouTube page", () => {
    const extractor = new YoutubeExtractor();
    expect(extractor.canHandle({ tabId: 1, url: "https://youtube.com.evil.example/watch?v=demo" })).toBe(false);
    expect(extractor.canHandle({ tabId: 1, url: "https://www.youtube.com/watch?v=demo" })).toBe(true);
  });
});

describe("YouTube caption track selection", () => {
  it("prefers manually created Chinese captions over generated or unrelated tracks", () => {
    const manualChinese = { languageCode: "zh-CN", baseUrl: "https://manual" };
    expect(chooseYoutubeCaptionTrack([
      { languageCode: "en", kind: "asr", baseUrl: "https://generated-en" },
      { languageCode: "fr", baseUrl: "https://manual-fr" },
      manualChinese,
    ])).toEqual(manualChinese);
  });

  it("falls back to preferred generated captions before an unrelated manual track", () => {
    const generatedChinese = { languageCode: "zh-Hans", kind: "asr", baseUrl: "https://generated-zh" };
    expect(chooseYoutubeCaptionTrack([
      { languageCode: "fr", baseUrl: "https://manual-fr" },
      generatedChinese,
    ])).toEqual(generatedChinese);
  });

  it("ignores caption tracks without a downloadable URL", () => {
    expect(chooseYoutubeCaptionTrack([
      { languageCode: "zh-CN" },
      { languageCode: "en", baseUrl: "https://english" },
    ])).toEqual({ languageCode: "en", baseUrl: "https://english" });
  });
});

describe("YouTube caption parsing", () => {
  it("parses the legacy XML response and decodes entities", () => {
    expect(parseYoutubeTranscript([
      "<transcript>",
      '<text start="0">你好 &amp; welcome</text>',
      '<text start="1.25">第二句</text>',
      "</transcript>",
    ].join(""))).toBe("[0] 你好 & welcome\n[1.25] 第二句");
  });

  it("parses YouTube JSON3 events", () => {
    expect(parseYoutubeTranscript(JSON.stringify({ events: [
      { tStartMs: 0, segs: [{ utf8: "第一" }, { utf8: "句" }] },
      { tStartMs: 1250, segs: [{ utf8: "第二句\n" }] },
    ] }))).toBe("[0] 第一句\n[1.25] 第二句");
  });

  it("parses WebVTT responses and removes rolling duplicate cues", () => {
    expect(parseYoutubeTranscript([
      "WEBVTT",
      "",
      "00:00:00.320 --> 00:00:03.000",
      "第一句<00:00:01.000><c>内容</c>",
      "",
      "00:00:02.900 --> 00:00:04.000",
      "第一句内容",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "第二句 &amp; 其他",
    ].join("\n"))).toBe("[0.32] 第一句内容\n[4] 第二句 & 其他");
  });

  it("parses transcript snippet arrays", () => {
    expect(parseYoutubeTranscript(JSON.stringify([
      { start: 0, text: "第一句" },
      { start: 1.25, text: "第二句" },
    ]))).toBe("[0] 第一句\n[1.25] 第二句");
  });

  it("parses SRT and TTML responses", () => {
    expect(parseYoutubeTranscript([
      "1",
      "00:00:00,500 --> 00:00:01,500",
      "SRT 一句",
      "",
      "2",
      "00:00:01,500 --> 00:00:02,500",
      "SRT 二句",
    ].join("\n"))).toBe("[0.5] SRT 一句\n[1.5] SRT 二句");
    expect(parseYoutubeTranscript([
      "<tt xmlns:tt=\"urn:tt\"><body><tt:p begin=\"00:00:00.750\">TTML 一句</tt:p></body></tt>",
    ].join(""))).toBe("[0.75] TTML 一句");
  });

  it("uses a vssId when a client omits languageCode", () => {
    const generatedChinese = { vssId: "a.zh-Hans", baseUrl: "https://generated" };
    expect(chooseYoutubeCaptionTrack([
      { languageCode: "fr", baseUrl: "https://french" },
      generatedChinese,
    ])).toEqual(generatedChinese);
  });

  it("recognizes PO-token-gated web caption URLs and removes a preselected format", () => {
    const url = "https://www.youtube.com/api/timedtext?v=video&exp=xpe&fmt=srv3&lang=en";
    expect(isYoutubeCaptionUrlPoTokenGated(url)).toBe(true);
    expect(stripYoutubeCaptionFormat(url)).toBe("https://www.youtube.com/api/timedtext?v=video&exp=xpe&lang=en");
    expect(isYoutubeCaptionUrlPoTokenGated("https://www.youtube.com/api/timedtext?v=video&exp=foo")).toBe(false);
  });

  it("returns an empty transcript for an empty or unsupported response", () => {
    expect(parseYoutubeTranscript("  ")).toBe("");
    expect(parseYoutubeTranscript(JSON.stringify({ playabilityStatus: "ERROR" }))).toBe("");
  });
});
