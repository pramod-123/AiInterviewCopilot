import type { IAppDao } from "../dao/IAppDao.js";
import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import type { SpeechTranscription } from "../types/speechTranscription.js";
import type { InterviewEvaluator } from "./evaluation/InterviewEvaluationService.js";
import { persistJobEvaluationArtifacts } from "./evaluation/persistJobEvaluationArtifacts.js";
import type { ISpeechToTextService } from "./speech-to-text/ISpeechToTextService.js";

export type TranscribeAndEvaluateOptions = {
  problemStatementText?: string;
  /** Frame timestamps (seconds) on the cropped video timeline; paired with `evaluationCodeSnapshot`. */
  evaluationFrameTimesSec?: number[];
  /** Per-timestamp editor text from live session code snapshots (legacy: was also used with frame OCR), aligned with `evaluationFrameTimesSec`. */
  evaluationCodeSnapshot?: string[];
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
    private readonly db: IAppDao,
  ) {}

  /**
   * STT only (no rubric). Use when labels must be attached before {@link evaluateTranscription}.
   */
  async transcribeFromFile(audioFilePath: string): Promise<SpeechTranscription> {
    return this.speechToText.transcribeFromFile(audioFilePath);
  }

  /**
   * Rubric evaluation + timeline JSON from an existing transcription (no STT).
   */
  async evaluateTranscription(
    transcription: SpeechTranscription,
    jobId: string,
    options?: TranscribeAndEvaluateOptions,
  ): Promise<{ evaluation: InterviewEvaluationPayload }> {
    const evaluation = await this.evaluateTranscriptionCore(transcription, jobId, options);
    return { evaluation };
  }

  private async evaluateTranscriptionCore(
    transcription: SpeechTranscription,
    jobId: string,
    options?: TranscribeAndEvaluateOptions,
  ): Promise<InterviewEvaluationPayload> {
    await persistJobEvaluationArtifacts(this.db, jobId, transcription, {
      evaluationFrameTimesSec: options?.evaluationFrameTimesSec,
      evaluationCodeSnapshot: options?.evaluationCodeSnapshot,
      carryForwardEditorSnapshots: options?.carryForwardEditorSnapshots,
      problemStatementText: options?.problemStatementText,
    });
    return this.evaluatePersistedJob(jobId);
  }

  /**
   * Rubric evaluation only — assumes {@link SpeechUtterance} (and job code snapshots) are already persisted.
   * Used by live session post-process so tool-calling agents read final rows from the DB.
   */
  async evaluatePersistedJob(jobId: string): Promise<InterviewEvaluationPayload> {
    try {
      return await this.evaluation.evaluate({ jobId });
    } catch (evalErr) {
      const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
      return {
        status: "failed",
        provider: this.evaluation.provider,
        errorMessage: `Evaluation request failed: ${msg}`,
      };
    }
  }

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
    const evaluation = await this.evaluateTranscriptionCore(transcription, jobId, options);
    return { transcription, evaluation };
  }
}
