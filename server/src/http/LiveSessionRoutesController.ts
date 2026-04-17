import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppTransactionRunner } from "../db.js";
import { ensureInterviewDataLayout } from "../dao/file-store/ensureInterviewDataLayout.js";
import type { IAppDao } from "../dao/IAppDao.js";
import type { IAppFileStore } from "../dao/file-store/IAppFileStore.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { mergeLiveSessionChunksToPlayableWebmBuffer } from "../live-session/remuxConcatenatedWebm.js";
import {
  sendWebmBufferWithRange,
  sendWebmFileWithRange,
} from "../live-session/serveWebmRange.js";
import type { LiveSessionPostProcessor } from "../services/LiveSessionPostProcessor.js";
import { notifyPostProcessEvent } from "../live-session/postProcessEventsHub.js";
import { GeminiLiveBridgeHandler } from "../live-session/realtime/GeminiLiveBridgeHandler.js";

type SessionIdParams = { Params: { id: string } };

type CodeSnapshotBody = {
  code: string;
  /** Seconds since recording start (client); aligns with merged WebM and SRT. */
  offsetSeconds: number;
  capturedAt?: string;
};

type PatchLiveSessionBody = {
  question: string;
};

type CreateLiveSessionBody = {
  /** Default true. When false, no Gemini Live WebSocket; post-process uses offline STT only. */
  liveInterviewerEnabled?: boolean;
};

function resolveLiveInterviewerEnabledFromBody(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return true;
  }
  const v = (body as CreateLiveSessionBody).liveInterviewerEnabled;
  if (v === false) {
    return false;
  }
  return true;
}

export class LiveSessionRoutesController {
  constructor(
    private readonly db: IAppDao,
    private readonly runInTransaction: AppTransactionRunner,
    private readonly paths: AppPaths,
    private readonly files: IAppFileStore,
    private readonly liveSessionPostProcessor: LiveSessionPostProcessor,
  ) {}

  register(app: FastifyInstance): void {
    app.post<{ Body: CreateLiveSessionBody }>("/api/live-sessions", (request, reply) =>
      this.handleCreateSession(request, reply),
    );
    app.get("/api/live-sessions", (_request, reply) => this.handleListSessions(reply));
    app.get<SessionIdParams>("/api/live-sessions/:id/recording.webm", (request, reply) =>
      this.handleGetMergedRecording(request, reply),
    );
    app.get<SessionIdParams>("/api/live-sessions/:id", (request, reply) =>
      this.handleGetSession(request, reply),
    );
    app.patch<SessionIdParams>("/api/live-sessions/:id", (request, reply) =>
      this.handlePatchSession(request, reply),
    );
    app.post<SessionIdParams>("/api/live-sessions/:id/recording-clock", (request, reply) =>
      this.handleRecordingClock(request, reply),
    );
    app.post<SessionIdParams>("/api/live-sessions/:id/video-chunk", (request, reply) =>
      this.handleVideoChunk(app, request, reply),
    );
    app.post<SessionIdParams>("/api/live-sessions/:id/code-snapshot", (request, reply) =>
      this.handleCodeSnapshot(request, reply),
    );
    app.post<SessionIdParams>("/api/live-sessions/:id/end", (request, reply) =>
      this.handleEndSession(request, reply),
    );
    app.delete<SessionIdParams>("/api/live-sessions/:id", (request, reply) =>
      this.handleDeleteSession(request, reply),
    );

    app.get<SessionIdParams>(
      "/api/live-sessions/:id/realtime",{ websocket: true }, (socket, request) => 
        this.handleInterviewWebSocket(socket, request),
    );
  }

  /**
   * WebSocket `/api/live-sessions/:id/realtime` (Gemini Live voice interviewer).
   */
  private handleInterviewWebSocket(socket: WebSocket, request: FastifyRequest<SessionIdParams>): void {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      socket.close(1013, "GEMINI_API_KEY not configured");
      return;
    }
    const model = process.env.GEMINI_LIVE_MODEL?.trim();
    if (!model) {
      socket.close(1013, "GEMINI_LIVE_MODEL not configured");
      return;
    }
    const handler = new GeminiLiveBridgeHandler(request.params.id, this.db, this.paths, model, request.log, apiKey);
    void handler.connect(socket);
  }

  private async handleListSessions(reply: FastifyReply): Promise<void> {
    const sessions = await this.db.listLiveSessions();

    return void reply.send(
      sessions.map((s) => ({
        id: s.id,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        videoChunkCount: s.videoChunkCount,
        codeSnapshotCount: s.codeSnapshotCount,
        questionPreview: s.questionPreview,
        liveInterviewerEnabled: s.liveInterviewerEnabled,
        postProcessJob: s.postProcessJob,
      })),
    );
  }

  private async handleCreateSession(
    request: FastifyRequest<{ Body: CreateLiveSessionBody }>,
    reply: FastifyReply,
  ): Promise<void> {
    await ensureInterviewDataLayout(this.files, this.paths);
    const id = randomUUID();
    const dir = this.paths.liveSessionDir(id);
    await this.files.mkdir(path.join(dir, "video-chunks"), { recursive: true });

    const liveInterviewerEnabled = resolveLiveInterviewerEnabledFromBody(request.body);

    await this.db.createLiveSession({
      id,
      status: "ACTIVE",
      liveInterviewerEnabled,
    });

    return void reply.code(201).send({
      id,
      status: "ACTIVE",
      liveInterviewerEnabled,
      message:
        "Live session created. POST /api/live-sessions/:id/recording-clock immediately after MediaRecorder.start, then video chunks and code snapshots.",
    });
  }

  private async handleGetSession(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const session = await this.db.getLiveSession(id);
    if (!session) {
      return void reply.code(404).send({ error: "Live session not found." });
    }
    return void reply.send({
      id: session.id,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      videoChunkCount: session.videoChunkCount,
      codeSnapshotCount: session.codeSnapshotCount,
      question: session.question,
      liveInterviewerEnabled: session.liveInterviewerEnabled,
      /** Single playable WebM: per-chunk files are not standalone (only chunk 1 has WebM headers). */
      recordingWebmPath: `/api/live-sessions/${session.id}/recording.webm`,
      /** Interview job (STT + SRT + evaluation) when the session ends; `GET /api/interviews/:id` or `WS /api/live-sessions/:id/post-process-events`. */
      postProcessJob: session.postProcessJob,
    });
  }

  /**
   * Serves a **playable** merged WebM: chunks are concatenated on the server and **remuxed with ffmpeg**
   * (MediaRecorder timeslice blobs after the first are not valid standalone WebM).
   */
  private async handleGetMergedRecording(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const exists = await this.db.findLiveSessionIdForTools(id);
    if (!exists) {
      return void reply.code(404).send({ error: "Live session not found." });
    }

    const chunks = await this.db.findLiveVideoChunksOrdered(id);
    if (chunks.length === 0) {
      return void reply.code(404).send({ error: "No video chunks for this session." });
    }

    const webmPath = path.join(this.paths.liveSessionDir(id), "recording.webm");
    const st = await this.files.statOrNull(webmPath);
    if (st?.isFile && st.size > 0) {
      await sendWebmFileWithRange(request, reply, webmPath, id);
      return;
    }

    try {
      const playable = await mergeLiveSessionChunksToPlayableWebmBuffer(chunks.map((c) => c.filePath));
      await sendWebmBufferWithRange(request, reply, playable, id);
    } catch (err) {
      request.log.error({ err, id }, "live session merge/remux failed");
      return void reply.code(500).send({ error: "Failed to merge or remux recording (ffmpeg)." });
    }
  }

  private async handlePatchSession(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const body = request.body as PatchLiveSessionBody;
    if (!body || typeof body.question !== "string") {
      return void reply.code(400).send({ error: 'JSON body must include string field "question".' });
    }

    const session = await this.db.getLiveSessionPatch(id);
    if (!session) {
      return void reply.code(404).send({ error: "Live session not found." });
    }
    if (session.status !== "ACTIVE") {
      return void reply.code(410).send({ error: "Live session has ended." });
    }

    await this.db.updateLiveSessionQuestion(id, body.question);

    return void reply.send({
      id,
      message: "Session updated.",
      questionLength: body.question.length,
    });
  }

  /**
   * Marks server wall time for MediaRecorder t≈0 (call from the extension immediately after `tabRecorder.start`).
   * Without this, Gemini/tab alignment uses the first uploaded chunk’s `createdAt`, which can be late by the
   * timeslice (e.g. 10s), shifting mixed dialogue audio on the timeline.
   */
  private async handleRecordingClock(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const session = await this.db.getLiveSessionPatch(id);
    if (!session) {
      return void reply.code(404).send({ error: "Live session not found." });
    }
    if (session.status !== "ACTIVE") {
      return void reply.code(410).send({ error: "Live session has ended." });
    }
    const wallMs = Date.now();
    await this.db.setLiveSessionRecordingStartedAtWallMsIfUnset(id, wallMs);
    return void reply.code(204).send();
  }

  private async handleVideoChunk(
    app: FastifyInstance,
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const part = await request.file();
    if (!part) {
      return void reply.code(400).send({ error: 'Missing multipart field "chunk" (video blob).' });
    }
    if (part.fieldname !== "chunk") {
      return void reply.code(400).send({ error: 'Expected field name "chunk".' });
    }

    const mime = part.mimetype || "application/octet-stream";

    try {
      const { sequence, sizeBytes } = await this.runInTransaction(async (tx) => {
        const session = await tx.getLiveSessionPatch(id);
        if (!session) {
          throw new SessionError(404, "Live session not found.");
        }
        if (session.status !== "ACTIVE") {
          throw new SessionError(410, "Live session has ended; video chunks are no longer accepted.");
        }

        const maxSeq = await tx.aggregateMaxLiveVideoSequence(id);
        const sequence = maxSeq + 1;
        const storedName = `chunk-${String(sequence).padStart(6, "0")}.webm`;
        const filePath = path.join(this.paths.liveSessionDir(id), "video-chunks", storedName);

        await this.files.writeStreamFromReadable(filePath, part.file);
        const stat = await this.files.stat(filePath);

        await tx.createLiveVideoChunk({
          sessionId: id,
          sequence,
          filePath,
          mimeType: mime,
          sizeBytes: Number(stat.size),
        });

        return { sequence, filePath, sizeBytes: Number(stat.size) };
      });

      return void reply.code(201).send({
        sessionId: id,
        sequence,
        sizeBytes,
        message: "Video chunk stored.",
      });
    } catch (e: unknown) {
      if (e instanceof SessionError) {
        return void reply.code(e.status).send({ error: e.message });
      }
      app.log.error({ err: e, id }, "live session video chunk failed");
      return void reply.code(500).send({ error: "Failed to store video chunk." });
    }
  }

  private async handleCodeSnapshot(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const body = request.body as CodeSnapshotBody;
    if (!body || typeof body.code !== "string") {
      return void reply.code(400).send({ error: 'JSON body must include string field "code".' });
    }
    if (
      typeof body.offsetSeconds !== "number" ||
      !Number.isFinite(body.offsetSeconds) ||
      body.offsetSeconds < 0
    ) {
      return void reply
        .code(400)
        .send({ error: 'JSON body must include non-negative finite number "offsetSeconds" (seconds since recording start).' });
    }

    let capturedAt: Date;
    if (body.capturedAt) {
      capturedAt = new Date(body.capturedAt);
      if (Number.isNaN(capturedAt.getTime())) {
        return void reply.code(400).send({ error: "Invalid capturedAt ISO date." });
      }
    } else {
      capturedAt = new Date();
    }

    try {
      const sequence = await this.runInTransaction(async (tx) => {
        const session = await tx.getLiveSessionPatch(id);
        if (!session) {
          throw new SessionError(404, "Live session not found.");
        }
        if (session.status !== "ACTIVE") {
          throw new SessionError(410, "Live session has ended; code snapshots are no longer accepted.");
        }

        const maxSeq = await tx.aggregateMaxLiveCodeSnapshotSequence(id);
        const sequence = maxSeq + 1;

        await tx.createLiveCodeSnapshot({
          sessionId: id,
          sequence,
          code: body.code,
          offsetSeconds: body.offsetSeconds,
          capturedAt,
        });
        return sequence;
      });

      return void reply.code(201).send({
        sessionId: id,
        sequence,
        offsetSeconds: body.offsetSeconds,
        message: "Code snapshot stored.",
      });
    } catch (e: unknown) {
      if (e instanceof SessionError) {
        return void reply.code(e.status).send({ error: e.message });
      }
      throw e;
    }
  }

  private async handleEndSession(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const session = await this.db.getLiveSessionPatch(id);
    if (!session) {
      return void reply.code(404).send({ error: "Live session not found." });
    }
    if (session.status === "ENDED") {
      const existingJobId = await this.db.findFirstJobIdByLiveSessionId(id);
      if (!existingJobId) {
        this.liveSessionPostProcessor.scheduleAfterEnd(id);
        return void reply.send({
          id,
          status: "ENDED",
          message:
            "Session was already ended; post-processing scheduled (no job linked — e.g. after CLI reset). Poll GET /api/live-sessions/:id for postProcessJob then GET /api/interviews/:jobId.",
        });
      }
      return void reply.send({ id, status: "ENDED", message: "Session was already ended." });
    }

    await this.db.updateLiveSessionStatus(id, "ENDED");

    this.liveSessionPostProcessor.scheduleAfterEnd(id);

    return void reply.send({
      id,
      status: "ENDED",
      message:
        "Live session closed; further uploads are rejected. Post-processing (merge, STT, transcript.srt) runs in the background — poll GET /api/live-sessions/:id for postProcessJob then GET /api/interviews/:jobId.",
    });
  }

  /**
   * Removes the live session and its linked post-process job from the database (cascades dependent rows),
   * then best-effort deletes `data/live-sessions/<id>/` and `data/uploads/<jobId>/` when a job existed.
   */
  private async handleDeleteSession(
    request: FastifyRequest<SessionIdParams>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const exists = await this.db.findLiveSessionIdForTools(id);
    if (!exists) {
      return void reply.code(404).send({ error: "Live session not found." });
    }
    const jobId = await this.db.findFirstJobIdByLiveSessionId(id);
    const deleted = await this.runInTransaction(async (tx) => tx.deleteLiveSessionById(id));
    if (deleted === 0) {
      return void reply.code(404).send({ error: "Live session not found." });
    }
    notifyPostProcessEvent(id, { type: "post_process", phase: "deleted" });
    if (jobId != null && jobId.length > 0) {
      try {
        await this.files.rm(this.paths.jobUploadDir(jobId), { recursive: true, force: true });
      } catch (err) {
        request.log.warn({ err, id, jobId }, "live session delete: failed to remove job upload directory");
      }
    }
    try {
      await this.files.rm(this.paths.liveSessionDir(id), { recursive: true, force: true });
    } catch (err) {
      request.log.warn({ err, id }, "live session delete: failed to remove session directory");
    }
    return void reply.code(204).send();
  }
}

class SessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
