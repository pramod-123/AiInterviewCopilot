import type { InterviewEvaluationInput } from "../types/interviewEvaluation.js";

const PLACEHOLDER_JOB = "{{JOB_ID}}";
const PLACEHOLDER_PROBLEM = "{{PROBLEM_STATEMENT}}";
const PLACEHOLDER_TIMELINE = "{{INTERVIEW_TIMELINE_JSON}}";

/** Vision-extracted problem text for the rubric prompt; cap size for context limits. */
export function truncateProblemStatementForEvaluation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const maxRaw = process.env.INTERVIEW_EVAL_PROBLEM_MAX_CHARS?.trim();
  let maxChars = maxRaw ? Number(maxRaw) : 24_000;
  if (!Number.isFinite(maxChars) || maxChars < 2000) {
    maxChars = 24_000;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const omitted = trimmed.length - maxChars;
  return `${trimmed.slice(0, maxChars)}\n\n... [problem statement truncated; ${omitted} characters omitted]`;
}

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
