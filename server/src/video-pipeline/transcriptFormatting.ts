import type { SpeechSegment, SpeechTranscription } from "../types/speechTranscription.js";

// --- SRT --------------------------------------------------------------------

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

function toSrtTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = 0;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const msClamped = ms >= 1000 ? 999 : ms;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(msClamped)}`;
}

export function speechSegmentToSrtBlock(index: number, seg: SpeechSegment): string {
  return [
    String(index),
    `${toSrtTimestamp(seg.startSec)} --> ${toSrtTimestamp(seg.endSec)}`,
    seg.text.trim(),
    "",
  ].join("\n");
}

export function transcriptionToSrt(transcription: SpeechTranscription): string {
  return transcription.segments
    .map((seg, i) => speechSegmentToSrtBlock(i + 1, seg))
    .join("\n");
}

// --- Frame ↔ speech alignment -----------------------------------------------

export type FrameOcrRecord = {
  frameIndex: number;
  timestampSec: number;
  ocrText: string;
  overlappingSpeech: Array<{
    startSec: number;
    endSec: number;
    text: string;
  }>;
};

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function alignFramesToSpeech(
  frameTimesSec: number[],
  ocrTexts: string[],
  speechSegments: SpeechSegment[],
  windowHalfSec: number = 0.75,
): FrameOcrRecord[] {
  const records: FrameOcrRecord[] = [];
  const n = Math.min(frameTimesSec.length, ocrTexts.length);
  for (let i = 0; i < n; i++) {
    const t = frameTimesSec[i];
    const w0 = t - windowHalfSec;
    const w1 = t + windowHalfSec;
    const overlappingSpeech = speechSegments
      .filter((s) => overlaps(w0, w1, s.startSec, s.endSec))
      .map((s) => ({
        startSec: s.startSec,
        endSec: s.endSec,
        text: s.text.trim(),
      }));
    records.push({
      frameIndex: i + 1,
      timestampSec: t,
      ocrText: ocrTexts[i] ?? "",
      overlappingSpeech,
    });
  }
  return records;
}

// --- final-transcript.json --------------------------------------------------

export type FinalTranscriptSegment = {
  start: number;
  end: number;
  audioTranscript: string;
  frameData: Array<{ frameNumber: number; text: string }>;
};

export type FinalTranscriptJson = FinalTranscriptSegment[];

function secToMs(sec: number): number {
  return Math.round(sec * 1000);
}

type TimelineSlice =
  | { kind: "gap_leading"; endSec: number }
  | { kind: "speech"; startSec: number; endSec: number; text: string }
  | { kind: "gap_between"; afterSec: number; beforeSec: number }
  | { kind: "gap_trailing"; startSec: number; endSec: number }
  | { kind: "gap_full"; endSec: number };

function timeInSlice(t: number, s: TimelineSlice): boolean {
  switch (s.kind) {
    case "gap_leading":
      return t >= 0 && t < s.endSec;
    case "speech":
      return t >= s.startSec && t <= s.endSec;
    case "gap_between":
      return t > s.afterSec && t < s.beforeSec;
    case "gap_trailing":
      return t > s.startSec && t <= s.endSec;
    case "gap_full":
      return t >= 0 && t <= s.endSec;
    default:
      return false;
  }
}

function sliceToOutputStub(s: TimelineSlice): {
  start: number;
  end: number;
  audioTranscript: string;
} {
  switch (s.kind) {
    case "gap_leading":
      return { start: 0, end: secToMs(s.endSec), audioTranscript: "" };
    case "speech":
      return {
        start: secToMs(s.startSec),
        end: secToMs(s.endSec),
        audioTranscript: s.text,
      };
    case "gap_between":
      return {
        start: secToMs(s.afterSec),
        end: secToMs(s.beforeSec),
        audioTranscript: "",
      };
    case "gap_trailing":
      return {
        start: secToMs(s.startSec),
        end: secToMs(s.endSec),
        audioTranscript: "",
      };
    case "gap_full":
      return { start: 0, end: secToMs(s.endSec), audioTranscript: "" };
    default:
      return { start: 0, end: 0, audioTranscript: "" };
  }
}

function buildTimelineSlices(
  orderedSegs: SpeechSegment[],
  durationSec: number,
): TimelineSlice[] {
  const eps = 1e-6;
  if (orderedSegs.length === 0) {
    return [{ kind: "gap_full", endSec: durationSec }];
  }

  const slices: TimelineSlice[] = [];
  const first = orderedSegs[0]!;
  if (first.startSec > eps) {
    slices.push({ kind: "gap_leading", endSec: first.startSec });
  }

  for (let k = 0; k < orderedSegs.length; k++) {
    const seg = orderedSegs[k]!;
    const text = seg.text.trim().replace(/\s+/g, " ").trim();
    slices.push({
      kind: "speech",
      startSec: seg.startSec,
      endSec: seg.endSec,
      text,
    });
    const next = orderedSegs[k + 1];
    if (next && seg.endSec < next.startSec - eps) {
      slices.push({
        kind: "gap_between",
        afterSec: seg.endSec,
        beforeSec: next.startSec,
      });
    }
  }

  const last = orderedSegs[orderedSegs.length - 1]!;
  if (last.endSec < durationSec - eps) {
    slices.push({
      kind: "gap_trailing",
      startSec: last.endSec,
      endSec: durationSec,
    });
  }

  return slices;
}

function resolveDurationSec(
  transcription: SpeechTranscription,
  frameTimestampsSec: number[],
  pairN: number,
  orderedSegs: SpeechSegment[],
): number {
  const maxFrame = pairN > 0 ? Math.max(...frameTimestampsSec.slice(0, pairN)) : 0;
  const maxSeg =
    orderedSegs.length > 0 ? Math.max(...orderedSegs.map((s) => s.endSec)) : 0;
  return Math.max(transcription.durationSec || 0, maxFrame, maxSeg, 1e-3);
}

export function buildFinalTranscriptJson(
  transcription: SpeechTranscription,
  frameTimestampsSec: number[],
  frameOcrTextsInOrder: string[],
): FinalTranscriptJson {
  const orderedSegs = [...transcription.segments].sort((a, b) => a.startSec - b.startSec);
  const pairN = Math.min(frameTimestampsSec.length, frameOcrTextsInOrder.length);
  const durationSec = resolveDurationSec(transcription, frameTimestampsSec, pairN, orderedSegs);

  if (orderedSegs.length === 0) {
    const stub = sliceToOutputStub({ kind: "gap_full", endSec: durationSec });
    return [
      {
        ...stub,
        audioTranscript: "",
        frameData: frameOcrTextsInOrder.slice(0, pairN).map((text, i) => ({
          frameNumber: i + 1,
          text,
        })),
      },
    ];
  }

  const slices = buildTimelineSlices(orderedSegs, durationSec);
  const out: FinalTranscriptSegment[] = slices.map((s) => {
    const stub = sliceToOutputStub(s);
    return { ...stub, frameData: [] };
  });

  for (let i = 0; i < pairN; i++) {
    const t = frameTimestampsSec[i]!;
    const text = frameOcrTextsInOrder[i]!;
    let placed = false;
    for (let j = 0; j < slices.length; j++) {
      if (timeInSlice(t, slices[j]!)) {
        out[j]!.frameData.push({ frameNumber: i + 1, text });
        placed = true;
        break;
      }
    }
    if (!placed && out.length > 0) {
      out[out.length - 1]!.frameData.push({ frameNumber: i + 1, text });
    }
  }

  return out;
}

// --- Evaluation LLM timeline (aligned speech + progressive frame OCR) ------------

export type InterviewEvaluationTimelineSegment = {
  start: number;
  end: number;
  speech: string;
  /** Progressive editor OCR strings (one per frame snapshot), in time order within this interval. */
  frameData: string[];
};

export function finalTranscriptToEvaluationTimeline(
  final: FinalTranscriptJson,
): InterviewEvaluationTimelineSegment[] {
  return final.map((s) => ({
    start: s.start,
    end: s.end,
    speech: s.audioTranscript,
    frameData: s.frameData.map((f) => f.text),
  }));
}

/**
 * Pretty-printed JSON array for the evaluation user prompt. Shrinks `frameData` from the end
 * until the string fits `maxChars` (or drops trailing segments).
 */
export function stringifyInterviewTimelineForEvaluation(
  segments: InterviewEvaluationTimelineSegment[],
  maxChars: number,
): string {
  const working = segments.map((seg) => ({
    start: seg.start,
    end: seg.end,
    speech: seg.speech,
    frameData: [...seg.frameData],
  }));

  const note = "\n\n... [interview timeline truncated for evaluation context limit]";
  for (let iter = 0; iter < 500_000; iter++) {
    const body = JSON.stringify(working, null, 2);
    if (body.length <= maxChars) {
      return body;
    }
    let removed = false;
    for (let i = working.length - 1; i >= 0 && !removed; i--) {
      if (working[i]!.frameData.length > 0) {
        working[i]!.frameData.pop();
        removed = true;
      }
    }
    if (!removed) {
      for (let i = working.length - 1; i >= 0 && !removed; i--) {
        const sp = working[i]!.speech;
        if (sp.length > 120) {
          working[i]!.speech = `${sp.slice(0, sp.length - 600)}…[speech truncated]`;
          removed = true;
        }
      }
    }
    if (!removed && working.length > 1) {
      working.pop();
      continue;
    }
    if (!removed) {
      const b = JSON.stringify(working, null, 2);
      if (b.length <= maxChars) {
        return b;
      }
      return `${b.slice(0, Math.max(0, maxChars - note.length))}${note}`;
    }
  }
  return "[]";
}
