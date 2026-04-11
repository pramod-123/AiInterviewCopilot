/**
 * WebSocket client for `/api/live-sessions/:id/realtime` — streams mic PCM (16 kHz) to the server
 * and plays model PCM audio. Editor updates use `{ type: "editorCode" }`.
 * Exposes {@link VoiceInterviewerRealtimeBridge.start}.
 * @see server — WebSocket route `/api/live-sessions/:id/realtime`
 */
(function initVoiceInterviewerRealtimeBridge(global) {
  const TARGET_PCM_RATE = 16000;
  const PING_MS = 25000;

  /**
   * @param {string} apiBase e.g. http://127.0.0.1:3001
   * @returns {string}
   */
  function httpToWsBase(apiBase) {
    const t = apiBase.trim().replace(/\/$/, "");
    if (t.startsWith("https://")) {
      return `wss://${t.slice(8)}`;
    }
    if (t.startsWith("http://")) {
      return `ws://${t.slice(7)}`;
    }
    return t;
  }

  /**
   * @param {Float32Array} input
   * @param {number} fromRate
   * @param {number} toRate
   * @returns {Float32Array}
   */
  function resampleFloat32(input, fromRate, toRate) {
    if (fromRate === toRate || input.length === 0) {
      return new Float32Array(input);
    }
    const outLen = Math.max(1, Math.floor((input.length * toRate) / fromRate));
    const out = new Float32Array(outLen);
    const ratio = fromRate / toRate;
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const x0 = Math.floor(x);
      const x1 = Math.min(x0 + 1, input.length - 1);
      const f = x - x0;
      out[i] = input[x0] * (1 - f) + input[x1] * f;
    }
    return out;
  }

  /**
   * @param {Float32Array} float32
   * @returns {Int16Array}
   */
  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  /**
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  function arrayBufferToBase64(buffer) {
    const u8 = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Decode model `audio/pcm` base64 (s16le) from Gemini Live.
   * @param {string} base64
   * @param {string} mimeType
   * @returns {{ float32: Float32Array; sampleRate: number } | null}
   */
  function decodeModelPcmBase64(base64, mimeType) {
    const rateMatch = /rate=(\d+)/i.exec(mimeType || "");
    const sampleRate = rateMatch ? Number.parseInt(rateMatch[1], 10) : 24000;
    let binary;
    try {
      binary = atob(base64);
    } catch {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (bytes.length < 2 || bytes.length % 2 !== 0) {
      return null;
    }
    const samples = bytes.length / 2;
    const float32 = new Float32Array(samples);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples; i++) {
      float32[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    return { float32, sampleRate };
  }

  /**
   * @typedef {{ stop: () => void; sendEditorSnapshot: (code: string) => void }} VoiceInterviewerRealtimeHandle
   * @typedef {(line: string) => void} LogFn
   * @typedef {(state: string, detail?: string) => void} StatusFn
   */

  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.apiBase
   * @param {MediaStream} options.mediaStream stream that includes the mic audio track(s)
   * @param {LogFn} options.log
   * @param {StatusFn} [options.onStatus]
   * @returns {VoiceInterviewerRealtimeHandle}
   */
  function start(options) {
    const { sessionId, apiBase, mediaStream, log } = options;
    const onStatus = options.onStatus || (() => {});

    const wsUrl = `${httpToWsBase(apiBase)}/api/live-sessions/${encodeURIComponent(sessionId)}/realtime`;
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("Voice interviewer needs a stream with an audio track");
    }

    let closed = false;
    /** @type {WebSocket | null} */
    let ws = null;
    /** One context for mic + model playback — shared {@link AudioContext} clock reduces capture vs playout drift. */
    /** @type {AudioContext | null} */
    let audioCtx = null;
    /** @type {ScriptProcessorNode | null} */
    let processor = null;
    /** @type {MediaStreamAudioSourceNode | null} */
    let mediaSource = null;
    /** @type {GainNode | null} */
    let silentSink = null;
    /** @type {ScriptProcessorNode | null} */
    let playbackProcessor = null;
    /** @type {GainNode | null} */
    let playbackGain = null;
    /**
     * Pull-based playback queue (Gemini sends tiny chunks; chaining BufferSources still clicks at seams).
     * ScriptProcessor drains this continuously for gapless output.
     */
    /** @type {Float32Array[]} */
    const playbackPcmChunks = [];
    let playbackPcmReadOffset = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    let pingId = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let speakingResetId = null;
    /** Dedupe sends; cleared on upstream reconnect so the model can see the buffer again. */
    let lastEditorPayloadSent = null;
    /** After `turnComplete` / `generationComplete`, clear "speaking" once the pull queue has drained. */
    let modelTurnAudioEnded = false;

    /**
     * @param {Float32Array} dst
     */
    function pullFromPlaybackQueue(dst) {
      const n = dst.length;
      let w = 0;
      while (w < n && playbackPcmChunks.length > 0) {
        const head = playbackPcmChunks[0];
        const avail = head.length - playbackPcmReadOffset;
        const take = Math.min(avail, n - w);
        dst.set(head.subarray(playbackPcmReadOffset, playbackPcmReadOffset + take), w);
        w += take;
        playbackPcmReadOffset += take;
        if (playbackPcmReadOffset >= head.length) {
          playbackPcmChunks.shift();
          playbackPcmReadOffset = 0;
        }
      }
      if (w < n) {
        dst.fill(0, w);
      }
    }

    function setSpeakingUi(active) {
      if (speakingResetId) {
        clearTimeout(speakingResetId);
        speakingResetId = null;
      }
      if (active) {
        onStatus("speaking");
      } else {
        speakingResetId = setTimeout(() => {
          if (!closed) {
            onStatus("ready");
          }
          speakingResetId = null;
        }, 400);
      }
    }

    function cleanupAudioGraph() {
      try {
        processor?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        mediaSource?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        silentSink?.disconnect();
      } catch {
        /* ignore */
      }
      processor = null;
      mediaSource = null;
      silentSink = null;
    }

    /**
     * Gemini Live: on interruption, stop playback immediately and drop queued chunks
     * @see https://ai.google.dev/gemini-api/docs/live-api/capabilities (Voice Activity Detection)
     */
    function clearPlaybackPcmQueue() {
      playbackPcmChunks.length = 0;
      playbackPcmReadOffset = 0;
    }

    /**
     * @param {Float32Array} float32 PCM at {@link audioCtx}.sampleRate
     */
    function enqueuePlaybackPcm(float32) {
      if (!float32 || float32.length === 0) {
        return;
      }
      playbackPcmChunks.push(float32);
    }

    /**
     * @param {string} base64
     * @param {string} mimeType
     */
    function appendModelPcmChunk(base64, mimeType) {
      if (!audioCtx) {
        return;
      }
      const decoded = decodeModelPcmBase64(base64, mimeType);
      if (!decoded) {
        return;
      }
      modelTurnAudioEnded = false;
      let { float32 } = decoded;
      const { sampleRate } = decoded;
      const outRate = audioCtx.sampleRate;
      if (sampleRate !== outRate) {
        float32 = resampleFloat32(float32, sampleRate, outRate);
      }
      enqueuePlaybackPcm(float32);
    }

    function stopModelPlaybackImmediate() {
      modelTurnAudioEnded = false;
      clearPlaybackPcmQueue();
      setSpeakingUi(false);
    }

    function cleanupPlayback() {
      clearPlaybackPcmQueue();
      try {
        playbackProcessor?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        playbackGain?.disconnect();
      } catch {
        /* ignore */
      }
      playbackProcessor = null;
      playbackGain = null;
      if (audioCtx) {
        void audioCtx.close().catch(() => {});
        audioCtx = null;
      }
    }

    function teardown() {
      if (pingId != null) {
        clearInterval(pingId);
        pingId = null;
      }
      if (speakingResetId) {
        clearTimeout(speakingResetId);
        speakingResetId = null;
      }
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "audioStreamEnd" }));
          }
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "client stop");
          }
        } catch {
          /* ignore */
        }
      }
      ws = null;
      cleanupAudioGraph();
      cleanupPlayback(); /* closes shared audioCtx */
    }

    /** User ended capture — always show idle in the panel. */
    function finalizeUserStop() {
      if (closed) {
        return;
      }
      closed = true;
      onStatus("off");
      teardown();
    }

    /** Socket closed (network, server, or normal). Preserve error for failed handshakes. */
    function finalizeSocketClose(ev) {
      if (closed) {
        return;
      }
      closed = true;
      log(`Voice interviewer: closed (${ev.code} ${ev.reason || ""})`.trim());
      const ok = ev.code === 1000;
      if (ok) {
        onStatus("off");
      } else {
        const r = String(ev.reason || "").trim() || `Disconnected (${ev.code})`;
        onStatus("error", r);
      }
      teardown();
    }

    onStatus("connecting");
    log(`Voice interviewer: connecting ${wsUrl}`);

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Voice interviewer: WebSocket failed (${msg})`);
      onStatus("error", msg);
      return { stop: () => {}, sendEditorSnapshot: () => {} };
    }

    /**
     * Push full editor buffer to the server (wrapped as a realtime text turn). Skips if unchanged since last send.
     * @param {string} code
     */
    function sendEditorSnapshot(code) {
      if (typeof code !== "string") {
        return;
      }
      if (code === lastEditorPayloadSent) {
        return;
      }
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "editorCode", code }));
        lastEditorPayloadSent = code;
      } catch {
        /* ignore */
      }
    }

    ws.onopen = async () => {
      if (closed) {
        return;
      }
      try {
        audioCtx = new AudioContext({ latencyHint: "interactive" });
        await audioCtx.resume();
        const micOnly = new MediaStream(audioTracks.map((t) => t));
        mediaSource = audioCtx.createMediaStreamSource(micOnly);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        silentSink = audioCtx.createGain();
        silentSink.gain.value = 0;
        mediaSource.connect(processor);
        processor.connect(silentSink);
        silentSink.connect(audioCtx.destination);

        processor.onaudioprocess = (ev) => {
          if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          const input = ev.inputBuffer.getChannelData(0);
          const rate = audioCtx.sampleRate;
          const resampled = resampleFloat32(input, rate, TARGET_PCM_RATE);
          const pcm = floatTo16BitPCM(resampled);
          const b64 = arrayBufferToBase64(pcm.buffer);
          try {
            ws.send(
              JSON.stringify({
                type: "audio",
                data: b64,
                mimeType: "audio/pcm;rate=16000",
              }),
            );
          } catch {
            /* ignore */
          }
        };

        playbackProcessor = audioCtx.createScriptProcessor(2048, 0, 1);
        playbackGain = audioCtx.createGain();
        playbackGain.gain.value = 1;
        playbackProcessor.onaudioprocess = (ev) => {
          if (closed) {
            return;
          }
          const out = ev.outputBuffer.getChannelData(0);
          pullFromPlaybackQueue(out);
          if (modelTurnAudioEnded && playbackPcmChunks.length === 0) {
            modelTurnAudioEnded = false;
            setSpeakingUi(false);
          }
        };
        playbackProcessor.connect(playbackGain);
        playbackGain.connect(audioCtx.destination);

        pingId = setInterval(() => {
          if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* ignore */
          }
        }, PING_MS);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`Voice interviewer: audio setup failed (${msg})`);
        onStatus("error", msg);
        finalizeUserStop();
      }
    };

    ws.onmessage = (evt) => {
      if (closed) {
        return;
      }
      let payloads;
      try {
        payloads = JSON.parse(String(evt.data));
      } catch {
        return;
      }
      const list = Array.isArray(payloads) ? payloads : [payloads];
      for (const p of list) {
        if (!p || typeof p !== "object") {
          continue;
        }
        const t = p.type;
        if (t === "ready") {
          log(`Voice interviewer: ready (model ${p.model || "?"})`);
          onStatus("ready");
        } else if (t === "reconnecting") {
          stopModelPlaybackImmediate();
          lastEditorPayloadSent = null;
          const ms = typeof p.delayMs === "number" ? p.delayMs : 0;
          const uc = p.upstreamCode != null ? String(p.upstreamCode) : "";
          const ur = typeof p.upstreamReason === "string" && p.upstreamReason.trim() ? ` (${p.upstreamReason.trim()})` : "";
          log(
            `Voice interviewer: Google Live session ended${uc ? ` [${uc}]` : ""}${ur} — reconnecting in ~${ms}ms`,
          );
          onStatus("connecting");
        } else if (t === "interrupted" && p.value === true) {
          stopModelPlaybackImmediate();
        } else if (t === "modelAudio" && typeof p.data === "string" && audioCtx) {
          setSpeakingUi(true);
          appendModelPcmChunk(p.data, typeof p.mimeType === "string" ? p.mimeType : "");
        } else if (t === "modelText" && typeof p.text === "string" && p.text.trim()) {
          log(`Interviewer: ${p.text.trim().slice(0, 200)}${p.text.length > 200 ? "…" : ""}`);
        } else if (t === "inputTranscription" && typeof p.text === "string" && p.text.trim()) {
          log(`You (transcript): ${p.text.trim().slice(0, 200)}${p.text.length > 200 ? "…" : ""}`);
        } else if (t === "error" && p.message) {
          log(`Voice interviewer error: ${p.message}`);
          onStatus("error", String(p.message));
        } else if (t === "turnComplete" || t === "generationComplete") {
          modelTurnAudioEnded = true;
          if (playbackPcmChunks.length === 0) {
            modelTurnAudioEnded = false;
            setSpeakingUi(false);
          }
        }
      }
    };

    ws.onerror = () => {
      if (!closed) {
        log("Voice interviewer: WebSocket error");
        onStatus("error", "WebSocket error");
      }
    };

    ws.onclose = (ev) => {
      finalizeSocketClose(ev);
    };

    return { stop: finalizeUserStop, sendEditorSnapshot };
  }

  global.VoiceInterviewerRealtimeBridge = { start };
})(typeof globalThis !== "undefined" ? globalThis : window);
