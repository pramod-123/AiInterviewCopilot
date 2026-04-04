import { AnthropicLlmClient } from "./AnthropicLlmClient.js";
import type { LlmClient } from "./LlmClient.js";
import { OpenAiLlmClient } from "./OpenAiLlmClient.js";

/**
 * Instantiates {@link LlmClient} from env. Provider is taken from **`EVALUATION_PROVIDER`**
 * (`openai` | `anthropic`, default `openai`); `none` or missing keys yield `null`.
 */
export class LlmClientFactory {
  static tryCreate(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
    const raw = env.EVALUATION_PROVIDER?.toLowerCase().trim() ?? "openai";
    if (raw === "none") {
      return null;
    }
    if (raw === "openai") {
      return OpenAiLlmClient.tryCreate(env);
    }
    if (raw === "anthropic") {
      return AnthropicLlmClient.tryCreate(env);
    }
    return null;
  }
}
