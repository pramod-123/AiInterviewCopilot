import { InterviewEvaluationServiceFactory } from "./evaluation/InterviewEvaluationServiceFactory.js";
import { SpeechToTextServiceFactory } from "./speech-to-text/SpeechToTextServiceFactory.js";
import { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";

/**
 * Builds {@link SpeechTranscriptionEvaluationOrchestrator} when STT is configured.
 */
export class SpeechTranscriptionEvaluationOrchestratorFactory {
  constructor(
    private readonly speechToTextFactory: SpeechToTextServiceFactory = new SpeechToTextServiceFactory(),
    private readonly evaluationFactory: InterviewEvaluationServiceFactory = new InterviewEvaluationServiceFactory(),
  ) {}

  tryCreate(): SpeechTranscriptionEvaluationOrchestrator | null {
    const stt = this.speechToTextFactory.create();
    if (!stt) {
      return null;
    }
    return new SpeechTranscriptionEvaluationOrchestrator(stt, this.evaluationFactory.create());
  }

  /**
   * @throws If no STT implementation is available for the current `STT_PROVIDER` / env (e.g. missing API key).
   */
  createOrThrow(): SpeechTranscriptionEvaluationOrchestrator {
    const stt = this.speechToTextFactory.create();
    if (!stt) {
      throw new Error(
        "Speech-to-text is not configured. Use STT_PROVIDER=remote (default) with OPENAI_API_KEY for Whisper via LlmClient, STT_PROVIDER=local with the whisper CLI, or fix your env.",
      );
    }
    return new SpeechTranscriptionEvaluationOrchestrator(stt, this.evaluationFactory.create());
  }
}
