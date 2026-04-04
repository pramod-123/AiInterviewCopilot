import { describe, expect, it } from "vitest";
import { parseDiarizationJson } from "../../../src/services/diarization/parseDiarizationJson.js";

describe("parseDiarizationJson", () => {
  it("parses whisperx output", () => {
    const raw = JSON.stringify({
      provider: "whisperx",
      model: "base",
      language: "en",
      segments: [
        { start: 0.5, end: 1.2, speaker: "SPEAKER_00", text: "Hello" },
        { start: 1.5, end: 2.0, speaker: "SPEAKER_01", text: "Hi there" },
      ],
    });
    const p = parseDiarizationJson(raw);
    expect(p).not.toBeNull();
    expect(p!.model).toBe("base");
    expect(p!.language).toBe("en");
    expect(p!.segments).toHaveLength(2);
    expect(p!.segments[0]).toEqual({
      startMs: 500,
      endMs: 1200,
      speaker: "SPEAKER_00",
      text: "Hello",
    });
  });

  it("parses openai_semantic provider", () => {
    const raw = JSON.stringify({
      provider: "openai_semantic",
      model: "gpt-4o-mini",
      language: "en",
      segments: [{ start: 0, end: 1, speaker: "INTERVIEWER", text: "Hi" }],
    });
    const p = parseDiarizationJson(raw);
    expect(p?.segments[0]?.speaker).toBe("INTERVIEWER");
  });

  it("returns null for invalid json", () => {
    expect(parseDiarizationJson("not json")).toBeNull();
    expect(parseDiarizationJson("{}")).toBeNull();
    expect(parseDiarizationJson(JSON.stringify({ provider: "other", segments: [] }))).toBeNull();
  });

  it("skips empty text and fixes end <= start", () => {
    const raw = JSON.stringify({
      provider: "whisperx",
      model: "base",
      segments: [
        { start: 1, end: 1, speaker: "A", text: "x" },
        { start: 2, end: 2.5, speaker: "B", text: "   " },
      ],
    });
    const p = parseDiarizationJson(raw);
    expect(p!.segments).toHaveLength(1);
    expect(p!.segments[0]!.endMs).toBeGreaterThan(p!.segments[0]!.startMs);
  });
});
