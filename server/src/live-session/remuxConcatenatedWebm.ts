import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * MediaRecorder `timeslice` chunks: only the first blob is a full WebM; the rest are continuations.
 * Naive byte concat is not reliably playable. FFmpeg remux rebuilds timestamps / structure for decoders.
 */
export async function remuxConcatenatedWebmToFile(
  rawWebmPath: string,
  outputWebmPath: string,
): Promise<void> {
  const probe = ["-probesize", "100M", "-analyzeduration", "100M"];
  const base = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    ...probe,
    "-i",
    rawWebmPath,
  ];
  const copyArgs = [...base, "-map", "0", "-c", "copy", outputWebmPath];
  try {
    await execFileAsync("ffmpeg", copyArgs, { maxBuffer: 64 * 1024 * 1024 });
    return;
  } catch {
    /* stream copy often fails on fragmented concat; re-encode */
  }

  const encArgs = [
    ...base,
    "-map",
    "0",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "35",
    "-b:v",
    "0",
    "-row-mt",
    "1",
    "-cpu-used",
    "2",
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    outputWebmPath,
  ];
  await execFileAsync("ffmpeg", encArgs, { maxBuffer: 64 * 1024 * 1024 });
}

async function concatChunkFilesToBuffer(chunkFilePaths: readonly string[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const p of chunkFilePaths) {
    parts.push(await fs.readFile(p));
  }
  return Buffer.concat(parts);
}

/**
 * Concatenates chunk files in order, remuxes with ffmpeg, returns playable WebM bytes (temp files cleaned up).
 */
export async function mergeLiveSessionChunksToPlayableWebmBuffer(
  chunkFilePaths: readonly string[],
): Promise<Buffer> {
  if (chunkFilePaths.length === 0) {
    throw new Error("mergeLiveSessionChunksToPlayableWebmBuffer: no chunks");
  }
  const id = randomBytes(8).toString("hex");
  const rawPath = path.join(os.tmpdir(), `aic-live-raw-${id}.webm`);
  const outPath = path.join(os.tmpdir(), `aic-live-out-${id}.webm`);
  try {
    await fs.writeFile(rawPath, await concatChunkFilesToBuffer(chunkFilePaths));
    await remuxConcatenatedWebmToFile(rawPath, outPath);
    return await fs.readFile(outPath);
  } finally {
    await fs.unlink(rawPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}
