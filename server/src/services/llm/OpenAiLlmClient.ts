import fsPromises from "node:fs/promises";
import type OpenAI from "openai";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import type { LlmClient, LlmJsonChatParams, LlmVisionJsonChatParams } from "./LlmClient.js";
import {
  DEFAULT_OPENAI_STT_MODEL,
  transcribeOneWavOpenAi,
  tryCreateOpenAiClient,
} from "./openAiClient.js";

export class OpenAiLlmClient implements LlmClient {
  getProviderId(): string {
    return "openai";
  }

  constructor(
    private readonly client: OpenAI,
    private readonly modelId: string,
    private readonly speechModelId: string = DEFAULT_OPENAI_STT_MODEL,
  ) {}

  getModelId(): string {
    return this.modelId;
  }

  static tryCreate(env: NodeJS.ProcessEnv = process.env): OpenAiLlmClient | null {
    const client = tryCreateOpenAiClient(env);
    if (!client) {
      return null;
    }
    const modelId = env.OPENAI_EVAL_MODEL?.trim() || "gpt-4o-mini";
    const speechModelId = env.OPENAI_STT_MODEL?.trim() || DEFAULT_OPENAI_STT_MODEL;
    return new OpenAiLlmClient(client, modelId, speechModelId);
  }

  async transcribeFromAudioFile(audioFilePath: string): Promise<SpeechTranscription> {
    return transcribeOneWavOpenAi(this.client, this.speechModelId, audioFilePath, "openai");
  }

  async completeJsonChat(params: LlmJsonChatParams): Promise<{ text: string }> {
    const completion = await this.client.chat.completions.create({
      model: this.modelId,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      temperature: params.temperature ?? 0.4,
    });
    const text = completion.choices[0]?.message?.content ?? "";
    return { text };
  }

  async completeVisionJsonChat(params: LlmVisionJsonChatParams): Promise<{ text: string }> {
    const imageBytes = await fsPromises.readFile(params.imagePngPath);
    const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    const model = params.modelId ?? this.modelId;
    const completion = await this.client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.system },
        {
          role: "user",
          content: [
            { type: "text", text: params.userText },
            {
              type: "image_url",
              image_url: { url: dataUrl, detail: "high" },
            },
          ],
        },
      ],
      temperature: params.temperature ?? 0.4,
      max_tokens: params.maxTokens ?? 4096,
    });
    const text = completion.choices[0]?.message?.content ?? "";
    return { text };
  }
}
