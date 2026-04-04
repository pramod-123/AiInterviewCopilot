import type { DiarizedSegment } from "../../types/diarization.js";

export type RawDiarizationFile = {
  provider?: string;
  model?: string;
  language?: string | null;
  segments?: Array<{
    start?: number;
    end?: number;
    speaker?: string;
    text?: string;
  }>;
};

/**
 * Parses `diarization.json` written by `scripts/diarize_dialogue_whisperx.py`.
 */
export function parseDiarizationJson(raw: string): {
  model: string;
  language: string | null;
  segments: DiarizedSegment[];
} | null {
  let data: RawDiarizationFile;
  try {
    data = JSON.parse(raw) as RawDiarizationFile;
  } catch {
    return null;
  }
  const okProvider =
    data.provider === "whisperx" || data.provider === "openai_semantic";
  if (!okProvider || !Array.isArray(data.segments)) {
    return null;
  }
  const model = typeof data.model === "string" ? data.model : "unknown";
  const language = typeof data.language === "string" ? data.language : null;
  const segments: DiarizedSegment[] = [];
  for (const s of data.segments) {
    const startSec = typeof s.start === "number" ? s.start : 0;
    const endSec = typeof s.end === "number" ? s.end : startSec;
    const text = typeof s.text === "string" ? s.text.trim() : "";
    const speaker = typeof s.speaker === "string" && s.speaker.trim() ? s.speaker.trim() : "UNKNOWN";
    if (!text) {
      continue;
    }
    const startMs = Math.max(0, Math.round(startSec * 1000));
    let endMs = Math.max(0, Math.round(endSec * 1000));
    if (endMs <= startMs) {
      endMs = startMs + 1;
    }
    segments.push({ startMs, endMs, speaker, text });
  }
  return { model, language, segments };
}
