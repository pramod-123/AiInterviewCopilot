import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads markdown (or plain text) prompt files from `server/prompts/`.
 * Works when running from `src` (tsx) or `dist` (compiled): both resolve to the same `server/` root.
 */
export class PromptLoader {
  private readonly promptsDir: string;

  constructor() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverRoot = path.resolve(here, "..", "..");
    this.promptsDir = path.join(serverRoot, "prompts");
  }

  loadSync(filename: string): string {
    const full = path.join(this.promptsDir, filename);
    try {
      return fs.readFileSync(full, "utf-8").trim();
    } catch (err) {
      const hint = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read prompt file "${filename}" at ${full}: ${hint}`, {
        cause: err,
      });
    }
  }
}
