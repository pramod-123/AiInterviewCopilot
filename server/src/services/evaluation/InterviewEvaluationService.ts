import type { FastifyBaseLogger } from "fastify";
import { buildEvaluationUserMessage } from "../../prompts/buildEvaluationUserMessage.js";
import type {
  InterviewEvaluationInput,
  InterviewEvaluationPayload,
} from "../../types/interviewEvaluation.js";
import type { LlmClient } from "../llm/LlmClient.js";
import { parseInterviewEvaluationJson } from "./interviewEvaluationJson.js";

/** Shared contract for LLM-backed evaluation and factory-built skipped evaluators. */
export interface InterviewEvaluator {
  readonly provider: string;
  evaluate(input: InterviewEvaluationInput): Promise<InterviewEvaluationPayload>;
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
};

/**
 * Interview rubric evaluation: builds prompts and delegates completion to an injected {@link LlmClient}.
 * Model id comes from {@link LlmClient.getModelId}.
 */
export class InterviewEvaluationService implements InterviewEvaluator {
  readonly provider: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly config: InterviewEvaluationServiceConfig,
  ) {
    this.provider = config.provider;
  }

  async evaluate(input: InterviewEvaluationInput): Promise<InterviewEvaluationPayload> {
    const { systemPrompt, userPromptTemplate } = this.config.loadPrompts();
    const userContent = buildEvaluationUserMessage(userPromptTemplate, input);

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

    const { text, usage } = await this.llm.completeJsonChat({
      system: systemPrompt,
      user: userContent,
      temperature: 0.4,
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
