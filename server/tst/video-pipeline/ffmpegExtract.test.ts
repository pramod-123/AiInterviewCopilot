import { describe, expect, it } from "vitest";
import {
  buildRoiCropEncodeFilter,
  EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX,
} from "../../src/video-pipeline/ffmpegExtract.js";

describe("buildRoiCropEncodeFilter", () => {
  it("chains crop, fixed-width lanczos scale, and yuv420p", () => {
    const vf = buildRoiCropEncodeFilter({ x: 10, y: 20, width: 624, height: 1240 });
    expect(vf).toBe(
      `crop=624:1240:10:20,scale=${EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX}:-2:flags=lanczos,format=yuv420p`,
    );
  });

  it("uses the shared target width constant", () => {
    expect(EDITOR_ROI_POST_CROP_TARGET_WIDTH_PX).toBe(1920);
  });
});
