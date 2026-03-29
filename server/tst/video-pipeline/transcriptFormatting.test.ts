import { describe, expect, it } from "vitest";
import { SpeechSegment, SpeechTranscription } from "../../src/types/speechTranscription.js";
import {
  alignFramesToSpeech,
  buildFinalTranscriptJson,
  finalTranscriptToEvaluationTimeline,
  stringifyInterviewTimelineForEvaluation,
} from "../../src/video-pipeline/transcriptFormatting.js";

function stt(
  segments: Array<{ start: number; end: number; text: string }>,
  durationSec = 10,
): SpeechTranscription {
  return new SpeechTranscription(
    segments.map((s) => new SpeechSegment(s.start, s.end, s.text)),
    durationSec,
    "en",
    null,
    "test",
    null,
  );
}

describe("buildFinalTranscriptJson", () => {
  it("places frame OCR into the speech slice that contains the frame time", () => {
    const transcription = stt([{ start: 0, end: 5, text: "hello" }]);
    const final = buildFinalTranscriptJson(transcription, [1, 2], ["a", "b"]);
    expect(final.length).toBeGreaterThanOrEqual(1);
    const speechSlice = final.find((s) => s.audioTranscript.includes("hello"));
    expect(speechSlice).toBeDefined();
    expect(speechSlice!.frameData.map((f) => f.text)).toEqual(["a", "b"]);
  });

  it("audio-only path yields empty frameData per slice", () => {
    const transcription = stt([{ start: 0, end: 1, text: "x" }]);
    const final = buildFinalTranscriptJson(transcription, [], []);
    const withSpeech = final.find((s) => s.audioTranscript === "x");
    expect(withSpeech?.frameData).toEqual([]);
  });
});

describe("finalTranscriptToEvaluationTimeline", () => {
  it("maps audioTranscript to speech and frame texts to frameData", () => {
    const final = [
      {
        start: 0,
        end: 1000,
        audioTranscript: "hi",
        frameData: [{ frameNumber: 1, text: "code" }],
      },
    ];
    const tl = finalTranscriptToEvaluationTimeline(final);
    expect(tl).toEqual([{ start: 0, end: 1000, speech: "hi", frameData: ["code"] }]);
  });
});

describe("stringifyInterviewTimelineForEvaluation", () => {
  it("returns pretty JSON when under maxChars", () => {
    const segs = [{ start: 0, end: 1, speech: "a", frameData: [] as string[] }];
    const s = stringifyInterviewTimelineForEvaluation(segs, 10_000);
    expect(s).toContain('"start": 0');
    expect(JSON.parse(s)).toEqual(segs);
  });

  it("shrinks when over maxChars", () => {
    const segs = [
      { start: 0, end: 1, speech: "x".repeat(500), frameData: ["a", "b", "c"] },
    ];
    const s = stringifyInterviewTimelineForEvaluation(segs, 80);
    expect(s.length).toBeLessThanOrEqual(80 + 200);
  });
});

describe("alignFramesToSpeech", () => {
  it("attaches overlapping speech segments to a frame record", () => {
    const segments = [
      new SpeechSegment(0, 2, "one"),
      new SpeechSegment(2, 4, "two"),
    ];
    const records = alignFramesToSpeech([1], ["ocr"], segments);
    expect(records).toHaveLength(1);
    expect(records[0]!.ocrText).toBe("ocr");
    expect(records[0]!.overlappingSpeech.length).toBeGreaterThanOrEqual(1);
  });
});
