/**
 * Toolbar action is only enabled on LeetCode tabs so the extension is "active" there only.
 * Tab capture + MediaRecorder run entirely in the side panel (same renderer as getMediaStreamId).
 */

const LEETCODE_URL_RE = /^https:\/\/([a-z0-9-]+\.)*leetcode\.com\//i;

function syncActionForTab(tabId, url) {
  if (typeof url !== "string" || !LEETCODE_URL_RE.test(url)) {
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
