import { describe, expect, it } from "vitest";
import { extractJsonObjectFromAgentOutput } from "../../src/services/evaluation/SingleAgentInterviewEvaluator.js";

describe("extractJsonObjectFromAgentOutput", () => {
  it("strips json code fence", () => {
    const out = extractJsonObjectFromAgentOutput('```json\n{"a":1}\n```');
    expect(out).toBe('{"a":1}');
  });

  it("extracts object from surrounding text", () => {
    const out = extractJsonObjectFromAgentOutput('here: {"status":"complete"} done');
    expect(out).toBe('{"status":"complete"}');
  });
});
