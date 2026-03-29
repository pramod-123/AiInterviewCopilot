import { describe, expect, it } from "vitest";
import {
  fillRoiSystemPrompt,
  parseEditorRoiResponse,
} from "../../src/video-pipeline/editorRoiDetection.js";

describe("fillRoiSystemPrompt", () => {
  it("substitutes width and height", () => {
    const t = "W={{IMAGE_WIDTH}} H={{IMAGE_HEIGHT}}";
    expect(fillRoiSystemPrompt(t, 1920, 1080)).toBe("W=1920 H=1080");
  });
});

describe("parseEditorRoiResponse", () => {
  it("parses pixel crop and problem_statement", () => {
    const raw = JSON.stringify({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
      problem_statement: " Two sum ",
    });
    const out = parseEditorRoiResponse(raw, 2560, 1440);
    expect(out.crop).toEqual({ x: 10, y: 20, width: 100, height: 200 });
    expect(out.problemStatement).toBe("Two sum");
  });

  it("scales normalized 0–1 box to pixels", () => {
    const raw = JSON.stringify({ x: 0.1, y: 0.2, width: 0.3, height: 0.25 });
    const out = parseEditorRoiResponse(raw, 1000, 800);
    expect(out.crop).toEqual({ x: 100, y: 160, width: 300, height: 200 });
  });

  it("unwraps nested crop object", () => {
    const raw = JSON.stringify({
      crop: { x: 5, y: 6, width: 7, height: 8 },
    });
    const out = parseEditorRoiResponse(raw, 500, 500);
    expect(out.crop).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it("reads x_min/x_max style boxes", () => {
    const raw = JSON.stringify({ x_min: 0, y_min: 0, x_max: 50, y_max: 40 });
    const out = parseEditorRoiResponse(raw, 200, 200);
    expect(out.crop).toEqual({ x: 0, y: 0, width: 50, height: 40 });
  });

  it("strips markdown fences and tolerates outer prose", () => {
    const raw = 'Here:\n```json\n{"x":1,"y":2,"width":3,"height":4}\n```';
    const out = parseEditorRoiResponse(raw, 100, 100);
    expect(out.crop).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("returns null crop on invalid JSON", () => {
    expect(parseEditorRoiResponse("{", 10, 10).crop).toBeNull();
  });
});
