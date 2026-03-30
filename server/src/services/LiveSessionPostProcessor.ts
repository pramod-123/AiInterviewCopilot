import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { writeMergedLiveSessionWebm } from "../live-session/mergeLiveSessionRecording.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { writeE2eSpeechAnalysisArtifacts } from "./e2e/E2eSpeechAnalysisArtifacts.js";
import type { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";
import { FfmpegRunner, ffprobeFormatDurationSec } from "../video-pipeline/ffmpegExtract.js";
import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import { SpeechSegment, type SpeechTranscription } from "../types/speechTranscription.js";

export type LiveSessionPostProcessRunOptions = {
  /** CLI / HTTP retry: allow run while session is still ACTIVE */
  allowWhileActive?: boolean;
};

/**
 * After a live session ends: merge WebM chunks, extract WAV, run STT + rubric using **code snapshots**
 * as the evaluation timeline (no frame OCR). Writes `transcript.srt` and related artifacts under
 * `data/live-sessions/<id>/post-process/`, and persists a linked {@link Job} with `AUDIO_STT` segments.
 */
export class LiveSessionPostProcessor {
  constructor(
    private readonly db: PrismaClient,
    private readonly paths: AppPaths,
    private readonly speechAnalysis: SpeechTranscriptionEvaluationOrchestrator,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Fire-and-forget background run. Idempotent: skips if a job already exists for this session.
   * Normal end flow: status must be ENDED (see {@link run}).
   */
  scheduleAfterEnd(sessionId: string): void {
    void this.run(sessionId).catch((err: unknown) => {
      this.log.error({ err, sessionId }, "Live session post-process failed");
    });
  }

  private async failJob(jobId: string, errorMessage: string): Promise<void> {
    await this.db.job.update({
      where: { id: jobId },
      data: { status: "FAILED", errorMessage },
    });
  }

  private toSttRow(
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
    sessionId: string,
    transcription: SpeechTranscription,
    segmentCount: number,
    evaluation: InterviewEvaluationPayload,
    artifactDir: string,
    mergedVideoPath: string,
    codeSnapshotCount: number,
  ): Prisma.InputJsonValue {
    return {
      stt: {
        provider: transcription.providerId,
        model: transcription.modelId,
        segmentCount,
        language: transcription.language,
      },
      evaluation,
      pipeline: {
        kind: "live_session",
        liveSessionId: sessionId,
        mergedVideoPath,
        codeSnapshotCount,
        artifactDir,
        files: {
          audioWav: path.join(artifactDir, "audio.wav"),
          transcriptSrt: path.join(artifactDir, "transcript.srt"),
          speechTranscriptionJson: path.join(artifactDir, "speech-transcription.json"),
          interviewFeedback: path.join(artifactDir, "interview-feedback.json"),
        },
      },
    };
  }

  async run(sessionId: string, options?: LiveSessionPostProcessRunOptions): Promise<void> {
    const existing = await this.db.job.findFirst({ where: { liveSessionId: sessionId } });
    if (existing) {
      this.log.info({ sessionId, jobId: existing.id }, "Live session post-process skipped (job already exists).");
      return;
    }

    const session = await this.db.interviewLiveSession.findUnique({
      where: { id: sessionId },
      include: {
        codeSnapshots: { orderBy: { sequence: "asc" } },
      },
    });

    const statusOk = session?.status === "ENDED" || options?.allowWhileActive === true;
    if (!session || !statusOk) {
      return;
    }

    const merged = await writeMergedLiveSessionWebm(this.db, this.paths, sessionId);
    const jobId = randomUUID();

    if (!merged) {
      await this.db.job.create({
        data: {
          id: jobId,
          status: "FAILED",
          errorMessage: "No video chunks to merge; cannot extract audio or run STT.",
          liveSessionId: sessionId,
        },
      });
      return;
    }

    await this.db.job.create({
      data: {
        id: jobId,
        status: "PROCESSING",
        errorMessage: null,
        liveSessionId: sessionId,
        interviewVideo: {
          create: {
            filePath: merged.path,
            originalFilename: "recording.webm",
            mimeType: "video/webm",
            sizeBytes: merged.sizeBytes,
          },
        },
      },
    });

    const artifactDir = path.join(this.paths.liveSessionDir(sessionId), "post-process");
    await fs.mkdir(artifactDir, { recursive: true });
    const audioWav = path.join(artifactDir, "audio.wav");

    const ffmpeg = new FfmpegRunner();

    try {
      await ffmpeg.exec([
        "-i",
        merged.path,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        audioWav,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failJob(jobId, `Audio extract failed: ${message}`);
      return;
    }

    const timesSec = session.codeSnapshots.map((s) => s.offsetSeconds);
    const codeTexts = session.codeSnapshots.map((s) => s.code);
    const problemForEval = session.question?.trim() || undefined;

    let transcription: SpeechTranscription;
    let evaluation: InterviewEvaluationPayload;
    try {
      const out = await this.speechAnalysis.transcribeAndEvaluate(audioWav, jobId, {
        evaluationFrameTimesSec: timesSec,
        evaluationFrameOcrTexts: codeTexts,
        problemStatementText: problemForEval,
        carryForwardEditorSnapshots: true,
      });
      transcription = out.transcription;
      evaluation = out.evaluation;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failJob(jobId, `Speech pipeline failed: ${message}`);
      return;
    }

    await writeE2eSpeechAnalysisArtifacts(artifactDir, jobId, transcription, evaluation);

    const durationSec = transcription.durationSec ?? (await ffprobeFormatDurationSec(audioWav));
    const sttRows = transcription.segments.map((seg, i) => this.toSttRow(jobId, seg, i));

    const audioStat = await fs.stat(audioWav).catch(() => null);
    const audioSize = audioStat ? Number(audioStat.size) : 0;

    const payload = this.buildResultPayload(
      sessionId,
      transcription,
      sttRows.length,
      evaluation,
      artifactDir,
      merged.path,
      session.codeSnapshots.length,
    );

    await this.db.$transaction(async (tx) => {
      await tx.transcriptSegment.deleteMany({ where: { jobId, source: "AUDIO_STT" } });
      if (sttRows.length > 0) {
        await tx.transcriptSegment.createMany({ data: sttRows });
      }

      await tx.interviewAudio.upsert({
        where: { jobId },
        create: {
          jobId,
          filePath: audioWav,
          originalFilename: "audio.wav",
          mimeType: "audio/wav",
          sizeBytes: audioSize,
          durationSeconds: durationSec > 0 ? durationSec : null,
        },
        update: {
          filePath: audioWav,
          originalFilename: "audio.wav",
          mimeType: "audio/wav",
          sizeBytes: audioSize,
          durationSeconds: durationSec > 0 ? durationSec : null,
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

    this.log.info(
      { sessionId, jobId, segments: sttRows.length, codeSnapshots: codeTexts.length },
      "Live session post-process completed.",
    );
  }
}
