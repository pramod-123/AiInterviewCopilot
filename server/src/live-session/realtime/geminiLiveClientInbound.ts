import type { Session } from "@google/genai";
import type { LiveRealtimeBridgeLogger } from "./LiveRealtimeBridgeHandler.js";
import { formatCandidateEditorSnapshotForGeminiLive } from "./geminiLiveEditorFormat.js";

/** Client → server JSON (UTF-8 text frames) for the Gemini Live bridge. */
export type GeminiLiveClientMessage =
  | { type: "audio"; data: string; mimeType?: string }
  | { type: "editorCode"; code: string }
  | { type: "text"; text: string }
  | { type: "audioStreamEnd"; value?: boolean }
  | { type: "ping" };

/**
 * Parses browser JSON and forwards to Gemini `sendRealtimeInput`.
 */
export function applyGeminiLiveClientJson(
  session: Session,
  raw: string,
  log: LiveRealtimeBridgeLogger,
  sessionId: string,
): void {
  let parsed: GeminiLiveClientMessage;
  try {
    parsed = JSON.parse(raw) as GeminiLiveClientMessage;
  } catch {
    log.warn({ sessionId, raw: raw.slice(0, 120) }, "gemini live: invalid JSON from client");
    return;
  }

  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    return;
  }

  const recordSend = (snapshot: Record<string, unknown>): void => {
    log.debug({ sessionId, ...snapshot }, "gemini live: realtimeSend");
  };

  switch (parsed.type) {
    case "ping":
      return;
    case "audio":
      if (typeof parsed.data === "string" && parsed.data.length > 0) {
        const mimeType = parsed.mimeType?.trim() || "audio/pcm;rate=16000";
        session.sendRealtimeInput({
          audio: {
            data: parsed.data,
            mimeType,
          },
        });
        recordSend({
          atMs: Date.now(),
          kind: "audio",
          audioDataChars: parsed.data.length,
          mimeType,
        });
      }
      break;
    case "editorCode":
      if (typeof parsed.code === "string") {
        const rawCodeChars = parsed.code.length;
        const wrapped = formatCandidateEditorSnapshotForGeminiLive(parsed.code);
        session.sendRealtimeInput({ text: wrapped });
        recordSend({
          atMs: Date.now(),
          kind: "editorCode",
          rawCodeChars,
          sentTextChars: wrapped.length,
        });
      }
      break;
    case "text":
      if (typeof parsed.text === "string" && parsed.text.length > 0) {
        const text = parsed.text;
        session.sendRealtimeInput({ text });
        recordSend({
          atMs: Date.now(),
          kind: "text",
          textChars: text.length,
        });
      }
      break;
    case "audioStreamEnd":
      session.sendRealtimeInput({ audioStreamEnd: true });
      recordSend({ atMs: Date.now(), kind: "audioStreamEnd" });
      break;
    default:
      break;
  }
}
