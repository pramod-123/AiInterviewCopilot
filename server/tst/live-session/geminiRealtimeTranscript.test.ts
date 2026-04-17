import { describe, expect, it } from "vitest";
import {
  mergeGeminiRealtimeRecordsToUtterances,
  speechTranscriptionFromGeminiUtterances,
} from "../../src/live-session/geminiRealtimeTranscript.js";
import type { RealtimeTranscriptionRecord } from "../../src/live-session/interviewBridgeCapture.js";

describe("mergeGeminiRealtimeRecordsToUtterances", () => {
  it("maps input/output to INTERVIEWEE/INTERVIEWER and aligns to anchor", () => {
    const records: RealtimeTranscriptionRecord[] = [
      { role: "input", text: "Hello", finished: true, offsetFromBridgeOpenMs: 5000 },
      { role: "output", text: "Hi there", finished: true, offsetFromBridgeOpenMs: 8000 },
    ];
    const anchorDeltaMs = 2000;
    const u = mergeGeminiRealtimeRecordsToUtterances(records, anchorDeltaMs);
    expect(u).toHaveLength(2);
    expect(u[0].speakerLabel).toBe("INTERVIEWEE");
    expect(u[0].segment.text).toBe("Hello");
    expect(u[0].segment.startSec).toBe(0);
    expect(u[0].segment.endSec).toBeCloseTo(7, 5);

    expect(u[1].speakerLabel).toBe("INTERVIEWER");
    expect(u[1].segment.text).toBe("Hi there");
    expect(u[1].segment.startSec).toBeCloseTo(7, 5);
    expect(u[1].segment.endSec).toBeCloseTo(10, 5);
  });

  it("flushes trailing unfinished text once", () => {
    const records: RealtimeTranscriptionRecord[] = [
      { role: "input", text: "Only partial", finished: false, offsetFromBridgeOpenMs: 1000 },
    ];
    const u = mergeGeminiRealtimeRecordsToUtterances(records, 0);
    expect(u).toHaveLength(1);
    expect(u[0].segment.text).toBe("Only partial");
  });
});

describe("speechTranscriptionFromGeminiUtterances", () => {
  it("builds SpeechTranscription with gemini_live_realtime provider", () => {
    const u = mergeGeminiRealtimeRecordsToUtterances(
      [{ role: "input", text: "A", finished: true, offsetFromBridgeOpenMs: 1000 }],
      0,
    );
    const tr = speechTranscriptionFromGeminiUtterances(u);
    expect(tr.providerId).toBe("gemini_live_realtime");
    expect(tr.segments).toHaveLength(1);
    expect(tr.fullText).toContain("A");
    expect(tr.segments[0]!.speakerLabel).toBe("INTERVIEWEE");
  });
});
