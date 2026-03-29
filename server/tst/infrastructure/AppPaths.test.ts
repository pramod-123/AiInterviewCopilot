import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppPaths } from "../../src/infrastructure/AppPaths.js";

describe("AppPaths", () => {
  it("resolves data and uploads under server root", () => {
    const p = new AppPaths();
    expect(p.dataDir).toBe(path.join(p.serverRoot, "data"));
    expect(p.uploadsDir).toBe(path.join(p.serverRoot, "data", "uploads"));
  });

  it("jobUploadDir nests job id under uploads", () => {
    const p = new AppPaths();
    expect(p.jobUploadDir("550e8400-e29b-41d4-a716-446655440000")).toBe(
      path.join(p.uploadsDir, "550e8400-e29b-41d4-a716-446655440000"),
    );
  });
});
