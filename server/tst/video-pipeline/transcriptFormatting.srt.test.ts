import { describe, expect, it } from "vitest";
import { SpeechSegment, SpeechTranscription } from "../../src/types/speechTranscription.js";
import type { ExtractedFrame } from "../../src/video-pipeline/ffmpegExtract.js";
import { extractedFramesToManifest } from "../../src/video-pipeline/ffmpegExtract.js";
import { speechSegmentToSrtBlock, transcriptionToSrt } from "../../src/video-pipeline/transcriptFormatting.js";

describe("speechSegmentToSrtBlock", () => {
  it("formats index, timestamps, and text", () => {
    const seg = new SpeechSegment(0, 1.5, "  hi  ");
    const block = speechSegmentToSrtBlock(1, seg);
    expect(block).toBe("1\n00:00:00,000 --> 00:00:01,500\nhi\n");
  });
});

describe("transcriptionToSrt", () => {
  it("joins blocks for all segments", () => {
    const t = new SpeechTranscription(
      [new SpeechSegment(0, 1, "a"), new SpeechSegment(1, 2, "b")],
      5,
      null,
      null,
      "p",
      null,
    );
    const srt = transcriptionToSrt(t);
    expect(srt).toContain("1\n");
    expect(srt).toContain("2\n");
    expect(srt).toContain("a");
    expect(srt).toContain("b");
  });

  it("returns empty string for no segments", () => {
    const t = new SpeechTranscription([], 0, null, null, "p", null);
    expect(transcriptionToSrt(t)).toBe("");
  });
});

describe("extractedFramesToManifest", () => {
  it("maps basename and sourceFrameIndex", () => {
    const frames: ExtractedFrame[] = [
      { index: 1, file: "/tmp/out/frame_000001.png", timestampSeconds: 0.5 },
      { index: 2, file: "/tmp/out/frame_000002.png", timestampSeconds: 1.0 },
    ];
    expect(extractedFramesToManifest(frames)).toEqual([
      { file: "frame_000001.png", timestampSec: 0.5, sourceFrameIndex: 0 },
      { file: "frame_000002.png", timestampSec: 1.0, sourceFrameIndex: 1 },
    ]);
  });
});
