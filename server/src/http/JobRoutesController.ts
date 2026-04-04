import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureInterviewDataLayout } from "../dao/file-store/ensureInterviewDataLayout.js";
import type { IAppDao } from "../dao/IAppDao.js";
import type { IAppFileStore } from "../dao/file-store/IAppFileStore.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { CodeSnapshotPresenter } from "../presenters/CodeSnapshotPresenter.js";
import { SpeechUtterancePresenter } from "../presenters/SpeechUtterancePresenter.js";
import type { VideoJobProcessor } from "../services/VideoJobProcessor.js";

type InterviewIdParams = { Params: { id: string } };

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".webm",
]);

/** Interview API accepts **video only** (audiovisual file): demuxed audio → STT + rubric; video → ROI, frames, OCR. */
function classifyInterviewVideo(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith("video/")) {
    return true;
  }
  if (m === "application/octet-stream") {
    const ext = path.extname(filename || "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  }
  return false;
}

/**
 * Two public endpoints: submit interview **video**, poll for result.
 * Audio-only files are rejected — every job runs full video + audio processing.
 */
export class JobRoutesController {
  constructor(
    private readonly db: IAppDao,
    private readonly paths: AppPaths,
    private readonly files: IAppFileStore,
    private readonly videoJobProcessor: VideoJobProcessor,
  ) {}

  register(app: FastifyInstance): void {
    app.post("/api/interviews", (request, reply) => this.handlePostInterview(app, request, reply));
    app.get<InterviewIdParams>("/api/interviews/:id", (request, reply) =>
      this.handleGetInterview(request, reply),
    );
  }

  private async handlePostInterview(
    app: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const part = await request.file();
    if (!part) {
      return void reply.code(400).send({ error: "Missing file field (expected multipart field \"file\")." });
    }

    const mime = part.mimetype || "application/octet-stream";
    const filename = part.filename || "";
    if (!classifyInterviewVideo(mime, filename)) {
      return void reply.code(415).send({
        error:
          "Interview uploads must be **video** files (video/* or a known video extension with application/octet-stream: .mp4, .mov, .mkv, .avi, .m4v, .webm). Audio-only uploads are not supported — the pipeline requires both picture and sound.",
      });
    }

    await ensureInterviewDataLayout(this.files, this.paths);

    const id = randomUUID();
    const uploadDir = this.paths.jobUploadDir(id);
    await this.files.mkdir(uploadDir, { recursive: true });

    const safeBase = path.basename(filename || "video").replace(/[^\w.\-()+ ]/g, "_");
    const storedName = safeBase || "video.bin";
    const filePath = path.join(uploadDir, storedName);

    await this.files.writeStreamFromReadable(filePath, part.file);

    const stat = await this.files.stat(filePath);

    await this.db.createJobPendingWithInterviewVideo({
      id,
      filePath,
      originalFilename: part.filename || storedName,
      mimeType: mime,
      sizeBytes: Number(stat.size),
    });

    void this.videoJobProcessor.process(id).catch((err: unknown) => {
      app.log.error({ err, id }, "Background video interview job failed");
    });

    return void reply.code(201).send({
      id,
      status: "PENDING",
      message:
        "Interview video accepted (vision ROI, screen OCR, speech transcription, evaluation). Poll GET /api/interviews/:id for the result.",
    });
  }

  private async handleGetInterview(
    request: FastifyRequest<InterviewIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;

    const job = await this.db.findJobDetail(id);

    if (!job) {
      return void reply.code(404).send({ error: "Interview not found." });
    }

    const speechTranscript = SpeechUtterancePresenter.toDtoList(job.speechUtterances);
    const codeSnapshots = CodeSnapshotPresenter.toDtoList(job.codeSnapshots);

    if (!job.result) {
      const fromLiveSession = job.liveSession != null;
      const message =
        job.status === "FAILED"
          ? job.errorMessage ?? "Processing failed."
          : job.status === "PROCESSING"
            ? fromLiveSession
              ? "Processing live session (merged recording, speech-to-text, code-snapshot timeline, evaluation)…"
              : "Processing interview video (vision ROI, frames, OCR, speech, evaluation)…"
            : "Result not ready yet.";

      return void reply.code(202).send({
        id: job.id,
        status: job.status,
        message,
        errorMessage: job.errorMessage,
        liveSessionId: job.liveSessionId,
        speechTranscript,
        codeSnapshots,
        transcripts: speechTranscript,
      });
    }

    return void reply.send({
      id: job.id,
      status: job.status,
      result: job.result.payload,
      createdAt: job.result.createdAt.toISOString(),
      liveSessionId: job.liveSessionId,
      speechTranscript,
      codeSnapshots,
      transcripts: speechTranscript,
    });
  }
}
