import fs from "node:fs/promises";
import path from "node:path";
import type { IAppDao } from "../dao/IAppDao.js";
import type { LiveVoiceRealtimeAudioChunkItem } from "../dao/dto.js";
import { FfmpegRunner } from "../media/ffmpegExtract.js";
import { pcmS16leMonoDurationMs, readVoiceRealtimeAudioBridgeMeta, type VoiceRealtimeAudioChunkStitchRow } from "./interviewBridgeCapture.js";

/** DB page size for stitch (avoids a single unbounded `findMany`). */
const VOICE_REALTIME_AUDIO_DB_PAGE_SIZE = 10_000;

/**
 * `bridgeOpenedAtWallMs - recordingEpochWallMs` (ms). `recordingEpochWallMs` is
 * {@link IAppDao.getLiveSessionRecordingStartedAtWallMs} when the extension POSTed `/recording-clock` right after
 * `MediaRecorder.start`, else the first video chunk's `createdAt` (can lag the real t=0 by the recorder timeslice).
 * Add the result to {@link VoiceRealtimeAudioChunkStitchRow.offsetFromBridgeOpenMs} for ms since recording start.
 */
export async function computeRecordingAnchorDeltaMs(
  db: IAppDao,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
): Promise<number> {
  const fromClock = await db.getLiveSessionRecordingStartedAtWallMs(sessionId);
  const fromFirstChunk = (await db.getFirstLiveVideoChunkCreatedAt(sessionId))?.getTime();
  const recordingEpochMs = fromClock ?? fromFirstChunk;
  if (recordingEpochMs == null) {
    return 0;
  }
  return Math.round(bridgeOpenedAtWallMs - recordingEpochMs);
}

type PlacedChunk = VoiceRealtimeAudioChunkStitchRow & {
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
  sessionId: string;
  db: IAppDao;
  workDir: string;
  outWav16k: string;
}): Promise<{ timeline24kPath: string; chunkCount: number; anchorDeltaMs: number } | null> {
  const { sessionId, db, workDir, outWav16k } = params;
  const meta = await readVoiceRealtimeAudioBridgeMeta(db, sessionId);
  if (!meta) {
    return null;
  }

  const rows: LiveVoiceRealtimeAudioChunkItem[] = [];
  let afterSequence: number | null = null;
  for (;;) {
    const page = await db.findLiveVoiceRealtimeAudioChunksPage({
      sessionId,
      afterSequence,
      limit: VOICE_REALTIME_AUDIO_DB_PAGE_SIZE,
    });
    if (page.length === 0) {
      break;
    }
    rows.push(...page);
    afterSequence = page[page.length - 1]!.sequence;
  }
  if (rows.length === 0) {
    return null;
  }

  const chunks: VoiceRealtimeAudioChunkStitchRow[] = rows.map((r) => ({
    pcm: r.pcmS16le,
    sampleRate: r.sampleRate,
    bytes: r.pcmS16le.length,
    receivedAtWallMs: r.receivedAtWallMs,
    offsetFromBridgeOpenMs: r.offsetFromBridgeOpenMs,
  }));

  const anchorDeltaMs = await computeRecordingAnchorDeltaMs(db, sessionId, meta.bridgeOpenedAtWallMs);

  const placed: PlacedChunk[] = chunks.map((c) => ({
    ...c,
    offsetOnRecordingMs: Math.max(0, c.offsetFromBridgeOpenMs + anchorDeltaMs),
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

    const pcmPath = path.join(workDir, `raw_${segIdx}.pcm`);
    await fs.writeFile(pcmPath, c.pcm);
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
 * Mixes tab/mic-derived `audio.wav` with the interviewer timeline (both 16 kHz mono), then muxes Opus into WebM.
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

  // duration=first: match tab/mic length so mux with `-shortest` does not clip a longer model tail off the WebM.
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
