import {
  extractDedupedFramesWithTimestamps,
  type ExtractDedupedFramesOptions,
  type ExtractedFrame,
} from "../../video-pipeline/ffmpegExtract.js";
import type { IDedupedFrameExtractor } from "./IDedupedFrameExtractor.js";

/**
 * {@link IDedupedFrameExtractor} backed by FFmpeg mpdecimate + showinfo (`pts_time` on stderr).
 */
export class FfmpegDedupedFrameExtractor implements IDedupedFrameExtractor {
  extractFrames(options: ExtractDedupedFramesOptions): Promise<ExtractedFrame[]> {
    return extractDedupedFramesWithTimestamps(options);
  }
}
