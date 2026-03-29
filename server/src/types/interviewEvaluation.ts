/** One rubric dimension with score and short rationale (1–5 scale in prompts). */
export type EvaluationDimension = {
  score: number;
  rationale: string;
};

/**
 * Serializable evaluation block stored under `Result.payload.evaluation`.
 */
export type InterviewEvaluationPayload = {
  status: "complete" | "skipped" | "failed";
  provider?: string;
  model?: string | null;
  summary?: string;
  dimensions?: Record<string, EvaluationDimension>;
  strengths?: string[];
  weaknesses?: string[];
  prepSuggestions?: string[];
  errorMessage?: string;
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
