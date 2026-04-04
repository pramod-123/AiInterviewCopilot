import path from "node:path";
import type { IAppDao } from "../dao/IAppDao.js";
import type { IAppFileStore } from "../dao/file-store/IAppFileStore.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";

/** Merged recording filenames under the session directory (rebuilt on next post-process). */
export const LIVE_SESSION_MERGED_RECORDING_BASENAMES = ["recording.webm", "recording-raw.webm"] as const;

/** `post-process/` directory under a live session root (path strings only). */
export function liveSessionPostProcessArtifactDir(sessionDir: string): string {
  return path.join(sessionDir, "post-process");
}

/**
 * Removes on-disk post-process outputs and merged recording copies for a session.
 * Does not touch the database or chunk/snapshot data.
 */
export async function removeLiveSessionPostProcessArtifactsFromDisk(
  files: IAppFileStore,
  sessionDir: string,
): Promise<void> {
  await files.rm(liveSessionPostProcessArtifactDir(sessionDir), { recursive: true, force: true });
  for (const name of LIVE_SESSION_MERGED_RECORDING_BASENAMES) {
    await files.unlink(path.join(sessionDir, name)).catch(() => {});
  }
}

export type LiveSessionPostProcessResetResult = {
  removedJobCount: number;
};

/**
 * Clears post-process DB state and artifacts for a live session so {@link LiveSessionPostProcessor.run}
 * can run again.
 *
 * - Deletes the {@link Job} linked by `liveSessionId` (cascades InterviewVideo, InterviewAudio,
 *   SpeechUtterance, CodeSnapshot, Result).
 * - Deletes `post-process/` and merged `recording.webm` / `recording-raw.webm` under the session dir.
 * - Sets session `status` to `ACTIVE`.
 *
 * Does **not** delete video chunks or code snapshots.
 */
export class LiveSessionPostProcessReset {
  constructor(
    private readonly db: IAppDao,
    private readonly paths: AppPaths,
    private readonly files: IAppFileStore,
  ) {}

  async reset(sessionId: string): Promise<LiveSessionPostProcessResetResult> {
    const removedJobCount = await this.db.deleteJobsByLiveSessionId(sessionId);
    await removeLiveSessionPostProcessArtifactsFromDisk(this.files, this.paths.liveSessionDir(sessionId));
    await this.db.updateLiveSessionStatus(sessionId, "ACTIVE");
    return { removedJobCount };
  }
}
