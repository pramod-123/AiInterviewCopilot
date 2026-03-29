import type { InterviewEvaluationInput } from "../../types/interviewEvaluation.js";
import type { SpeechTranscription } from "../../types/speechTranscription.js";

/**
 * Maps Whisper-style {@link SpeechTranscription} into rubric evaluation input.
 * The STT/evaluation orchestrator adds `interviewTimelineJson` before calling the evaluator.
 */
export function transcriptionToEvaluationInput(
  jobId: string,
  transcription: SpeechTranscription,
): InterviewEvaluationInput {
  const segments = transcription.segments.map((s) => ({
    startMs: Math.max(0, Math.round(s.startSec * 1000)),
    endMs: Math.max(0, Math.round(s.endSec * 1000)),
    text: s.text,
  }));
  const fullTranscriptText =
    transcription.fullText?.trim() ||
    transcription.segments.map((s) => s.text).join(" ").trim();
  return { jobId, segments, fullTranscriptText };
}
