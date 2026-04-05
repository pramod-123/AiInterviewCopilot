import type { IAppDao } from "../dao/IAppDao.js";
import type {
  CodeProgressionInTimeRange,
  ToolResult,
  TranscriptionInTimeRange,
} from "./types.js";

export type GetQuestionData = { text: string };

export type GetCodeAtData = {
  text: string;
  /** Offset of the snapshot used (seconds from recording start). */
  offsetSeconds: number;
  /** True when `timestampSec` was before the first snapshot; first snapshot code is returned. */
  clampedToEarliest: boolean;
};

/** Live session row summary for agents (no full question text — use {@link IInterviewSessionTools.getQuestion}). */
export type SessionMetadataData = {
  id: string;
  /** `LiveSessionStatus` as stored (e.g. ACTIVE, ENDED). */
  status: string;
  liveInterviewerEnabled: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /** True when a non-empty problem/prompt string exists; use get_question for the text. */
  hasQuestionSaved: boolean;
  /** Post-process job linked to this session, if any (`Job.liveSessionId`). */
  postProcessJobId: string | null;
  /**
   * End of last STT utterance on the job timeline (seconds). Null if no linked job or no utterances.
   * Agents should not scan transcript windows beyond this (add small padding if needed).
   */
  postProcessTranscriptEndSec: number | null;
  videoChunkCount: number;
  liveCodeSnapshotCount: number;
};

/**
 * Read-only tools for interview/live-session context (editor snapshots, question, STT by job).
 * Intended for wiring into LLM agents / function-calling later.
 */
export interface IInterviewSessionTools {
  getQuestion(sessionId: string): Promise<ToolResult<GetQuestionData>>;
  /** Status, flags, counts, and linked job id for the live session (no question body). */
  getSessionMetadata(sessionId: string): Promise<ToolResult<SessionMetadataData>>;
  /** `timestampSec` aligns with {@link LiveCodeSnapshot.offsetSeconds} (seconds since tab capture start). */
  getCodeAt(sessionId: string, timestampSec: number): Promise<ToolResult<GetCodeAtData>>;
  /**
   * Ordered full editor snapshots between times (seconds on the same timeline as `getCodeAt`).
   * Spec name `start_id` is interpreted as **start time in seconds** (`startTimeSec`).
   */
  getCodeProgressionInTimeRange(
    sessionId: string,
    startTimeSec: number,
    endTimeSec?: number,
  ): Promise<ToolResult<CodeProgressionInTimeRange>>;
  /**
   * STT segments overlapping the wall-clock interval on the job timeline (seconds).
   * `jobId` must be the post-process job for this `sessionId` (`Job.liveSessionId`).
   * When `speakerLabel` is set (non-empty after trim), only segments whose stored label matches (case-insensitive) are returned; segments with null/unknown speaker are excluded.
   */
  getTranscriptionInTimeRange(
    sessionId: string,
    jobId: string,
    startTimeSec: number,
    endTimeSec?: number,
    speakerLabel?: string | null,
  ): Promise<ToolResult<TranscriptionInTimeRange>>;
}

function toolErr<T>(error: string): ToolResult<T> {
  return { ok: false, error };
}

function sortLiveSnapshots<T extends { offsetSeconds: number; sequence: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.offsetSeconds !== b.offsetSeconds ? a.offsetSeconds - b.offsetSeconds : a.sequence - b.sequence,
  );
}

function normalizeSpeakerLabelForMatch(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "_");
}

/** DAO-backed {@link IInterviewSessionTools}. */
export class DaoInterviewSessionTools implements IInterviewSessionTools {
  constructor(private readonly db: IAppDao) {}

  async getQuestion(sessionId: string): Promise<ToolResult<GetQuestionData>> {
    const row = await this.db.getLiveSessionQuestionText(sessionId);
    if (!row) {
      return toolErr("Session not found.");
    }
    return { ok: true, data: { text: row.question?.trim() ?? "" } };
  }

  async getSessionMetadata(sessionId: string): Promise<ToolResult<SessionMetadataData>> {
    const row = await this.db.getLiveSessionMetadataForTools(sessionId);
    if (!row) {
      return toolErr("Session not found.");
    }
    return {
      ok: true,
      data: {
        id: row.id,
        status: row.status,
        liveInterviewerEnabled: row.liveInterviewerEnabled,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        hasQuestionSaved: row.hasQuestionSaved,
        postProcessJobId: row.postProcessJobId,
        postProcessTranscriptEndSec: row.postProcessTranscriptEndSec,
        videoChunkCount: row.videoChunkCount,
        liveCodeSnapshotCount: row.liveCodeSnapshotCount,
      },
    };
  }

  async getCodeAt(sessionId: string, timestampSec: number): Promise<ToolResult<GetCodeAtData>> {
    if (!Number.isFinite(timestampSec) || timestampSec < 0) {
      return toolErr("timestampSec must be a non-negative finite number.");
    }
    const session = await this.db.findLiveSessionIdForTools(sessionId);
    if (!session) {
      return toolErr("Session not found.");
    }
    const snaps = sortLiveSnapshots(await this.db.findLiveCodeSnapshotsForSession(sessionId));
    if (snaps.length === 0) {
      return toolErr("No code snapshots for this session.");
    }
    let clampedToEarliest = false;
    let chosen = snaps[0]!;
    if (timestampSec < chosen.offsetSeconds) {
      clampedToEarliest = true;
    } else {
      for (const s of snaps) {
        if (s.offsetSeconds <= timestampSec) {
          chosen = s;
        } else {
          break;
        }
      }
    }
    return {
      ok: true,
      data: {
        text: chosen.code,
        offsetSeconds: chosen.offsetSeconds,
        clampedToEarliest,
      },
    };
  }

  async getCodeProgressionInTimeRange(
    sessionId: string,
    startTimeSec: number,
    endTimeSec?: number,
  ): Promise<ToolResult<CodeProgressionInTimeRange>> {
    if (!Number.isFinite(startTimeSec) || startTimeSec < 0) {
      return toolErr("startTimeSec must be a non-negative finite number.");
    }
    if (endTimeSec !== undefined && (!Number.isFinite(endTimeSec) || endTimeSec < startTimeSec)) {
      return toolErr("endTimeSec must be finite and >= startTimeSec when provided.");
    }
    const session = await this.db.findLiveSessionIdForTools(sessionId);
    if (!session) {
      return toolErr("Session not found.");
    }
    const all = sortLiveSnapshots(await this.db.findLiveCodeSnapshotsForSession(sessionId));
    if (all.length === 0) {
      return toolErr("No code snapshots for this session.");
    }
    const inRange = all.filter(
      (s) =>
        s.offsetSeconds >= startTimeSec &&
        (endTimeSec === undefined || s.offsetSeconds <= endTimeSec),
    );
    if (inRange.length === 0) {
      return { ok: true, data: { snapshots: [] } };
    }
    const snapshots = inRange.map((s) => ({
      timeStampSec: s.offsetSeconds,
      text: s.code,
    }));
    return { ok: true, data: { snapshots } };
  }

  async getTranscriptionInTimeRange(
    sessionId: string,
    jobId: string,
    startTimeSec: number,
    endTimeSec?: number,
    speakerLabel?: string | null,
  ): Promise<ToolResult<TranscriptionInTimeRange>> {
    if (!Number.isFinite(startTimeSec) || startTimeSec < 0) {
      return toolErr("startTimeSec must be a non-negative finite number.");
    }
    if (endTimeSec !== undefined && (!Number.isFinite(endTimeSec) || endTimeSec < startTimeSec)) {
      return toolErr("endTimeSec must be finite and >= startTimeSec when provided.");
    }
    const job = await this.db.findJobLiveSessionId(jobId);
    if (!job) {
      return toolErr("Job not found.");
    }
    if (job.liveSessionId !== sessionId) {
      return toolErr("jobId does not belong to this session (liveSessionId mismatch).");
    }
    const speakerFilter =
      speakerLabel != null && String(speakerLabel).trim() !== ""
        ? normalizeSpeakerLabelForMatch(String(speakerLabel))
        : null;
    const utterances = await this.db.findSpeechUtterancesForJobOrdered(
      jobId,
      speakerFilter != null ? { speakerLabelNormalized: speakerFilter } : undefined,
    );
    const rangeStartMs = Math.round(startTimeSec * 1000);
    const rangeEndMs =
      endTimeSec === undefined ? Number.MAX_SAFE_INTEGER : Math.round(endTimeSec * 1000);
    const segments = utterances
      .filter((u) => u.startMs < rangeEndMs && u.endMs > rangeStartMs)
      .map((u) => ({
        startSec: u.startMs / 1000,
        endSec: u.endMs / 1000,
        text: u.text,
        speakerLabel: u.speakerLabel ?? null,
        sequence: u.sequence,
      }));
    return { ok: true, data: { segments } };
  }
}

/** @deprecated Use {@link DaoInterviewSessionTools}. */
export const PrismaInterviewSessionTools = DaoInterviewSessionTools;
