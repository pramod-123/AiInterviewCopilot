import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { IAppDao } from "../../src/dao/IAppDao.js";
import type { LlmClient } from "../../src/services/llm/LlmClient.js";
import type { InterviewEvaluationServiceConfig } from "../../src/services/evaluation/InterviewEvaluationService.js";

const agentMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  lastExecutorOpts: null as { returnIntermediateSteps?: boolean } | null,
  createToolCallingAgent: vi.fn(() => ({ lc_namespace: ["test", "agent"] })),
}));

vi.mock("langchain/agents", () => ({
  createToolCallingAgent: agentMocks.createToolCallingAgent,
  AgentExecutor: class MockAgentExecutor {
    invoke = agentMocks.invoke;
    constructor(opts: { returnIntermediateSteps?: boolean }) {
      agentMocks.lastExecutorOpts = opts;
    }
  },
}));

import {
  formatAgentStepsTrace,
  SingleAgentInterviewEvaluator,
} from "../../src/services/evaluation/SingleAgentInterviewEvaluator.js";

const minimalEvalJson = JSON.stringify({
  summary: "Direct evaluator test",
  dimensions: {
    problem_understanding: {
      score: 3,
      evidence_sufficiency: "moderate",
      rationale_points: [{ claim: "placeholder" }],
    },
  },
  strengths: ["clear"],
  weaknesses: [],
});

function mockLlm(overrides?: { providerId?: string; modelId?: string }): LlmClient {
  const providerId = overrides?.providerId ?? "openai";
  const modelId = overrides?.modelId ?? "gpt-test";
  return {
    getProviderId: () => providerId,
    getModelId: () => modelId,
    toBaseChatModel: vi.fn((): BaseChatModel => ({}) as BaseChatModel),
    completeJsonChat: vi.fn(),
    completeVisionJsonChat: vi.fn(),
    transcribeFromAudioFile: vi.fn(),
  };
}

function baseConfig(overrides?: { provider: string }): InterviewEvaluationServiceConfig {
  return {
    provider: overrides?.provider ?? "openai",
    loadPrompts: () => ({
      systemPrompt: "You are an evaluator. Output JSON.",
      userPromptTemplate: "{{JOB_ID}}",
    }),
  };
}

/** Job linked to a live session (single-agent path). */
function appDbWithLiveSession(): IAppDao {
  return {
    findJobLiveSessionId: vi.fn().mockResolvedValue({ liveSessionId: "sess-1" }),
  } as unknown as IAppDao;
}

/**
 * Unit tests: construct {@link SingleAgentInterviewEvaluator} and call `evaluate()` with mocks.
 * For a **real** run against the DB + LLM APIs, use
 * `npm run test:single-agent-evaluator` (one `LLM_PROVIDER` from `.env`) or
 * `npm run test:single-agent-evaluator:providers` (openai, anthropic, gemini, ollama in sequence, keys permitting).
 */
describe("formatAgentStepsTrace", () => {
  it("maps tool, toolInput, agentThought from action.log, and truncates long observations", () => {
    const longObs = "x".repeat(7000);
    const trace = formatAgentStepsTrace([
      {
        action: {
          tool: "read_file",
          toolInput: { path: "/a" },
          log: "I need the file contents.",
        },
        observation: longObs,
      },
    ]);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.tool).toBe("read_file");
    expect(trace[0]!.toolInput).toEqual({ path: "/a" });
    expect(trace[0]!.agentThought).toBe("I need the file contents.");
    expect(trace[0]!.observationTruncated).toBe(true);
    expect(trace[0]!.observationPreview.endsWith("…")).toBe(true);
    expect(trace[0]!.observationPreview.length).toBeLessThan(longObs.length);
  });

  it("does not truncate when maxObservationChars is Infinity", () => {
    const longObs = "y".repeat(7000);
    const trace = formatAgentStepsTrace(
      [
        {
          action: { tool: "t", toolInput: {}, log: "" },
          observation: longObs,
        },
      ],
      Number.POSITIVE_INFINITY,
    );
    expect(trace[0]!.observationTruncated).toBe(false);
    expect(trace[0]!.observationPreview).toBe(longObs);
  });
});

describe("SingleAgentInterviewEvaluator (direct evaluate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentMocks.lastExecutorOpts = null;
  });

  it("constructs an instance with provider from LlmClient", () => {
    const llm = mockLlm();
    const appDb = {} as unknown as IAppDao;
    const ev = new SingleAgentInterviewEvaluator(llm, appDb, baseConfig(), 8, () => []);
    expect(ev.provider).toBe("openai");
  });

  it("returns failed when job is missing", async () => {
    const appDb = {
      findJobLiveSessionId: vi.fn().mockResolvedValue(null),
    } as unknown as IAppDao;
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, baseConfig(), 8, () => []);
    const r = await ev.evaluate({ jobId: "missing-job" });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("Evaluation job not found");
    expect(agentMocks.invoke).not.toHaveBeenCalled();
  });

  it("returns failed when job has no liveSessionId", async () => {
    const appDb = {
      findJobLiveSessionId: vi.fn().mockResolvedValue({ liveSessionId: null }),
    } as unknown as IAppDao;
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, baseConfig(), 8, () => []);
    const r = await ev.evaluate({ jobId: "j1" });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("liveSessionId");
    expect(agentMocks.invoke).not.toHaveBeenCalled();
  });

  it("returns failed when AgentExecutor.invoke throws", async () => {
    const appDb = appDbWithLiveSession();
    agentMocks.invoke.mockRejectedValue(new Error("network down"));
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, baseConfig(), 8, () => []);
    const r = await ev.evaluate({ jobId: "j1" });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("network down");
  });

  it("returns failed when agent output is empty after extract", async () => {
    const appDb = appDbWithLiveSession();
    agentMocks.invoke.mockResolvedValue({ output: "   " });
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, baseConfig(), 8, () => []);
    const r = await ev.evaluate({ jobId: "j1" });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("empty output");
  });

  it("parses complete payload when invoke returns rubric JSON", async () => {
    const appDb = appDbWithLiveSession();
    agentMocks.invoke.mockResolvedValue({ output: minimalEvalJson });
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, baseConfig(), 8, () => []);
    const r = await ev.evaluate({ jobId: "job-abc" });
    expect(r.status).toBe("complete");
    expect(r.summary).toBe("Direct evaluator test");
    expect(r.dimensions?.problem_understanding?.score).toBe(3);
    expect(agentMocks.invoke).toHaveBeenCalledTimes(1);
    expect(agentMocks.lastExecutorOpts?.returnIntermediateSteps).toBe(false);
    const call = agentMocks.invoke.mock.calls[0]![0] as {
      input: string;
      system: string;
    };
    expect(call.system).toContain("evaluator");
    expect(call.input).toContain("job-abc");
    expect(call.input).toContain("sess-1");
    expect(call.input).not.toContain("INTERVIEW_TIMELINE_JSON");
    expect(call.input).not.toContain("{{JOB_ID}}");
  });

  it("enables returnIntermediateSteps when logAgentToolSteps is true", async () => {
    const appDb = appDbWithLiveSession();
    agentMocks.invoke.mockResolvedValue({ output: minimalEvalJson, intermediateSteps: [] });
    const cfg = { ...baseConfig(), logAgentToolSteps: true };
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, cfg, 8, () => []);
    await ev.evaluate({ jobId: "job-abc" });
    expect(agentMocks.lastExecutorOpts?.returnIntermediateSteps).toBe(true);
  });

  it("logs agent tool steps via promptLog when logAgentToolSteps is true", async () => {
    const appDb = appDbWithLiveSession();
    const promptLog = { info: vi.fn() };
    agentMocks.invoke.mockResolvedValue({
      output: minimalEvalJson,
      intermediateSteps: [
        {
          action: {
            tool: "t1",
            toolInput: { a: 1 },
            log: "thinking",
          },
          observation: "ok",
        },
      ],
    });
    const cfg = {
      ...baseConfig(),
      logAgentToolSteps: true,
      promptLog: promptLog as unknown as import("fastify").FastifyBaseLogger,
    };
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, cfg, 8, () => []);
    await ev.evaluate({ jobId: "job-xyz" });
    expect(promptLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-xyz",
        liveSessionId: "sess-1",
        evaluationLlm: expect.objectContaining({
          mode: "single_agent_interview_evaluator",
          agentToolSteps: expect.objectContaining({
            toolCallCount: 1,
            toolsCalledInOrder: ["t1"],
            steps: [
              expect.objectContaining({
                step: 1,
                tool: "t1",
                agentThought: "thinking",
                observationPreview: "ok",
                observationTruncated: false,
              }),
            ],
          }),
        }),
      }),
      "Interview evaluation single-agent tool steps",
    );
  });

  it("logs complete LLM input to console when logCompleteEvaluationInput is true and promptLog is unset", async () => {
    const appDb = appDbWithLiveSession();
    agentMocks.invoke.mockResolvedValue({ output: minimalEvalJson });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = { ...baseConfig(), logCompleteEvaluationInput: true };
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, cfg, 8, () => []);
    await ev.evaluate({ jobId: "job-full" });
    expect(logSpy).toHaveBeenCalled();
    const raw = logSpy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("completeEvaluationInput"))?.[0];
    expect(raw).toBeDefined();
    logSpy.mockRestore();
    const parsed = JSON.parse(raw as string) as {
      jobId: string;
      liveSessionId: string;
      completeEvaluationInput: { userPrompt: string; evaluationInput: { jobId: string } };
    };
    expect(parsed.jobId).toBe("job-full");
    expect(parsed.liveSessionId).toBe("sess-1");
    expect(parsed.completeEvaluationInput.evaluationInput.jobId).toBe("job-full");
    expect(parsed.completeEvaluationInput.userPrompt).toContain("job-full");
    expect(parsed.completeEvaluationInput.userPrompt).toContain("sess-1");
  });

  it("logs complete LLM input via promptLog when logCompleteEvaluationInput is true", async () => {
    const appDb = appDbWithLiveSession();
    agentMocks.invoke.mockResolvedValue({ output: minimalEvalJson });
    const promptLog = { info: vi.fn() };
    const cfg = {
      ...baseConfig(),
      logCompleteEvaluationInput: true,
      promptLog: promptLog as unknown as import("fastify").FastifyBaseLogger,
    };
    const ev = new SingleAgentInterviewEvaluator(mockLlm(), appDb, cfg, 8, () => []);
    await ev.evaluate({ jobId: "job-z" });
    const completeCall = promptLog.info.mock.calls.find((c) => c[1] === "Interview evaluation complete LLM input");
    expect(completeCall).toBeDefined();
    const payload = completeCall![0] as {
      evaluationLlm: { completeInput: { maxAgentIterations: number; evaluationInput: { jobId: string } } };
    };
    expect(payload.evaluationLlm.completeInput.evaluationInput.jobId).toBe("job-z");
    expect(payload.evaluationLlm.completeInput.maxAgentIterations).toBe(8);
    const promptsOnly = promptLog.info.mock.calls.find(
      (c) => c[1] === "Interview evaluation single-agent prompts",
    );
    expect(promptsOnly).toBeUndefined();
  });
});
