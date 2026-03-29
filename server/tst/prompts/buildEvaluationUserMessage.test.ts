import { describe, expect, it } from "vitest";
import {
  buildEvaluationUserMessage,
  truncateProblemStatementForEvaluation,
} from "../../src/prompts/buildEvaluationUserMessage.js";
import type { InterviewEvaluationInput } from "../../src/types/interviewEvaluation.js";

describe("buildEvaluationUserMessage", () => {
  it("replaces job, problem, and timeline placeholders", () => {
    const template = `id: {{JOB_ID}}\np: {{PROBLEM_STATEMENT}}\nj: {{INTERVIEW_TIMELINE_JSON}}`;
    const input: InterviewEvaluationInput = {
      jobId: "abc-123",
      segments: [],
      fullTranscriptText: "",
      problemStatementText: "Do the thing.",
      interviewTimelineJson: '[{"start":0,"end":1,"speech":"hi","frameData":[]}]',
    };
    const out = buildEvaluationUserMessage(template, input);
    expect(out).toContain("id: abc-123");
    expect(out).toContain("p: Do the thing.");
    expect(out).toContain('j: [{"start":0,"end":1,"speech":"hi","frameData":[]}]');
  });

  it("uses defaults when problem and timeline omitted", () => {
    const input: InterviewEvaluationInput = {
      jobId: "j1",
      segments: [{ startMs: 0, endMs: 1, text: "x" }],
      fullTranscriptText: "x",
    };
    const out = buildEvaluationUserMessage(
      "{{JOB_ID}}\n{{PROBLEM_STATEMENT}}\n{{INTERVIEW_TIMELINE_JSON}}",
      input,
    );
    expect(out).toContain("j1");
    expect(out).toContain("Not provided — no interview problem text");
    expect(out).toContain("[]");
  });
});

describe("truncateProblemStatementForEvaluation", () => {
  const prev = process.env.INTERVIEW_EVAL_PROBLEM_MAX_CHARS;

  it("returns empty for whitespace-only input", () => {
    expect(truncateProblemStatementForEvaluation("  \n  ")).toBe("");
  });

  it("truncates when env cap is below input length (min cap 2000 in implementation)", () => {
    process.env.INTERVIEW_EVAL_PROBLEM_MAX_CHARS = "2000";
    const long = "b".repeat(3500);
    const got = truncateProblemStatementForEvaluation(long);
    expect(got.length).toBeLessThan(long.length);
    expect(got).toContain("problem statement truncated");
    if (prev === undefined) {
      delete process.env.INTERVIEW_EVAL_PROBLEM_MAX_CHARS;
    } else {
      process.env.INTERVIEW_EVAL_PROBLEM_MAX_CHARS = prev;
    }
  });
});
