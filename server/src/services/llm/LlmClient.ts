import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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
 * Minimal contract for rubric / JSON-style chat completion. Provider SDKs implement this (OpenAI, Anthropic, Gemini, …).
 */
export type LlmJsonChatParams = {
  system: string;
  user: string;
  /** Cap on completion tokens (evaluation JSON can be long). */
  maxOutputTokens?: number;
};

/** Multimodal JSON-style completion (vision + text when the model supports it). */
export type LlmVisionJsonChatParams = {
  system: string;
  userText: string;
  /** Local PNG path (read by the client implementation). */
  imagePngPath: string;
  maxTokens?: number;
  /** Override the chat model for this call (optional). */
  modelId?: string;
};

export interface LlmClient {
  /** Vendor id for wiring / checks (must match {@link InterviewEvaluationServiceConfig.provider} when used together). */
  getProviderId(): string;

  /** Chat model this client was configured with (used for API calls and evaluation payloads). */
  getModelId(): string;

  /**
   * LangChain {@link BaseChatModel} for tool-calling agents and other Runnables (same underlying model as {@link getModelId}).
   * Sampling temperature is fixed in each {@link LlmClient} implementation (not configured from callers).
   */
  toBaseChatModel(): BaseChatModel;

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
