import { describe, expect, it } from "vitest";
import { SpeechSegment, SpeechTranscription } from "../../../src/types/speechTranscription.js";
import { transcriptionToEvaluationInput } from "../../../src/services/evaluation/transcriptionToEvaluationInput.js";

describe("transcriptionToEvaluationInput", () => {
  it("maps segments to ms and builds full text from fullText when set", () => {
    const stt = new SpeechTranscription(
      [new SpeechSegment(1.234, 2.5, " hello ")],
      10,
      "en",
      "full body",
      "openai",
      "whisper-1",
    );
    const out = transcriptionToEvaluationInput("job-a", stt);
    expect(out.jobId).toBe("job-a");
    expect(out.segments).toEqual([{ startMs: 1234, endMs: 2500, text: " hello " }]);
    expect(out.fullTranscriptText).toBe("full body");
  });

  it("joins segment text when fullText is null", () => {
    const stt = new SpeechTranscription(
      [new SpeechSegment(0, 1, "a"), new SpeechSegment(1, 2, "b")],
      5,
      null,
      null,
      "x",
      null,
    );
    const out = transcriptionToEvaluationInput("j", stt);
    expect(out.fullTranscriptText).toBe("a b");
  });

  it("clamps negative seconds to 0 ms", () => {
    const stt = new SpeechTranscription(
      [new SpeechSegment(-0.001, 0.5, "x")],
      1,
      null,
      null,
      "p",
      null,
    );
    expect(transcriptionToEvaluationInput("j", stt).segments[0]).toEqual({
      startMs: 0,
      endMs: 500,
      text: "x",
    });
  });
});
