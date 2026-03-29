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

export type InterviewEvaluationServiceConfig = {
  /** Shown on evaluation payloads; should match {@link LlmClient.getProviderId}. */
  provider: string;
  systemPrompt: string;
  userPromptTemplate: string;
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
    const userContent = buildEvaluationUserMessage(this.config.userPromptTemplate, input);

    const { text } = await this.llm.completeJsonChat({
      system: this.config.systemPrompt,
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

    return parseInterviewEvaluationJson(text, this.config.provider, modelId);
  }
}
