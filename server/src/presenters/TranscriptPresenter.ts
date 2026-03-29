import type { TranscriptSegment } from "@prisma/client";

/** API DTO for a single transcript line. */
export type TranscriptSegmentDto = {
  id: string;
  source: TranscriptSegment["source"];
  startMs: number;
  endMs: number;
  text: string;
  sequence: number;
};

/**
 * Maps persisted {@link TranscriptSegment} rows to API responses.
 */
export class TranscriptPresenter {
  static readonly defaultOrderBy = [
    { source: "asc" as const },
    { sequence: "asc" as const },
    { startMs: "asc" as const },
  ];

  static toDtoList(segments: TranscriptSegment[]): TranscriptSegmentDto[] {
    return segments.map((s) => ({
      id: s.id,
      source: s.source,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      sequence: s.sequence,
    }));
  }
}
