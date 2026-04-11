import fs from "node:fs/promises";
import path from "node:path";
import type { IAppDao } from "../dao/IAppDao.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";

const REALTIME_TRANSCRIPT_LOG = "realtime-transcriptions.jsonl";

/** Anchor for chunk offsets (stored on the live session as `voiceRealtimeBridgeOpenedAtWallMs`). */
export type VoiceRealtimeAudioBridgeMeta = {
  version: 1;
  bridgeOpenedAtWallMs: number;
};

/** @deprecated Use {@link VoiceRealtimeAudioBridgeMeta}. */
export type GeminiAudioMeta = VoiceRealtimeAudioBridgeMeta;

/** One PCM segment for timeline stitch (from DB). */
export type VoiceRealtimeAudioChunkStitchRow = {
  pcm: Buffer;
  sampleRate: number;
  bytes: number;
  receivedAtWallMs: number;
  offsetFromBridgeOpenMs: number;
};

/** @deprecated Use {@link VoiceRealtimeAudioChunkStitchRow}. */
export type GeminiAudioChunkRecord = VoiceRealtimeAudioChunkStitchRow;

/** Legacy on-disk `chunks.jsonl` row (per-file PCM). Used only by migration and tests. */
export type VoiceRealtimeAudioChunkFileRow = {
  file: string;
  sampleRate: number;
  bytes: number;
  receivedAtWallMs: number;
  offsetFromBridgeOpenMs: number;
};

/** One input/output transcription event (still logged under `gemini-audio/`). */
export type GeminiRealtimeTranscriptionRecord = {
  role: "input" | "output";
  text: string;
  finished: boolean;
  offsetFromBridgeOpenMs: number;
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

export function geminiAudioDir(paths: AppPaths, sessionId: string): string {
  return path.join(paths.liveSessionDir(sessionId), "gemini-audio");
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
export async function initGeminiAudioCapture(
  db: IAppDao,
  paths: AppPaths,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
): Promise<void> {
  const dir = geminiAudioDir(paths, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await db.setVoiceRealtimeBridgeOpenedAtIfUnset(sessionId, bridgeOpenedAtWallMs);
}

export async function appendGeminiRealtimeTranscription(
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
  const dir = geminiAudioDir(paths, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const offsetFromBridgeOpenMs = Math.max(0, Date.now() - bridgeOpenedAtWallMs);
  const rec: GeminiRealtimeTranscriptionRecord = {
    role,
    text: trimmed,
    finished,
    offsetFromBridgeOpenMs,
  };
  await fs.appendFile(path.join(dir, REALTIME_TRANSCRIPT_LOG), `${JSON.stringify(rec)}\n`, "utf-8");
}

export async function readGeminiRealtimeTranscriptionRecords(
  paths: AppPaths,
  sessionId: string,
): Promise<GeminiRealtimeTranscriptionRecord[]> {
  const dir = geminiAudioDir(paths, sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, REALTIME_TRANSCRIPT_LOG), "utf-8");
  } catch {
    return [];
  }
  const out: GeminiRealtimeTranscriptionRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const o = JSON.parse(t) as GeminiRealtimeTranscriptionRecord;
      if (o && (o.role === "input" || o.role === "output") && typeof o.text === "string") {
        out.push({
          role: o.role,
          text: o.text,
          finished: Boolean(o.finished),
          offsetFromBridgeOpenMs: Number(o.offsetFromBridgeOpenMs) || 0,
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function appendGeminiModelAudioChunk(
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
