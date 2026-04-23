import {
  EndSensitivity,
  GoogleGenAI,
  type LiveConnectConfig,
  type LiveServerMessage,
  Modality,
  type Session,
  type SessionResumptionConfig,
  StartSensitivity,
  TurnCoverage,
} from "@google/genai";
import type { IAppDao } from "../../../dao/IAppDao.js";
import type { AppPaths } from "../../../infrastructure/AppPaths.js";
import { initRealtimeAudioCapture } from "../../interviewBridgeCapture.js";
import { LiveRealtimeBridgeHandler, type LiveRealtimeBridgeLogger } from "../LiveRealtimeBridgeHandler.js";
import { applyGeminiLiveClientJson } from "./geminiLiveClientInbound.js";
import { LiveRealtimeModelOutputBatch, type LiveRealtimeModelOutputPayload } from "../LiveRealtimeModelOutputBatch.js";
import { geminiLiveMessageToClientPayload } from "./geminiLiveMessageMapper.js";
import { buildGeminiLiveInterviewerSystemInstruction } from "../../../prompts/buildGeminiLiveInterviewerSystemInstruction.js";

export { formatCandidateEditorSnapshotForGeminiLive } from "../geminiLiveEditorFormat.js";
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
  /** First upstream `onopen` wall time (persists transcript anchor). */
  private geminiBridgeOpenedAtWallMs: number | null = null;
  /** Buffered candidate speech (input transcription); flushed when model output transcription arrives. */
  private inputTranscriptLatest = "";
  private inputTranscriptWallStart: number | null = null;
  private inputTranscriptWallLast: number | null = null;
  /** Buffered interviewer speech (output transcription); flushed on `turnComplete`. */
  private outputTranscriptLatest = "";
  private outputTranscriptWallStart: number | null = null;
  /** When `turnComplete` arrived before any output text in that turn, flush uses this end time. */
  private pendingOutputTurnCompleteWallMs: number | null = null;

  constructor(
    sessionId: string,
    db: IAppDao,
    paths: AppPaths,
    model: string,
    log: LiveRealtimeBridgeLogger,
    private readonly apiKey: string,
    private readonly geminiLiveVoice?: string,
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

    const live = await this.db.getLiveSessionForRealtimeBridge(this.sessionId);
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
        const voiceName = this.geminiLiveVoice?.trim();
        const liveConfig: LiveConnectConfig = {
          // Native-audio Live models reject `AUDIO`+`TEXT` together ("invalid argument"); transcriptions still stream via `*Transcription` fields.
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          /** Enables `serverContent.inputTranscription` / `outputTranscription` → `realtime-transcriptions.jsonl` + post-process. */
          inputAudioTranscription: {},
          outputAudioTranscription: {},
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
        };
        if (voiceName) {
          liveConfig.speechConfig = {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          };
        }
        const session = await ai.live.connect({
          model: this.model,
          config: liveConfig,
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

  protected override onClientTextFromBrowser(raw: string): void {
    if (!this.geminiSession || this.bridgeEnded) {
      return;
    }
    this.dispatchBrowserJsonToGemini(raw);
  }

  protected onClientChannelEnded(): void {
    const bridgeMs = this.geminiBridgeOpenedAtWallMs;
    if (bridgeMs != null) {
      const wall = Date.now();
      void this.flushGeminiTranscriptionBuffersAtEnd(bridgeMs, wall).catch(() => {});
    }
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

  protected override async persistRealtimeTranscriptionForBatch(
    batch: LiveRealtimeModelOutputBatch,
  ): Promise<void> {
    const bridgeOpenedAtWallMs = batch.bridgeOpenedAtWallMs;
    if (bridgeOpenedAtWallMs == null) {
      return;
    }
    await this.consumeGeminiTranscriptionPayloads(bridgeOpenedAtWallMs, batch.payloads);
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
    this.geminiBridgeOpenedAtWallMs = openedAtWallMs;
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

  private mergeTranscriptionDelta(prev: string, token: string): string {
    const t = token;
    if (!t) {
      return prev;
    }
    if (!prev) {
      return t;
    }
    if (t.startsWith(prev)) {
      return t;
    }
    return `${prev}${t}`;
  }

  private ingestInputTranscription(text: string, wallMs: number): void {
    const merged = this.mergeTranscriptionDelta(this.inputTranscriptLatest, text);
    if (!merged.trim()) {
      return;
    }
    if (!this.inputTranscriptLatest.trim()) {
      this.inputTranscriptWallStart = wallMs;
    }
    this.inputTranscriptLatest = merged;
    this.inputTranscriptWallLast = wallMs;
  }

  private ingestOutputTranscription(text: string, wallMs: number): void {
    const merged = this.mergeTranscriptionDelta(this.outputTranscriptLatest, text);
    if (!merged.trim()) {
      return;
    }
    if (!this.outputTranscriptLatest.trim()) {
      this.outputTranscriptWallStart = wallMs;
    }
    this.outputTranscriptLatest = merged;
  }

  private async flushInputTranscriptionBuffer(bridgeOpenedAtWallMs: number): Promise<void> {
    const text = this.inputTranscriptLatest.trim();
    if (!text || this.inputTranscriptWallStart == null || this.inputTranscriptWallLast == null) {
      return;
    }
    await this.persistRealtimeTranscriptionSpan(
      bridgeOpenedAtWallMs,
      "input",
      text,
      this.inputTranscriptWallStart,
      this.inputTranscriptWallLast,
    );
    this.inputTranscriptLatest = "";
    this.inputTranscriptWallStart = null;
    this.inputTranscriptWallLast = null;
  }

  private async flushOutputTranscriptionBuffer(bridgeOpenedAtWallMs: number, endWallMs: number): Promise<void> {
    const text = this.outputTranscriptLatest.trim();
    if (!text || this.outputTranscriptWallStart == null) {
      return;
    }
    const end = Math.max(endWallMs, this.outputTranscriptWallStart + 1);
    await this.persistRealtimeTranscriptionSpan(
      bridgeOpenedAtWallMs,
      "output",
      text,
      this.outputTranscriptWallStart,
      end,
    );
    this.outputTranscriptLatest = "";
    this.outputTranscriptWallStart = null;
    this.pendingOutputTurnCompleteWallMs = null;
  }

  private async consumeGeminiTranscriptionPayloads(
    bridgeOpenedAtWallMs: number,
    payloads: ReadonlyArray<LiveRealtimeModelOutputPayload>,
  ): Promise<void> {
    const t0 = Date.now();
    let idx = 0;
    for (const p of payloads) {
      const wallMs = t0 + idx;
      idx += 1;

      if (p.type === "interrupted") {
        await this.flushInputTranscriptionBuffer(bridgeOpenedAtWallMs);
        await this.flushOutputTranscriptionBuffer(bridgeOpenedAtWallMs, wallMs);
        continue;
      }

      if (p.type === "turnComplete") {
        if (this.outputTranscriptLatest.trim() && this.outputTranscriptWallStart != null) {
          await this.flushOutputTranscriptionBuffer(bridgeOpenedAtWallMs, wallMs);
        } else {
          this.pendingOutputTurnCompleteWallMs = wallMs;
        }
        continue;
      }

      if (p.type === "inputTranscription") {
        this.ingestInputTranscription(p.text, wallMs);
        continue;
      }

      if (p.type === "outputTranscription") {
        await this.flushInputTranscriptionBuffer(bridgeOpenedAtWallMs);
        this.ingestOutputTranscription(p.text, wallMs);
        if (
          this.pendingOutputTurnCompleteWallMs != null &&
          this.outputTranscriptLatest.trim() &&
          this.outputTranscriptWallStart != null
        ) {
          await this.flushOutputTranscriptionBuffer(bridgeOpenedAtWallMs, this.pendingOutputTurnCompleteWallMs);
        }
        continue;
      }
    }

    if (
      this.pendingOutputTurnCompleteWallMs != null &&
      this.outputTranscriptLatest.trim() &&
      this.outputTranscriptWallStart != null
    ) {
      await this.flushOutputTranscriptionBuffer(bridgeOpenedAtWallMs, this.pendingOutputTurnCompleteWallMs);
    }
  }

  private async flushGeminiTranscriptionBuffersAtEnd(bridgeOpenedAtWallMs: number, endWallMs: number): Promise<void> {
    await this.flushInputTranscriptionBuffer(bridgeOpenedAtWallMs);
    await this.flushOutputTranscriptionBuffer(bridgeOpenedAtWallMs, endWallMs);
  }
}
