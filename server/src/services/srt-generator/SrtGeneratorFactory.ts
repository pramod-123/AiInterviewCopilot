import type { FastifyBaseLogger } from "fastify";
import type { AppPaths } from "../../infrastructure/AppPaths.js";
import { LlmClientFactory } from "../llm/LlmClientFactory.js";
import { SpeechToTextServiceFactory } from "../speech-to-text/SpeechToTextServiceFactory.js";
import type { ISrtGenerator } from "./ISrtGenerator.js";
import { LlmClientSrtGenerator } from "./LlmClientSrtGenerator.js";
import {
  resolveSrtGeneratorProviderFromEnv,
  type SrtGeneratorProviderId,
} from "../utilities/resolveSrtGeneratorProviderFromEnv.js";
import { WhisperXSrtGenerator } from "./WhisperXSrtGenerator.js";

export type SrtGeneratorProvider = SrtGeneratorProviderId;

export class SrtGeneratorFactory {
  constructor(
    private readonly paths: AppPaths,
    private readonly log: FastifyBaseLogger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  create(): ISrtGenerator | null {
    const provider = resolveSrtGeneratorProviderFromEnv(this.env);
    if (provider === "none") {
      throw new Error(
        'SRT/diarization cannot be disabled for this API: unset SRT_GENERATOR_PROVIDER=none and DIARIZATION_PROVIDER=none, and set one of whisperx, openai / openai_semantic, or llm_client.',
      );
    }
    if (provider === "whisperx") {
      return new WhisperXSrtGenerator(this.paths, this.log, this.env);
    }

    const stt = new SpeechToTextServiceFactory(this.env).create();
    if (!stt) {
      this.log.warn("SRT generator llm_client disabled: no STT provider available.");
      return null;
    }
    const llm = LlmClientFactory.tryCreate(this.env);
    if (!llm) {
      this.log.warn("SRT generator llm_client disabled: no LLM client configured.");
      return null;
    }
    return new LlmClientSrtGenerator(stt, llm, this.log);
  }
}
