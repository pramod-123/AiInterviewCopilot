import type { SpeechTranscription } from "../../types/speechTranscription.js";

/**
 * Pluggable speech-to-text backend (OpenAI, Deepgram, local Whisper, etc.).
 */
export interface ISpeechToTextService {
  /** Provider id stored on {@link SpeechTranscription} and in job results. */
  readonly providerId: string;

  transcribeFromFile(audioFilePath: string): Promise<SpeechTranscription>;
}
