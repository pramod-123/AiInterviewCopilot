import { describe, expect, it } from "vitest";
import { buildEvaluationUserMessage } from "../../src/prompts/buildEvaluationUserMessage.js";
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

