import type { IAppDao } from "../dao/IAppDao.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import { SpeechSegment, SpeechTranscription } from "../types/speechTranscription.js";
import {
  readGeminiAudioMeta,
  readGeminiRealtimeTranscriptionRecords,
  type GeminiRealtimeTranscriptionRecord,
} from "./geminiLiveAudioCapture.js";
import { computeRecordingAnchorDeltaMs } from "./stitchGeminiInterviewerTimeline.js";

export type GeminiDerivedUtterance = {
  segment: SpeechSegment;
  /** Candidate vs AI voice interviewer */
  speakerLabel: "INTERVIEWEE" | "INTERVIEWER";
};

/**
 * Maps Gemini Live wall-clock offsets onto the merged recording timeline using the same anchor as
 * {@link stitchGeminiInterviewerTimelineWav}.
 */
export function mergeGeminiRealtimeRecordsToUtterances(
  records: GeminiRealtimeTranscriptionRecord[],
  anchorDeltaMs: number,
): GeminiDerivedUtterance[] {
  const sorted = [...records].sort((a, b) => {
    const d = a.offsetFromBridgeOpenMs - b.offsetFromBridgeOpenMs;
    return d !== 0 ? d : a.role.localeCompare(b.role);
  });

  const utterances: GeminiDerivedUtterance[] = [];
  let lastEndSec = 0;

  const flush = (role: "input" | "output", text: string, offsetFromBridgeOpenMs: number): void => {
    const t = text.trim();
    if (!t) {
      return;
    }
    const recMs = Math.max(0, offsetFromBridgeOpenMs - anchorDeltaMs);
    const endSec = recMs / 1000;
    const startSec = lastEndSec;
    const segEnd = Math.max(startSec + 0.05, endSec);
    const speakerLabel: GeminiDerivedUtterance["speakerLabel"] =
      role === "input" ? "INTERVIEWEE" : "INTERVIEWER";
    utterances.push({
      segment: new SpeechSegment(startSec, segEnd, t),
      speakerLabel,
    });
    lastEndSec = segEnd;
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

  return utterances;
}

export function speechTranscriptionFromGeminiUtterances(utterances: GeminiDerivedUtterance[]): SpeechTranscription {
  const segments = utterances.map((u) => u.segment);
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
  const records = await readGeminiRealtimeTranscriptionRecords(paths, sessionId);
  if (records.length === 0) {
    return null;
  }
  const meta = await readGeminiAudioMeta(paths, sessionId);
  if (!meta) {
    return null;
  }
  const anchorDeltaMs = await computeRecordingAnchorDeltaMs(
    db,
    sessionId,
    meta.bridgeOpenedAtWallMs,
  );
  const utterances = mergeGeminiRealtimeRecordsToUtterances(records, anchorDeltaMs);
  if (utterances.length === 0) {
    return null;
  }
  return { utterances, anchorDeltaMs };
}
