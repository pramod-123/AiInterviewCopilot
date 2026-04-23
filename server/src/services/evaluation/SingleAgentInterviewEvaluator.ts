import type { AgentStep } from "@langchain/core/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import type { FastifyBaseLogger } from "fastify";
import type {
  InterviewEvaluationPayload,
  InterviewEvaluationRequest,
} from "../../types/interviewEvaluation.js";
import type { IAppDao } from "../../dao/IAppDao.js";
import type { LlmClient } from "../llm/LlmClient.js";
import {
  buildDefaultInterviewEvaluationTools,
  type InterviewEvaluationAgentToolsFactory,
} from "./langChainInterviewTools.js";
import {
  interviewEvaluationInputSnapshot,
  logCompleteEvaluationLlmInput,
  type InterviewEvaluator,
  type InterviewEvaluationServiceConfig,
} from "./InterviewEvaluationService.js";
import { parseInterviewEvaluationJson } from "./interviewEvaluationJson.js";

export type {
  InterviewEvaluationAgentToolContext as SingleAgentEvaluationToolContext,
  InterviewEvaluationAgentToolsFactory as SingleAgentEvaluationToolsFactory,
} from "./langChainInterviewTools.js";

/** Default max characters per tool observation in structured logs (single-agent evaluator). */
export const DEFAULT_AGENT_TOOL_OBSERVATION_LOG_CHARS = 6000;

/** Human-readable trace of LangChain {@link AgentStep}s (tool calls + model log + observation preview). */
export type AgentToolStepTrace = {
  step: number;
  tool: string;
  toolInput: unknown;
  /** Model-facing text associated with the action (often includes reasoning before the tool call). */
  agentThought: string;
  observationPreview: string;
  observationTruncated: boolean;
};

/**
 * @param maxObservationChars Per-step cap; use `Infinity` (e.g. from {@link InterviewEvaluationServiceConfig.agentToolObservationMaxChars}) for full text in logs.
 */
export function formatAgentStepsTrace(
  steps: AgentStep[],
  maxObservationChars: number = DEFAULT_AGENT_TOOL_OBSERVATION_LOG_CHARS,
): AgentToolStepTrace[] {
  const limit =
    Number.isFinite(maxObservationChars) && maxObservationChars > 0
      ? maxObservationChars
      : Number.POSITIVE_INFINITY;
  return steps.map((s, i) => {
    const obs = typeof s.observation === "string" ? s.observation : JSON.stringify(s.observation);
    const truncated = obs.length > limit;
    return {
      step: i + 1,
      tool: s.action.tool,
      toolInput: s.action.toolInput,
      agentThought: s.action.log ?? "",
      observationPreview: truncated ? `${obs.slice(0, limit)}…` : obs,
      observationTruncated: truncated,
    };
  });
}

/** Pull a JSON object from model output (handles optional \`\`\`json fences). */
export function extractJsonObjectFromAgentOutput(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```/im.exec(t);
  if (fenced?.[1]) {
    return fenced[1]!.trim();
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return t.slice(start, end + 1).trim();
  }
  return t;
}

/**
 * Human turn for the agent: identifiers only. Transcript, problem text, and code must come from tools.
 */
export function buildSingleAgentInterviewUserMessage(jobId: string, liveSessionId: string): string {
  return [
    "Evaluate this interview. The message below contains only identifiers — no transcript, problem text, or code.",
    "",
    `jobId: ${jobId}`,
    `liveSessionId: ${liveSessionId}`,
    "",
    "When finished, reply with exactly one JSON object matching the system schema (no markdown fences, no extra text).",
  ].join("\n");
}

/**
 * {@link InterviewEvaluator} that runs a single tool-calling agent. Tools are supplied by
 * {@link InterviewEvaluationAgentToolsFactory} (defaults to {@link buildDefaultInterviewEvaluationTools}).
 * Requires the evaluation job to be linked to a live session (`liveSessionId` on the job row).
 * Jobs with no persisted speech utterances are allowed (e.g. mute interview); the model uses tools and may report limited speech evidence.
 *
 * The agent user message carries **only** `jobId` and `liveSessionId`; all interview content is retrieved via tools.
 *
 * System prompt text is read once from {@link InterviewEvaluationServiceConfig.loadPrompts} at construction
 * (not on each {@link evaluate} call). Use a new evaluator instance to pick up edited markdown prompts.
 *
 * Product/agent notes: `agents/single-agent-evaluator/AGENT.md`.
 */
export class SingleAgentInterviewEvaluator implements InterviewEvaluator {
  readonly provider: string;
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly appDb: IAppDao,
    private readonly config: InterviewEvaluationServiceConfig,
    private readonly maxAgentIterations: number,
    private readonly createTools: InterviewEvaluationAgentToolsFactory = buildDefaultInterviewEvaluationTools,
  ) {
    this.provider = llm.getProviderId();
    this.systemPrompt = config.loadPrompts().systemPrompt;
  }

  async evaluate(request: InterviewEvaluationRequest): Promise<InterviewEvaluationPayload> {
    const jobId = request.jobId;
    const job = await this.appDb.findJobLiveSessionId(jobId);
    if (!job) {
      return {
        status: "failed",
        provider: this.config.provider,
        model: this.llm.getModelId(),
        errorMessage: `Evaluation job not found: ${jobId}`,
      };
    }
    const liveSessionId = job.liveSessionId;
    if (!liveSessionId) {
      return {
        status: "failed",
        provider: this.config.provider,
        model: this.llm.getModelId(),
        errorMessage:
          "Single-agent interview evaluation requires job.liveSessionId; this job is not linked to a live session.",
      };
    }

    const userContent = buildSingleAgentInterviewUserMessage(jobId, liveSessionId);

    if (this.config.logCompleteEvaluationInput) {
      logCompleteEvaluationLlmInput({
        promptLog: this.config.promptLog,
        jobId,
        liveSessionId,
        mode: "single_agent_interview_evaluator",
        systemPrompt: this.systemPrompt,
        userPrompt: userContent,
        evaluationInput: interviewEvaluationInputSnapshot({
          jobId,
          segments: [],
          fullTranscriptText: "",
        }),
        maxAgentIterations: this.maxAgentIterations,
      });
    } else {
      this.logPrompts(jobId, this.systemPrompt, userContent, liveSessionId);
    }

    const chatModel = this.llm.toBaseChatModel();
    const tools = this.createTools({
      db: this.appDb,
      liveSessionId,
      jobId,
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "{system}"],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const agent = createToolCallingAgent({
      llm: chatModel,
      tools,
      prompt,
    });

    const traceSteps = Boolean(this.config.logAgentToolSteps);
    const executor = new AgentExecutor({
      agent,
      tools,
      maxIterations: this.maxAgentIterations,
      returnIntermediateSteps: traceSteps,
      earlyStoppingMethod: "generate",
    });

    let output: string;
    try {
      const res = (await executor.invoke({
        input: userContent,
        chat_history: [],
        system: this.systemPrompt,
      })) as {
        output?: unknown;
        intermediateSteps?: AgentStep[];
      };
      output = typeof res.output === "string" ? res.output : JSON.stringify(res.output);
      if (traceSteps && Array.isArray(res.intermediateSteps)) {
        this.logAgentToolSteps(jobId, liveSessionId, res.intermediateSteps);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        provider: this.config.provider,
        model: this.llm.getModelId(),
        errorMessage: `Interview evaluation agent failed: ${msg}`,
      };
    }

    const jsonText = extractJsonObjectFromAgentOutput(output);
    if (!jsonText.trim()) {
      return {
        status: "failed",
        provider: this.config.provider,
        model: this.llm.getModelId(),
        errorMessage: "Evaluation agent returned empty output after tool loop.",
      };
    }

    return parseInterviewEvaluationJson(jsonText, this.config.provider, this.llm.getModelId());
  }

  private logAgentToolSteps(jobId: string, liveSessionId: string, steps: AgentStep[]): void {
    const maxObs =
      this.config.agentToolObservationMaxChars ?? DEFAULT_AGENT_TOOL_OBSERVATION_LOG_CHARS;
    const trace = formatAgentStepsTrace(steps, maxObs);
    const payload = {
      jobId,
      liveSessionId,
      toolCallCount: trace.length,
      toolsCalledInOrder: trace.map((t) => t.tool),
      steps: trace,
    };
    const log = this.config.promptLog;
    if (log) {
      log.info(
        {
          jobId,
          liveSessionId,
          evaluationLlm: {
            mode: "single_agent_interview_evaluator",
            agentToolSteps: payload,
          },
        },
        "Interview evaluation single-agent tool steps",
      );
    } else {
      console.log(JSON.stringify({ agentToolSteps: payload }, null, 2));
    }
  }

  private logPrompts(
    jobId: string,
    systemPrompt: string,
    userContent: string,
    liveSessionId: string,
  ): void {
    const log = this.config.promptLog as FastifyBaseLogger | undefined;
    if (!log) {
      return;
    }
    log.info(
      {
        jobId,
        liveSessionId,
        evaluationLlm: {
          mode: "single_agent_interview_evaluator",
          systemPrompt,
          userPrompt: userContent,
          systemCharCount: systemPrompt.length,
          userCharCount: userContent.length,
          maxAgentIterations: this.maxAgentIterations,
        },
      },
      "Interview evaluation single-agent prompts",
    );
  }
}
