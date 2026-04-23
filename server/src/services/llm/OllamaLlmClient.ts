import fsPromises from "node:fs/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOllama } from "@langchain/ollama";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import type { LlmClient, LlmCompletionResult, LlmJsonChatParams, LlmTokenUsage, LlmVisionJsonChatParams } from "./LlmClient.js";

const JSON_CHAT_TEMPERATURE = 0.2;

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

type OllamaChatResponse = {
  message?: { role?: string; content?: string };
  /** Prompt token count (Ollama chat response, when available). */
  prompt_eval_count?: number;
  /** Generated token count (Ollama chat response, when available). */
  eval_count?: number;
};

function normalizeOllamaBaseUrl(raw: string | undefined): string {
  const t = raw?.trim();
  if (!t) {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  return t.replace(/\/$/, "");
}

function usageFromOllamaResponse(data: OllamaChatResponse): LlmTokenUsage | undefined {
  if (data.prompt_eval_count == null && data.eval_count == null) {
    return undefined;
  }
  const inT = data.prompt_eval_count ?? 0;
  const outT = data.eval_count ?? 0;
  return { inputTokens: inT, outputTokens: outT, totalTokens: inT + outT };
}

/**
 * Local [Ollama](https://ollama.com) HTTP API (`/api/chat`). Tool-calling uses {@link ChatOllama} from `@langchain/ollama`.
 *
 * **Env**
 * - `OLLAMA_MODEL_ID` (required) — e.g. `llama3.2`, `qwen2.5`, or a vision id for
 *   {@link completeVisionJsonChat}.
 * - `OLLAMA_BASE_URL` (optional) — default `http://127.0.0.1:11434` (no trailing path).
 * - `LLM_PROVIDER=ollama`
 *
 * No API key. Audio STT is not supported here (local Whisper via runtime config).
 */
export class OllamaLlmClient implements LlmClient {
  getProviderId(): string {
    return "ollama";
  }

  constructor(
    private readonly modelId: string,
    private readonly baseUrl: string,
  ) {}

  getModelId(): string {
    return this.modelId;
  }

  toBaseChatModel(): BaseChatModel {
    return new ChatOllama({
      model: this.modelId,
      baseUrl: this.baseUrl,
      temperature: JSON_CHAT_TEMPERATURE,
    });
  }

  static tryCreate(env: NodeJS.ProcessEnv = process.env): OllamaLlmClient | null {
    const modelId = env.OLLAMA_MODEL_ID?.trim();
    if (!modelId) {
      return null;
    }
    const baseUrl = normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL);
    return new OllamaLlmClient(modelId, baseUrl);
  }

  private async postChat(body: unknown): Promise<OllamaChatResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama API ${res.status}: ${raw.slice(0, 500)}`);
    }
    let data: OllamaChatResponse;
    try {
      data = JSON.parse(raw) as OllamaChatResponse;
    } catch {
      throw new Error("Ollama returned non-JSON body.");
    }
    return data;
  }

  async completeJsonChat(params: LlmJsonChatParams): Promise<LlmCompletionResult> {
    const data = await this.postChat({
      model: this.modelId,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      stream: false,
      format: "json",
      options: {
        temperature: JSON_CHAT_TEMPERATURE,
        ...(params.maxOutputTokens != null ? { num_predict: params.maxOutputTokens } : {}),
      },
    });
    const text = data.message?.content ?? "";
    return { text, usage: usageFromOllamaResponse(data) };
  }

  async completeVisionJsonChat(params: LlmVisionJsonChatParams): Promise<LlmCompletionResult> {
    const imageBytes = await fsPromises.readFile(params.imagePngPath);
    const b64 = imageBytes.toString("base64");
    const model = params.modelId ?? this.modelId;
    const data = await this.postChat({
      model,
      messages: [
        { role: "system", content: params.system },
        {
          role: "user",
          content: params.userText,
          images: [b64],
        },
      ],
      stream: false,
      format: "json",
      options: {
        temperature: JSON_CHAT_TEMPERATURE,
        ...(params.maxTokens != null ? { num_predict: params.maxTokens } : {}),
      },
    });
    const text = data.message?.content ?? "";
    return { text, usage: usageFromOllamaResponse(data) };
  }

  async transcribeFromAudioFile(_audioFilePath: string): Promise<SpeechTranscription> {
    throw new Error(
      "Ollama LlmClient does not implement audio transcription; speech-to-text uses the local Whisper CLI (localWhisperExecutable, whisperModel in server/.app-runtime-config.json or merged env).",
    );
  }
}
