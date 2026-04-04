import type { FastifyBaseLogger } from "fastify";
import { PromptLoader } from "../../prompts/PromptLoader.js";
import type { IAppDao } from "../../dao/IAppDao.js";
import { LlmClientFactory } from "../llm/LlmClientFactory.js";
import {
  type InterviewEvaluator,
  InterviewEvaluationService,
} from "./InterviewEvaluationService.js";
import { SingleAgentInterviewEvaluator } from "./SingleAgentInterviewEvaluator.js";

const SYSTEM_PROMPT_FILE = "interview-evaluation-system.md";
const USER_PROMPT_FILE = "interview-evaluation-user.md";

const DEFAULT_LLM_EVAL_TEMPERATURE = 0.4;
const DEFAULT_AGENT_MAX_ITERATIONS = 24;

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

function langChainAgentEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVALUATION_USE_LANGCHAIN_AGENT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function agentMaxIterationsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.EVALUATION_AGENT_MAX_ITERATIONS?.trim();
  if (!raw) {
    return DEFAULT_AGENT_MAX_ITERATIONS;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_AGENT_MAX_ITERATIONS;
  }
  return Math.min(n, 64);
}

function logAgentToolStepsFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVALUATION_LOG_AGENT_STEPS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function logCompleteEvaluationInputFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVALUATION_LOG_COMPLETE_INPUT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Builds an {@link InterviewEvaluator}: {@link InterviewEvaluationService} with a concrete {@link LlmClient}
 * from {@link LlmClientFactory.tryCreate} (uses `EVALUATION_PROVIDER`), or {@link SingleAgentInterviewEvaluator} when
 * `EVALUATION_USE_LANGCHAIN_AGENT=1` and {@link IAppDao} is supplied.
 * Throws if `EVALUATION_PROVIDER` / API keys / database are not configured — the HTTP server should not start.
 * See `agents/single-agent-evaluator/AGENT.md` for the tool-based evaluator contract.
 */
export class InterviewEvaluationServiceFactory {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly appDb?: IAppDao,
  ) {}

  create(promptLog?: FastifyBaseLogger): InterviewEvaluator {
    const loader = new PromptLoader();
    const loadPrompts = () => ({
      systemPrompt: loader.loadSync(SYSTEM_PROMPT_FILE),
      userPromptTemplate: loader.loadSync(USER_PROMPT_FILE),
    });

    const raw = this.env.EVALUATION_PROVIDER?.toLowerCase().trim() ?? "openai";

    if (raw === "none") {
      throw new Error(
        'EVALUATION_PROVIDER cannot be "none" for this API: set EVALUATION_PROVIDER=openai or anthropic and the matching API key.',
      );
    }

    if (!this.appDb) {
      throw new Error(
        "Interview evaluation requires a configured application database (pass IAppDao into InterviewEvaluationServiceFactory).",
      );
    }

    if (raw === "openai" || raw === "anthropic") {
      const llm = LlmClientFactory.tryCreate(this.env);
      if (!llm) {
        throw new Error(
          raw === "openai"
            ? "OPENAI_API_KEY is not set but EVALUATION_PROVIDER=openai."
            : "ANTHROPIC_API_KEY is not set but EVALUATION_PROVIDER=anthropic.",
        );
      }
      const base = {
        provider: llm.getProviderId(),
        loadPrompts,
        promptLog,
        evaluationTemperature: evaluationTemperatureFromEnv(this.env),
        logAgentToolSteps: logAgentToolStepsFromEnv(this.env),
        logCompleteEvaluationInput: logCompleteEvaluationInputFromEnv(this.env),
      };
      if (langChainAgentEnabled(this.env)) {
        return new SingleAgentInterviewEvaluator(
          llm,
          this.appDb,
          base,
          agentMaxIterationsFromEnv(this.env),
        );
      }
      return new InterviewEvaluationService(llm, base, this.appDb);
    }

    throw new Error(`Unsupported EVALUATION_PROVIDER "${raw}". Use exactly "openai" or "anthropic".`);
  }
}
