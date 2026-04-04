/** One diarized line (WhisperX / pyannote style speaker ids). */
export type DiarizedSegment = {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
};

export type DiarizationPipelineResult = {
  provider: "whisperx" | "openai_semantic";
  model: string;
  language: string | null;
  audioSource: "dialogue_mixed" | "tab_mic_only";
  segmentCount: number;
  artifactPath: string;
  segments: DiarizedSegment[];
};
