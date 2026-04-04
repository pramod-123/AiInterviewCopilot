/**
 * Smoke-test {@link SingleAgentInterviewEvaluator} with a real DB job + LLM (no HTTP server).
 *
 * Prereqs: `.env` with `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, `EVALUATION_PROVIDER` matching.
 * Optional: `EVALUATION_USE_LANGCHAIN_AGENT` is ignored here — this script always uses the single-agent evaluator.
 * Tool-call trace (model thought + tool + observation preview) is always enabled (`logAgentToolSteps`).
 * Full LLM input logging (`logCompleteEvaluationInput`) is always enabled; the agent user turn is ids-only (transcript/problem/code via tools).
 *
 * Usage (from `server/`):
 *   npx tsx scripts/test-single-agent-evaluator.ts                                    # auto-pick richest job
 *   npx tsx scripts/test-single-agent-evaluator.ts <jobId | liveSessionId>            # job id, or session id (if no job has that primary key)
 *   npx tsx scripts/test-single-agent-evaluator.ts --session <liveSessionId>        # explicit live session
 */
import "dotenv/config";
import { PromptLoader } from "../src/prompts/PromptLoader.js";
import { appDao, closeAppDatabase, openAppDatabase } from "../src/db.js";
import { LlmClientFactory } from "../src/services/llm/LlmClientFactory.js";
import { loadInterviewEvaluationInputForJob } from "../src/services/evaluation/loadInterviewEvaluationInputForJob.js";
import { SingleAgentInterviewEvaluator } from "../src/services/evaluation/SingleAgentInterviewEvaluator.js";

const SYSTEM_PROMPT_FILE = "interview-evaluation-system.md";
const USER_PROMPT_FILE = "interview-evaluation-user.md";

function iterationsFromEnv(): number {
  const raw = process.env.EVALUATION_AGENT_MAX_ITERATIONS?.trim();
  if (!raw) {
    return 24;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return 24;
  }
  return Math.min(n, 64);
}

/**
 * Prefer jobs linked to a live session with the most speech utterances, then the most editor snapshots.
 */
async function pickJobWithRichestData(): Promise<{
  jobId: string;
  utteranceCount: number;
  liveCodeSnapshotCount: number;
} | null> {
  const candidates = await appDao.findJobsLinkedToLiveSessionsWithUtteranceCounts();
  if (candidates.length === 0) {
    return null;
  }
  const sessionIds = [...new Set(candidates.map((c) => c.liveSessionId))];
  const grouped = await appDao.countLiveCodeSnapshotsBySessionIds(sessionIds);
  const snapsBySession = new Map(grouped.map((g) => [g.sessionId, g.count]));

  let best: {
    jobId: string;
    utteranceCount: number;
    liveCodeSnapshotCount: number;
  } | null = null;
  for (const c of candidates) {
    const u = c.speechUtteranceCount;
    const snaps = snapsBySession.get(c.liveSessionId) ?? 0;
    if (
      !best ||
      u > best.utteranceCount ||
      (u === best.utteranceCount && snaps > best.liveCodeSnapshotCount)
    ) {
      best = { jobId: c.id, utteranceCount: u, liveCodeSnapshotCount: snaps };
    }
  }
  return best;
}

function parseCli(): { sessionId: string | null; jobOrSessionToken: string | null } {
  const raw = process.argv.slice(2);
  const sessionIdx = raw.findIndex((a) => a === "--session");
  if (sessionIdx >= 0 && raw[sessionIdx + 1]?.trim()) {
    return { sessionId: raw[sessionIdx + 1]!.trim(), jobOrSessionToken: null };
  }
  const positional = raw.filter((a) => !a.startsWith("-"))[0]?.trim() ?? null;
  return { sessionId: null, jobOrSessionToken: positional };
}

async function main(): Promise<void> {
  const { sessionId: explicitSessionId, jobOrSessionToken } = parseCli();
  let jobId: string | null = null;
  let pickMeta: { utteranceCount: number; liveCodeSnapshotCount: number; autoPicked: boolean } | null =
    null;
  let resolvedViaSession = false;

  await openAppDatabase();

  if (explicitSessionId) {
    const jid = await appDao.findFirstJobIdByLiveSessionId(explicitSessionId);
    if (!jid) {
      console.error(`No Job with liveSessionId ${explicitSessionId}`);
      await closeAppDatabase();
      process.exit(1);
    }
    jobId = jid;
    resolvedViaSession = true;
  } else if (jobOrSessionToken) {
    const byJobId = await appDao.findJobIdIfExists(jobOrSessionToken);
    if (byJobId) {
      jobId = byJobId;
    } else {
      const bySession = await appDao.findFirstJobIdByLiveSessionId(jobOrSessionToken);
      if (bySession) {
        jobId = bySession;
        resolvedViaSession = true;
      }
    }
    if (!jobId) {
      console.error(
        `No Job with id ${jobOrSessionToken}, and no Job with liveSessionId ${jobOrSessionToken}.`,
      );
      await closeAppDatabase();
      process.exit(1);
    }
  }

  if (!jobId) {
    const picked = await pickJobWithRichestData();
    if (!picked) {
      console.error("No Job with liveSessionId in the database. Create/post-process a live session first.");
      await closeAppDatabase();
      process.exit(1);
    }
    jobId = picked.jobId;
    pickMeta = {
      utteranceCount: picked.utteranceCount,
      liveCodeSnapshotCount: picked.liveCodeSnapshotCount,
      autoPicked: true,
    };
    console.log(
      JSON.stringify(
        {
          autoPickedJob: true,
          jobId,
          reason: "Most speech utterances for a live-session job, tie-break by live code snapshot count",
          utteranceCount: picked.utteranceCount,
          liveCodeSnapshotCount: picked.liveCodeSnapshotCount,
        },
        null,
        2,
      ),
    );
  }

  if (explicitSessionId) {
    console.log(JSON.stringify({ resolvedFromSessionId: explicitSessionId, jobId }, null, 2));
  } else if (resolvedViaSession && jobOrSessionToken) {
    console.log(JSON.stringify({ resolvedFromLiveSessionId: jobOrSessionToken, jobId }, null, 2));
  }

  const providerRaw = process.env.EVALUATION_PROVIDER?.toLowerCase().trim() ?? "openai";
  const llm = LlmClientFactory.tryCreate(process.env);

  if (!llm) {
    console.error(
      `No LLM client for EVALUATION_PROVIDER=${providerRaw}. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`,
    );
    await closeAppDatabase();
    process.exit(1);
  }

  try {
    const job = await appDao.findJobLiveSessionId(jobId!);
    if (!job) {
      console.error(`No Job with id ${jobId}`);
      process.exit(1);
    }
    if (!job.liveSessionId) {
      console.error(`Job ${jobId} has no liveSessionId (single-agent evaluator requires a live session).`);
      process.exit(1);
    }

    const loadedPreview = await loadInterviewEvaluationInputForJob(appDao, jobId);
    const utteranceCountDb = await appDao.countSpeechUtterancesForJob(jobId);

    const loader = new PromptLoader();
    const evalTemperature = (() => {
      const raw = process.env.LLM_EVAL_TEMPERATURE?.trim();
      if (!raw) {
        return 0.4;
      }
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0.4;
    })();

    const evaluator = new SingleAgentInterviewEvaluator(llm, appDao, {
      provider: llm.getProviderId(),
      loadPrompts: () => ({
        systemPrompt: loader.loadSync(SYSTEM_PROMPT_FILE),
        userPromptTemplate: loader.loadSync(USER_PROMPT_FILE),
      }),
      evaluationTemperature: evalTemperature,
      logAgentToolSteps: true,
      logCompleteEvaluationInput: true,
    }, iterationsFromEnv());

    let timelineIntervalCount = 0;
    let problemStatementChars = 0;
    if (loadedPreview.ok) {
      const timelineJson = loadedPreview.input.interviewTimelineJson ?? "";
      try {
        timelineIntervalCount = JSON.parse(timelineJson).length;
      } catch {
        /* ignore */
      }
      problemStatementChars = loadedPreview.input.problemStatementText?.length ?? 0;
    } else {
      const session = await appDao.getLiveSessionQuestionText(job.liveSessionId);
      problemStatementChars = session?.question?.trim().length ?? 0;
    }

    const sessionSnaps = await appDao.countLiveCodeSnapshotsForSession(job.liveSessionId);
    console.log(
      JSON.stringify(
        {
          jobId,
          liveSessionId: job.liveSessionId,
          speechUtteranceRowCount: utteranceCountDb,
          utteranceCountInPreview: loadedPreview.ok ? loadedPreview.input.segments.length : null,
          liveCodeSnapshotCount: sessionSnaps,
          interviewTimelineIntervalCount: timelineIntervalCount,
          problemStatementChars,
          loadInterviewEvaluationInputOk: loadedPreview.ok,
          ...(loadedPreview.ok ? {} : { loadInterviewEvaluationInputError: loadedPreview.errorMessage }),
          autoPicked: pickMeta?.autoPicked ?? false,
          provider: llm.getProviderId(),
          model: llm.getModelId(),
          maxIterations: iterationsFromEnv(),
        },
        null,
        2,
      ),
    );
    console.log("Calling SingleAgentInterviewEvaluator.evaluate({ jobId })…");

    const result = await evaluator.evaluate({ jobId });

    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "complete") {
      process.exit(1);
    }
  } finally {
    await closeAppDatabase();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
