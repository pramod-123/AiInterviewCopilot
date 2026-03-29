/** Time-bounded text from STT (seconds, Whisper-style). */
export class SpeechSegment {
  constructor(
    readonly startSec: number,
    readonly endSec: number,
    readonly text: string,
  ) {}
}

/** Normalized output from a speech-to-text provider. */
export class SpeechTranscription {
  constructor(
    readonly segments: SpeechSegment[],
    readonly durationSec: number,
    readonly language: string | null,
    readonly fullText: string | null,
    /** Stable id for persistence / API (e.g. `local`, `openai` from Whisper payload, `remote:openai`). */
    readonly providerId: string,
    readonly modelId: string | null,
  ) {}
}
