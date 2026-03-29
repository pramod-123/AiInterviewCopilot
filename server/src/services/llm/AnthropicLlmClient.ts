import fsPromises from "node:fs/promises";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import type { LlmClient, LlmJsonChatParams, LlmVisionJsonChatParams } from "./LlmClient.js";

type AnthropicMessageResponse = {
  content?: Array<{ type: string; text?: string }>;
};

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

  static tryCreate(env: NodeJS.ProcessEnv = process.env): AnthropicLlmClient | null {
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) {
      return null;
    }
    const modelId =
      env.ANTHROPIC_EVAL_MODEL?.trim() || "claude-3-5-haiku-20241022";
    return new AnthropicLlmClient(key, modelId);
  }

  async completeJsonChat(params: LlmJsonChatParams): Promise<{ text: string }> {
    const system = `${params.system}\n\nYou must respond with a single valid JSON object only — no markdown fences, no explanation outside the JSON.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: params.user }],
        temperature: params.temperature ?? 0.4,
      }),
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
    return { text: block?.text ?? "" };
  }

  async completeVisionJsonChat(params: LlmVisionJsonChatParams): Promise<{ text: string }> {
    const imageBytes = await fsPromises.readFile(params.imagePngPath);
    const system = `${params.system}\n\nYou must respond with a single valid JSON object only — no markdown fences, no explanation outside the JSON.`;
    const model = params.modelId ?? this.modelId;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
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
        temperature: params.temperature ?? 0.4,
      }),
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
    return { text: block?.text ?? "" };
  }

  async transcribeFromAudioFile(_audioFilePath: string): Promise<SpeechTranscription> {
    throw new Error(
      "Anthropic LlmClient does not support audio transcription; use STT_PROVIDER=remote with OPENAI_API_KEY (Whisper) or STT_PROVIDER=local.",
    );
  }
}
