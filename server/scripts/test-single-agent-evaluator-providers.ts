/**
 * Real (non-mock) integration: run {@link SingleAgentInterviewEvaluator} against **OpenAI, Anthropic,
 * Gemini, and Ollama** in sequence, using your `.env` API keys (Ollama: no key). Same DB + tools as
 * `test-single-agent-evaluator.ts`; only `LLM_PROVIDER` and the per-provider client differ per run.
 *
 * Prereqs: `server/.env` (or env) with keys/models for any provider you want to exercise:
 *   - openai:  OPENAI_API_KEY,  OPENAI_MODEL_ID
 *   - anthropic: ANTHROPIC_API_KEY, ANTHROPIC_MODEL_ID
 *   - gemini:  GEMINI_API_KEY,  GEMINI_MODEL_ID
 *   - ollama:  OLLAMA_MODEL_ID, optional OLLAMA_BASE_URL (default http://127.0.0.1:11434)
 * Providers with missing key/model are **skipped** (logged); at least one must run or the script exits 1.
 *
 * Usage (from `server/`):
 *   npx tsx scripts/test-single-agent-evaluator-providers.ts
 *   npx tsx scripts/test-single-agent-evaluator-providers.ts <jobId|liveSessionId>
 *   npx tsx scripts/test-single-agent-evaluator-providers.ts --session <liveSessionId>
 *   npx tsx scripts/test-single-agent-evaluator-providers.ts --only openai
 *   npx tsx scripts/test-single-agent-evaluator-providers.ts --only ollama
 */
import "dotenv/config";
import { PromptLoader } from "../src/prompts/PromptLoader.js";
import { appDao, closeAppDatabase, openAppDatabase } from "../src/db.js";
import { LlmClientFactory } from "../src/services/llm/LlmClientFactory.js";
import { loadInterviewEvaluationInputForJob } from "../src/services/evaluation/loadInterviewEvaluationInputForJob.js";
import { SingleAgentInterviewEvaluator } from "../src/services/evaluation/SingleAgentInterviewEvaluator.js";
import type { LlmClient } from "../src/services/llm/LlmClient.js";

const SYSTEM_PROMPT_FILE = "interview-evaluation-system.md";
const USER_PROMPT_FILE = "interview-evaluation-user.md";

const PROVIDERS = [
  {
    id: "openai" as const,
    label: "openai",
    isConfigured: (e: NodeJS.ProcessEnv) => Boolean(e.OPENAI_API_KEY?.trim() && e.OPENAI_MODEL_ID?.trim()),
    hint: "set OPENAI_API_KEY and OPENAI_MODEL_ID",
  },
  {
    id: "anthropic" as const,
    label: "anthropic",
    isConfigured: (e: NodeJS.ProcessEnv) => Boolean(
      e.ANTHROPIC_API_KEY?.trim() && e.ANTHROPIC_MODEL_ID?.trim(),
    ),
    hint: "set ANTHROPIC_API_KEY and ANTHROPIC_MODEL_ID",
  },
  {
    id: "gemini" as const,
    label: "gemini",
    isConfigured: (e: NodeJS.ProcessEnv) => Boolean(e.GEMINI_API_KEY?.trim() && e.GEMINI_MODEL_ID?.trim()),
    hint: "set GEMINI_API_KEY and GEMINI_MODEL_ID",
  },
  {
    id: "ollama" as const,
    label: "ollama",
    isConfigured: (e: NodeJS.ProcessEnv) => Boolean(e.OLLAMA_MODEL_ID?.trim()),
    hint: "set OLLAMA_MODEL_ID (optional OLLAMA_BASE_URL; Ollama must be running)",
  },
] as const;

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

function parseCli(): {
  sessionId: string | null;
  jobOrSessionToken: string | null;
  only: "openai" | "anthropic" | "gemini" | "ollama" | null;
} {
  const raw = process.argv.slice(2);
  const onlyIdx = raw.findIndex((a) => a === "--only");
  let only: "openai" | "anthropic" | "gemini" | "ollama" | null = null;
  if (onlyIdx >= 0) {
    const v = raw[onlyIdx + 1]?.trim().toLowerCase() ?? "";
    if (v === "openai" || v === "anthropic" || v === "gemini" || v === "ollama") {
      only = v;
    } else {
      console.error(
        `--only must be one of: openai, anthropic, gemini, ollama (got "${raw[onlyIdx + 1] ?? ""}").`,
      );
      process.exit(1);
    }
  }

  const sessionIdx = raw.findIndex((a) => a === "--session");
  if (sessionIdx >= 0 && raw[sessionIdx + 1]?.trim()) {
    return { sessionId: raw[sessionIdx + 1]!.trim(), jobOrSessionToken: null, only };
  }

  const posArgs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--only" || raw[i] === "--session") {
      i += 1;
      continue;
    }
    if (raw[i]?.startsWith("-")) {
      continue;
    }
    if (raw[i]) {
      posArgs.push(raw[i]!);
    }
  }
  return { sessionId: null, jobOrSessionToken: posArgs[0]?.trim() ?? null, only };
}

function envForProvider(id: (typeof PROVIDERS)[number]["id"]): NodeJS.ProcessEnv {
  return { ...process.env, LLM_PROVIDER: id };
}

async function main(): Promise<void> {
  const { sessionId: explicitSessionId, jobOrSessionToken, only } = parseCli();
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

  const toRun = PROVIDERS.filter((p) => (only == null || p.id === only) && p.isConfigured(process.env));
  for (const p of PROVIDERS.filter((p) => only == null || p.id === only)) {
    if (!p.isConfigured(process.env)) {
      console.warn(
        `Skipping ${p.label} (${p.hint})`,
      );
    }
  }

  if (toRun.length === 0) {
    console.error(
      "No provider configured. Set API keys and model ids for at least one of openai, anthropic, gemini, ollama (see script header).",
    );
    await closeAppDatabase();
    process.exit(1);
  }

  const job = await appDao.findJobLiveSessionId(jobId!);
  if (!job) {
    console.error(`No Job with id ${jobId}`);
    await closeAppDatabase();
    process.exit(1);
  }
  if (!job.liveSessionId) {
    console.error(`Job ${jobId} has no liveSessionId (single-agent evaluator requires a live session).`);
    await closeAppDatabase();
    process.exit(1);
  }

  const loadedPreview = await loadInterviewEvaluationInputForJob(appDao, jobId);
  const utteranceCountDb = await appDao.countSpeechUtterancesForJob(jobId);
  const loader = new PromptLoader();

  let timelineIntervalCount = 0;
  let problemStatementChars: number;
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
  const baseContext = {
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
    maxIterations: iterationsFromEnv(),
  };

  let anyFailed = false;
  for (const spec of toRun) {
    const mergedEnv = envForProvider(spec.id);
    let llm: LlmClient;
    try {
      llm = LlmClientFactory.create(mergedEnv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to create LlmClient for ${spec.label}: ${msg}`);
      anyFailed = true;
      continue;
    }

    console.log(
      "\n" +
        "=".repeat(72) +
        `\n Real evaluation: provider=${llm.getProviderId()}  model=${llm.getModelId()}\n` +
        "=".repeat(72),
    );
    console.log(JSON.stringify({ ...baseContext, provider: llm.getProviderId(), model: llm.getModelId() }, null, 2));
    console.log("Calling SingleAgentInterviewEvaluator.evaluate({ jobId })…\n");

    const evaluator = new SingleAgentInterviewEvaluator(
      llm,
      appDao,
      {
        provider: llm.getProviderId(),
        loadPrompts: () => ({
          systemPrompt: loader.loadSync(SYSTEM_PROMPT_FILE),
          userPromptTemplate: loader.loadSync(USER_PROMPT_FILE),
        }),
        logAgentToolSteps: true,
        logCompleteEvaluationInput: true,
      },
      iterationsFromEnv(),
    );

    const result = await evaluator.evaluate({ jobId });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "complete") {
      anyFailed = true;
    }
  }

  await closeAppDatabase();
  if (anyFailed) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
