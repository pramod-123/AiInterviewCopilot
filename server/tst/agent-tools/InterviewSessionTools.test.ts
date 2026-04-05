import { describe, expect, it, vi } from "vitest";
import type { IAppDao } from "../../src/dao/IAppDao.js";
import { DaoInterviewSessionTools } from "../../src/agent-tools/InterviewSessionTools.js";

function mockDb(overrides: Partial<IAppDao>): IAppDao {
  return overrides as IAppDao;
}

describe("DaoInterviewSessionTools", () => {
  it("getQuestion returns trimmed text", async () => {
    const db = mockDb({
      getLiveSessionQuestionText: vi.fn().mockResolvedValue({ question: "  Two sum  " }),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getQuestion("s1");
    expect(r).toEqual({ ok: true, data: { text: "Two sum" } });
  });

  it("getQuestion errors when session missing", async () => {
    const db = mockDb({
      getLiveSessionQuestionText: vi.fn().mockResolvedValue(null),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getQuestion("nope");
    expect(r.ok).toBe(false);
  });

  it("getSessionMetadata returns counts and linked job id", async () => {
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const updatedAt = new Date("2025-01-02T00:00:00.000Z");
    const db = mockDb({
      getLiveSessionMetadataForTools: vi.fn().mockResolvedValue({
        id: "s1",
        status: "ENDED",
        liveInterviewerEnabled: false,
        createdAt,
        updatedAt,
        hasQuestionSaved: true,
        postProcessJobId: "job-uuid",
        postProcessTranscriptEndSec: 50,
        videoChunkCount: 3,
        liveCodeSnapshotCount: 12,
      }),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getSessionMetadata("s1");
    expect(r).toEqual({
      ok: true,
      data: {
        id: "s1",
        status: "ENDED",
        liveInterviewerEnabled: false,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
        hasQuestionSaved: true,
        postProcessJobId: "job-uuid",
        postProcessTranscriptEndSec: 50,
        videoChunkCount: 3,
        liveCodeSnapshotCount: 12,
      },
    });
  });

  it("getSessionMetadata hasQuestionSaved false when question empty", async () => {
    const t = new Date();
    const db = mockDb({
      getLiveSessionMetadataForTools: vi.fn().mockResolvedValue({
        id: "s1",
        status: "ACTIVE",
        liveInterviewerEnabled: true,
        createdAt: t,
        updatedAt: t,
        hasQuestionSaved: false,
        postProcessJobId: null,
        postProcessTranscriptEndSec: null,
        videoChunkCount: 0,
        liveCodeSnapshotCount: 0,
      }),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getSessionMetadata("s1");
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.data.hasQuestionSaved).toBe(false);
    expect(r.data.postProcessJobId).toBeNull();
    expect(r.data.postProcessTranscriptEndSec).toBeNull();
  });

  it("getSessionMetadata errors when session missing", async () => {
    const db = mockDb({
      getLiveSessionMetadataForTools: vi.fn().mockResolvedValue(null),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getSessionMetadata("nope");
    expect(r.ok).toBe(false);
  });

  it("getCodeAt picks last snapshot at or before timestamp", async () => {
    const db = mockDb({
      findLiveSessionIdForTools: vi.fn().mockResolvedValue({ id: "s1" }),
      findLiveCodeSnapshotsForSession: vi.fn().mockResolvedValue([
        { code: "a", offsetSeconds: 0, sequence: 0 },
        { code: "b", offsetSeconds: 10, sequence: 1 },
        { code: "c", offsetSeconds: 20, sequence: 2 },
      ]),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getCodeAt("s1", 15);
    expect(r).toEqual({
      ok: true,
      data: { text: "b", offsetSeconds: 10, clampedToEarliest: false },
    });
  });

  it("getCodeAt clamps to earliest when timestamp before first snapshot", async () => {
    const db = mockDb({
      findLiveSessionIdForTools: vi.fn().mockResolvedValue({ id: "s1" }),
      findLiveCodeSnapshotsForSession: vi.fn().mockResolvedValue([
        { code: "first", offsetSeconds: 5, sequence: 0 },
      ]),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getCodeAt("s1", 1);
    expect(r).toEqual({
      ok: true,
      data: { text: "first", offsetSeconds: 5, clampedToEarliest: true },
    });
  });

  it("getCodeProgressionInTimeRange returns full text per snapshot in window", async () => {
    const db = mockDb({
      findLiveSessionIdForTools: vi.fn().mockResolvedValue({ id: "s1" }),
      findLiveCodeSnapshotsForSession: vi.fn().mockResolvedValue([
        { code: "x", offsetSeconds: 0, sequence: 0 },
        { code: "x", offsetSeconds: 1, sequence: 1 },
        { code: "y", offsetSeconds: 2, sequence: 2 },
      ]),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getCodeProgressionInTimeRange("s1", 0, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.data.snapshots).toEqual([
      { timeStampSec: 0, text: "x" },
      { timeStampSec: 1, text: "x" },
      { timeStampSec: 2, text: "y" },
    ]);
  });

  it("getTranscriptionInTimeRange filters by overlap and validates job session", async () => {
    const findUtterances = vi.fn().mockResolvedValue([
      {
        id: "u0",
        jobId: "j1",
        startMs: 0,
        endMs: 1000,
        text: "a",
        speakerLabel: null,
        sequence: 0,
      },
      {
        id: "u1",
        jobId: "j1",
        startMs: 5000,
        endMs: 6000,
        text: "b",
        speakerLabel: "INTERVIEWER",
        sequence: 1,
      },
    ]);
    const db = mockDb({
      findJobLiveSessionId: vi.fn().mockResolvedValue({ liveSessionId: "s1" }),
      findSpeechUtterancesForJobOrdered: findUtterances,
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getTranscriptionInTimeRange("s1", "j1", 0.5, 5.5);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(findUtterances).toHaveBeenCalledWith("j1", undefined);
    expect(r.data.segments).toHaveLength(2);
    expect(r.data.segments[0]!.text).toBe("a");
    expect(r.data.segments[1]!.speakerLabel).toBe("INTERVIEWER");
  });

  it("getTranscriptionInTimeRange optional speakerLabel passes normalized label to DAO", async () => {
    const allRows = [
      {
        id: "u0",
        jobId: "j1",
        startMs: 0,
        endMs: 1000,
        text: "a",
        speakerLabel: null as string | null,
        sequence: 0,
      },
      {
        id: "u1",
        jobId: "j1",
        startMs: 1000,
        endMs: 2000,
        text: "b",
        speakerLabel: "INTERVIEWER",
        sequence: 1,
      },
    ];
    const findUtterances = vi.fn().mockImplementation((_jobId: string, opts?: { speakerLabelNormalized?: string }) => {
      if (opts?.speakerLabelNormalized === "INTERVIEWER") {
        return Promise.resolve(allRows.filter((u) => u.speakerLabel === "INTERVIEWER"));
      }
      return Promise.resolve(allRows);
    });
    const db = mockDb({
      findJobLiveSessionId: vi.fn().mockResolvedValue({ liveSessionId: "s1" }),
      findSpeechUtterancesForJobOrdered: findUtterances,
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getTranscriptionInTimeRange("s1", "j1", 0, 10, "interviewer");
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(findUtterances).toHaveBeenCalledWith("j1", { speakerLabelNormalized: "INTERVIEWER" });
    expect(r.data.segments).toHaveLength(1);
    expect(r.data.segments[0]!.text).toBe("b");
    expect(r.data.segments[0]!.speakerLabel).toBe("INTERVIEWER");
  });

  it("getTranscriptionInTimeRange rejects job for wrong session", async () => {
    const db = mockDb({
      findJobLiveSessionId: vi.fn().mockResolvedValue({ liveSessionId: "other" }),
    });
    const tools = new DaoInterviewSessionTools(db);
    const r = await tools.getTranscriptionInTimeRange("s1", "j1", 0, 10);
    expect(r.ok).toBe(false);
  });
});
