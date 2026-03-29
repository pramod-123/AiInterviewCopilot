import type {
  ExtractDedupedFramesOptions,
  ExtractedFrame,
} from "../../video-pipeline/ffmpegExtract.js";

/**
 * Extracts visually deduped video frames with presentation timestamps (e.g. FFmpeg mpdecimate + showinfo).
 */
export interface IDedupedFrameExtractor {
  extractFrames(options: ExtractDedupedFramesOptions): Promise<ExtractedFrame[]>;
}
