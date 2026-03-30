import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { remuxConcatenatedWebmToFile } from "./remuxConcatenatedWebm.js";

/**
 * Merges stored WebM chunks in DB order, **remuxes with ffmpeg** into `recording.webm` (playable in normal players).
 * Chunk 2+ from MediaRecorder are not standalone WebM; raw byte concat is insufficient.
 */
export async function writeMergedLiveSessionWebm(
  db: PrismaClient,
  paths: AppPaths,
  sessionId: string,
): Promise<{ path: string; sizeBytes: number } | null> {
  const chunks = await db.liveVideoChunk.findMany({
    where: { sessionId },
    orderBy: { sequence: "asc" },
  });
  if (chunks.length === 0) {
    return null;
  }

  const buffers: Buffer[] = [];
  for (const c of chunks) {
    buffers.push(await fs.readFile(c.filePath));
  }
  const mergedRaw = Buffer.concat(buffers);

  const sessionDir = paths.liveSessionDir(sessionId);
  const rawPath = path.join(sessionDir, "recording-raw.webm");
  const outPath = path.join(sessionDir, "recording.webm");

  await fs.writeFile(rawPath, mergedRaw);
  try {
    await remuxConcatenatedWebmToFile(rawPath, outPath);
  } finally {
    await fs.unlink(rawPath).catch(() => {});
  }

  const stat = await fs.stat(outPath);
  return { path: outPath, sizeBytes: Number(stat.size) };
}
