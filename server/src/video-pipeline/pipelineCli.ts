/**
 * Unified video / e2e CLI (subcommand required).
 *
 *   npm run pipeline:e2e [-- [video.mov] [--quick]]
 *   npm run test:video-pipeline [-- …]
 *   npm run pipeline:e2e:stt-eval -- <e2eOutputDir>
 *   npm run pipeline:e2e:finish -- <e2eOutputDir> [inputVideoPath]
 *
 * Manual: `tsx src/video-pipeline/pipelineCli.ts <e2e|video|finish-e2e|stt-eval> …`
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2eDirectorySpeechAnalysisService,
  writeE2eSpeechAnalysisArtifacts,
} from "../services/e2e/E2eSpeechAnalysisArtifacts.js";
import { SpeechTranscriptionEvaluationOrchestratorFactory } from "../services/SpeechTranscriptionEvaluationOrchestratorFactory.js";
import { FfmpegDedupedFrameExtractor } from "../services/video/FfmpegDedupedFrameExtractor.js";
import { assertMandatoryVisionRoi } from "../services/mandatoryInterviewApiEnv.js";
import { LlmClientFactory } from "../services/llm/LlmClientFactory.js";
import { E2eInterviewPipeline } from "./E2eInterviewPipeline.js";
import { EditorRoiDetectionService } from "./editorRoiDetection.js";
import { FfmpegRunner } from "./ffmpegExtract.js";
import { alignFramesToSpeech, buildFinalTranscriptJson } from "./transcriptFormatting.js";
import type { FramesManifestEntry } from "../types/framesManifest.js";
import { assertTesseractOnPath, TesseractRunner } from "./tesseractRunner.js";
import type { VideoCropRect } from "./VideoProcessingPipeline.js";
import { VideoProcessingPipeline } from "./VideoProcessingPipeline.js";

// --- shared CLI helpers -------------------------------------------------------

export function resolveVideoInputPath(cliArg?: string): string {
  const cwd = process.cwd();
  const candidates = [
    cliArg?.trim(),
    process.env.VIDEO_PATH?.trim(),
    path.join(cwd, "media", "Interview.mov"),
    path.join(cwd, "media", "interview.mov"),
    path.join(cwd, "server", "media", "Interview.mov"),
    path.join(cwd, "server", "media", "interview.mov"),
    path.join(cwd, "interview.mov"),
    path.join(cwd, "Interview.mov"),
    path.join(cwd, "interview.mp4"),
    path.join(cwd, "src", "interview.mov"),
    path.join(cwd, "src", "Interview.mov"),
    path.join(cwd, "server", "interview.mov"),
    path.join(cwd, "server", "src", "interview.mov"),
    path.join(cwd, "server", "src", "Interview.mov"),
    path.join(cwd, "..", "interview.mov"),
    path.join(cwd, "..", "Interview.mov"),
  ].filter((p): p is string => Boolean(p));

  const seen = new Set<string>();
  for (const raw of candidates) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return abs;
    }
  }

  throw new Error(
    [
      "No video file found.",
      "Pass a path: npm run test:video-pipeline -- /path/to/interview.mov",
      "Or set VIDEO_PATH, or place Interview.mov under server/media/ (see media/.gitkeep).",
    ].join(" "),
  );
}

export function parseCropSpec(spec: string | undefined): VideoCropRect | null {
  if (spec == null || spec.trim() === "") {
    return null;
  }
  const parts = spec.split(":").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(
      `Invalid crop "${spec}". Expected width:height:x:y in pixels (e.g. 1280:720:0:0).`,
    );
  }
  const [width, height, x, y] = parts;
  return { width, height, x, y };
}

// --- e2e ----------------------------------------------------------------------

function assertFfmpegFfprobeOnPath(): void {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
    execSync("ffprobe -version", { stdio: "pipe" });
  } catch {
    console.error("ffmpeg and ffprobe are required on PATH.");
    process.exit(1);
  }
}

function parseE2eArgs(argv: string[]): { input?: string; quick?: boolean } {
  const out: { input?: string; quick?: boolean } = {};
  for (const a of argv) {
    if (a === "--quick") {
      out.quick = true;
    } else if (!a.startsWith("-")) {
      out.input = a;
    }
  }
  return out;
}

export async function runE2ePipelineCli(argv: string[]): Promise<void> {
  assertFfmpegFfprobeOnPath();
  await assertTesseractOnPath();

  const args = parseE2eArgs(argv);
  const inputPath = resolveVideoInputPath(args.input);
  const maxInputDurationSec = args.quick ? 90 : undefined;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, "..", "..");
  const outDir = path.join(
    serverRoot,
    "data",
    "e2e-pipeline-test",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

  console.log("Input: ", inputPath);
  console.log("Out:   ", outDir);
  console.error(
    "Note: step progress is logged on stderr as [e2e] / [stt] (visible here; use 2>&1 | tee log.txt if piping).",
  );
  if (maxInputDurationSec) {
    console.log("Limit: first", maxInputDurationSec, "s (quick mode)");
  }

  const speechAnalysis = new SpeechTranscriptionEvaluationOrchestratorFactory().createOrThrow();
  const visionOpenAiLlm = LlmClientFactory.tryCreate("openai", process.env);
  assertMandatoryVisionRoi(visionOpenAiLlm);
  const roiDetection = new EditorRoiDetectionService(visionOpenAiLlm);
  const pipeline = new E2eInterviewPipeline(new FfmpegRunner(), new TesseractRunner(), {
    roiDetection,
    dedupedFrames: new FfmpegDedupedFrameExtractor(),
    speechAnalysis,
    frameExportFps: 2,
  });
  await pipeline.run({ inputVideoPath: inputPath, outputDir: outDir, maxInputDurationSec });

  console.log("\nDone. Key outputs:");
  console.log("  e2e-result.json      — OCR + speech alignment + meta");
  console.log("  final-transcript.json — [{ start, end, audioTranscript, frameData[] }, …]");
  console.log("  transcript.srt / speech-transcription.json / interview-feedback.json — Whisper + rubric");
  console.log("  problem-statement.txt — if extracted");
  console.log("  audio.wav, video-roi-cropped.mp4, frames/, frames-manifest.json");
}

// --- video (FFmpeg smoke) -----------------------------------------------------

function assertFfmpegOnPath(): void {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    console.error("ffmpeg not found. Install it (e.g. `brew install ffmpeg`) and ensure it is on PATH.");
    process.exit(1);
  }
}

function parseVideoArgs(argv: string[]): {
  input?: string;
  extractFps?: number;
  quick?: boolean;
} {
  const out: {
    input?: string;
    extractFps?: number;
    quick?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fps" && argv[i + 1]) {
      out.extractFps = Number(argv[++i]);
    } else if (a === "--quick") {
      out.quick = true;
    } else if (!a.startsWith("-")) {
      out.input = a;
    }
  }
  return out;
}

export async function runVideoPipelineCli(argv: string[]): Promise<void> {
  assertFfmpegOnPath();

  const args = parseVideoArgs(argv);
  const inputPath = resolveVideoInputPath(args.input);

  const extractFpsRaw = process.env.VIDEO_EXTRACT_FPS;
  let extractFps =
    args.extractFps ??
    (extractFpsRaw != null && extractFpsRaw !== ""
      ? Number(extractFpsRaw)
      : undefined);
  if (args.quick && extractFps == null) {
    extractFps = 1;
  }
  if (extractFps != null && (!Number.isFinite(extractFps) || extractFps <= 0)) {
    throw new Error("VIDEO_EXTRACT_FPS / --fps must be a positive number.");
  }

  const maxDurRaw = process.env.VIDEO_MAX_DURATION_SEC;
  let maxInputDurationSec =
    maxDurRaw != null && maxDurRaw !== "" ? Number(maxDurRaw) : undefined;
  if (args.quick) {
    maxInputDurationSec = maxInputDurationSec ?? 90;
  }
  if (
    maxInputDurationSec != null &&
    (!Number.isFinite(maxInputDurationSec) || maxInputDurationSec <= 0)
  ) {
    throw new Error("VIDEO_MAX_DURATION_SEC must be a positive number.");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, "..", "..");
  const outDir = path.join(
    serverRoot,
    "data",
    "video-pipeline-test",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

  await fsPromises.mkdir(outDir, { recursive: true });
  const firstFramePng = path.join(outDir, "first-frame.png");
  const ffmpeg = new FfmpegRunner();
  const durArgs =
    maxInputDurationSec != null
      ? (["-t", String(maxInputDurationSec)] as const)
      : ([] as const);

  const visionOpenAiLlm = LlmClientFactory.tryCreate("openai", process.env);
  assertMandatoryVisionRoi(visionOpenAiLlm);
  const roiService = new EditorRoiDetectionService(visionOpenAiLlm);
  await ffmpeg.exec([
    "-i",
    inputPath,
    ...durArgs,
    "-frames:v",
    "1",
    "-update",
    "1",
    firstFramePng,
  ]);
  const roiResult = await roiService.detectEditorRoi({
    imagePath: firstFramePng,
  });
  if (!roiResult.crop) {
    throw new Error(
      "LLM did not return an editor crop; the video pipeline requires vision ROI. Check OPENAI_API_KEY and frame content.",
    );
  }
  const crop: VideoCropRect = roiResult.crop;
  console.log("Editor ROI:", crop);

  const extractedProblemStatement = roiResult.problemStatement;
  if (extractedProblemStatement) {
    console.log(
      "Problem (from screen):",
      extractedProblemStatement.slice(0, 200) +
        (extractedProblemStatement.length > 200 ? "…" : ""),
    );
    await fsPromises.writeFile(
      path.join(outDir, "problem-statement-extracted.txt"),
      extractedProblemStatement,
      "utf-8",
    );
  }

  console.log("Input:     ", inputPath);
  console.log("Output dir:", outDir);
  console.log("Crop:      ", crop);
  console.log("Frame fps: ", extractFps ?? "(mpdecimate only; no fps cap)");
  console.log(
    "Input -t:  ",
    maxInputDurationSec != null ? `${maxInputDurationSec}s` : "(full file)",
  );

  const pipeline = new VideoProcessingPipeline(inputPath, outDir, ffmpeg, crop, {
    ...(extractFps != null ? { extractFps } : {}),
    ...(maxInputDurationSec != null ? { maxInputDurationSec } : {}),
  });

  const artifacts = await pipeline.run();

  const summary = {
    note: "No database writes — artifacts only on disk.",
    input: inputPath,
    editorRoi: true,
    crop,
    problemStatementFromScreen:
      extractedProblemStatement != null
        ? extractedProblemStatement.length > 600
          ? `${extractedProblemStatement.slice(0, 600)}…`
          : extractedProblemStatement
        : null,
    problemStatementExtractedFile: extractedProblemStatement
      ? "problem-statement-extracted.txt"
      : null,
    extractFps: extractFps ?? null,
    maxInputDurationSec: maxInputDurationSec ?? null,
    quick: Boolean(args.quick),
    outputs: {
      audioWav: artifacts.audioWav,
      firstFramePng: artifacts.firstFramePng,
      croppedMp4: artifacts.croppedMp4,
      framesDir: artifacts.framesDir,
      framesManifest: artifacts.framesManifestPath,
    },
    frameCount: artifacts.frameCount,
  };

  const summaryPath = path.join(outDir, "pipeline-summary.json");
  await fsPromises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  console.log("\nDone.");
  console.log("Frames extracted:", artifacts.frameCount);
  console.log("Summary JSON:   ", summaryPath);
}

// --- finish e2e dir -----------------------------------------------------------

export async function finishE2eFromDirCli(argv: string[]): Promise<void> {
  await assertTesseractOnPath();
  const outDir = path.resolve(argv[0] ?? "");
  const inputVideoPath =
    argv[1] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "media", "Interview.mov");

  if (!outDir) {
    console.error("Usage: tsx pipelineCli.ts finish-e2e <outputDir> [inputVideoPath]");
    process.exit(1);
  }

  const audioWav = path.join(outDir, "audio.wav");
  const framesDir = path.join(outDir, "frames");
  const manifestPath = path.join(outDir, "frames-manifest.json");
  const transcriptSrtPath = path.join(outDir, "transcript.srt");
  const resultJsonPath = path.join(outDir, "e2e-result.json");
  const finalTranscriptPath = path.join(outDir, "final-transcript.json");
  const problemPath = path.join(outDir, "problem-statement.txt");

  const manifestRaw = await fsPromises.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw) as FramesManifestEntry[];

  const tesseract = new TesseractRunner();
  const ocrTexts: string[] = [];
  for (const entry of manifest) {
    const text = await tesseract.ocrPng(path.join(framesDir, entry.file));
    ocrTexts.push(text);
  }

  const times = manifest.map((m) => m.timestampSec);
  const jobId = `e2e-${path.basename(outDir)}`;
  const speechAnalysis = new SpeechTranscriptionEvaluationOrchestratorFactory().createOrThrow();
  const { transcription, evaluation } = await speechAnalysis.transcribeAndEvaluate(audioWav, jobId);
  await writeE2eSpeechAnalysisArtifacts(outDir, jobId, transcription, evaluation);

  const alignN = Math.min(times.length, ocrTexts.length);
  const ocrAligned = ocrTexts.slice(0, alignN);
  const aligned = alignFramesToSpeech(
    times.slice(0, alignN),
    ocrAligned,
    transcription.segments,
  );

  const finalTranscript = buildFinalTranscriptJson(
    transcription,
    times.slice(0, alignN),
    ocrAligned,
  );
  await fsPromises.writeFile(finalTranscriptPath, JSON.stringify(finalTranscript, null, 2), "utf-8");

  let problemStatementPreview: string | null;
  try {
    const ps = await fsPromises.readFile(problemPath, "utf-8");
    problemStatementPreview = ps.length > 500 ? `${ps.slice(0, 500)}…` : ps;
  } catch {
    problemStatementPreview = null;
  }

  const result = {
    meta: {
      inputVideoPath: path.resolve(inputVideoPath),
      outputDir: outDir,
      maxInputDurationSec: null,
      cropUsed: null,
      problemStatementPreview,
      note: "Finished via pipelineCli finish-e2e (STT + OCR + rubric evaluation).",
      files: {
        audioWav,
        videoVideoOnly: path.join(outDir, "video-video-only.mp4"),
        firstFramePng: path.join(outDir, "first-frame.png"),
        roiCroppedMp4: path.join(outDir, "video-roi-cropped.mp4"),
        framesDir,
        framesManifest: manifestPath,
        transcriptSrt: transcriptSrtPath,
        speechTranscriptionJson: path.join(outDir, "speech-transcription.json"),
        interviewFeedback: path.join(outDir, "interview-feedback.json"),
        finalTranscript: finalTranscriptPath,
        problemStatement: (await fsPromises.stat(problemPath).catch(() => null))
          ? problemPath
          : null,
      },
      frameStats: {
        manifestFrameCount: manifest.length,
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

  await fsPromises.writeFile(resultJsonPath, JSON.stringify(result, null, 2), "utf-8");
  console.log("Wrote:", transcriptSrtPath);
  console.log("Wrote:", path.join(outDir, "interview-feedback.json"));
  console.log("Wrote:", finalTranscriptPath);
  console.log("Wrote:", resultJsonPath);
}

// --- stt-eval only -----------------------------------------------------------

export async function sttEvalE2eCli(argv: string[]): Promise<void> {
  const outDir = path.resolve(argv[0] ?? "");
  if (!outDir) {
    console.error("Usage: tsx pipelineCli.ts stt-eval <e2eOutputDir>");
    process.exit(1);
  }

  const orchestrator = new SpeechTranscriptionEvaluationOrchestratorFactory().createOrThrow();
  const svc = new E2eDirectorySpeechAnalysisService(orchestrator);

  console.error("[stt+eval] Transcribing audio.wav (chunked if large)…");
  const { jobId, transcription, evaluation } = await svc.analyzeFromExistingWav(outDir);
  console.error(
    `[stt+eval] Wrote transcript.srt (${transcription.segments.length} segments), interview-feedback.json (status=${evaluation.status}, jobId=${jobId}).`,
  );
}

// --- dispatch -----------------------------------------------------------------

/** Drop the executed script path so the first arg is the subcommand (`e2e`, `video`, …). */
function pipelineCliUserArgs(): string[] {
  const args = process.argv.slice(2);
  const first = args[0];
  if (
    first &&
    (first.endsWith("pipelineCli.ts") ||
      first.endsWith("pipelineCli.js") ||
      /[/\\]pipelineCli\.(ts|js)$/.test(first))
  ) {
    args.shift();
  }
  return args;
}

const SUBCOMMANDS = ["e2e", "video", "finish-e2e", "stt-eval"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export async function runPipelineCliDispatch(argv: string[]): Promise<void> {
  const cmd = argv[0] as Subcommand | undefined;
  const rest = argv.slice(1);

  if (!cmd || !SUBCOMMANDS.includes(cmd as Subcommand)) {
    console.error(
      `Usage: tsx pipelineCli.ts <${SUBCOMMANDS.join("|")}> ...\n` +
        "  e2e          — full interview pipeline (npm run pipeline:e2e)\n" +
        "  video        — FFmpeg smoke + mandatory editor ROI (OPENAI_API_KEY; npm run test:video-pipeline)\n" +
        "  finish-e2e   — resume OCR+STT+eval in an existing output dir\n" +
        "  stt-eval     — Whisper + rubric only (npm run pipeline:e2e:stt-eval)",
    );
    process.exit(1);
  }

  switch (cmd) {
    case "e2e":
      await runE2ePipelineCli(rest);
      break;
    case "video":
      await runVideoPipelineCli(rest);
      break;
    case "finish-e2e":
      await finishE2eFromDirCli(rest);
      break;
    case "stt-eval":
      await sttEvalE2eCli(rest);
      break;
  }
}

function isMainModule(): boolean {
  const thisFile = path.normalize(fileURLToPath(import.meta.url));
  const a1 = process.argv[1] ? path.normalize(path.resolve(process.argv[1])) : "";
  const a2 = process.argv[2] ? path.normalize(path.resolve(process.argv[2])) : "";
  return a1 === thisFile || a2 === thisFile;
}

if (isMainModule()) {
  runPipelineCliDispatch(pipelineCliUserArgs()).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
