import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppTransactionRunner } from "../db.js";
import type { IAppDao } from "../dao/IAppDao.js";
import type { IAppFileStore } from "../dao/file-store/IAppFileStore.js";
import type { JsonValue, SpeechUtteranceInsert } from "../dao/dto.js";
import type { FastifyBaseLogger } from "fastify";
import { writeMergedLiveSessionWebm } from "../live-session/mergeLiveSessionRecording.js";
import {
  speechTranscriptionFromGeminiUtterances,
  tryLoadGeminiRealtimeForLiveSession,
  type GeminiDerivedUtterance,
} from "../live-session/geminiRealtimeTranscript.js";
import {
  mixDialogueAudioAndMuxWebm,
  stitchGeminiInterviewerTimelineWav,
} from "../live-session/stitchGeminiInterviewerTimeline.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { writeE2eSpeechAnalysisArtifacts } from "./e2e/E2eSpeechAnalysisArtifacts.js";
import type { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";
import { codeSnapshotsFromTimelineSec } from "./codeSnapshotsFromTimelineSec.js";
import { FfmpegRunner, ffprobeFormatDurationSec } from "../video-pipeline/ffmpegExtract.js";
import type { SrtGenerationResult } from "../types/srtGeneration.js";
import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import { SpeechSegment, SpeechTranscription } from "../types/speechTranscription.js";
import { isWhisperXDiarizationEnabled } from "./diarization/runWhisperXDiarization.js";
import { speakerLabelForInterval } from "./diarization/speakerLabelForInterval.js";
import type { ISrtGenerator } from "./srt-generator/ISrtGenerator.js";
import { speechTranscriptionFromWhisperXSrt } from "./srt-generator/speechTranscriptionFromWhisperXSrt.js";
import { notifyPostProcessEvent } from "../live-session/postProcessEventsHub.js";

export type LiveSessionPostProcessRunOptions = {
  /** CLI / HTTP retry: allow run while session is still ACTIVE */
  allowWhileActive?: boolean;
};

/**
 * After a live session ends: merge WebM chunks, extract WAV, run STT + rubric using **code snapshots**
 * as the evaluation timeline (no frame OCR). Writes `transcript.srt` and related artifacts under
 * `data/live-sessions/<id>/post-process/`, and persists a linked {@link Job} with
 * {@link SpeechUtterance} (STT) and {@link CodeSnapshot} (`EDITOR_SNAPSHOT`) rows.
 *
 * To clear post-process state and re-run from scratch, use {@link LiveSessionPostProcessReset}.
 */
export class LiveSessionPostProcessor {
  constructor(
    private readonly db: IAppDao,
    private readonly runInTransaction: AppTransactionRunner,
    private readonly paths: AppPaths,
    private readonly files: IAppFileStore,
    private readonly speechAnalysis: SpeechTranscriptionEvaluationOrchestrator,
    private readonly log: FastifyBaseLogger,
    private readonly srtGenerator: ISrtGenerator,
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

  private async failJob(sessionId: string, jobId: string, errorMessage: string): Promise<void> {
    await this.db.updateJob(jobId, { status: "FAILED", errorMessage });
    notifyPostProcessEvent(sessionId, {
      type: "post_process",
      phase: "failed",
      jobId,
      errorMessage,
    });
  }

  private toSttRow(
    jobId: string,
    seg: SpeechSegment,
    sequence: number,
    speakerLabel: string | null,
  ): SpeechUtteranceInsert {
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
      speakerLabel,
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
    dialogueMerge?: {
      geminiInterviewer16kWav: string;
      dialogueMixed16kWav: string;
      dialogueWebm: string;
      anchorDeltaMs: number;
      chunkCount: number;
    },
    diarization?: SrtGenerationResult,
    transcriptSource: "gemini_live_realtime" | "local_stt" = "local_stt",
  ): JsonValue {
    const baseFiles = {
      audioWav: path.join(artifactDir, "audio.wav"),
      transcriptSrt: path.join(artifactDir, "transcript.srt"),
      speechTranscriptionJson: path.join(artifactDir, "speech-transcription.json"),
      interviewFeedback: path.join(artifactDir, "interview-feedback.json"),
    };
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
        transcriptSource,
        mergedVideoPath,
        codeSnapshotCount,
        artifactDir,
        files: {
          ...baseFiles,
          ...(dialogueMerge
            ? {
                geminiInterviewer16kWav: dialogueMerge.geminiInterviewer16kWav,
                dialogueMixed16kWav: dialogueMerge.dialogueMixed16kWav,
                dialogueWebm: dialogueMerge.dialogueWebm,
              }
            : {}),
        },
        geminiDialogue: dialogueMerge
          ? {
              anchorDeltaMs: dialogueMerge.anchorDeltaMs,
              geminiChunkCount: dialogueMerge.chunkCount,
              whisperxHint:
                transcriptSource === "gemini_live_realtime"
                  ? "Transcript and speaker labels from Gemini Live input/output transcription; local STT and SRT/diarization were skipped."
                  : diarization?.provider === "whisperx"
                    ? "Transcript and speaker labels from WhisperX (same run as pipeline.diarization); Gemini Live realtime transcript skipped when SRT/diarization provider is whisperx."
                    : diarization
                      ? `Speaker diarization is in pipeline.diarization (${diarization.provider}).`
                      : "Set DIARIZATION_PROVIDER=whisperx (HF token) or openai_semantic (local whisper + OpenAI); STT uses tab/mic audio.wav unless WhisperX is the SRT provider.",
            }
          : undefined,
        diarization: diarization
          ? {
              provider: diarization.provider,
              model: diarization.model,
              language: diarization.language,
              audioSource: diarization.audioSource,
              segmentCount: diarization.segmentCount,
              srt: diarization.srt,
              segments: diarization.segments,
            }
          : undefined,
      },
    } as JsonValue;
  }

  async run(sessionId: string, options?: LiveSessionPostProcessRunOptions): Promise<void> {
    const existingJobId = await this.db.findFirstJobIdByLiveSessionId(sessionId);
    if (existingJobId) {
      this.log.info({ sessionId, jobId: existingJobId }, "Live session post-process skipped (job already exists).");
      return;
    }

    const session = await this.db.getLiveSessionContent(sessionId);

    const statusOk = session?.status === "ENDED" || options?.allowWhileActive === true;
    if (!session || !statusOk) {
      return;
    }

    const merged = await writeMergedLiveSessionWebm(this.db, this.files, this.paths, sessionId);
    const jobId = randomUUID();

    if (!merged) {
      await this.db.createJobFailedLiveSession({
        id: jobId,
        liveSessionId: sessionId,
        errorMessage: "No video chunks to merge; cannot extract audio or run STT.",
      });
      notifyPostProcessEvent(sessionId, {
        type: "post_process",
        phase: "failed",
        jobId,
        errorMessage: "No video chunks to merge; cannot extract audio or run STT.",
      });
      return;
    }

    await this.db.createJobProcessingLiveSessionWithVideo({
      id: jobId,
      liveSessionId: sessionId,
      videoFilePath: merged.path,
      videoSizeBytes: merged.sizeBytes,
    });
    notifyPostProcessEvent(sessionId, { type: "post_process", phase: "processing", jobId });

    const artifactDir = path.join(this.paths.liveSessionDir(sessionId), "post-process");
    await this.files.mkdir(artifactDir, { recursive: true });
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
      await this.failJob(sessionId, jobId, `Audio extract failed: ${message}`);
      return;
    }

    let dialogueMerge:
      | {
          geminiInterviewer16kWav: string;
          dialogueMixed16kWav: string;
          dialogueWebm: string;
          anchorDeltaMs: number;
          chunkCount: number;
        }
      | undefined;
    try {
      const chunkLog = path.join(this.paths.liveSessionDir(sessionId), "gemini-audio", "chunks.jsonl");
      if (await this.files.pathExists(chunkLog)) {
        const workDir = path.join(artifactDir, "gemini-stitch-work");
        const gemini16k = path.join(artifactDir, "gemini-interviewer-16k.wav");
        const stitched = await stitchGeminiInterviewerTimelineWav({
          paths: this.paths,
          sessionId,
          db: this.db,
          workDir,
          outWav16k: gemini16k,
        });
        if (stitched) {
          const dialogueWav = path.join(artifactDir, "dialogue-mixed-16k.wav");
          const dialogueWebm = path.join(artifactDir, "dialogue.webm");
          await mixDialogueAudioAndMuxWebm({
            ffmpeg,
            recordingWebm: merged.path,
            recordingAudio16kWav: audioWav,
            geminiTimeline16kWav: gemini16k,
            outDialogueWav: dialogueWav,
            outDialogueWebm: dialogueWebm,
          });
          await this.files.copyFile(dialogueWebm, merged.path);
          dialogueMerge = {
            geminiInterviewer16kWav: gemini16k,
            dialogueMixed16kWav: dialogueWav,
            dialogueWebm,
            anchorDeltaMs: stitched.anchorDeltaMs,
            chunkCount: stitched.chunkCount,
          };
          this.log.info(
            { sessionId, jobId, geminiChunks: stitched.chunkCount },
            "Gemini interviewer audio stitched, mixed into dialogue.webm, and copied to recording.webm for playback.",
          );
        }
      }
    } catch (err) {
      this.log.warn({ err, sessionId }, "Gemini dialogue stitch/mix skipped (no captures or ffmpeg error).");
    }

    const wavForDiarize = dialogueMerge?.dialogueMixed16kWav ?? audioWav;
    const audioSourceForDiarize: SrtGenerationResult["audioSource"] = dialogueMerge?.dialogueMixed16kWav
      ? "dialogue_mixed"
      : "tab_mic_only";

    const timesSec = session.codeSnapshots.map((s) => s.offsetSeconds);
    const codeTexts = session.codeSnapshots.map((s) => s.code);
    const problemForEval = session.question?.trim() || undefined;

    const evalOpts = {
      evaluationFrameTimesSec: timesSec,
      evaluationCodeSnapshot: codeTexts,
      problemStatementText: problemForEval,
      carryForwardEditorSnapshots: true as const,
    };

    const forceLocalStt = process.env.LIVE_SESSION_FORCE_WHISPER_STT === "1";
    const liveInterviewerEnabled = session.liveInterviewerEnabled;
    const useWhisperXPrimary = this.srtGenerator.providerId === "whisperx";
    const allowGeminiRealtimeTranscript =
      liveInterviewerEnabled && !forceLocalStt && !useWhisperXPrimary;
    const geminiBundle = allowGeminiRealtimeTranscript
      ? await tryLoadGeminiRealtimeForLiveSession(this.paths, this.db, sessionId)
      : null;

    let transcription: SpeechTranscription;
    let evaluation: InterviewEvaluationPayload;
    let transcriptSource: "gemini_live_realtime" | "local_stt" = "local_stt";
    let geminiUtterancesForRows: GeminiDerivedUtterance[] | null = null;
    let diarization: SrtGenerationResult | undefined;

    try {
      if (geminiBundle && geminiBundle.utterances.length > 0) {
        transcriptSource = "gemini_live_realtime";
        geminiUtterancesForRows = geminiBundle.utterances;
        transcription = speechTranscriptionFromGeminiUtterances(geminiBundle.utterances);
        const ev = await this.speechAnalysis.evaluateTranscription(transcription, jobId, evalOpts);
        evaluation = ev.evaluation;
        this.log.info(
          { sessionId, jobId, segments: transcription.segments.length },
          "Live session transcript from Gemini Live realtime (input/output transcription).",
        );
      } else if (useWhisperXPrimary) {
        const d = await this.srtGenerator.generate({
          audioFilePath: wavForDiarize,
          audioSource: audioSourceForDiarize,
        });
        if (d && d.segments.length > 0) {
          diarization = d;
          transcription = speechTranscriptionFromWhisperXSrt(d);
          const ev = await this.speechAnalysis.evaluateTranscription(transcription, jobId, evalOpts);
          evaluation = ev.evaluation;
          this.log.info(
            {
              sessionId,
              jobId,
              segments: transcription.segments.length,
              audioSource: d.audioSource,
            },
            "Live session transcript from WhisperX (single ASR + diarization pass).",
          );
        } else {
          this.log.warn(
            { sessionId, jobId },
            "WhisperX produced no segments; falling back to STT_PROVIDER on tab/mic audio.wav.",
          );
          const out = await this.speechAnalysis.transcribeAndEvaluate(audioWav, jobId, evalOpts);
          transcription = out.transcription;
          evaluation = out.evaluation;
        }
      } else {
        const rawTx = await this.speechAnalysis.transcribeFromFile(audioWav);
        try {
          const d = await this.srtGenerator.generate({
            audioFilePath: wavForDiarize,
            audioSource: audioSourceForDiarize,
          });
          if (d) {
            diarization = d;
          }
        } catch (err) {
          this.log.warn({ err, sessionId }, "SRT generation before evaluation failed.");
        }
        const labeledSegments = rawTx.segments.map((seg) => {
          const startMs = Math.max(0, Math.round(seg.startSec * 1000));
          let endMs = Math.max(0, Math.round(seg.endSec * 1000));
          if (endMs <= startMs) {
            endMs = startMs + 1;
          }
          const label = speakerLabelForInterval(startMs, endMs, diarization);
          return new SpeechSegment(seg.startSec, seg.endSec, seg.text, label);
        });
        transcription = new SpeechTranscription(
          labeledSegments,
          rawTx.durationSec,
          rawTx.language,
          rawTx.fullText,
          rawTx.providerId,
          rawTx.modelId,
        );
        const ev = await this.speechAnalysis.evaluateTranscription(transcription, jobId, evalOpts);
        evaluation = ev.evaluation;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failJob(sessionId, jobId, `Speech pipeline failed: ${message}`);
      return;
    }

    try {
      await writeE2eSpeechAnalysisArtifacts(this.files, artifactDir, jobId, transcription, evaluation);

      if (transcriptSource === "local_stt" && !diarization) {
        try {
          const d = await this.srtGenerator.generate({
            audioFilePath: wavForDiarize,
            audioSource: audioSourceForDiarize,
          });
          if (d) {
            diarization = d;
            this.log.info(
              { sessionId, jobId, segments: d.segmentCount, audioSource: d.audioSource, provider: d.provider },
              "SRT generation with speaker labels completed.",
            );
          }
        } catch (err) {
          this.log.warn({ err, sessionId }, "SRT generation failed.");
        }
        if (!diarization && isWhisperXDiarizationEnabled(process.env)) {
          this.log.warn(
            { sessionId, jobId },
            "WhisperX diarization produced no result; utterances will have null speakerLabel. Set HF_TOKEN (Hugging Face), install whisperx+torch+ffmpeg, or use DIARIZATION_PROVIDER=openai.",
          );
        }
      }

      if (diarization?.srt?.trim()) {
        await this.files.writeFile(path.join(artifactDir, "transcript.srt"), diarization.srt.trim() + "\n", "utf-8");
      }

      const durationSec = transcription.durationSec ?? (await ffprobeFormatDurationSec(audioWav));
      const sttRows = geminiUtterancesForRows
        ? geminiUtterancesForRows.map((u, i) => this.toSttRow(jobId, u.segment, i, u.speakerLabel))
        : transcription.providerId === "whisperx" &&
            diarization &&
            diarization.segments.length === transcription.segments.length
          ? transcription.segments.map((seg, i) =>
              this.toSttRow(jobId, seg, i, diarization!.segments[i]!.speakerLabel),
            )
          : transcription.segments.map((seg, i) => {
              const startMs = Math.max(0, Math.round(seg.startSec * 1000));
              let endMs = Math.max(0, Math.round(seg.endSec * 1000));
              if (endMs <= startMs) {
                endMs = startMs + 1;
              }
              const label =
                seg.speakerLabel !== undefined && seg.speakerLabel !== null
                  ? seg.speakerLabel
                  : speakerLabelForInterval(startMs, endMs, diarization);
              return this.toSttRow(jobId, seg, i, label);
            });
      const editorSnapshotRows = codeSnapshotsFromTimelineSec(timesSec, codeTexts).map((r) => ({
        jobId,
        source: "EDITOR_SNAPSHOT" as const,
        offsetMs: r.offsetMs,
        text: r.text,
        sequence: r.sequence,
      }));

      const audioStat = await this.files.statOrNull(audioWav);
      const audioSize = audioStat ? Number(audioStat.size) : 0;

      let mergedRecordingSizeBytes = merged.sizeBytes;
      if (dialogueMerge) {
        const mergedStat = await this.files.statOrNull(merged.path);
        if (mergedStat) {
          mergedRecordingSizeBytes = Number(mergedStat.size);
        }
      }

      const payload = this.buildResultPayload(
        sessionId,
        transcription,
        sttRows.length,
        evaluation,
        artifactDir,
        merged.path,
        session.codeSnapshots.length,
        dialogueMerge,
        diarization,
        transcriptSource,
      );

      await this.runInTransaction(async (tx) => {
        await tx.deleteSpeechUtterancesByJobId(jobId);
        if (sttRows.length > 0) {
          await tx.createSpeechUtterances(sttRows);
        }
        await tx.deleteJobCodeSnapshotsBySource(jobId, "EDITOR_SNAPSHOT");
        if (editorSnapshotRows.length > 0) {
          await tx.createJobCodeSnapshots(editorSnapshotRows);
        }

        await tx.upsertInterviewAudio({
          jobId,
          filePath: audioWav,
          originalFilename: "audio.wav",
          mimeType: "audio/wav",
          sizeBytes: audioSize,
          durationSeconds: durationSec > 0 ? durationSec : null,
        });

        if (dialogueMerge) {
          await tx.updateInterviewVideoSizeBytes(jobId, mergedRecordingSizeBytes);
        }

        await tx.upsertResultPayload(jobId, payload);

        await tx.updateJob(jobId, { status: "COMPLETED", errorMessage: null });

        await tx.updateLiveSessionStatus(sessionId, "ENDED");
      });

      notifyPostProcessEvent(sessionId, { type: "post_process", phase: "complete", jobId });

      this.log.info(
        { sessionId, jobId, segments: sttRows.length, codeSnapshots: codeTexts.length },
        "Live session post-process completed.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, sessionId, jobId }, "Live session post-process failed after STT (persist step)");
      await this.failJob(sessionId, jobId, `Post-process persist failed: ${message}`);
    }
  }
}
