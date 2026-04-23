import fsPromises from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import type { LlmClient, LlmCompletionResult, LlmJsonChatParams, LlmTokenUsage, LlmVisionJsonChatParams } from "./LlmClient.js";

const JSON_CHAT_TEMPERATURE = 0.4;

/**
 * Reject model ids that only exist for Live / native-audio (not `generateContent` / tool-calling).
 */
function assertGeminiModelIdSupportsTextGenerateContent(modelId: string): void {
  const m = modelId.toLowerCase();
  if (m.includes("native-audio")) {
    throw new Error(
      `GEMINI_MODEL_ID "${modelId}" is a native-audio / Live preview model and is not available for text generateContent (interview evaluation, tool-calling). ` +
        `Set GEMINI_MODEL_ID to a text model, for example: gemini-2.0-flash, gemini-2.5-flash, or gemini-2.5-pro. ` +
        `Use native-audio / Live model ids only for Gemini Live (e.g. geminiLiveModel in .app-runtime-config.json), not for GEMINI_MODEL_ID.`,
    );
  }
}

/**
 * Gemini API via `@google/genai` ({@link GoogleGenAI.models.generateContent}) for JSON chat and vision.
 * Tool agents use {@link ChatGoogleGenerativeAI} from `@langchain/google-genai` (legacy `@google/generative-ai` stack).
 *
 * Env: **`GEMINI_API_KEY`**, **`GEMINI_MODEL_ID`** — use a **text** model (e.g. `gemini-2.0-flash`), not Live / `native-audio` previews.
 * **`LLM_PROVIDER=gemini`**. Audio STT for `transcribeFromAudioFile` is not supported here — use the local Whisper CLI.
 */
export class GeminiLlmClient implements LlmClient {
  getProviderId(): string {
    return "gemini";
  }

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly modelId: string,
    /** Same key as {@link GoogleGenAI}; LangChain chat model requires it explicitly. */
    private readonly apiKey: string,
  ) {}

  getModelId(): string {
    return this.modelId;
  }

  toBaseChatModel(): BaseChatModel {
    return new ChatGoogleGenerativeAI({
      model: this.modelId,
      temperature: JSON_CHAT_TEMPERATURE,
      apiKey: this.apiKey,
    });
  }

  static tryCreate(env: NodeJS.ProcessEnv = process.env): GeminiLlmClient | null {
    const key = env.GEMINI_API_KEY?.trim();
    if (!key) {
      return null;
    }
    const modelId = env.GEMINI_MODEL_ID?.trim();
    if (!modelId) {
      return null;
    }
    assertGeminiModelIdSupportsTextGenerateContent(modelId);
    const ai = new GoogleGenAI({ apiKey: key });
    return new GeminiLlmClient(ai, modelId, key);
  }

  async transcribeFromAudioFile(_audioFilePath: string): Promise<SpeechTranscription> {
    throw new Error(
      "Gemini LlmClient does not implement audio.transcriptions; speech-to-text uses the local Whisper CLI (localWhisperExecutable, whisperModel in server/.app-runtime-config.json or merged env).",
    );
  }

  private static extractUsage(
    meta:
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        }
      | undefined,
  ): LlmTokenUsage | undefined {
    if (!meta) {
      return undefined;
    }
    const input = meta.promptTokenCount ?? 0;
    const output = meta.candidatesTokenCount ?? 0;
    const total = meta.totalTokenCount ?? input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  async completeJsonChat(params: LlmJsonChatParams): Promise<LlmCompletionResult> {
    const system = params.system;
    const response = await this.ai.models.generateContent({
      model: this.modelId,
      contents: params.user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        temperature: JSON_CHAT_TEMPERATURE,
        maxOutputTokens: params.maxOutputTokens,
      },
    });
    const text = response.text ?? "";
    return { text, usage: GeminiLlmClient.extractUsage(response.usageMetadata) };
  }

  async completeVisionJsonChat(params: LlmVisionJsonChatParams): Promise<LlmCompletionResult> {
    const imageBytes = await fsPromises.readFile(params.imagePngPath);
    const model = params.modelId ?? this.modelId;
    const system = params.system;
    const response = await this.ai.models.generateContent({
      model,
      contents: {
        role: "user",
        parts: [
          { text: params.userText },
          { inlineData: { mimeType: "image/png", data: imageBytes.toString("base64") } },
        ],
      },
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        temperature: JSON_CHAT_TEMPERATURE,
        maxOutputTokens: params.maxTokens,
      },
    });
    const text = response.text ?? "";
    return { text, usage: GeminiLlmClient.extractUsage(response.usageMetadata) };
  }
}
