/**
 * WebSocket client for `/api/live-sessions/:id/realtime` — streams mic PCM (16 kHz) to the server
 * and plays model PCM audio. Exposes {@link GeminiLiveBridge.start}.
 * @see server/src/http/GeminiLiveWebSocketPlugin.ts
 */
(function initGeminiLiveBridge(global) {
  const TARGET_PCM_RATE = 16000;
  const VIDEO_INTERVAL_MS = 1000;
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
   * @param {string} base64
   * @param {string} mimeType
   * @param {AudioContext} ctx
   * @param {{ nextTime: number }} sched
   */
  function schedulePcmPlayback(base64, mimeType, ctx, sched) {
    const rateMatch = /rate=(\d+)/i.exec(mimeType || "");
    const sampleRate = rateMatch ? Number.parseInt(rateMatch[1], 10) : 24000;
    let binary;
    try {
      binary = atob(base64);
    } catch {
      return;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (bytes.length < 2 || bytes.length % 2 !== 0) {
      return;
    }
    const samples = bytes.length / 2;
    const float32 = new Float32Array(samples);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples; i++) {
      float32[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    const buf = ctx.createBuffer(1, samples, sampleRate);
    buf.copyToChannel(float32, 0, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const startAt = Math.max(sched.nextTime, now + 0.02);
    src.start(startAt);
    sched.nextTime = startAt + buf.duration;
  }

  /**
   * @typedef {{ stop: () => void }} GeminiLiveHandle
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
   * @param {boolean} [options.sendVideoHints] attach ~1 FPS JPEG from tab video track
   * @returns {GeminiLiveHandle}
   */
  function start(options) {
    const { sessionId, apiBase, mediaStream, log } = options;
    const onStatus = options.onStatus || (() => {});
    const sendVideoHints = options.sendVideoHints !== false;

    const wsUrl = `${httpToWsBase(apiBase)}/api/live-sessions/${encodeURIComponent(sessionId)}/realtime`;
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("Voice interviewer needs a stream with an audio track");
    }

    let closed = false;
    /** @type {WebSocket | null} */
    let ws = null;
    /** @type {AudioContext | null} */
    let captureCtx = null;
    /** @type {ScriptProcessorNode | null} */
    let processor = null;
    /** @type {MediaStreamAudioSourceNode | null} */
    let mediaSource = null;
    /** @type {GainNode | null} */
    let silentSink = null;
    /** @type {AudioContext | null} */
    let playbackCtx = null;
    const playSched = { nextTime: 0 };
    /** @type {ReturnType<typeof setInterval> | null} */
    let pingId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let videoId = null;
    /** @type {HTMLVideoElement | null} */
    let tapVideo = null;
    /** @type {HTMLCanvasElement | null} */
    let tapCanvas = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let speakingResetId = null;

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
      if (captureCtx) {
        void captureCtx.close().catch(() => {});
        captureCtx = null;
      }
    }

    function cleanupPlayback() {
      if (playbackCtx) {
        void playbackCtx.close().catch(() => {});
        playbackCtx = null;
      }
      playSched.nextTime = 0;
    }

    function stopVideoTap() {
      if (videoId != null) {
        clearInterval(videoId);
        videoId = null;
      }
      if (tapVideo) {
        tapVideo.srcObject = null;
        tapVideo.remove();
        tapVideo = null;
      }
      if (tapCanvas) {
        tapCanvas.remove();
        tapCanvas = null;
      }
    }

    function teardown() {
      if (pingId != null) {
        clearInterval(pingId);
        pingId = null;
      }
      stopVideoTap();
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
      cleanupPlayback();
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
      return { stop: () => {} };
    }

    ws.onopen = async () => {
      if (closed) {
        return;
      }
      try {
        captureCtx = new AudioContext();
        await captureCtx.resume();
        const micOnly = new MediaStream(audioTracks.map((t) => t));
        mediaSource = captureCtx.createMediaStreamSource(micOnly);
        processor = captureCtx.createScriptProcessor(4096, 1, 1);
        silentSink = captureCtx.createGain();
        silentSink.gain.value = 0;
        mediaSource.connect(processor);
        processor.connect(silentSink);
        silentSink.connect(captureCtx.destination);

        processor.onaudioprocess = (ev) => {
          if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          const input = ev.inputBuffer.getChannelData(0);
          const rate = captureCtx.sampleRate;
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

        playbackCtx = new AudioContext();
        await playbackCtx.resume();

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

        const vTrack = mediaStream.getVideoTracks()[0];
        if (sendVideoHints && vTrack && vTrack.readyState === "live") {
          tapVideo = document.createElement("video");
          tapVideo.muted = true;
          tapVideo.playsInline = true;
          tapVideo.setAttribute("playsinline", "true");
          tapVideo.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-99px;";
          document.body.appendChild(tapVideo);
          tapCanvas = document.createElement("canvas");
          tapCanvas.width = 640;
          tapCanvas.height = 360;
          tapVideo.srcObject = new MediaStream([vTrack]);
          tapVideo.play().catch(() => {});

          videoId = setInterval(() => {
            if (closed || !ws || ws.readyState !== WebSocket.OPEN || !tapVideo || !tapCanvas) {
              return;
            }
            if (tapVideo.readyState < 2) {
              return;
            }
            const ctx2d = tapCanvas.getContext("2d");
            if (!ctx2d) {
              return;
            }
            try {
              ctx2d.drawImage(tapVideo, 0, 0, tapCanvas.width, tapCanvas.height);
              const dataUrl = tapCanvas.toDataURL("image/jpeg", 0.45);
              const comma = dataUrl.indexOf(",");
              const jpegB64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
              if (jpegB64) {
                ws.send(JSON.stringify({ type: "video", data: jpegB64, mimeType: "image/jpeg" }));
              }
            } catch {
              /* ignore */
            }
          }, VIDEO_INTERVAL_MS);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`Voice interviewer: audio setup failed (${msg})`);
        onStatus("error", msg);
        stop();
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
          const ms = typeof p.delayMs === "number" ? p.delayMs : 0;
          const uc = p.upstreamCode != null ? String(p.upstreamCode) : "";
          const ur = typeof p.upstreamReason === "string" && p.upstreamReason.trim() ? ` (${p.upstreamReason.trim()})` : "";
          log(
            `Voice interviewer: Google Live session ended${uc ? ` [${uc}]` : ""}${ur} — reconnecting in ~${ms}ms`,
          );
          onStatus("connecting");
        } else if (t === "modelAudio" && typeof p.data === "string" && playbackCtx) {
          setSpeakingUi(true);
          schedulePcmPlayback(p.data, typeof p.mimeType === "string" ? p.mimeType : "", playbackCtx, playSched);
        } else if (t === "modelText" && typeof p.text === "string" && p.text.trim()) {
          log(`Interviewer: ${p.text.trim().slice(0, 200)}${p.text.length > 200 ? "…" : ""}`);
        } else if (t === "inputTranscription" && typeof p.text === "string" && p.text.trim()) {
          log(`You (transcript): ${p.text.trim().slice(0, 200)}${p.text.length > 200 ? "…" : ""}`);
        } else if (t === "error" && p.message) {
          log(`Voice interviewer error: ${p.message}`);
          onStatus("error", String(p.message));
        } else if (t === "turnComplete" || t === "generationComplete") {
          setSpeakingUi(false);
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

    return { stop: finalizeUserStop };
  }

  global.GeminiLiveBridge = { start };
})(typeof globalThis !== "undefined" ? globalThis : window);
