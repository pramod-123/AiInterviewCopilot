const metaEl = document.getElementById("meta");
const logEntriesEl = document.getElementById("logEntries");
const logScrollEl = document.getElementById("logScroll");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const btnEnd = document.getElementById("btnEnd");
const chkMic = document.getElementById("chkMic");
const processStatusEl = document.getElementById("processStatus");
const resultSectionEl = document.getElementById("resultSection");
const sessionClockEl = document.getElementById("sessionClock");
const sessionStatePill = document.getElementById("sessionStatePill");
const sessionStateLabel = document.getElementById("sessionStateLabel");
const tabCaptureStatusEl = document.getElementById("tabCaptureStatus");
const micCaptureStatusEl = document.getElementById("micCaptureStatus");
const analysisPulseEl = document.getElementById("analysisPulse");
const btnSideSettings = document.getElementById("btnSideSettings");
const btnSideHelp = document.getElementById("btnSideHelp");
const sideSettingsPanel = document.getElementById("sideSettingsPanel");
const sideHelpPanel = document.getElementById("sideHelpPanel");

/** Poll interval for live session job + interview result (ms). */
const POST_PROCESS_POLL_MS = 2500;

/** @type {AbortController | null} */
let postProcessPollAbort = null;

const MIC_PERMISSION_HINT =
  "Side panel mic prompts often fail in Chrome. Fix: use the toolbar popup → Start interview (Allow mic there), or chrome://settings/content/microphone → allow this extension.";

/** @type {string} */
let sessionId = "";
/** @type {string} */
let apiBase = "";
/** @type {number} */
let leetcodeTabId = NaN;

/** @type {number | null} */
let codeIntervalId = null;

/** Last editor text successfully uploaded; `null` means no snapshot yet this recording. */
let lastUploadedCode = null;

/** `performance.now()` when tab capture succeeded; code snapshot offsets are vs merged video / SRT t≈0. */
let recordingStartedPerfMs = null;

/** @type {MediaRecorder | null} */
let tabRecorder = null;
/** @type {MediaStream | null} */
let tabMediaStream = null;
/** @type {AudioContext | null} */
let tabAudioPassthroughCtx = null;

/** Stops mic tracks after {@link attachMicDirectToTabVideo} (or legacy mixer). */
let releaseMixer = null;

/** @type {number | null} */
let recordingWallClockId = null;

function formatMmSs(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function updateSessionClockFromPerfOrigin() {
  if (!sessionClockEl || recordingStartedPerfMs == null) {
    return;
  }
  const sec = (performance.now() - recordingStartedPerfMs) / 1000;
  sessionClockEl.textContent = formatMmSs(sec);
}

function startRecordingWallClock() {
  stopRecordingWallClock();
  updateSessionClockFromPerfOrigin();
  recordingWallClockId = window.setInterval(updateSessionClockFromPerfOrigin, 1000);
}

function stopRecordingWallClock() {
  if (recordingWallClockId != null) {
    window.clearInterval(recordingWallClockId);
    recordingWallClockId = null;
  }
  if (sessionClockEl) {
    sessionClockEl.textContent = "00:00";
  }
}

function clearLogEntries() {
  if (logEntriesEl) {
    logEntriesEl.replaceChildren();
  }
}

function syncCaptureUi() {
  const recording = tabRecorder != null && tabRecorder.state !== "inactive";
  document.body.classList.toggle("is-recording", recording);

  if (sessionStatePill) {
    sessionStatePill.classList.toggle("is-recording", recording);
  }
  if (sessionStateLabel) {
    sessionStateLabel.textContent = recording ? "Session active" : "Standby";
  }

  if (tabCaptureStatusEl) {
    tabCaptureStatusEl.textContent = recording ? "Active" : "Idle";
    tabCaptureStatusEl.classList.toggle("idle", !recording);
  }

  if (micCaptureStatusEl) {
    if (recording) {
      if (releaseMixer) {
        micCaptureStatusEl.textContent = "Connected";
        micCaptureStatusEl.classList.remove("idle");
      } else {
        const at = tabMediaStream?.getAudioTracks().length ?? 0;
        micCaptureStatusEl.textContent = at > 0 ? "Tab audio" : "Off";
        micCaptureStatusEl.classList.toggle("idle", at === 0);
      }
    } else {
      const wantMic = Boolean(chkMic?.checked);
      micCaptureStatusEl.textContent = wantMic ? "Ready" : "Off";
      micCaptureStatusEl.classList.toggle("idle", !wantMic);
    }
  }

  if (analysisPulseEl) {
    analysisPulseEl.classList.toggle("on", recording);
  }
}

/**
 * @param {HTMLElement | null} panel
 * @param {HTMLButtonElement | null} btn
 * @param {boolean} open
 */
function setPanelOpen(panel, btn, open) {
  if (panel) {
    panel.classList.toggle("hidden", !open);
  }
  if (btn) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

function log(line) {
  const timeStr = new Date().toISOString().slice(11, 19);
  if (logEntriesEl) {
    const pulse = /Interview result ready/i.test(line);
    if (pulse) {
      for (const el of logEntriesEl.querySelectorAll(".log-row-pulse")) {
        el.classList.remove("log-row-pulse");
      }
    }
    const row = document.createElement("div");
    row.className = "log-row";
    if (/Session ended on server\.|Interview result ready|Processing complete\./i.test(line)) {
      row.classList.add("log-row-highlight");
    }
    if (pulse) {
      row.classList.add("log-row-pulse");
    }
    const tEl = document.createElement("span");
    tEl.className = "log-time";
    tEl.textContent = timeStr;
    const mEl = document.createElement("span");
    mEl.className = "log-msg";
    mEl.textContent = line;
    row.appendChild(tEl);
    row.appendChild(mEl);
    logEntriesEl.appendChild(row);
    if (logScrollEl) {
      logScrollEl.scrollTop = logScrollEl.scrollHeight;
    }
  } else {
    console.warn("[InterviewCopilot]", timeStr, line);
  }
}

function setProcessStatus(text, isError) {
  if (!processStatusEl) {
    return;
  }
  processStatusEl.hidden = false;
  processStatusEl.textContent = text;
  processStatusEl.className = isError ? "err" : "";
}

function hideProcessStatus() {
  if (!processStatusEl) {
    return;
  }
  processStatusEl.hidden = true;
  processStatusEl.textContent = "";
  processStatusEl.className = "";
}

function clearResultSection() {
  if (!resultSectionEl) {
    return;
  }
  resultSectionEl.hidden = true;
  resultSectionEl.replaceChildren();
}

function stopPostProcessPolling() {
  if (postProcessPollAbort) {
    postProcessPollAbort.abort();
    postProcessPollAbort = null;
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @param {string} url
 */
async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * @param {AbortSignal} signal
 * @returns {Promise<string | null>}
 */
async function pollForPostProcessJobId(signal) {
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const { res, data } = await fetchJson(`${apiBase}/api/live-sessions/${sessionId}`);
    if (!res.ok) {
      throw new Error(data.error || `GET session HTTP ${res.status}`);
    }
    const job = data.postProcessJob;
    const id = job && typeof job.id === "string" ? job.id : "";
    if (id) {
      return id;
    }
    await sleepAbortable(POST_PROCESS_POLL_MS, signal);
  }
  return null;
}

/**
 * @param {string} jobId
 * @param {AbortSignal} signal
 */
async function pollInterviewUntilComplete(jobId, signal) {
  const deadline = Date.now() + 40 * 60 * 1000;
  while (Date.now() < deadline) {
    const { res, data } = await fetchJson(`${apiBase}/api/interviews/${jobId}`);
    if (!res.ok) {
      throw new Error(data.error || `GET interview HTTP ${res.status}`);
    }
    if (res.status === 200 && data.result != null) {
      return data;
    }
    if (data.status === "FAILED") {
      throw new Error(data.errorMessage || data.message || "Post-processing failed.");
    }
    await sleepAbortable(POST_PROCESS_POLL_MS, signal);
  }
  return null;
}

/** @param {{ result?: unknown } & Record<string, unknown>} data */
function renderInterviewResult(data) {
  if (!resultSectionEl) {
    return;
  }
  clearResultSection();
  resultSectionEl.hidden = false;
  const rv = window.InterviewCopilotResultView;
  if (rv && typeof rv.renderInterviewGetResponse === "function") {
    rv.renderInterviewGetResponse(resultSectionEl, data);
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "raw";
  pre.textContent = JSON.stringify(data, null, 2);
  resultSectionEl.appendChild(pre);
}

function startPostProcessPollingAfterEnd() {
  if (!sessionId || !apiBase || !processStatusEl) {
    return;
  }
  stopPostProcessPolling();
  clearResultSection();
  postProcessPollAbort = new AbortController();
  const { signal } = postProcessPollAbort;

  void (async () => {
    try {
      setProcessStatus("Waiting for post-process job (merge + speech)…", false);
      const jobId = await pollForPostProcessJobId(signal);
      if (signal.aborted) {
        return;
      }
      if (!jobId) {
        setProcessStatus("Timed out waiting for a job to be linked to this session.", true);
        return;
      }
      setProcessStatus(
        `Processing… (${jobId.slice(0, 8)}…). Speech + evaluation can take several minutes.`,
        false,
      );
      const final = await pollInterviewUntilComplete(jobId, signal);
      if (signal.aborted) {
        return;
      }
      if (!final) {
        setProcessStatus("Timed out waiting for results.", true);
        return;
      }
      setProcessStatus("Processing complete.", false);
      log(`Interview result ready (job ${jobId.slice(0, 8)}…).`);
      renderInterviewResult(final);
    } catch (e) {
      if (e && typeof e === "object" && "name" in e && e.name === "AbortError") {
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      setProcessStatus(msg, true);
      log(`post-process poll: ${msg}`);
    }
  })();
}

function tabIdValid() {
  return Number.isInteger(leetcodeTabId) && leetcodeTabId >= 0;
}

/**
 * Tab-capture stream IDs must be consumed by getUserMedia in the **same renderer** that called
 * getMediaStreamId. The side panel and offscreen documents are different processes — offscreen fails.
 * @param {MediaStream} stream
 * @returns {MediaRecorder}
 */
function createMediaRecorder(stream) {
  const hasAudio = stream.getAudioTracks().length > 0;
  /** Prefer explicit Opus — bare `video/webm` can mux video-only in Chrome. */
  /** @type {(MediaRecorderOptions | undefined)[]} */
  const attempts = hasAudio
    ? [
        /** Tab video + mic audio are different sources; default muxer is often most reliable. */
        undefined,
        {},
        { mimeType: "video/webm;codecs=vp9,opus", audioBitsPerSecond: 128000 },
        { mimeType: "video/webm;codecs=vp8,opus", audioBitsPerSecond: 128000 },
        { mimeType: "video/webm;codecs=vp9,opus" },
        { mimeType: "video/webm;codecs=vp8,opus" },
      ]
    : [
        { mimeType: "video/webm;codecs=vp9,opus" },
        { mimeType: "video/webm;codecs=vp8,opus" },
        { mimeType: "video/webm" },
        undefined,
      ];

  for (const opts of attempts) {
    if (opts?.mimeType && !MediaRecorder.isTypeSupported(opts.mimeType)) {
      continue;
    }
    try {
      const rec =
        opts === undefined ? new MediaRecorder(stream) : new MediaRecorder(stream, opts);
      log(`MediaRecorder: ${rec.mimeType || "default"} (audio tracks: ${stream.getAudioTracks().length})`);
      return rec;
    } catch {
      /* try next */
    }
  }
  return new MediaRecorder(stream);
}

async function stopTabAudioPassthrough() {
  if (!tabAudioPassthroughCtx) {
    return;
  }
  try {
    await tabAudioPassthroughCtx.close();
  } catch {
    /* ignore */
  }
  tabAudioPassthroughCtx = null;
}

/**
 * @param {MediaStream} stream
 */
async function wireTabAudioPassthrough(stream) {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    log(
      "warning: 0 audio tracks — video-only (tab audio needs the LeetCode tab focused + sound playing in that tab)",
    );
    return;
  }
  for (const t of audioTracks) {
    log(`tab audio: enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`);
  }
  try {
    tabAudioPassthroughCtx = new AudioContext();
    await tabAudioPassthroughCtx.resume();
    const src = tabAudioPassthroughCtx.createMediaStreamSource(stream);
    src.connect(tabAudioPassthroughCtx.destination);
    log("tab audio passthrough on (you should hear the LeetCode tab)");
  } catch (e) {
    log(
      `tab audio passthrough failed: ${e instanceof Error ? e.message : String(e)} (file may still have audio)`,
    );
  }
}

/**
 * Tab video + **raw microphone** in one MediaStream (no Web Audio graph).
 * Chrome often muxes **silent Opus** when audio is routed only through {@link AudioContext} → {@link MediaStreamDestination}.
 * Tab **playback** audio is not included here — only your mic. (Meet audio in-tab needs a future mix option.)
 * @param {MediaStream} tabStream
 * @param {Promise<MediaStream>} micPromise
 * @returns {Promise<MediaStream>}
 */
async function attachMicDirectToTabVideo(tabStream, micPromise) {
  const mic = await micPromise;

  const vids = tabStream.getVideoTracks();
  if (vids.length === 0) {
    for (const t of mic.getTracks()) {
      t.stop();
    }
    throw new Error("tab stream has no video track");
  }

  const micAudios = mic.getAudioTracks();
  if (micAudios.length === 0) {
    for (const t of mic.getTracks()) {
      t.stop();
    }
    throw new Error("microphone stream has no audio track");
  }

  for (const t of micAudios) {
    log(
      `mic: "${t.label}" enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`,
    );
  }

  const recordStream = new MediaStream([...vids, ...micAudios]);

  releaseMixer = () => {
    for (const t of mic.getTracks()) {
      t.stop();
    }
  };

  log(
    `record: ${vids.length} video + ${micAudios.length} mic (direct; tab playback audio not in file)`,
  );
  return recordStream;
}

function releaseMixerIfAny() {
  if (!releaseMixer) {
    return;
  }
  try {
    releaseMixer();
  } catch {
    /* ignore */
  }
  releaseMixer = null;
}

/**
 * If the user granted mic but tab capture failed before the mixer took ownership, stop the mic tracks.
 * @param {Promise<MediaStream> | null | undefined} p
 */
async function stopMicPromiseIfResolved(p) {
  if (!p) {
    return;
  }
  try {
    const m = await p;
    for (const t of m.getTracks()) {
      t.stop();
    }
  } catch {
    /* denied or already stopped */
  }
}

/**
 * @param {string} streamId
 * @returns {Promise<MediaStream>}
 */
async function getStreamFromCaptureId(streamId) {
  await stopTabAudioPassthrough();

  const vid = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  };
  const aud = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  };

  /** One getUserMedia with video+audio first — some builds reject a second call with the same chromeMediaSourceId. */
  /** @type {MediaStreamConstraints[]} */
  const combinedAttempts = [
    { audio: { mandatory: { ...aud.mandatory } }, video: { mandatory: { ...vid.mandatory } } },
    {
      audio: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
      video: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  ];

  let lastCombinedErr = null;
  for (const constraints of combinedAttempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      log("tab capture: single getUserMedia (video+audio)");
      return stream;
    } catch (e) {
      lastCombinedErr = e;
    }
  }

  log(
    `tab combined capture failed: ${lastCombinedErr instanceof Error ? lastCombinedErr.message : String(lastCombinedErr)} — trying split video/audio`,
  );

  /** @type {MediaStream | null} */
  let vStream = null;
  try {
    vStream = await navigator.mediaDevices.getUserMedia({
      video: vid,
      audio: false,
    });
    const aStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: aud,
    });
    const stream = new MediaStream([
      ...vStream.getVideoTracks(),
      ...aStream.getAudioTracks(),
    ]);
    log("tab capture: separate video + audio getUserMedia merged");
    return stream;
  } catch (e1) {
    if (vStream) {
      for (const t of vStream.getTracks()) {
        t.stop();
      }
    }
    log(
      `tab split capture failed: ${e1 instanceof Error ? e1.message : String(e1)} — falling back to video-only`,
    );
  }

  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { ...vid.mandatory } },
  });
}

/**
 * Captures the **currently selected tab** in this window (must be the LeetCode tab). No stream id.
 * @returns {Promise<MediaStream>}
 */
function captureActiveTabViaChromeApi() {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.capture({ audio: true, video: true }, (stream) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!stream || stream.getVideoTracks().length === 0) {
          reject(new Error("tabCapture.capture returned no video track"));
          return;
        }
        resolve(stream);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

async function uploadVideoChunk(blob) {
  if (!sessionId || !apiBase) {
    return;
  }
  const fd = new FormData();
  fd.append("chunk", blob, "chunk.webm");
  const res = await fetch(`${apiBase}/api/live-sessions/${sessionId}/video-chunk`, {
    method: "POST",
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `video-chunk HTTP ${res.status}`);
  }
  log(`video chunk #${data.sequence} ok (${data.sizeBytes} bytes)`);
}

function stopTabCapture() {
  if (tabRecorder && tabRecorder.state !== "inactive") {
    try {
      tabRecorder.stop();
    } catch {
      /* ignore */
    }
  }
  tabRecorder = null;
  void stopTabAudioPassthrough();
  releaseMixerIfAny();
  if (tabMediaStream) {
    for (const t of tabMediaStream.getTracks()) {
      t.stop();
    }
    tabMediaStream = null;
  }
}

/**
 * @param {MediaStream} stream
 * @param {{ recordMic?: boolean; micPromise?: Promise<MediaStream> | null }} [opts] — mic intent is fixed at Start click (see handler).
 */
async function startTabCaptureFromStream(stream, opts = {}) {
  const recordMic = Boolean(opts.recordMic);
  const micPromise = opts.micPromise ?? null;

  stopTabCapture();

  /** Raw tab capture (for preview / logging). */
  const tabOnlyStream = stream;
  let recordStream = tabOnlyStream;

  if (recordMic && micPromise) {
    try {
      recordStream = await attachMicDirectToTabVideo(tabOnlyStream, micPromise);
      const tabAud = tabOnlyStream.getAudioTracks();
      for (const t of tabAud) {
        t.stop();
      }
      if (tabAud.length > 0) {
        log(`stopped ${tabAud.length} tab audio track(s); file uses mic only`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`microphone not available: ${msg} — recording tab audio only`);
      if (/permission|dismissed|not allowed/i.test(msg) || (e instanceof Error && e.name === "NotAllowedError")) {
        log(MIC_PERMISSION_HINT);
      }
    }
  }

  tabMediaStream = recordStream;
  const vt = tabMediaStream.getVideoTracks()[0];
  if (vt) {
    vt.addEventListener("ended", () => {
      stopTabCapture();
      log("Tab capture ended.");
      resetAfterCapturePipeStops("Tab capture ended (tab closed or navigated away).");
    });
  }

  if (recordMic && recordStream !== tabOnlyStream) {
    log("speaker preview off during mic capture (keeps MediaRecorder tracks untouched)");
  } else {
    await wireTabAudioPassthrough(tabMediaStream);
  }

  tabRecorder = createMediaRecorder(tabMediaStream);

  tabRecorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) {
      return;
    }
    try {
      await uploadVideoChunk(e.data);
    } catch (err) {
      log(`upload chunk failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  tabRecorder.onerror = (ev) => {
    log(`MediaRecorder error: ${ev.error?.message || "unknown"}`);
  };

  const sliceMs = 10_000;
  tabRecorder.start(sliceMs);
  recordingStartedPerfMs = performance.now();
  startRecordingWallClock();
  syncCaptureUi();
  log(`Tab capture on (~${sliceMs / 1000}s chunks) in side panel`);
}

/**
 * @param {string} streamId
 * @param {{ recordMic?: boolean; micPromise?: Promise<MediaStream> | null }} [opts]
 */
async function startTabCapturePipeline(streamId, opts = {}) {
  let stream;
  try {
    stream = await getStreamFromCaptureId(streamId);
  } catch (e) {
    await stopMicPromiseIfResolved(opts.micPromise);
    throw e;
  }
  await startTabCaptureFromStream(stream, opts);
}

/**
 * @param {string} code
 * @param {{ forceOffsetSeconds?: number }} [opts] — use `forceOffsetSeconds: 0` for the mandatory t=0 snapshot.
 */
async function uploadCodeSnapshot(code, opts = {}) {
  const offsetSeconds =
    typeof opts.forceOffsetSeconds === "number"
      ? opts.forceOffsetSeconds
      : recordingStartedPerfMs == null
        ? 0
        : (performance.now() - recordingStartedPerfMs) / 1000;
  const res = await fetch(`${apiBase}/api/live-sessions/${sessionId}/code-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      offsetSeconds,
      capturedAt: new Date().toISOString(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `code-snapshot HTTP ${res.status}`);
  }
  log(
    `code snapshot #${data.sequence} ok (${code.length} chars) @ ${offsetSeconds.toFixed(2)}s`,
  );
}

async function pushQuestionToServer(question) {
  const res = await fetch(`${apiBase}/api/live-sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `PATCH session HTTP ${res.status}`);
  }
}

/**
 * Runs in the LeetCode tab MAIN world (serialized by `executeScript` — self-contained, no closures).
 * Prefers dehydrated GraphQL (`__NEXT_DATA__`) when the visible DOM is in a shadow tree or virtualized.
 * @returns {string}
 */
function extractLeetCodeQuestionMainWorld() {
  const MAX = 100000;
  function stripHtml(html) {
    if (!html || typeof html !== "string") {
      return "";
    }
    const t = document.createElement("template");
    t.innerHTML = html;
    return (t.content.textContent || "").replace(/\u00a0/g, " ").trim();
  }
  function slugTitle() {
    const m = location.pathname.match(/\/problems\/([^/]+)/i);
    if (!m) {
      return "";
    }
    return m[1]
      .split("-")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  function formatQuestionObj(raw) {
    if (!raw || typeof raw !== "object") {
      return "";
    }
    const title = String(raw.title || raw.questionTitle || "").trim();
    let content = String(raw.content || raw.translatedContent || "").trim();
    if (content.includes("<")) {
      content = stripHtml(content);
    } else {
      content = content.replace(/\u00a0/g, " ").trim();
    }
    if (!title && !content) {
      return "";
    }
    return title && content ? `${title}\n\n${content}` : title || content;
  }
  function fromDehydratedNext() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el?.textContent) {
      return "";
    }
    let d;
    try {
      d = JSON.parse(el.textContent);
    } catch {
      return "";
    }
    let best = "";
    const consider = (text) => {
      const t = String(text || "")
        .replace(/\u00a0/g, " ")
        .trim();
      if (t.length > best.length) {
        best = t;
      }
    };
    const queries = d?.props?.pageProps?.dehydratedState?.queries;
    if (Array.isArray(queries)) {
      for (const q of queries) {
        const data = q?.state?.data;
        if (!data || typeof data !== "object") {
          continue;
        }
        const nested = [data.question, data.consolePanelQuestion?.question];
        for (const raw of nested) {
          consider(formatQuestionObj(raw));
        }
        if ((data.title || data.questionTitle) && (data.content || data.translatedContent)) {
          consider(formatQuestionObj(data));
        }
      }
    }
    const pq = d?.props?.pageProps?.question;
    if (pq && typeof pq === "object") {
      consider(formatQuestionObj(pq));
    }
    return best;
  }
  function longestInnerTextAcross(selectors) {
    let best = "";
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        const t = (el.innerText || "").replace(/\u00a0/g, " ").trim();
        if (t.length > best.length && t.length < MAX) {
          best = t;
        }
      }
    }
    return best;
  }
  function firstTitleText() {
    const titleSelectors = [
      '[data-cy="question-title"]',
      '[data-cy="qb-title"]',
      '[data-cy="interview-question-title"]',
      ".text-title-large",
      ".text-headline-medium",
    ];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      const t = (el?.textContent || "").replace(/\u00a0/g, " ").trim();
      if (t) {
        return t;
      }
    }
    return "";
  }
  function fromDom() {
    const title = firstTitleText();
    /* Avoid `[role=tabpanel]` in the main pass — a longer Solutions / Editorial tab can beat Description. */
    let body = longestInnerTextAcross([
      '[data-cy="question-content"]',
      '[data-cy="description-content"]',
      'div[data-track-load="description_content"]',
      '[class*="description-content"]',
      '[class*="question-content"]',
      '[class*="problem-statement"]',
      '[class*="ProblemStatement"]',
      '[class*="_questionContent"]',
      ".lc-md",
      '[class*="lc-md"]',
    ]);
    if (!body || body.length < 80) {
      const tabFallback = longestInnerTextAcross([
        '[data-cy="question-detail-main-tabs"] [role="tabpanel"]',
      ]);
      if (tabFallback.length > body.length) {
        body = tabFallback;
      }
    }
    if (body) {
      return title ? `${title}\n\n${body}` : body;
    }
    if (title) {
      return title;
    }
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || "";
    const og = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() || "";
    const slug = slugTitle();
    if (metaDesc && metaDesc.length > 50) {
      return slug ? `${slug}\n\n${metaDesc}` : metaDesc;
    }
    if (og && og.length > 50) {
      return slug ? `${slug}\n\n${og}` : og;
    }
    if (slug) {
      return `${slug}\n\n(Full statement was not readable from the page. Keep the problem **Description** tab visible and try again, or rely on code + video on the server.)`;
    }
    return "";
  }
  const embedded = fromDehydratedNext().replace(/\u00a0/g, " ").trim();
  const dom = fromDom().replace(/\u00a0/g, " ").trim();
  const merged = embedded.length >= dom.length ? embedded : dom;
  return merged.slice(0, MAX);
}

/**
 * Isolated-world content script + MAIN-world `__NEXT_DATA__` / DOM. Uses the longer extraction so a
 * partial first-match from the content script does not hide the full statement from `__NEXT_DATA__`.
 * @returns {Promise<string>}
 */
async function pullQuestionFromLeetCodeTab() {
  if (!tabIdValid()) {
    return "";
  }
  let fromCs = "";
  try {
    const qr = await chrome.tabs.sendMessage(leetcodeTabId, { type: "GET_QUESTION" });
    if (qr?.ok && typeof qr.question === "string") {
      fromCs = qr.question.trim();
    }
  } catch {
    /* content script missing or tab closed */
  }
  let fromMain = "";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: leetcodeTabId },
      world: "MAIN",
      func: extractLeetCodeQuestionMainWorld,
    });
    const r = results[0]?.result;
    if (typeof r === "string") {
      fromMain = r.trim();
    }
  } catch {
    /* restricted tab */
  }
  if (!fromCs) {
    return fromMain;
  }
  if (!fromMain) {
    return fromCs;
  }
  return fromMain.length >= fromCs.length ? fromMain : fromCs;
}

/**
 * @returns {{ ok: true, code: string, source: string } | { ok: false, error: string }}
 */
async function getCodeFromLeetCodeTab() {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: leetcodeTabId, allFrames: true },
      world: "MAIN",
      func: () => {
        try {
          const monaco = globalThis.monaco;
          if (!monaco?.editor?.getModels) {
            return { code: "" };
          }
          let best = "";
          for (const m of monaco.editor.getModels()) {
            const v = m.getValue();
            if (typeof v === "string" && v.length > best.length) {
              best = v;
            }
          }
          return { code: best };
        } catch {
          return { code: "" };
        }
      },
    });
    let bestCode = "";
    for (const inj of results) {
      const c = inj.result && typeof inj.result.code === "string" ? inj.result.code : "";
      if (c.length > bestCode.length) {
        bestCode = c;
      }
    }
    if (bestCode.length > 0) {
      return { ok: true, code: bestCode, source: "monaco" };
    }
  } catch {
    /* fall through */
  }

  try {
    const response = await chrome.tabs.sendMessage(leetcodeTabId, { type: "GET_CODE" });
    if (!response?.ok) {
      return { ok: false, error: response?.error || "no response" };
    }
    const code = typeof response.code === "string" ? response.code : "";
    return { ok: true, code, source: "dom" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** First snapshot after recording starts; always **t = 0** on the server timeline. */
async function pullAndUploadCodeInitial() {
  try {
    const got = await getCodeFromLeetCodeTab();
    if (!got.ok) {
      log(`code t=0 skip: ${got.error}`);
      return;
    }
    const { code, source } = got;
    await uploadCodeSnapshot(code, { forceOffsetSeconds: 0 });
    lastUploadedCode = code;
    if (source === "dom") {
      log("code via DOM (visible lines only — scroll full editor into view or update LeetCode if incomplete)");
    }
  } catch (e) {
    log(`code t=0 error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 10 s tick: rapid edits are batched — only the **latest** text is compared; upload if it changed.
 */
async function pullAndUploadCodeTick() {
  try {
    const got = await getCodeFromLeetCodeTab();
    if (!got.ok) {
      log(`code skip: ${got.error}`);
      return;
    }
    const { code, source } = got;
    if (lastUploadedCode !== null && code === lastUploadedCode) {
      return;
    }
    if (lastUploadedCode === null) {
      await uploadCodeSnapshot(code, { forceOffsetSeconds: 0 });
    } else {
      await uploadCodeSnapshot(code);
    }
    lastUploadedCode = code;
    if (source === "dom") {
      log("code via DOM (visible lines only — scroll full editor into view or update LeetCode if incomplete)");
    }
  } catch (e) {
    log(`code error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** On stop/end: one upload if the buffer changed after the last tick. */
async function flushCodeSnapshotIfChanged() {
  if (recordingStartedPerfMs == null || !sessionId || !apiBase) {
    return;
  }
  try {
    const got = await getCodeFromLeetCodeTab();
    if (!got.ok) {
      return;
    }
    const { code } = got;
    if (lastUploadedCode !== null && code === lastUploadedCode) {
      return;
    }
    if (lastUploadedCode === null) {
      await uploadCodeSnapshot(code, { forceOffsetSeconds: 0 });
    } else {
      await uploadCodeSnapshot(code);
    }
    lastUploadedCode = code;
    log("code snapshot flushed (final change before stop)");
  } catch {
    /* ignore on teardown */
  }
}

function clearCodeInterval() {
  if (codeIntervalId != null) {
    window.clearInterval(codeIntervalId);
    codeIntervalId = null;
  }
}

/**
 * @param {unknown} [reason]
 */
function resetAfterCapturePipeStops(reason) {
  clearCodeInterval();
  recordingStartedPerfMs = null;
  stopRecordingWallClock();
  lastUploadedCode = null;
  btnStart.disabled = false;
  btnStop.disabled = true;
  if (chkMic) {
    chkMic.disabled = false;
  }
  syncCaptureUi();
  if (typeof reason === "string" && reason) {
    log(reason);
  }
}

async function stopAll(reason) {
  await flushCodeSnapshotIfChanged();
  clearCodeInterval();
  recordingStartedPerfMs = null;
  stopRecordingWallClock();
  lastUploadedCode = null;
  stopTabCapture();
  btnStart.disabled = false;
  btnStop.disabled = true;
  if (chkMic) {
    chkMic.disabled = false;
  }
  syncCaptureUi();
  if (reason) {
    log(reason);
  }
}

async function resolveSessionConfig() {
  const params = new URLSearchParams(window.location.search);
  const fromUrlSid = params.get("sessionId");
  if (fromUrlSid) {
    sessionId = fromUrlSid;
    apiBase = (params.get("apiBase") || "").replace(/\/$/, "");
    const raw = params.get("tabId");
    leetcodeTabId =
      raw != null && raw !== "" ? Number.parseInt(raw, 10) : Number.NaN;
    return;
  }

  const { pendingRecorder } = await chrome.storage.session.get(["pendingRecorder"]);
  if (pendingRecorder && typeof pendingRecorder.sessionId === "string") {
    sessionId = pendingRecorder.sessionId;
    apiBase = String(pendingRecorder.apiBase || "")
      .trim()
      .replace(/\/$/, "");
    leetcodeTabId =
      typeof pendingRecorder.tabId === "number" ? pendingRecorder.tabId : Number.NaN;
  }
}

async function init() {
  await resolveSessionConfig();

  const { preferRecordMic } = await chrome.storage.local.get(["preferRecordMic"]);
  if (chkMic && typeof preferRecordMic === "boolean") {
    chkMic.checked = preferRecordMic;
  }

  if (!sessionId || !apiBase || !tabIdValid()) {
    if (metaEl) {
      metaEl.textContent =
        "Use the toolbar popup → Start interview on a LeetCode tab (that opens this side panel with a session).";
    }
    btnStart.disabled = true;
    if (chkMic) {
      chkMic.disabled = true;
    }
    hideProcessStatus();
    clearResultSection();
    stopRecordingWallClock();
    syncCaptureUi();
    return;
  }

  if (metaEl) {
    metaEl.textContent = `Session ${sessionId} · LeetCode tab #${leetcodeTabId} · ${apiBase}`;
  }

  if (chkMic) {
    chkMic.addEventListener("change", () => {
      void chrome.storage.local.set({ preferRecordMic: chkMic.checked });
      syncCaptureUi();
    });
  }

  if (btnSideSettings && sideSettingsPanel) {
    btnSideSettings.addEventListener("click", () => {
      const willOpen = sideSettingsPanel.classList.contains("hidden");
      if (sideHelpPanel && btnSideHelp) {
        setPanelOpen(sideHelpPanel, btnSideHelp, false);
      }
      setPanelOpen(sideSettingsPanel, btnSideSettings, willOpen);
    });
  }
  if (btnSideHelp && sideHelpPanel) {
    btnSideHelp.addEventListener("click", () => {
      const willOpen = sideHelpPanel.classList.contains("hidden");
      if (sideSettingsPanel && btnSideSettings) {
        setPanelOpen(sideSettingsPanel, btnSideSettings, false);
      }
      setPanelOpen(sideHelpPanel, btnSideHelp, willOpen);
    });
  }

  syncCaptureUi();

  btnStart.addEventListener("click", async () => {
    if (!sessionId || !apiBase || !tabIdValid()) {
      return;
    }

    try {
      const recordMic = Boolean(chkMic && chkMic.checked);
      /** Started immediately so mic permission stays on the Start click gesture. */
      const micPromise = recordMic
        ? navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: { ideal: 1 },
            },
            video: false,
          })
        : null;

      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: leetcodeTabId,
        });
      } catch (e) {
        log(`tab capture id: ${e instanceof Error ? e.message : String(e)}`);
        if (micPromise) {
          micPromise.then((m) => m.getTracks().forEach((t) => t.stop())).catch(() => {});
        }
        return;
      }
      if (!streamId || typeof streamId !== "string") {
        log("tab capture id: empty stream id");
        if (micPromise) {
          micPromise.then((m) => m.getTracks().forEach((t) => t.stop())).catch(() => {});
        }
        return;
      }

      clearLogEntries();

      // Consume stream id in this document with no intervening awaits (tabs.update/delay can break capture).
      try {
        await startTabCapturePipeline(streamId, { recordMic, micPromise });
      } catch (e1) {
        log(
          `stream-id path failed: ${e1 instanceof Error ? e1.message : String(e1)} — trying tabCapture.capture (LeetCode tab will be focused)`,
        );
        stopTabCapture();
        try {
          await chrome.tabs.update(leetcodeTabId, { active: true });
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 250));
        const stream = await captureActiveTabViaChromeApi();
        log("tab capture: using chrome.tabCapture.capture (active tab)");
        await startTabCaptureFromStream(stream, { recordMic, micPromise });
      }

      try {
        await chrome.tabs.update(leetcodeTabId, { active: true });
      } catch {
        /* ignore */
      }

      void (async () => {
        let question = "";
        try {
          question = await pullQuestionFromLeetCodeTab();
        } catch {
          question = "";
        }
        try {
          await pushQuestionToServer(question);
          const slugOnly =
            question.length > 0 &&
            /Full statement was not readable|Keep the problem \*\*Description\*\*/i.test(question);
          log(
            question.length > 0
              ? slugOnly
                ? `question saved (${question.length} chars; slug/meta only — open Description tab for full text if needed)`
                : `question saved (${question.length} chars)`
              : "question empty (not on a /problems/… page, or page blocked script access)",
          );
        } catch (e) {
          log(
            `question save failed: ${e instanceof Error ? e.message : String(e)} — capture continues`,
          );
        }
      })();

      lastUploadedCode = null;
      await pullAndUploadCodeInitial();
      const sliceMs = 10_000;
      codeIntervalId = window.setInterval(() => {
        void pullAndUploadCodeTick();
      }, sliceMs);

      btnStart.disabled = true;
      btnStop.disabled = false;
      btnEnd.disabled = false;
      if (chkMic) {
        chkMic.disabled = true;
      }
      syncCaptureUi();
    } catch (e) {
      log(`start failed: ${e instanceof Error ? e.message : String(e)}`);
      stopTabCapture();
      stopRecordingWallClock();
      if (chkMic) {
        chkMic.disabled = false;
      }
      syncCaptureUi();
    }
  });

  btnStop.addEventListener("click", () => {
    void stopAll("Capture stopped.");
  });

  btnEnd.addEventListener("click", async () => {
    await stopAll(null);
    try {
      const res = await fetch(`${apiBase}/api/live-sessions/${sessionId}/end`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        log(`end session: ${data.error || res.status}`);
        return;
      }
      log("Session ended on server.");
      btnEnd.disabled = true;
      await chrome.storage.session.remove(["pendingRecorder"]);
      startPostProcessPollingAfterEnd();
    } catch (e) {
      log(`end session: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  window.addEventListener("beforeunload", () => {
    stopPostProcessPolling();
    void flushCodeSnapshotIfChanged();
    clearCodeInterval();
    recordingStartedPerfMs = null;
    stopRecordingWallClock();
    lastUploadedCode = null;
    stopTabCapture();
  });
}

void init();
