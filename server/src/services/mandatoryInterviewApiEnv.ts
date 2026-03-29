import { execSync } from "node:child_process";
import type { LlmClient } from "./llm/LlmClient.js";
import type { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";

/**
 * Tools required for every interview video job (frame + audio path).
 */
export function assertMandatoryVideoPipelineBinaries(): void {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
    execSync("ffprobe -version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "Interview API requires ffmpeg and ffprobe on PATH (demux, WAV, frames, crop).",
    );
  }
  try {
    execSync("tesseract --version", { stdio: "pipe" });
  } catch {
    throw new Error("Interview API requires tesseract on PATH (screen OCR).");
  }
}

/**
 * Vision ROI for editor crop. Call with the same OpenAI {@link LlmClient} instance you pass to {@link EditorRoiDetectionService}.
 * @throws If `visionOpenAiLlm` is null (e.g. missing `OPENAI_API_KEY`).
 */
export function assertMandatoryVisionRoi(
  visionOpenAiLlm: LlmClient | null,
): asserts visionOpenAiLlm is LlmClient {
  if (!visionOpenAiLlm) {
    throw new Error(
      "Interview API requires vision ROI for editor detection. Set OPENAI_API_KEY.",
    );
  }
}

/**
 * @param visionOpenAiLlm — same OpenAI {@link LlmClient} used for {@link EditorRoiDetectionService} (create once with `LlmClientFactory.tryCreate("openai", env)`).
 * @throws If the HTTP interview API cannot run full video+audio+vision processing.
 */
export function assertMandatoryInterviewApiConfig(
  speechAnalysis: SpeechTranscriptionEvaluationOrchestrator | null,
  visionOpenAiLlm: LlmClient | null,
): asserts speechAnalysis is SpeechTranscriptionEvaluationOrchestrator {
  assertMandatoryVideoPipelineBinaries();

  if (!speechAnalysis) {
    throw new Error(
      "Interview API requires speech-to-text and evaluation. Set STT_PROVIDER=remote (default) or local, OPENAI_API_KEY for remote Whisper, and EVALUATION_PROVIDER.",
    );
  }

  assertMandatoryVisionRoi(visionOpenAiLlm);
}
