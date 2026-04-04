import path from "node:path";
import type { IAppDao } from "../dao/IAppDao.js";
import type { IAppFileStore } from "../dao/file-store/IAppFileStore.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { remuxConcatenatedWebmToFile } from "./remuxConcatenatedWebm.js";

/**
 * Merges stored WebM chunks in DB order, **remuxes with ffmpeg** into `recording.webm` (playable in normal players).
 * Chunk 2+ from MediaRecorder are not standalone WebM; raw byte concat is insufficient.
 */
export async function writeMergedLiveSessionWebm(
  db: IAppDao,
  files: IAppFileStore,
  paths: AppPaths,
  sessionId: string,
): Promise<{ path: string; sizeBytes: number } | null> {
  const chunks = await db.findLiveVideoChunksOrdered(sessionId);
  if (chunks.length === 0) {
    return null;
  }

  const sessionDir = paths.liveSessionDir(sessionId);
  const outPath = path.join(sessionDir, "recording.webm");

  /**
   * One full recording file (e.g. synthetic fixture MP4). FFmpeg probes by content; the `.webm`
   * name is the contract for the rest of the pipeline. Avoids WebM chunk remux and heavy re-encode.
   */
  if (chunks.length === 1) {
    await files.mkdir(sessionDir, { recursive: true });
    await files.copyFile(chunks[0]!.filePath, outPath);
    const stat = await files.stat(outPath);
    return { path: outPath, sizeBytes: Number(stat.size) };
  }

  const buffers: Buffer[] = [];
  for (const c of chunks) {
    buffers.push(await files.readFile(c.filePath));
  }
  const mergedRaw = Buffer.concat(buffers);

  const rawPath = path.join(sessionDir, "recording-raw.webm");
  await files.mkdir(sessionDir, { recursive: true });
  await files.writeFile(rawPath, mergedRaw);
  try {
    await remuxConcatenatedWebmToFile(rawPath, outPath);
  } finally {
    await files.unlink(rawPath).catch(() => {});
  }

  const stat = await files.stat(outPath);
  return { path: outPath, sizeBytes: Number(stat.size) };
}
