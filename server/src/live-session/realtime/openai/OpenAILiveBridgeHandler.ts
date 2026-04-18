import WebSocket from "ws";
import type { IAppDao } from "../../../dao/IAppDao.js";
import type { AppPaths } from "../../../infrastructure/AppPaths.js";
import { buildGeminiLiveInterviewerSystemInstruction } from "../../../prompts/buildGeminiLiveInterviewerSystemInstruction.js";
import { initRealtimeAudioCapture } from "../../interviewBridgeCapture.js";
import { LiveRealtimeBridgeHandler, type LiveRealtimeBridgeLogger } from "../LiveRealtimeBridgeHandler.js";
import { applyOpenAILiveClientJson } from "./openaiLiveClientInbound.js";
import {
  LiveRealtimeModelOutputBatch,
  type LiveRealtimeTranscriptionPayload,
} from "../LiveRealtimeModelOutputBatch.js";
import {
  createOpenAIRealtimeMapperState,
  openaiRealtimeServerEventToClientPayloads,
  type OpenAIRealtimeMapperState,
} from "./openaiRealtimeMessageMapper.js";

function sendUpstreamJson(upstream: WebSocket, evt: Record<string, unknown>): void {
  if (upstream.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    upstream.send(JSON.stringify(evt));
  } catch {
    /* ignore */
  }
}

/**
 * OpenAI Realtime API bridge for `/api/live-sessions/:id/realtime` when
 * `LIVE_REALTIME_PROVIDER=openai`. Extension JSON is the same as Gemini; upstream is
 * `wss://api.openai.com/v1/realtime`. Client transport is owned by {@link LiveRealtimeBridgeHandler}.
 */
export class OpenAILiveBridgeHandler extends LiveRealtimeBridgeHandler {
  private upstream: WebSocket | null = null;
  private bridgeEnded = false;
  private mapperState: OpenAIRealtimeMapperState = createOpenAIRealtimeMapperState();
  /** First wall time for a non-empty OpenAI ASR delta (input or output); span written on `finished`. */
  private openaiTranscriptionFirstWallMsByKey = new Map<string, number>();
  /**
   * `input_audio_buffer.speech_started` / `speech_stopped` share `item_id` with input transcription;
   * wall times bound user speech better than ASR completion latency.
   */
  private inputAudioVadWallByItemId = new Map<string, { start: number; end?: number }>();
  private readonly warnOnce: { warnedInputRate16k?: boolean } = {};

  constructor(
    sessionId: string,
    db: IAppDao,
    paths: AppPaths,
    model: string,
    log: LiveRealtimeBridgeLogger,
    private readonly apiKey: string,
    private readonly voice: string = "alloy",
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
        this.upstream?.close();
      } catch {
        /* ignore */
      }
      this.setUpstream(null);
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

    const instructions = buildGeminiLiveInterviewerSystemInstruction(live.question);
    let bridgeOpenedAtWallMs: number | null = null;
    const reconnectState = { inFlight: false };

    const connectUpstream = async (): Promise<void> => {
      if (this.bridgeEnded || !this.isClientChannelOpen()) {
        return;
      }
      this.mapperState = createOpenAIRealtimeMapperState();
      this.openaiTranscriptionFirstWallMsByKey.clear();
      this.inputAudioVadWallByItemId.clear();

      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
        });
      } catch (err) {
        this.log.error({ err, sessionId: this.sessionId }, "OpenAI Realtime WebSocket construct failed");
        endBridge(1011, "OpenAI connect failed");
        return;
      }

      this.setUpstream(ws);

      ws.on("message", (data) => {
        if (this.bridgeEnded || this.upstream !== ws) {
          return;
        }
        const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(text) as Record<string, unknown>;
        } catch {
          this.log.warn({ sessionId: this.sessionId, raw: text.slice(0, 200) }, "openai realtime: invalid JSON from upstream");
          return;
        }

        const t = ev.type;
        if (t === "error") {
          this.notifyUpstreamError(ev.error ?? ev);
          return;
        }

        if (t === "session.created") {
          sendUpstreamJson(ws, this.buildSessionUpdateEvent(instructions));
        }

        if (t === "session.updated" && bridgeOpenedAtWallMs == null) {
          bridgeOpenedAtWallMs = Date.now();
          this.notifyUpstreamOpened(bridgeOpenedAtWallMs);
        }

        if (t === "input_audio_buffer.speech_started" && typeof ev.item_id === "string") {
          this.inputAudioVadWallByItemId.set(ev.item_id, { start: Date.now() });
        }
        if (t === "input_audio_buffer.speech_stopped" && typeof ev.item_id === "string") {
          const itemId = ev.item_id;
          const tick = Date.now();
          const prev = this.inputAudioVadWallByItemId.get(itemId);
          if (prev) {
            this.inputAudioVadWallByItemId.set(itemId, { start: prev.start, end: tick });
          } else {
            this.inputAudioVadWallByItemId.set(itemId, { start: tick, end: tick });
          }
        }

        const payloads = openaiRealtimeServerEventToClientPayloads(ev, this.mapperState);
        if (payloads.length > 0) {
          this.processModelOutputs(new LiveRealtimeModelOutputBatch(payloads, ev, bridgeOpenedAtWallMs));
        }
      });

      ws.on("error", (err: Error) => {
        if (this.upstream !== ws) {
          return;
        }
        this.log.warn({ err, sessionId: this.sessionId }, "openai realtime: upstream socket error");
        this.notifyUpstreamError(err);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        if (this.upstream !== ws) {
          return;
        }
        this.handleOpenAIUpstreamClose(
          { code, reason: reason.toString() },
          connectUpstream,
          endBridge,
          reconnectState,
        );
      });
    };

    await connectUpstream();
    if (this.bridgeEnded) {
      return false;
    }
    return true;
  }

  private static itemIdFromOpenAiTranscriptionKey(key: string): string | null {
    if (key === "__input__" || key === "__output__") {
      return null;
    }
    const z = key.indexOf("\0");
    return z >= 0 ? key.slice(0, z) : key;
  }

  private buildSessionUpdateEvent(instructions: string): Record<string, unknown> {
    const voice = (this.voice ?? "alloy").trim() || "alloy";
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en",
        },
        turn_detection: {
          type: "server_vad",
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          interrupt_response: true,
          create_response: true,
        },
        temperature: 0.8,
      },
    };
  }

  protected override async persistRealtimeTranscriptionForBatch(
    batch: LiveRealtimeModelOutputBatch,
  ): Promise<void> {
    const bridgeOpenedAtWallMs = batch.bridgeOpenedAtWallMs;
    if (bridgeOpenedAtWallMs == null) {
      return;
    }
    const rows = batch.payloads.filter(
      (p): p is LiveRealtimeTranscriptionPayload =>
        p.type === "inputTranscription" || p.type === "outputTranscription",
    );
    for (const p of rows) {
      const role = p.type === "inputTranscription" ? "input" : "output";
      const key = p.itemKey ?? (role === "input" ? "__input__" : "__output__");
      if (!p.finished) {
        const tick = Date.now();
        if (!p.text.trim()) {
          continue;
        }
        if (!this.openaiTranscriptionFirstWallMsByKey.has(key)) {
          this.openaiTranscriptionFirstWallMsByKey.set(key, tick);
        }
        continue;
      }
      if (!p.text.trim()) {
        this.openaiTranscriptionFirstWallMsByKey.delete(key);
        continue;
      }
      const deltaFirstWall = this.openaiTranscriptionFirstWallMsByKey.get(key) ?? null;
      this.openaiTranscriptionFirstWallMsByKey.delete(key);

      const itemId = role === "input" ? OpenAILiveBridgeHandler.itemIdFromOpenAiTranscriptionKey(key) : null;
      const vad = itemId ? this.inputAudioVadWallByItemId.get(itemId) : undefined;

      let startWall: number;
      let endWall: number;
      if (role === "input" && vad?.start != null) {
        const vadEnd = vad.end != null && vad.end > vad.start ? vad.end : Date.now();
        startWall = deltaFirstWall != null ? Math.min(vad.start, deltaFirstWall) : vad.start;
        endWall = Math.max(vadEnd, startWall + 1);
        if (itemId) {
          this.inputAudioVadWallByItemId.delete(itemId);
        }
      } else {
        endWall = Date.now();
        if (deltaFirstWall != null) {
          startWall = deltaFirstWall;
        } else {
          const sec =
            role === "input" && typeof p.sourceAudioDurationSec === "number" && p.sourceAudioDurationSec > 0
              ? p.sourceAudioDurationSec
              : 0;
          if (sec > 0) {
            startWall = Math.round(endWall - sec * 1000);
          } else {
            startWall = endWall;
          }
        }
        if (itemId) {
          this.inputAudioVadWallByItemId.delete(itemId);
        }
      }
      startWall = Math.max(bridgeOpenedAtWallMs, Math.min(startWall, endWall));
      await this.persistRealtimeTranscriptionSpan(bridgeOpenedAtWallMs, role, p.text, startWall, endWall);
    }
  }

  private notifyUpstreamOpened(openedAtWallMs: number): void {
    void initRealtimeAudioCapture(this.db, this.paths, this.sessionId, openedAtWallMs);
    this.log.info({ sessionId: this.sessionId, model: this.model }, "openai realtime: bridge open");
    this.sendToBrowser({ type: "ready", model: this.model });
  }

  private setUpstream(ws: WebSocket | null): void {
    this.upstream = ws;
  }

  protected onClientTextFromBrowser(raw: string): void {
    if (!this.upstream || this.bridgeEnded) {
      return;
    }
    applyOpenAILiveClientJson(this.upstream, raw, this.log, this.sessionId, this.warnOnce);
  }

  protected onClientChannelEnded(): void {
    if (this.bridgeEnded) {
      return;
    }
    this.bridgeEnded = true;
    try {
      this.upstream?.close();
    } catch {
      /* ignore */
    }
    this.setUpstream(null);
  }

  private handleOpenAIUpstreamClose(
    e: { code: number; reason: string },
    connectUpstream: () => Promise<void>,
    endBridge: (code: number, reason: string) => void,
    reconnectState: { inFlight: boolean },
  ): void {
    this.notifyUpstreamClosed({
      code: e.code,
      reason: e.reason,
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
      "openai realtime: upstream close detail",
    );
    this.setUpstream(null);

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
          upstreamCode: e.code,
          upstreamReason: e.reason,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        if (this.bridgeEnded || !this.isClientChannelOpen()) {
          return;
        }
        await connectUpstream();
      } catch (err) {
        this.log.error({ err, sessionId: this.sessionId }, "OpenAI Realtime reconnect failed");
        endBridge(1011, "OpenAI reconnect failed");
      } finally {
        reconnectState.inFlight = false;
      }
    })();
  }
}
