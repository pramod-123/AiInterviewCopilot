import type { SpeechTranscription } from "../../types/speechTranscription.js";
import type { LlmClient } from "../llm/LlmClient.js";
import type { ISpeechToTextService } from "./ISpeechToTextService.js";
import { transcribeWavByTimeWindows } from "./wavChunkTranscription.js";

const DEFAULT_MAX_CHUNK_BYTES = 20 * 1024 * 1024;

function parsePositiveBytesEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Expected a positive number of bytes, got "${raw}".`);
  }
  return Math.floor(n);
}

/**
 * Remote STT via {@link LlmClient.transcribeFromAudioFile} (Whisper API on {@link OpenAiLlmClient}).
 * Chunk cap: **`REMOTE_STT_MAX_CHUNK_BYTES`** (optional).
 */
export class LlmClientSpeechToTextService implements ISpeechToTextService {
  readonly providerId: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES,
  ) {
    this.providerId = `remote:${this.llm.getProviderId()}`;
  }

  static tryCreate(
    llm: LlmClient,
    env: NodeJS.ProcessEnv = process.env,
  ): LlmClientSpeechToTextService {
    const maxChunkBytes = parsePositiveBytesEnv(
      env.REMOTE_STT_MAX_CHUNK_BYTES,
      DEFAULT_MAX_CHUNK_BYTES,
    );
    return new LlmClientSpeechToTextService(llm, maxChunkBytes);
  }

  async transcribeFromFile(audioFilePath: string): Promise<SpeechTranscription> {
    return transcribeWavByTimeWindows({
      wavPath: audioFilePath,
      maxChunkBytes: this.maxChunkBytes,
      logLabel: `[stt:remote:${this.llm.getProviderId()}]`,
      transcribeChunk: (chunkPath) => this.llm.transcribeFromAudioFile(chunkPath),
    });
  }
}
