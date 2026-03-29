import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { JobRoutesController } from "./http/JobRoutesController.js";
import { AppPaths } from "./infrastructure/AppPaths.js";
import { assertMandatoryInterviewApiConfig } from "./services/mandatoryInterviewApiEnv.js";
import { InterviewEvaluationServiceFactory } from "./services/evaluation/InterviewEvaluationServiceFactory.js";
import { LlmClientFactory } from "./services/llm/LlmClientFactory.js";
import { SpeechTranscriptionEvaluationOrchestratorFactory } from "./services/SpeechTranscriptionEvaluationOrchestratorFactory.js";
import { SpeechToTextServiceFactory } from "./services/speech-to-text/SpeechToTextServiceFactory.js";
import { VideoJobProcessor } from "./services/VideoJobProcessor.js";
import { EditorRoiDetectionService } from "./video-pipeline/editorRoiDetection.js";

/**
 * Composes Fastify plugins and route controllers for the local interview API.
 */
export class InterviewCopilotServer {
  private readonly app: FastifyInstance;
  private readonly paths: AppPaths;
  private readonly speechToTextFactory: SpeechToTextServiceFactory;
  private readonly evaluationFactory: InterviewEvaluationServiceFactory;

  constructor(
    speechToTextFactory?: SpeechToTextServiceFactory,
    evaluationFactory?: InterviewEvaluationServiceFactory,
  ) {
    this.app = Fastify({ logger: true });
    this.paths = new AppPaths();
    this.speechToTextFactory = speechToTextFactory ?? new SpeechToTextServiceFactory();
    this.evaluationFactory = evaluationFactory ?? new InterviewEvaluationServiceFactory();
  }

  get instance(): FastifyInstance {
    return this.app;
  }

  async registerPlugins(): Promise<void> {
    await this.app.register(cors, { origin: true });
    await this.app.register(multipart, {
      limits: { fileSize: 500 * 1024 * 1024 },
    });
  }

  registerRoutes(): void {
    const speechAnalysis = new SpeechTranscriptionEvaluationOrchestratorFactory(
      this.speechToTextFactory,
      this.evaluationFactory,
    ).tryCreate();
    const visionOpenAiLlm = LlmClientFactory.tryCreate("openai", process.env);
    // ffmpeg/ffprobe/tesseract, STT + eval, vision ROI — fail before accepting uploads.
    assertMandatoryInterviewApiConfig(speechAnalysis, visionOpenAiLlm);
    const roiDetection = new EditorRoiDetectionService(visionOpenAiLlm!);
    const videoProcessor = new VideoJobProcessor(
      prisma,
      this.paths,
      speechAnalysis,
      this.app.log,
      roiDetection,
    );
    const jobRoutes = new JobRoutesController(prisma, this.paths, videoProcessor);
    jobRoutes.register(this.app);
  }

  async listen(port: number, host: string): Promise<void> {
    await this.app.listen({ port, host });
    this.app.log.info(`Server listening on http://${host}:${port}`);
  }
}
