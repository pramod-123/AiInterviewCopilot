import fsPromises from "node:fs/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import type { LlmClient, LlmCompletionResult, LlmJsonChatParams, LlmTokenUsage, LlmVisionJsonChatParams } from "./LlmClient.js";

type AnthropicMessageResponse = {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

const ANTHROPIC_JSON_TEMPERATURE = 0.2;

/** LangChain defaults `topP`/`topK` to -1; merge this into `messages.create` to omit them. */
const STRIP_DEFAULT_TOP_P_TOP_K = {
  top_p: undefined,
  top_k: undefined,
};

/**
 * Longer prefixes first. `null` = omit `temperature` on the REST body / LangChain. Otherwise same as
 * {@link ANTHROPIC_JSON_TEMPERATURE}.
 */
const ANTHROPIC_TEMPERATURE_BY_PREFIX: ReadonlyArray<{
  prefix: string;
  temperature: number | null;
}> = [
  { prefix: "claude-sonnet-4-", temperature: null },
  { prefix: "claude-opus-4-", temperature: null },
  { prefix: "claude-4-", temperature: null },
];

function temperatureForAnthropicModelId(modelId: string): number | null {
  const m = modelId.trim().toLowerCase();
  for (const r of ANTHROPIC_TEMPERATURE_BY_PREFIX) {
    if (m.startsWith(r.prefix)) {
      return r.temperature;
    }
  }
  return ANTHROPIC_JSON_TEMPERATURE;
}

/**
 * Anthropic Messages API via `fetch` (no extra dependency). Responses must be JSON-only (enforced in system prompt).
 */
export class AnthropicLlmClient implements LlmClient {
  getProviderId(): string {
    return "anthropic";
  }

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
  ) {}

  getModelId(): string {
    return this.modelId;
  }

  toBaseChatModel(): BaseChatModel {
    return new ChatAnthropic({
      model: this.modelId,
      anthropicApiKey: this.apiKey,
      temperature: temperatureForAnthropicModelId(this.modelId),
      invocationKwargs: STRIP_DEFAULT_TOP_P_TOP_K,
    });
  }

  static tryCreate(env: NodeJS.ProcessEnv = process.env): AnthropicLlmClient | null {
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) {
      return null;
    }
    const modelId = env.ANTHROPIC_MODEL_ID?.trim();
    if (!modelId) {
      return null;
    }
    return new AnthropicLlmClient(key, modelId);
  }

  private static extractUsage(data: AnthropicMessageResponse): LlmTokenUsage | undefined {
    if (!data.usage) return undefined;
    const input = data.usage.input_tokens ?? 0;
    const output = data.usage.output_tokens ?? 0;
    return { inputTokens: input, outputTokens: output, totalTokens: input + output };
  }

  async completeJsonChat(params: LlmJsonChatParams): Promise<LlmCompletionResult> {
    const t = temperatureForAnthropicModelId(this.modelId);
    const system = `${params.system}\n\nYou must respond with a single valid JSON object only — no markdown fences, no explanation outside the JSON.`;
    const body = {
      model: this.modelId,
      max_tokens: params.maxOutputTokens ?? 8192,
      system,
      messages: [{ role: "user", content: params.user }],
      ...(t === null ? {} : { temperature: t }),
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${raw.slice(0, 500)}`);
    }

    let data: AnthropicMessageResponse;
    try {
      data = JSON.parse(raw) as AnthropicMessageResponse;
    } catch {
      throw new Error("Anthropic returned non-JSON body.");
    }

    const block = data.content?.find((c) => c.type === "text");
    return { text: block?.text ?? "", usage: AnthropicLlmClient.extractUsage(data) };
  }

  async completeVisionJsonChat(params: LlmVisionJsonChatParams): Promise<LlmCompletionResult> {
    const imageBytes = await fsPromises.readFile(params.imagePngPath);
    const system = `${params.system}\n\nYou must respond with a single valid JSON object only — no markdown fences, no explanation outside the JSON.`;
    const model = params.modelId ?? this.modelId;
    const t = temperatureForAnthropicModelId(model);
    const visionBody = {
      model,
      max_tokens: params.maxTokens ?? 4096,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: params.userText },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageBytes.toString("base64"),
              },
            },
          ],
        },
      ],
      ...(t === null ? {} : { temperature: t }),
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(visionBody),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${raw.slice(0, 500)}`);
    }

    let data: AnthropicMessageResponse;
    try {
      data = JSON.parse(raw) as AnthropicMessageResponse;
    } catch {
      throw new Error("Anthropic returned non-JSON body.");
    }

    const block = data.content?.find((c) => c.type === "text");
    return { text: block?.text ?? "", usage: AnthropicLlmClient.extractUsage(data) };
  }

  async transcribeFromAudioFile(_audioFilePath: string): Promise<SpeechTranscription> {
    throw new Error(
      "Anthropic LlmClient does not support audio transcription; speech-to-text uses the local Whisper CLI (localWhisperExecutable, whisperModel in server/.app-runtime-config.json or merged env).",
    );
  }
}
