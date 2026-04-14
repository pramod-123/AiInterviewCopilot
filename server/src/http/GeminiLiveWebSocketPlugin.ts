import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IAppDao } from "../dao/IAppDao.js";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import {
  EndSensitivity,
  GoogleGenAI,
  type LiveServerMessage,
  type LiveServerSessionResumptionUpdate,
  Modality,
  type Session,
  type SessionResumptionConfig,
  StartSensitivity,
  TurnCoverage,
} from "@google/genai";
import type { WebSocket } from "ws";
import {
  appendGeminiModelAudioChunk,
  appendGeminiRealtimeTranscription,
  initGeminiAudioCapture,
} from "../live-session/geminiLiveAudioCapture.js";
import { buildGeminiLiveInterviewerSystemInstruction } from "../prompts/buildGeminiLiveInterviewerSystemInstruction.js";

/**
 * Wraps candidate editor buffer for {@link Session.sendRealtimeInput} text turns.
 * No server-side length cap — the Live API may still reject or truncate per Google’s limits.
 * @public — exported for unit tests
 */
export function formatCandidateEditorSnapshotForGeminiLive(code: string): string {
  const raw = typeof code === "string" ? code : "";
  const body = raw.trim().length > 0 ? raw : "(empty editor buffer)";
  return [
    "[Candidate editor — full buffer as plain text. The interview problem is in your system instructions above. Screen/video frames are not sent; only this buffer updates when their code changes.]",
    "",
    body,
  ].join("\n");
}

/** Client → server JSON (UTF-8 text frames). */
export type GeminiLiveClientMessage =
  | { type: "audio"; data: string; mimeType?: string }
  /** LeetCode editor buffer (server formats and sends as a Live text turn). */
  | { type: "editorCode"; code: string }
  | { type: "text"; text: string }
  | { type: "audioStreamEnd"; value?: boolean }
  | { type: "ping" };

type SessionParams = { Params: { id: string } };

/**
 * Live `sessionResumption`: pass `{ handle }` after a prior token, or `{}` on first connect so the
 * server emits `SessionResumptionUpdate` messages. Do not set `transparent` on Gemini API / mldev.
 * @see https://ai.google.dev/gemini-api/docs/live-api/session-management#session-resumption
 */
function liveSessionResumptionConfig(handle: string | undefined): SessionResumptionConfig {
  return handle != null && handle.length > 0 ? { handle } : {};
}

/** Browser payload for `sessionResumptionUpdate` (`newHandle` stays server-only). */
function clientPayloadSessionResumptionUpdate(sr: LiveServerSessionResumptionUpdate): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: "sessionResumptionUpdate",
    resumable: sr.resumable ?? null,
  };
  if (sr.lastConsumedClientMessageIndex != null) {
    payload.lastConsumedClientMessageIndex = sr.lastConsumedClientMessageIndex;
  }
  return payload;
}

/**
 * WebSocket bridge: browser ↔ Fastify ↔ Gemini Live API (`GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`).
 * Uses API `v1alpha` for Live setup fields such as proactive audio (see Gemini Live API capabilities; 2.5 Flash Live only).
 * Session management (see https://ai.google.dev/gemini-api/docs/live-api/session-management) —
 * `sessionResumption` is always set (empty on first connect, then `handle` from server updates); upstream reconnect after
 * `onclose` passes the latest handle. `contextWindowCompression.slidingWindow` extends long audio sessions per Google docs.
 * Live always sets `thinkingConfig.includeThoughts: true`. Thought text is mapped to `modelThought` and forwarded to the browser with other payloads (`modelText`, audio, etc.).
 * Path: `/api/live-sessions/:id/realtime` — session must be `ACTIVE`.
 */
export class GeminiLiveWebSocketPlugin {
  constructor(
    private readonly db: IAppDao,
    private readonly paths: AppPaths,
  ) {}

  async register(app: FastifyInstance): Promise<void> {
    app.get<SessionParams>(
      "/api/live-sessions/:id/realtime",
      { websocket: true },
      (socket, request) => {
        this.handleBrowserSocket(socket, request);
      },
    );
  }

  /**
   * Maps Gemini Live server messages to compact JSON payloads.
   * `modelThought` is included for logging and is forwarded to the browser like other payload types.
   * @see https://ai.google.dev/gemini-api/docs/live
   */
  static messageToClientPayload(msg: LiveServerMessage): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];

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
          /** Thought summaries use `part.thought === true` (see Thinking API / Live `thinkingConfig.includeThoughts`). */
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

  /** Outbound WebSocket frames (same order as {@link messageToClientPayload}). */
  static payloadsForClientSocket(payloads: Record<string, unknown>[]): Record<string, unknown>[] {
    return payloads;
  }

  private static safeSend(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  private static handleClientJson(
    session: Session,
    raw: string,
    log: {
      debug: (o: object, m: string) => void;
      info: (o: object, m: string) => void;
      warn: (o: object, m: string) => void;
    },
    sessionId: string,
  ): void {
    let parsed: GeminiLiveClientMessage;
    try {
      parsed = JSON.parse(raw) as GeminiLiveClientMessage;
    } catch {
      log.warn({ raw: raw.slice(0, 120) }, "gemini live: invalid JSON from client");
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

  private handleBrowserSocket(socket: WebSocket, request: FastifyRequest<SessionParams>): void {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      socket.close(1013, "GEMINI_API_KEY not configured");
      return;
    }

    const model = process.env.GEMINI_LIVE_MODEL?.trim();
    if (!model) {
      socket.close(1013, "GEMINI_LIVE_MODEL not configured");
      return;
    }

    void this.attachGeminiLive(socket, request, apiKey, model);
  }

  private async attachGeminiLive(
    socket: WebSocket,
    request: FastifyRequest<SessionParams>,
    apiKey: string,
    model: string,
  ): Promise<void> {
    const log = request.log;
    const sessionId = request.params.id;
    let geminiSession: Session | null = null;
    /** Browser disconnected or we gave up reconnecting — stop all work. */
    let bridgeEnded = false;
    /** Serialized reconnect after upstream closes (avoids parallel onclose → double reconnect). */
    let reconnectScheduled = false;

    const endBridge = (code: number, reason: string): void => {
      if (bridgeEnded) {
        return;
      }
      bridgeEnded = true;
      try {
        geminiSession?.close();
      } catch {
        /* ignore */
      }
      geminiSession = null;
      if (socket.readyState === socket.OPEN) {
        socket.close(code, reason);
      }
    };

    const live = await this.db.getLiveSessionForGeminiWs(sessionId);
    if (!live || live.status !== "ACTIVE") {
      socket.close(1008, "Session not found or not ACTIVE");
      return;
    }
    if (!live.liveInterviewerEnabled) {
      socket.close(1008, "Live interviewer disabled for this session");
      return;
    }

    const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
    const systemInstruction = buildGeminiLiveInterviewerSystemInstruction(live.question);
    const paths = this.paths;
    /** First upstream `onopen` for this browser socket (kept across Gemini reconnects). */
    let bridgeOpenedAtWallMs: number | null = null;
    /** Latest `newHandle` from Gemini `sessionResumptionUpdate` (used when reconnecting upstream after `onclose`). */
    let liveResumptionHandle: string | undefined;
    const connectUpstream = async (): Promise<void> => {
      if (bridgeEnded || socket.readyState !== socket.OPEN) {
        return;
      }
      try {
        geminiSession = await ai.live.connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction,
            /** Model may skip speaking when input is not relevant (requires v1alpha; 2.5 Flash Live). */
            proactivity: { proactiveAudio: true },
            thinkingConfig: { includeThoughts: true },
            sessionResumption: liveSessionResumptionConfig(liveResumptionHandle),
            contextWindowCompression: { slidingWindow: {} },
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                /** More silence before end-of-speech (ms) — fewer mid-thought cuts on live mic. */
                silenceDurationMs: 1200,
                /** Higher = longer sustained speech before start-of-speech commits — fewer false starts (noise, keyboard). */
                prefixPaddingMs: 200,
              },
              turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
            },
          },
          callbacks: {
            onopen: () => {
              bridgeOpenedAtWallMs ??= Date.now();
              void initGeminiAudioCapture(this.db, paths, sessionId, bridgeOpenedAtWallMs);
              log.info({ sessionId, model }, "gemini live: bridge open");
              log.debug(
                {
                  sessionId,
                  model,
                  payload: {
                    liveResumptionHandle: liveResumptionHandle ?? null,
                    includeThoughts: true,
                    bridgeOpenedAtWallMs,
                  },
                },
                "gemini live: onopen detail",
              );
              GeminiLiveWebSocketPlugin.safeSend(socket, { type: "ready", model });
            },
            onmessage: (msg: LiveServerMessage) => {
              const sr = msg.sessionResumptionUpdate;
              if (
                sr &&
                sr.resumable !== false &&
                typeof sr.newHandle === "string" &&
                sr.newHandle.length > 0
              ) {
                liveResumptionHandle = sr.newHandle;
              }
              const payloads = GeminiLiveWebSocketPlugin.messageToClientPayload(msg);
              log.debug({ sessionId, payload: msg }, "gemini live: onmessage");
              for (const p of GeminiLiveWebSocketPlugin.payloadsForClientSocket(payloads)) {
                GeminiLiveWebSocketPlugin.safeSend(socket, p);
              }
              const anchor = bridgeOpenedAtWallMs;
              if (anchor != null) {
                void Promise.all(
                  payloads.map((p) =>
                    p.type === "inputTranscription" && typeof p.text === "string"
                      ? appendGeminiRealtimeTranscription(
                          paths,
                          sessionId,
                          anchor,
                          "input",
                          p.text,
                          Boolean(p.finished),
                        )
                      : p.type === "outputTranscription" && typeof p.text === "string"
                        ? appendGeminiRealtimeTranscription(
                            paths,
                            sessionId,
                            anchor,
                            "output",
                            p.text,
                            Boolean(p.finished),
                          )
                        : p.type === "modelAudio" &&
                            typeof p.data === "string" &&
                            typeof p.mimeType === "string" &&
                            p.data.length > 0
                          ? appendGeminiModelAudioChunk(this.db, sessionId, anchor, p.mimeType, p.data)
                          : Promise.resolve(),
                  ),
                ).catch(() => {});
              }
            },
            onerror: (e) => {
              log.warn({ sessionId, model, payload: e }, "gemini live: onerror");
              GeminiLiveWebSocketPlugin.safeSend(socket, {
                type: "error",
                message: String((e as { error?: unknown }).error ?? "Gemini Live error"),
              });
            },
            onclose: (e) => {
              const ev = e as { code?: number; reason?: string };
              log.info(
                { sessionId, model, code: ev.code ?? null, reason: ev.reason ?? null },
                "gemini live: upstream closed",
              );
              log.debug(
                {
                  sessionId,
                  model,
                  payload: e,
                  bridgeEnded,
                  browserSocketOpen: socket.readyState === socket.OPEN,
                  reconnectScheduled,
                },
                "gemini live: onclose detail",
              );
              geminiSession = null;

              if (bridgeEnded || socket.readyState !== socket.OPEN || reconnectScheduled) {
                return;
              }
              reconnectScheduled = true;

              void (async () => {
                try {
                  const delayMs = 450;
                  GeminiLiveWebSocketPlugin.safeSend(socket, {
                    type: "reconnecting",
                    delayMs,
                    upstreamCode: ev?.code ?? null,
                    upstreamReason: ev?.reason ?? null,
                  });
                  await new Promise((r) => setTimeout(r, delayMs));
                  if (bridgeEnded || socket.readyState !== socket.OPEN) {
                    return;
                  }
                  await connectUpstream();
                } catch (err) {
                  log.error({ err, sessionId }, "Gemini live reconnect failed");
                  endBridge(1011, "Gemini reconnect failed");
                } finally {
                  reconnectScheduled = false;
                }
              })();
            },
          },
        });
      } catch (err) {
        log.error({ err, sessionId }, "Gemini live.connect failed");
        endBridge(1011, "Gemini connect failed");
      }
    };

    await connectUpstream();
    if (bridgeEnded) {
      return;
    }

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!geminiSession || bridgeEnded) {
        return;
      }
      try {
        if (isBinary) {
          log.warn({ sessionId }, "gemini live: binary client frames not supported; use JSON text");
          return;
        }
        const raw = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        GeminiLiveWebSocketPlugin.handleClientJson(geminiSession, raw, log, sessionId);
      } catch (err) {
        log.warn({ err, sessionId }, "gemini live: failed to handle client message");
      }
    });

    socket.on("close", () => {
      bridgeEnded = true;
      try {
        geminiSession?.close();
      } catch {
        /* ignore */
      }
      geminiSession = null;
    });

    socket.on("error", (err: Error) => {
      log.warn({ err, sessionId }, "browser websocket error");
      bridgeEnded = true;
      try {
        geminiSession?.close();
      } catch {
        /* ignore */
      }
      geminiSession = null;
    });
  }
}
