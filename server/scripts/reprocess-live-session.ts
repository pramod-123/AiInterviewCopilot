/**
 * Re-run live session post-process (merge → WAV → STT → evaluation → artifacts).
 * Runs the same reset as `reset-live-session-post-process.ts`, then processes (even if session is still ACTIVE).
 *
 * Usage (from `server/`): npx tsx scripts/reprocess-live-session.ts <sessionId>
 */
import "dotenv/config";
import pino from "pino";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../src/db.js";
import { AppPaths } from "../src/infrastructure/AppPaths.js";
import { resetLiveSessionPostProcess } from "../src/live-session/resetLiveSessionPostProcess.js";
import { LlmClientFactory } from "../src/services/llm/LlmClientFactory.js";
import { assertMandatoryInterviewApiConfig } from "../src/services/mandatoryInterviewApiEnv.js";
import { LiveSessionPostProcessor } from "../src/services/LiveSessionPostProcessor.js";
import { SpeechTranscriptionEvaluationOrchestratorFactory } from "../src/services/SpeechTranscriptionEvaluationOrchestratorFactory.js";

const sessionId = process.argv[2]?.trim();
if (!sessionId) {
  console.error("Usage: npx tsx scripts/reprocess-live-session.ts <liveSessionId>");
  process.exit(1);
}

const log = pino({ level: "info" }) as unknown as FastifyBaseLogger;

await prisma.$connect();
await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 30000");

const session = await prisma.interviewLiveSession.findUnique({
  where: { id: sessionId },
  select: { id: true, status: true },
});
if (!session) {
  console.error(`No InterviewLiveSession with id ${sessionId}`);
  await prisma.$disconnect();
  process.exit(1);
}

const paths = new AppPaths();
const { removedJobCount } = await resetLiveSessionPostProcess(prisma, paths, sessionId);
log.info({ sessionId, removedJobCount, sessionStatus: session.status }, "Reset live session post-process before reprocess");

const speechAnalysis = new SpeechTranscriptionEvaluationOrchestratorFactory(
  undefined,
  undefined,
  log,
).createOrThrow();
const visionOpenAiLlm = LlmClientFactory.tryCreate("openai", process.env);
assertMandatoryInterviewApiConfig(speechAnalysis, visionOpenAiLlm);

const processor = new LiveSessionPostProcessor(prisma, paths, speechAnalysis, log);
await processor.run(sessionId, { allowWhileActive: true });
log.info({ sessionId }, "reprocess-live-session finished");
await prisma.$disconnect();
