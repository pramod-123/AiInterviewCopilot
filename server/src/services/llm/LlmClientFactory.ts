import { AnthropicLlmClient } from "./AnthropicLlmClient.js";
import type { LlmClient } from "./LlmClient.js";
import { OpenAiLlmClient } from "./OpenAiLlmClient.js";

export type LlmChatProviderId = "openai" | "anthropic";

/**
 * Instantiates {@link LlmClient} implementations from env (API keys, model vars). No routing or product messaging.
 */
export class LlmClientFactory {
  static tryCreate(
    provider: LlmChatProviderId,
    env: NodeJS.ProcessEnv = process.env,
  ): LlmClient | null {
    return provider === "openai"
      ? OpenAiLlmClient.tryCreate(env)
      : AnthropicLlmClient.tryCreate(env);
  }
}
