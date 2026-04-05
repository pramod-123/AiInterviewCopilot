import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { appDao, runAppTransaction } from "./db.js";
import { buildFastifyLoggerOptions } from "./logging/buildFastifyLoggerOptions.js";
import { appFileStore } from "./appFileStore.js";
import { JobRoutesController } from "./http/JobRoutesController.js";
import { LiveSessionRoutesController } from "./http/LiveSessionRoutesController.js";
import { AppPaths } from "./infrastructure/AppPaths.js";
import { assertMandatoryInterviewApiConfig } from "./services/mandatoryInterviewApiEnv.js";
import { InterviewEvaluationServiceFactory } from "./services/evaluation/InterviewEvaluationServiceFactory.js";
import { OpenAiLlmClient } from "./services/llm/OpenAiLlmClient.js";
import { SpeechTranscriptionEvaluationOrchestratorFactory } from "./services/SpeechTranscriptionEvaluationOrchestratorFactory.js";
import { SpeechToTextServiceFactory } from "./services/speech-to-text/SpeechToTextServiceFactory.js";
import { LiveSessionPostProcessor } from "./services/LiveSessionPostProcessor.js";
import { VideoJobProcessor } from "./services/VideoJobProcessor.js";
import { GeminiLiveWebSocketPlugin } from "./http/GeminiLiveWebSocketPlugin.js";
import { LiveSessionPostProcessWebSocketPlugin } from "./http/LiveSessionPostProcessWebSocketPlugin.js";
import { EditorRoiDetectionService } from "./video-pipeline/editorRoiDetection.js";
import { SrtGeneratorFactory } from "./services/srt-generator/SrtGeneratorFactory.js";

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
    this.app = Fastify({ logger: buildFastifyLoggerOptions() });
    this.paths = new AppPaths();
    this.speechToTextFactory = speechToTextFactory ?? new SpeechToTextServiceFactory();
    this.evaluationFactory =
      evaluationFactory ?? new InterviewEvaluationServiceFactory(process.env, appDao);
  }

  get instance(): FastifyInstance {
    return this.app;
  }

  async registerPlugins(): Promise<void> {
    // Restrict CORS to localhost origins only (http/https on 127.0.0.1 or localhost, any port)
    // and Chrome extension origins, which is all that should ever call this local-only server.
    await this.app.register(cors, {
      origin: (origin, cb) => {
        if (
          !origin ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
          /^chrome-extension:\/\//.test(origin)
        ) {
          cb(null, true);
        } else {
          cb(new Error("CORS: origin not allowed"), false);
        }
      },
    });
    await this.app.register(multipart, {
      limits: { fileSize: 500 * 1024 * 1024 },
    });
    await this.app.register(websocket, {
      options: { maxPayload: 8 * 1024 * 1024 },
    });
  }

  registerRoutes(): void {
    const speechAnalysis = new SpeechTranscriptionEvaluationOrchestratorFactory(
      this.speechToTextFactory,
      this.evaluationFactory,
      this.app.log,
    ).create();
    const visionOpenAiLlm = OpenAiLlmClient.tryCreate(process.env);
    // ffmpeg/ffprobe/tesseract, STT + eval, vision ROI — fail before accepting uploads.
    assertMandatoryInterviewApiConfig(speechAnalysis, visionOpenAiLlm);
    const roiDetection = new EditorRoiDetectionService(visionOpenAiLlm!);
    const videoProcessor = new VideoJobProcessor(
      appDao,
      runAppTransaction,
      this.paths,
      appFileStore,
      speechAnalysis,
      this.app.log,
      roiDetection,
    );
    const liveSessionPostProcessor = new LiveSessionPostProcessor(
      appDao,
      runAppTransaction,
      this.paths,
      appFileStore,
      speechAnalysis,
      this.app.log,
      new SrtGeneratorFactory(this.paths, this.app.log).create(),
    );
    const liveSessionRoutes = new LiveSessionRoutesController(
      appDao,
      runAppTransaction,
      this.paths,
      appFileStore,
      liveSessionPostProcessor,
    );
    liveSessionRoutes.register(this.app);
    new LiveSessionPostProcessWebSocketPlugin(appDao).register(this.app);

    const jobRoutes = new JobRoutesController(appDao, this.paths, appFileStore, videoProcessor);
    jobRoutes.register(this.app);
  }

  /**
   * Gemini Live API bridge — WebSocket `/api/live-sessions/:id/realtime`.
   * Skipped unless both `GEMINI_API_KEY` and `GEMINI_LIVE_MODEL` are set.
   */
  async registerGeminiLiveWebSocket(): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    const model = process.env.GEMINI_LIVE_MODEL?.trim();
    if (!apiKey || !model) {
      this.app.log.info(
        "Gemini Live WebSocket not registered — set GEMINI_API_KEY and GEMINI_LIVE_MODEL to enable voice interviewer.",
      );
      return;
    }
    await new GeminiLiveWebSocketPlugin(appDao, this.paths).register(this.app);
  }

  async listen(port: number, host: string): Promise<void> {
    await this.app.listen({ port, host });
    const startedAt = new Date();
    const url = `http://${host}:${port}`;
    this.app.log.info(
      {
        url,
        host,
        port,
        node: process.version,
        startedAt: startedAt.toISOString(),
      },
      `Server listening on ${url} (started at ${startedAt.toISOString()})`,
    );
  }
}
