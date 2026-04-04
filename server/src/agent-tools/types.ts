/** Discriminated result for agent-callable tools (no throws for expected failures). */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type CodeProgressionDelta = {
  /** Seconds from recording start when this version was captured (same as live snapshot `offsetSeconds`). */
  timeStampSec: number;
  /** Unified diff hunks only (no Index / `---` / `+++` file headers); `+` / `-` / context lines from `diff`. */
  codeDelta: string;
};

export type CodeProgressionInTimeRange = {
  initialCode: string;
  finalCode: string;
  codeDeltas: CodeProgressionDelta[];
};

export type TranscriptionSegmentInRange = {
  startSec: number;
  endSec: number;
  text: string;
  speakerLabel: string | null;
  sequence: number;
};

export type TranscriptionInTimeRange = {
  segments: TranscriptionSegmentInRange[];
};
