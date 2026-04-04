import type { SrtGenerationResult, SrtLabeledSegment } from "../../types/srtGeneration.js";
import { renderSrt } from "../srt-generator/srtFormatting.js";

export const INTERVIEW_SPEAKER_ROLES = ["INTERVIEWER", "INTERVIEWEE"] as const;
export type InterviewSpeakerRole = (typeof INTERVIEW_SPEAKER_ROLES)[number];

function isInterviewSpeakerRole(s: string): s is InterviewSpeakerRole {
  return (INTERVIEW_SPEAKER_ROLES as readonly string[]).includes(s);
}

/** Pull a single JSON object from model text (handles ```json fences). */
export function extractJsonObject(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/im.exec(t);
  if (fence?.[1]) {
    return fence[1].trim();
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

export function pickWhisperXSpeakerSamples(
  segments: SrtLabeledSegment[],
  maxPerSpeaker = 3,
  maxCharsPerSample = 400,
): Map<string, string[]> {
  const bySp = new Map<string, string[]>();
  for (const seg of segments) {
    const sp = seg.speakerLabel.trim() || "UNKNOWN";
    let arr = bySp.get(sp);
    if (!arr) {
      arr = [];
      bySp.set(sp, arr);
    }
    if (arr.length >= maxPerSpeaker) {
      continue;
    }
    const t = seg.text.trim().slice(0, maxCharsPerSample);
    if (t) {
      arr.push(t);
    }
  }
  return bySp;
}

export function parseSpeakerRoleMappingJson(
  text: string,
  expectedSpeakers: string[],
): Record<string, InterviewSpeakerRole> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(text));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const mappingRaw = rec.mapping;
  if (mappingRaw === null || typeof mappingRaw !== "object" || Array.isArray(mappingRaw)) {
    return null;
  }
  const out: Record<string, InterviewSpeakerRole> = {};
  for (const sp of expectedSpeakers) {
    const v = (mappingRaw as Record<string, unknown>)[sp];
    if (typeof v !== "string" || !isInterviewSpeakerRole(v)) {
      return null;
    }
    out[sp] = v;
  }
  return out;
}

export function applySpeakerRoleMappingToSrtResult(
  result: SrtGenerationResult,
  mapping: Record<string, InterviewSpeakerRole>,
): SrtGenerationResult {
  const segments = result.segments.map((s) => {
    const key = s.speakerLabel.trim();
    const role = mapping[key];
    const speakerLabel = role ?? s.speakerLabel;
    return { ...s, speakerLabel };
  });
  return {
    ...result,
    segmentCount: segments.length,
    srt: renderSrt(segments),
    segments,
  };
}
