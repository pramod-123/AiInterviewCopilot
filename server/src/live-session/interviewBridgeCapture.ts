import fs from "node:fs/promises";
import path from "node:path";
import type { IAppDao } from "../dao/IAppDao.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";

const REALTIME_TRANSCRIPT_LOG = "realtime-transcriptions.jsonl";

/** Directory under each live session for bridge transcript + related files. */
export const LIVE_BRIDGE_TRANSCRIPTION_DIR = "live-bridge-transcription";

/** Anchor for chunk offsets (stored on the live session as `voiceRealtimeBridgeOpenedAtWallMs`). */
export type VoiceRealtimeAudioBridgeMeta = {
  version: 1;
  bridgeOpenedAtWallMs: number;
};

/** One PCM segment for timeline stitch (from DB). */
export type VoiceRealtimeAudioChunkStitchRow = {
  pcm: Buffer;
  sampleRate: number;
  bytes: number;
  receivedAtWallMs: number;
  offsetFromBridgeOpenMs: number;
};

/** Legacy on-disk `chunks.jsonl` row (per-file PCM). Used only by migration and tests. */
export type VoiceRealtimeAudioChunkFileRow = {
  file: string;
  sampleRate: number;
  bytes: number;
  receivedAtWallMs: number;
  offsetFromBridgeOpenMs: number;
};

/** One input/output transcription event (persisted under the realtime audio session directory). */
export type RealtimeTranscriptionRecord = {
  role: "input" | "output";
  text: string;
  finished: boolean;
  /** Legacy single instant (ms since bridge open); used when span fields are absent. */
  offsetFromBridgeOpenMs: number;
  /** When both set (Gemini buffered flush), segment uses this wall-derived span on the bridge timeline (ms since bridge open). */
  startOffsetFromBridgeOpenMs?: number;
  endOffsetFromBridgeOpenMs?: number;
};

export function parsePcmSampleRateFromMime(mimeType: string): number {
  const m = /rate=(\d+)/i.exec(mimeType || "");
  return m ? Number.parseInt(m[1], 10) : 24000;
}

/** PCM duration in milliseconds (16-bit mono). */
export function pcmS16leMonoDurationMs(numBytes: number, sampleRate: number): number {
  if (sampleRate <= 0 || numBytes <= 0) {
    return 0;
  }
  const samples = numBytes / 2;
  return (samples / sampleRate) * 1000;
}

export function realtimeAudioDir(paths: AppPaths, sessionId: string): string {
  return path.join(paths.liveSessionDir(sessionId), LIVE_BRIDGE_TRANSCRIPTION_DIR);
}

export async function readVoiceRealtimeAudioBridgeMeta(
  db: IAppDao,
  sessionId: string,
): Promise<VoiceRealtimeAudioBridgeMeta | null> {
  const ms = await db.getVoiceRealtimeBridgeOpenedAtWallMs(sessionId);
  if (ms == null) {
    return null;
  }
  return { version: 1, bridgeOpenedAtWallMs: ms };
}

/**
 * Ensures transcript log directory exists and persists the bridge-open anchor on the session (once).
 */
export async function initRealtimeAudioCapture(
  db: IAppDao,
  paths: AppPaths,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
): Promise<void> {
  const dir = realtimeAudioDir(paths, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await db.setVoiceRealtimeBridgeOpenedAtIfUnset(sessionId, bridgeOpenedAtWallMs);
}

export async function appendRealtimeTranscription(
  paths: AppPaths,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
  role: "input" | "output",
  text: string,
  finished: boolean,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const dir = realtimeAudioDir(paths, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const offsetFromBridgeOpenMs = Math.max(0, Date.now() - bridgeOpenedAtWallMs);
  const rec: RealtimeTranscriptionRecord = {
    role,
    text: trimmed,
    finished,
    offsetFromBridgeOpenMs,
  };
  await fs.appendFile(path.join(dir, REALTIME_TRANSCRIPT_LOG), `${JSON.stringify(rec)}\n`, "utf-8");
}

/**
 * Append one transcription line with an explicit **wall-clock** span (converted to ms since bridge open).
 * Used by Gemini Live buffering: input/output token times instead of `Date.now()` at append.
 */
export async function appendRealtimeTranscriptionWallSpan(
  paths: AppPaths,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
  role: "input" | "output",
  text: string,
  startWallMs: number,
  endWallMs: number,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  let startOffset = Math.round(startWallMs - bridgeOpenedAtWallMs);
  let endOffset = Math.round(endWallMs - bridgeOpenedAtWallMs);
  startOffset = Math.max(0, startOffset);
  endOffset = Math.max(0, endOffset);
  if (endOffset <= startOffset) {
    endOffset = startOffset + 1;
  }
  const dir = realtimeAudioDir(paths, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const rec: RealtimeTranscriptionRecord = {
    role,
    text: trimmed,
    finished: true,
    offsetFromBridgeOpenMs: startOffset,
    startOffsetFromBridgeOpenMs: startOffset,
    endOffsetFromBridgeOpenMs: endOffset,
  };
  await fs.appendFile(path.join(dir, REALTIME_TRANSCRIPT_LOG), `${JSON.stringify(rec)}\n`, "utf-8");
}

export async function readRealtimeTranscriptionRecords(
  paths: AppPaths,
  sessionId: string,
): Promise<RealtimeTranscriptionRecord[]> {
  const dir = realtimeAudioDir(paths, sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, REALTIME_TRANSCRIPT_LOG), "utf-8");
  } catch {
    return [];
  }
  const out: RealtimeTranscriptionRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const o = JSON.parse(t) as RealtimeTranscriptionRecord;
      if (o && (o.role === "input" || o.role === "output") && typeof o.text === "string") {
        const start = Number(o.startOffsetFromBridgeOpenMs);
        const end = Number(o.endOffsetFromBridgeOpenMs);
        const hasSpan = Number.isFinite(start) && Number.isFinite(end) && end > start;
        out.push({
          role: o.role,
          text: o.text,
          finished: Boolean(o.finished),
          offsetFromBridgeOpenMs: Number(o.offsetFromBridgeOpenMs) || 0,
          ...(hasSpan
            ? { startOffsetFromBridgeOpenMs: start, endOffsetFromBridgeOpenMs: end }
            : {}),
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function appendRealtimeModelAudioChunk(
  db: IAppDao,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
  mimeType: string,
  base64: string,
): Promise<void> {
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return;
  }
  if (buf.length === 0) {
    return;
  }
  const sampleRate = parsePcmSampleRateFromMime(mimeType);
  const receivedAtWallMs = Date.now();
  const offsetFromBridgeOpenMs = Math.max(0, receivedAtWallMs - bridgeOpenedAtWallMs);
  await db.insertLiveVoiceRealtimeAudioChunk({
    sessionId,
    pcmS16le: buf,
    sampleRate,
    receivedAtWallMs,
    offsetFromBridgeOpenMs,
  });
}

/**
 * Collapse duplicate legacy `chunks.jsonl` rows for the same file (migration / tests).
 */
export function mergeVoiceRealtimeAudioChunkFileRowsByFile(
  chunks: VoiceRealtimeAudioChunkFileRow[],
): VoiceRealtimeAudioChunkFileRow[] {
  const byFile = new Map<string, VoiceRealtimeAudioChunkFileRow>();
  for (const c of chunks) {
    const prev = byFile.get(c.file);
    if (!prev) {
      byFile.set(c.file, { ...c });
      continue;
    }
    byFile.set(c.file, {
      ...prev,
      offsetFromBridgeOpenMs: Math.min(prev.offsetFromBridgeOpenMs, c.offsetFromBridgeOpenMs),
      bytes: Math.max(prev.bytes, c.bytes),
      receivedAtWallMs: Math.min(prev.receivedAtWallMs, c.receivedAtWallMs),
    });
  }
  return [...byFile.values()].sort((a, b) => a.offsetFromBridgeOpenMs - b.offsetFromBridgeOpenMs);
}
