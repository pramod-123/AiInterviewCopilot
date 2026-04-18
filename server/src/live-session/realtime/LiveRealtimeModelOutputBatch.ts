export type LiveRealtimeToolCallPayload = {
  type: "toolCall";
  names: string[];
};

export type LiveRealtimeBooleanFlagPayload = {
  type: "interrupted" | "generationComplete" | "turnComplete" | "waitingForInput";
  value: true;
};

export type LiveRealtimeTranscriptionPayload = {
  type: "inputTranscription" | "outputTranscription";
  text: string;
  finished: boolean;
  /** OpenAI: correlates input deltas with `completed` for the same user audio item (item_id + content_index). */
  itemKey?: string;
  /**
   * OpenAI `conversation.item.input_audio_transcription.completed`: when `usage.type === "duration"`,
   * `usage.seconds` is the billed audio length; the bridge uses it to approximate wall-clock start if
   * no streaming delta arrived first (avoids anchoring the whole span at completion time).
   */
  sourceAudioDurationSec?: number;
};

export type LiveRealtimeModelAudioPayload = {
  type: "modelAudio";
  mimeType: string;
  data: string;
};

export type LiveRealtimeModelTextPayload = {
  type: "modelText" | "modelThought";
  text: string;
};

export type LiveRealtimeGoAwayPayload = {
  type: "goAway";
  timeLeft: string | null;
};

export type LiveRealtimeSessionResumptionUpdatePayload = {
  type: "sessionResumptionUpdate";
  resumable: boolean | null;
  lastConsumedClientMessageIndex?: number | string;
};

export type LiveRealtimeModelOutputPayload =
  | LiveRealtimeToolCallPayload
  | LiveRealtimeBooleanFlagPayload
  | LiveRealtimeTranscriptionPayload
  | LiveRealtimeModelAudioPayload
  | LiveRealtimeModelTextPayload
  | LiveRealtimeGoAwayPayload
  | LiveRealtimeSessionResumptionUpdatePayload;

/**
 * One upstream model → browser turn after normalization: concrete payloads for the extension,
 * raw vendor message for debug logs, and wall-clock anchor for persistence (null before bridge open).
 */
export class LiveRealtimeModelOutputBatch {
  constructor(
    readonly payloads: ReadonlyArray<LiveRealtimeModelOutputPayload>,
    readonly rawMessageForLog: unknown,
    readonly bridgeOpenedAtWallMs: number | null,
  ) {}
}
