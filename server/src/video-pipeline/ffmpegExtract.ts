import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FramesManifestEntry } from "../types/framesManifest.js";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `ffmpeg` CLI (must be on PATH).
 */
export class FfmpegRunner {
  exec(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
        stdio: "inherit",
        shell: false,
      });
      child.on("error", (err) => {
        reject(
          err instanceof Error
            ? err
            : new Error("Failed to spawn ffmpeg. Is it installed and on PATH?"),
        );
      });
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
          ),
        );
      });
    });
  }
}

/** Container / stream duration in seconds (best effort; 0 if unknown). */
export async function ffprobeFormatDurationSec(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const n = Number(String(stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** First video stream width×height as FFmpeg sees it (may differ from a PNG frame export when rotation/SAR differs). */
export async function ffprobeVideoStreamDimensions(
  videoPath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        videoPath,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const line = String(stdout).trim();
    const parts = line.split(",");
    if (parts.length < 2) {
      return null;
    }
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

export type ExtractedFrame = {
  index: number;
  file: string;
  timestampSeconds: number;
};

export type ExtractDedupedFramesOptions = {
  inputVideo: string;
  outputDir: string;
  crop?: string;
  scale?: string;
  fps?: number;
  maxDurationSec?: number;
  ffmpegPath?: string;
};

/**
 * FFmpeg: optional crop → gray → optional scale → mpdecimate → optional fps → showinfo,
 * `-vsync vfr`, PNG sequence; `pts_time` parsed from stderr.
 */
export async function extractDedupedFramesWithTimestamps(
  options: ExtractDedupedFramesOptions,
): Promise<ExtractedFrame[]> {
  const {
    inputVideo,
    outputDir,
    crop,
    scale,
    fps,
    maxDurationSec,
    ffmpegPath = "ffmpeg",
  } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const filters: string[] = [];
  if (crop) filters.push(`crop=${crop}`);
  filters.push("format=gray");
  if (scale) filters.push(`scale=${scale}`);
  filters.push("mpdecimate");
  if (fps != null && fps > 0) filters.push(`fps=${fps}`);
  filters.push("showinfo");

  const outputPattern = path.join(outputDir, "frame_%06d.png");

  const args: string[] = ["-hide_banner", "-loglevel", "info", "-y"];
  if (maxDurationSec != null && Number.isFinite(maxDurationSec) && maxDurationSec > 0) {
    args.push("-t", String(maxDurationSec));
  }
  args.push("-i", inputVideo, "-vf", filters.join(","), "-vsync", "vfr", outputPattern);

  return new Promise<ExtractedFrame[]>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderrBuffer = "";
    const timestamps: number[] = [];

    child.stderr.setEncoding("utf8");

    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.includes("showinfo")) continue;
        const match = line.match(/\bpts_time:([0-9.+-eE]+)/);
        if (match) {
          const timestamp = Number(match[1]);
          if (!Number.isNaN(timestamp)) {
            timestamps.push(timestamp);
          }
        }
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }

      try {
        const files = (await fs.readdir(outputDir))
          .filter((name) => /^frame_\d{6}\.png$/.test(name))
          .sort();

        if (files.length !== timestamps.length) {
          reject(
            new Error(
              `Mismatch between saved frames (${files.length}) and parsed timestamps (${timestamps.length}).`,
            ),
          );
          return;
        }

        const result: ExtractedFrame[] = files.map((file, i) => ({
          index: i + 1,
          file: path.join(outputDir, file),
          timestampSeconds: timestamps[i]!,
        }));

        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function extractedFramesToManifest(frames: ExtractedFrame[]): FramesManifestEntry[] {
  return frames.map((f, i) => ({
    file: path.basename(f.file),
    timestampSec: f.timestampSeconds,
    sourceFrameIndex: i,
  }));
}

export async function writeFramesManifest(
  manifestPath: string,
  frames: ExtractedFrame[],
): Promise<FramesManifestEntry[]> {
  const manifest = extractedFramesToManifest(frames);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

// --- ROI encode: crop → scale → yuv420p -------------------------------------

export type RoiCropRect = { x: number; y: number; width: number; height: number };

/** Fixed width after ROI crop (PNG frames inherit this size). Height keeps aspect; lanczos. */
export const EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX = 1920;

/** `crop` → `scale` → `format=yuv420p` for ROI MP4 + downstream frames. */
export function buildRoiCropEncodeFilter(crop: RoiCropRect): string {
  return [
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    `scale=${EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX}:-2:flags=lanczos`,
    "format=yuv420p",
  ].join(",");
}
