/**
 * Shared server runtime config UI (API keys, voice bridge, Whisper STT model, evaluation LLM).
 * Mount into any container; uses `data-ic` fields only (no global id collisions).
 */
(function () {
  "use strict";

  var DEFAULT_API = "http://127.0.0.1:3001";

  var TOOLBAR_FULL =
    '<div class="ic-srv-toolbar ac-toolbar">' +
    "<label>API base URL " +
    '<input type="url" data-ic="apiBase" placeholder="http://127.0.0.1:3001" autocomplete="off" />' +
    "</label>" +
    "</div>";

  var MOUNT_SCROLL_OPEN = '<div class="ic-srv-mount-inner"><div class="ic-srv-mount-scroll">';
  var MOUNT_SCROLL_CLOSE =
    '</div><div class="ic-srv-save-footer">' +
    '<button type="button" class="sess-btn sess-btn-primary" data-ic="btnSave">Save</button>' +
    "</div></div>";

  var INNER_MAIN =
    '<main class="ac-main">' +
    '<section class="ac-card">' +
    "<h2>API keys (stored in <code>server/data/app-runtime-config.json</code>)</h2>" +
    '<p class="ac-hint">Add a key to enable that vendor below. Leave blank to keep the current server value. Check “remove” to clear a stored key.</p>' +
    '<div class="ac-key-row"><label>OpenAI API key <span data-ic="openaiKeyBadge" class="ac-badge"></span> ' +
    '<input data-ic="openaiApiKey" type="password" autocomplete="new-password" placeholder="sk-…" /></label>' +
    '<label class="ac-inline"><input type="checkbox" data-ic="clearOpenaiApiKey" /> Remove stored key</label></div>' +
    '<div class="ac-key-row"><label>Gemini API key <span data-ic="geminiKeyBadge" class="ac-badge"></span> ' +
    '<input data-ic="geminiApiKey" type="password" autocomplete="new-password" /></label>' +
    '<label class="ac-inline"><input type="checkbox" data-ic="clearGeminiApiKey" /> Remove stored key</label></div>' +
    '<div class="ac-key-row"><label>Anthropic API key <span data-ic="anthropicKeyBadge" class="ac-badge"></span> ' +
    '<input data-ic="anthropicApiKey" type="password" autocomplete="new-password" /></label>' +
    '<label class="ac-inline"><input type="checkbox" data-ic="clearAnthropicApiKey" /> Remove stored key</label></div>' +
    "</section>" +
    '<section class="ac-card">' +
    "<h2>Voice bridge (WebSocket)</h2>" +
    '<p class="ac-hint">Realtime provider lists both vendors; each choice stays disabled until that API key exists. Model ID fields for a vendor unlock when that API key exists (independent of the provider dropdown).</p>' +
    "<label>Realtime provider " +
    '<select data-ic="liveRealtimeProvider">' +
    '<option value="">Select…</option>' +
    '<option value="openai">openai</option>' +
    '<option value="gemini">gemini</option>' +
    "</select></label>" +
    '<div class="ic-srv-voice-models">' +
    '<div class="ic-srv-model-col">' +
    '<span class="ic-srv-model-col-title">OpenAI</span>' +
    "<label>Model ID " +
    '<input data-ic="openaiRealtimeModel" type="text" autocomplete="off" placeholder="e.g. gpt-4o-realtime-preview-2024-12-17" />' +
    "</label>" +
    "<label>Voice " +
    '<input data-ic="openaiRealtimeVoice" type="text" autocomplete="off" placeholder="alloy" />' +
    "</label></div>" +
    '<div class="ic-srv-model-col">' +
    '<span class="ic-srv-model-col-title">Gemini</span>' +
    "<label>Model ID " +
    '<input data-ic="geminiLiveModel" type="text" autocomplete="off" placeholder="e.g. gemini-2.5-flash-native-audio-preview-12-2025" />' +
    "</label></div></div>" +
    "</section>" +
    '<section class="ac-card">' +
    "<h2>Evaluation LLM</h2>" +
    '<p class="ac-hint">LLM provider lists all vendors; each option unlocks when that API key exists. Each vendor’s model ID field unlocks when that API key exists (independent of the LLM provider dropdown).</p>' +
    "<label>LLM provider " +
    '<select data-ic="llmProvider">' +
    '<option value="">Select…</option>' +
    '<option value="openai">openai</option>' +
    '<option value="anthropic">anthropic</option>' +
    '<option value="gemini">gemini</option>' +
    "</select></label>" +
    '<div class="ic-srv-eval-models">' +
    '<div class="ic-srv-model-col">' +
    '<span class="ic-srv-model-col-title">OpenAI</span>' +
    "<label>Model ID " +
    '<input data-ic="openaiModelId" type="text" autocomplete="off" placeholder="OPENAI_MODEL_ID" />' +
    "</label></div>" +
    '<div class="ic-srv-model-col">' +
    '<span class="ic-srv-model-col-title">Anthropic</span>' +
    "<label>Model ID " +
    '<input data-ic="anthropicModelId" type="text" autocomplete="off" placeholder="ANTHROPIC_MODEL_ID" />' +
    "</label></div>" +
    '<div class="ic-srv-model-col">' +
    '<span class="ic-srv-model-col-title">Gemini</span>' +
    "<label>Model ID " +
    '<input data-ic="geminiModelId" type="text" autocomplete="off" placeholder="GEMINI_MODEL_ID" />' +
    "</label></div></div>" +
    "</section>" +
    '<section class="ac-card">' +
    "<h2>Local speech-to-text (Whisper)</h2>" +
    '<p class="ac-hint">Stored as <code>whisperModel</code> in the runtime file (merged as <code>WHISPER_MODEL</code>). Choose <strong>Default</strong> to follow <code>.env</code> / built-in default (<code>base</code>).</p>' +
    "<label>Whisper model " +
    '<select data-ic="whisperModel">' +
    '<option value="">Default (.env / base)</option>' +
    '<option value="tiny">tiny</option>' +
    '<option value="base">base</option>' +
    '<option value="small">small</option>' +
    '<option value="medium">medium</option>' +
    '<option value="large">large</option>' +
    '<option value="large-v2">large-v2</option>' +
    '<option value="large-v3">large-v3</option>' +
    '<option value="turbo">turbo</option>' +
    "</select></label>" +
    "</section>" +
    "</main>";

  var STATUS_HTML = '<p data-ic="status" class="ac-status"></p>';

  /**
   * @param {HTMLElement} root
   * @param {string} name
   * @returns {HTMLElement | null}
   */
  function q(root, name) {
    return root.querySelector('[data-ic="' + name + '"]');
  }

  /**
   * @param {unknown} v
   * @returns {string}
   */
  function asString(v) {
    return typeof v === "string" ? v : "";
  }

  /**
   * @typedef {object} IcMountServerConfigOpts
   * @property {HTMLElement} mountPoint
   * @property {boolean} [compact]
   * @property {string} [initialApiBase] applied on first mount only (standalone page)
   * @property {"full" | "actions"} [toolbar] default full; `actions` = no top toolbar (API base from parent; Save in footer)
   * @property {() => string} [getApiBase]
   * @property {(normalized: string) => void} [setApiBase]
   * @property {(normalized: string) => void | Promise<void>} [persistApiBase]
   * @property {boolean} [skipInitialLoad]
   */

  /**
   * @param {IcMountServerConfigOpts} opts
   * @returns {{ reload: () => Promise<void> }}
   */
  function mountServerConfigUI(opts) {
    var mountPoint = opts.mountPoint;
    if (!mountPoint) {
      return {
        reload: function () {
          return Promise.resolve();
        },
        syncFromParent: function () {},
      };
    }

    var elAny = /** @type {any} */ (mountPoint);
    var prevCtl = elAny.__icSrvCtl;
    if (prevCtl && typeof prevCtl.reload === "function" && mountPoint.dataset.icSrvMounted === "1") {
      prevCtl.syncFromParent();
      return prevCtl;
    }

    if (mountPoint.dataset.icSrvMounted !== "1") {
      var bar = opts.toolbar === "actions" ? "" : TOOLBAR_FULL;
      mountPoint.innerHTML = MOUNT_SCROLL_OPEN + bar + STATUS_HTML + INNER_MAIN + MOUNT_SCROLL_CLOSE;
      if (opts.compact) {
        mountPoint.classList.add("ic-server-config--compact");
      }
      mountPoint.dataset.icSrvMounted = "1";
      var firstApi = /** @type {HTMLInputElement | null} */ (q(mountPoint, "apiBase"));
      if (firstApi && typeof opts.initialApiBase === "string" && opts.initialApiBase.trim()) {
        firstApi.value = opts.initialApiBase.trim().replace(/\/$/, "");
      }
    }

    var apiInput = /** @type {HTMLInputElement | null} */ (q(mountPoint, "apiBase"));
    var cfgStatus = /** @type {HTMLElement | null} */ (q(mountPoint, "status"));
    var btnSave = /** @type {HTMLButtonElement | null} */ (q(mountPoint, "btnSave"));

    var liveRealtimeProvider = /** @type {HTMLSelectElement | null} */ (q(mountPoint, "liveRealtimeProvider"));
    var geminiLiveModel = /** @type {HTMLInputElement | null} */ (q(mountPoint, "geminiLiveModel"));
    var openaiRealtimeModel = /** @type {HTMLInputElement | null} */ (q(mountPoint, "openaiRealtimeModel"));
    var openaiRealtimeVoice = /** @type {HTMLInputElement | null} */ (q(mountPoint, "openaiRealtimeVoice"));
    var llmProvider = /** @type {HTMLSelectElement | null} */ (q(mountPoint, "llmProvider"));
    var whisperModel = /** @type {HTMLSelectElement | null} */ (q(mountPoint, "whisperModel"));
    var openaiModelId = /** @type {HTMLInputElement | null} */ (q(mountPoint, "openaiModelId"));
    var anthropicModelId = /** @type {HTMLInputElement | null} */ (q(mountPoint, "anthropicModelId"));
    var geminiModelId = /** @type {HTMLInputElement | null} */ (q(mountPoint, "geminiModelId"));
    var openaiApiKey = /** @type {HTMLInputElement | null} */ (q(mountPoint, "openaiApiKey"));
    var geminiApiKey = /** @type {HTMLInputElement | null} */ (q(mountPoint, "geminiApiKey"));
    var anthropicApiKey = /** @type {HTMLInputElement | null} */ (q(mountPoint, "anthropicApiKey"));
    var clearOpenaiApiKey = /** @type {HTMLInputElement | null} */ (q(mountPoint, "clearOpenaiApiKey"));
    var clearGeminiApiKey = /** @type {HTMLInputElement | null} */ (q(mountPoint, "clearGeminiApiKey"));
    var clearAnthropicApiKey = /** @type {HTMLInputElement | null} */ (q(mountPoint, "clearAnthropicApiKey"));
    var openaiKeyBadge = /** @type {HTMLElement | null} */ (q(mountPoint, "openaiKeyBadge"));
    var geminiKeyBadge = /** @type {HTMLElement | null} */ (q(mountPoint, "geminiKeyBadge"));
    var anthropicKeyBadge = /** @type {HTMLElement | null} */ (q(mountPoint, "anthropicKeyBadge"));

    /** @type {{ openai: boolean; gemini: boolean; anthropic: boolean }} */
    var lastServerKeyFlags = { openai: false, gemini: false, anthropic: false };

    /** @type {Record<string, string> | null} */
    var lastLoaded = null;

    function keyAvailOpenai() {
      if (clearOpenaiApiKey && clearOpenaiApiKey.checked) {
        return !!(openaiApiKey && openaiApiKey.value.trim());
      }
      return lastServerKeyFlags.openai || !!(openaiApiKey && openaiApiKey.value.trim());
    }
    function keyAvailGemini() {
      if (clearGeminiApiKey && clearGeminiApiKey.checked) {
        return !!(geminiApiKey && geminiApiKey.value.trim());
      }
      return lastServerKeyFlags.gemini || !!(geminiApiKey && geminiApiKey.value.trim());
    }
    function keyAvailAnthropic() {
      if (clearAnthropicApiKey && clearAnthropicApiKey.checked) {
        return !!(anthropicApiKey && anthropicApiKey.value.trim());
      }
      return lastServerKeyFlags.anthropic || !!(anthropicApiKey && anthropicApiKey.value.trim());
    }

    /**
     * @param {HTMLSelectElement} sel
     * @param {string} value
     * @param {boolean} disabled
     */
    function setSelectOptionDisabled(sel, value, disabled) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === value) {
          sel.options[i].disabled = disabled;
          return;
        }
      }
    }

    /**
     * Keeps provider on a valid option: empty placeholder, or a vendor that has a key.
     * Does not auto-select the first vendor when preferred is empty.
     * @param {HTMLSelectElement} sel
     * @param {string} preferred
     */
    function clampSelectToEnabledOption(sel, preferred) {
      var opts = sel.options;
      var want = preferred.trim();
      if (want === "") {
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].value === "" && !opts[i].disabled) {
            sel.value = "";
            return;
          }
        }
        return;
      }
      for (var j = 0; j < opts.length; j++) {
        if (opts[j].value === want && !opts[j].disabled) {
          sel.value = want;
          return;
        }
      }
      for (var z = 0; z < opts.length; z++) {
        if (opts[z].value === "" && !opts[z].disabled) {
          sel.value = "";
          return;
        }
      }
      for (var k = 0; k < opts.length; k++) {
        if (!opts[k].disabled) {
          sel.value = opts[k].value;
          return;
        }
      }
    }

    function refreshKeyGatedUis() {
      var o = keyAvailOpenai();
      var g = keyAvailGemini();
      var a = keyAvailAnthropic();

      if (liveRealtimeProvider) {
        setSelectOptionDisabled(liveRealtimeProvider, "openai", !o);
        setSelectOptionDisabled(liveRealtimeProvider, "gemini", !g);
        liveRealtimeProvider.disabled = false;
        clampSelectToEnabledOption(liveRealtimeProvider, liveRealtimeProvider.value);
      }

      if (llmProvider) {
        setSelectOptionDisabled(llmProvider, "openai", !o);
        setSelectOptionDisabled(llmProvider, "anthropic", !a);
        setSelectOptionDisabled(llmProvider, "gemini", !g);
        llmProvider.disabled = false;
        clampSelectToEnabledOption(llmProvider, llmProvider.value);
      }

      if (geminiLiveModel) {
        geminiLiveModel.disabled = !g;
      }
      if (openaiRealtimeModel) {
        openaiRealtimeModel.disabled = !o;
      }
      if (openaiRealtimeVoice) {
        openaiRealtimeVoice.disabled = !o;
      }
      if (openaiModelId) {
        openaiModelId.disabled = !o;
      }
      if (anthropicModelId) {
        anthropicModelId.disabled = !a;
      }
      if (geminiModelId) {
        geminiModelId.disabled = !g;
      }
    }

    function setStatus(text, isError) {
      if (!cfgStatus) {
        return;
      }
      cfgStatus.textContent = text;
      cfgStatus.className = isError ? "ac-status err" : "ac-status";
    }

    function apiBase() {
      if (typeof opts.getApiBase === "function") {
        var ext = opts.getApiBase().trim().replace(/\/$/, "");
        return ext || DEFAULT_API;
      }
      return (apiInput && apiInput.value ? apiInput.value : "").trim().replace(/\/$/, "") || DEFAULT_API;
    }

    function pushApiBaseToParent() {
      if (!apiInput || typeof opts.setApiBase !== "function") {
        return;
      }
      var b = (apiInput.value || "").trim().replace(/\/$/, "") || DEFAULT_API;
      opts.setApiBase(b);
    }

    function syncApiInputFromParent() {
      if (!apiInput || typeof opts.getApiBase !== "function") {
        return;
      }
      apiInput.value = opts.getApiBase().trim().replace(/\/$/, "") || DEFAULT_API;
    }

    function persistIfNeeded() {
      if (typeof opts.persistApiBase !== "function") {
        return Promise.resolve();
      }
      return Promise.resolve(opts.persistApiBase(apiBase()));
    }

    /**
     * @param {unknown} data
     */
    function applyPublicConfig(data) {
      if (!data || typeof data !== "object") {
        return;
      }
      var c = /** @type {Record<string, unknown>} */ (data);
      lastLoaded = {
        liveRealtimeProvider: asString(c.liveRealtimeProvider),
        geminiLiveModel: asString(c.geminiLiveModel),
        openaiRealtimeModel: asString(c.openaiRealtimeModel),
        openaiRealtimeVoice: asString(c.openaiRealtimeVoice),
        llmProvider: asString(c.llmProvider),
        openaiModelId: asString(c.openaiModelId),
        anthropicModelId: asString(c.anthropicModelId),
        geminiModelId: asString(c.geminiModelId),
        whisperModel: asString(c.whisperModel),
      };
      lastServerKeyFlags = {
        openai: Boolean(c.openaiApiKeyConfigured),
        gemini: Boolean(c.geminiApiKeyConfigured),
        anthropic: Boolean(c.anthropicApiKeyConfigured),
      };
      if (openaiApiKey) {
        openaiApiKey.value = "";
      }
      if (geminiApiKey) {
        geminiApiKey.value = "";
      }
      if (anthropicApiKey) {
        anthropicApiKey.value = "";
      }
      if (clearOpenaiApiKey) {
        clearOpenaiApiKey.checked = false;
      }
      if (clearGeminiApiKey) {
        clearGeminiApiKey.checked = false;
      }
      if (clearAnthropicApiKey) {
        clearAnthropicApiKey.checked = false;
      }

      /**
       * @param {HTMLElement | null} el
       * @param {boolean} configured
       */
      function setBadge(el, configured) {
        if (!el) {
          return;
        }
        el.textContent = configured ? "(stored on server)" : "(not set in runtime file)";
        el.className = configured ? "ac-badge" : "ac-badge off";
      }
      setBadge(openaiKeyBadge, Boolean(c.openaiApiKeyConfigured));
      setBadge(geminiKeyBadge, Boolean(c.geminiApiKeyConfigured));
      setBadge(anthropicKeyBadge, Boolean(c.anthropicApiKeyConfigured));

      if (liveRealtimeProvider) {
        liveRealtimeProvider.value = lastLoaded.liveRealtimeProvider.trim();
      }
      if (llmProvider) {
        llmProvider.value = lastLoaded.llmProvider.trim();
      }

      refreshKeyGatedUis();

      if (geminiLiveModel) {
        geminiLiveModel.value = lastLoaded.geminiLiveModel;
      }
      if (openaiRealtimeModel) {
        openaiRealtimeModel.value = lastLoaded.openaiRealtimeModel;
      }
      if (openaiRealtimeVoice) {
        openaiRealtimeVoice.value = lastLoaded.openaiRealtimeVoice;
      }
      if (openaiModelId) {
        openaiModelId.value = lastLoaded.openaiModelId;
      }
      if (anthropicModelId) {
        anthropicModelId.value = lastLoaded.anthropicModelId;
      }
      if (geminiModelId) {
        geminiModelId.value = lastLoaded.geminiModelId;
      }
      if (whisperModel) {
        whisperModel.value = lastLoaded.whisperModel;
      }
    }

    async function loadConfig() {
      setStatus("Loading…", false);
      try {
        syncApiInputFromParent();
        var base = apiBase();
        var res;
        try {
          res = await fetch(base + "/api/app-config");
        } catch {
          setStatus("Could not reach server (check API base URL and that it is running).", true);
          return;
        }
        var data = await res.json().catch(function () {
          return null;
        });
        if (!res.ok) {
          var err =
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : "HTTP " + res.status;
          setStatus(err, true);
          return;
        }
        applyPublicConfig(data);
        setStatus("Loaded.", false);
      } catch (e) {
        var msg =
          e && typeof e === "object" && "message" in e && typeof e.message === "string"
            ? e.message
            : "Load failed.";
        setStatus(msg, true);
      }
    }

    /**
     * @param {string} v
     * @returns {string | undefined}
     */
    function trimOrUndef(v) {
      var t = v.trim();
      return t ? t : undefined;
    }

    function emptyConfigBaseline() {
      return {
        liveRealtimeProvider: "",
        geminiLiveModel: "",
        openaiRealtimeModel: "",
        openaiRealtimeVoice: "",
        llmProvider: "",
        openaiModelId: "",
        anthropicModelId: "",
        geminiModelId: "",
        whisperModel: "",
      };
    }

    async function saveConfig() {
      var baseline = lastLoaded || emptyConfigBaseline();
      setStatus("Saving…", false);
      try {
        pushApiBaseToParent();
        await persistIfNeeded();

        /** @type {Record<string, string>} */
        var patch = {};

        if (liveRealtimeProvider) {
          var lr = liveRealtimeProvider.value.trim();
          if (lr !== baseline.liveRealtimeProvider) {
            patch.liveRealtimeProvider = lr;
          }
        }

        var g = geminiLiveModel ? geminiLiveModel.value.trim() : "";
        if (g !== baseline.geminiLiveModel) {
          patch.geminiLiveModel = g;
        }

        var orm = openaiRealtimeModel ? openaiRealtimeModel.value.trim() : "";
        if (orm !== baseline.openaiRealtimeModel) {
          patch.openaiRealtimeModel = orm;
        }

        var orv = openaiRealtimeVoice ? openaiRealtimeVoice.value.trim() : "";
        if (orv !== baseline.openaiRealtimeVoice) {
          patch.openaiRealtimeVoice = orv;
        }

        if (llmProvider) {
          var lp = llmProvider.value.trim();
          if (lp !== baseline.llmProvider) {
            patch.llmProvider = lp;
          }
        }

        var om = openaiModelId ? openaiModelId.value.trim() : "";
        if (om !== baseline.openaiModelId) {
          patch.openaiModelId = om;
        }
        var am = anthropicModelId ? anthropicModelId.value.trim() : "";
        if (am !== baseline.anthropicModelId) {
          patch.anthropicModelId = am;
        }
        var gm = geminiModelId ? geminiModelId.value.trim() : "";
        if (gm !== baseline.geminiModelId) {
          patch.geminiModelId = gm;
        }

        var wmv = whisperModel ? whisperModel.value.trim() : "";
        if (wmv !== baseline.whisperModel) {
          patch.whisperModel = wmv;
        }

        if (clearOpenaiApiKey && clearOpenaiApiKey.checked) {
          patch.openaiApiKey = "";
        } else {
          var kO = openaiApiKey ? trimOrUndef(openaiApiKey.value) : undefined;
          if (kO) {
            patch.openaiApiKey = kO;
          }
        }
        if (clearGeminiApiKey && clearGeminiApiKey.checked) {
          patch.geminiApiKey = "";
        } else {
          var kG = geminiApiKey ? trimOrUndef(geminiApiKey.value) : undefined;
          if (kG) {
            patch.geminiApiKey = kG;
          }
        }
        if (clearAnthropicApiKey && clearAnthropicApiKey.checked) {
          patch.anthropicApiKey = "";
        } else {
          var kA = anthropicApiKey ? trimOrUndef(anthropicApiKey.value) : undefined;
          if (kA) {
            patch.anthropicApiKey = kA;
          }
        }

        if (Object.keys(patch).length === 0) {
          setStatus("Nothing to save.", false);
          return;
        }

        var base = apiBase();
        var res;
        try {
          res = await fetch(base + "/api/app-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
        } catch {
          setStatus("Could not reach server (check API base URL and that it is running).", true);
          return;
        }
        var data = await res.json().catch(function () {
          return null;
        });
        if (!res.ok) {
          var err2 =
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : "HTTP " + res.status;
          setStatus(err2, true);
          return;
        }
        setStatus("Saved. Refreshing…", false);
        await loadConfig();
      } catch (e) {
        var msg =
          e && typeof e === "object" && "message" in e && typeof e.message === "string"
            ? e.message
            : "Save failed.";
        setStatus(msg, true);
      }
    }

    if (mountPoint.dataset.icSrvBound !== "1") {
      mountPoint.dataset.icSrvBound = "1";
      if (apiInput) {
        apiInput.addEventListener("change", function () {
          pushApiBaseToParent();
          void persistIfNeeded();
        });
      }
      btnSave &&
        btnSave.addEventListener("click", function () {
          void saveConfig();
        });
      [openaiApiKey, geminiApiKey, anthropicApiKey].forEach(function (inp) {
        if (inp) {
          inp.addEventListener("input", function () {
            refreshKeyGatedUis();
          });
        }
      });
      [clearOpenaiApiKey, clearGeminiApiKey, clearAnthropicApiKey].forEach(function (cb) {
        if (cb) {
          cb.addEventListener("change", function () {
            refreshKeyGatedUis();
          });
        }
      });
      if (liveRealtimeProvider) {
        liveRealtimeProvider.addEventListener("change", refreshKeyGatedUis);
      }
      if (llmProvider) {
        llmProvider.addEventListener("change", refreshKeyGatedUis);
      }
    }

    syncApiInputFromParent();

    // Until /api/app-config returns, vendor options stay disabled (no keys yet);
    // placeholder stays selected so the list can still open.
    refreshKeyGatedUis();

    if (!opts.skipInitialLoad) {
      void loadConfig();
    } else if (!lastLoaded) {
      setStatus("Open server settings again to fetch config.", false);
    }

    var ctl = {
      reload: loadConfig,
      syncFromParent: syncApiInputFromParent,
    };
    elAny.__icSrvCtl = ctl;
    return ctl;
  }

  window.ICMountServerConfigUI = mountServerConfigUI;
  window.IC_SERVER_CONFIG_DEFAULT_API = DEFAULT_API;

  /** Standalone app-config page: `#icServerConfigRoot` */
  function tryInitStandalonePage() {
    var root = document.getElementById("icServerConfigRoot");
    if (!root) {
      return;
    }
    void chrome.storage.local.get(["apiBase"]).then(function (got) {
      var stored = typeof got.apiBase === "string" && got.apiBase.trim() ? got.apiBase.trim().replace(/\/$/, "") : "";
      mountServerConfigUI({
        mountPoint: root,
        initialApiBase: stored || DEFAULT_API,
        persistApiBase: function (normalized) {
          return chrome.storage.local.set({ apiBase: normalized });
        },
      });
    });
  }

  if (typeof document !== "undefined") {
    tryInitStandalonePage();
  }
})();
