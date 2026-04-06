import type { FastifyBaseLogger } from "fastify";
import { buildEvaluationUserMessage } from "../../prompts/buildEvaluationUserMessage.js";
import type {
  InterviewEvaluationInput,
  InterviewEvaluationPayload,
  InterviewEvaluationRequest,
} from "../../types/interviewEvaluation.js";
import type { IAppDao } from "../../dao/IAppDao.js";
import type { LlmClient } from "../llm/LlmClient.js";
import { loadInterviewEvaluationInputForJob } from "./loadInterviewEvaluationInputForJob.js";
import { parseInterviewEvaluationJson } from "./interviewEvaluationJson.js";

/** Shared contract for LLM-backed evaluation. */
export interface InterviewEvaluator {
  readonly provider: string;
  evaluate(request: InterviewEvaluationRequest): Promise<InterviewEvaluationPayload>;
}

export type LoadedInterviewEvaluationPrompts = {
  systemPrompt: string;
  userPromptTemplate: string;
};

export type InterviewEvaluationServiceConfig = {
  /** Shown on evaluation payloads; should match {@link LlmClient.getProviderId}. */
  provider: string;
  /** Called on every evaluation request so edits to markdown prompts apply without restarting the server. */
  loadPrompts: () => LoadedInterviewEvaluationPrompts;
  /** When set, logs full system + user prompts sent to the evaluation model (via Fastify logger). */
  promptLog?: FastifyBaseLogger;
  /**
   * When true, records each LangChain agent tool step (model “thought” text, tool name/args, observation preview)
   * and emits via {@link promptLog} if set, otherwise `console.log` (use env `EVALUATION_LOG_AGENT_STEPS` in the factory).
   */
  logAgentToolSteps?: boolean;
  /**
   * When true, logs the exact system + user strings sent to the model plus the full {@link InterviewEvaluationInput}
   * (segments, full transcript, timeline JSON, problem text). Uses {@link promptLog} if set, otherwise `console.log`
   * (env `EVALUATION_LOG_COMPLETE_INPUT` in the factory). When enabled, skips the slimmer prompt-only log to avoid duplicates.
   */
  logCompleteEvaluationInput?: boolean;
  /**
   * Single-agent only: max characters logged per tool observation (default 6000).
   * Set to `Infinity` (via `EVALUATION_LOG_FULL_TOOL_OBSERVATIONS` in the factory) to log full observations on screen / in JSON logs.
   */
  agentToolObservationMaxChars?: number;
  /** Sampling temperature for the rubric evaluation chat call (typical range 0–2). */
  evaluationTemperature: number;
};

/** Plain snapshot of evaluation input for structured logging (no transformation). */
export function interviewEvaluationInputSnapshot(input: InterviewEvaluationInput): InterviewEvaluationInput {
  return {
    jobId: input.jobId,
    segments: input.segments,
    fullTranscriptText: input.fullTranscriptText,
    interviewTimelineJson: input.interviewTimelineJson,
    problemStatementText: input.problemStatementText,
  };
}

export type EvaluationLlmCompleteLogMode =
  | "interview_evaluation_service"
  | "single_agent_interview_evaluator";

/**
 * Emits full system + user prompts and structured {@link InterviewEvaluationInput} (no truncation).
 * Uses Fastify logger when `promptLog` is set, otherwise `console.log` JSON.
 */
export function logCompleteEvaluationLlmInput(opts: {
  promptLog?: FastifyBaseLogger;
  jobId: string;
  liveSessionId: string | null;
  mode: EvaluationLlmCompleteLogMode;
  systemPrompt: string;
  userPrompt: string;
  evaluationInput: InterviewEvaluationInput;
  /** Single-agent path only: mirrors prior prompt log metadata. */
  maxAgentIterations?: number;
}): void {
  const { evaluationInput: ev } = opts;
  const completeInput = {
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    evaluationInput: ev,
    systemCharCount: opts.systemPrompt.length,
    userCharCount: opts.userPrompt.length,
    segmentCount: ev.segments.length,
    fullTranscriptCharCount: ev.fullTranscriptText.length,
    hasProblemStatement: Boolean(ev.problemStatementText?.trim()),
    timelineJsonCharCount: ev.interviewTimelineJson?.length ?? 0,
    ...(opts.maxAgentIterations != null ? { maxAgentIterations: opts.maxAgentIterations } : {}),
  };
  const log = opts.promptLog;
  if (log) {
    log.info(
      {
        jobId: opts.jobId,
        liveSessionId: opts.liveSessionId ?? undefined,
        evaluationLlm: {
          mode: opts.mode,
          completeInput,
        },
      },
      "Interview evaluation complete LLM input",
    );
  } else {
    console.log(
      JSON.stringify(
        {
          jobId: opts.jobId,
          liveSessionId: opts.liveSessionId,
          completeEvaluationInput: completeInput,
        },
        null,
        2,
      ),
    );
  }
}

/**
 * Interview rubric evaluation: builds prompts and delegates completion to an injected {@link LlmClient}.
 * Model id comes from {@link LlmClient.getModelId}.
 */
export class InterviewEvaluationService implements InterviewEvaluator {
  readonly provider: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly config: InterviewEvaluationServiceConfig,
    private readonly appDb: IAppDao,
  ) {
    this.provider = config.provider;
  }

  async evaluate(request: InterviewEvaluationRequest): Promise<InterviewEvaluationPayload> {
    const loaded = await loadInterviewEvaluationInputForJob(this.appDb, request.jobId);
    if (!loaded.ok) {
      return {
        status: "failed",
        provider: this.config.provider,
        model: this.llm.getModelId(),
        errorMessage: loaded.errorMessage,
      };
    }
    const input = loaded.input;
    const { systemPrompt, userPromptTemplate } = this.config.loadPrompts();
    const userContent = buildEvaluationUserMessage(userPromptTemplate, input);

    if (this.config.logCompleteEvaluationInput) {
      logCompleteEvaluationLlmInput({
        promptLog: this.config.promptLog,
        jobId: input.jobId,
        liveSessionId: loaded.liveSessionId,
        mode: "interview_evaluation_service",
        systemPrompt,
        userPrompt: userContent,
        evaluationInput: interviewEvaluationInputSnapshot(input),
      });
    } else {
      this.config.promptLog?.info(
        {
          jobId: input.jobId,
          evaluationLlm: {
            systemPrompt,
            userPrompt: userContent,
            systemCharCount: systemPrompt.length,
            userCharCount: userContent.length,
            hasProblemStatement: Boolean(input.problemStatementText?.trim()),
            segmentCount: input.segments.length,
          },
        },
        "Interview evaluation prompts sent to LLM",
      );
    }

    const { text, usage } = await this.llm.completeJsonChat({
      system: systemPrompt,
      user: userContent,
      temperature: this.config.evaluationTemperature,
    });

    const modelId = this.llm.getModelId();

    if (!text.trim()) {
      return {
        status: "failed",
        provider: this.config.provider,
        model: modelId,
        errorMessage: "Empty response from evaluation model.",
      };
    }

    const result = parseInterviewEvaluationJson(text, this.config.provider, modelId);
    if (usage) {
      result.tokenUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      };
      if (usage.cachedTokens) result.tokenUsage.cachedTokens = usage.cachedTokens;
      if (usage.reasoningTokens) result.tokenUsage.reasoningTokens = usage.reasoningTokens;
    }
    return result;
  }
}
