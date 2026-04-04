import fs from "node:fs/promises";
import path from "node:path";
import type { IAppDao } from "../dao/IAppDao.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { FfmpegRunner } from "../video-pipeline/ffmpegExtract.js";
import {
  geminiAudioDir,
  mergeGeminiChunkRecordsByFile,
  pcmS16leMonoDurationMs,
  readGeminiAudioChunks,
  readGeminiAudioMeta,
  type GeminiAudioChunkRecord,
} from "./geminiLiveAudioCapture.js";

/**
 * `bridgeOpenedAtWallMs - firstVideoChunk.createdAt` so Gemini receive-times can be shifted
 * onto the recording timeline (best-effort; assumes capture starts before or near the voice bridge).
 */
export async function computeRecordingAnchorDeltaMs(
  db: IAppDao,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
): Promise<number> {
  const createdAt = await db.getFirstLiveVideoChunkCreatedAt(sessionId);
  if (!createdAt) {
    return 0;
  }
  return Math.round(bridgeOpenedAtWallMs - createdAt.getTime());
}

type PlacedChunk = GeminiAudioChunkRecord & {
  offsetOnRecordingMs: number;
  durationMs: number;
};

function concatListLine(filePath: string): string {
  const esc = filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
  return `file '${esc}'`;
}

/**
 * Builds a mono 24 kHz timeline WAV from stored PCM chunks + silence gaps, then 16 kHz output for mixing with STT audio.
 */
export async function stitchGeminiInterviewerTimelineWav(params: {
  paths: AppPaths;
  sessionId: string;
  db: IAppDao;
  workDir: string;
  outWav16k: string;
}): Promise<{ timeline24kPath: string; chunkCount: number; anchorDeltaMs: number } | null> {
  const { paths, sessionId, db, workDir, outWav16k } = params;
  const meta = await readGeminiAudioMeta(paths, sessionId);
  const rawChunks = await readGeminiAudioChunks(paths, sessionId);
  if (!meta || rawChunks.length === 0) {
    return null;
  }

  const gDir = geminiAudioDir(paths, sessionId);
  const chunksDir = path.join(gDir, "chunks");
  const mergedByFile = mergeGeminiChunkRecordsByFile(rawChunks);
  const chunks: GeminiAudioChunkRecord[] = [];
  for (const c of mergedByFile) {
    try {
      const st = await fs.stat(path.join(chunksDir, c.file));
      const bytes = Math.max(c.bytes, st.size);
      if (bytes <= 0) {
        continue;
      }
      chunks.push({ ...c, bytes });
    } catch {
      /* missing pcm — skip */
    }
  }
  if (chunks.length === 0) {
    return null;
  }

  const anchorDeltaMs = await computeRecordingAnchorDeltaMs(db, sessionId, meta.bridgeOpenedAtWallMs);

  const placed: PlacedChunk[] = chunks.map((c) => ({
    ...c,
    offsetOnRecordingMs: Math.max(0, c.offsetFromBridgeOpenMs - anchorDeltaMs),
    durationMs: pcmS16leMonoDurationMs(c.bytes, c.sampleRate),
  }));
  placed.sort((a, b) => a.offsetOnRecordingMs - b.offsetOnRecordingMs);

  await fs.mkdir(workDir, { recursive: true });
  const ffmpeg = new FfmpegRunner();
  const segmentPaths: string[] = [];
  let cursorMs = 0;
  let segIdx = 0;

  for (const c of placed) {
    const startMs = Math.max(c.offsetOnRecordingMs, cursorMs);
    const gapMs = startMs - cursorMs;
    if (gapMs > 0) {
      const silencePath = path.join(workDir, `sil_${segIdx++}.wav`);
      const sec = gapMs / 1000;
      await ffmpeg.exec([
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=24000:cl=mono:d=${sec}`,
        "-acodec",
        "pcm_s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        silencePath,
      ]);
      segmentPaths.push(silencePath);
      cursorMs += gapMs;
    }

    const pcmPath = path.join(gDir, "chunks", c.file);
    const wavPath = path.join(workDir, `ch_${segIdx++}.wav`);
    await ffmpeg.exec([
      "-f",
      "s16le",
      "-ar",
      String(c.sampleRate),
      "-ac",
      "1",
      "-i",
      pcmPath,
      "-acodec",
      "pcm_s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      wavPath,
    ]);
    segmentPaths.push(wavPath);
    cursorMs += c.durationMs;
  }

  const listPath = path.join(workDir, "concat.txt");
  await fs.writeFile(
    listPath,
    segmentPaths.map((p) => concatListLine(path.resolve(p))).join("\n"),
    "utf-8",
  );

  const timeline24k = path.join(workDir, "gemini-interviewer-timeline-24k.wav");
  await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", timeline24k]);

  await ffmpeg.exec([
    "-i",
    timeline24k,
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    outWav16k,
  ]);

  return { timeline24kPath: timeline24k, chunkCount: chunks.length, anchorDeltaMs };
}

/**
 * Mixes tab/mic-derived `audio.wav` with the Gemini interviewer timeline (both 16 kHz mono), then muxes Opus into WebM.
 */
export async function mixDialogueAudioAndMuxWebm(params: {
  ffmpeg: FfmpegRunner;
  recordingWebm: string;
  recordingAudio16kWav: string;
  geminiTimeline16kWav: string;
  outDialogueWav: string;
  outDialogueWebm: string;
}): Promise<void> {
  const { ffmpeg, recordingWebm, recordingAudio16kWav, geminiTimeline16kWav, outDialogueWav, outDialogueWebm } =
    params;

  // duration=first: match tab/mic length so mux with `-shortest` does not clip a longer Gemini tail off the WebM.
  await ffmpeg.exec([
    "-i",
    recordingAudio16kWav,
    "-i",
    geminiTimeline16kWav,
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2:duration=first:normalize=0",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    outDialogueWav,
  ]);

  await ffmpeg.exec([
    "-i",
    recordingWebm,
    "-i",
    outDialogueWav,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "libopus",
    "-b:a",
    "128k",
    "-shortest",
    outDialogueWebm,
  ]);
}
