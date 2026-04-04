import { describe, expect, it } from "vitest";
import { speakerLabelForInterval } from "../../../src/services/diarization/speakerLabelForInterval.js";
import type { SrtGenerationResult } from "../../../src/types/srtGeneration.js";

function dim(segments: SrtGenerationResult["segments"]): SrtGenerationResult {
  return {
    provider: "llm_client",
    model: "test",
    language: "en",
    audioSource: "dialogue_mixed",
    segmentCount: segments.length,
    srt: "",
    segments,
  };
}

describe("speakerLabelForInterval", () => {
  it("returns null without diarization", () => {
    expect(speakerLabelForInterval(0, 1000, undefined)).toBeNull();
    expect(speakerLabelForInterval(0, 1000, dim([]))).toBeNull();
  });

  it("picks speaker with max overlap", () => {
    const d = dim([
      { startMs: 0, endMs: 500, speakerLabel: "A", text: "x" },
      { startMs: 400, endMs: 2000, speakerLabel: "B", text: "y" },
    ]);
    expect(speakerLabelForInterval(0, 400, d)).toBe("A");
    expect(speakerLabelForInterval(500, 1500, d)).toBe("B");
  });

  it("returns null when no overlap", () => {
    const d = dim([{ startMs: 0, endMs: 100, speakerLabel: "A", text: "x" }]);
    expect(speakerLabelForInterval(200, 300, d)).toBeNull();
  });
});
