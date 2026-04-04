import { describe, expect, it } from "vitest";
import {
  applySpeakerRoleMappingToSrtResult,
  extractJsonObject,
  parseSpeakerRoleMappingJson,
  pickWhisperXSpeakerSamples,
} from "../../../src/services/diarization/whisperXSpeakerRoleMapper.js";
import type { SrtGenerationResult } from "../../../src/types/srtGeneration.js";

describe("extractJsonObject", () => {
  it("strips markdown fence", () => {
    const t = '```json\n{"mapping":{"SPEAKER_00":"INTERVIEWER"}}\n```';
    expect(extractJsonObject(t)).toBe('{"mapping":{"SPEAKER_00":"INTERVIEWER"}}');
  });

  it("uses first brace object", () => {
    const t = 'prefix {"mapping":{}} trailing';
    expect(extractJsonObject(t)).toBe('{"mapping":{}}');
  });
});

describe("parseSpeakerRoleMappingJson", () => {
  it("parses valid mapping for all expected speakers", () => {
    const text = JSON.stringify({
      mapping: { SPEAKER_00: "INTERVIEWER", SPEAKER_01: "INTERVIEWEE" },
      rationale: "ok",
    });
    const m = parseSpeakerRoleMappingJson(text, ["SPEAKER_00", "SPEAKER_01"]);
    expect(m).toEqual({
      SPEAKER_00: "INTERVIEWER",
      SPEAKER_01: "INTERVIEWEE",
    });
  });

  it("returns null if a speaker is missing", () => {
    const text = JSON.stringify({ mapping: { SPEAKER_00: "INTERVIEWER" } });
    expect(parseSpeakerRoleMappingJson(text, ["SPEAKER_00", "SPEAKER_01"])).toBeNull();
  });

  it("returns null for invalid role", () => {
    const text = JSON.stringify({
      mapping: { SPEAKER_00: "HOST", SPEAKER_01: "INTERVIEWEE" },
    });
    expect(parseSpeakerRoleMappingJson(text, ["SPEAKER_00", "SPEAKER_01"])).toBeNull();
  });
});

describe("pickWhisperXSpeakerSamples", () => {
  it("groups up to maxPerSpeaker per id", () => {
    const segs = [
      { startMs: 0, endMs: 1, text: "a", speakerLabel: "SPEAKER_00" },
      { startMs: 1, endMs: 2, text: "b", speakerLabel: "SPEAKER_00" },
      { startMs: 2, endMs: 3, text: "c", speakerLabel: "SPEAKER_00" },
      { startMs: 3, endMs: 4, text: "d", speakerLabel: "SPEAKER_00" },
    ];
    const m = pickWhisperXSpeakerSamples(segs, 2);
    expect(m.get("SPEAKER_00")).toEqual(["a", "b"]);
  });
});

describe("applySpeakerRoleMappingToSrtResult", () => {
  it("remaps labels and SRT", () => {
    const result: SrtGenerationResult = {
      provider: "whisperx",
      model: "base",
      language: "en",
      audioSource: "tab_mic_only",
      segmentCount: 2,
      srt: "",
      segments: [
        { startMs: 0, endMs: 1000, text: "Hi", speakerLabel: "SPEAKER_00" },
        { startMs: 1000, endMs: 2000, text: "Hello", speakerLabel: "SPEAKER_01" },
      ],
    };
    const out = applySpeakerRoleMappingToSrtResult(result, {
      SPEAKER_00: "INTERVIEWER",
      SPEAKER_01: "INTERVIEWEE",
    });
    expect(out.segments[0]!.speakerLabel).toBe("INTERVIEWER");
    expect(out.segments[1]!.speakerLabel).toBe("INTERVIEWEE");
    expect(out.srt).toContain("[INTERVIEWER]");
    expect(out.srt).toContain("[INTERVIEWEE]");
  });
});
