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

  /** JSON file for API keys and models editable from the extension UI (overrides `.env` when set). */
  runtimeAppConfigPath(): string {
    return path.join(this.dataDir, "app-runtime-config.json");
  }

  /** Built-in preset option lists when the runtime file omits an array (shipped with the server). */
  runtimeAppConfigDefaultsPath(): string {
    return path.join(this.dataDir, "app-runtime-config.defaults.json");
  }
}
