const DEFAULT_API = "http://127.0.0.1:3001";

const apiBaseInput = document.getElementById("apiBase");
const btnLoad = document.getElementById("btnLoad");
const btnOpenPopup = document.getElementById("btnOpenPopup");
const btnShare = document.getElementById("btnShare");
const btnExportPrint = document.getElementById("btnExportPrint");
const sessSidebarBulk = document.getElementById("sessSidebarBulk");
const btnBulkDeleteSessions = document.getElementById("btnBulkDeleteSessions");
const bulkDeleteLabel = document.getElementById("bulkDeleteLabel");
const btnSelectAllSessions = document.getElementById("btnSelectAllSessions");
const btnClearSessionSelection = document.getElementById("btnClearSessionSelection");
const listStatus = document.getElementById("listStatus");
const sessionList = document.getElementById("sessionList");
const sessSidebar = document.getElementById("sessSidebar");
const btnSidebarToggle = document.getElementById("btnSidebarToggle");
const sessionCountBadge = document.getElementById("sessionCountBadge");
const detailPanel = document.getElementById("detailPanel");
const detailEmpty = document.getElementById("detailEmpty");
const detailWorkspace = document.getElementById("detailWorkspace");
const sessTranscriptCard = document.getElementById("sess-transcript-card");
const breadcrumbSessionId = document.getElementById("breadcrumbSessionId");
const detailTitle = document.getElementById("detailTitle");
const sessTokenMetaHost = document.getElementById("sessTokenMetaHost");
const detailSub = document.getElementById("detailSub");
const footerSessionId = document.getElementById("footerSessionId");
const sessionVideo = document.getElementById("sessionVideo");
const videoStatus = document.getElementById("videoStatus");
const transcriptLines = document.getElementById("transcriptLines");
const transcriptBadge = document.getElementById("transcriptBadge");
const sessDimensionsMount = document.getElementById("sessDimensionsMount");
const sessDimensionsBody = document.getElementById("sessDimensionsBody");
const sessMissedPairMount = document.getElementById("sessMissedPairMount");
const sessExtendedEvalMount = document.getElementById("sessExtendedEvalMount");
const sessMomentCard = document.getElementById("sess-moment-card");
const momentByMomentLines = document.getElementById("momentByMomentLines");

const footJumpVideo = document.getElementById("footJumpVideo");
const footJumpTranscript = document.getElementById("footJumpTranscript");
const footJumpDims = document.getElementById("footJumpDims");
const btnThemeToggle = document.getElementById("btnThemeToggle");

function syncSessionsThemeToggleUi() {
  if (!btnThemeToggle || typeof window.ICTheme === "undefined") {
    return;
  }
  const dark = window.ICTheme.get() === "dark";
  const icon = btnThemeToggle.querySelector(".material-icons-round");
  if (icon) {
    icon.textContent = dark ? "light_mode" : "dark_mode";
  }
  btnThemeToggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
  btnThemeToggle.setAttribute("aria-label", btnThemeToggle.title);
}

btnThemeToggle?.addEventListener("click", () => {
  window.ICTheme?.toggle();
  syncSessionsThemeToggleUi();
});

document.addEventListener("ic-theme-change", () => {
  syncSessionsThemeToggleUi();
});

window.addEventListener("storage", (e) => {
  if (e.key === window.ICTheme?.STORAGE_KEY && e.newValue) {
    window.ICTheme?.syncFromStorage();
    syncSessionsThemeToggleUi();
  }
});

syncSessionsThemeToggleUi();

/** @type {WebSocket | null} */
let postProcessWebSocket = null;

/** @type {ReturnType<typeof setInterval> | null} */
let postProcessPollTimer = null;

/** @type {string | null} */
let selectedSessionId = null;

/** @type {HTMLElement | null} */
let transcriptSeekHighlightEl = null;

function setListStatus(text, isError) {
  if (!listStatus) {
    return;
  }
  listStatus.textContent = text;
  listStatus.className = isError ? "err" : "";
}

function apiBase() {
  return (apiBaseInput?.value || "").trim().replace(/\/$/, "") || DEFAULT_API;
}

/**
 * @param {boolean} collapsed
 */
function applySidebarCollapsed(collapsed) {
  if (!sessSidebar) {
    return;
  }
  sessSidebar.classList.toggle("is-collapsed", collapsed);
  if (btnSidebarToggle) {
    btnSidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btnSidebarToggle.title = collapsed ? "Expand session list" : "Collapse session list";
    const icon = btnSidebarToggle.querySelector(".material-icons-round");
    if (icon) {
      icon.textContent = collapsed ? "chevron_right" : "chevron_left";
    }
  }
  if (sessionList) {
    sessionList.setAttribute("aria-hidden", collapsed ? "true" : "false");
  }
  if (sessSidebarBulk) {
    sessSidebarBulk.setAttribute("aria-hidden", collapsed ? "true" : "false");
  }
}

async function loadSettings() {
  const { apiBase: stored, sessionsSidebarCollapsed } = await chrome.storage.local.get([
    "apiBase",
    "sessionsSidebarCollapsed",
  ]);
  if (apiBaseInput && typeof stored === "string" && stored.trim()) {
    apiBaseInput.value = stored.trim().replace(/\/$/, "");
  } else if (apiBaseInput) {
    apiBaseInput.value = DEFAULT_API;
  }
  applySidebarCollapsed(sessionsSidebarCollapsed === true);
}

async function saveApiBase() {
  const b = apiBase();
  await chrome.storage.local.set({ apiBase: b });
}

/**
 * @param {string} text
 */
function setVideoStatusLine(text) {
  if (!videoStatus) {
    return;
  }
  videoStatus.textContent = text;
  videoStatus.hidden = !text;
}

/**
 * @param {string} sessionId
 */
function recordingUrlForSession(sessionId) {
  const base = apiBase();
  const id = encodeURIComponent(sessionId);
  return `${base}/api/live-sessions/${id}/recording.webm`;
}

/**
 * @param {string} sessionId
 * @param {number} videoChunkCount
 */
function updateSessionVideo(sessionId, videoChunkCount) {
  if (!sessionVideo) {
    return;
  }

  sessionVideo.onerror = null;
  sessionVideo.onloadedmetadata = null;
  sessionVideo.onloadeddata = null;
  sessionVideo.oncanplay = null;

  sessionVideo.pause();
  sessionVideo.removeAttribute("src");
  for (const s of sessionVideo.querySelectorAll("source")) {
    s.remove();
  }
  sessionVideo.load();

  const updateSubDuration = () => {
    if (!detailSub || !sessionVideo.duration || !Number.isFinite(sessionVideo.duration)) {
      return;
    }
    const base = detailSub.dataset.baseLine || detailSub.textContent || "";
    detailSub.textContent = `${base} · ${formatDuration(sessionVideo.duration)} recording`;
  };

  if (videoChunkCount === 0) {
    sessionVideo.classList.add("is-hidden");
    setVideoStatusLine("No video chunks for this session yet.");
    return;
  }

  sessionVideo.classList.remove("is-hidden");
  setVideoStatusLine("Loading recording…");

  const url = recordingUrlForSession(sessionId);
  sessionVideo.src = url;

  sessionVideo.onerror = () => {
    setVideoStatusLine(
      "Recording unavailable (404: no chunks on server yet, merge failed, or wrong API base).",
    );
    sessionVideo.classList.add("is-hidden");
  };

  const clearLoadingHint = () => {
    setVideoStatusLine("");
    sessionVideo.onloadeddata = null;
    sessionVideo.oncanplay = null;
  };
  sessionVideo.onloadeddata = clearLoadingHint;
  sessionVideo.oncanplay = clearLoadingHint;
  sessionVideo.onloadedmetadata = updateSubDuration;
}

/**
 * @param {number} sec
 */
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * @param {number} sec
 */
function formatTranscriptTs(sec) {
  return formatDuration(sec);
}

/** Millisecond range from model, e.g. `0-128140 ms`. */
const MOMENT_MS_RANGE_RE = /^\s*(\d+)\s*-\s*(\d+)\s*ms\s*$/i;
/** Seconds range per evaluation schema, e.g. `120-165` (start_sec-end_sec). */
const MOMENT_SEC_RANGE_RE = /^\s*(\d+)\s*-\s*(\d+)\s*$/;

/**
 * @param {string} raw
 * @returns {{ startMs: number; endMs: number } | null}
 */
function parseMomentMsRange(raw) {
  const s = raw.trim();
  const mMs = s.match(MOMENT_MS_RANGE_RE);
  if (mMs) {
    const startMs = Number.parseInt(mMs[1], 10);
    const endMs = Number.parseInt(mMs[2], 10);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return null;
    }
    return { startMs, endMs };
  }
  const mSec = s.match(MOMENT_SEC_RANGE_RE);
  if (mSec) {
    const startSec = Number.parseInt(mSec[1], 10);
    const endSec = Number.parseInt(mSec[2], 10);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      return null;
    }
    return { startMs: startSec * 1000, endMs: endSec * 1000 };
  }
  return null;
}

/**
 * @param {number} ms
 */
function formatEvidenceClock(ms) {
  const t = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * @param {string} raw
 */
function formatMomentTimeRangeDisplay(raw) {
  const s = raw.trim();
  if (!s) {
    return "—";
  }
  const parsed = parseMomentMsRange(s);
  if (!parsed) {
    return s;
  }
  const a = formatDuration(Math.floor(Math.max(0, parsed.startMs) / 1000));
  const b = formatDuration(Math.floor(Math.max(0, parsed.endMs) / 1000));
  return `${a} – ${b}`;
}

function clearTranscriptSeekHighlight() {
  if (transcriptSeekHighlightEl) {
    transcriptSeekHighlightEl.classList.remove("is-seek-highlight");
    transcriptSeekHighlightEl = null;
  }
}

/**
 * @param {number} ms
 * @returns {HTMLElement | null}
 */
function findTranscriptLineForMs(ms) {
  if (!transcriptLines) {
    return null;
  }
  const lines = transcriptLines.querySelectorAll("p.sess-trans-line[data-start-ms]");
  if (lines.length === 0) {
    return null;
  }
  /** @type {HTMLElement | null} */
  let bestInside = null;
  for (const el of lines) {
    if (!(el instanceof HTMLElement)) {
      continue;
    }
    const start = Number(el.dataset.startMs);
    const end = Number(el.dataset.endMs ?? el.dataset.startMs);
    if (Number.isFinite(start) && Number.isFinite(end) && ms >= start && ms <= end) {
      bestInside = el;
      break;
    }
  }
  if (bestInside) {
    return bestInside;
  }
  /** @type {HTMLElement | null} */
  let best = null;
  let bestDist = Infinity;
  for (const el of lines) {
    if (!(el instanceof HTMLElement)) {
      continue;
    }
    const start = Number(el.dataset.startMs);
    const end = Number(el.dataset.endMs ?? el.dataset.startMs);
    if (!Number.isFinite(start)) {
      continue;
    }
    const endClamped = Number.isFinite(end) ? end : start;
    const dist = ms < start ? start - ms : ms > endClamped ? ms - endClamped : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }
  return best;
}

/**
 * Seeks the session video and highlights the nearest transcript segment.
 * @param {number} ms
 */
function seekToRecordingTimeMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return;
  }
  const sec = ms / 1000;
  if (sessionVideo && !sessionVideo.classList.contains("is-hidden")) {
    try {
      sessionVideo.currentTime = sec;
    } catch {
      /* ignore */
    }
  }
  clearTranscriptSeekHighlight();
  const line = findTranscriptLineForMs(ms);
  if (line) {
    line.classList.add("is-seek-highlight");
    transcriptSeekHighlightEl = line;
    sessTranscriptCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    line.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/**
 * @param {string} iso
 */
function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max) {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function clearDimensionsMount() {
  sessDimensionsBody?.replaceChildren();
  sessDimensionsMount?.classList.add("hidden");
}

function clearFeedbackLayoutMounts() {
  sessMissedPairMount?.replaceChildren();
  sessMissedPairMount?.classList.add("hidden");
  sessExtendedEvalMount?.replaceChildren();
  sessExtendedEvalMount?.classList.add("hidden");
}

function disconnectPostProcessWebSocketOnly() {
  if (postProcessWebSocket) {
    try {
      postProcessWebSocket.close();
    } catch {
      /* ignore */
    }
    postProcessWebSocket = null;
  }
}

function clearPostProcessPoll() {
  if (postProcessPollTimer) {
    clearInterval(postProcessPollTimer);
    postProcessPollTimer = null;
  }
}

function disconnectPostProcessListeners() {
  disconnectPostProcessWebSocketOnly();
  clearPostProcessPoll();
}

/** Clears the session detail panel and list selection (e.g. after delete). */
function clearSessionDetailUi() {
  selectedSessionId = null;
  for (const el of sessionList?.querySelectorAll(".sess-session-item") ?? []) {
    if (el instanceof HTMLElement) {
      el.classList.remove("is-selected");
    }
  }
  if (detailEmpty) {
    detailEmpty.classList.remove("hidden");
  }
  if (detailWorkspace) {
    detailWorkspace.classList.add("hidden");
  }
  if (breadcrumbSessionId) {
    breadcrumbSessionId.textContent = "—";
  }
  if (footerSessionId) {
    footerSessionId.textContent = "";
  }
  if (detailTitle) {
    detailTitle.textContent = "—";
  }
  if (detailSub) {
    detailSub.textContent = "—";
    delete detailSub.dataset.baseLine;
  }
  updateSessionVideo("", 0);
  if (transcriptLines) {
    transcriptLines.replaceChildren();
  }
  if (transcriptBadge) {
    transcriptBadge.textContent = "—";
  }
  sessMomentCard?.classList.add("hidden");
  momentByMomentLines?.replaceChildren();
  clearDimensionsMount();
  clearFeedbackLayoutMounts();
  document.getElementById("sessTokenMeta")?.remove();
  sessTokenMetaHost?.replaceChildren();
  const qDetails = document.getElementById("sessQuestionDetails");
  const qBody = document.getElementById("detailQuestionBody");
  if (qDetails) {
    qDetails.hidden = true;
  }
  if (qBody) {
    qBody.replaceChildren();
  }
  if (detailPanel) {
    detailPanel.replaceChildren();
  }
}

/**
 * @param {HTMLElement} host
 */
function fillTranscriptSkeleton(host) {
  host.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "sess-skel-stack";
  for (let i = 0; i < 8; i++) {
    const row = document.createElement("div");
    row.className = "sess-skel-line";
    row.style.width = `${62 + (i % 5) * 7}%`;
    wrap.appendChild(row);
  }
  host.appendChild(wrap);
}

function fillMomentSkeleton() {
  if (!momentByMomentLines || !sessMomentCard) {
    return;
  }
  momentByMomentLines.replaceChildren();
  sessMomentCard.classList.remove("hidden");
  const wrap = document.createElement("div");
  wrap.className = "sess-skel-stack sess-skel-stack--tight";
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div");
    row.className = "sess-skel-block sess-skel-block--lg";
    wrap.appendChild(row);
    const row2 = document.createElement("div");
    row2.className = "sess-skel-line";
    row2.style.width = "92%";
    wrap.appendChild(row2);
  }
  momentByMomentLines.appendChild(wrap);
}

/**
 * @param {HTMLElement} inner
 */
function fillFeedbackSkeleton(inner) {
  inner.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "sess-skel-stack";
  const title = document.createElement("div");
  title.className = "sess-skel-block sess-skel-block--title";
  wrap.appendChild(title);
  for (let i = 0; i < 6; i++) {
    const ln = document.createElement("div");
    ln.className = "sess-skel-line";
    ln.style.width = `${72 + (i % 3) * 8}%`;
    wrap.appendChild(ln);
  }
  inner.appendChild(wrap);
}

/**
 * @param {HTMLElement} detailInner
 */
function applyProcessingPlaceholders(detailInner) {
  document.getElementById("sess-video-card")?.classList.add("sess-widget--skeleton");
  sessTranscriptCard?.classList.add("sess-widget--skeleton");
  sessMomentCard?.classList.add("sess-widget--skeleton");
  if (transcriptLines) {
    fillTranscriptSkeleton(transcriptLines);
  }
  fillMomentSkeleton();
  fillFeedbackSkeleton(detailInner);
  clearDimensionsMount();
  clearFeedbackLayoutMounts();
  sessDimensionsBody?.replaceChildren();
  const dimSk = document.createElement("div");
  dimSk.className = "sess-skel-stack";
  for (let i = 0; i < 3; i++) {
    const b = document.createElement("div");
    b.className = "sess-skel-block sess-skel-block--dim";
    dimSk.appendChild(b);
  }
  sessDimensionsBody?.appendChild(dimSk);
  sessDimensionsMount?.classList.remove("hidden");
  sessDimensionsMount?.classList.add("sess-widget--skeleton");
}

function clearProcessingPlaceholders() {
  document.getElementById("sess-video-card")?.classList.remove("sess-widget--skeleton");
  sessTranscriptCard?.classList.remove("sess-widget--skeleton");
  sessMomentCard?.classList.remove("sess-widget--skeleton");
  sessDimensionsMount?.classList.remove("sess-widget--skeleton");
}

/**
 * @param {HTMLElement} detailInner
 * @param {string} text
 */
function setProcessingHint(detailInner, text) {
  let el = detailInner.querySelector(".sess-process-hint");
  if (!el) {
    el = document.createElement("p");
    el.className = "sess-process-hint detail-muted";
    detailInner.insertBefore(el, detailInner.firstChild);
  }
  el.textContent = text;
}

/**
 * @param {HTMLElement} detailInner
 */
function removeProcessingHint(detailInner) {
  detailInner.querySelector(".sess-process-hint")?.remove();
}

/**
 * @param {string} sessionId
 * @param {string} jobId
 * @param {HTMLElement} detailInner
 * @param {typeof window.InterviewCopilotResultView} rv
 * @returns {Promise<{ state: "complete" | "failed" | "processing"; hint?: string }>}
 */
async function loadInterviewPayload(_sessionId, jobId, detailInner, rv) {
  const base = apiBase();
  try {
    const res = await fetch(`${base}/api/interviews/${encodeURIComponent(jobId)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      clearProcessingPlaceholders();
      removeProcessingHint(detailInner);
      clearFeedbackLayoutMounts();
      detailInner.replaceChildren();
      const err =
        typeof body.error === "string"
          ? body.error
          : res.status === 404
            ? "Interview job not found."
            : `HTTP ${res.status}`;
      rv.renderStatusMessage(detailInner, err, true);
      return { state: "failed" };
    }
    const transcripts = Array.isArray(body.speechTranscript)
      ? body.speechTranscript
      : Array.isArray(body.transcripts)
        ? body.transcripts
        : [];

    if (res.status === 200 && body.result != null) {
      clearProcessingPlaceholders();
      removeProcessingHint(detailInner);
      const badge =
        transcripts.length > 0 ? `${transcripts.length} segments` : "Transcript ready";
      clearTranscriptSeekHighlight();
      renderTranscriptPanel(transcripts, body.result, badge);
      renderChronologicalTurningPointsPanel(extractChronologicalTurningPointsFromInterviewBody(body));
      detailInner.replaceChildren();
      rv.renderInterviewGetResponse(detailInner, body, {
        richLayout: true,
        omitInlineTranscriptionMeta: true,
        missedMount: sessMissedPairMount ?? undefined,
        extendedMount: sessExtendedEvalMount ?? undefined,
      });
      moveDimensionsSection(detailInner, sessExtendedEvalMount);
      renderTokenMetaUnderSession(
        /** @type {Record<string, unknown>} */ (body.result),
      );
      return { state: "complete" };
    }

    if (body.status === "FAILED") {
      clearProcessingPlaceholders();
      removeProcessingHint(detailInner);
      clearFeedbackLayoutMounts();
      const badge =
        transcripts.length > 0 ? `${transcripts.length} segments` : "—";
      clearTranscriptSeekHighlight();
      renderTranscriptPanel(transcripts, body.result, badge);
      renderChronologicalTurningPointsPanel([]);
      detailInner.replaceChildren();
      rv.renderStatusMessage(
        detailInner,
        typeof body.errorMessage === "string"
          ? body.errorMessage
          : typeof body.message === "string"
            ? body.message
            : "Processing failed.",
        true,
      );
      return { state: "failed" };
    }

    return {
      state: "processing",
      hint:
        typeof body.message === "string"
          ? body.message
          : "Still processing merged recording, speech, and evaluation…",
    };
  } catch (e) {
    clearProcessingPlaceholders();
    removeProcessingHint(detailInner);
    clearFeedbackLayoutMounts();
    detailInner.replaceChildren();
    rv.renderStatusMessage(detailInner, e instanceof Error ? e.message : String(e), true);
    return { state: "failed" };
  }
}

/**
 * @param {string} sessionId
 * @param {string} jobId
 * @param {HTMLElement} detailInner
 * @param {typeof window.InterviewCopilotResultView} rv
 */
function startPostProcessPollFallback(sessionId, jobId, detailInner, rv) {
  clearPostProcessPoll();
  /** @type {string} */
  let jid = typeof jobId === "string" ? jobId.trim() : "";
  let ticks = 0;
  postProcessPollTimer = setInterval(() => {
    ticks += 1;
    if (ticks > 120) {
      clearPostProcessPoll();
      return;
    }
    void (async () => {
      if (selectedSessionId !== sessionId) {
        return;
      }
      if (!jid) {
        jid = await resolvePostProcessJobIdFromSession(sessionId);
        if (jid) {
          syncListRowPostProcessJob(sessionId, jid);
        }
      }
      if (!jid) {
        return;
      }
      const out = await loadInterviewPayload(sessionId, jid, detailInner, rv);
      if (out.state === "complete" || out.state === "failed") {
        clearPostProcessPoll();
        disconnectPostProcessWebSocketOnly();
      }
    })();
  }, 4000);
}

/**
 * @param {string} sessionId
 * @param {string} jobId
 * @param {HTMLElement} detailInner
 * @param {typeof window.InterviewCopilotResultView} rv
 */
function wirePostProcessStream(sessionId, jobId, detailInner, rv) {
  clearPostProcessPoll();
  disconnectPostProcessWebSocketOnly();
  const httpBase = apiBase();
  const wsBase = httpBase.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const url = `${wsBase}/api/live-sessions/${encodeURIComponent(sessionId)}/post-process-events`;
  /** @type {string} */
  let jobIdRef = typeof jobId === "string" ? jobId.trim() : "";
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    startPostProcessPollFallback(sessionId, jobIdRef, detailInner, rv);
    return;
  }
  postProcessWebSocket = ws;
  ws.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!data || data.type !== "post_process") {
      return;
    }
    if (data.phase === "deleted") {
      disconnectPostProcessListeners();
      if (selectedSessionId === sessionId) {
        clearSessionDetailUi();
      }
      void fetchSessions();
      return;
    }
    if (selectedSessionId !== sessionId) {
      return;
    }
    if (data.phase === "processing" && typeof data.jobId === "string") {
      jobIdRef = data.jobId;
      syncListRowPostProcessJob(sessionId, data.jobId);
    }
    if (data.phase === "complete" && typeof data.jobId === "string") {
      syncListRowPostProcessJob(sessionId, data.jobId);
      void loadInterviewPayload(sessionId, data.jobId, detailInner, rv).then((out) => {
        if (out.state === "complete") {
          disconnectPostProcessListeners();
        }
      });
    }
    if (data.phase === "failed" && typeof data.jobId === "string") {
      disconnectPostProcessListeners();
      clearProcessingPlaceholders();
      removeProcessingHint(detailInner);
      clearFeedbackLayoutMounts();
      detailInner.replaceChildren();
      rv.renderStatusMessage(
        detailInner,
        typeof data.errorMessage === "string" && data.errorMessage.trim()
          ? data.errorMessage
          : "Processing failed.",
        true,
      );
    }
    if (data.phase === "error") {
      disconnectPostProcessWebSocketOnly();
      startPostProcessPollFallback(sessionId, jobIdRef, detailInner, rv);
    }
  });
  ws.addEventListener("error", () => {
    disconnectPostProcessWebSocketOnly();
    startPostProcessPollFallback(sessionId, jobIdRef, detailInner, rv);
  });
}

/**
 * Fetches full session `question` (list API only exposes a short preview).
 * @param {string} sessionId
 */
async function loadSessionQuestion(sessionId) {
  const details = document.getElementById("sessQuestionDetails");
  const bodyEl = document.getElementById("detailQuestionBody");
  if (!details || !bodyEl) {
    return;
  }
  details.hidden = true;
  bodyEl.replaceChildren();
  const base = apiBase();
  try {
    const res = await fetch(`${base}/api/live-sessions/${encodeURIComponent(sessionId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return;
    }
    const q = typeof data.question === "string" ? data.question.trim() : "";
    if (!q) {
      return;
    }
    const md = window.InterviewCopilotMarkdown;
    if (md && typeof md.appendMarkdownToElement === "function") {
      md.appendMarkdownToElement(bodyEl, q);
    } else {
      bodyEl.textContent = q;
    }
    details.hidden = false;
  } catch {
    /* ignore */
  }
}

/**
 * When the sessions list was loaded before post-process finished, `data-job-id` on the row is empty.
 * Session detail always includes current {@link postProcessJob} — use it so the detail pane can load results
 * without forcing the user to reload the list and click again.
 * @param {string} sessionId
 * @returns {Promise<string>} job id or ""
 */
async function resolvePostProcessJobIdFromSession(sessionId) {
  const base = apiBase();
  try {
    const res = await fetch(`${base}/api/live-sessions/${encodeURIComponent(sessionId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || typeof data !== "object") {
      return "";
    }
    const pp = data.postProcessJob;
    if (pp && typeof pp === "object" && typeof pp.id === "string") {
      return pp.id.trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * @param {string} sessionId
 * @param {string} jobId
 */
function syncListRowPostProcessJob(sessionId, jobId) {
  if (!sessionList || !jobId) {
    return;
  }
  const esc =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(sessionId) : sessionId;
  const row = sessionList.querySelector(`button.sess-session-item[data-session-id="${esc}"]`);
  if (!(row instanceof HTMLElement)) {
    return;
  }
  row.dataset.jobId = jobId;
  const label = row.querySelector(".sess-job-label");
  if (label) {
    label.textContent = "Has result";
  }
}

/**
 * @param {unknown} v — API `speaker` field
 * @returns {string | null} trimmed label or null if absent
 */
function normalizeTranscriptSpeaker(v) {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * @param {string | null | undefined} raw
 * @returns {string} display text (empty if null — caller uses "—" for unknown)
 */
function transcriptSpeakerLabel(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return "";
  }
  const u = raw.trim().toUpperCase();
  if (u === "INTERVIEWER") {
    return "Interviewer";
  }
  if (u === "INTERVIEWEE") {
    return "Interviewee";
  }
  if (/^SPEAKER_\d+$/i.test(raw.trim())) {
    const n = raw.trim().replace(/^SPEAKER_/i, "");
    return `Speaker ${Number.parseInt(n, 10) + 1}`;
  }
  return raw.trim();
}

/**
 * @param {unknown} transcripts
 * @param {unknown} resultPayload
 * @param {string} fallbackBadge
 */
function renderTranscriptPanel(transcripts, resultPayload, fallbackBadge) {
  if (!transcriptLines) {
    return;
  }
  clearTranscriptSeekHighlight();
  transcriptLines.replaceChildren();

  const parts = [];
  if (resultPayload && typeof resultPayload === "object") {
    const st = /** @type {Record<string, unknown>} */ (resultPayload).stt;
    if (st && typeof st === "object") {
      const o = /** @type {Record<string, unknown>} */ (st);
      if (typeof o.provider === "string") {
        parts.push(o.provider);
      }
      if (typeof o.model === "string") {
        parts.push(o.model);
      }
      if (typeof o.segmentCount === "number") {
        parts.push(`${o.segmentCount} segments`);
      }
    }
  }

  const list = Array.isArray(transcripts) ? transcripts : [];
  const audio = list.filter(
    (t) => t && typeof t === "object" && /** @type {{ source?: string }} */ (t).source === "AUDIO_STT",
  );
  const use = audio.length > 0 ? audio : list;

  const speakerKeys = new Set();
  for (const seg of use) {
    if (!seg || typeof seg !== "object") {
      continue;
    }
    const row = /** @type {Record<string, unknown>} */ (seg);
    const sp = normalizeTranscriptSpeaker(row.speaker);
    if (sp) {
      speakerKeys.add(sp);
    }
  }
  if (speakerKeys.size > 0) {
    parts.push(
      speakerKeys.size === 1 ? `1 speaker label` : `${speakerKeys.size} speaker labels`,
    );
  } else if (use.length > 0) {
    parts.push("No speaker diarization");
  }

  if (transcriptBadge) {
    transcriptBadge.textContent = parts.length > 0 ? parts.join(" · ") : fallbackBadge;
  }

  for (const seg of use) {
    if (!seg || typeof seg !== "object") {
      continue;
    }
    const s = /** @type {{ startMs?: number; endMs?: number; text?: string; speaker?: unknown }} */ (seg);
    const startMs = typeof s.startMs === "number" ? s.startMs : 0;
    const endMs = typeof s.endMs === "number" ? s.endMs : startMs;
    const startSec = startMs / 1000;
    const rawSpeaker = normalizeTranscriptSpeaker(s.speaker);
    const p = document.createElement("p");
    p.className = "sess-trans-line";
    p.dataset.startMs = String(startMs);
    p.dataset.endMs = String(endMs);
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `${formatTranscriptTs(startSec)}`;
    p.appendChild(ts);
    const spEl = document.createElement("span");
    spEl.className = "sess-trans-speaker";
    if (rawSpeaker) {
      const key = rawSpeaker.toUpperCase().replace(/\s+/g, "_");
      spEl.dataset.speakerKey = key;
      const pretty = transcriptSpeakerLabel(rawSpeaker);
      spEl.textContent = `${pretty || rawSpeaker}:`;
    } else {
      spEl.classList.add("sess-trans-speaker--unknown");
      spEl.textContent = "\u2014";
      spEl.title = "No diarized speaker (enable diarization in post-process or check pipeline.diarization in result JSON)";
    }
    p.appendChild(spEl);
    p.appendChild(document.createTextNode(` \u2014 "${s.text || ""}"`));
    transcriptLines.appendChild(p);
  }

  if (transcriptLines.children.length === 0) {
    const p = document.createElement("p");
    p.className = "detail-muted";
    p.textContent = "No transcript segments yet.";
    transcriptLines.appendChild(p);
  }
}

/**
 * @param {unknown} body — GET /api/interviews/:id JSON
 * @returns {Record<string, unknown>[]}
 */
function extractChronologicalTurningPointsFromInterviewBody(body) {
  if (!body || typeof body !== "object") {
    return [];
  }
  const result = /** @type {Record<string, unknown>} */ (body).result;
  if (!result || typeof result !== "object") {
    return [];
  }
  const evaluation = /** @type {Record<string, unknown>} */ (result).evaluation;
  if (!evaluation || typeof evaluation !== "object") {
    return [];
  }
  const raw =
    evaluation.chronologicalTurningPoints ?? evaluation.chronological_turning_points;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((x) => x && typeof x === "object") /** @type {Record<string, unknown>[]} */;
}

/**
 * @param {Record<string, unknown>[]} items
 */
function renderChronologicalTurningPointsPanel(items) {
  if (!sessMomentCard || !momentByMomentLines) {
    return;
  }
  momentByMomentLines.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    sessMomentCard.classList.add("hidden");
    return;
  }
  sessMomentCard.classList.remove("hidden");
  for (const item of items) {
    const timeRange =
      typeof item.timeRange === "string"
        ? item.timeRange
        : typeof item.time_range === "string"
          ? item.time_range
          : "";
    const phase = typeof item.phase === "string" ? item.phase : "";
    const observation = typeof item.observation === "string" ? item.observation : "";
    const impact = typeof item.impact === "string" ? item.impact : "";
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];

    const article = document.createElement("article");
    article.className = "sess-moment-item";

    const head = document.createElement("div");
    head.className = "sess-moment-item-head";
    const badge = document.createElement("span");
    badge.className = "sess-moment-range";
    badge.textContent = formatMomentTimeRangeDisplay(timeRange);
    const momentParsed = parseMomentMsRange(timeRange);
    if (momentParsed) {
      badge.classList.add("sess-moment-range--seekable");
      badge.dataset.seekStartMs = String(momentParsed.startMs);
      badge.title = "Seek video and transcript to start of this range";
      badge.setAttribute("role", "button");
      badge.tabIndex = 0;
      badge.setAttribute(
        "aria-label",
        `Seek recording to start of range at ${formatEvidenceClock(momentParsed.startMs)}`,
      );
    }
    head.appendChild(badge);
    if (phase.trim()) {
      const ph = document.createElement("span");
      ph.className = "sess-moment-phase";
      ph.textContent = phase.trim();
      head.appendChild(ph);
    }
    article.appendChild(head);

    if (observation) {
      const p = document.createElement("p");
      p.className = "sess-moment-obs";
      p.textContent = observation;
      article.appendChild(p);
    }

    if (evidence.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "sess-moment-evidence sess-moment-evidence--structured";
      for (const row of evidence) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const r = /** @type {Record<string, unknown>} */ (row);
        const quote = typeof r.quote === "string" ? r.quote : "";
        const tms =
          typeof r.timestampMs === "number"
            ? r.timestampMs
            : typeof r.timestamp_ms === "number"
              ? r.timestamp_ms
              : Number.NaN;
        const src = typeof r.source === "string" ? r.source : "";
        if (quote && Number.isFinite(tms)) {
          const li = document.createElement("li");
          li.className = "sess-moment-ev-line";
          const ts = document.createElement("span");
          ts.className = "sess-moment-ev-ts ic-seek-link";
          ts.textContent = `[${formatEvidenceClock(tms)}]`;
          ts.dataset.seekMs = String(Math.round(tms));
          ts.title = "Seek to this time";
          ts.setAttribute("role", "button");
          ts.tabIndex = 0;
          ts.setAttribute("aria-label", `Seek recording to ${formatEvidenceClock(tms)}`);
          const srcSp = document.createElement("span");
          srcSp.className = "sess-moment-ev-src";
          srcSp.textContent = src ? `${src} ` : "";
          li.appendChild(ts);
          li.appendChild(document.createTextNode(" "));
          li.appendChild(srcSp);
          const qSpan = document.createElement("span");
          qSpan.className = "sess-moment-ev-quote";
          qSpan.textContent = quote;
          li.appendChild(qSpan);
          ul.appendChild(li);
        } else if (typeof row === "string" && row.trim()) {
          const li = document.createElement("li");
          li.textContent = row.trim();
          ul.appendChild(li);
        }
      }
      if (ul.children.length > 0) {
        article.appendChild(ul);
      }
    }

    if (impact) {
      const p = document.createElement("p");
      p.className = "sess-moment-meta";
      const strong = document.createElement("strong");
      strong.textContent = "💥 Impact: ";
      p.appendChild(strong);
      p.appendChild(document.createTextNode(impact));
      article.appendChild(p);
    }

    momentByMomentLines.appendChild(article);
  }
}

/**
 * @param {unknown} sessions
 */
function renderSessionList(sessions) {
  if (!sessionList) {
    return;
  }
  sessionList.replaceChildren();
  if (sessionCountBadge) {
    sessionCountBadge.textContent = Array.isArray(sessions) ? `${sessions.length} total` : "0 total";
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    const div = document.createElement("div");
    div.className = "sess-empty-list";
    div.textContent = "No sessions found.";
    sessionList.appendChild(div);
    updateBulkDeleteToolbar();
    return;
  }

  for (const s of sessions) {
    if (!s || typeof s !== "object") {
      continue;
    }
    const sess = /** @type {Record<string, unknown>} */ (s);
    const id = typeof sess.id === "string" ? sess.id : "";
    if (!id) {
      continue;
    }
    const job = sess.postProcessJob && typeof sess.postProcessJob === "object"
      ? /** @type {Record<string, unknown>} */ (sess.postProcessJob)
      : null;
    const jobId = job && typeof job.id === "string" ? job.id : "";
    const jobStatus = job && typeof job.status === "string" ? job.status : "";
    const status = typeof sess.status === "string" ? sess.status : "—";
    const updatedAt = typeof sess.updatedAt === "string" ? sess.updatedAt : "";
    const preview = typeof sess.questionPreview === "string" ? sess.questionPreview.trim() : "";
    const videoChunkCount =
      typeof sess.videoChunkCount === "number" && Number.isFinite(sess.videoChunkCount)
        ? sess.videoChunkCount
        : 0;
    const titleText = preview || truncate(id, 36) || "Session";

    const rowEl = document.createElement("div");
    rowEl.className = "sess-session-row";

    const checkWrap = document.createElement("div");
    checkWrap.className = "sess-session-row-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "sess-session-select-cb";
    cb.dataset.sessionId = id;
    cb.setAttribute("aria-label", `Select session ${truncate(id, 14)} for bulk delete`);
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    checkWrap.appendChild(cb);
    rowEl.appendChild(checkWrap);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sess-session-item";
    btn.dataset.sessionId = id;
    btn.dataset.jobId = jobId;
    btn.dataset.jobStatus = jobStatus;
    btn.dataset.videoChunks = String(videoChunkCount);
    btn.dataset.preview = preview;
    btn.dataset.updatedAt = updatedAt;
    btn.dataset.status = status;
    if (id === selectedSessionId) {
      btn.classList.add("is-selected");
    }

    const h = document.createElement("div");
    h.className = "sess-session-title";
    h.textContent = titleText;

    const meta = document.createElement("div");
    meta.className = "sess-session-meta";
    const spanD = document.createElement("span");
    spanD.textContent = fmtTime(updatedAt);
    const spanDur = document.createElement("span");
    spanDur.style.display = "flex";
    spanDur.style.alignItems = "center";
    spanDur.style.gap = "4px";
    const ic = document.createElement("span");
    ic.className = "material-icons-round";
    ic.textContent = "timer";
    ic.setAttribute("aria-hidden", "true");
    const jobLabel = document.createElement("span");
    jobLabel.className = "sess-job-label";
    jobLabel.textContent = jobId ? "Has result" : "—";
    spanDur.appendChild(ic);
    spanDur.appendChild(jobLabel);

    meta.appendChild(spanD);
    meta.appendChild(spanDur);
    btn.appendChild(h);
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      void selectSession(id, jobId, videoChunkCount, preview, updatedAt, status, jobStatus);
    });

    rowEl.appendChild(btn);
    sessionList.appendChild(rowEl);
  }
  updateBulkDeleteToolbar();
}

async function fetchSessions() {
  setListStatus("Loading…", false);
  await saveApiBase();
  const base = apiBase();
  const res = await fetch(`${base}/api/live-sessions`);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `HTTP ${res.status}`;
    setListStatus(err, true);
    renderSessionList([]);
    return;
  }
  if (!Array.isArray(data)) {
    setListStatus("Unexpected response (not an array).", true);
    renderSessionList([]);
    return;
  }
  setListStatus(`${data.length} session(s).`, false);
  renderSessionList(data);
  selectSessionFromQueryIfPresent();
}

/**
 * @param {string} sessionId
 * @param {{ silent?: boolean }} [opts]
 * @returns {Promise<"ok" | "missing" | "error">}
 */
async function deleteLiveSessionOnServer(sessionId, opts = {}) {
  const silent = Boolean(opts.silent);
  const base = apiBase();
  const res = await fetch(`${base}/api/live-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (res.status === 404) {
    if (!silent) {
      setListStatus("Session already removed (not found on server).", true);
    }
    return "missing";
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body === "object" && typeof body.error === "string") {
        msg = body.error;
      }
    } catch {
      /* ignore */
    }
    if (!silent) {
      setListStatus(msg, true);
    }
    return "error";
  }
  return "ok";
}

function getCheckedSessionIds() {
  if (!sessionList) {
    return [];
  }
  const out = [];
  for (const el of sessionList.querySelectorAll("input.sess-session-select-cb:checked")) {
    if (el instanceof HTMLInputElement) {
      const id = typeof el.dataset.sessionId === "string" ? el.dataset.sessionId.trim() : "";
      if (id) {
        out.push(id);
      }
    }
  }
  return out;
}

function updateBulkDeleteToolbar() {
  const ids = getCheckedSessionIds();
  const n = ids.length;
  if (btnBulkDeleteSessions) {
    btnBulkDeleteSessions.disabled = n === 0;
  }
  if (bulkDeleteLabel) {
    bulkDeleteLabel.textContent = n === 0 ? "Delete selected" : `Delete selected (${n})`;
  }
}

/**
 * If the URL has `?session=<id>`, select that row after the list renders and drop the query param.
 */
function selectSessionFromQueryIfPresent() {
  let want = "";
  try {
    want = (new URLSearchParams(window.location.search).get("session") || "").trim();
  } catch {
    return;
  }
  if (!want || !sessionList) {
    return;
  }
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(want) : want;
  const btn = sessionList.querySelector(`button.sess-session-item[data-session-id="${escaped}"]`);
  if (!(btn instanceof HTMLButtonElement)) {
    setListStatus(
      `Session ${truncate(want, 14)}… not in this list — click Load sessions to refresh.`,
      true,
    );
    return;
  }
  const id = btn.dataset.sessionId ?? "";
  const jobId = btn.dataset.jobId ?? "";
  const jobStatus = btn.dataset.jobStatus ?? "";
  const rawChunks = btn.dataset.videoChunks ?? "0";
  const videoChunkCount = Number.parseInt(rawChunks, 10);
  const preview = btn.dataset.preview ?? "";
  const updatedAt = btn.dataset.updatedAt ?? "";
  const status = btn.dataset.status ?? "—";
  void selectSession(
    id,
    jobId,
    Number.isFinite(videoChunkCount) ? videoChunkCount : 0,
    preview,
    updatedAt,
    status,
    jobStatus,
  );

  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("session");
    const qs = u.searchParams.toString();
    history.replaceState({}, "", u.pathname + (qs ? `?${qs}` : ""));
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement} inner
 */
/**
 * @param {HTMLElement} inner
 * @param {HTMLElement | null | undefined} [extendedRoot]
 */
function moveDimensionsSection(inner, extendedRoot) {
  clearDimensionsMount();
  const dimSec =
    inner.querySelector("#ic-dimensions-section") ||
    (extendedRoot && extendedRoot.querySelector("#ic-dimensions-section"));
  if (dimSec && sessDimensionsBody && sessDimensionsMount) {
    sessDimensionsBody.appendChild(dimSec);
    sessDimensionsMount.classList.remove("hidden");
  }
}

/**
 * @param {string} sessionId
 * @param {string} jobId
 * @param {number} videoChunkCount
 * @param {string} preview
 * @param {string} updatedAt
 * @param {string} sessionStatus
 * @param {string} jobStatus
 */
async function selectSession(
  sessionId,
  jobId,
  videoChunkCount,
  preview,
  updatedAt,
  sessionStatus,
  jobStatus,
) {
  disconnectPostProcessListeners();
  selectedSessionId = sessionId;
  clearDimensionsMount();
  clearFeedbackLayoutMounts();

  for (const el of sessionList?.querySelectorAll(".sess-session-item") ?? []) {
    if (el instanceof HTMLElement) {
      el.classList.toggle("is-selected", el.dataset.sessionId === sessionId);
    }
  }

  if (detailEmpty) {
    detailEmpty.classList.add("hidden");
  }
  if (detailWorkspace) {
    detailWorkspace.classList.remove("hidden");
  }

  if (breadcrumbSessionId) {
    breadcrumbSessionId.textContent = truncate(sessionId, 28);
  }
  if (footerSessionId) {
    footerSessionId.textContent = `ID: ${truncate(sessionId, 20)}`;
  }
  if (detailTitle) {
    detailTitle.textContent = preview.trim() ? truncate(preview, 120) : "Live session";
  }
  const baseLine = `${fmtTime(updatedAt)} · ${videoChunkCount > 0 ? "Recording available" : "No recording yet"}`;
  if (detailSub) {
    detailSub.textContent = baseLine;
    detailSub.dataset.baseLine = baseLine;
  }
  document.getElementById("sessTokenMeta")?.remove();
  sessTokenMetaHost?.replaceChildren();

  void loadSessionQuestion(sessionId);

  updateSessionVideo(sessionId, videoChunkCount);
  if (transcriptLines) {
    transcriptLines.replaceChildren();
  }
  if (transcriptBadge) {
    transcriptBadge.textContent = "—";
  }
  sessMomentCard?.classList.add("hidden");
  if (momentByMomentLines) {
    momentByMomentLines.replaceChildren();
  }

  if (!detailPanel) {
    return;
  }

  const rv = window.InterviewCopilotResultView;
  if (!rv) {
    clearFeedbackLayoutMounts();
    detailPanel.replaceChildren();
    const p = document.createElement("p");
    p.className = "detail-err";
    p.textContent = "resultView.js failed to load.";
    detailPanel.appendChild(p);
    return;
  }

  detailPanel.replaceChildren();
  const detailInner = document.createElement("div");
  detailPanel.appendChild(detailInner);

  const isEnded = sessionStatus === "ENDED";
  const js = typeof jobStatus === "string" ? jobStatus : "";

  let effectiveJobId = typeof jobId === "string" ? jobId.trim() : "";
  if (!effectiveJobId) {
    const p = document.createElement("p");
    p.className = "detail-muted";
    p.textContent = "Checking for post-process job…";
    detailInner.appendChild(p);
    effectiveJobId = await resolvePostProcessJobIdFromSession(sessionId);
    clearFeedbackLayoutMounts();
    detailInner.replaceChildren();
    if (effectiveJobId) {
      syncListRowPostProcessJob(sessionId, effectiveJobId);
    }
  }

  if (!effectiveJobId) {
    if (isEnded) {
      applyProcessingPlaceholders(detailInner);
      setProcessingHint(
        detailInner,
        "Waiting for post-process job to start… Results appear here when processing finishes.",
      );
      wirePostProcessStream(sessionId, "", detailInner, rv);
    } else {
      const p = document.createElement("p");
      p.className = "detail-muted";
      p.textContent =
        "No post-process job for this session yet. End the session from the recorder side panel to start processing.";
      detailInner.appendChild(p);
    }
    return;
  }

  const likelyProcessing = isEnded && (js === "PROCESSING" || js === "PENDING");

  if (likelyProcessing) {
    applyProcessingPlaceholders(detailInner);
    setProcessingHint(detailInner, "Processing merged recording, speech, and evaluation…");
  }

  const out = await loadInterviewPayload(sessionId, effectiveJobId, detailInner, rv);
  if (out.state === "complete" || out.state === "failed") {
    disconnectPostProcessListeners();
    return;
  }

  if (out.state === "processing") {
    if (!likelyProcessing) {
      applyProcessingPlaceholders(detailInner);
    }
    setProcessingHint(detailInner, out.hint || "Still processing…");
    if (isEnded) {
      wirePostProcessStream(sessionId, effectiveJobId, detailInner, rv);
    }
  }
}

/**
 * Render token-usage metadata just below the interview question block (small type).
 * @param {Record<string, unknown>} payload — Result.payload from the API
 */
function renderTokenMetaUnderSession(payload) {
  const existing = document.getElementById("sessTokenMeta");
  if (existing) existing.remove();

  if (!payload || typeof payload !== "object") return;

  const evaluation =
    payload.evaluation && typeof payload.evaluation === "object"
      ? /** @type {Record<string, unknown>} */ (payload.evaluation)
      : null;
  const evalUsage =
    evaluation && evaluation.tokenUsage && typeof evaluation.tokenUsage === "object"
      ? /** @type {Record<string, unknown>} */ (evaluation.tokenUsage)
      : null;

  if (!evalUsage) return;

  /** @param {Record<string, unknown>} u @param {string} k */
  function n(u, k) {
    const v = u[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }

  /** @param {string} label @param {Record<string, unknown>} usage */
  function line(label, usage) {
    const inp = n(usage, "inputTokens");
    const out = n(usage, "outputTokens");
    const total = n(usage, "totalTokens") || inp + out;
    let s = `${label}  ·  in ${inp.toLocaleString()}  ·  out ${out.toLocaleString()}  ·  total ${total.toLocaleString()}`;
    const cached = n(usage, "cachedTokens");
    if (cached > 0) s += `  (${cached.toLocaleString()} cached)`;
    const reasoning = n(usage, "reasoningTokens");
    if (reasoning > 0) s += `  (${reasoning.toLocaleString()} reasoning)`;
    return s;
  }

  const wrap = document.createElement("div");
  wrap.id = "sessTokenMeta";
  wrap.className = "ic-token-meta";

  if (evalUsage) {
    const model = evaluation && typeof evaluation.model === "string" ? evaluation.model : null;
    const provider = evaluation && typeof evaluation.provider === "string" ? evaluation.provider : "";
    const label = model ? `${provider}/${model}` : "Evaluation";

    const span = document.createElement("span");
    span.className = "ic-token-meta-line";
    span.textContent = line(label, evalUsage);
    wrap.appendChild(span);
  }

  if (sessTokenMetaHost) {
    sessTokenMetaHost.appendChild(wrap);
  } else if (detailSub) {
    detailSub.after(wrap);
  }
}

function setFooterActive(which) {
  footJumpVideo?.classList.toggle("is-active", which === "video");
  footJumpTranscript?.classList.toggle("is-active", which === "transcript");
  footJumpDims?.classList.toggle("is-active", which === "dims");
}

/**
 * @param {string} sel
 */
function scrollToSel(sel) {
  const el = document.querySelector(sel);
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

btnSidebarToggle?.addEventListener("click", () => {
  if (!sessSidebar) {
    return;
  }
  const collapsed = !sessSidebar.classList.contains("is-collapsed");
  applySidebarCollapsed(collapsed);
  void chrome.storage.local.set({ sessionsSidebarCollapsed: collapsed });
});

btnLoad?.addEventListener("click", () => {
  void fetchSessions();
});

btnOpenPopup?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});

btnShare?.addEventListener("click", async () => {
  if (!selectedSessionId) {
    return;
  }
  const url = recordingUrlForSession(selectedSessionId);
  try {
    await navigator.clipboard.writeText(url);
    setListStatus("Recording URL copied to clipboard.", false);
    setTimeout(() => setListStatus("", false), 2500);
  } catch {
    setListStatus("Could not copy URL.", true);
  }
});

btnExportPrint?.addEventListener("click", () => {
  window.print();
});

sessionList?.addEventListener("change", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.classList.contains("sess-session-select-cb")) {
    updateBulkDeleteToolbar();
  }
});

btnSelectAllSessions?.addEventListener("click", () => {
  for (const el of sessionList?.querySelectorAll("input.sess-session-select-cb") ?? []) {
    if (el instanceof HTMLInputElement) {
      el.checked = true;
    }
  }
  updateBulkDeleteToolbar();
});

btnClearSessionSelection?.addEventListener("click", () => {
  for (const el of sessionList?.querySelectorAll("input.sess-session-select-cb") ?? []) {
    if (el instanceof HTMLInputElement) {
      el.checked = false;
    }
  }
  updateBulkDeleteToolbar();
});

btnBulkDeleteSessions?.addEventListener("click", () => {
  const ids = getCheckedSessionIds();
  if (ids.length === 0) {
    return;
  }
  const n = ids.length;
  const ok = window.confirm(
    `Permanently delete ${n} session(s)?\n\nThis removes recordings, code snapshots, transcripts, evaluations, and all server files for each session. This cannot be undone.`,
  );
  if (!ok) {
    return;
  }
  void (async () => {
    let deleted = 0;
    let missing = 0;
    let errors = 0;
    for (const id of ids) {
      const outcome = await deleteLiveSessionOnServer(id, { silent: true });
      if (outcome === "ok") {
        deleted += 1;
      } else if (outcome === "missing") {
        missing += 1;
      } else {
        errors += 1;
      }
    }
    const clearedSelection = ids.some((id) => id === selectedSessionId);
    if (clearedSelection) {
      disconnectPostProcessListeners();
      clearSessionDetailUi();
    }
    if (errors > 0) {
      setListStatus(`Deleted ${deleted}; ${missing} already gone; ${errors} failed — check API or connection.`, true);
    } else if (missing > 0) {
      setListStatus(`Deleted ${deleted} session(s). ${missing} were already removed.`, false);
    } else {
      setListStatus(`Deleted ${deleted} session(s).`, false);
    }
    await fetchSessions();
  })();
});

footJumpVideo?.addEventListener("click", () => {
  setFooterActive("video");
  scrollToSel("#sess-video-card");
});

footJumpTranscript?.addEventListener("click", () => {
  setFooterActive("transcript");
  scrollToSel("#sess-transcript-card");
});

footJumpDims?.addEventListener("click", () => {
  setFooterActive("dims");
  scrollToSel("#sessDimensionsMount");
});

if (detailWorkspace && !detailWorkspace.dataset.seekDelegationBound) {
  detailWorkspace.dataset.seekDelegationBound = "1";
  /**
   * @param {HTMLElement} el
   */
  function seekFromSeekableElement(el) {
    if (el.dataset.seekMs != null && el.dataset.seekMs !== "") {
      const v = Number(el.dataset.seekMs);
      if (Number.isFinite(v)) {
        seekToRecordingTimeMs(v);
        return true;
      }
    }
    if (el.dataset.seekStartMs != null && el.dataset.seekStartMs !== "") {
      const v = Number(el.dataset.seekStartMs);
      if (Number.isFinite(v)) {
        seekToRecordingTimeMs(v);
        return true;
      }
    }
    return false;
  }
  detailWorkspace.addEventListener("click", (e) => {
    const seekHit = e.target.closest("[data-seek-ms], [data-seek-start-ms]");
    if (seekHit instanceof HTMLElement) {
      seekFromSeekableElement(seekHit);
    }
  });
  detailWorkspace.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") {
      return;
    }
    const seekHit = e.target.closest("[data-seek-ms], [data-seek-start-ms]");
    if (!(seekHit instanceof HTMLElement) || !detailWorkspace.contains(seekHit)) {
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
    }
    seekFromSeekableElement(seekHit);
  });
}

void loadSettings().then(() => {
  void fetchSessions();
});
