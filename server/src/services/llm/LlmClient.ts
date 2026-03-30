import type { SpeechTranscription } from "../../types/speechTranscription.js";

/** Token counts from an LLM completion call. */
export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cached input tokens (OpenAI prompt_tokens_details.cached_tokens). */
  cachedTokens?: number;
  /** Reasoning tokens used by reasoning models (OpenAI completion_tokens_details.reasoning_tokens). */
  reasoningTokens?: number;
};

/** Result of an LLM completion call including the response text and optional token usage. */
export type LlmCompletionResult = {
  text: string;
  usage?: LlmTokenUsage;
};

/**
 * Minimal contract for rubric / JSON-style chat completion. Provider SDKs implement this (OpenAI, Anthropic, …).
 */
export type LlmJsonChatParams = {
  system: string;
  user: string;
  temperature?: number;
  /** Cap on completion tokens (evaluation JSON can be long). */
  maxOutputTokens?: number;
};

/** Multimodal JSON-style completion (e.g. editor ROI from a PNG). */
export type LlmVisionJsonChatParams = {
  system: string;
  userText: string;
  /** Local PNG path (read by the client implementation). */
  imagePngPath: string;
  temperature?: number;
  maxTokens?: number;
  /** Override the chat model for this call (optional). */
  modelId?: string;
};

export interface LlmClient {
  /** Vendor id for wiring / checks (must match {@link InterviewEvaluationServiceConfig.provider} when used together). */
  getProviderId(): string;

  /** Chat model this client was configured with (used for API calls and evaluation payloads). */
  getModelId(): string;

  /** Ask for a single JSON object (providers differ; callers parse with {@link parseInterviewEvaluationJson}). */
  completeJsonChat(params: LlmJsonChatParams): Promise<LlmCompletionResult>;

  /**
   * Vision + text → single JSON object in the reply text (e.g. editor crop). Implementations without vision must throw.
   */
  completeVisionJsonChat(params: LlmVisionJsonChatParams): Promise<LlmCompletionResult>;

  /**
   * Speech transcription from a WAV path (e.g. OpenAI Whisper). Implementations that lack audio STT must throw.
   */
  transcribeFromAudioFile(audioFilePath: string): Promise<SpeechTranscription>;
}
