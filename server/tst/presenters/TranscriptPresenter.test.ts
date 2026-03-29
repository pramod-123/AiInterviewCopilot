import type { TranscriptSegment } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { TranscriptPresenter } from "../../src/presenters/TranscriptPresenter.js";

function mockSegment(partial: Partial<TranscriptSegment> & Pick<TranscriptSegment, "id">): TranscriptSegment {
  return {
    jobId: "job-1",
    source: "AUDIO_STT",
    startMs: 0,
    endMs: 1,
    text: "",
    sequence: 0,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    ...partial,
  } as TranscriptSegment;
}

describe("TranscriptPresenter", () => {
  it("maps rows to DTOs", () => {
    const rows = [
      mockSegment({
        id: "a",
        source: "VIDEO_OCR",
        startMs: 100,
        endMs: 200,
        text: "code",
        sequence: 1,
      }),
    ];
    const dto = TranscriptPresenter.toDtoList(rows);
    expect(dto).toEqual([
      {
        id: "a",
        source: "VIDEO_OCR",
        startMs: 100,
        endMs: 200,
        text: "code",
        sequence: 1,
      },
    ]);
  });

  it("defaultOrderBy is stable", () => {
    expect(TranscriptPresenter.defaultOrderBy).toEqual([
      { source: "asc" },
      { sequence: "asc" },
      { startMs: "asc" },
    ]);
  });
});
