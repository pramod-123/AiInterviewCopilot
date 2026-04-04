import type { AppTransactionRunner } from "../db.js";
import type { IAppDao } from "../dao/IAppDao.js";
import type { SpeechUtteranceInsert } from "../dao/dto.js";
import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import { SpeechSegment, SpeechTranscription } from "../types/speechTranscription.js";
import type { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";

/**
 * Persists STT segments and rubric evaluation for a stored interview audio file.
 * Transcription + evaluation are delegated to {@link SpeechTranscriptionEvaluationOrchestrator}.
 *
 * On success, updates `Job`, `InterviewAudio.durationSeconds`, replaces {@link SpeechUtterance}
 * rows, and upserts `Result.payload` (`stt` + `evaluation`). Video jobs populate
 * {@link CodeSnapshot} (`VIDEO_OCR`) via {@link VideoJobProcessor}.
 */
export class AudioJobProcessor {
  constructor(
    private readonly db: IAppDao,
    private readonly runInTransaction: AppTransactionRunner,
    private readonly speechAnalysis: SpeechTranscriptionEvaluationOrchestrator | null,
  ) {}

  /**
   * Loads the job’s audio, runs STT when configured, writes {@link SpeechUtterance} rows
   * and a placeholder {@link Result}; updates {@link Job} status.
   */
  async process(jobId: string): Promise<void> {
    if (!this.speechAnalysis) {
      await this.failJob(
        jobId,
        "No speech-to-text provider is available. Set STT_PROVIDER=remote (default) or local with matching keys/CLI, or STT_PROVIDER=none.",
      );
      return;
    }

    const job = await this.db.findJobWithInterviewAudio(jobId);

    if (!job?.interviewAudio) {
      await this.failJob(jobId, "No interview audio found for this job.");
      return;
    }

    await this.db.updateJob(jobId, { status: "PROCESSING", errorMessage: null });

    const audioMeta = job.interviewAudio;

    try {
      const { transcription, evaluation } = await this.speechAnalysis.transcribeAndEvaluate(
        audioMeta.filePath,
        jobId,
      );
      await this.persistSuccessfulTranscription(
        jobId,
        audioMeta.durationSeconds,
        transcription,
        evaluation,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failJob(jobId, `Speech-to-text failed: ${message}`);
      throw err;
    }
  }

  private async failJob(jobId: string, errorMessage: string): Promise<void> {
    await this.db.updateJob(jobId, { status: "FAILED", errorMessage });
  }

  private async persistSuccessfulTranscription(
    jobId: string,
    previousDuration: number | null,
    transcription: SpeechTranscription,
    evaluation: InterviewEvaluationPayload,
  ): Promise<void> {
    const segments = transcription.segments;
    const durationSec = transcription.durationSec;
    const segmentRows = segments.map((seg, i) => this.toSegmentRow(jobId, seg, i));

    const payload = this.buildResultPayload(transcription, segments.length, evaluation);

    await this.runInTransaction(async (tx) => {
      await tx.deleteSpeechUtterancesByJobId(jobId);

      if (segmentRows.length > 0) {
        await tx.createSpeechUtterances(segmentRows);
      }

      await tx.updateInterviewAudioDuration(
        jobId,
        durationSec > 0 ? durationSec : previousDuration,
      );

      await tx.upsertResultPayload(jobId, payload);

      await tx.updateJob(jobId, { status: "COMPLETED", errorMessage: null });
    });
  }

  private toSegmentRow(jobId: string, seg: SpeechSegment, sequence: number): SpeechUtteranceInsert {
    const startMs = Math.max(0, Math.round(seg.startSec * 1000));
    let endMs = Math.max(0, Math.round(seg.endSec * 1000));
    if (endMs <= startMs) {
      endMs = startMs + 1;
    }
    return {
      jobId,
      startMs,
      endMs,
      text: seg.text,
      sequence,
    };
  }

  private buildResultPayload(
    transcription: SpeechTranscription,
    segmentCount: number,
    evaluation: InterviewEvaluationPayload,
  ) {
    return {
      stt: {
        provider: transcription.providerId,
        model: transcription.modelId,
        segmentCount,
        language: transcription.language,
      },
      evaluation,
    };
  }
}
