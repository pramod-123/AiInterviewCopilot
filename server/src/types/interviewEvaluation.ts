/** Evidence row tied to a moment in the recording (ms from recording start). */
export type EvaluationEvidenceQuote = {
  quote: string;
  timestampMs: number;
  source?: "speech" | "code" | "question";
};

/** One scored claim under a rubric dimension. */
export type DimensionRationalePoint = {
  claim: string;
  evidence?: EvaluationEvidenceQuote[];
};

export type EvidenceSufficiency = "limited" | "moderate" | "strong";

/** One rubric dimension (see `interview-evaluation-system.md`). */
export type EvaluationDimension = {
  score: number;
  evidenceSufficiency: EvidenceSufficiency;
  rationalePoints: DimensionRationalePoint[];
};

export type RoundOutcomePrediction = "strong_pass" | "pass" | "borderline" | "weak_no_pass";

export type SpeechCodeConflict = {
  timeRange: string;
  issue: string;
  speechEvidence: EvaluationEvidenceQuote[];
  codeEvidence: EvaluationEvidenceQuote[];
  whyItMatters: string;
  coachingAdvice: string;
};

/** `chronological_turning_points` entry (replaces legacy moment-by-moment feedback). */
export type ChronologicalTurningPoint = {
  timeRange: string;
  phase: string;
  observation: string;
  evidence: EvaluationEvidenceQuote[];
  impact: string;
};

export type PrepSuggestionItem = {
  weakness: string;
  prescription: string;
  goal: string;
};

export type WhatToSayDifferentlyItem = {
  situation: string;
  betterPhrasing: string;
  whyItHelps: string;
};

export type DecisionTraceStep = {
  step: string;
  whatWasChecked: string;
  evidenceUsed: EvaluationEvidenceQuote[];
  conclusion: string;
};

/** Token usage from an LLM evaluation call. */
export type EvaluationTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
};

/**
 * Serializable evaluation block stored under `Result.payload.evaluation`.
 * Shape follows `prompts/interview-evaluation-system.md` (snake_case from the model → camelCase here).
 */
export type InterviewEvaluationPayload = {
  status: "complete" | "skipped" | "failed";
  provider?: string;
  model?: string | null;
  summary?: string;
  finalOutcome?: string;
  interviewProcessQuality?: string;
  hireSignalSummary?: string;
  roundOutcomePrediction?: RoundOutcomePrediction;
  dimensions?: Record<string, EvaluationDimension>;
  strengths?: string[];
  weaknesses?: string[];
  missedOpportunities?: string[];
  missedInterviewerFriendlyBehaviors?: string[];
  whatToSayDifferently?: WhatToSayDifferentlyItem[];
  prepSuggestions?: PrepSuggestionItem[];
  speechCodeConflicts?: SpeechCodeConflict[];
  chronologicalTurningPoints?: ChronologicalTurningPoint[];
  alternativeStrongerPath?: string[];
  decisionTrace?: DecisionTraceStep[];
  errorMessage?: string;
  tokenUsage?: EvaluationTokenUsage;
};

/** Rubric evaluation call: job id only; evaluators load utterances, code snapshots, and session data from the DB. */
export type InterviewEvaluationRequest = {
  jobId: string;
};

/** Input built from timed transcript segments (audio STT) and optional editor OCR (video jobs). */
export type InterviewEvaluationInput = {
  jobId: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  /** Plain concatenation for models that prefer one block. */
  fullTranscriptText: string;
  /**
   * Pretty-printed JSON array: `{ start, end, speech, frameData }[]` (ms timeline + progressive OCR per interval).
   * Filled when assembling evaluation input from persisted job rows (orchestrator persists, then evaluator loads).
   */
  interviewTimelineJson?: string;
  /**
   * When set (e.g. video pipeline), problem/prompt text read from the first frame by the vision model.
   * Plain text; may be long. Audio-only jobs omit this.
   */
  problemStatementText?: string;
};
