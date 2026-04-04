import type { AppPaths } from "../../infrastructure/AppPaths.js";
import type { IAppFileStore } from "./IAppFileStore.js";

/** Ensures `uploads/` and `live-sessions/` roots exist under the app data directory. */
export async function ensureInterviewDataLayout(
  files: IAppFileStore,
  paths: AppPaths,
): Promise<void> {
  await files.mkdir(paths.uploadsDir, { recursive: true });
  await files.mkdir(paths.liveSessionsDir, { recursive: true });
}
