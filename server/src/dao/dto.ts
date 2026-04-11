/** JSON-serializable value for persisted payloads (no Prisma types). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
export type LiveSessionStatus = "ACTIVE" | "ENDED";
export type CodeSnapshotSource = "VIDEO_OCR" | "EDITOR_SNAPSHOT";

export type SpeechUtteranceInsert = {
  jobId: string;
  startMs: number;
  endMs: number;
  text: string;
  sequence: number;
  speakerLabel?: string | null;
};

export type SpeechUtteranceItem = {
  id: string;
  jobId: string;
  startMs: number;
  endMs: number;
  text: string;
  sequence: number;
  speakerLabel: string | null;
};

export type CodeSnapshotItem = {
  id: string;
  jobId: string;
  source: CodeSnapshotSource;
  offsetMs: number;
  text: string;
  sequence: number;
};

export type LiveVideoChunkItem = {
  id: string;
  sessionId: string;
  sequence: number;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
};

/** One PCM blob from the live realtime voice model (DB row), for stitch or APIs. */
export type LiveVoiceRealtimeAudioChunkItem = {
  sequence: number;
  pcmS16le: Buffer;
  sampleRate: number;
  receivedAtWallMs: number;
  offsetFromBridgeOpenMs: number;
};

export type InterviewAudioItem = {
  jobId: string;
  filePath: string;
  durationSeconds: number | null;
};

export type InterviewVideoItem = {
  jobId: string;
  filePath: string;
};

export type LiveSessionListItem = {
  id: string;
  status: LiveSessionStatus;
  createdAt: Date;
  updatedAt: Date;
  videoChunkCount: number;
  codeSnapshotCount: number;
  questionPreview: string | null;
  liveInterviewerEnabled: boolean;
  postProcessJob: { id: string; status: JobStatus; errorMessage: string | null } | null;
};

export type LiveSessionGetItem = {
  id: string;
  status: LiveSessionStatus;
  createdAt: Date;
  updatedAt: Date;
  videoChunkCount: number;
  codeSnapshotCount: number;
  question: string | null;
  liveInterviewerEnabled: boolean;
  postProcessJob: { id: string; status: JobStatus; errorMessage: string | null } | null;
};

export type LiveSessionPatchItem = {
  id: string;
  status: LiveSessionStatus;
};

export type LiveSessionContent = {
  id: string;
  status: LiveSessionStatus;
  question: string | null;
  liveInterviewerEnabled: boolean;
  codeSnapshots: { offsetSeconds: number; code: string; sequence: number }[];
};

export type JobDetail = {
  id: string;
  status: JobStatus;
  errorMessage: string | null;
  liveSessionId: string | null;
  result: { payload: JsonValue; createdAt: Date } | null;
  interviewVideo: { filePath: string } | null;
  speechUtterances: SpeechUtteranceItem[];
  codeSnapshots: CodeSnapshotItem[];
  liveSession: { id: string } | null;
};

export type JobWithInterviewAudio = {
  id: string;
  interviewAudio: InterviewAudioItem | null;
};

export type JobWithInterviewVideo = {
  id: string;
  interviewVideo: InterviewVideoItem | null;
};

export type JobEvaluationLoad = {
  id: string;
  liveSessionId: string | null;
  speechUtterances: SpeechUtteranceItem[];
  liveSession: {
    question: string | null;
    codeSnapshots: { offsetSeconds: number; code: string }[];
  } | null;
};

export function mergeJsonPayload(prev: unknown, patch: Record<string, unknown>): JsonValue {
  const base =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  return { ...base, ...patch } as JsonValue;
}
