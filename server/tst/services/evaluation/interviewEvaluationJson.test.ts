import { describe, expect, it } from "vitest";
import { parseInterviewEvaluationJson } from "../../../src/services/evaluation/interviewEvaluationJson.js";

describe("parseInterviewEvaluationJson", () => {
  it("parses fenced JSON and dimensions (v4 shape)", () => {
    const raw = `\`\`\`json
{"summary":"ok","dimensions":{"a":{"score":4,"evidence_sufficiency":"strong","rationale_points":[{"claim":"did well"}]}},"strengths":["s"],"weaknesses":[],"prep_suggestions":[{"weakness":"w","prescription":"p","goal":"g"}]}
\`\`\``;
    const out = parseInterviewEvaluationJson(raw, "openai", "gpt-4o-mini");
    expect(out.status).toBe("complete");
    expect(out.provider).toBe("openai");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.summary).toBe("ok");
    expect(out.dimensions?.a).toEqual({
      score: 4,
      evidenceSufficiency: "strong",
      rationalePoints: [{ claim: "did well" }],
    });
    expect(out.strengths).toEqual(["s"]);
    expect(out.prepSuggestions).toEqual([{ weakness: "w", prescription: "p", goal: "g" }]);
  });

  it("accepts prepSuggestions camelCase objects", () => {
    const out = parseInterviewEvaluationJson(
      JSON.stringify({
        prepSuggestions: [{ weakness: "a", prescription: "b", goal: "c" }],
      }),
      "p",
      null,
    );
    expect(out.prepSuggestions).toEqual([{ weakness: "a", prescription: "b", goal: "c" }]);
  });

  it("coerces string scores to numbers when finite", () => {
    const out = parseInterviewEvaluationJson(
      JSON.stringify({
        dimensions: {
          x: { score: "3", evidence_sufficiency: "limited", rationale_points: [] },
        },
      }),
      "p",
      null,
    );
    expect(out.dimensions?.x).toEqual({
      score: 3,
      evidenceSufficiency: "limited",
      rationalePoints: [],
    });
  });

  it("parses top-level narrative fields and turning points (snake_case)", () => {
    const raw = {
      summary: "s",
      final_outcome: "Solved with bug",
      interview_process_quality: "Solid process",
      hire_signal_summary: "Lean hire",
      round_outcome_prediction: "pass",
      dimensions: {
        problem_understanding: {
          score: 4,
          evidence_sufficiency: "moderate",
          rationale_points: [{ claim: "r", evidence: [{ quote: "hi", timestamp_ms: 1000, source: "speech" }] }],
        },
      },
      strengths: ["a"],
      weaknesses: ["b"],
      prep_suggestions: [{ weakness: "w", prescription: "p", goal: "g" }],
      missed_opportunities: ["m"],
      missed_interviewer_friendly_behaviors: ["late start"],
      what_to_say_differently: [{ situation: "s", better_phrasing: "b", why_it_helps: "h" }],
      speech_code_conflicts: [
        {
          time_range: "10-20",
          issue: "i",
          speech_evidence: [{ quote: "x", timestamp_ms: 5000, source: "speech" }],
          code_evidence: [{ quote: "`y`", timestamp_ms: 9000, source: "code" }],
          why_it_matters: "w",
          coaching_advice: "c",
        },
      ],
      chronological_turning_points: [
        {
          time_range: "0-45",
          phase: "approach",
          observation: "o",
          evidence: [{ quote: "a", timestamp_ms: 12000, source: "question" }],
          impact: "imp",
        },
      ],
      alternative_stronger_path: ["use heap"],
      decision_trace: [
        {
          step: "check edges",
          what_was_checked: "empty input",
          evidence_used: [{ quote: "if not arr", timestamp_ms: 60000, source: "code" }],
          conclusion: "handled",
        },
      ],
    };
    const out = parseInterviewEvaluationJson(JSON.stringify(raw), "openai", "gpt-4o");
    expect(out.status).toBe("complete");
    expect(out.finalOutcome).toBe("Solved with bug");
    expect(out.interviewProcessQuality).toBe("Solid process");
    expect(out.hireSignalSummary).toBe("Lean hire");
    expect(out.roundOutcomePrediction).toBe("pass");
    expect(out.missedInterviewerFriendlyBehaviors).toEqual(["late start"]);
    expect(out.whatToSayDifferently?.[0]).toMatchObject({
      situation: "s",
      betterPhrasing: "b",
      whyItHelps: "h",
    });
    expect(out.missedOpportunities).toEqual(["m"]);
    expect(out.speechCodeConflicts).toHaveLength(1);
    expect(out.speechCodeConflicts?.[0]).toMatchObject({
      timeRange: "10-20",
      issue: "i",
      speechEvidence: [{ quote: "x", timestampMs: 5000, source: "speech" }],
      codeEvidence: [{ quote: "`y`", timestampMs: 9000, source: "code" }],
      whyItMatters: "w",
      coachingAdvice: "c",
    });
    expect(out.chronologicalTurningPoints?.[0]).toMatchObject({
      timeRange: "0-45",
      phase: "approach",
      observation: "o",
      evidence: [{ quote: "a", timestampMs: 12000, source: "question" }],
      impact: "imp",
    });
    expect(out.alternativeStrongerPath).toEqual(["use heap"]);
    expect(out.decisionTrace?.[0]).toMatchObject({
      step: "check edges",
      whatWasChecked: "empty input",
      evidenceUsed: [{ quote: "if not arr", timestampMs: 60000, source: "code" }],
      conclusion: "handled",
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

  it("parses rationale_points with claim and timestamped evidence (snake_case)", () => {
    const raw = {
      dimensions: {
        approach_quality: {
          score: 3,
          evidence_sufficiency: "limited",
          rationale_points: [
            {
              claim: "Plan matched heap idea.",
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
      evidenceSufficiency: "limited",
      rationalePoints: [
        {
          claim: "Plan matched heap idea.",
          evidence: [
            { quote: "use a max heap", timestampMs: 5000, source: "speech" },
            { quote: "`PriorityQueue<Integer> q`", timestampMs: 90000, source: "code" },
          ],
        },
      ],
    });
  });

  it("maps legacy rationale_points text to claim", () => {
    const out = parseInterviewEvaluationJson(
      JSON.stringify({
        dimensions: {
          x: {
            score: 2,
            evidence_sufficiency: "strong",
            rationale_points: [{ text: "Legacy point" }],
          },
        },
      }),
      "p",
      null,
    );
    expect(out.dimensions?.x?.rationalePoints?.[0]?.claim).toBe("Legacy point");
  });
});
