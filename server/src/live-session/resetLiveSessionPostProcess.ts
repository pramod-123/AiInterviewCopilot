import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { AppPaths } from "../infrastructure/AppPaths.js";

/**
 * Removes post-process database rows and on-disk outputs for a live session so
 * {@link LiveSessionPostProcessor.run} can run again from scratch.
 *
 * - Deletes the {@link Job} linked by `liveSessionId` (cascades InterviewVideo, InterviewAudio,
 *   TranscriptSegment, Result).
 * - Deletes `post-process/` under the session dir.
 * - Deletes merged `recording.webm` / temp `recording-raw.webm` (rebuilt on next process run).
 *
 * Does **not** delete video chunks or code snapshots.
 */
export async function resetLiveSessionPostProcess(
  db: PrismaClient,
  paths: AppPaths,
  sessionId: string,
): Promise<{ removedJobCount: number }> {
  const del = await db.job.deleteMany({ where: { liveSessionId: sessionId } });
  const sessionDir = paths.liveSessionDir(sessionId);
  const postProcessDir = path.join(sessionDir, "post-process");
  await fs.rm(postProcessDir, { recursive: true, force: true });
  for (const name of ["recording.webm", "recording-raw.webm"] as const) {
    await fs.unlink(path.join(sessionDir, name)).catch(() => {});
  }
  return { removedJobCount: del.count };
}
