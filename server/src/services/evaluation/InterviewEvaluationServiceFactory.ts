import type { FastifyBaseLogger } from "fastify";
import { PromptLoader } from "../../prompts/PromptLoader.js";
import type {
  InterviewEvaluationInput,
  InterviewEvaluationPayload,
} from "../../types/interviewEvaluation.js";
import { LlmClientFactory } from "../llm/LlmClientFactory.js";
import {
  type InterviewEvaluator,
  InterviewEvaluationService,
} from "./InterviewEvaluationService.js";

const SYSTEM_PROMPT_FILE = "interview-evaluation-system.md";
const USER_PROMPT_FILE = "interview-evaluation-user.md";

const DEFAULT_LLM_EVAL_TEMPERATURE = 0.4;

function evaluationTemperatureFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.LLM_EVAL_TEMPERATURE?.trim();
  if (!raw) {
    return DEFAULT_LLM_EVAL_TEMPERATURE;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return DEFAULT_LLM_EVAL_TEMPERATURE;
  }
  return n;
}

/**
 * Returns `status: "skipped"` for every evaluate call (no LLM).
 * Used when `EVALUATION_PROVIDER` is none or the chosen provider has no API key.
 */
class SkippedInterviewEvaluationService implements InterviewEvaluator {
  readonly provider: string;

  constructor(
    provider: string,
    private readonly summary: string,
  ) {
    this.provider = provider;
  }

  async evaluate(_input: InterviewEvaluationInput): Promise<InterviewEvaluationPayload> {
    return {
      status: "skipped",
      provider: this.provider,
      summary: this.summary,
    };
  }
}

/**
 * Builds an {@link InterviewEvaluator}: {@link InterviewEvaluationService} with a concrete {@link LlmClient}
 * from {@link LlmClientFactory.tryCreate}, or an internal skipped implementation when evaluation is off or the API key is missing.
 */
export class InterviewEvaluationServiceFactory {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  create(promptLog?: FastifyBaseLogger): InterviewEvaluator {
    const loader = new PromptLoader();
    const loadPrompts = () => ({
      systemPrompt: loader.loadSync(SYSTEM_PROMPT_FILE),
      userPromptTemplate: loader.loadSync(USER_PROMPT_FILE),
    });

    const raw = this.env.EVALUATION_PROVIDER?.toLowerCase().trim() ?? "openai";

    if (raw === "none") {
      return new SkippedInterviewEvaluationService(
        "none",
        "Evaluation disabled (EVALUATION_PROVIDER=none). Set EVALUATION_PROVIDER=openai or anthropic and the matching API key.",
      );
    }

    if (raw === "openai") {
      const llm = LlmClientFactory.tryCreate("openai", this.env);
      if (!llm) {
        return new SkippedInterviewEvaluationService(
          "none",
          "OPENAI_API_KEY is not set; LLM evaluation was skipped.",
        );
      }
      return new InterviewEvaluationService(llm, {
        provider: llm.getProviderId(),
        loadPrompts,
        promptLog,
        evaluationTemperature: evaluationTemperatureFromEnv(this.env),
      });
    }

    if (raw === "anthropic") {
      const llm = LlmClientFactory.tryCreate("anthropic", this.env);
      if (!llm) {
        return new SkippedInterviewEvaluationService(
          "none",
          "ANTHROPIC_API_KEY is not set; LLM evaluation was skipped.",
        );
      }
      return new InterviewEvaluationService(llm, {
        provider: llm.getProviderId(),
        loadPrompts,
        promptLog,
        evaluationTemperature: evaluationTemperatureFromEnv(this.env),
      });
    }

    throw new Error(
      `Unsupported EVALUATION_PROVIDER "${raw}". Use exactly "openai", "anthropic", or "none".`,
    );
  }
}
