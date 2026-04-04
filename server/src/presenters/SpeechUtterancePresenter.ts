import type { SpeechUtteranceItem } from "../dao/dto.js";

export type SpeechUtteranceDto = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  sequence: number;
  /** Diarized or inferred speaker when available (e.g. INTERVIEWER, INTERVIEWEE, SPEAKER_00). */
  speaker: string | null;
};

/**
 * Maps persisted STT rows to API responses.
 */
export class SpeechUtterancePresenter {
  static readonly defaultOrderBy = [
    { sequence: "asc" as const },
    { startMs: "asc" as const },
  ];

  static toDtoList(rows: SpeechUtteranceItem[]): SpeechUtteranceDto[] {
    return rows.map((s) => ({
      id: s.id,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      sequence: s.sequence,
      speaker: s.speakerLabel ?? null,
    }));
  }
}
