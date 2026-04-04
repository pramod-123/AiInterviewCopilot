const DEFAULT_API = "http://127.0.0.1:3001";

const LEETCODE_URL_RE = /^https:\/\/([a-z0-9-]+\.)*leetcode\.com\//i;

const MIC_HINT =
  "Chrome: Settings → Privacy → Site settings → Microphone → allow this extension. Or click the extension icon → Site settings.";

/**
 * Side panels often get NotAllowedError / “Permission dismissed” for getUserMedia.
 * Requesting here (toolbar popup) uses a gesture Chrome accepts; tracks are stopped immediately.
 * @returns {Promise<boolean>}
 */
async function ensureMicAllowedInExtension() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
    },
    video: false,
  });
  for (const t of stream.getTracks()) {
    t.stop();
  }
  return true;
}

function setStatus(text, isError) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text;
    el.className = isError ? "err" : "";
  }
  const dot = document.getElementById("statusDot");
  const hero = document.getElementById("heroTitle");
  const sub = document.getElementById("heroSub");
  const working = Boolean(text?.trim()) && !isError;
  dot?.classList.toggle("busy", working);
  if (hero) {
    hero.textContent = isError ? "Issue" : working ? "Working" : "Ready";
  }
  if (sub) {
    sub.textContent = isError
      ? "See details below"
      : working
        ? "Processing…"
        : "LeetCode capture • Standby";
  }
}

async function loadSettings() {
  const { apiBase, preferRecordMic, preferLiveInterviewer } = await chrome.storage.local.get([
    "apiBase",
    "preferRecordMic",
    "preferLiveInterviewer",
  ]);
  const baseEl = document.getElementById("apiBase");
  if (baseEl) {
    baseEl.value = apiBase || DEFAULT_API;
  }
  const chk = document.getElementById("chkPopupMic");
  if (chk && typeof preferRecordMic === "boolean") {
    chk.checked = preferRecordMic;
  }
  const chkLive = document.getElementById("chkPopupLiveInterviewer");
  if (chkLive && typeof preferLiveInterviewer === "boolean") {
    chkLive.checked = preferLiveInterviewer;
  }
}

document.getElementById("start").addEventListener("click", async () => {
  const rawBase = document.getElementById("apiBase")?.value ?? "";
  const apiBase = rawBase.trim().replace(/\/$/, "") || DEFAULT_API;
  const wantMic = document.getElementById("chkPopupMic")?.checked !== false;
  const liveInterviewerEnabled =
    document.getElementById("chkPopupLiveInterviewer")?.checked !== false;
  await chrome.storage.local.set({
    apiBase,
    preferRecordMic: wantMic,
    preferLiveInterviewer: liveInterviewerEnabled,
  });
  setStatus("Creating session…");

  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = active?.id;
    const url = active?.url || "";
    if (tabId == null || !LEETCODE_URL_RE.test(url)) {
      setStatus("Open this popup from a leetcode.com problem tab (icon is enabled only there).", true);
      return;
    }

    if (wantMic) {
      setStatus("Microphone — choose Allow in the prompt…");
      try {
        await ensureMicAllowedInExtension();
      } catch (e) {
        const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(
          `Microphone: ${msg}${name ? ` (${name})` : ""}. ${MIC_HINT} You can uncheck “Record my microphone” and start tab-only.`,
          true,
        );
        return;
      }
    }

    setStatus("Creating session…");
    const res = await fetch(`${apiBase}/api/live-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ liveInterviewerEnabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `HTTP ${res.status}`, true);
      return;
    }
    const sessionId = data.id;
    if (!sessionId) {
      setStatus("Unexpected response (no session id).", true);
      return;
    }

    if (typeof chrome.sidePanel?.open !== "function") {
      setStatus("Side panel API missing — use Chrome 114+.", true);
      return;
    }

    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId == null) {
      setStatus("Could not read window for this tab.", true);
      return;
    }

    await chrome.storage.session.set({
      pendingRecorder: { sessionId, apiBase, tabId, liveInterviewerEnabled },
    });

    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });

    await chrome.sidePanel.open({ windowId: tab.windowId });

    setStatus("Side panel opened — use it to start recording.");
    window.close();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
});

document.getElementById("openSessions")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") });
  window.close();
});

document.getElementById("btnSettings")?.addEventListener("click", () => {
  const panel = document.getElementById("settingsPanel");
  const btn = document.getElementById("btnSettings");
  panel?.classList.toggle("hidden");
  const open = panel && !panel.classList.contains("hidden");
  btn?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    document.getElementById("apiBase")?.focus();
  }
});

document.getElementById("btnHelp")?.addEventListener("click", () => {
  const panel = document.getElementById("helpPanel");
  const btn = document.getElementById("btnHelp");
  panel?.classList.toggle("hidden");
  const open = panel && !panel.classList.contains("hidden");
  btn?.setAttribute("aria-expanded", open ? "true" : "false");
});

void loadSettings();
