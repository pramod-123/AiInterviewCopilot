import type { IAppDao } from "../dao/IAppDao.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { SpeechSegment, SpeechTranscription } from "../types/speechTranscription.js";
import {
  readRealtimeTranscriptionRecords,
  readVoiceRealtimeAudioBridgeMeta,
  type RealtimeTranscriptionRecord,
} from "./interviewBridgeCapture.js";
import { computeRecordingAnchorDeltaMs } from "./stitchGeminiInterviewerTimeline.js";

export type GeminiDerivedUtterance = {
  segment: SpeechSegment;
  /** Candidate vs AI voice interviewer */
  speakerLabel: "INTERVIEWEE" | "INTERVIEWER";
};

/** Seconds after the last utterance ends when no following transcript event exists (no audio duration here). */
const LAST_UTTERANCE_TAIL_SEC = 1.0;

type FlushedTurn = {
  role: "input" | "output";
  text: string;
  /** Milliseconds since recording start (bridge offset + {@link computeRecordingAnchorDeltaMs}). */
  anchorMs: number;
};

/**
 * Maps Gemini Live wall-clock offsets onto the merged recording timeline using the same anchor as
 * {@link stitchGeminiInterviewerTimelineWav}.
 *
 * Each finished line uses `Date.now()-bridgeOpen` at append time as one instant on the recording
 * clock. Segments use **[t_i, t_{i+1}]** (non-overlapping, monotonic) so a candidate line does not
 * inherit the previous line’s **start** time — that packing caused e.g. first user speech at ~25s
 * on the recording to appear starting at ~14s when the interviewer’s line ended at ~14s.
 */
export function mergeGeminiRealtimeRecordsToUtterances(
  records: RealtimeTranscriptionRecord[],
  anchorDeltaMs: number,
): GeminiDerivedUtterance[] {
  const sorted = [...records].sort((a, b) => {
    const d = a.offsetFromBridgeOpenMs - b.offsetFromBridgeOpenMs;
    return d !== 0 ? d : a.role.localeCompare(b.role);
  });

  const flushed: FlushedTurn[] = [];

  const flush = (role: "input" | "output", text: string, offsetFromBridgeOpenMs: number): void => {
    const t = text.trim();
    if (!t) {
      return;
    }
    const anchorMs = Math.max(0, offsetFromBridgeOpenMs + anchorDeltaMs);
    flushed.push({ role, text: t, anchorMs });
  };

  let pendingIn: { text: string; offset: number } | null = null;
  let pendingOut: { text: string; offset: number } | null = null;

  for (const e of sorted) {
    if (e.role === "input") {
      pendingIn = { text: e.text, offset: e.offsetFromBridgeOpenMs };
      if (e.finished) {
        flush("input", e.text, e.offsetFromBridgeOpenMs);
        pendingIn = null;
      }
    } else {
      pendingOut = { text: e.text, offset: e.offsetFromBridgeOpenMs };
      if (e.finished) {
        flush("output", e.text, e.offsetFromBridgeOpenMs);
        pendingOut = null;
      }
    }
  }

  if (pendingIn?.text.trim()) {
    flush("input", pendingIn.text, pendingIn.offset);
  }
  if (pendingOut?.text.trim()) {
    flush("output", pendingOut.text, pendingOut.offset);
  }

  const utterances: GeminiDerivedUtterance[] = [];
  let prevEndSec = 0;
  for (let i = 0; i < flushed.length; i++) {
    const { role, text, anchorMs } = flushed[i]!;
    const idealStartSec = anchorMs / 1000;
    const startSec = Math.max(prevEndSec, idealStartSec);
    const nextAnchorSec = i + 1 < flushed.length ? flushed[i + 1]!.anchorMs / 1000 : null;
    const endSec =
      nextAnchorSec != null
        ? Math.max(startSec + 0.05, nextAnchorSec)
        : startSec + LAST_UTTERANCE_TAIL_SEC;
    prevEndSec = endSec;
    const speakerLabel: GeminiDerivedUtterance["speakerLabel"] =
      role === "input" ? "INTERVIEWEE" : "INTERVIEWER";
    utterances.push({
      segment: new SpeechSegment(startSec, endSec, text),
      speakerLabel,
    });
  }

  return utterances;
}

export function speechTranscriptionFromGeminiUtterances(utterances: GeminiDerivedUtterance[]): SpeechTranscription {
  const segments = utterances.map(
    (u) =>
      new SpeechSegment(u.segment.startSec, u.segment.endSec, u.segment.text, u.speakerLabel),
  );
  const durationSec =
    segments.length > 0 ? Math.max(...segments.map((s) => s.endSec), 0) : 0;
  const fullText = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  return new SpeechTranscription(
    segments,
    durationSec,
    "en",
    fullText || null,
    "gemini_live_realtime",
    null,
  );
}

/**
 * Returns merged utterances when `realtime-transcriptions.jsonl` exists and produces at least one segment.
 * Requires `meta.json` (bridge open time) for anchor alignment.
 */
export async function tryLoadGeminiRealtimeForLiveSession(
  paths: AppPaths,
  db: IAppDao,
  sessionId: string,
): Promise<{ utterances: GeminiDerivedUtterance[]; anchorDeltaMs: number } | null> {
  const records = await readRealtimeTranscriptionRecords(paths, sessionId);
  if (records.length === 0) {
    return null;
  }
  const meta = await readVoiceRealtimeAudioBridgeMeta(db, sessionId);
  if (!meta) {
    return null;
  }
  const anchorDeltaMs = await computeRecordingAnchorDeltaMs(db, sessionId, meta.bridgeOpenedAtWallMs);
  const utterances = mergeGeminiRealtimeRecordsToUtterances(records, anchorDeltaMs);
  if (utterances.length === 0) {
    return null;
  }
  return { utterances, anchorDeltaMs };
}
