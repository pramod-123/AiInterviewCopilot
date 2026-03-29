import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs the `tesseract` CLI (must be on PATH). English by default.
 */
export class TesseractRunner {
  constructor(private readonly lang: string = "eng") {}

  async ocrPng(imagePath: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "-l", this.lang, "--dpi", "300"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim();
  }
}

export async function assertTesseractOnPath(): Promise<void> {
  try {
    await execFileAsync("tesseract", ["--version"], { maxBuffer: 65536 });
  } catch {
    throw new Error(
      "tesseract not found on PATH. Install it (e.g. `brew install tesseract`) for OCR in the e2e pipeline.",
    );
  }
}
