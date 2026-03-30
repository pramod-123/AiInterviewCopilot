/**
 * Delete live-session post-process Job + DB cascades and wipe `post-process/` + merged recording files.
 * Does not remove chunks or code snapshots.
 *
 * Usage (from `server/`): npx tsx scripts/reset-live-session-post-process.ts <liveSessionId>
 */
import "dotenv/config";
import pino from "pino";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../src/db.js";
import { AppPaths } from "../src/infrastructure/AppPaths.js";
import { resetLiveSessionPostProcess } from "../src/live-session/resetLiveSessionPostProcess.js";

const sessionId = process.argv[2]?.trim();
if (!sessionId) {
  console.error("Usage: npx tsx scripts/reset-live-session-post-process.ts <liveSessionId>");
  process.exit(1);
}

const log = pino({ level: "info" }) as unknown as FastifyBaseLogger;

await prisma.$connect();
await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 30000");

const session = await prisma.interviewLiveSession.findUnique({
  where: { id: sessionId },
  select: { id: true },
});
if (!session) {
  console.error(`No InterviewLiveSession with id ${sessionId}`);
  await prisma.$disconnect();
  process.exit(1);
}

const paths = new AppPaths();
const { removedJobCount } = await resetLiveSessionPostProcess(prisma, paths, sessionId);
log.info({ sessionId, removedJobCount }, "Live session post-process reset (DB + artifacts)");
await prisma.$disconnect();
