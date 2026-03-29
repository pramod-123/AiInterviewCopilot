import type { Prisma, PrismaClient } from "@prisma/client";
import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import { SpeechSegment, SpeechTranscription } from "../types/speechTranscription.js";
import type { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";

/**
 * Persists STT segments and rubric evaluation for a stored interview audio file.
 * Transcription + evaluation are delegated to {@link SpeechTranscriptionEvaluationOrchestrator}.
 *
 * On success, updates `Job`, `InterviewAudio.durationSeconds`, replaces `TranscriptSegment` rows
 * with `source=AUDIO_STT`, and upserts `Result.payload` (`stt` + `evaluation`). Video jobs populate
 * `VIDEO_OCR` via {@link VideoJobProcessor}.
 */
export class AudioJobProcessor {
  constructor(
    private readonly db: PrismaClient,
    private readonly speechAnalysis: SpeechTranscriptionEvaluationOrchestrator | null,
  ) {}

  /**
   * Loads the job’s audio, runs STT when configured, writes {@link TranscriptSegment} rows
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

    const job = await this.db.job.findUnique({
      where: { id: jobId },
      include: { interviewAudio: true },
    });

    if (!job?.interviewAudio) {
      await this.failJob(jobId, "No interview audio found for this job.");
      return;
    }

    await this.db.job.update({
      where: { id: jobId },
      data: { status: "PROCESSING", errorMessage: null },
    });

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
    await this.db.job.update({
      where: { id: jobId },
      data: { status: "FAILED", errorMessage },
    });
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

    await this.db.$transaction(async (tx) => {
      await tx.transcriptSegment.deleteMany({
        where: { jobId, source: "AUDIO_STT" },
      });

      if (segmentRows.length > 0) {
        await tx.transcriptSegment.createMany({ data: segmentRows });
      }

      await tx.interviewAudio.update({
        where: { jobId },
        data: {
          durationSeconds: durationSec > 0 ? durationSec : previousDuration,
        },
      });

      await tx.result.upsert({
        where: { jobId },
        create: { jobId, payload },
        update: { payload },
      });

      await tx.job.update({
        where: { id: jobId },
        data: { status: "COMPLETED", errorMessage: null },
      });
    });
  }

  private toSegmentRow(
    jobId: string,
    seg: SpeechSegment,
    sequence: number,
  ): Prisma.TranscriptSegmentCreateManyInput {
    const startMs = Math.max(0, Math.round(seg.startSec * 1000));
    let endMs = Math.max(0, Math.round(seg.endSec * 1000));
    if (endMs <= startMs) {
      endMs = startMs + 1;
    }
    return {
      jobId,
      source: "AUDIO_STT",
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
  ): Prisma.InputJsonValue {
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
