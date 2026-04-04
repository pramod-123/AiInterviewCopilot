import type { SpeechUtteranceItem } from "../../src/dao/dto.js";
import { describe, expect, it } from "vitest";
import { SpeechUtterancePresenter } from "../../src/presenters/SpeechUtterancePresenter.js";

function mockItem(partial: Partial<SpeechUtteranceItem> & Pick<SpeechUtteranceItem, "id">): SpeechUtteranceItem {
  return {
    jobId: "job-1",
    startMs: 0,
    endMs: 1,
    text: "",
    sequence: 0,
    speakerLabel: null,
    ...partial,
  };
}

describe("SpeechUtterancePresenter", () => {
  it("maps rows to DTOs", () => {
    const rows = [
      mockItem({
        id: "a",
        startMs: 100,
        endMs: 200,
        text: "hello",
        sequence: 1,
        speakerLabel: "INTERVIEWER",
      }),
    ];
    const dto = SpeechUtterancePresenter.toDtoList(rows);
    expect(dto).toEqual([
      {
        id: "a",
        startMs: 100,
        endMs: 200,
        text: "hello",
        sequence: 1,
        speaker: "INTERVIEWER",
      },
    ]);
  });

  it("maps null DB speakerLabel to DTO speaker null", () => {
    const dto = SpeechUtterancePresenter.toDtoList([
      mockItem({
        id: "a",
        speakerLabel: null,
      }),
    ]);
    expect(dto[0]!.speaker).toBeNull();
  });

  it("defaultOrderBy is stable", () => {
    expect(SpeechUtterancePresenter.defaultOrderBy).toEqual([
      { sequence: "asc" },
      { startMs: "asc" },
    ]);
  });
});
