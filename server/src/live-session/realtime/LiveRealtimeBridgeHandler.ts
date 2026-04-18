import type { IAppDao } from "../../dao/IAppDao.js";
import type { AppPaths } from "../../infrastructure/AppPaths.js";
import {
  appendRealtimeModelAudioChunk,
  appendRealtimeTranscription,
  appendRealtimeTranscriptionWallSpan,
} from "../interviewBridgeCapture.js";
import type {
  LiveRealtimeModelAudioPayload,
  LiveRealtimeModelOutputBatch,
  LiveRealtimeTranscriptionPayload,
} from "./LiveRealtimeModelOutputBatch.js";

export { LiveRealtimeModelOutputBatch } from "./LiveRealtimeModelOutputBatch.js";

/** Browser/extension client connection (typically `ws` from Fastify). */
export type LiveBrowserClient = import("ws").WebSocket;

/** Minimal logger surface for the live realtime bridge (Fastify / pino child logger compatible). */
export type LiveRealtimeBridgeLogger = {
  debug: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

/**
 * Owns the browser/extension client channel (`ws`): {@link connect} binds the client, runs
 * {@link establishUpstreamSession}, then wires `message` / `close` / `error` when that method returns true.
 * Logger is supplied at construction.
 *
 * Subclasses implement upstream setup and client payload routing only — no direct `ws` usage.
 */
export abstract class LiveRealtimeBridgeHandler {
  private clientChannelListenersAttached = false;
  private connectStarted = false;
  private clientChannel!: LiveBrowserClient;

  constructor(
    readonly sessionId: string,
    readonly db: IAppDao,
    readonly paths: AppPaths,
    readonly model: string,
    protected readonly log: LiveRealtimeBridgeLogger,
  ) {}

  /**
   * Binds the client channel, establishes the upstream session, then wires inbound client
   * events when {@link establishUpstreamSession} returns true.
   */
  async connect(client: LiveBrowserClient): Promise<void> {
    if (this.connectStarted) {
      this.log.warn({ sessionId: this.sessionId }, "live realtime: connect() ignored (already started)");
      return;
    }
    this.connectStarted = true;
    this.clientChannel = client;
    const acceptClientText = await this.establishUpstreamSession();
    if (acceptClientText) {
      this.attachClientChannelListeners();
    }
  }

  /**
   * Prepare the upstream provider (e.g. vendor live session). Return true to start forwarding decoded
   * UTF-8 text from the client channel to {@link onClientTextFromBrowser}.
   */
  protected abstract establishUpstreamSession(): Promise<boolean>;

  /** UTF-8 text frame from the client extension (already decoded). */
  protected abstract onClientTextFromBrowser(raw: string): void;

  /** Client channel closed or errored; release upstream resources. Should be idempotent. */
  protected abstract onClientChannelEnded(): void;

  /** Close the client channel if it is still open. */
  protected closeClientChannel(code: number, reason: string): void {
    if (this.clientChannel.readyState !== this.clientChannel.OPEN) {
      return;
    }
    try {
      this.clientChannel.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  /** Whether the client channel is open. */
  protected isClientChannelOpen(): boolean {
    return this.clientChannel.readyState === this.clientChannel.OPEN;
  }

  private attachClientChannelListeners(): void {
    if (this.clientChannelListenersAttached) {
      return;
    }
    this.clientChannelListenersAttached = true;

    this.clientChannel.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        if (isBinary) {
          this.log.warn(
            { sessionId: this.sessionId },
            "live realtime: binary client frames not supported; use JSON text",
          );
          return;
        }
        const raw = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        this.onClientTextFromBrowser(raw);
      } catch (err) {
        this.log.warn({ err, sessionId: this.sessionId }, "live realtime: failed to handle client message");
      }
    });

    this.clientChannel.on("close", () => {
      this.onClientChannelEnded();
    });

    this.clientChannel.on("error", (err: Error) => {
      this.log.warn({ err, sessionId: this.sessionId }, "live realtime: client channel error");
      this.onClientChannelEnded();
    });
  }

  protected sendToBrowser(payload: Record<string, unknown>): void {
    if (this.clientChannel.readyState !== this.clientChannel.OPEN) {
      return;
    }
    try {
      this.clientChannel.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  /** Log + send mapped upstream payloads to the extension (transcription stays server-side). */
  protected deliverModelOutputBatchToBrowser(batch: LiveRealtimeModelOutputBatch): void {
    this.log.debug({ sessionId: this.sessionId, payload: batch.rawMessageForLog }, "live realtime: onmessage");
    for (const p of batch.payloads) {
      if (p.type === "inputTranscription" || p.type === "outputTranscription") {
        continue;
      }
      this.sendToBrowser(p as unknown as Record<string, unknown>);
    }
  }

  private async writeRealtimeTranscriptionChunk(
    bridgeOpenedAtWallMs: number,
    role: "input" | "output",
    text: string,
    finished: boolean,
  ): Promise<void> {
    await appendRealtimeTranscription(
      this.paths,
      this.sessionId,
      bridgeOpenedAtWallMs,
      role,
      text,
      finished,
    );
  }

  private async writeRealtimeTranscriptionWallSpan(
    bridgeOpenedAtWallMs: number,
    role: "input" | "output",
    text: string,
    startWallMs: number,
    endWallMs: number,
  ): Promise<void> {
    await appendRealtimeTranscriptionWallSpan(
      this.paths,
      this.sessionId,
      bridgeOpenedAtWallMs,
      role,
      text,
      startWallMs,
      endWallMs,
    );
  }

  protected persistRealtimeTranscriptionSpan(
    bridgeOpenedAtWallMs: number,
    role: "input" | "output",
    text: string,
    startWallMs: number,
    endWallMs: number,
  ): Promise<void> {
    return this.writeRealtimeTranscriptionWallSpan(
      bridgeOpenedAtWallMs,
      role,
      text,
      startWallMs,
      endWallMs,
    );
  }

  /** Persist `modelAudio` chunks from a batch (post-session stitch / audit). */
  protected async persistModelAudioAuditFromBatch(batch: LiveRealtimeModelOutputBatch): Promise<void> {
    const bridgeOpenedAtWallMs = batch.bridgeOpenedAtWallMs;
    if (bridgeOpenedAtWallMs == null) {
      return;
    }
    const audioPayloads = batch.payloads.filter((p): p is LiveRealtimeModelAudioPayload => p.type === "modelAudio");
    if (audioPayloads.length === 0) {
      return;
    }
    await Promise.all(
      audioPayloads.map((p) =>
        p.data.length === 0
          ? Promise.resolve()
          : appendRealtimeModelAudioChunk(this.db, this.sessionId, bridgeOpenedAtWallMs, p.mimeType, p.data),
      ),
    );
  }

  /**
   * Persist realtime transcript for one upstream batch. Default: one jsonl row per transcription
   * payload (instant anchor per chunk). Subclasses buffer/aggregate first, then call
   * {@link persistRealtimeTranscriptionSpan} when a turn is complete.
   */
  protected async persistRealtimeTranscriptionForBatch(batch: LiveRealtimeModelOutputBatch): Promise<void> {
    const bridgeOpenedAtWallMs = batch.bridgeOpenedAtWallMs;
    if (bridgeOpenedAtWallMs == null) {
      return;
    }
    const rows = batch.payloads.filter(
      (p): p is LiveRealtimeTranscriptionPayload =>
        p.type === "inputTranscription" || p.type === "outputTranscription",
    );
    if (rows.length === 0) {
      return;
    }
    await Promise.all(
      rows.map((p) =>
        this.writeRealtimeTranscriptionChunk(
          bridgeOpenedAtWallMs,
          p.type === "inputTranscription" ? "input" : "output",
          p.text,
          p.finished,
        ),
      ),
    );
  }

  /**
   * One entry point per upstream batch: extension delivery (non-transcription), then when the bridge
   * clock exists — transcription persist + model audio audit (parallel).
   */
  protected processModelOutputs(batch: LiveRealtimeModelOutputBatch): void {
    void (async () => {
      this.deliverModelOutputBatchToBrowser(batch);
      const bridgeOpenedAtWallMs = batch.bridgeOpenedAtWallMs;
      if (bridgeOpenedAtWallMs == null) {
        return;
      }
      await Promise.all([
        this.persistRealtimeTranscriptionForBatch(batch),
        this.persistModelAudioAuditFromBatch(batch),
      ]);
    })().catch(() => {});
  }

  protected notifyUpstreamError(error: unknown): void {
    this.log.warn({ sessionId: this.sessionId, payload: error }, "live realtime: upstream error");
    this.sendToBrowser({
      type: "error",
      message: String((error as { error?: unknown }).error ?? error ?? "Upstream error"),
    });
  }

  protected notifyUpstreamClosed(event: { code: number | null; reason: string }): void {
    this.log.info(
      { sessionId: this.sessionId, model: this.model, code: event.code, reason: event.reason },
      "live realtime: upstream closed",
    );
  }
}
