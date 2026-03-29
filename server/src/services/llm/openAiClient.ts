import { createReadStream } from "node:fs";
import OpenAI, { APIConnectionError, APIError, RateLimitError } from "openai";
import { SpeechSegment, SpeechTranscription } from "../../types/speechTranscription.js";

export const DEFAULT_OPENAI_STT_MODEL = "whisper-1";

/** Shared OpenAI SDK client when `OPENAI_API_KEY` is set (STT, ROI, {@link OpenAiLlmClient}). */
export function tryCreateOpenAiClient(env: NodeJS.ProcessEnv = process.env): OpenAI | null {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    return null;
  }
  return new OpenAI({ apiKey: key });
}

type VerboseWhisperPayload = {
  text?: string;
  duration?: number;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
};

function asVerbosePayload(raw: unknown): VerboseWhisperPayload {
  if (raw && typeof raw === "object") {
    return raw as VerboseWhisperPayload;
  }
  return {};
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries for long Whisper uploads when the connection drops mid-request (`ECONNRESET`, etc.). */
function readOpenAiSttRetryConfig(): { maxAttempts: number; baseDelayMs: number } {
  const maxRaw = process.env.OPENAI_STT_MAX_RETRIES?.trim();
  const baseRaw = process.env.OPENAI_STT_RETRY_BASE_MS?.trim();
  let maxAttempts = maxRaw ? Number(maxRaw) : 6;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    maxAttempts = 6;
  }
  if (maxAttempts > 12) {
    maxAttempts = 12;
  }
  let baseDelayMs = baseRaw ? Number(baseRaw) : 2000;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 200) {
    baseDelayMs = 2000;
  }
  return { maxAttempts, baseDelayMs };
}

function isRetriableOpenAiTranscriptionError(err: unknown): boolean {
  if (err instanceof APIConnectionError) {
    return true;
  }
  if (err instanceof RateLimitError) {
    return true;
  }
  if (err instanceof APIError && typeof err.status === "number") {
    const s = err.status;
    return s === 408 || s === 429 || (s >= 502 && s <= 504);
  }
  return false;
}

function speechTranscriptionFromVerboseJson(
  raw: unknown,
  providerId: string,
  whisperModelId: string,
): SpeechTranscription {
  const payload = asVerbosePayload(raw);
  const durationSec = payload.duration ?? 0;
  const language = payload.language ?? null;
  const fullText = payload.text?.trim() ? payload.text.trim() : null;

  let segments = (payload.segments ?? []).map(
    (s) => new SpeechSegment(s.start, s.end, s.text.trim()),
  );

  if (segments.length === 0 && fullText) {
    const endSec = durationSec > 0 ? durationSec : 0.001;
    segments = [new SpeechSegment(0, endSec, fullText)];
  }

  return new SpeechTranscription(
    segments,
    durationSec,
    language,
    fullText,
    providerId,
    whisperModelId,
  );
}

/**
 * One WAV file through OpenAI’s `audio.transcriptions` (Whisper) API → {@link SpeechTranscription}.
 * Retries on transient network failures and common server/rate-limit responses (configurable via
 * `OPENAI_STT_MAX_RETRIES`, `OPENAI_STT_RETRY_BASE_MS`).
 */
export async function transcribeOneWavOpenAi(
  client: OpenAI,
  whisperModelId: string,
  audioFilePath: string,
  providerId: string,
): Promise<SpeechTranscription> {
  const { maxAttempts, baseDelayMs } = readOpenAiSttRetryConfig();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await client.audio.transcriptions.create({
        file: createReadStream(audioFilePath),
        model: whisperModelId,
        response_format: "verbose_json",
      });
      return speechTranscriptionFromVerboseJson(raw, providerId, whisperModelId);
    } catch (err) {
      lastErr = err;
      const retriable = isRetriableOpenAiTranscriptionError(err);
      if (!retriable || attempt === maxAttempts) {
        throw err;
      }
      const backoff = Math.min(
        90_000,
        baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 750),
      );
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[openai-stt] attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 200)}); retrying in ${backoff}ms\n`,
      );
      await sleepMs(backoff);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
