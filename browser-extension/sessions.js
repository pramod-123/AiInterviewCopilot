const DEFAULT_API = "http://127.0.0.1:3001";

const apiBaseInput = document.getElementById("apiBase");
const btnLoad = document.getElementById("btnLoad");
const btnOpenPopup = document.getElementById("btnOpenPopup");
const btnShare = document.getElementById("btnShare");
const btnExportPrint = document.getElementById("btnExportPrint");
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
const detailSub = document.getElementById("detailSub");
const footerSessionId = document.getElementById("footerSessionId");
const sessionVideo = document.getElementById("sessionVideo");
const videoStatus = document.getElementById("videoStatus");
const transcriptLines = document.getElementById("transcriptLines");
const transcriptBadge = document.getElementById("transcriptBadge");
const sessDimensionsMount = document.getElementById("sessDimensionsMount");
const sessDimensionsBody = document.getElementById("sessDimensionsBody");
const sessMomentCard = document.getElementById("sess-moment-card");
const momentByMomentLines = document.getElementById("momentByMomentLines");

const footJumpVideo = document.getElementById("footJumpVideo");
const footJumpTranscript = document.getElementById("footJumpTranscript");
const footJumpDims = document.getElementById("footJumpDims");

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

/** Matches model output like `0-128140 ms` or `153040-248480 ms`. */
const MOMENT_MS_RANGE_RE = /^\s*(\d+)\s*-\s*(\d+)\s*(?:ms)?\s*$/i;

/**
 * @param {string} raw
 * @returns {{ startMs: number; endMs: number } | null}
 */
function parseMomentMsRange(raw) {
  const m = raw.trim().match(MOMENT_MS_RANGE_RE);
  if (!m) {
    return null;
  }
  const startMs = Number.parseInt(m[1], 10);
  const endMs = Number.parseInt(m[2], 10);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return { startMs, endMs };
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
  if (transcriptBadge) {
    transcriptBadge.textContent = parts.length > 0 ? parts.join(" · ") : fallbackBadge;
  }

  const list = Array.isArray(transcripts) ? transcripts : [];
  const audio = list.filter(
    (t) => t && typeof t === "object" && /** @type {{ source?: string }} */ (t).source === "AUDIO_STT",
  );
  const use = audio.length > 0 ? audio : list;

  for (const seg of use) {
    if (!seg || typeof seg !== "object") {
      continue;
    }
    const s = /** @type {{ startMs?: number; endMs?: number; text?: string }} */ (seg);
    const startMs = typeof s.startMs === "number" ? s.startMs : 0;
    const endMs = typeof s.endMs === "number" ? s.endMs : startMs;
    const startSec = startMs / 1000;
    const p = document.createElement("p");
    p.className = "sess-trans-line";
    p.dataset.startMs = String(startMs);
    p.dataset.endMs = String(endMs);
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `${formatTranscriptTs(startSec)}`;
    p.appendChild(ts);
    p.appendChild(document.createTextNode(` — "${s.text || ""}"`));
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
function extractMomentByMomentFromInterviewBody(body) {
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
    evaluation.momentByMomentFeedback ?? evaluation.moment_by_moment_feedback;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((x) => x && typeof x === "object") /** @type {Record<string, unknown>[]} */;
}

/**
 * @param {Record<string, unknown>[]} items
 */
function renderMomentByMomentPanel(items) {
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
    const observation = typeof item.observation === "string" ? item.observation : "";
    const impact = typeof item.impact === "string" ? item.impact : "";
    const suggestion = typeof item.suggestion === "string" ? item.suggestion : "";
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((x) => typeof x === "string")
      : [];

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
    }
    head.appendChild(badge);
    article.appendChild(head);

    if (observation) {
      const p = document.createElement("p");
      p.className = "sess-moment-obs";
      p.textContent = observation;
      article.appendChild(p);
    }

    if (evidence.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "sess-moment-evidence";
      for (const line of evidence) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      article.appendChild(ul);
    }

    if (impact) {
      const p = document.createElement("p");
      p.className = "sess-moment-meta";
      const strong = document.createElement("strong");
      strong.textContent = "Impact: ";
      p.appendChild(strong);
      p.appendChild(document.createTextNode(impact));
      article.appendChild(p);
    }

    if (suggestion) {
      const p = document.createElement("p");
      p.className = "sess-moment-meta sess-moment-suggestion";
      const strong = document.createElement("strong");
      strong.textContent = "Suggestion: ";
      p.appendChild(strong);
      p.appendChild(document.createTextNode(suggestion));
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
    return;
  }

  for (const s of sessions) {
    if (!s || typeof s !== "object") {
      continue;
    }
    const row = /** @type {Record<string, unknown>} */ (s);
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) {
      continue;
    }
    const job = row.postProcessJob && typeof row.postProcessJob === "object"
      ? /** @type {Record<string, unknown>} */ (row.postProcessJob)
      : null;
    const jobId = job && typeof job.id === "string" ? job.id : "";
    const status = typeof row.status === "string" ? row.status : "—";
    const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : "";
    const preview = typeof row.questionPreview === "string" ? row.questionPreview.trim() : "";
    const videoChunkCount =
      typeof row.videoChunkCount === "number" && Number.isFinite(row.videoChunkCount)
        ? row.videoChunkCount
        : 0;

    const titleText = preview || truncate(id, 36) || "Session";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sess-session-item";
    btn.dataset.sessionId = id;
    btn.dataset.jobId = jobId;
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
    jobLabel.textContent = jobId ? "Has result" : "—";
    spanDur.appendChild(ic);
    spanDur.appendChild(jobLabel);

    meta.appendChild(spanD);
    meta.appendChild(spanDur);
    btn.appendChild(h);
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      void selectSession(id, jobId, videoChunkCount, preview, updatedAt);
    });

    sessionList.appendChild(btn);
  }
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
  const rawChunks = btn.dataset.videoChunks ?? "0";
  const videoChunkCount = Number.parseInt(rawChunks, 10);
  const preview = btn.dataset.preview ?? "";
  const updatedAt = btn.dataset.updatedAt ?? "";
  void selectSession(id, jobId, Number.isFinite(videoChunkCount) ? videoChunkCount : 0, preview, updatedAt);

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
function moveDimensionsSection(inner) {
  clearDimensionsMount();
  const dimSec = inner.querySelector("#ic-dimensions-section");
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
 */
async function selectSession(sessionId, jobId, videoChunkCount, preview, updatedAt) {
  selectedSessionId = sessionId;
  clearDimensionsMount();

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
  const prevMeta = document.getElementById("sessTokenMeta");
  if (prevMeta) prevMeta.remove();

  void loadSessionQuestion(sessionId);

  updateSessionVideo(sessionId, videoChunkCount);
  renderTranscriptPanel([], null, "—");
  renderMomentByMomentPanel([]);

  if (!detailPanel) {
    return;
  }

  const rv = window.InterviewCopilotResultView;
  if (!rv) {
    detailPanel.replaceChildren();
    const p = document.createElement("p");
    p.className = "detail-err";
    p.textContent = "resultView.js failed to load.";
    detailPanel.appendChild(p);
    return;
  }

  detailPanel.replaceChildren();

  if (!jobId) {
    const p = document.createElement("p");
    p.className = "detail-muted";
    p.textContent =
      "No post-process job for this session yet. End the session from the recorder side panel to start processing.";
    detailPanel.appendChild(p);
    return;
  }

  const inner = document.createElement("div");
  detailPanel.appendChild(inner);
  rv.renderStatusMessage(inner, "Loading interview result…", false);

  const base = apiBase();
  try {
    const res = await fetch(`${base}/api/interviews/${jobId}`);
    const body = await res.json().catch(() => ({}));
    const transcripts = Array.isArray(body.transcripts) ? body.transcripts : [];
    const badge =
      transcripts.length > 0 ? `${transcripts.length} segments` : "Waiting for speech…";
    renderTranscriptPanel(transcripts, body.result, badge);
    renderMomentByMomentPanel(extractMomentByMomentFromInterviewBody(body));

    if (!res.ok) {
      inner.replaceChildren();
      rv.renderStatusMessage(
        inner,
        typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        true,
      );
      return;
    }
    inner.replaceChildren();
    if (res.status === 200 && body.result != null) {
      rv.renderInterviewGetResponse(inner, body, {
        richLayout: true,
        omitInlineTranscriptionMeta: true,
      });
      moveDimensionsSection(inner);
      renderTokenMetaUnderSession(body.result);
      return;
    }
    if (body.status === "FAILED") {
      rv.renderStatusMessage(
        inner,
        typeof body.errorMessage === "string"
          ? body.errorMessage
          : typeof body.message === "string"
            ? body.message
            : "Processing failed.",
        true,
      );
      return;
    }
    const msg =
      typeof body.message === "string" ? body.message : "Still processing… Poll again later.";
    rv.renderStatusMessage(inner, `${msg} (status: ${String(body.status)})`, false);
  } catch (e) {
    inner.replaceChildren();
    rv.renderStatusMessage(inner, e instanceof Error ? e.message : String(e), true);
  }
}

/** Known context windows (tokens) for popular models. */
function contextWindowForModel(model) {
  if (typeof model !== "string") return 0;
  const m = model.toLowerCase();
  if (m.includes("gpt-4o-mini")) return 128000;
  if (m.includes("gpt-4o")) return 128000;
  if (m.includes("gpt-4-turbo")) return 128000;
  if (m.includes("gpt-4")) return 8192;
  if (m.includes("gpt-3.5")) return 16385;
  if (m.includes("o1-mini")) return 128000;
  if (m.includes("o1")) return 200000;
  if (m.includes("o3-mini")) return 200000;
  if (m.includes("o3")) return 200000;
  if (m.includes("claude-3-5-sonnet")) return 200000;
  if (m.includes("claude-3-5-haiku")) return 200000;
  if (m.includes("claude-3-opus")) return 200000;
  if (m.includes("claude-3-sonnet")) return 200000;
  if (m.includes("claude-3-haiku")) return 200000;
  if (m.includes("claude")) return 200000;
  return 0;
}

/**
 * Render faint token-usage metadata below the session subtitle (detailSub).
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

  /** @param {string} label @param {Record<string, unknown>} usage @param {string|null} model */
  function line(label, usage, model) {
    const inp = n(usage, "inputTokens");
    const out = n(usage, "outputTokens");
    const total = n(usage, "totalTokens") || inp + out;
    let s = `${label}  ·  in ${inp.toLocaleString()}  ·  out ${out.toLocaleString()}  ·  total ${total.toLocaleString()}`;
    const cached = n(usage, "cachedTokens");
    if (cached > 0) s += `  (${cached.toLocaleString()} cached)`;
    const reasoning = n(usage, "reasoningTokens");
    if (reasoning > 0) s += `  (${reasoning.toLocaleString()} reasoning)`;
    const ctx = contextWindowForModel(model);
    if (ctx > 0 && total > 0) {
      const pct = ((total / ctx) * 100).toFixed(1);
      s += `  ·  ${pct}% of ${(ctx / 1000).toLocaleString()}k context`;
    }
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
    span.textContent = line(label, evalUsage, model);
    wrap.appendChild(span);
  }

  if (detailSub) {
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
  detailWorkspace.addEventListener("click", (e) => {
    const dimTs = e.target.closest("[data-seek-ms]");
    if (dimTs instanceof HTMLElement) {
      const v = Number(dimTs.dataset.seekMs);
      if (Number.isFinite(v)) {
        seekToRecordingTimeMs(v);
        return;
      }
    }
    const momentBadge = e.target.closest("[data-seek-start-ms]");
    if (momentBadge instanceof HTMLElement) {
      const v = Number(momentBadge.dataset.seekStartMs);
      if (Number.isFinite(v)) {
        seekToRecordingTimeMs(v);
      }
    }
  });
}

void loadSettings().then(() => {
  void fetchSessions();
});
