import type { IAppDao } from "../../dao/IAppDao.js";
import type { AppPaths } from "../../infrastructure/AppPaths.js";
import { appendRealtimeModelAudioChunk, appendRealtimeTranscription } from "../interviewBridgeCapture.js";
import type {
  LiveRealtimeModelAudioPayload,
  LiveRealtimeModelOutputPayload,
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

  private emitToBrowser(payload: Record<string, unknown>): void {
    if (this.clientChannel.readyState !== this.clientChannel.OPEN) {
      return;
    }
    try {
      this.clientChannel.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  protected sendToBrowser(payload: Record<string, unknown>): void {
    this.emitToBrowser(payload);
  }

  private forwardPayloadsToBrowser(payloads: ReadonlyArray<LiveRealtimeModelOutputPayload>): void {
    for (const p of payloads) {
      this.emitToBrowser(p);
    }
  }

  protected processModelOutputs(batch: LiveRealtimeModelOutputBatch): void {
    this.log.debug({ sessionId: this.sessionId, payload: batch.rawMessageForLog }, "live realtime: onmessage");
    this.forwardPayloadsToBrowser(batch.payloads);
    if (batch.bridgeOpenedAtWallMs != null) {
      void Promise.resolve(this.persistModelOutputs(batch)).catch(() => {});
    }
  }

  private async persistModelOutputs(batch: LiveRealtimeModelOutputBatch): Promise<void> {
    await Promise.all(
      batch.payloads.map((p) =>
        p.type === "inputTranscription" || p.type === "outputTranscription"
          ? this.persistTranscriptionPayload(p, batch.bridgeOpenedAtWallMs)
          : p.type === "modelAudio"
            ? this.persistModelAudioPayload(p, batch.bridgeOpenedAtWallMs)
            : Promise.resolve(),
      ),
    );
  }

  private persistTranscriptionPayload(p: LiveRealtimeTranscriptionPayload, bridgeOpenedAtWallMs: number | null): Promise<void> {
    if (bridgeOpenedAtWallMs == null) {
      return Promise.resolve();
    }
    return appendRealtimeTranscription(
      this.paths,
      this.sessionId,
      bridgeOpenedAtWallMs,
      p.type === "inputTranscription" ? "input" : "output",
      p.text,
      p.finished,
    );
  }

  private persistModelAudioPayload(p: LiveRealtimeModelAudioPayload, bridgeOpenedAtWallMs: number | null): Promise<void> {
    if (bridgeOpenedAtWallMs == null || p.data.length === 0) {
      return Promise.resolve();
    }
    return appendRealtimeModelAudioChunk(this.db, this.sessionId, bridgeOpenedAtWallMs, p.mimeType, p.data);
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
