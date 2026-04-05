/** Discriminated result for agent-callable tools (no throws for expected failures). */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type CodeProgressionSnapshot = {
  /** Seconds from recording start when this version was captured (same as live snapshot `offsetSeconds`). */
  timeStampSec: number;
  /** Full editor source at this capture (same meaning as get_code_at `text`). */
  text: string;
};

export type CodeProgressionInTimeRange = {
  /** Snapshots with `offsetSeconds` in the requested window, oldest first. */
  snapshots: CodeProgressionSnapshot[];
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
