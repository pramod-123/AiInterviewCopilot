import type { FastifyBaseLogger } from "fastify";
import type { ISpeechToTextService } from "../speech-to-text/ISpeechToTextService.js";
import type { LlmClient } from "../llm/LlmClient.js";
import type { SrtGenerationResult } from "../../types/srtGeneration.js";
import { renderSrt } from "./srtFormatting.js";
import type { ISrtGenerator, SrtGeneratorInput } from "./ISrtGenerator.js";

type LabelReply = { labels?: Array<{ i: number; speakerLabel?: string; speaker?: string }> };

export class LlmClientSrtGenerator implements ISrtGenerator {
  readonly providerId = "llm_client" as const;

  constructor(
    private readonly stt: ISpeechToTextService,
    private readonly llm: LlmClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  async generate(input: SrtGeneratorInput): Promise<SrtGenerationResult | null> {
    const tr = await this.stt.transcribeFromFile(input.audioFilePath);
    if (tr.segments.length === 0) {
      return null;
    }

    const lines = tr.segments
      .map((s, i) => `${i} [${s.startSec}-${s.endSec}s] ${s.text.trim()}`)
      .join("\n");

    let labels: LabelReply["labels"];
    try {
      const response = await this.llm.completeJsonChat({
        maxOutputTokens: 4000,
        system:
          'Output only JSON: {"labels":[{"i":number,"speakerLabel":"INTERVIEWER"|"INTERVIEWEE"}]}. Label technical interview transcript segments.',
        user: `Label speaker per segment:

${lines}`,
      });
      const parsed = JSON.parse(response.text) as LabelReply;
      labels = parsed.labels ?? [];
    } catch (err) {
      this.log.warn({ err }, "llm_client srt generator: labeling failed");
      return null;
    }

    const byI = new Map<number, string>(
      labels.map((x) => [x.i, x.speakerLabel ?? x.speaker ?? "INTERVIEWER"]),
    );

    const segments = tr.segments.map((s, i) => {
      const startMs = Math.max(0, Math.round(s.startSec * 1000));
      let endMs = Math.max(0, Math.round(s.endSec * 1000));
      if (endMs <= startMs) {
        endMs = startMs + 1;
      }
      const speakerLabel = byI.get(i) === "INTERVIEWEE" ? "INTERVIEWEE" : "INTERVIEWER";
      return {
        startMs,
        endMs,
        text: s.text.trim(),
        speakerLabel,
      };
    });

    const srt = renderSrt(segments);
    const out: SrtGenerationResult = {
      provider: "llm_client",
      model: this.llm.getModelId(),
      language: tr.language,
      audioSource: input.audioSource,
      segmentCount: segments.length,
      srt,
      segments,
    };
    return out;
  }
}
