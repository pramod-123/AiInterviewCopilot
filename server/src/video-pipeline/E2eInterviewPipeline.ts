import fs from "node:fs/promises";
import path from "node:path";
import { writeE2eSpeechAnalysisArtifacts } from "../services/e2e/E2eSpeechAnalysisArtifacts.js";
import type {
  SpeechTranscriptionEvaluationOrchestrator,
  TranscribeAndEvaluateOptions,
} from "../services/SpeechTranscriptionEvaluationOrchestrator.js";
import type { IDedupedFrameExtractor } from "../services/video/IDedupedFrameExtractor.js";
import type { InterviewEvaluationPayload } from "../types/interviewEvaluation.js";
import type { SpeechTranscription } from "../types/speechTranscription.js";
import { readPngDimensions, type EditorRoiDetectionService } from "./editorRoiDetection.js";
import {
  buildRoiCropEncodeFilter,
  EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX,
  ffprobeFormatDurationSec,
  ffprobeVideoStreamDimensions,
  FfmpegRunner,
  writeFramesManifest,
} from "./ffmpegExtract.js";
import { truncateProblemStatementForEvaluation } from "../prompts/buildEvaluationUserMessage.js";
import {
  alignFramesToSpeech,
  buildFinalTranscriptJson,
  type FinalTranscriptJson,
  type FrameOcrRecord,
} from "./transcriptFormatting.js";
import type { TesseractRunner } from "./tesseractRunner.js";
import type { VideoCropRect } from "./VideoProcessingPipeline.js";

export type E2ePipelineInput = {
  inputVideoPath: string;
  outputDir: string;
  /** Limits how much of the source is processed (seconds). */
  maxInputDurationSec?: number;
  /**
   * Passed to STT + rubric artifacts (`speech-transcription.json`, etc.). Defaults to `e2e-<outputDir basename>`.
   */
  sttEvalJobId?: string;
};

/** Structured output from {@link E2eInterviewPipeline.run} for APIs and tests (disk artifacts are still written). */
export type E2eInterviewPipelineRunResult = {
  transcription: SpeechTranscription;
  evaluation: InterviewEvaluationPayload;
  frameTimesSec: number[];
  frameOcrTexts: string[];
  alignedTimeline: FrameOcrRecord[];
  finalTranscript: FinalTranscriptJson;
  audioWavPath: string;
  roiCroppedMp4Path: string;
  outputDir: string;
  cropUsed: VideoCropRect;
  extractedFrameCount: number;
  problemStatement: string | null;
};

/** Injected collaborators for {@link E2eInterviewPipeline} (vision ROI, frame extract, STT + rubric LLM). */
export type E2eInterviewPipelineDeps = {
  roiDetection: EditorRoiDetectionService | null;
  dedupedFrames: IDedupedFrameExtractor;
  speechAnalysis: SpeechTranscriptionEvaluationOrchestrator;
  /** After mpdecimate; default 2. */
  frameExportFps?: number;
  /**
   * Concurrent `tesseract` processes for frame OCR. When unset, uses `FRAME_OCR_CONCURRENCY` (default 8), clamped 1–64.
   */
  frameOcrConcurrency?: number;
  onProgress?: (message: string) => void;
};

function makeEvenCrop(r: VideoCropRect): VideoCropRect {
  const x = Math.max(0, Math.floor(r.x / 2) * 2);
  const y = Math.max(0, Math.floor(r.y / 2) * 2);
  const w = Math.max(2, Math.floor(r.width / 2) * 2);
  const h = Math.max(2, Math.floor(r.height / 2) * 2);
  return { x, y, width: w, height: h };
}

/** Map a crop from PNG / vision space into FFmpeg filter graph space for the demuxed video stream. */
function scaleCropRectToSpace(
  crop: VideoCropRect,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): VideoCropRect {
  return {
    x: Math.round((crop.x * toW) / fromW),
    y: Math.round((crop.y * toH) / fromH),
    width: Math.round((crop.width * toW) / fromW),
    height: Math.round((crop.height * toH) / fromH),
  };
}

function clampCropRectToImage(
  r: VideoCropRect,
  imageWidth: number,
  imageHeight: number,
): VideoCropRect | null {
  let xi = Math.floor(r.x);
  let yi = Math.floor(r.y);
  let wi = Math.floor(r.width);
  let hi = Math.floor(r.height);
  if (wi < 1 || hi < 1) {
    return null;
  }
  xi = Math.max(0, Math.min(xi, imageWidth - 1));
  yi = Math.max(0, Math.min(yi, imageHeight - 1));
  wi = Math.min(wi, imageWidth - xi);
  hi = Math.min(hi, imageHeight - yi);
  if (wi < 1 || hi < 1) {
    return null;
  }
  return { x: xi, y: yi, width: wi, height: hi };
}

/**
 * Nudge the crop left so the line gutter / first code column is not clipped. Set `EDITOR_ROI_PAD_LEFT_PX=0` to turn off.
 * Default 24px (~1% on 2560-wide frames); override with any non-negative integer.
 */
function readEditorRoiPadLeftPx(): number {
  const raw = process.env.EDITOR_ROI_PAD_LEFT_PX?.trim();
  if (raw === undefined || raw === "") {
    return 24;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return 24;
  }
  return Math.floor(n);
}

function expandCropRectLeft(
  r: VideoCropRect,
  padLeft: number,
  imageWidth: number,
  imageHeight: number,
): VideoCropRect {
  if (padLeft <= 0) {
    return r;
  }
  const newX = Math.max(0, r.x - padLeft);
  const gained = r.x - newX;
  const wider: VideoCropRect = {
    x: newX,
    y: r.y,
    width: r.width + gained,
    height: r.height,
  };
  return clampCropRectToImage(wider, imageWidth, imageHeight) ?? r;
}

function durationArgs(maxSec?: number): string[] {
  if (maxSec == null || !Number.isFinite(maxSec) || maxSec <= 0) {
    return [];
  }
  return ["-t", String(maxSec)];
}

function defaultE2eProgress(msg: string): void {
  process.stderr.write(`[e2e] ${msg}\n`);
}

function resolveFrameOcrConcurrency(explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit) && explicit >= 1) {
    return Math.min(64, Math.floor(explicit));
  }
  const raw = process.env.FRAME_OCR_CONCURRENCY?.trim();
  let n = raw ? Number(raw) : 8;
  if (!Number.isFinite(n) || n < 1) {
    n = 8;
  }
  return Math.min(64, Math.floor(n));
}

/**
 * Run async work over `items` with at most `concurrency` in flight; results match input order.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) {
    return [];
  }
  const pool = Math.max(1, Math.min(concurrency, n));
  const results = new Array<R>(n);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) {
        return;
      }
      results[i] = await mapper(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

/**
 * End-to-end: demux → first-frame ROI → crop video → FFmpeg mpdecimate → showinfo PNGs →
 * Whisper + rubric LLM → Tesseract OCR → timeline alignment → JSON + SRT + feedback artifacts on disk.
 *
 * Callers must run {@link assertMandatoryVisionRoi} or {@link assertMandatoryInterviewApiConfig} before {@link E2eInterviewPipeline.run}
 * so ROI configuration fails at startup, not mid-pipeline.
 */
export class E2eInterviewPipeline {
  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly tesseract: TesseractRunner,
    private readonly deps: E2eInterviewPipelineDeps,
  ) {}

  private progress(msg: string): void {
    (this.deps.onProgress ?? defaultE2eProgress)(msg);
  }

  async run(input: E2ePipelineInput): Promise<E2eInterviewPipelineRunResult> {
    const { inputVideoPath, outputDir, maxInputDurationSec, sttEvalJobId } = input;
    const dur = durationArgs(maxInputDurationSec);

    await fs.mkdir(outputDir, { recursive: true });
    const framesDir = path.join(outputDir, "frames");
    await fs.mkdir(framesDir, { recursive: true });

    const audioWav = path.join(outputDir, "audio.wav");
    const videoVideoOnly = path.join(outputDir, "video-video-only.mp4");
    const firstFramePng = path.join(outputDir, "first-frame.png");
    const roiCroppedMp4 = path.join(outputDir, "video-roi-cropped.mp4");
    const framesManifestPath = path.join(outputDir, "frames-manifest.json");
    const transcriptSrtPath = path.join(outputDir, "transcript.srt");
    const problemPath = path.join(outputDir, "problem-statement.txt");
    const editorRoiDebugPath = path.join(outputDir, "editor-roi-debug.json");
    const resultJsonPath = path.join(outputDir, "e2e-result.json");
    const finalTranscriptPath = path.join(outputDir, "final-transcript.json");
    const speechTranscriptionJsonPath = path.join(outputDir, "speech-transcription.json");
    const interviewFeedbackPath = path.join(outputDir, "interview-feedback.json");

    this.progress(
      `Starting → ${outputDir}${maxInputDurationSec != null ? ` (first ${maxInputDurationSec}s)` : " (full input)"}`,
    );

    this.progress("Extracting audio (WAV)…");
    await this.ffmpeg.exec([
      "-i",
      inputVideoPath,
      ...dur,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      audioWav,
    ]);
    this.progress("Demuxing video-only copy…");
    await this.ffmpeg.exec([
      "-i",
      inputVideoPath,
      ...dur,
      "-an",
      "-c:v",
      "copy",
      videoVideoOnly,
    ]);
    this.progress("Capturing first frame for ROI…");
    await this.ffmpeg.exec([
      "-i",
      inputVideoPath,
      ...dur,
      "-frames:v",
      "1",
      "-update",
      "1",
      firstFramePng,
    ]);

    let problemStatement: string | null = null;

    const roiService = this.deps.roiDetection;
    if (!roiService) {
      throw new Error(
        "Editor ROI detection is required for this pipeline. Set OPENAI_API_KEY.",
      );
    }

    this.progress("Calling vision ROI + problem extraction…");
    const roiResult = await roiService.detectEditorRoi({ imagePath: firstFramePng });
    if (roiResult.problemStatement?.trim()) {
      problemStatement = roiResult.problemStatement.trim();
      await fs.writeFile(problemPath, problemStatement, "utf-8");
    }

    if (!roiResult.crop) {
      throw new Error("LLM did not return an editor crop; cannot crop video to ROI.");
    }

    const pngDims = readPngDimensions(firstFramePng);
    const streamDims = await ffprobeVideoStreamDimensions(inputVideoPath);
    let cropInStreamSpace = roiResult.crop;
    let scaledFromPng: VideoCropRect | null = null;
    if (
      streamDims != null &&
      (streamDims.width !== pngDims.width || streamDims.height !== pngDims.height)
    ) {
      scaledFromPng = scaleCropRectToSpace(
        roiResult.crop,
        pngDims.width,
        pngDims.height,
        streamDims.width,
        streamDims.height,
      );
      const clamped = clampCropRectToImage(scaledFromPng, streamDims.width, streamDims.height);
      if (!clamped) {
        throw new Error(
          `ROI scaled from PNG (${pngDims.width}×${pngDims.height}) to stream (${streamDims.width}×${streamDims.height}) was invalid; check editor-roi-debug after re-run.`,
        );
      }
      cropInStreamSpace = clamped;
      this.progress(
        `ROI: PNG ${pngDims.width}×${pngDims.height} vs stream ${streamDims.width}×${streamDims.height} — scaled crop to video space.`,
      );
    }

    const encW = streamDims?.width ?? pngDims.width;
    const encH = streamDims?.height ?? pngDims.height;
    const padLeftPx = readEditorRoiPadLeftPx();
    const cropBeforeLeftPad = { ...cropInStreamSpace };
    cropInStreamSpace = expandCropRectLeft(cropInStreamSpace, padLeftPx, encW, encH);
    if (padLeftPx > 0 && cropInStreamSpace.x !== cropBeforeLeftPad.x) {
      this.progress(
        `ROI: expanded left by up to ${padLeftPx}px (gutter margin); x ${cropBeforeLeftPad.x}→${cropInStreamSpace.x}.`,
      );
    }

    const crop = makeEvenCrop(cropInStreamSpace);
    const vf = buildRoiCropEncodeFilter(crop);

    const editorRoiDebugPayload: Record<string, unknown> = {
      pngDimensions: pngDims,
      videoStreamDimensions: streamDims,
      cropFromModelPx: roiResult.crop,
      scaledFromPngToStream: scaledFromPng,
      editorRoiPadLeftPx: padLeftPx,
      cropBeforeLeftPad,
      cropAfterLeftPad: cropInStreamSpace,
      cropAfterMakeEven: crop,
      /** Pixel size cut from the source video, before `scale=` in `vf`. */
      cropPixelSizeBeforeScale: { width: crop.width, height: crop.height },
      editorRoiPostCropTargetWidthPx: EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX,
      vf,
      rawModelJson: roiResult.rawResponseText ?? null,
    };

    this.progress(
      `Encoding ROI crop ${crop.width}×${crop.height} @ (${crop.x},${crop.y}) → scale to ${EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX}px wide (lanczos)…`,
    );
    await this.ffmpeg.exec([
      "-i",
      inputVideoPath,
      ...dur,
      "-vf",
      vf,
      "-an",
      roiCroppedMp4,
    ]);

    const roiEncodedDims = await ffprobeVideoStreamDimensions(roiCroppedMp4);
    editorRoiDebugPayload.roiCroppedMp4StreamDimensions = roiEncodedDims;
    await fs.writeFile(editorRoiDebugPath, JSON.stringify(editorRoiDebugPayload, null, 2), "utf-8");

    const roiOutW = roiEncodedDims?.width ?? "?";
    const roiOutH = roiEncodedDims?.height ?? "?";
    const formatDurationSec = await ffprobeFormatDurationSec(roiCroppedMp4);
    this.progress(
      `ROI clip encoded ${roiOutW}×${roiOutH}px on disk (was ${crop.width}×${crop.height}px before scale) — duration ${formatDurationSec.toFixed(2)}s; FFmpeg mpdecimate + PNG extract…`,
    );

    for (const f of await fs.readdir(framesDir)) {
      if (f.endsWith(".png")) {
        await fs.unlink(path.join(framesDir, f));
      }
    }

    const fps = this.deps.frameExportFps ?? 2;
    const extracted = await this.deps.dedupedFrames.extractFrames({
      inputVideo: roiCroppedMp4,
      outputDir: framesDir,
      fps,
    });
    const manifest = await writeFramesManifest(framesManifestPath, extracted);
    this.progress(
      `Frames written: ${manifest.length} (mpdecimate, fps=${fps} cap, showinfo timestamps).`,
    );

    const times = manifest.map((m) => m.timestampSec);
    const frameFiles = (await fs.readdir(framesDir))
      .filter((f) => f.endsWith(".png"))
      .sort();
    const ocrConcurrency = resolveFrameOcrConcurrency(this.deps.frameOcrConcurrency);
    const ocrLogEvery = 50;
    let ocrCompleted = 0;
    this.progress(
      `Tesseract OCR: ${frameFiles.length} frames (${ocrConcurrency} parallel, log every ${ocrLogEvery})…`,
    );
    const ocrTexts = await mapWithConcurrency(frameFiles, ocrConcurrency, async (file) => {
      const text = await this.tesseract.ocrPng(path.join(framesDir, file));
      const done = ++ocrCompleted;
      if (done === 1 || done % ocrLogEvery === 0 || done === frameFiles.length) {
        this.progress(`OCR ${done}/${frameFiles.length} (${file})`);
      }
      return text;
    });
    this.progress("OCR finished.");

    if (times.length !== ocrTexts.length) {
      console.warn(
        `[e2e] Manifest vs OCR length mismatch: manifest=${times.length} ocr=${ocrTexts.length}; aligning min length.`,
      );
    }
    const alignN = Math.min(times.length, ocrTexts.length);
    const ocrs = ocrTexts.slice(0, alignN);
    const timesAligned = times.slice(0, alignN);

    const jobId = sttEvalJobId ?? `e2e-${path.basename(outputDir)}`;
    const problemForEval = problemStatement?.trim()
      ? truncateProblemStatementForEvaluation(problemStatement)
      : undefined;
    this.progress("Speech-to-text (Whisper) + interview rubric evaluation…");
    const evalOptions: TranscribeAndEvaluateOptions = {
      evaluationFrameTimesSec: timesAligned,
      evaluationFrameOcrTexts: ocrs,
    };
    if (problemForEval) {
      evalOptions.problemStatementText = problemForEval;
    }
    const { transcription, evaluation } = await this.deps.speechAnalysis.transcribeAndEvaluate(
      audioWav,
      jobId,
      evalOptions,
    );
    this.progress(
      `Whisper done: ${transcription.segments.length} segments, ${(transcription.durationSec ?? 0).toFixed(1)}s audio; evaluation status=${evaluation.status}.`,
    );
    await writeE2eSpeechAnalysisArtifacts(outputDir, jobId, transcription, evaluation);

    const aligned = alignFramesToSpeech(timesAligned, ocrs, transcription.segments);

    const finalTranscript = buildFinalTranscriptJson(transcription, timesAligned, ocrs);
    await fs.writeFile(finalTranscriptPath, JSON.stringify(finalTranscript, null, 2), "utf-8");

    const result = {
      meta: {
        inputVideoPath,
        outputDir,
        maxInputDurationSec: maxInputDurationSec ?? null,
        cropUsed: crop,
        problemStatementPreview:
          problemStatement != null
            ? problemStatement.length > 500
              ? `${problemStatement.slice(0, 500)}…`
              : problemStatement
            : null,
        files: {
          audioWav,
          videoVideoOnly,
          firstFramePng,
          roiCroppedMp4,
          framesDir,
          framesManifest: framesManifestPath,
          transcriptSrt: transcriptSrtPath,
          speechTranscriptionJson: speechTranscriptionJsonPath,
          interviewFeedback: interviewFeedbackPath,
          finalTranscript: finalTranscriptPath,
          problemStatement: problemStatement ? problemPath : null,
          editorRoiDebug: editorRoiDebugPath,
        },
        frameStats: {
          formatDurationSec,
          frameExtraction: {
            method: "ffmpeg_mpdecimate_showinfo",
            extractedFrameCount: manifest.length,
          },
          finalPngFrameCount: ocrTexts.length,
          alignedCount: alignN,
        },
        speech: {
          providerId: transcription.providerId,
          modelId: transcription.modelId,
          language: transcription.language,
          segmentCount: transcription.segments.length,
        },
        interviewEvaluation: evaluation,
      },
      alignedTimeline: aligned,
    };

    await fs.writeFile(resultJsonPath, JSON.stringify(result, null, 2), "utf-8");
    this.progress(
      "Wrote e2e-result.json, final-transcript.json, transcript.srt, interview-feedback.json — pipeline complete.",
    );

    return {
      transcription,
      evaluation,
      frameTimesSec: timesAligned,
      frameOcrTexts: ocrs,
      alignedTimeline: aligned,
      finalTranscript,
      audioWavPath: audioWav,
      roiCroppedMp4Path: roiCroppedMp4,
      outputDir,
      cropUsed: crop,
      extractedFrameCount: manifest.length,
      problemStatement,
    };
  }
}
