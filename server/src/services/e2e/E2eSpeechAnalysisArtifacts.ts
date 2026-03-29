import fs from "node:fs/promises";
import path from "node:path";
import type { InterviewEvaluationPayload } from "../../types/interviewEvaluation.js";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import { transcriptionToSrt } from "../../video-pipeline/transcriptFormatting.js";
import type { SpeechTranscriptionEvaluationOrchestrator } from "../SpeechTranscriptionEvaluationOrchestrator.js";

/**
 * Writes `transcript.srt`, `speech-transcription.json`, and `interview-feedback.json` under an e2e output directory.
 */
export async function writeE2eSpeechAnalysisArtifacts(
  outputDir: string,
  jobId: string,
  transcription: SpeechTranscription,
  evaluation: InterviewEvaluationPayload,
): Promise<void> {
  const transcriptSrtPath = path.join(outputDir, "transcript.srt");
  const speechJsonPath = path.join(outputDir, "speech-transcription.json");
  const feedbackPath = path.join(outputDir, "interview-feedback.json");

  await fs.writeFile(transcriptSrtPath, transcriptionToSrt(transcription), "utf-8");
  await fs.writeFile(
    speechJsonPath,
    JSON.stringify(
      {
        jobId,
        providerId: transcription.providerId,
        modelId: transcription.modelId,
        language: transcription.language,
        durationSec: transcription.durationSec,
        fullText: transcription.fullText,
        segments: transcription.segments.map((s) => ({
          startSec: s.startSec,
          endSec: s.endSec,
          text: s.text,
        })),
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(
    feedbackPath,
    JSON.stringify(
      {
        jobId,
        evaluatedAt: new Date().toISOString(),
        evaluation,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

/**
 * Re-runs Whisper + rubric evaluation on `audio.wav` in an e2e directory and persists the standard artifact files.
 */
export class E2eDirectorySpeechAnalysisService {
  constructor(private readonly orchestrator: SpeechTranscriptionEvaluationOrchestrator) {}

  /**
   * @param outputDir — folder containing `audio.wav`
   * @returns jobId used for filenames and evaluation payload
   */
  async analyzeFromExistingWav(outputDir: string): Promise<{
    jobId: string;
    transcription: SpeechTranscription;
    evaluation: InterviewEvaluationPayload;
  }> {
    const jobId = `e2e-${path.basename(outputDir)}`;
    const audioWav = path.join(outputDir, "audio.wav");
    await fs.access(audioWav).catch(() => {
      throw new Error(`Missing audio.wav under ${outputDir}`);
    });

    const { transcription, evaluation } = await this.orchestrator.transcribeAndEvaluate(
      audioWav,
      jobId,
    );
    await writeE2eSpeechAnalysisArtifacts(outputDir, jobId, transcription, evaluation);
    return { jobId, transcription, evaluation };
  }
}
