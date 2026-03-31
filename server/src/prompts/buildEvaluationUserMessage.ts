import type { InterviewEvaluationInput } from "../types/interviewEvaluation.js";

const PLACEHOLDER_JOB = "{{JOB_ID}}";
const PLACEHOLDER_PROBLEM = "{{PROBLEM_STATEMENT}}";
const PLACEHOLDER_TIMELINE = "{{INTERVIEW_TIMELINE_JSON}}";

/**
 * Fills `interview-evaluation-user.md` placeholders from transcript input.
 */
export function buildEvaluationUserMessage(
  template: string,
  input: InterviewEvaluationInput,
): string {
  const timeline = input.interviewTimelineJson?.trim() || "[]";
  const problem =
    input.problemStatementText?.trim() ||
    "(Not provided — no interview problem text was attached. Infer the task only from the timeline.)";

  return template
    .replaceAll(PLACEHOLDER_JOB, input.jobId)
    .replaceAll(PLACEHOLDER_PROBLEM, problem)
    .replaceAll(PLACEHOLDER_TIMELINE, timeline);
}
