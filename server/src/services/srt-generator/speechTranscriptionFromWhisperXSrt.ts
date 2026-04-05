import type { SrtGenerationResult } from "../../types/srtGeneration.js";
import { SpeechSegment, SpeechTranscription } from "../../types/speechTranscription.js";

/** Builds evaluation STT payload from a WhisperX {@link SrtGenerationResult} (single pipeline run). */
export function speechTranscriptionFromWhisperXSrt(result: SrtGenerationResult): SpeechTranscription {
  const segments = result.segments.map(
    (s) => new SpeechSegment(s.startMs / 1000, s.endMs / 1000, s.text.trim(), s.speakerLabel),
  );
  const durationSec = segments.length > 0 ? Math.max(...segments.map((seg) => seg.endSec)) : 0;
  const fullText =
    segments
      .map((s) => s.text)
      .filter(Boolean)
      .join(" ")
      .trim() || null;
  return new SpeechTranscription(
    segments,
    durationSec,
    result.language,
    fullText,
    "whisperx",
    result.model,
  );
}
