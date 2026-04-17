import { describe, expect, it } from "vitest";
import { formatCandidateEditorSnapshotForGeminiLive } from "../../src/live-session/realtime/geminiLiveEditorFormat.js";

describe("formatCandidateEditorSnapshotForGeminiLive", () => {
  it("wraps non-empty code with framing line", () => {
    const out = formatCandidateEditorSnapshotForGeminiLive("const x = 1;\n");
    expect(out).toContain("[Candidate editor");
    expect(out).toContain("const x = 1;");
  });

  it("uses placeholder for empty or whitespace-only buffer", () => {
    expect(formatCandidateEditorSnapshotForGeminiLive("")).toContain("(empty editor buffer)");
    expect(formatCandidateEditorSnapshotForGeminiLive("   ")).toContain("(empty editor buffer)");
  });

  it("does not truncate long buffers in this formatter", () => {
    const long = "a".repeat(20_000);
    const out = formatCandidateEditorSnapshotForGeminiLive(long);
    expect(out.length).toBeGreaterThan(19_000);
  });
});
