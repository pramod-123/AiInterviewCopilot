export type SrtLabeledSegment = {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string;
};

export type SrtGenerationProvider = "none";

export type SrtGenerationResult = {
  provider: SrtGenerationProvider;
  model: string;
  language: string | null;
  audioSource: "dialogue_mixed" | "tab_mic_only";
  segmentCount: number;
  srt: string;
  segments: SrtLabeledSegment[];
};
