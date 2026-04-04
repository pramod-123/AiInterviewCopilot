/**
 * Idempotently seeds a fixed {@link InterviewLiveSession} + one video chunk + editor code snapshots
 * aligned to fixtures/synthetic/longest-substring-interview-timeline.json.
 *
 * Prereq: generated MP4 from `npm run fixture:video:longest-substring`.
 *
 * After seeding, run post-process when you want STT + evaluation:
 *   npx tsx scripts/reprocess-live-session.ts a0000001-0001-4000-8001-000000000001
 *
 * Or reset then reprocess:
 *   npx tsx scripts/reset-live-session-post-process.ts a0000001-0001-4000-8001-000000000001
 *   npx tsx scripts/reprocess-live-session.ts a0000001-0001-4000-8001-000000000001
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appDao, closeAppDatabase, openAppDatabase } from "../src/db.js";
import { AppPaths } from "../src/infrastructure/AppPaths.js";
import { SYNTHETIC_LONGEST_SUBSTRING_LIVE_SESSION_ID } from "../src/fixtures/syntheticLongestSubstringLiveSession.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..");
const TIMELINE_JSON = join(SERVER_ROOT, "fixtures/synthetic/longest-substring-interview-timeline.json");
const PROBLEM_TXT = join(SERVER_ROOT, "fixtures/synthetic/longest-substring-problem-panel.txt");
const SYNTHETIC_MP4 = join(
  SERVER_ROOT,
  "fixtures/synthetic/generated/longest-substring-interview-synthetic.mp4",
);

type Interval = { start: number; end: number; speech: string; frameData: string[] };

async function main(): Promise<void> {
  try {
    await fs.access(SYNTHETIC_MP4);
  } catch {
    console.error(
      `Missing ${SYNTHETIC_MP4}\nRun first: cd server && npm run fixture:video:longest-substring`,
    );
    process.exit(1);
  }
  const timeline = JSON.parse(await fs.readFile(TIMELINE_JSON, "utf8")) as Interval[];
  const question = await fs.readFile(PROBLEM_TXT, "utf8");
  const stat = await fs.stat(SYNTHETIC_MP4);
  const paths = new AppPaths();
  const sessionId = SYNTHETIC_LONGEST_SUBSTRING_LIVE_SESSION_ID;
  const sessionDir = paths.liveSessionDir(sessionId);
  const chunkDir = join(sessionDir, "video-chunks");
  const chunkPath = join(chunkDir, "synthetic-longest-substring.mp4");

  await openAppDatabase();

  await appDao.deleteJobsByLiveSessionId(sessionId);
  await appDao.deleteLiveSessionById(sessionId);

  await fs.mkdir(chunkDir, { recursive: true });
  await fs.copyFile(SYNTHETIC_MP4, chunkPath);

  const now = new Date();
  await appDao.createLiveSessionWithChunksAndSnapshots({
    id: sessionId,
    status: "ENDED",
    liveInterviewerEnabled: false,
    question: question.trim(),
    videoChunks: [
      {
        sequence: 0,
        filePath: chunkPath,
        mimeType: "video/mp4",
        sizeBytes: Number(stat.size),
      },
    ],
    codeSnapshots: timeline.map((row, i) => {
      const code =
        row.frameData.length > 0 ? row.frameData[row.frameData.length - 1]! : "// (empty)";
      return {
        sequence: i,
        code,
        offsetSeconds: row.start / 1000,
        capturedAt: new Date(now.getTime() + i * 1000),
      };
    }),
  });

  await closeAppDatabase();

  console.log("Synthetic live session seeded.");
  console.log(`  sessionId: ${sessionId}`);
  console.log(`  video:     ${chunkPath}`);
  console.log(`  snapshots: ${timeline.length} (timeline intervals)`);
  console.log("");
  console.log("Run post-process (needs API keys / ffmpeg):");
  console.log(`  npx tsx scripts/reprocess-live-session.ts ${sessionId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
