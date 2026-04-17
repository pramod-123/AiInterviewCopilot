import {
  EndSensitivity,
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
  type SessionResumptionConfig,
  StartSensitivity,
  TurnCoverage,
} from "@google/genai";
import type { IAppDao } from "../../dao/IAppDao.js";
import type { AppPaths } from "../../infrastructure/AppPaths.js";
import { initRealtimeAudioCapture } from "../interviewBridgeCapture.js";
import { LiveRealtimeBridgeHandler, type LiveRealtimeBridgeLogger } from "./LiveRealtimeBridgeHandler.js";
import { applyGeminiLiveClientJson } from "./geminiLiveClientInbound.js";
import { LiveRealtimeModelOutputBatch } from "./LiveRealtimeModelOutputBatch.js";
import { geminiLiveMessageToClientPayload } from "./geminiLiveMessageMapper.js";
import { buildGeminiLiveInterviewerSystemInstruction } from "../../prompts/buildGeminiLiveInterviewerSystemInstruction.js";

export { formatCandidateEditorSnapshotForGeminiLive } from "./geminiLiveEditorFormat.js";
export type { GeminiLiveClientMessage } from "./geminiLiveClientInbound.js";

/**
 * Live `sessionResumption`: pass `{ handle }` after a prior token, or `{}` on first connect so the
 * server emits `SessionResumptionUpdate` messages. Do not set `transparent` on Gemini API / mldev.
 * @see https://ai.google.dev/gemini-api/docs/live-api/session-management#session-resumption
 */
function liveSessionResumptionConfig(handle: string | undefined): SessionResumptionConfig {
  return handle != null && handle.length > 0 ? { handle } : {};
}

/**
 * Gemini Live bridge for `/api/live-sessions/:id/realtime`: extension ↔ Gemini Live API,
 * upstream session lifecycle, and model output mapping. Client transport is owned by {@link LiveRealtimeBridgeHandler}.
 */
export class GeminiLiveBridgeHandler extends LiveRealtimeBridgeHandler {
  private geminiSession: Session | null = null;
  /** End of client channel or fatal bridge end; stops inbound JSON and upstream reconnect. */
  private bridgeEnded = false;

  constructor(
    sessionId: string,
    db: IAppDao,
    paths: AppPaths,
    model: string,
    log: LiveRealtimeBridgeLogger,
    private readonly apiKey: string,
  ) {
    super(sessionId, db, paths, model, log);
  }

  protected async establishUpstreamSession(): Promise<boolean> {
    const endBridge = (code: number, reason: string): void => {
      if (this.bridgeEnded) {
        return;
      }
      this.bridgeEnded = true;
      try {
        this.geminiSession?.close();
      } catch {
        /* ignore */
      }
      this.setGeminiSession(null);
      this.closeClientChannel(code, reason);
    };

    const live = await this.db.getLiveSessionForGeminiWs(this.sessionId);
    if (!live || live.status !== "ACTIVE") {
      this.closeClientChannel(1008, "Session not found or not ACTIVE");
      return false;
    }
    if (!live.liveInterviewerEnabled) {
      this.closeClientChannel(1008, "Live interviewer disabled for this session");
      return false;
    }

    const ai = new GoogleGenAI({ apiKey: this.apiKey, apiVersion: "v1alpha" });
    const systemInstruction = buildGeminiLiveInterviewerSystemInstruction(live.question);
    let bridgeOpenedAtWallMs: number | null = null;
    let liveResumptionHandle: string | undefined;
    const reconnectState = { inFlight: false };

    const connectUpstream = async (): Promise<void> => {
      if (this.bridgeEnded || !this.isClientChannelOpen()) {
        return;
      }
      try {
        const session = await ai.live.connect({
          model: this.model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction,
            proactivity: { proactiveAudio: true },
            thinkingConfig: { includeThoughts: true },
            sessionResumption: liveSessionResumptionConfig(liveResumptionHandle),
            contextWindowCompression: { slidingWindow: {} },
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                silenceDurationMs: 1200,
                prefixPaddingMs: 200,
              },
              turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
            },
          },
          callbacks: {
            onopen: () => {
              bridgeOpenedAtWallMs ??= Date.now();
              this.geminiNotifyUpstreamOpened(bridgeOpenedAtWallMs, liveResumptionHandle ?? null);
            },
            onmessage: (msg: LiveServerMessage) => {
              this.dispatchGeminiServerMessage(msg, bridgeOpenedAtWallMs, (h) => {
                liveResumptionHandle = h;
              });
            },
            onerror: (e) => {
              this.notifyUpstreamError(e);
            },
            onclose: (e) => {
              this.handleGeminiLiveUpstreamClose(e, connectUpstream, endBridge, reconnectState);
            },
          },
        });
        this.setGeminiSession(session);
      } catch (err) {
        this.log.error({ err, sessionId: this.sessionId }, "Gemini live.connect failed");
        endBridge(1011, "Gemini connect failed");
      }
    };

    await connectUpstream();
    if (this.bridgeEnded) {
      return false;
    }
    return true;
  }

  protected onClientTextFromBrowser(raw: string): void {
    if (!this.geminiSession || this.bridgeEnded) {
      return;
    }
    this.dispatchBrowserJsonToGemini(raw);
  }

  protected onClientChannelEnded(): void {
    if (this.bridgeEnded) {
      return;
    }
    this.bridgeEnded = true;
    try {
      this.geminiSession?.close();
    } catch {
      /* ignore */
    }
    this.setGeminiSession(null);
  }

  private setGeminiSession(session: Session | null): void {
    this.geminiSession = session;
  }

  private dispatchBrowserJsonToGemini(raw: string): void {
    if (!this.geminiSession) {
      return;
    }
    applyGeminiLiveClientJson(this.geminiSession, raw, this.log, this.sessionId);
  }

  private geminiNotifyUpstreamOpened(openedAtWallMs: number, liveResumptionHandle: string | null): void {
    this.log.debug(
      {
        sessionId: this.sessionId,
        model: this.model,
        payload: {
          liveResumptionHandle,
          includeThoughts: true,
          bridgeOpenedAtWallMs: openedAtWallMs,
        },
      },
      "gemini live: onopen detail",
    );
    void initRealtimeAudioCapture(this.db, this.paths, this.sessionId, openedAtWallMs);
    this.log.info({ sessionId: this.sessionId, model: this.model }, "gemini live: bridge open");
    this.sendToBrowser({ type: "ready", model: this.model });
  }

  private handleGeminiLiveUpstreamClose(
    e: unknown,
    connectUpstream: () => Promise<void>,
    endBridge: (code: number, reason: string) => void,
    reconnectState: { inFlight: boolean },
  ): void {
    const ev = e as { code?: number; reason?: string };
    this.notifyUpstreamClosed({
      code: ev.code ?? null,
      reason: typeof ev.reason === "string" ? ev.reason : "",
    });
    this.log.debug(
      {
        sessionId: this.sessionId,
        model: this.model,
        payload: e,
        bridgeEnded: this.bridgeEnded,
        clientChannelOpen: this.isClientChannelOpen(),
        reconnectScheduled: reconnectState.inFlight,
      },
      "gemini live: onclose detail",
    );
    this.setGeminiSession(null);

    if (this.bridgeEnded || !this.isClientChannelOpen() || reconnectState.inFlight) {
      return;
    }
    reconnectState.inFlight = true;

    void (async () => {
      try {
        const delayMs = 450;
        this.sendToBrowser({
          type: "reconnecting",
          delayMs,
          upstreamCode: ev?.code ?? null,
          upstreamReason: ev?.reason ?? null,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        if (this.bridgeEnded || !this.isClientChannelOpen()) {
          return;
        }
        await connectUpstream();
      } catch (err) {
        this.log.error({ err, sessionId: this.sessionId }, "Gemini live reconnect failed");
        endBridge(1011, "Gemini reconnect failed");
      } finally {
        reconnectState.inFlight = false;
      }
    })();
  }

  private dispatchGeminiServerMessage(
    msg: LiveServerMessage,
    bridgeOpenedAtWallMs: number | null,
    setResumptionHandle: (handle: string) => void,
  ): void {
    const sr = msg.sessionResumptionUpdate;
    if (sr && sr.resumable !== false && typeof sr.newHandle === "string" && sr.newHandle.length > 0) {
      setResumptionHandle(sr.newHandle);
    }
    const payloads = geminiLiveMessageToClientPayload(msg);
    this.processModelOutputs(new LiveRealtimeModelOutputBatch(payloads, msg, bridgeOpenedAtWallMs));
  }
}
