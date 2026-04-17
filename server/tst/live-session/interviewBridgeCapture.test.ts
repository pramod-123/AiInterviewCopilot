import { describe, expect, it } from "vitest";
import {
  mergeVoiceRealtimeAudioChunkFileRowsByFile,
  parsePcmSampleRateFromMime,
  pcmS16leMonoDurationMs,
} from "../../src/live-session/interviewBridgeCapture.js";

describe("interviewBridgeCapture helpers", () => {
  it("parses sample rate from mime", () => {
    expect(parsePcmSampleRateFromMime("audio/pcm;rate=24000")).toBe(24000);
    expect(parsePcmSampleRateFromMime("audio/L16; rate=16000")).toBe(16000);
    expect(parsePcmSampleRateFromMime("audio/pcm")).toBe(24000);
  });

  it("computes mono s16le duration", () => {
    expect(pcmS16leMonoDurationMs(48000, 24000)).toBe(1000);
    expect(pcmS16leMonoDurationMs(0, 24000)).toBe(0);
  });

  it("merges duplicate jsonl rows for the same pcm file", () => {
    const merged = mergeVoiceRealtimeAudioChunkFileRowsByFile([
      { file: "a.pcm", sampleRate: 24000, bytes: 46080, receivedAtWallMs: 2, offsetFromBridgeOpenMs: 100 },
      { file: "a.pcm", sampleRate: 24000, bytes: 1920, receivedAtWallMs: 1, offsetFromBridgeOpenMs: 50 },
      { file: "b.pcm", sampleRate: 24000, bytes: 100, receivedAtWallMs: 3, offsetFromBridgeOpenMs: 200 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ file: "a.pcm", offsetFromBridgeOpenMs: 50, bytes: 46080, receivedAtWallMs: 1 });
    expect(merged[1]).toMatchObject({ file: "b.pcm" });
  });

  it("merges same-file rows taking min offset and max bytes", () => {
    const merged = mergeVoiceRealtimeAudioChunkFileRowsByFile([
      { file: "a.pcm", sampleRate: 24000, bytes: 100, receivedAtWallMs: 1, offsetFromBridgeOpenMs: 10 },
      { file: "a.pcm", sampleRate: 24000, bytes: 200, receivedAtWallMs: 2, offsetFromBridgeOpenMs: 5 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.bytes).toBe(200);
    expect(merged[0]?.offsetFromBridgeOpenMs).toBe(5);
  });
});
