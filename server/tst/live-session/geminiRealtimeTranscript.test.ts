import { describe, expect, it } from "vitest";
import { transcriptionToSrt } from "../../src/media/transcriptFormatting.js";
import {
  mergeGeminiRealtimeRecordsToUtterances,
  speechTranscriptionFromGeminiUtterances,
} from "../../src/live-session/geminiRealtimeTranscript.js";
import type { RealtimeTranscriptionRecord } from "../../src/live-session/interviewBridgeCapture.js";

describe("mergeGeminiRealtimeRecordsToUtterances", () => {
  it("maps input/output to INTERVIEWEE/INTERVIEWER and uses [t_i, t_{i+1}] on anchor clock (no back-to-back packing)", () => {
    const records: RealtimeTranscriptionRecord[] = [
      { role: "input", text: "Hello", finished: true, offsetFromBridgeOpenMs: 5000 },
      { role: "output", text: "Hi there", finished: true, offsetFromBridgeOpenMs: 8000 },
    ];
    const anchorDeltaMs = 2000;
    const u = mergeGeminiRealtimeRecordsToUtterances(records, anchorDeltaMs);
    expect(u).toHaveLength(2);
    expect(u[0].speakerLabel).toBe("INTERVIEWEE");
    expect(u[0].segment.text).toBe("Hello");
    // (5000+2000)/1000 = 7s; next event at (8000+2000)/1000 = 10s
    expect(u[0].segment.startSec).toBeCloseTo(7, 5);
    expect(u[0].segment.endSec).toBeCloseTo(10, 5);

    expect(u[1].speakerLabel).toBe("INTERVIEWER");
    expect(u[1].segment.text).toBe("Hi there");
    expect(u[1].segment.startSec).toBeCloseTo(10, 5);
    expect(u[1].segment.endSec).toBeCloseTo(11, 5); // LAST_UTTERANCE_TAIL_SEC after last line
  });

  it("does not pack the next speaker’s start onto the previous line’s end when gaps are large", () => {
    const records: RealtimeTranscriptionRecord[] = [
      { role: "output", text: "Question?", finished: true, offsetFromBridgeOpenMs: 14_000 },
      { role: "input", text: "Answer.", finished: true, offsetFromBridgeOpenMs: 25_000 },
    ];
    const u = mergeGeminiRealtimeRecordsToUtterances(records, 0);
    expect(u[0].segment.startSec).toBeCloseTo(14, 5);
    expect(u[0].segment.endSec).toBeCloseTo(25, 5);
    expect(u[1].segment.startSec).toBeCloseTo(25, 5);
    expect(u[1].segment.text).toBe("Answer.");
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

  it("round-trips to non-empty SRT for post-process transcript.srt (same path as LiveSessionPostProcessor realtime branch)", () => {
    const u = mergeGeminiRealtimeRecordsToUtterances(
      [
        { role: "input", text: "Hello", finished: true, offsetFromBridgeOpenMs: 1000 },
        { role: "output", text: "Hi", finished: true, offsetFromBridgeOpenMs: 2000 },
      ],
      0,
    );
    const tr = speechTranscriptionFromGeminiUtterances(u);
    const srt = transcriptionToSrt(tr).trim();
    expect(srt.length).toBeGreaterThan(0);
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain("Hello");
    expect(srt).toContain("Hi");
  });
});
