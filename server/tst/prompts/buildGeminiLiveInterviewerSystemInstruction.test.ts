import { describe, expect, it } from "vitest";
import { buildGeminiLiveInterviewerSystemInstruction } from "../../src/prompts/buildGeminiLiveInterviewerSystemInstruction.js";

describe("buildGeminiLiveInterviewerSystemInstruction", () => {
  it("puts interview question before base agent and trims problem text", () => {
    const out = buildGeminiLiveInterviewerSystemInstruction("  Two sum  ");
    expect(out).toContain("## Interview question (read first;");
    expect(out).toContain("same session");
    expect(out).toContain("professional technical interviewer");
    expect(out.indexOf("Two sum")).toBeLessThan(out.indexOf("professional technical interviewer"));
    expect(out).toContain("Two sum");
    expect(out).not.toContain("  Two sum  ");
  });

  it("uses fallback when problem missing or blank", () => {
    const fromNull = buildGeminiLiveInterviewerSystemInstruction(null);
    const fromBlank = buildGeminiLiveInterviewerSystemInstruction("   ");
    expect(fromNull).toContain("No problem statement was provided");
    expect(fromBlank).toContain("No problem statement was provided");
    expect(fromNull).toBe(fromBlank);
  });
});
