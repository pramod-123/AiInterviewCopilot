import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { appDao, runAppTransaction } from "./db.js";
import { buildFastifyLogger } from "./logging/buildFastifyLogger.js";
import { appFileStore } from "./appFileStore.js";
import { JobRoutesController } from "./http/JobRoutesController.js";
import { LiveSessionRoutesController } from "./http/LiveSessionRoutesController.js";
import { AppPaths } from "./infrastructure/AppPaths.js";
import { assertMandatoryInterviewApiConfig } from "./services/mandatoryInterviewApiEnv.js";
import { InterviewEvaluationServiceFactory } from "./services/evaluation/InterviewEvaluationServiceFactory.js";
import { SpeechTranscriptionEvaluationOrchestratorFactory } from "./services/SpeechTranscriptionEvaluationOrchestratorFactory.js";
import { SpeechToTextServiceFactory } from "./services/speech-to-text/SpeechToTextServiceFactory.js";
import { LiveSessionPostProcessor } from "./services/LiveSessionPostProcessor.js";
import { LiveSessionPostProcessWebSocketPlugin } from "./http/LiveSessionPostProcessWebSocketPlugin.js";
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
    this.app = Fastify({
      loggerInstance: buildFastifyLogger(),
      disableRequestLogging: true,
    });
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
    assertMandatoryInterviewApiConfig(speechAnalysis);
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

    const jobRoutes = new JobRoutesController(appDao);
    jobRoutes.register(this.app);
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
