import fs from "node:fs/promises";
import path from "node:path";
import { FfmpegDedupedFrameExtractor } from "../services/video/FfmpegDedupedFrameExtractor.js";
import type { IDedupedFrameExtractor } from "../services/video/IDedupedFrameExtractor.js";
import {
  buildRoiCropEncodeFilter,
  writeFramesManifest,
  type FfmpegRunner,
} from "./ffmpegExtract.js";

export type VideoCropRect = { width: number; height: number; x: number; y: number };

export type VideoPipelineArtifacts = {
  outputDir: string;
  audioWav: string;
  firstFramePng: string;
  /** Cropped ROI video; exported PNGs use FFmpeg mpdecimate + showinfo timestamps. */
  croppedMp4: string;
  framesDir: string;
  frameCount: number;
  framesManifestPath: string;
};

export type VideoProcessingOptions = {
  /**
   * If set, adds an `fps=` filter after mpdecimate (caps output rate; timestamps still come from showinfo).
   */
  extractFps?: number;
  /**
   * If set, adds `-t` after each `-i` on the main file so smoke tests do not process the whole clip.
   */
  maxInputDurationSec?: number;
};

/**
 * Local FFmpeg pipeline: audio extract, first frame, crop to MP4, mpdecimate + showinfo PNGs + manifest.
 * Does not touch the database.
 */
export class VideoProcessingPipeline {
  constructor(
    private readonly inputPath: string,
    private readonly outputDir: string,
    private readonly ffmpeg: FfmpegRunner,
    private readonly crop: VideoCropRect | null,
    private readonly options: VideoProcessingOptions = {},
    private readonly frameExtractor: IDedupedFrameExtractor = new FfmpegDedupedFrameExtractor(),
  ) {}

  async run(): Promise<VideoPipelineArtifacts> {
    await fs.mkdir(this.outputDir, { recursive: true });
    const framesDir = path.join(this.outputDir, "frames");
    await fs.mkdir(framesDir, { recursive: true });

    const audioWav = path.join(this.outputDir, "audio.wav");
    const firstFramePng = path.join(this.outputDir, "first-frame.png");
    const croppedMp4 = path.join(this.outputDir, "video-cropped.mp4");
    const framesManifestPath = path.join(this.outputDir, "frames-manifest.json");

    const dur = this.inputDurationArgs();

    await this.ffmpeg.exec([
      "-i",
      this.inputPath,
      ...dur,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      audioWav,
    ]);

    await this.ffmpeg.exec([
      "-i",
      this.inputPath,
      ...dur,
      "-frames:v",
      "1",
      "-update",
      "1",
      firstFramePng,
    ]);

    const vfCrop = this.buildCropFilterChain();
    await this.ffmpeg.exec([
      "-i",
      this.inputPath,
      ...dur,
      "-vf",
      vfCrop,
      "-an",
      croppedMp4,
    ]);

    for (const f of await fs.readdir(framesDir).catch(() => [])) {
      if (f.endsWith(".png")) {
        await fs.unlink(path.join(framesDir, f));
      }
    }

    const fps =
      this.options.extractFps != null && this.options.extractFps > 0
        ? this.options.extractFps
        : undefined;

    const extracted = await this.frameExtractor.extractFrames({
      inputVideo: croppedMp4,
      outputDir: framesDir,
      fps,
    });
    await writeFramesManifest(framesManifestPath, extracted);
    console.info(
      `[video-pipeline] Frames: ${extracted.length} (mpdecimate + showinfo${fps != null ? `, fps=${fps}` : ""})`,
    );

    const frameFiles = (await fs.readdir(framesDir)).filter((f) => f.endsWith(".png"));
    return {
      outputDir: this.outputDir,
      audioWav,
      firstFramePng,
      croppedMp4,
      framesDir,
      frameCount: frameFiles.length,
      framesManifestPath,
    };
  }

  private buildCropFilterChain(): string {
    if (this.crop) {
      return buildRoiCropEncodeFilter(this.crop);
    }
    return "format=yuv420p";
  }

  private inputDurationArgs(): string[] {
    const t = this.options.maxInputDurationSec;
    if (t == null || !Number.isFinite(t) || t <= 0) {
      return [];
    }
    return ["-t", String(t)];
  }
}
