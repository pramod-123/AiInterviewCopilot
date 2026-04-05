import type { FastifyBaseLogger } from "fastify";
import type { IAppDao } from "../dao/IAppDao.js";
import { appDao } from "../db.js";
import { InterviewEvaluationServiceFactory } from "./evaluation/InterviewEvaluationServiceFactory.js";
import { SpeechToTextServiceFactory } from "./speech-to-text/SpeechToTextServiceFactory.js";
import { SpeechTranscriptionEvaluationOrchestrator } from "./SpeechTranscriptionEvaluationOrchestrator.js";

/**
 * Builds {@link SpeechTranscriptionEvaluationOrchestrator} from STT + evaluation configuration.
 */
export class SpeechTranscriptionEvaluationOrchestratorFactory {
  constructor(
    private readonly speechToTextFactory: SpeechToTextServiceFactory = new SpeechToTextServiceFactory(),
    private readonly evaluationFactory: InterviewEvaluationServiceFactory = new InterviewEvaluationServiceFactory(
      process.env,
      appDao,
    ),
    private readonly evaluationPromptLog?: FastifyBaseLogger,
    private readonly db: IAppDao = appDao,
  ) {}

  /**
   * @throws If `STT_PROVIDER` / API keys do not yield a working speech-to-text service.
   */
  create(): SpeechTranscriptionEvaluationOrchestrator {
    const stt = this.speechToTextFactory.create();
    return new SpeechTranscriptionEvaluationOrchestrator(
      stt,
      this.evaluationFactory.create(this.evaluationPromptLog),
      this.db,
    );
  }
}
