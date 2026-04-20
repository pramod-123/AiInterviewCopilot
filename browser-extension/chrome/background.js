/**
 * Toolbar action is enabled on supported practice / contest sites only.
 * Tab capture + MediaRecorder run entirely in the side panel (same renderer as getMediaStreamId).
 */
importScripts("platformUrls.js");

const LEETCODE_TAB_URL_PATTERNS = ["https://leetcode.com/*", "https://*.leetcode.com/*"];

/** Prefer a tab on a `/problems/…` URL for capture; fall back to any LeetCode tab. */
function tabLooksLikeLeetCodeProblem(url) {
  return typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)*leetcode\.com\/problems\//i.test(url);
}

function syncActionForTab(tabId, url) {
  if (typeof url !== "string" || !ICIsPracticeSiteUrl(url)) {
    void chrome.action.disable(tabId);
  } else {
    void chrome.action.enable(tabId);
  }
}

function syncAllTabs() {
  void chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null && tab.url) {
        syncActionForTab(tab.id, tab.url);
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  syncAllTabs();
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
});

chrome.runtime.onStartup.addListener(() => {
  syncAllTabs();
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab.url;
  if (url) {
    syncActionForTab(tabId, url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      syncActionForTab(activeInfo.tabId, tab.url);
    }
  } catch {
    /* tab may have closed */
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "IC_PREPARE_NEW_INTERVIEW_ON_LEETCODE") {
    return undefined;
  }
  void (async () => {
    try {
      const fromMsg =
        typeof message.apiBase === "string" && message.apiBase.trim()
          ? message.apiBase.trim().replace(/\/$/, "")
          : "";
      const { apiBase: storedBase, preferLiveInterviewer } = await chrome.storage.local.get([
        "apiBase",
        "preferLiveInterviewer",
      ]);
      const apiBase =
        fromMsg ||
        (typeof storedBase === "string" && storedBase.trim() ? storedBase.trim().replace(/\/$/, "") : "") ||
        "http://127.0.0.1:3001";
      const liveInterviewerEnabled =
        typeof preferLiveInterviewer === "boolean" ? preferLiveInterviewer : false;

      const tabs = await chrome.tabs.query({ url: LEETCODE_TAB_URL_PATTERNS });
      const problemTab = tabs.find((t) => tabLooksLikeLeetCodeProblem(t.url || ""));
      const tab = problemTab ?? tabs[0];
      if (!tab?.id || tab.windowId == null) {
        sendResponse({ ok: false, reason: "no_leetcode_tab" });
        return;
      }
      await chrome.storage.session.set({
        pendingRecorder: {
          apiBase,
          tabId: tab.id,
          liveInterviewerEnabled,
        },
      });
      await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
      await chrome.sidePanel.open({ windowId: tab.windowId });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true;
});
