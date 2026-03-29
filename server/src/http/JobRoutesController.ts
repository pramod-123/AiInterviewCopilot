import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { TranscriptPresenter } from "../presenters/TranscriptPresenter.js";
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
    private readonly db: PrismaClient,
    private readonly paths: AppPaths,
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

    await this.paths.ensureDataDirs();

    const id = randomUUID();
    const uploadDir = this.paths.jobUploadDir(id);
    await fs.mkdir(uploadDir, { recursive: true });

    const safeBase = path.basename(filename || "video").replace(/[^\w.\-()+ ]/g, "_");
    const storedName = safeBase || "video.bin";
    const filePath = path.join(uploadDir, storedName);

    await pipeline(part.file, createWriteStream(filePath));

    const stat = await fs.stat(filePath);

    await this.db.job.create({
      data: {
        id,
        status: "PENDING",
        interviewVideo: {
          create: {
            filePath,
            originalFilename: part.filename || storedName,
            mimeType: mime,
            sizeBytes: Number(stat.size),
          },
        },
      },
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

    const job = await this.db.job.findUnique({
      where: { id },
      include: {
        result: true,
        interviewVideo: true,
        transcriptSegments: { orderBy: TranscriptPresenter.defaultOrderBy },
      },
    });

    if (!job) {
      return void reply.code(404).send({ error: "Interview not found." });
    }

    const transcripts = TranscriptPresenter.toDtoList(job.transcriptSegments);

    if (!job.result) {
      const message =
        job.status === "FAILED"
          ? job.errorMessage ?? "Processing failed."
          : job.status === "PROCESSING"
            ? "Processing interview video (vision ROI, frames, OCR, speech, evaluation)…"
            : "Result not ready yet.";

      return void reply.code(202).send({
        id: job.id,
        status: job.status,
        message,
        errorMessage: job.errorMessage,
        transcripts,
      });
    }

    return void reply.send({
      id: job.id,
      status: job.status,
      result: job.result.payload,
      createdAt: job.result.createdAt.toISOString(),
      transcripts,
    });
  }
}
