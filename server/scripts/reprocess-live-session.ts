/**
 * Re-run live session post-process (merge → WAV → STT → evaluation → artifacts).
 * Runs the same reset as `reset-live-session-post-process.ts`, then processes (even if session is still ACTIVE).
 *
 * Usage (from `server/`): npx tsx scripts/reprocess-live-session.ts <sessionId>
 *
 * Synthetic fixture session id (after `npm run db:seed:synthetic-live-session`):
 *   a0000001-0001-4000-8001-000000000001
 */
import "dotenv/config";
import pino from "pino";
import type { FastifyBaseLogger } from "fastify";
import { appDao, closeAppDatabase, openAppDatabase, runAppTransaction } from "../src/db.js";
import { appFileStore } from "../src/appFileStore.js";
import { AppPaths } from "../src/infrastructure/AppPaths.js";
import { LiveSessionPostProcessReset } from "../src/live-session/LiveSessionPostProcessReset.js";
import { OpenAiLlmClient } from "../src/services/llm/OpenAiLlmClient.js";
import { assertMandatoryInterviewApiConfig } from "../src/services/mandatoryInterviewApiEnv.js";
import { InterviewEvaluationServiceFactory } from "../src/services/evaluation/InterviewEvaluationServiceFactory.js";
import { LiveSessionPostProcessor } from "../src/services/LiveSessionPostProcessor.js";
import { SpeechTranscriptionEvaluationOrchestratorFactory } from "../src/services/SpeechTranscriptionEvaluationOrchestratorFactory.js";
import { SrtGeneratorFactory } from "../src/services/srt-generator/SrtGeneratorFactory.js";

const sessionId = process.argv[2]?.trim();
if (!sessionId) {
  console.error("Usage: npx tsx scripts/reprocess-live-session.ts <liveSessionId>");
  process.exit(1);
}

const log = pino({ level: "info" }) as unknown as FastifyBaseLogger;

await openAppDatabase();

const session = await appDao.getLiveSessionPatch(sessionId);
if (!session) {
  console.error(`No InterviewLiveSession with id ${sessionId}`);
  await closeAppDatabase();
  process.exit(1);
}

const paths = new AppPaths();
const { removedJobCount } = await new LiveSessionPostProcessReset(appDao, paths, appFileStore).reset(
  sessionId,
);
log.info({ sessionId, removedJobCount, sessionStatus: session.status }, "Reset live session post-process before reprocess");

const evaluationFactory = new InterviewEvaluationServiceFactory(process.env, appDao);
const speechAnalysis = new SpeechTranscriptionEvaluationOrchestratorFactory(
  undefined,
  evaluationFactory,
  log,
).create();
const visionOpenAiLlm = OpenAiLlmClient.tryCreate(process.env);
assertMandatoryInterviewApiConfig(speechAnalysis, visionOpenAiLlm);

const processor = new LiveSessionPostProcessor(
  appDao,
  runAppTransaction,
  paths,
  appFileStore,
  speechAnalysis,
  log,
  new SrtGeneratorFactory(paths, log).create(),
);
await processor.run(sessionId, { allowWhileActive: true });
log.info({ sessionId }, "reprocess-live-session finished");
await closeAppDatabase();
