import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppPaths } from "../../src/infrastructure/AppPaths.js";

describe("AppPaths", () => {
  it("resolves data, uploads, and live-sessions under server root", () => {
    const p = new AppPaths();
    expect(p.dataDir).toBe(path.join(p.serverRoot, "data"));
    expect(p.uploadsDir).toBe(path.join(p.serverRoot, "data", "uploads"));
    expect(p.liveSessionsDir).toBe(path.join(p.serverRoot, "data", "live-sessions"));
  });

  it("jobUploadDir nests job id under uploads", () => {
    const p = new AppPaths();
    expect(p.jobUploadDir("550e8400-e29b-41d4-a716-446655440000")).toBe(
      path.join(p.uploadsDir, "550e8400-e29b-41d4-a716-446655440000"),
    );
  });

  it("liveSessionDir nests session id under live-sessions", () => {
    const p = new AppPaths();
    expect(p.liveSessionDir("abc")).toBe(path.join(p.liveSessionsDir, "abc"));
  });
});
