import type {
  CodeSnapshotItem,
  CodeSnapshotSource,
  InterviewAudioItem,
  InterviewVideoItem,
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

/**
 * Application data access: explicit query/command methods only — no ORM delegates.
 * Connection lifecycle, driver-specific pragmas, and multi-statement transactions live in
 * `db.ts` (application wiring), not on this interface.
 */
export interface IAppDao {
  // --- Jobs ---
  findFirstJobIdByLiveSessionId(liveSessionId: string): Promise<string | null>;
  /** Returns job id if a row exists (for CLI resolution). */
  findJobIdIfExists(jobId: string): Promise<string | null>;
  findJobDetail(jobId: string): Promise<JobDetail | null>;
  findJobWithInterviewAudio(jobId: string): Promise<JobWithInterviewAudio | null>;
  findJobWithInterviewVideo(jobId: string): Promise<JobWithInterviewVideo | null>;
  findJobLiveSessionId(jobId: string): Promise<{ liveSessionId: string | null } | null>;
  findJobForEvaluationLoad(jobId: string): Promise<JobEvaluationLoad | null>;
  createJobPendingWithInterviewVideo(params: {
    id: string;
    filePath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<void>;
  createJobFailedLiveSession(params: {
    id: string;
    liveSessionId: string;
    errorMessage: string;
  }): Promise<void>;
  createJobProcessingLiveSessionWithVideo(params: {
    id: string;
    liveSessionId: string;
    videoFilePath: string;
    videoSizeBytes: number;
  }): Promise<void>;
  updateJob(
    jobId: string,
    data: { status?: JobStatus; errorMessage?: string | null },
  ): Promise<void>;
  upsertJobProcessingShell(jobId: string): Promise<void>;
  deleteJobsByLiveSessionId(liveSessionId: string): Promise<number>;

  // --- Live sessions ---
  listLiveSessions(): Promise<LiveSessionListItem[]>;
  createLiveSession(params: {
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
  }): Promise<void>;
  /** Atomically creates a session with nested video chunks and live code snapshots (fixtures / seed scripts). */
  createLiveSessionWithChunksAndSnapshots(params: {
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
    question: string | null;
    videoChunks: { sequence: number; filePath: string; mimeType: string; sizeBytes: number }[];
    codeSnapshots: { sequence: number; code: string; offsetSeconds: number; capturedAt: Date }[];
  }): Promise<void>;
  getLiveSession(id: string): Promise<LiveSessionGetItem | null>;
  getLiveSessionPatch(id: string): Promise<LiveSessionPatchItem | null>;
  getLiveSessionContent(id: string): Promise<LiveSessionContent | null>;
  updateLiveSessionQuestion(id: string, question: string): Promise<void>;
  updateLiveSessionStatus(id: string, status: LiveSessionStatus): Promise<void>;
  getLiveSessionForGeminiWs(id: string): Promise<{
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
    question: string | null;
  } | null>;
  findLiveSessionIdForTools(id: string): Promise<{ id: string } | null>;
  getLiveSessionQuestionText(id: string): Promise<{ question: string | null } | null>;
  getLiveSessionMetadataForTools(id: string): Promise<{
    id: string;
    status: LiveSessionStatus;
    liveInterviewerEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
    hasQuestionSaved: boolean;
    postProcessJobId: string | null;
    videoChunkCount: number;
    liveCodeSnapshotCount: number;
  } | null>;
  deleteLiveSessionById(id: string): Promise<void>;
  /** Most recently updated session id, or null if none. */
  findLatestLiveSessionId(): Promise<string | null>;

  // --- Live video chunks ---
  findLiveVideoChunksOrdered(sessionId: string): Promise<LiveVideoChunkItem[]>;
  getFirstLiveVideoChunkCreatedAt(sessionId: string): Promise<Date | null>;
  aggregateMaxLiveVideoSequence(sessionId: string): Promise<number>;
  createLiveVideoChunk(params: {
    sessionId: string;
    sequence: number;
    filePath: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<void>;

  // --- Live code snapshots (tab capture) ---
  findLiveCodeSnapshotsForSession(sessionId: string): Promise<
    { code: string; offsetSeconds: number; sequence: number }[]
  >;
  countLiveCodeSnapshotsForSession(sessionId: string): Promise<number>;
  aggregateMaxLiveCodeSnapshotSequence(sessionId: string): Promise<number>;
  createLiveCodeSnapshot(params: {
    sessionId: string;
    sequence: number;
    code: string;
    offsetSeconds: number;
    capturedAt: Date;
  }): Promise<void>;

  // --- Speech utterances ---
  countSpeechUtterancesForJob(jobId: string): Promise<number>;
  deleteSpeechUtterancesByJobId(jobId: string): Promise<void>;
  createSpeechUtterances(data: SpeechUtteranceInsert[]): Promise<void>;
  findSpeechUtterancesForJobOrdered(jobId: string): Promise<SpeechUtteranceItem[]>;

  /** Jobs with non-null `liveSessionId`, for CLI heuristics. */
  findJobsLinkedToLiveSessionsWithUtteranceCounts(): Promise<
    { id: string; liveSessionId: string; speechUtteranceCount: number }[]
  >;
  /** Live tab-capture snapshot counts per session id. */
  countLiveCodeSnapshotsBySessionIds(
    sessionIds: string[],
  ): Promise<{ sessionId: string; count: number }[]>;

  // --- Job code snapshots ---
  deleteJobCodeSnapshotsBySource(jobId: string, source: CodeSnapshotSource): Promise<void>;
  createJobCodeSnapshots(
    rows: {
      jobId: string;
      source: CodeSnapshotSource;
      offsetMs: number;
      text: string;
      sequence: number;
    }[],
  ): Promise<void>;
  findJobCodeSnapshotsBySource(
    jobId: string,
    source: CodeSnapshotSource,
  ): Promise<CodeSnapshotItem[]>;

  // --- Interview audio ---
  upsertInterviewAudio(params: {
    jobId: string;
    filePath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number | null;
  }): Promise<void>;
  updateInterviewAudioDuration(jobId: string, durationSeconds: number | null): Promise<void>;

  // --- Interview video ---
  updateInterviewVideoSizeBytes(jobId: string, sizeBytes: number): Promise<void>;

  // --- Result ---
  findResultPayloadByJobId(jobId: string): Promise<{ payload: JsonValue } | null>;
  upsertResultPayload(jobId: string, payload: JsonValue): Promise<void>;
}
