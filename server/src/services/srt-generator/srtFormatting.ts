import type { SrtLabeledSegment } from "../../types/srtGeneration.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function ts(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1_000);
  const rem = total % 1_000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(rem)}`;
}

export function renderSrt(segments: SrtLabeledSegment[]): string {
  return segments
    .map((seg, i) => {
      const text = `[${seg.speakerLabel}] ${seg.text}`.trim();
      return `${i + 1}\n${ts(seg.startMs)} --> ${ts(seg.endMs)}\n${text}\n`;
    })
    .join("\n");
}
