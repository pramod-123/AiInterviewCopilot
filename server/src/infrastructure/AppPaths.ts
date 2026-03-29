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

  constructor() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.serverRoot = path.resolve(__dirname, "..", "..");
    this.dataDir = path.join(this.serverRoot, "data");
    this.uploadsDir = path.join(this.dataDir, "uploads");
  }

  jobUploadDir(jobId: string): string {
    return path.join(this.uploadsDir, jobId);
  }

  async ensureDataDirs(): Promise<void> {
    await fs.mkdir(this.uploadsDir, { recursive: true });
  }
}
