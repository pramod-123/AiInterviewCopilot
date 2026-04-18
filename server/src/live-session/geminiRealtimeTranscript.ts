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

function recordHasSpan(e: RealtimeTranscriptionRecord): boolean {
  const s = e.startOffsetFromBridgeOpenMs;
  const en = e.endOffsetFromBridgeOpenMs;
  return (
    typeof s === "number" &&
    typeof en === "number" &&
    Number.isFinite(s) &&
    Number.isFinite(en) &&
    en > s
  );
}

type TimedSegment = {
  role: "input" | "output";
  text: string;
  startMs: number;
  endMs: number;
};

/**
 * Maps Gemini Live transcript lines onto the merged recording timeline using the same anchor as
 * {@link stitchGeminiInterviewerTimelineWav}.
 *
 * - **Legacy** lines (single `offsetFromBridgeOpenMs`): coalesce unfinished turns, then pack
 *   segment ends using the next line’s anchor (same as before).
 * - **Span** lines (`startOffsetFromBridgeOpenMs` / `endOffsetFromBridgeOpenMs` from buffered Gemini
 *   flushes): use explicit start/end on the recording clock after `anchorDeltaMs`.
 */
export function mergeGeminiRealtimeRecordsToUtterances(
  records: RealtimeTranscriptionRecord[],
  anchorDeltaMs: number,
): GeminiDerivedUtterance[] {
  const legacyRecords = [...records].filter((e) => !recordHasSpan(e)).sort((a, b) => {
    const d = a.offsetFromBridgeOpenMs - b.offsetFromBridgeOpenMs;
    return d !== 0 ? d : a.role.localeCompare(b.role);
  });

  const spanSegments: TimedSegment[] = [...records]
    .filter(recordHasSpan)
    .sort((a, b) => {
      const aS = a.startOffsetFromBridgeOpenMs as number;
      const bS = b.startOffsetFromBridgeOpenMs as number;
      const d = aS - bS;
      return d !== 0 ? d : a.role.localeCompare(b.role);
    })
    .map((e) => ({
      role: e.role,
      text: e.text.trim(),
      startMs: Math.max(0, (e.startOffsetFromBridgeOpenMs as number) + anchorDeltaMs),
      endMs: Math.max(0, (e.endOffsetFromBridgeOpenMs as number) + anchorDeltaMs),
    }))
    .filter((s) => s.text.length > 0);

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

  for (const e of legacyRecords) {
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

  const legacyTimed: TimedSegment[] = [];
  let prevEndMs = 0;
  for (let i = 0; i < flushed.length; i++) {
    const { role, text, anchorMs } = flushed[i]!;
    const idealStartMs = anchorMs;
    const startMs = Math.max(prevEndMs, idealStartMs);
    const nextAnchorMs = i + 1 < flushed.length ? flushed[i + 1]!.anchorMs : null;
    const endMs =
      nextAnchorMs != null
        ? Math.max(startMs + 50, nextAnchorMs)
        : startMs + LAST_UTTERANCE_TAIL_SEC * 1000;
    prevEndMs = endMs;
    legacyTimed.push({ role, text, startMs, endMs });
  }

  const combined = [...legacyTimed, ...spanSegments].sort((a, b) => {
    const d = a.startMs - b.startMs;
    return d !== 0 ? d : a.endMs - b.endMs;
  });

  const utterances: GeminiDerivedUtterance[] = [];
  let prevEndSec = 0;
  for (const seg of combined) {
    const startSec = Math.max(prevEndSec, seg.startMs / 1000);
    const endSec = Math.max(startSec + 0.05, seg.endMs / 1000);
    prevEndSec = endSec;
    const speakerLabel: GeminiDerivedUtterance["speakerLabel"] =
      seg.role === "input" ? "INTERVIEWEE" : "INTERVIEWER";
    utterances.push({
      segment: new SpeechSegment(startSec, endSec, seg.text),
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
