import { AnthropicLlmClient } from "./AnthropicLlmClient.js";
import { GeminiLlmClient } from "./GeminiLlmClient.js";
import type { LlmClient } from "./LlmClient.js";
import { OllamaLlmClient } from "./OllamaLlmClient.js";
import { OpenAiLlmClient } from "./OpenAiLlmClient.js";

/**
 * Instantiates {@link LlmClient} from env. Backend is **`LLM_PROVIDER`**
 * (`openai` | `anthropic` | `gemini` | `ollama`) with matching API key (not required for Ollama).
 */
export class LlmClientFactory {
  static create(env: NodeJS.ProcessEnv = process.env): LlmClient {
    const configured = env.LLM_PROVIDER?.trim();
    if (!configured) {
      throw new Error(
        'LLM_PROVIDER is required: set llmProvider in server/.app-runtime-config.json (or LLM_PROVIDER in the process environment) to "openai", "anthropic", "gemini", or "ollama" with the matching API key (Ollama: no key; set OLLAMA_MODEL_ID).',
      );
    }
    const raw = configured.toLowerCase();
    if (raw === "openai") {
      const client = OpenAiLlmClient.tryCreate(env);
      if (!client) {
        if (!env.OPENAI_API_KEY?.trim()) {
          throw new Error("OPENAI_API_KEY is not set but LLM_PROVIDER=openai.");
        }
        if (!env.OPENAI_MODEL_ID?.trim()) {
          throw new Error("OPENAI_MODEL_ID is not set but LLM_PROVIDER=openai.");
        }
        throw new Error("Could not create OpenAI LLM client.");
      }
      return client;
    }
    if (raw === "anthropic") {
      const client = AnthropicLlmClient.tryCreate(env);
      if (!client) {
        if (!env.ANTHROPIC_API_KEY?.trim()) {
          throw new Error("ANTHROPIC_API_KEY is not set but LLM_PROVIDER=anthropic.");
        }
        if (!env.ANTHROPIC_MODEL_ID?.trim()) {
          throw new Error("ANTHROPIC_MODEL_ID is not set but LLM_PROVIDER=anthropic.");
        }
        throw new Error("Could not create Anthropic LLM client.");
      }
      return client;
    }
    if (raw === "gemini") {
      const client = GeminiLlmClient.tryCreate(env);
      if (!client) {
        if (!env.GEMINI_API_KEY?.trim()) {
          throw new Error("GEMINI_API_KEY is not set but LLM_PROVIDER=gemini.");
        }
        if (!env.GEMINI_MODEL_ID?.trim()) {
          throw new Error("GEMINI_MODEL_ID is not set but LLM_PROVIDER=gemini.");
        }
        throw new Error("Could not create Gemini LLM client.");
      }
      return client;
    }
    if (raw === "ollama") {
      const client = OllamaLlmClient.tryCreate(env);
      if (!client) {
        if (!env.OLLAMA_MODEL_ID?.trim()) {
          throw new Error("OLLAMA_MODEL_ID is not set but LLM_PROVIDER=ollama.");
        }
        throw new Error("Could not create Ollama LLM client.");
      }
      return client;
    }
    throw new Error(
      `Unsupported LLM_PROVIDER "${raw}". Use exactly "openai", "anthropic", "gemini", or "ollama".`,
    );
  }
}
