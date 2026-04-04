import type { FastifyBaseLogger } from "fastify";
import type { AppPaths } from "../../infrastructure/AppPaths.js";
import type { DiarizationPipelineResult } from "../../types/diarization.js";
import type { SrtGenerationResult } from "../../types/srtGeneration.js";
import {
  applySpeakerRoleMappingToSrtResult,
  parseSpeakerRoleMappingJson,
  pickWhisperXSpeakerSamples,
} from "../diarization/whisperXSpeakerRoleMapper.js";
import { runWhisperXDiarization } from "../diarization/runWhisperXDiarization.js";
import { LlmClientFactory } from "../llm/LlmClientFactory.js";
import { renderSrt } from "./srtFormatting.js";
import type { ISrtGenerator, SrtGeneratorInput } from "./ISrtGenerator.js";

function srtGenerationFromWhisperxDiarization(raw: DiarizationPipelineResult): SrtGenerationResult {
  const segments = raw.segments.map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text,
    speakerLabel: s.speaker,
  }));
  return {
    provider: "whisperx",
    model: raw.model,
    language: raw.language,
    audioSource: raw.audioSource,
    segmentCount: segments.length,
    srt: renderSrt(segments),
    segments,
  };
}

/**
 * WhisperX ASR + pyannote diarization. When there are two or more diarized speakers and
 * {@link LlmClientFactory.tryCreate} succeeds (`EVALUATION_PROVIDER`), maps `SPEAKER_xx` → INTERVIEWER / INTERVIEWEE.
 */
export class WhisperXSrtGenerator implements ISrtGenerator {
  readonly providerId = "whisperx" as const;

  constructor(
    private readonly paths: AppPaths,
    private readonly log: FastifyBaseLogger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async maybeMapPyannoteSpeakersToInterviewRoles(result: SrtGenerationResult): Promise<SrtGenerationResult> {
    if (result.segments.length === 0) {
      return result;
    }
    const llm = LlmClientFactory.tryCreate(this.env);
    if (!llm) {
      return result;
    }

    const unique = [
      ...new Set(result.segments.map((s) => s.speakerLabel.trim()).filter((x) => x.length > 0)),
    ];
    if (unique.length < 2) {
      return result;
    }

    const samples = pickWhisperXSpeakerSamples(result.segments);
    const lines: string[] = [];
    for (const sp of unique) {
      const quotes = samples.get(sp) ?? [];
      lines.push(`## ${sp}`);
      if (quotes.length === 0) {
        lines.push("(no text in sample window)");
      } else {
        quotes.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
      }
    }

    const system = `You label speakers in a technical coding interview recording.
Acoustic diarization produced arbitrary ids like SPEAKER_00, SPEAKER_01 (order is meaningless).

Map each id to exactly one role:
- INTERVIEWER: asks questions, explains the problem, probes, gives hints, runs the interview.
- INTERVIEWEE: the candidate — answers, thinks aloud, describes their approach, codes.

Output only one JSON object with this shape (no markdown, no prose):
{"mapping":{"SPEAKER_00":"INTERVIEWER","SPEAKER_01":"INTERVIEWEE"},"rationale":"one short sentence"}

Rules:
- Every id listed in the user message must appear as a key in "mapping".
- Values must be exactly "INTERVIEWER" or "INTERVIEWEE".
- If audio mixes tab capture + synthetic interviewer voice, use content: problem statements and clarifying questions → INTERVIEWER; solution walkthrough from the human → INTERVIEWEE.`;

    const user = `Map these diarization ids using the sample utterances:

${lines.join("\n")}

Ids to map (keys required): ${JSON.stringify(unique)}`;

    let text: string;
    try {
      const res = await llm.completeJsonChat({
        system,
        user,
        temperature: 0.1,
        maxOutputTokens: 1500,
      });
      text = res.text;
    } catch (err) {
      this.log.warn({ err }, "WhisperX speaker role labeling: LLM request failed");
      return result;
    }

    const mapping = parseSpeakerRoleMappingJson(text, unique);
    if (!mapping) {
      this.log.warn(
        { preview: text.slice(0, 500) },
        "WhisperX speaker role labeling: could not parse mapping JSON",
      );
      return result;
    }

    const remapped = applySpeakerRoleMappingToSrtResult(result, mapping);
    this.log.info(
      { mapping, segmentCount: remapped.segmentCount },
      "WhisperX speaker ids mapped to INTERVIEWER / INTERVIEWEE.",
    );
    return remapped;
  }

  async generate(input: SrtGeneratorInput): Promise<SrtGenerationResult | null> {
    const raw = await runWhisperXDiarization({
      paths: this.paths,
      wavPath: input.audioFilePath,
      outJsonPath: `/tmp/whisperx-srt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      audioSource: input.audioSource,
      log: this.log,
    });
    if (!raw) {
      return null;
    }
    const base = srtGenerationFromWhisperxDiarization(raw);
    return this.maybeMapPyannoteSpeakersToInterviewRoles(base);
  }
}
