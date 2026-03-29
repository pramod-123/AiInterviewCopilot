/** One row in `frames-manifest.json` next to extracted PNGs. */
export type FramesManifestEntry = {
  /** Written PNG basename, e.g. `frame_000001.png`. */
  file: string;
  /** Presentation time of this frame in the cropped video (seconds). */
  timestampSec: number;
  /** Output sequence index (0-based) after extraction / dedupe. */
  sourceFrameIndex: number;
};
