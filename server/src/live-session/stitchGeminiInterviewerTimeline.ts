import { Readable } from "node:stream";
import type { IAppDao } from "../dao/IAppDao.js";
import type { LiveVoiceRealtimeAudioChunkMeta } from "../dao/dto.js";
import {
  FfmpegRunner,
  pipelinePcmS16leMono24kToWav16kFile,
  resampleS16leMonoPcmBuffer,
} from "../media/ffmpegExtract.js";
import { pcmS16leMonoDurationMs, readVoiceRealtimeAudioBridgeMeta } from "./interviewBridgeCapture.js";

/** How many timeline chunks worth of PCM to load from the DB at once (bounded RAM). */
const STITCH_PCM_FETCH_BATCH = 5000;

/** Interviewer timeline sample rate before downmix to 16 kHz for tab/mic blend. */
const TIMELINE_PCM_HZ = 24_000;

/** Max contiguous same-rate PCM merged before one ffmpeg resample (avoids huge `Buffer.concat`). */
const PENDING_RESAMPLE_MAX_MS = 1000;

/**
 * `bridgeOpenedAtWallMs - recordingEpochWallMs` (ms). `recordingEpochWallMs` is
 * {@link IAppDao.getLiveSessionRecordingStartedAtWallMs} when the extension POSTed `/recording-clock` right after
 * `MediaRecorder.start`, else the first video chunk's `createdAt` (can lag the real t=0 by the recorder timeslice).
 * Add the result to bridge-relative `offsetFromBridgeOpenMs` for ms since recording start.
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

type PlacedMeta = LiveVoiceRealtimeAudioChunkMeta & {
  offsetOnRecordingMs: number;
  durationMs: number;
};

type PendingSameRate = { sampleRate: number; parts: Buffer[] };

function pendingPcmDurationMs(p: PendingSameRate): number {
  const totalBytes = p.parts.reduce((sum, b) => sum + b.length, 0);
  return pcmS16leMonoDurationMs(totalBytes, p.sampleRate);
}

/** Concatenate consecutive same-rate chunks (no timeline gap) and resample once; skip ffmpeg when already 24 kHz. */
async function flushPendingToTimeline24k(pending: PendingSameRate | null): Promise<Buffer[]> {
  if (!pending || pending.parts.length === 0) {
    return [];
  }
  const merged = Buffer.concat(pending.parts);
  const { sampleRate } = pending;
  if (sampleRate === TIMELINE_PCM_HZ) {
    return [merged];
  }
  return [await resampleS16leMonoPcmBuffer(merged, sampleRate, TIMELINE_PCM_HZ)];
}

/**
 * Builds a mono 16 kHz WAV for the interviewer from stored PCM chunks + silence gaps.
 *
 * - Loads **metadata only** (no PCM blobs) for ordering, then batch-fetches PCM in {@link STITCH_PCM_FETCH_BATCH}-sized groups.
 * - Streams 24 kHz s16le mono into ffmpeg stdin and writes **only** `outWav16k` on disk (no per-segment temp files,
 *   no full-timeline `Buffer.concat` in Node).
 * - **Does not spawn ffmpeg per tiny chunk**: 24 kHz PCM is copied as-is; other rates are resampled **once per ~1s**
 *   of contiguous same-rate audio (or on gap / rate change), not once per 20–40 ms receive.
 */
export async function stitchGeminiInterviewerTimelineWav(params: {
  sessionId: string;
  db: IAppDao;
  outWav16k: string;
}): Promise<{ chunkCount: number; anchorDeltaMs: number } | null> {
  const { sessionId, db, outWav16k } = params;
  const metaBridge = await readVoiceRealtimeAudioBridgeMeta(db, sessionId);
  if (!metaBridge) {
    return null;
  }

  const metas = await db.listLiveVoiceRealtimeAudioChunkMetas(sessionId);
  if (metas.length === 0) {
    return null;
  }

  const anchorDeltaMs = await computeRecordingAnchorDeltaMs(db, sessionId, metaBridge.bridgeOpenedAtWallMs);

  const placed: PlacedMeta[] = metas.map((m) => ({
    ...m,
    offsetOnRecordingMs: Math.max(0, m.offsetFromBridgeOpenMs + anchorDeltaMs),
    durationMs: pcmS16leMonoDurationMs(m.pcmByteLength, m.sampleRate),
  }));
  placed.sort((a, b) => a.offsetOnRecordingMs - b.offsetOnRecordingMs);

  const bytesPerMs = (TIMELINE_PCM_HZ * 2) / 1000;

  async function* stitchedPcm24k(): AsyncGenerator<Buffer, void, undefined> {
    let cursorMs = 0;
    let idx = 0;
    let pending: PendingSameRate | null = null;

    while (idx < placed.length) {
      const end = Math.min(idx + STITCH_PCM_FETCH_BATCH, placed.length);
      const batch = placed.slice(idx, end);
      idx = end;

      const sequences = [...new Set(batch.map((p) => p.sequence))];
      const rows = await db.findLiveVoiceRealtimeAudioChunksBySequences(sessionId, sequences);
      const bySeq = new Map(rows.map((r) => [r.sequence, r]));

      for (const p of batch) {
        const startMs = Math.max(p.offsetOnRecordingMs, cursorMs);
        const gapMs = startMs - cursorMs;
        if (gapMs > 0) {
          for (const b of await flushPendingToTimeline24k(pending)) {
            yield b;
          }
          pending = null;
          const n = Math.floor(gapMs * bytesPerMs);
          if (n > 0) {
            yield Buffer.alloc(n, 0);
          }
          cursorMs += gapMs;
        }

        const row = bySeq.get(p.sequence);
        if (!row) {
          throw new Error(`Missing live voice chunk sequence ${p.sequence} for session ${sessionId}`);
        }

        if (row.sampleRate === TIMELINE_PCM_HZ) {
          for (const b of await flushPendingToTimeline24k(pending)) {
            yield b;
          }
          pending = null;
          yield row.pcmS16le;
          cursorMs += p.durationMs;
          continue;
        }

        if (pending && pending.sampleRate !== row.sampleRate) {
          for (const b of await flushPendingToTimeline24k(pending)) {
            yield b;
          }
          pending = null;
        }
        if (!pending) {
          pending = { sampleRate: row.sampleRate, parts: [] };
        } else {
          const nextDur = pcmS16leMonoDurationMs(row.pcmS16le.length, row.sampleRate);
          if (pendingPcmDurationMs(pending) + nextDur > PENDING_RESAMPLE_MAX_MS) {
            for (const b of await flushPendingToTimeline24k(pending)) {
              yield b;
            }
            pending = { sampleRate: row.sampleRate, parts: [] };
          }
        }
        pending.parts.push(row.pcmS16le);
        cursorMs += p.durationMs;
      }
    }

    for (const b of await flushPendingToTimeline24k(pending)) {
      yield b;
    }
  }

  const source = Readable.from(stitchedPcm24k(), { objectMode: false });
  await pipelinePcmS16leMono24kToWav16kFile(source, outWav16k);

  return { chunkCount: metas.length, anchorDeltaMs };
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
