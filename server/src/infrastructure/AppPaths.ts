import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved filesystem locations for local data and uploads.
 */
export class AppPaths {
  readonly serverRoot: string;
  readonly dataDir: string;
  readonly uploadsDir: string;
  readonly liveSessionsDir: string;

  constructor() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.serverRoot = path.resolve(__dirname, "..", "..");
    this.dataDir = path.join(this.serverRoot, "data");
    this.uploadsDir = path.join(this.dataDir, "uploads");
    this.liveSessionsDir = path.join(this.dataDir, "live-sessions");
  }

  jobUploadDir(jobId: string): string {
    return path.join(this.uploadsDir, jobId);
  }

  liveSessionDir(sessionId: string): string {
    return path.join(this.liveSessionsDir, sessionId);
  }

  async ensureDataDirs(): Promise<void> {
    await fs.mkdir(this.uploadsDir, { recursive: true });
    await fs.mkdir(this.liveSessionsDir, { recursive: true });
  }
}
