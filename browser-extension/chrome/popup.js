const DEFAULT_API = "http://127.0.0.1:3001";

const MIC_HINT =
  "Chrome: Settings → Privacy → Site settings → Microphone → allow this extension. Or click the extension icon → Site settings.";

const INTERVIEW_API_OFF_HINT =
  "Live interviews are off on this server until API keys, local Whisper, and evaluation settings are complete. Open Sessions → Server settings (gear), fill in the fields, and Save — the server reloads that file without a restart.";

const LIVE_VOICE_NO_KEYS_HINT =
  "Add a Gemini API key in Server config (Sessions or side panel → Settings) to use live voice (Gemini Live).";

const LIVE_VOICE_WRONG_VENDOR_HINT =
  "Set live realtime to Gemini in Server config and add a Gemini API key, or save if the server was still on OpenAI for live voice.";

/**
 * @param {string} apiBase
 */
async function applyInterviewApiGate(apiBase) {
  const banner = document.getElementById("popupInterviewBanner");
  const bannerText = document.getElementById("popupInterviewBannerText");
  const startBtn = document.getElementById("start");
  const chkMic = document.getElementById("chkPopupMic");
  const chkLive = document.getElementById("chkPopupLiveInterviewer");
  if (typeof window.ICFetchPublicAppConfig !== "function" || typeof window.ICLiveRealtimeFromPublicConfig !== "function") {
    return;
  }
  const cfg = await window.ICFetchPublicAppConfig(apiBase);
  const interviewApiEnabled =
    cfg == null || typeof cfg.interviewApiEnabled !== "boolean" ? true : Boolean(cfg.interviewApiEnabled);
  const lr = window.ICLiveRealtimeFromPublicConfig(cfg);

  if (!interviewApiEnabled) {
    banner?.classList.remove("hidden");
    if (bannerText) {
      const fromServer =
        cfg && typeof cfg.interviewApiDisableReason === "string" && cfg.interviewApiDisableReason.trim()
          ? cfg.interviewApiDisableReason.trim()
          : "";
      bannerText.textContent = fromServer
        ? `${fromServer} — Open Sessions → Server settings (gear), Save.`
        : INTERVIEW_API_OFF_HINT;
    }
    if (startBtn) {
      startBtn.disabled = true;
    }
    if (chkMic) {
      chkMic.disabled = true;
    }
    if (chkLive) {
      chkLive.disabled = true;
      chkLive.removeAttribute("title");
    }
    return;
  }

  banner?.classList.add("hidden");
  if (startBtn) {
    startBtn.disabled = false;
  }
  if (chkMic) {
    chkMic.disabled = false;
  }

  if (chkLive) {
    if (!lr.selectedProviderHasKey) {
      chkLive.disabled = true;
      chkLive.checked = false;
      chkLive.setAttribute(
        "title",
        lr.anyRealtimeKey ? LIVE_VOICE_WRONG_VENDOR_HINT : LIVE_VOICE_NO_KEYS_HINT,
      );
    } else {
      chkLive.disabled = false;
      chkLive.removeAttribute("title");
    }
  }
}

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
        : "Practice site capture • Standby";
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
  const chkLiveEl = document.getElementById("chkPopupLiveInterviewer");
  let liveInterviewerEnabled = false;
  if (chkLiveEl && !chkLiveEl.disabled) {
    if (
      typeof window.ICFetchPublicAppConfig === "function" &&
      typeof window.ICLiveRealtimeFromPublicConfig === "function"
    ) {
      const cfg = await window.ICFetchPublicAppConfig(apiBase);
      const lr = window.ICLiveRealtimeFromPublicConfig(cfg);
      liveInterviewerEnabled = Boolean(lr.selectedProviderHasKey && chkLiveEl.checked);
    } else {
      liveInterviewerEnabled = chkLiveEl.checked !== false;
    }
  }
  await chrome.storage.local.set({
    apiBase,
    preferRecordMic: wantMic,
    preferLiveInterviewer: liveInterviewerEnabled,
  });

  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = active?.id;
    const url = active?.url || "";
    if (tabId == null || typeof ICIsPracticeSiteUrl !== "function" || !ICIsPracticeSiteUrl(url)) {
      setStatus(
        "Open this popup from a supported practice tab (LeetCode, HackerRank, Codeforces, AtCoder, CodeChef, TopCoder).",
        true,
      );
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

    setStatus("Opening side panel…");

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
      pendingRecorder: { apiBase, tabId, liveInterviewerEnabled },
    });

    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });

    await chrome.sidePanel.open({ windowId: tab.windowId });

    setStatus("Side panel opened — click Start interview there to create the session.");
    window.close();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
});

function openSessionsTab() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") });
}

document.getElementById("openSessions")?.addEventListener("click", () => {
  openSessionsTab();
  window.close();
});

document.getElementById("popupBannerOpenSessions")?.addEventListener("click", () => {
  openSessionsTab();
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

function syncPopupThemeToggleUi() {
  const btn = document.getElementById("btnPopupTheme");
  if (!btn || typeof window.ICTheme === "undefined") {
    return;
  }
  const dark = window.ICTheme.get() === "dark";
  const icon = btn.querySelector(".material-symbols-outlined");
  if (icon) {
    icon.textContent = dark ? "light_mode" : "dark_mode";
  }
  btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-label", btn.title);
}

document.getElementById("btnPopupTheme")?.addEventListener("click", () => {
  window.ICTheme?.toggle();
  syncPopupThemeToggleUi();
});
document.addEventListener("ic-theme-change", syncPopupThemeToggleUi);
window.addEventListener("storage", (e) => {
  if (e.key === window.ICTheme?.STORAGE_KEY && e.newValue) {
    window.ICTheme?.syncFromStorage();
    syncPopupThemeToggleUi();
  }
});
syncPopupThemeToggleUi();

async function popupRefreshInterviewGateFromApiBase() {
  const rawBase = document.getElementById("apiBase")?.value ?? "";
  const apiBase = rawBase.trim().replace(/\/$/, "") || DEFAULT_API;
  await applyInterviewApiGate(apiBase);
}

void loadSettings().then(() => popupRefreshInterviewGateFromApiBase());

document.getElementById("apiBase")?.addEventListener("change", () => {
  void popupRefreshInterviewGateFromApiBase();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void popupRefreshInterviewGateFromApiBase();
  }
});

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.icRuntimeConfigSavedAt) {
      return;
    }
    void popupRefreshInterviewGateFromApiBase();
  });
}
