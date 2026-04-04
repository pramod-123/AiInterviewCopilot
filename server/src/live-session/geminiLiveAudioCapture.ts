import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../infrastructure/AppPaths.js";

const META = "meta.json";
const CHUNKS_DIR = "chunks";
const CHUNKS_LOG = "chunks.jsonl";
const REALTIME_TRANSCRIPT_LOG = "realtime-transcriptions.jsonl";

export type GeminiAudioMeta = {
  version: 1;
  /** `Date.now()` when the first upstream Live session opened for this browser WebSocket. */
  bridgeOpenedAtWallMs: number;
};

export type GeminiAudioChunkRecord = {
  file: string;
  sampleRate: number;
  bytes: number;
  receivedAtWallMs: number;
  offsetFromBridgeOpenMs: number;
};

/** One input/output transcription event from Gemini Live (`inputAudioTranscription` / `outputAudioTranscription`). */
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

/**
 * Call on first Gemini Live `onopen` for this WebSocket (stable anchor across upstream reconnects).
 */
export async function initGeminiAudioCapture(
  paths: AppPaths,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
): Promise<void> {
  const dir = geminiAudioDir(paths, sessionId);
  await fs.mkdir(path.join(dir, CHUNKS_DIR), { recursive: true });
  const metaPath = path.join(dir, META);
  try {
    await fs.access(metaPath);
    return;
  } catch {
    /* create */
  }
  const meta: GeminiAudioMeta = { version: 1, bridgeOpenedAtWallMs };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Append one model audio blob (raw PCM s16le mono, rate from mimeType).
 */
/**
 * Append a transcription line (same wall-clock anchor as {@link appendGeminiModelAudioChunk}).
 */
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
  let raw = "";
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
  paths: AppPaths,
  sessionId: string,
  bridgeOpenedAtWallMs: number,
  mimeType: string,
  base64: string,
): Promise<void> {
  const dir = geminiAudioDir(paths, sessionId);
  const chunksDir = path.join(dir, CHUNKS_DIR);
  await fs.mkdir(chunksDir, { recursive: true });

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

  /** Unique names avoid parallel `onmessage` handlers racing on readdir-based indices (duplicate jsonl rows / wrong durations). */
  const name = `${randomUUID()}.pcm`;
  await fs.writeFile(path.join(chunksDir, name), buf);

  const rec: GeminiAudioChunkRecord = {
    file: name,
    sampleRate,
    bytes: buf.length,
    receivedAtWallMs,
    offsetFromBridgeOpenMs,
  };
  await fs.appendFile(path.join(dir, CHUNKS_LOG), `${JSON.stringify(rec)}\n`, "utf-8");
}

export async function readGeminiAudioMeta(
  paths: AppPaths,
  sessionId: string,
): Promise<GeminiAudioMeta | null> {
  try {
    const raw = await fs.readFile(path.join(geminiAudioDir(paths, sessionId), META), "utf-8");
    return JSON.parse(raw) as GeminiAudioMeta;
  } catch {
    return null;
  }
}

export async function readGeminiAudioChunks(
  paths: AppPaths,
  sessionId: string,
): Promise<GeminiAudioChunkRecord[]> {
  const dir = geminiAudioDir(paths, sessionId);
  let raw = "";
  try {
    raw = await fs.readFile(path.join(dir, CHUNKS_LOG), "utf-8");
  } catch {
    return [];
  }
  const out: GeminiAudioChunkRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t) as GeminiAudioChunkRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Collapse duplicate `chunks.jsonl` rows that reference the same file (legacy race) into one record
 * per file: earliest offset, largest declared byte length (on-disk size applied in stitch).
 */
export function mergeGeminiChunkRecordsByFile(chunks: GeminiAudioChunkRecord[]): GeminiAudioChunkRecord[] {
  const byFile = new Map<string, GeminiAudioChunkRecord>();
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
