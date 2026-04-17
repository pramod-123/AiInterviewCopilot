import type { LiveServerMessage, LiveServerSessionResumptionUpdate } from "@google/genai";
import type {
  LiveRealtimeModelOutputPayload,
  LiveRealtimeSessionResumptionUpdatePayload,
} from "./LiveRealtimeModelOutputBatch.js";

/** Browser payload for `sessionResumptionUpdate` (`newHandle` stays server-only). */
export function clientPayloadSessionResumptionUpdate(
  sr: LiveServerSessionResumptionUpdate,
): LiveRealtimeSessionResumptionUpdatePayload {
  const payload: LiveRealtimeSessionResumptionUpdatePayload = {
    type: "sessionResumptionUpdate",
    resumable: sr.resumable ?? null,
  };
  if (sr.lastConsumedClientMessageIndex != null) {
    payload.lastConsumedClientMessageIndex = sr.lastConsumedClientMessageIndex;
  }
  return payload;
}

/**
 * Maps Gemini Live server messages to compact JSON payloads for the browser WebSocket.
 * `modelThought` is included for logging and is forwarded like other payload types.
 * @see https://ai.google.dev/gemini-api/docs/live
 */
export function geminiLiveMessageToClientPayload(msg: LiveServerMessage): LiveRealtimeModelOutputPayload[] {
  const out: LiveRealtimeModelOutputPayload[] = [];

  if (msg.toolCall?.functionCalls?.length) {
    out.push({
      type: "toolCall",
      names: msg.toolCall.functionCalls.map((f) => f.name ?? "").filter(Boolean),
    });
  }

  const sc = msg.serverContent;
  if (sc?.interrupted) {
    out.push({ type: "interrupted", value: true });
  }
  if (sc?.generationComplete) {
    out.push({ type: "generationComplete", value: true });
  }
  if (sc?.turnComplete) {
    out.push({ type: "turnComplete", value: true });
  }
  if (sc?.waitingForInput) {
    out.push({ type: "waitingForInput", value: true });
  }

  if (sc?.inputTranscription?.text != null && sc.inputTranscription.text !== "") {
    out.push({
      type: "inputTranscription",
      text: sc.inputTranscription.text,
      finished: Boolean(sc.inputTranscription.finished),
    });
  }
  if (sc?.outputTranscription?.text != null && sc.outputTranscription.text !== "") {
    out.push({
      type: "outputTranscription",
      text: sc.outputTranscription.text,
      finished: Boolean(sc.outputTranscription.finished),
    });
  }

  const parts = sc?.modelTurn?.parts;
  if (parts) {
    for (const part of parts) {
      const id = part.inlineData;
      if (id?.data && id.mimeType?.startsWith("audio/")) {
        out.push({
          type: "modelAudio",
          mimeType: id.mimeType,
          data: id.data,
        });
      }
      if (part.text) {
        if (part.thought === true) {
          out.push({ type: "modelThought", text: part.text });
        } else {
          out.push({ type: "modelText", text: part.text });
        }
      }
    }
  }

  if (msg.goAway) {
    out.push({ type: "goAway", timeLeft: msg.goAway.timeLeft ?? null });
  }

  if (msg.sessionResumptionUpdate) {
    out.push(clientPayloadSessionResumptionUpdate(msg.sessionResumptionUpdate));
  }

  return out;
}
