import type { SrtGenerationResult } from "../../types/srtGeneration.js";

export type SrtGeneratorInput = {
  audioFilePath: string;
  audioSource: SrtGenerationResult["audioSource"];
};

export interface ISrtGenerator {
  readonly providerId: SrtGenerationResult["provider"];

  generate(input: SrtGeneratorInput): Promise<SrtGenerationResult | null>;
}
