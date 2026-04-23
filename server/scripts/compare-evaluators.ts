/**
 * Run {@link InterviewEvaluationService} (direct LLM, full prompt from DB) and
 * {@link SingleAgentInterviewEvaluator} (ids-only user turn + tools) on the same job;
 * write both payloads to a JSON file for diffing.
 *
 * From `server/`:
 *   npx tsx scripts/compare-evaluators.ts
 *   npx tsx scripts/compare-evaluators.ts <jobId | liveSessionId> [output.json]
 *   npx tsx scripts/compare-evaluators.ts --session <liveSessionId> [output.json]
 *
 * Uses `LLM_PROVIDER`, API keys, `EVALUATION_AGENT_MAX_ITERATIONS` like the app.
 * Logging flags are off here to keep stdout quiet; results go to the file (and a one-line path on stderr).
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PromptLoader } from "../src/prompts/PromptLoader.js";
import { appDao, closeAppDatabase, openAppDatabase } from "../src/db.js";
import type { InterviewEvaluationPayload } from "../src/types/interviewEvaluation.js";
import { LlmClientFactory } from "../src/services/llm/LlmClientFactory.js";
import { InterviewEvaluationService } from "../src/services/evaluation/InterviewEvaluationService.js";
import { SingleAgentInterviewEvaluator } from "../src/services/evaluation/SingleAgentInterviewEvaluator.js";

const SYSTEM_PROMPT_FILE = "interview-evaluation-system.md";
const USER_PROMPT_FILE = "interview-evaluation-user.md";

const DEFAULT_AGENT_MAX_ITERATIONS = 24;

function agentMaxIterationsFromEnv(): number {
  const raw = process.env.EVALUATION_AGENT_MAX_ITERATIONS?.trim();
  if (!raw) return DEFAULT_AGENT_MAX_ITERATIONS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AGENT_MAX_ITERATIONS;
  return Math.min(n, 64);
}

async function pickJobWithRichestData(): Promise<{
  jobId: string;
  utteranceCount: number;
  liveCodeSnapshotCount: number;
} | null> {
  const candidates = await appDao.findJobsLinkedToLiveSessionsWithUtteranceCounts();
  if (candidates.length === 0) return null;
  const sessionIds = [...new Set(candidates.map((c) => c.liveSessionId))];
  const grouped = await appDao.countLiveCodeSnapshotsBySessionIds(sessionIds);
  const snapsBySession = new Map(grouped.map((g) => [g.sessionId, g.count]));
  let best: { jobId: string; utteranceCount: number; liveCodeSnapshotCount: number } | null = null;
  for (const c of candidates) {
    const u = c.speechUtteranceCount;
    const snaps = snapsBySession.get(c.liveSessionId) ?? 0;
    if (!best || u > best.utteranceCount || (u === best.utteranceCount && snaps > best.liveCodeSnapshotCount)) {
      best = { jobId: c.id, utteranceCount: u, liveCodeSnapshotCount: snaps };
    }
  }
  return best;
}

function parseCli(): {
  sessionId: string | null;
  jobOrSessionToken: string | null;
  outPath: string | null;
} {
  const raw = process.argv.slice(2);
  const outFlagIdx = raw.findIndex((a) => a === "--out");
  let outPath: string | null = null;
  if (outFlagIdx >= 0 && raw[outFlagIdx + 1]?.trim()) {
    outPath = path.resolve(raw[outFlagIdx + 1]!.trim());
  }

  const sessionIdx = raw.findIndex((a) => a === "--session");
  const explicitSession =
    sessionIdx >= 0 && raw[sessionIdx + 1]?.trim() ? raw[sessionIdx + 1]!.trim() : null;

  const positional = raw.filter((a, i) => {
    if (a.startsWith("-")) return false;
    if (outFlagIdx >= 0 && (i === outFlagIdx + 1 || i === outFlagIdx)) return false;
    if (sessionIdx >= 0 && (i === sessionIdx + 1 || i === sessionIdx)) return false;
    return true;
  });

  if (explicitSession) {
    return { sessionId: explicitSession, jobOrSessionToken: null, outPath };
  }

  if (positional.length >= 2 && positional[positional.length - 1]!.endsWith(".json")) {
    if (!outPath) {
      outPath = path.resolve(positional[positional.length - 1]!);
    }
    return { sessionId: null, jobOrSessionToken: positional[0]!.trim(), outPath };
  }

  if (positional.length === 1) {
    const p = positional[0]!.trim();
    if (p.endsWith(".json")) {
      throw new Error("Output path looks like a .json file but no job id was given. Usage: … <jobId> [out.json]");
    }
    return { sessionId: null, jobOrSessionToken: p, outPath };
  }

  return { sessionId: null, jobOrSessionToken: null, outPath };
}

async function resolveJobId(
  explicitSessionId: string | null,
  jobOrSessionToken: string | null,
): Promise<{ jobId: string; autoPicked: boolean }> {
  if (explicitSessionId) {
    const jobId = await appDao.findFirstJobIdByLiveSessionId(explicitSessionId);
    if (!jobId) throw new Error(`No Job with liveSessionId ${explicitSessionId}`);
    return { jobId, autoPicked: false };
  }
  if (jobOrSessionToken) {
    const byJobId = await appDao.findJobIdIfExists(jobOrSessionToken);
    if (byJobId) return { jobId: byJobId, autoPicked: false };
    const bySession = await appDao.findFirstJobIdByLiveSessionId(jobOrSessionToken);
    if (bySession) return { jobId: bySession, autoPicked: false };
    throw new Error(`No Job with id ${jobOrSessionToken}, and no Job with liveSessionId ${jobOrSessionToken}.`);
  }
  const picked = await pickJobWithRichestData();
  if (!picked) throw new Error("No Job with liveSessionId in the database. Seed or post-process a live session first.");
  return { jobId: picked.jobId, autoPicked: true };
}

type ComparisonPayload = {
  meta: {
    jobId: string;
    liveSessionId: string | null;
    generatedAt: string;
    evaluationProvider: string;
    evalModelLabel: string;
    directDurationMs: number | null;
    singleAgentDurationMs: number | null;
    autoPickedJob: boolean;
    note: string;
  };
  directLlmFromDb: {
    evaluator: "InterviewEvaluationService";
    result: InterviewEvaluationPayload;
    error?: string;
  };
  singleAgentTools: {
    evaluator: "SingleAgentInterviewEvaluator";
    result: InterviewEvaluationPayload | null;
    skippedReason?: string;
    error?: string;
  };
};

async function main(): Promise<void> {
  const { sessionId: explicitSessionId, jobOrSessionToken, outPath: outPathCli } = parseCli();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, "..");
  const dataDir = path.join(serverRoot, "data");

  await openAppDatabase();

  const { jobId, autoPicked } = await resolveJobId(explicitSessionId, jobOrSessionToken);
  const job = await appDao.findJobLiveSessionId(jobId);
  const liveSessionId = job?.liveSessionId ?? null;

  const llm = LlmClientFactory.create(process.env);

  const loader = new PromptLoader();
  const loadPrompts = () => ({
    systemPrompt: loader.loadSync(SYSTEM_PROMPT_FILE),
    userPromptTemplate: loader.loadSync(USER_PROMPT_FILE),
  });

  const baseConfig = {
    provider: llm.getProviderId(),
    loadPrompts,
    logAgentToolSteps: false,
    logCompleteEvaluationInput: false,
  };

  const direct = new InterviewEvaluationService(llm, baseConfig, appDao);
  const agent = new SingleAgentInterviewEvaluator(
    llm,
    appDao,
    baseConfig,
    agentMaxIterationsFromEnv(),
  );

  const out: ComparisonPayload = {
    meta: {
      jobId,
      liveSessionId,
      generatedAt: new Date().toISOString(),
      evaluationProvider: process.env.EVALUATION_PROVIDER?.trim() || "single-agent",
      evalModelLabel: llm.getModelId(),
      directDurationMs: null,
      singleAgentDurationMs: null,
      autoPickedJob: autoPicked,
      note:
        "directLlmFromDb: one-shot JSON chat with full user prompt built from DB (utterances, timeline, problem). singleAgentTools: human message is jobId + liveSessionId only; model uses tools to fetch data. Single-agent is skipped when liveSessionId is null.",
    },
    directLlmFromDb: {
      evaluator: "InterviewEvaluationService",
      result: {
        status: "failed",
        provider: baseConfig.provider,
        errorMessage: "Not run (initialization placeholder).",
      },
    },
    singleAgentTools: { evaluator: "SingleAgentInterviewEvaluator", result: null },
  };

  const req = { jobId };

  const t0 = Date.now();
  try {
    out.directLlmFromDb.result = await direct.evaluate(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.directLlmFromDb.error = msg;
    out.directLlmFromDb.result = {
      status: "failed",
      provider: direct.provider,
      errorMessage: msg,
    };
  }
  out.meta.directDurationMs = Date.now() - t0;

  const t1 = Date.now();
  if (!liveSessionId) {
    out.singleAgentTools.skippedReason =
      "job.liveSessionId is null — SingleAgentInterviewEvaluator requires a live session.";
  } else {
    try {
      out.singleAgentTools.result = await agent.evaluate(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.singleAgentTools.error = msg;
      out.singleAgentTools.result = {
        status: "failed",
        provider: agent.provider,
        model: llm.getModelId(),
        errorMessage: msg,
      };
    }
  }
  out.meta.singleAgentDurationMs = Date.now() - t1;

  const defaultOut = path.join(
    dataDir,
    `evaluation-comparison-${jobId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  const outPath = outPathCli ?? defaultOut;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf-8");

  await closeAppDatabase();

  console.error(`Wrote comparison to ${outPath}`);
}

void main().catch(async (err) => {
  console.error(err);
  try {
    await closeAppDatabase();
  } catch {
    /* */
  }
  process.exit(1);
});
