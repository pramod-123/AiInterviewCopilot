import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import type { SpeechTranscription } from "../types/speechTranscription.js";
import type { InterviewEvaluator } from "./evaluation/InterviewEvaluationService.js";
import { transcriptionToEvaluationInput } from "./evaluation/transcriptionToEvaluationInput.js";
import type { ISpeechToTextService } from "./speech-to-text/ISpeechToTextService.js";
import {
  applyCarryForwardEditorSnapshots,
  buildFinalTranscriptJson,
  finalTranscriptToEvaluationTimeline,
  stringifyInterviewTimelineForEvaluation,
} from "../video-pipeline/transcriptFormatting.js";

export type TranscribeAndEvaluateOptions = {
  problemStatementText?: string;
  /** Frame timestamps (seconds) on the cropped video timeline; paired with `evaluationFrameOcrTexts`. */
  evaluationFrameTimesSec?: number[];
  evaluationFrameOcrTexts?: string[];
  /**
   * Live sessions: sparse code snapshots — fill speech slices that missed a snapshot with the previous code.
   * @see applyCarryForwardEditorSnapshots
   */
  carryForwardEditorSnapshots?: boolean;
};

/**
 * Runs speech-to-text then interview rubric evaluation — shared by HTTP jobs and offline e2e flows.
 */
export class SpeechTranscriptionEvaluationOrchestrator {
  constructor(
    private readonly speechToText: ISpeechToTextService,
    private readonly evaluation: InterviewEvaluator,
  ) {}

  /**
   * Transcribes `audioFilePath`, then runs {@link InterviewEvaluator.evaluate}.
   * Evaluation errors are captured as `status: "failed"` (same contract as `AudioJobProcessor`).
   */
  async transcribeAndEvaluate(
    audioFilePath: string,
    jobId: string,
    options?: TranscribeAndEvaluateOptions,
  ): Promise<{ transcription: SpeechTranscription; evaluation: InterviewEvaluationPayload }> {
    const transcription = await this.speechToText.transcribeFromFile(audioFilePath);
    const evalInput = transcriptionToEvaluationInput(jobId, transcription);
    const times = options?.evaluationFrameTimesSec ?? [];
    const ocrs = options?.evaluationFrameOcrTexts ?? [];
    let finalTranscript = buildFinalTranscriptJson(transcription, times, ocrs);
    if (options?.carryForwardEditorSnapshots) {
      finalTranscript = applyCarryForwardEditorSnapshots(finalTranscript);
    }
    const timelineSegs = finalTranscriptToEvaluationTimeline(finalTranscript);
    evalInput.interviewTimelineJson = stringifyInterviewTimelineForEvaluation(timelineSegs);
    const problem = options?.problemStatementText?.trim();
    if (problem) {
      evalInput.problemStatementText = problem;
    }
    let evaluation: InterviewEvaluationPayload;
    try {
      evaluation = await this.evaluation.evaluate(evalInput);
    } catch (evalErr) {
      const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
      evaluation = {
        status: "failed",
        provider: this.evaluation.provider,
        errorMessage: `Evaluation request failed: ${msg}`,
      };
    }
    return { transcription, evaluation };
  }
}
