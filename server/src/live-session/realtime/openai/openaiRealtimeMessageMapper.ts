import type { LiveRealtimeModelOutputPayload } from "../LiveRealtimeModelOutputBatch.js";

/** OpenAI Realtime output is PCM16 at 24 kHz (matches extension `modelAudio` handling). */
export const OPENAI_REALTIME_OUTPUT_AUDIO_MIME = "audio/pcm;rate=24000";

/**
 * Mutable transcript accumulators for delta events (keyed by stable ids from server events).
 */
export type OpenAIRealtimeMapperState = {
  outputAudioTranscript: Record<string, string>;
  inputAudioTranscript: Record<string, string>;
};

export function createOpenAIRealtimeMapperState(): OpenAIRealtimeMapperState {
  return { outputAudioTranscript: {}, inputAudioTranscript: {} };
}

function outAudioTsKey(responseId: string, itemId: string, contentIndex: number): string {
  return `${responseId}\0${itemId}\0${contentIndex}`;
}

function inAudioTsKey(itemId: string, contentIndex: number): string {
  return `${itemId}\0${contentIndex}`;
}

/** OpenAI Realtime: `usage` on transcription.completed may bill by audio duration (seconds). */
function inputTranscriptionCompletedDurationSec(ev: Record<string, unknown>): number | undefined {
  const usage = ev.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const u = usage as Record<string, unknown>;
  if (u.type === "duration" && typeof u.seconds === "number" && Number.isFinite(u.seconds) && u.seconds > 0) {
    return u.seconds;
  }
  return undefined;
}

/**
 * Maps one OpenAI Realtime server JSON event to normalized browser payloads (Gemini-bridge compatible).
 */
export function openaiRealtimeServerEventToClientPayloads(
  ev: Record<string, unknown>,
  state: OpenAIRealtimeMapperState,
): LiveRealtimeModelOutputPayload[] {
  const type = ev.type;
  if (typeof type !== "string") {
    return [];
  }

  const out: LiveRealtimeModelOutputPayload[] = [];

  switch (type) {
    case "response.output_item.added": {
      const item = ev.item as { type?: string; name?: string } | undefined;
      if (item?.type === "function_call" && typeof item.name === "string" && item.name.length > 0) {
        out.push({ type: "toolCall", names: [item.name] });
      }
      break;
    }
    case "response.audio.delta": {
      const delta = ev.delta;
      if (typeof delta === "string" && delta.length > 0) {
        out.push({
          type: "modelAudio",
          mimeType: OPENAI_REALTIME_OUTPUT_AUDIO_MIME,
          data: delta,
        });
      }
      break;
    }
    case "response.audio_transcript.delta": {
      const delta = ev.delta;
      const responseId = ev.response_id;
      const itemId = ev.item_id;
      const contentIndex = typeof ev.content_index === "number" ? ev.content_index : 0;
      if (
        typeof delta === "string" &&
        delta.length > 0 &&
        typeof responseId === "string" &&
        typeof itemId === "string"
      ) {
        const key = outAudioTsKey(responseId, itemId, contentIndex);
        state.outputAudioTranscript[key] = (state.outputAudioTranscript[key] ?? "") + delta;
        out.push({
          type: "outputTranscription",
          text: state.outputAudioTranscript[key]!,
          finished: false,
          itemKey: key,
        });
      }
      break;
    }
    case "response.audio_transcript.done": {
      const transcript = ev.transcript;
      const responseId = ev.response_id;
      const itemId = ev.item_id;
      const contentIndex = typeof ev.content_index === "number" ? ev.content_index : 0;
      if (typeof responseId === "string" && typeof itemId === "string") {
        const key = outAudioTsKey(responseId, itemId, contentIndex);
        delete state.outputAudioTranscript[key];
      }
      if (typeof transcript === "string" && transcript.length > 0) {
        out.push({
          type: "outputTranscription",
          text: transcript,
          finished: true,
          ...(typeof responseId === "string" && typeof itemId === "string"
            ? { itemKey: outAudioTsKey(responseId, itemId, contentIndex) }
            : {}),
        });
      }
      break;
    }
    case "response.text.delta": {
      const delta = ev.delta;
      if (typeof delta === "string" && delta.length > 0) {
        out.push({ type: "modelText", text: delta });
      }
      break;
    }
    case "conversation.item.input_audio_transcription.delta": {
      const delta = ev.delta;
      const itemId = ev.item_id;
      const contentIndex = typeof ev.content_index === "number" ? ev.content_index : 0;
      if (typeof delta === "string" && delta.length > 0 && typeof itemId === "string") {
        const key = inAudioTsKey(itemId, contentIndex);
        state.inputAudioTranscript[key] = (state.inputAudioTranscript[key] ?? "") + delta;
        out.push({
          type: "inputTranscription",
          text: state.inputAudioTranscript[key]!,
          finished: false,
          itemKey: key,
        });
      }
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = ev.transcript;
      const itemId = ev.item_id;
      const contentIndex = typeof ev.content_index === "number" ? ev.content_index : 0;
      if (typeof itemId === "string") {
        delete state.inputAudioTranscript[inAudioTsKey(itemId, contentIndex)];
      }
      if (typeof transcript === "string" && transcript.length > 0) {
        const dur = inputTranscriptionCompletedDurationSec(ev);
        out.push({
          type: "inputTranscription",
          text: transcript,
          finished: true,
          ...(typeof itemId === "string" ? { itemKey: inAudioTsKey(itemId, contentIndex) } : {}),
          ...(dur != null ? { sourceAudioDurationSec: dur } : {}),
        });
      }
      break;
    }
    case "response.done": {
      const response = ev.response as
        | { status?: string; status_details?: { reason?: string } }
        | undefined;
      const status = response?.status;
      const reason = response?.status_details?.reason;
      if (status === "cancelled" && reason === "turn_detected") {
        out.push({ type: "interrupted", value: true });
      }
      if (status === "completed") {
        out.push({ type: "generationComplete", value: true });
        out.push({ type: "turnComplete", value: true });
        out.push({ type: "waitingForInput", value: true });
      }
      break;
    }
    default:
      break;
  }

  return out;
}
