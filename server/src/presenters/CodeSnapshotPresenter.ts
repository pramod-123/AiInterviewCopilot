import type { CodeSnapshotItem, CodeSnapshotSource } from "../dao/dto.js";

export type CodeSnapshotDto = {
  id: string;
  source: CodeSnapshotSource;
  offsetMs: number;
  text: string;
  sequence: number;
};

/**
 * Maps persisted code snapshot rows (OCR / editor captures) to API responses.
 */
export class CodeSnapshotPresenter {
  static readonly defaultOrderBy = [
    { sequence: "asc" as const },
    { offsetMs: "asc" as const },
  ];

  static toDtoList(rows: CodeSnapshotItem[]): CodeSnapshotDto[] {
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      offsetMs: r.offsetMs,
      text: r.text,
      sequence: r.sequence,
    }));
  }
}
