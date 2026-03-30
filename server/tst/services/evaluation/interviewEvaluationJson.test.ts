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

  it("parses dimension evidence and new top-level arrays (snake_case)", () => {
    const raw = {
      summary: "s",
      dimensions: {
        problem_understanding: {
          score: 4,
          rationale: "r",
          evidence: ["Speech: hi", "Code: `x`"],
        },
      },
      strengths: ["a"],
      weaknesses: ["b"],
      prep_suggestions: ["p"],
      missed_opportunities: ["m"],
      speech_code_conflicts: [
        {
          time_range: "0-1000 ms",
          issue: "i",
          speech_evidence: "Speech: x",
          code_evidence: "Code: y",
          why_it_matters: "w",
          coaching_advice: "c",
        },
      ],
      moment_by_moment_feedback: [
        {
          time_range: "0-500 ms",
          observation: "o",
          evidence: ["Speech: a"],
          impact: "imp",
          suggestion: "sug",
        },
      ],
    };
    const out = parseInterviewEvaluationJson(JSON.stringify(raw), "openai", "gpt-4o");
    expect(out.status).toBe("complete");
    expect(out.dimensions?.problem_understanding).toEqual({
      score: 4,
      rationale: "r",
      evidence: ["Speech: hi", "Code: `x`"],
    });
    expect(out.missedOpportunities).toEqual(["m"]);
    expect(out.speechCodeConflicts).toHaveLength(1);
    expect(out.speechCodeConflicts?.[0]).toMatchObject({
      timeRange: "0-1000 ms",
      issue: "i",
      speechEvidence: "Speech: x",
      codeEvidence: "Code: y",
      whyItMatters: "w",
      coachingAdvice: "c",
    });
    expect(out.momentByMomentFeedback?.[0]).toMatchObject({
      timeRange: "0-500 ms",
      observation: "o",
      evidence: ["Speech: a"],
      impact: "imp",
      suggestion: "sug",
    });
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

  it("parses rationale_points with timestamped evidence (snake_case)", () => {
    const raw = {
      dimensions: {
        approach_quality: {
          score: 3,
          rationale_points: [
            {
              text: "Plan matched heap idea.",
              evidence: [
                { quote: "use a max heap", timestamp_ms: 5000, source: "speech" },
                { quote: "`PriorityQueue<Integer> q`", timestamp_ms: 90000, source: "code" },
              ],
            },
          ],
        },
      },
    };
    const out = parseInterviewEvaluationJson(JSON.stringify(raw), "openai", "gpt-4o");
    expect(out.dimensions?.approach_quality).toEqual({
      score: 3,
      rationale: "Plan matched heap idea.",
      rationalePoints: [
        {
          text: "Plan matched heap idea.",
          evidence: [
            { quote: "use a max heap", timestampMs: 5000, source: "speech" },
            { quote: "`PriorityQueue<Integer> q`", timestampMs: 90000, source: "code" },
          ],
        },
      ],
    });
  });
});
