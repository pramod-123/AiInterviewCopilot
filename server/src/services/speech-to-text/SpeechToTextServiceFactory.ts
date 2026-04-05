import { OpenAiLlmClient } from "../llm/OpenAiLlmClient.js";
import type { ISpeechToTextService } from "./ISpeechToTextService.js";
import { LocalWhisperSpeechToTextService } from "./LocalWhisperSpeechToTextService.js";
import { LlmClientSpeechToTextService } from "./LlmClientSpeechToTextService.js";

/** Canonical `STT_PROVIDER` values (case-insensitive). */
export type SpeechToTextProviderName = "local" | "remote";

/**
 * Selects an {@link ISpeechToTextService} implementation from configuration.
 * Inject `env` in tests to avoid mutating `process.env`.
 */
export class SpeechToTextServiceFactory {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /**
   * - **`remote`** (default): OpenAI Whisper via {@link OpenAiLlmClient.tryCreate}(env) and {@link LlmClientSpeechToTextService}.
   *   Optional chunking: **`REMOTE_STT_MAX_CHUNK_BYTES`**.
   * - **`local`**: Python `whisper` CLI (`LOCAL_WHISPER_*`).
   */
  create(): ISpeechToTextService {
    const mode = this.env.STT_PROVIDER?.toLowerCase().trim() ?? "remote";
    if (mode === "none") {
      throw new Error(
        'STT_PROVIDER cannot be "none" for this API. Use "remote" (default) with OPENAI_API_KEY or "local" with the whisper CLI on PATH.',
      );
    }
    if (mode === "local") {
      return LocalWhisperSpeechToTextService.create(this.env);
    }
    if (mode === "remote") {
      const llm = OpenAiLlmClient.tryCreate(this.env);
      if (!llm) {
        throw new Error("OPENAI_API_KEY is not set but STT_PROVIDER=remote.");
      }
      return LlmClientSpeechToTextService.create(llm, this.env);
    }
    throw new Error(
      `Unsupported STT_PROVIDER "${mode}". Use exactly "remote", "local", or omit STT_PROVIDER for remote.`,
    );
  }
}
