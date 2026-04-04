import type { SrtGenerationResult } from "../../types/srtGeneration.js";

/**
 * Picks the diarization segment speaker with the largest time overlap with [startMs, endMs].
 * Assumes STT and diarization share the same recording timeline (live session merged audio / dialogue mix).
 */
export function speakerLabelForInterval(
  startMs: number,
  endMs: number,
  diarization: SrtGenerationResult | undefined,
): string | null {
  if (!diarization?.segments.length) {
    return null;
  }
  let bestLabel: string | null = null;
  let bestOverlap = 0;
  for (const d of diarization.segments) {
    const overlap = Math.max(0, Math.min(endMs, d.endMs) - Math.max(startMs, d.startMs));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestLabel = d.speakerLabel;
    }
  }
  return bestOverlap > 0 ? bestLabel : null;
}
