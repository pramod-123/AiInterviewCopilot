import { LlmClientFactory } from "../llm/LlmClientFactory.js";
import type { ISpeechToTextService } from "./ISpeechToTextService.js";
import { LocalWhisperSpeechToTextService } from "./LocalWhisperSpeechToTextService.js";
import { LlmClientSpeechToTextService } from "./LlmClientSpeechToTextService.js";

/** Canonical `STT_PROVIDER` values (case-insensitive). */
export type SpeechToTextProviderName = "local" | "remote" | "none";

/**
 * Selects an {@link ISpeechToTextService} implementation from configuration.
 * Inject `env` in tests to avoid mutating `process.env`.
 */
export class SpeechToTextServiceFactory {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /**
   * - **`remote`** (default): OpenAI Whisper via {@link LlmClientFactory.tryCreate}(`"openai"`, env) and {@link LlmClientSpeechToTextService}.
   *   Optional chunking: **`REMOTE_STT_MAX_CHUNK_BYTES`**.
   * - **`local`**: Python `whisper` CLI (`LOCAL_WHISPER_*`).
   * - **`none`**: no STT (`null`).
   */
  create(): ISpeechToTextService | null {
    const mode = this.env.STT_PROVIDER?.toLowerCase().trim() ?? "remote";
    if (mode === "none") {
      return null;
    }
    if (mode === "local") {
      return LocalWhisperSpeechToTextService.tryCreate(this.env);
    }
    if (mode === "remote") {
      const llm = LlmClientFactory.tryCreate("openai", this.env);
      if (!llm) {
        return null;
      }
      return LlmClientSpeechToTextService.tryCreate(llm, this.env);
    }
    throw new Error(
      `Unsupported STT_PROVIDER "${mode}". Use exactly "remote", "local", or "none".`,
    );
  }
}
