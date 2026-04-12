/**
 * Light / dark appearance for extension pages (sessions, side panel, popup).
 * Persists in localStorage under {@link ICTheme.STORAGE_KEY}. Load this script
 * synchronously before stylesheets so the first paint uses the correct theme.
 */
(function () {
  var STORAGE_KEY = "ic-ui-theme";

  function readStored() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === "light" || v === "dark") {
        return v;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function systemPreference() {
    try {
      return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function resolve() {
    return readStored() || systemPreference();
  }

  /**
   * @param {string} theme
   */
  function apply(theme) {
    if (theme !== "light" && theme !== "dark") {
      theme = "dark";
    }
    var root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }

  apply(resolve());

  window.ICTheme = {
    STORAGE_KEY: STORAGE_KEY,
    get: function () {
      return document.documentElement.dataset.theme === "light" ? "light" : "dark";
    },
    /**
     * @param {string} theme
     */
    set: function (theme) {
      if (theme !== "light" && theme !== "dark") {
        return;
      }
      apply(theme);
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch (e) {
        /* ignore */
      }
      try {
        document.dispatchEvent(new CustomEvent("ic-theme-change", { detail: { theme: theme } }));
      } catch (e) {
        /* ignore */
      }
    },
    toggle: function () {
      window.ICTheme.set(window.ICTheme.get() === "dark" ? "light" : "dark");
    },
    /** Re-read localStorage (e.g. after another extension page updated the theme). */
    syncFromStorage: function () {
      var s = readStored();
      if (s === "light" || s === "dark") {
        apply(s);
      }
    },
  };
})();
