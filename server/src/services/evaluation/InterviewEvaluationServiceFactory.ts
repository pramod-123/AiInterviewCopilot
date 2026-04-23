import type { FastifyBaseLogger } from "fastify";
import type { AppEnvResolver } from "../../infrastructure/appEnvResolver.js";
import { PromptLoader } from "../../prompts/PromptLoader.js";
import type { IAppDao } from "../../dao/IAppDao.js";
import { LlmClientFactory } from "../llm/LlmClientFactory.js";
import {
  type InterviewEvaluator,
  InterviewEvaluationService,
} from "./InterviewEvaluationService.js";
import {
  DEFAULT_AGENT_TOOL_OBSERVATION_LOG_CHARS,
  SingleAgentInterviewEvaluator,
} from "./SingleAgentInterviewEvaluator.js";

const SYSTEM_PROMPT_FILE = "interview-evaluation-system.md";
const USER_PROMPT_FILE = "interview-evaluation-user.md";

const DEFAULT_AGENT_MAX_ITERATIONS = 24;

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

/** Default on; set to 0 / false / no / off to disable. */
function logAgentToolStepsFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVALUATION_LOG_AGENT_STEPS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") {
    return false;
  }
  if (!v) {
    return true;
  }
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Cap for each tool observation in single-agent step logs. `EVALUATION_LOG_FULL_TOOL_OBSERVATIONS=1` → no cap.
 * `EVALUATION_AGENT_OBSERVATION_PREVIEW_CHARS=0` or `-1` also means no cap; otherwise a positive integer sets the limit.
 */
function agentToolObservationMaxCharsFromEnv(env: NodeJS.ProcessEnv): number {
  const full = env.EVALUATION_LOG_FULL_TOOL_OBSERVATIONS?.trim().toLowerCase();
  if (full === "1" || full === "true" || full === "yes" || full === "on") {
    return Number.POSITIVE_INFINITY;
  }
  const raw = env.EVALUATION_AGENT_OBSERVATION_PREVIEW_CHARS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (n === 0 || n === -1) {
      return Number.POSITIVE_INFINITY;
    }
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_AGENT_TOOL_OBSERVATION_LOG_CHARS;
}

/** Default on; set to 0 / false / no / off to disable. */
function logCompleteEvaluationInputFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVALUATION_LOG_COMPLETE_INPUT?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") {
    return false;
  }
  if (!v) {
    return true;
  }
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Builds an {@link InterviewEvaluator}. Set **`EVALUATION_PROVIDER`** to **`llm`** (one-shot {@link InterviewEvaluationService})
 * or **`single-agent`** ({@link SingleAgentInterviewEvaluator}). Set **`LLM_PROVIDER`** to **`openai`** | **`anthropic`** | **`gemini`** | **`ollama`**
 * with the matching API key (Ollama: no key; set `OLLAMA_MODEL_ID`, optional `OLLAMA_BASE_URL`) — shared with {@link LlmClientFactory}, not evaluation-specific.
 * Throws if env / API keys / database are not configured — the HTTP server should not start.
 * See `agents/single-agent-evaluator/AGENT.md` for the tool-based evaluator contract.
 *
 * Full tool observation text in logs (no 6000-char preview cap): set **`EVALUATION_LOG_FULL_TOOL_OBSERVATIONS=1`**,
 * or **`EVALUATION_AGENT_OBSERVATION_PREVIEW_CHARS=0`**. Requires **`EVALUATION_LOG_AGENT_STEPS`** enabled (default on).
 */
export class InterviewEvaluationServiceFactory {
  constructor(
    private readonly resolveEnv: AppEnvResolver = () => process.env,
    private readonly appDb: IAppDao,
  ) {}

  create(promptLog?: FastifyBaseLogger): InterviewEvaluator {
    const env = this.resolveEnv();
    const loader = new PromptLoader();
    const loadPrompts = () => ({
      systemPrompt: loader.loadSync(SYSTEM_PROMPT_FILE),
      userPromptTemplate: loader.loadSync(USER_PROMPT_FILE),
    });

    const configured = env.EVALUATION_PROVIDER?.trim();
    if (!configured) {
      throw new Error(
        'EVALUATION_PROVIDER is required: set evaluationProvider in server/.app-runtime-config.json (or EVALUATION_PROVIDER in the process environment) to "llm" or "single-agent". Set LLM_PROVIDER and the matching credentials (Ollama: OLLAMA_MODEL_ID; cloud: API key + model id).',
      );
    }
    const raw = configured.toLowerCase();
    if (raw !== "llm" && raw !== "single-agent") {
      throw new Error(
        `Unsupported EVALUATION_PROVIDER "${raw}". Use exactly "llm" or "single-agent" with LLM_PROVIDER=openai|anthropic|gemini|ollama.`,
      );
    }

    const llm = LlmClientFactory.create(env);

    const base = {
      provider: llm.getProviderId(),
      loadPrompts,
      promptLog,
      logAgentToolSteps: logAgentToolStepsFromEnv(env),
      logCompleteEvaluationInput: logCompleteEvaluationInputFromEnv(env),
      agentToolObservationMaxChars: agentToolObservationMaxCharsFromEnv(env),
    };

    if (raw === "single-agent") {
      return new SingleAgentInterviewEvaluator(
        llm,
        this.appDb,
        base,
        agentMaxIterationsFromEnv(env),
      );
    }
    return new InterviewEvaluationService(llm, base, this.appDb);
  }
}
