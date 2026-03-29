import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SpeechSegment, SpeechTranscription } from "../../types/speechTranscription.js";

const execFileAsync = promisify(execFile);

function bytesPerSecondPcmS16leMono16k(): number {
  return 16000 * 2;
}

export async function wavDurationSec(wavPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      wavPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const n = Number(String(stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function extractWavChunk(
  inputWav: string,
  outputWav: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-ss",
      String(startSec),
      "-i",
      inputWav,
      "-t",
      String(durationSec),
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      "-acodec",
      "pcm_s16le",
      outputWav,
    ],
    { maxBuffer: 1024 * 1024 },
  );
}

/** Window length (seconds) that keeps PCM s16le mono @ 16 kHz under `maxChunkBytes`. */
export function chunkDurationSecForMaxBytes(maxChunkBytes: number): number {
  const bps = bytesPerSecondPcmS16leMono16k();
  return Math.max(30, Math.floor(maxChunkBytes / bps) - 2);
}

/**
 * Splits a WAV into time windows when the file exceeds `maxChunkBytes`, transcribes each window, merges segments.
 * Callers choose `maxChunkBytes` and `logLabel` to match their backend (API limits, local memory, etc.).
 */
export async function transcribeWavByTimeWindows(params: {
  wavPath: string;
  maxChunkBytes: number;
  logLabel: string;
  transcribeChunk: (chunkPath: string) => Promise<SpeechTranscription>;
}): Promise<SpeechTranscription> {
  const { wavPath, maxChunkBytes, logLabel, transcribeChunk } = params;
  const st = await stat(wavPath);
  if (st.size <= maxChunkBytes) {
    process.stderr.write(
      `${logLabel} single request (${(st.size / (1024 * 1024)).toFixed(2)} MiB)\n`,
    );
    return transcribeChunk(wavPath);
  }

  const totalDuration = await wavDurationSec(wavPath);
  if (totalDuration <= 0) {
    throw new Error(
      "Large WAV needs duration from ffprobe; got 0. Install ffmpeg/ffprobe and ensure the file is valid.",
    );
  }

  const windowSec = chunkDurationSecForMaxBytes(maxChunkBytes);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aic-stt-"));
  const mergedSegments: SpeechSegment[] = [];
  let language: string | null = null;
  let providerId = "";
  let modelId: string | null = null;

  try {
    const approxChunks = Math.max(1, Math.ceil(totalDuration / windowSec));
    let chunkIndex = 0;
    for (let offset = 0; offset < totalDuration; offset += windowSec) {
      const dur = Math.min(windowSec, totalDuration - offset);
      if (dur <= 0) {
        break;
      }

      chunkIndex += 1;
      process.stderr.write(
        `${logLabel} chunk ${chunkIndex}/${approxChunks} (~${offset.toFixed(0)}s–${(offset + dur).toFixed(0)}s)\n`,
      );

      const chunkPath = path.join(tmpDir, `chunk-${offset}.wav`);
      await extractWavChunk(wavPath, chunkPath, offset, dur);

      const chunkStat = await stat(chunkPath);
      if (chunkStat.size === 0) {
        await unlink(chunkPath).catch(() => {});
        break;
      }

      const tr = await transcribeChunk(chunkPath);
      await unlink(chunkPath).catch(() => {});

      providerId = tr.providerId;
      modelId = tr.modelId;
      if (language == null && tr.language) {
        language = tr.language;
      }
      for (const s of tr.segments) {
        mergedSegments.push(new SpeechSegment(offset + s.startSec, offset + s.endSec, s.text));
      }
    }

    const fullText =
      mergedSegments.length > 0
        ? mergedSegments
            .map((s) => s.text.trim())
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        : null;
    return new SpeechTranscription(
      mergedSegments,
      totalDuration,
      language,
      fullText,
      providerId,
      modelId,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
