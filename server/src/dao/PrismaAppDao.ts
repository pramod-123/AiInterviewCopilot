import type { Prisma, PrismaClient } from "@prisma/client";
import type { IAppDao } from "./IAppDao.js";
import type {
  CodeSnapshotItem,
  CodeSnapshotSource,
  JobDetail,
  JobEvaluationLoad,
  JobStatus,
  JobWithInterviewAudio,
  JobWithInterviewVideo,
  JsonValue,
  LiveSessionContent,
  LiveSessionGetItem,
  LiveSessionListItem,
  LiveSessionPatchItem,
  LiveSessionStatus,
  LiveVideoChunkItem,
  SpeechUtteranceInsert,
  SpeechUtteranceItem,
} from "./dto.js";

type Db = PrismaClient | Prisma.TransactionClient;

function assertRoot(client: PrismaClient | null, op: string): asserts client is PrismaClient {
  if (!client) {
    throw new Error(`${op} is only available on the root DAO, not inside a transaction`);
  }
}

function toSpeechItems(rows: { id: string; jobId: string; startMs: number; endMs: number; text: string; sequence: number; speakerLabel: string | null }[]): SpeechUtteranceItem[] {
  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    startMs: r.startMs,
    endMs: r.endMs,
    text: r.text,
    sequence: r.sequence,
    speakerLabel: r.speakerLabel,
  }));
}

function toCodeRows(
  rows: { id: string; jobId: string; source: CodeSnapshotSource; offsetMs: number; text: string; sequence: number }[],
): CodeSnapshotItem[] {
  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    source: r.source,
    offsetMs: r.offsetMs,
    text: r.text,
    sequence: r.sequence,
  }));
}

/**
 * Prisma-backed {@link IAppDao}. Root instances also support connect/disconnect, SQLite pragmas,
 * and `runTransaction` — those are not part of {@link IAppDao} and are invoked via `db.ts` only.
 */
export class PrismaAppDao implements IAppDao {
  constructor(
    private readonly db: Db,
    private readonly root: PrismaClient | null,
  ) {}

  /** Root client: exposes lifecycle + `$transaction` (use through `db.ts`, not as `IAppDao`). */
  static createRoot(prisma: PrismaClient): PrismaAppDao {
    return new PrismaAppDao(prisma, prisma);
  }

  async connect(): Promise<void> {
    assertRoot(this.root, "connect");
    await this.root.$connect();
  }

  async disconnect(): Promise<void> {
    assertRoot(this.root, "disconnect");
    await this.root.$disconnect();
  }

  async executePragmaBusyTimeoutMs(): Promise<void> {
    assertRoot(this.root, "executePragmaBusyTimeoutMs");
    await this.root.$executeRawUnsafe("PRAGMA busy_timeout = 30000");
  }

  async runTransaction<R>(fn: (tx: IAppDao) => Promise<R>): Promise<R> {
    assertRoot(this.root, "runTransaction");
    return this.root.$transaction(async (tx) => fn(new PrismaAppDao(tx, null)));
  }

  async findFirstJobIdByLiveSessionId(liveSessionId: string): Promise<string | null> {
    const row = await this.db.job.findFirst({
      where: { liveSessionId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async findJobIdIfExists(jobId: string): Promise<string | null> {
    const row = await this.db.job.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async findJobDetail(jobId: string): Promise<JobDetail | null> {
    const job = await this.db.job.findUnique({
      where: { id: jobId },
      include: {
        result: true,
        interviewVideo: true,
        speechUtterances: { orderBy: [{ sequence: "asc" }, { startMs: "asc" }] },
        codeSnapshots: { orderBy: [{ sequence: "asc" }, { offsetMs: "asc" }] },
        liveSession: { select: { id: true } },
      },
    });
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      status: job.status as JobStatus,
      errorMessage: job.errorMessage,
      liveSessionId: job.liveSessionId,
      result: job.result
        ? { payload: job.result.payload as JsonValue, createdAt: job.result.createdAt }
        : null,
      interviewVideo: job.interviewVideo ? { filePath: job.interviewVideo.filePath } : null,
      speechUtterances: toSpeechItems(job.speechUtterances),
      codeSnapshots: toCodeRows(job.codeSnapshots),
      liveSession: job.liveSession,
    };
  }

  async findJobWithInterviewAudio(jobId: string): Promise<JobWithInterviewAudio | null> {
    const job = await this.db.job.findUnique({
      where: { id: jobId },
      include: { interviewAudio: true },
    });
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      interviewAudio: job.interviewAudio
        ? {
            jobId: job.interviewAudio.jobId,
            filePath: job.interviewAudio.filePath,
            durationSeconds: job.interviewAudio.durationSeconds,
          }
        : null,
    };
  }

  async findJobWithInterviewVideo(jobId: string): Promise<JobWithInterviewVideo | null> {
    const job = await this.db.job.findUnique({
      where: { id: jobId },
      include: { interviewVideo: true },
    });
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      interviewVideo: job.interviewVideo ? { jobId: job.interviewVideo.jobId, filePath: job.interviewVideo.filePath } : null,
    };
  }

  async findJobLiveSessionId(jobId: string): Promise<{ liveSessionId: string | null } | null> {
    const job = await this.db.job.findUnique({
      where: { id: jobId },
      select: { liveSessionId: true },
    });
    return job;
  }

  async findJobForEvaluationLoad(jobId: string): Promise<JobEvaluationLoad | null> {
    const job = await this.db.job.findUnique({
      where: { id: jobId },
      include: {
        speechUtterances: { orderBy: [{ sequence: "asc" }, { startMs: "asc" }] },
        liveSession: {
          select: {
            question: true,
            codeSnapshots: {
              orderBy: { sequence: "asc" },
              select: { offsetSeconds: true, code: true },
            },
          },
        },
      },
    });
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      liveSessionId: job.liveSessionId,
      speechUtterances: toSpeechItems(job.speechUtterances),
      liveSession: job.liveSession,
    };
  }

  async createJobPendingWithInterviewVideo(params: {
    id: string;
    filePath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<void> {
    await this.db.job.create({
      data: {
        id: params.id,
        status: "PENDING",
        interviewVideo: {
          create: {
            filePath: params.filePath,
            originalFilename: params.originalFilename,
            mimeType: params.mimeType,
            sizeBytes: params.sizeBytes,
          },
        },
      },
    });
  }

  async createJobFailedLiveSession(params: {
    id: string;
    liveSessionId: string;
    errorMessage: string;
  }): Promise<void> {
    await this.db.job.create({
      data: {
        id: params.id,
        status: "FAILED",
        errorMessage: params.errorMessage,
        liveSessionId: params.liveSessionId,
      },
    });
  }

  async createJobProcessingLiveSessionWithVideo(params: {
    id: string;
    liveSessionId: string;
    videoFilePath: string;
    videoSizeBytes: number;
  }): Promise<void> {
    await this.db.job.create({
      data: {
        id: params.id,
        status: "PROCESSING",
        errorMessage: null,
        liveSessionId: params.liveSessionId,
        interviewVideo: {
          create: {
            filePath: params.videoFilePath,
            originalFilename: "recording.webm",
            mimeType: "video/webm",
            sizeBytes: params.videoSizeBytes,
          },
        },
      },
    });
  }

  async updateJob(
    jobId: string,
    data: { status?: JobStatus; errorMessage?: string | null },
  ): Promise<void> {
    await this.db.job.update({
      where: { id: jobId },
      data,
    });
  }

  async upsertJobProcessingShell(jobId: string): Promise<void> {
    await this.db.job.upsert({
      where: { id: jobId },
      create: { id: jobId, status: "PROCESSING" },
      update: {},
    });
  }

  async deleteJobsByLiveSessionId(liveSessionId: string): Promise<number> {
    const r = await this.db.job.deleteMany({ where: { liveSessionId } });
    return r.count;
  }

  async listLiveSessions(): Promise<LiveSessionListItem[]> {
    const sessions = await this.db.interviewLiveSession.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: {
        _count: { select: { videoChunks: true, codeSnapshots: true } },
        postProcessJob: { select: { id: true, status: true, errorMessage: true } },
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      status: s.status as LiveSessionStatus,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      videoChunkCount: s._count.videoChunks,
      codeSnapshotCount: s._count.codeSnapshots,
      questionPreview: s.question && s.question.length > 0 ? s.question.slice(0, 240) : null,
      liveInterviewerEnabled: s.liveInterviewerEnabled,
      postProcessJob: s.postProcessJob
        ? {
            id: s.postProcessJob.id,
            status: s.postProcessJob.status as JobStatus,
            errorMessage: s.postProcessJob.errorMessage,
          }
        : null,
    }));
  }

  async createLiveSession(params: {
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
  }): Promise<void> {
    await this.db.interviewLiveSession.create({
      data: {
        id: params.id,
        status: params.status,
        liveInterviewerEnabled: params.liveInterviewerEnabled,
      },
    });
  }

  async createLiveSessionWithChunksAndSnapshots(params: {
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
    question: string | null;
    videoChunks: { sequence: number; filePath: string; mimeType: string; sizeBytes: number }[];
    codeSnapshots: { sequence: number; code: string; offsetSeconds: number; capturedAt: Date }[];
  }): Promise<void> {
    await this.db.interviewLiveSession.create({
      data: {
        id: params.id,
        status: params.status,
        liveInterviewerEnabled: params.liveInterviewerEnabled,
        question: params.question,
        videoChunks: { create: params.videoChunks },
        codeSnapshots: { create: params.codeSnapshots },
      },
    });
  }

  async getLiveSession(id: string): Promise<LiveSessionGetItem | null> {
    const session = await this.db.interviewLiveSession.findUnique({
      where: { id },
      include: {
        _count: { select: { videoChunks: true, codeSnapshots: true } },
        postProcessJob: { select: { id: true, status: true, errorMessage: true } },
      },
    });
    if (!session) {
      return null;
    }
    return {
      id: session.id,
      status: session.status as LiveSessionStatus,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      videoChunkCount: session._count.videoChunks,
      codeSnapshotCount: session._count.codeSnapshots,
      question: session.question,
      liveInterviewerEnabled: session.liveInterviewerEnabled,
      postProcessJob: session.postProcessJob
        ? {
            id: session.postProcessJob.id,
            status: session.postProcessJob.status as JobStatus,
            errorMessage: session.postProcessJob.errorMessage,
          }
        : null,
    };
  }

  async getLiveSessionPatch(id: string): Promise<LiveSessionPatchItem | null> {
    const session = await this.db.interviewLiveSession.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!session) {
      return null;
    }
    return { id: session.id, status: session.status as LiveSessionStatus };
  }

  async getLiveSessionContent(id: string): Promise<LiveSessionContent | null> {
    const session = await this.db.interviewLiveSession.findUnique({
      where: { id },
      include: {
        codeSnapshots: { orderBy: { sequence: "asc" } },
      },
    });
    if (!session) {
      return null;
    }
    return {
      id: session.id,
      status: session.status as LiveSessionStatus,
      question: session.question,
      liveInterviewerEnabled: session.liveInterviewerEnabled,
      codeSnapshots: session.codeSnapshots.map((c) => ({
        offsetSeconds: c.offsetSeconds,
        code: c.code,
        sequence: c.sequence,
      })),
    };
  }

  async updateLiveSessionQuestion(id: string, question: string): Promise<void> {
    await this.db.interviewLiveSession.update({
      where: { id },
      data: { question },
    });
  }

  async updateLiveSessionStatus(id: string, status: LiveSessionStatus): Promise<void> {
    await this.db.interviewLiveSession.update({
      where: { id },
      data: { status },
    });
  }

  async getLiveSessionForGeminiWs(id: string): Promise<{
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
    question: string | null;
  } | null> {
    const live = await this.db.interviewLiveSession.findUnique({ where: { id } });
    if (!live) {
      return null;
    }
    return {
      id: live.id,
      status: live.status as LiveSessionStatus,
      liveInterviewerEnabled: live.liveInterviewerEnabled,
      question: live.question,
    };
  }

  async findLiveSessionIdForTools(id: string): Promise<{ id: string } | null> {
    return this.db.interviewLiveSession.findUnique({
      where: { id },
      select: { id: true },
    });
  }

  async getLiveSessionQuestionText(id: string): Promise<{ question: string | null } | null> {
    return this.db.interviewLiveSession.findUnique({
      where: { id },
      select: { question: true },
    });
  }

  async getLiveSessionMetadataForTools(id: string): Promise<{
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
    hasQuestionSaved: boolean;
    postProcessJobId: string | null;
    videoChunkCount: number;
    liveCodeSnapshotCount: number;
  } | null> {
    const row = await this.db.interviewLiveSession.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        liveInterviewerEnabled: true,
        createdAt: true,
        updatedAt: true,
        question: true,
        _count: {
          select: { videoChunks: true, codeSnapshots: true },
        },
        postProcessJob: { select: { id: true } },
      },
    });
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      status: row.status as LiveSessionStatus,
      liveInterviewerEnabled: row.liveInterviewerEnabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hasQuestionSaved: (row.question?.trim() ?? "").length > 0,
      postProcessJobId: row.postProcessJob?.id ?? null,
      videoChunkCount: row._count.videoChunks,
      liveCodeSnapshotCount: row._count.codeSnapshots,
    };
  }

  async deleteLiveSessionById(id: string): Promise<void> {
    await this.db.interviewLiveSession.deleteMany({ where: { id } });
  }

  async findLatestLiveSessionId(): Promise<string | null> {
    const row = await this.db.interviewLiveSession.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async findLiveVideoChunksOrdered(sessionId: string): Promise<LiveVideoChunkItem[]> {
    const chunks = await this.db.liveVideoChunk.findMany({
      where: { sessionId },
      orderBy: { sequence: "asc" },
    });
    return chunks.map((c) => ({
      id: c.id,
      sessionId: c.sessionId,
      sequence: c.sequence,
      filePath: c.filePath,
      mimeType: c.mimeType,
      sizeBytes: c.sizeBytes,
    }));
  }

  async getFirstLiveVideoChunkCreatedAt(sessionId: string): Promise<Date | null> {
    const first = await this.db.liveVideoChunk.findFirst({
      where: { sessionId },
      orderBy: { sequence: "asc" },
      select: { createdAt: true },
    });
    return first?.createdAt ?? null;
  }

  async aggregateMaxLiveVideoSequence(sessionId: string): Promise<number> {
    const agg = await this.db.liveVideoChunk.aggregate({
      where: { sessionId },
      _max: { sequence: true },
    });
    return agg._max.sequence ?? 0;
  }

  async createLiveVideoChunk(params: {
    sessionId: string;
    sequence: number;
    filePath: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<void> {
    await this.db.liveVideoChunk.create({ data: params });
  }

  async findLiveCodeSnapshotsForSession(sessionId: string): Promise<
    { code: string; offsetSeconds: number; sequence: number }[]
  > {
    return this.db.liveCodeSnapshot.findMany({
      where: { sessionId },
      select: { code: true, offsetSeconds: true, sequence: true },
    });
  }

  async countLiveCodeSnapshotsForSession(sessionId: string): Promise<number> {
    return this.db.liveCodeSnapshot.count({ where: { sessionId } });
  }

  async aggregateMaxLiveCodeSnapshotSequence(sessionId: string): Promise<number> {
    const agg = await this.db.liveCodeSnapshot.aggregate({
      where: { sessionId },
      _max: { sequence: true },
    });
    return agg._max.sequence ?? 0;
  }

  async createLiveCodeSnapshot(params: {
    sessionId: string;
    sequence: number;
    code: string;
    offsetSeconds: number;
    capturedAt: Date;
  }): Promise<void> {
    await this.db.liveCodeSnapshot.create({ data: params });
  }

  async deleteSpeechUtterancesByJobId(jobId: string): Promise<void> {
    await this.db.speechUtterance.deleteMany({ where: { jobId } });
  }

  async countSpeechUtterancesForJob(jobId: string): Promise<number> {
    return this.db.speechUtterance.count({ where: { jobId } });
  }

  async createSpeechUtterances(data: SpeechUtteranceInsert[]): Promise<void> {
    if (data.length === 0) {
      return;
    }
    await this.db.speechUtterance.createMany({ data });
  }

  async findSpeechUtterancesForJobOrdered(jobId: string): Promise<SpeechUtteranceItem[]> {
    const rows = await this.db.speechUtterance.findMany({
      where: { jobId },
      orderBy: [{ startMs: "asc" }, { sequence: "asc" }],
    });
    return toSpeechItems(rows);
  }

  async findJobsLinkedToLiveSessionsWithUtteranceCounts(): Promise<
    { id: string; liveSessionId: string; speechUtteranceCount: number }[]
  > {
    const rows = await this.db.job.findMany({
      where: { liveSessionId: { not: null } },
      select: {
        id: true,
        liveSessionId: true,
        _count: { select: { speechUtterances: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      liveSessionId: r.liveSessionId!,
      speechUtteranceCount: r._count.speechUtterances,
    }));
  }

  async countLiveCodeSnapshotsBySessionIds(
    sessionIds: string[],
  ): Promise<{ sessionId: string; count: number }[]> {
    if (sessionIds.length === 0) {
      return [];
    }
    const grouped = await this.db.liveCodeSnapshot.groupBy({
      by: ["sessionId"],
      where: { sessionId: { in: sessionIds } },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ sessionId: g.sessionId, count: g._count._all }));
  }

  async deleteJobCodeSnapshotsBySource(jobId: string, source: CodeSnapshotSource): Promise<void> {
    await this.db.codeSnapshot.deleteMany({ where: { jobId, source } });
  }

  async createJobCodeSnapshots(
    rows: {
      jobId: string;
      source: CodeSnapshotSource;
      offsetMs: number;
      text: string;
      sequence: number;
    }[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db.codeSnapshot.createMany({ data: rows });
  }

  async findJobCodeSnapshotsBySource(
    jobId: string,
    source: CodeSnapshotSource,
  ): Promise<CodeSnapshotItem[]> {
    const rows = await this.db.codeSnapshot.findMany({
      where: { jobId, source },
      orderBy: [{ offsetMs: "asc" }, { sequence: "asc" }],
    });
    return toCodeRows(rows);
  }

  async upsertInterviewAudio(params: {
    jobId: string;
    filePath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number | null;
  }): Promise<void> {
    await this.db.interviewAudio.upsert({
      where: { jobId: params.jobId },
      create: {
        jobId: params.jobId,
        filePath: params.filePath,
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        durationSeconds: params.durationSeconds,
      },
      update: {
        filePath: params.filePath,
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        durationSeconds: params.durationSeconds,
      },
    });
  }

  async updateInterviewAudioDuration(jobId: string, durationSeconds: number | null): Promise<void> {
    await this.db.interviewAudio.update({
      where: { jobId },
      data: { durationSeconds },
    });
  }

  async updateInterviewVideoSizeBytes(jobId: string, sizeBytes: number): Promise<void> {
    await this.db.interviewVideo.update({
      where: { jobId },
      data: { sizeBytes },
    });
  }

  async findResultPayloadByJobId(jobId: string): Promise<{ payload: JsonValue } | null> {
    const row = await this.db.result.findUnique({ where: { jobId } });
    if (!row) {
      return null;
    }
    return { payload: row.payload as JsonValue };
  }

  async upsertResultPayload(jobId: string, payload: JsonValue): Promise<void> {
    await this.db.result.upsert({
      where: { jobId },
      create: { jobId, payload: payload as Prisma.InputJsonValue },
      update: { payload: payload as Prisma.InputJsonValue },
    });
  }
}
