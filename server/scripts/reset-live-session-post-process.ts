/**
 * Delete live-session post-process Job + DB cascades and wipe `post-process/` + merged recording files.
 * Sets session status to ACTIVE (so you can POST …/end again). Does not remove chunks or code snapshots.
 *
 * Usage (from `server/`): npx tsx scripts/reset-live-session-post-process.ts <liveSessionId>
 *
 * Synthetic seeded session: a0000001-0001-4000-8001-000000000001
 */
import "dotenv/config";
import pino from "pino";
import type { FastifyBaseLogger } from "fastify";
import { appDao, closeAppDatabase, openAppDatabase } from "../src/db.js";
import { appFileStore } from "../src/appFileStore.js";
import { AppPaths } from "../src/infrastructure/AppPaths.js";
import { LiveSessionPostProcessReset } from "../src/live-session/LiveSessionPostProcessReset.js";

const sessionId = process.argv[2]?.trim();
if (!sessionId) {
  console.error("Usage: npx tsx scripts/reset-live-session-post-process.ts <liveSessionId>");
  process.exit(1);
}

const log = pino({ level: "info" }) as unknown as FastifyBaseLogger;

await openAppDatabase();

const session = await appDao.findLiveSessionIdForTools(sessionId);
if (!session) {
  console.error(`No InterviewLiveSession with id ${sessionId}`);
  await closeAppDatabase();
  process.exit(1);
}

const paths = new AppPaths();
const { removedJobCount } = await new LiveSessionPostProcessReset(appDao, paths, appFileStore).reset(
  sessionId,
);
log.info({ sessionId, removedJobCount }, "Live session post-process reset (DB + artifacts)");
await closeAppDatabase();
