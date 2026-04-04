import type { CodeSnapshotItem } from "../../src/dao/dto.js";
import { describe, expect, it } from "vitest";
import { CodeSnapshotPresenter } from "../../src/presenters/CodeSnapshotPresenter.js";

function mockItem(partial: Partial<CodeSnapshotItem> & Pick<CodeSnapshotItem, "id">): CodeSnapshotItem {
  return {
    jobId: "job-1",
    source: "VIDEO_OCR",
    offsetMs: 0,
    text: "",
    sequence: 0,
    ...partial,
  };
}

describe("CodeSnapshotPresenter", () => {
  it("maps rows to DTOs", () => {
    const rows = [
      mockItem({
        id: "b",
        source: "EDITOR_SNAPSHOT",
        offsetMs: 5000,
        text: "int x = 1;",
        sequence: 0,
      }),
    ];
    const dto = CodeSnapshotPresenter.toDtoList(rows);
    expect(dto).toEqual([
      {
        id: "b",
        source: "EDITOR_SNAPSHOT",
        offsetMs: 5000,
        text: "int x = 1;",
        sequence: 0,
      },
    ]);
  });

  it("defaultOrderBy is stable", () => {
    expect(CodeSnapshotPresenter.defaultOrderBy).toEqual([
      { sequence: "asc" },
      { offsetMs: "asc" },
    ]);
  });
});
