/** One quoted evidence row tied to a moment in the recording (ms from recording start). */
export type DimensionEvidenceQuote = {
  quote: string;
  timestampMs: number;
  source?: "speech" | "code";
};

/** One bullet of assessment under a dimension, optionally backed by timestamped quotes. */
export type DimensionRationalePoint = {
  text: string;
  evidence?: DimensionEvidenceQuote[];
};

/**
 * One rubric dimension.
 * Prefer {@link DimensionRationalePoint} via `rationalePoints` (see `interview-evaluation-system.md`).
 * `rationale` is kept as a flattened summary for backward compatibility and simple UIs.
 */
export type EvaluationDimension = {
  score: number;
  rationale: string;
  /** Legacy flat strings from older model outputs. */
  evidence?: string[];
  /** Structured rationale bullets with timestamped evidence. */
  rationalePoints?: DimensionRationalePoint[];
};

/** Model output: `speech_code_conflicts` entries (snake_case in JSON). */
export type SpeechCodeConflict = {
  timeRange: string;
  issue: string;
  speechEvidence: string;
  codeEvidence: string;
  whyItMatters: string;
  coachingAdvice: string;
};

/** Model output: `moment_by_moment_feedback` entries. */
export type MomentByMomentFeedbackItem = {
  timeRange: string;
  observation: string;
  evidence: string[];
  impact: string;
  suggestion: string;
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
  dimensions?: Record<string, EvaluationDimension>;
  strengths?: string[];
  weaknesses?: string[];
  /** From `prep_suggestions` in model JSON. */
  prepSuggestions?: string[];
  /** From `missed_opportunities`. */
  missedOpportunities?: string[];
  speechCodeConflicts?: SpeechCodeConflict[];
  momentByMomentFeedback?: MomentByMomentFeedbackItem[];
  errorMessage?: string;
  /** Token usage for the evaluation LLM call. */
  tokenUsage?: EvaluationTokenUsage;
};

/** Input built from timed transcript segments (audio STT) and optional editor OCR (video jobs). */
export type InterviewEvaluationInput = {
  jobId: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  /** Plain concatenation for models that prefer one block. */
  fullTranscriptText: string;
  /**
   * Pretty-printed JSON array: `{ start, end, speech, frameData }[]` (ms timeline + progressive OCR per interval).
   * Set by {@link SpeechTranscriptionEvaluationOrchestrator.transcribeAndEvaluate} before evaluation.
   */
  interviewTimelineJson?: string;
  /**
   * When set (e.g. video pipeline), problem/prompt text read from the first frame by the vision model.
   * Plain text; may be long. Audio-only jobs omit this.
   */
  problemStatementText?: string;
};
