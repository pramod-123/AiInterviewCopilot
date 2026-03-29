import { describe, expect, it } from "vitest";
import { parseInterviewEvaluationJson } from "../../../src/services/evaluation/interviewEvaluationJson.js";

describe("parseInterviewEvaluationJson", () => {
  it("parses fenced JSON and dimensions", () => {
    const raw = `\`\`\`json
{"summary":"ok","dimensions":{"a":{"score":4,"rationale":"r"}},"strengths":["s"],"weaknesses":[],"prep_suggestions":["p"]}
\`\`\``;
    const out = parseInterviewEvaluationJson(raw, "openai", "gpt-4o-mini");
    expect(out.status).toBe("complete");
    expect(out.provider).toBe("openai");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.summary).toBe("ok");
    expect(out.dimensions?.a).toEqual({ score: 4, rationale: "r" });
    expect(out.strengths).toEqual(["s"]);
    expect(out.prepSuggestions).toEqual(["p"]);
  });

  it("accepts prepSuggestions camelCase", () => {
    const out = parseInterviewEvaluationJson(
      JSON.stringify({ prepSuggestions: ["x"] }),
      "p",
      null,
    );
    expect(out.prepSuggestions).toEqual(["x"]);
  });

  it("coerces string scores to numbers when finite", () => {
    const out = parseInterviewEvaluationJson(
      JSON.stringify({
        dimensions: { x: { score: "3", rationale: "z" } },
      }),
      "p",
      null,
    );
    expect(out.dimensions?.x).toEqual({ score: 3, rationale: "z" });
  });

  it("returns failed on invalid JSON", () => {
    const out = parseInterviewEvaluationJson("not json", "anthropic", "claude");
    expect(out.status).toBe("failed");
    expect(out.errorMessage).toMatch(/non-JSON/i);
  });

  it("returns failed when root is not an object", () => {
    const out = parseInterviewEvaluationJson("[1]", "p", null);
    expect(out.status).toBe("failed");
  });
});
