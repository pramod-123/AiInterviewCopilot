import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { DaoInterviewSessionTools } from "../../agent-tools/InterviewSessionTools.js";
import type { IAppDao } from "../../dao/IAppDao.js";
import type { ToolResult } from "../../agent-tools/types.js";

/** Context for building the tool list on each single-agent evaluation run. */
export type InterviewEvaluationAgentToolContext = {
  db: IAppDao;
  liveSessionId: string;
  jobId: string;
};

export type InterviewEvaluationAgentToolsFactory = (
  ctx: InterviewEvaluationAgentToolContext,
) => StructuredToolInterface[];

/**
 * LangChain tools backed by {@link DaoInterviewSessionTools}. `sessionId` and `jobId` are fixed at
 * construction so the model cannot query arbitrary sessions.
 */
export class LangChainInterviewSessionToolPack {
  private readonly sessionTools: DaoInterviewSessionTools;

  constructor(
    db: IAppDao,
    private readonly sessionId: string,
    private readonly jobId: string,
  ) {
    this.sessionTools = new DaoInterviewSessionTools(db);
  }

  /** Pair for `responseFormat: "content_and_artifact"`: model-facing JSON string + structured `ToolResult` as tool-message artifact. */
  private wrapContentAndArtifact<T>(result: ToolResult<T>): [string, ToolResult<T>] {
    return [JSON.stringify(result), result];
  }

  asLangChainTools(): StructuredToolInterface[] {
    const sessionTools = this.sessionTools;
    const sessionId = this.sessionId;
    const jobId = this.jobId;

    const get_session_metadata = tool(
      async () => this.wrapContentAndArtifact(await sessionTools.getSessionMetadata(sessionId)),
      {
        name: "get_session_metadata",
        description: `Return metadata for this live interview session (no full question text).

Input: none (session is fixed for this evaluation).

Output: JSON string of ToolResult<SessionMetadataData> (tool message content).
- ok: true → id, status (e.g. ACTIVE/ENDED), liveInterviewerEnabled, createdAt/updatedAt (ISO 8601), hasQuestionSaved (whether a prompt was stored — use get_question for text), postProcessJobId if the session has a linked post-process job, videoChunkCount, liveCodeSnapshotCount.
- ok: false → session not found.
The same ToolResult is also provided as the tool message artifact (structured) for hosts that read it.`,
        schema: z.object({}),
        responseFormat: "content_and_artifact",
      },
    );

    const get_question = tool(
      async () => this.wrapContentAndArtifact(await sessionTools.getQuestion(sessionId)),
      {
        name: "get_question",
        description: `Fetch the interview problem / prompt text stored for this live session (e.g. scraped from the coding platform).

Input: none (session is fixed for this evaluation).

Output: JSON string of ToolResult<{ text: string }> (tool message content).
- ok: true → data.text is the full problem statement, or "" if none was saved.
- ok: false → error explains failure (e.g. session not found).
The same ToolResult is also provided as the tool message artifact (structured) for hosts that read it.`,
        schema: z.object({}),
        responseFormat: "content_and_artifact",
      },
    );

    const get_code_at = tool(
      async ({ timestampSec }: { timestampSec: number }) =>
        this.wrapContentAndArtifact(await sessionTools.getCodeAt(sessionId, timestampSec)),
      {
        name: "get_code_at",
        description: `Fetch the editor code snapshot at or before a point on the recording timeline.

Input:
- timestampSec (number): seconds from the start of tab capture, aligned with live code snapshot offsetSeconds and the merged recording / STT timeline.

Behavior: returns the latest snapshot whose offsetSeconds <= timestampSec. If timestampSec is before the first snapshot, returns the earliest snapshot and marks clampedToEarliest.

Output: JSON string of ToolResult<{ text: string; offsetSeconds: number; clampedToEarliest: boolean }> (tool message content).
- ok: true → data.text is full editor source at that moment; data.offsetSeconds is the snapshot time used; data.clampedToEarliest true if timestamp was before first capture.
- ok: false → e.g. no snapshots, invalid timestamp, or session missing.
The same ToolResult is also provided as the tool message artifact (structured) for hosts that read it.`,
        schema: z.object({
          timestampSec: z
            .number()
            .describe(
              "Non-negative seconds from recording start; same unit as code snapshot offsetSeconds.",
            ),
        }),
        responseFormat: "content_and_artifact",
      },
    );

    const get_code_progression_in_timerange = tool(
      async ({
        startTimeSec,
        endTimeSec,
      }: {
        startTimeSec: number;
        endTimeSec?: number;
      }) =>
        this.wrapContentAndArtifact(
          await sessionTools.getCodeProgressionInTimeRange(sessionId, startTimeSec, endTimeSec),
        ),
      {
        name: "get_code_progression_in_timerange",
        description: `List editor snapshots in a time window and progressive diffs between consecutive snapshots.

Input:
- startTimeSec (number): window start in seconds (recording timeline).
- endTimeSec (number, optional): window end in seconds; omit to include all snapshots from startTimeSec onward (no upper bound).

Behavior: filters live code snapshots to offsetSeconds in [startTimeSec, endTimeSec] (or >= startTimeSec if end omitted), ordered by time. Builds one unified-diff hunk (no file headers) per step from previous to next snapshot.

Output: JSON string of ToolResult<{ initialCode: string; finalCode: string; codeDeltas: Array<{ timeStampSec: number; codeDelta: string }> }> (tool message content).
- ok: true → initialCode/finalCode are first/last full source in range; codeDeltas[i] is the change at timeStampSec (empty string if identical to previous).
- ok: true with empty range → initialCode, finalCode "", codeDeltas [].
- ok: false → e.g. no snapshots in session, invalid range, or session missing.
The same ToolResult is also provided as the tool message artifact (structured) for hosts that read it.`,
        schema: z.object({
          startTimeSec: z
            .number()
            .describe("Start of window in seconds on the same timeline as get_code_at."),
          endTimeSec: z
            .number()
            .optional()
            .describe(
              "End of window in seconds; must be >= startTimeSec when provided. Omit to take all snapshots from startTimeSec to the end of the session.",
            ),
        }),
        responseFormat: "content_and_artifact",
      },
    );

    const get_transcription_in_timerange = tool(
      async ({ startTimeSec, endTimeSec }: { startTimeSec: number; endTimeSec?: number }) =>
        this.wrapContentAndArtifact(
          await sessionTools.getTranscriptionInTimeRange(
            sessionId,
            jobId,
            startTimeSec,
            endTimeSec,
          ),
        ),
      {
        name: "get_transcription_in_timerange",
        description: `Fetch speech-to-text segments for this post-process job that overlap a time range on the job audio timeline.

Input:
- startTimeSec (number): range start in seconds (0 = start of job transcript timeline).
- endTimeSec (number, optional): range end in seconds; omit to treat end as +infinity (all speech from startTimeSec onward).

Behavior: a segment is included if its [startMs,endMs] overlaps [startTimeSec*1000, endTimeSec*1000] (or to end of time if endTimeSec omitted). Segments are ordered by start time.

Output: JSON string of ToolResult<{ segments: Array<{ startSec: number; endSec: number; text: string; speakerLabel: string | null; sequence: number }> }> (tool message content).
- ok: true → segments may be empty if nothing overlaps the window.
- ok: false → job not found, jobId does not match this live session, or invalid times.
The same ToolResult is also provided as the tool message artifact (structured) for hosts that read it.`,
        schema: z.object({
          startTimeSec: z
            .number()
            .describe("Start of query window in seconds on the job STT timeline (non-negative)."),
          endTimeSec: z
            .number()
            .optional()
            .describe(
              "End of window in seconds; must be >= startTimeSec when set. Omit to include all speech from startTimeSec to the end of available transcript.",
            ),
        }),
        responseFormat: "content_and_artifact",
      },
    );

    return [
      get_session_metadata,
      get_question,
      get_code_at,
      get_code_progression_in_timerange,
      get_transcription_in_timerange,
    ];
  }
}

/** Default inventory: session metadata, question, code-at-time, progression, transcription. */
export function buildDefaultInterviewEvaluationTools(
  ctx: InterviewEvaluationAgentToolContext,
): StructuredToolInterface[] {
  return new LangChainInterviewSessionToolPack(ctx.db, ctx.liveSessionId, ctx.jobId).asLangChainTools();
}
