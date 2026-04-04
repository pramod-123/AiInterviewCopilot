import { describe, expect, it } from "vitest";
import { speechTranscriptionFromWhisperXSrt } from "../../../src/services/srt-generator/speechTranscriptionFromWhisperXSrt.js";
import type { SrtGenerationResult } from "../../../src/types/srtGeneration.js";

describe("speechTranscriptionFromWhisperXSrt", () => {
  it("maps WhisperX SRT result to SpeechTranscription", () => {
    const result: SrtGenerationResult = {
      provider: "whisperx",
      model: "base",
      language: "en",
      audioSource: "dialogue_mixed",
      segmentCount: 2,
      srt: "",
      segments: [
        { startMs: 0, endMs: 1000, text: "Hello", speakerLabel: "SPEAKER_00" },
        { startMs: 1000, endMs: 2500, text: "world", speakerLabel: "SPEAKER_01" },
      ],
    };
    const t = speechTranscriptionFromWhisperXSrt(result);
    expect(t.providerId).toBe("whisperx");
    expect(t.modelId).toBe("base");
    expect(t.language).toBe("en");
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]!.startSec).toBe(0);
    expect(t.segments[0]!.endSec).toBe(1);
    expect(t.segments[0]!.text).toBe("Hello");
    expect(t.segments[1]!.text).toBe("world");
    expect(t.durationSec).toBe(2.5);
    expect(t.fullText).toBe("Hello world");
  });
});
