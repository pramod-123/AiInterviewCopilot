/**
 * Best-effort read of LeetCode / Monaco via the **visible DOM only**.
 * Monaco virtualizes lines: this returns **viewport text**, not the full buffer.
 * The side panel uses `chrome.scripting` MAIN-world `monaco.editor.getModels()` first (full buffer).
 */
function extractLeetCodeEditorText() {
  const selectors = [
    ".monaco-editor .view-lines",
    '[data-cy="code-editor"] .view-lines',
    ".editor-scrollable .view-lines",
    "#editor .view-lines",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.innerText || "").replace(/\u00a0/g, " ");
      if (text.trim().length > 0) {
        return text;
      }
    }
  }

  const monacoRoot = document.querySelector(".monaco-editor");
  if (monacoRoot) {
    const lines = monacoRoot.querySelectorAll(".view-line");
    if (lines.length > 0) {
      return Array.from(lines)
        .map((l) => (l.textContent || "").replace(/\u00a0/g, " "))
        .join("\n");
    }
  }

  return "";
}

const QUESTION_TEXT_MAX = 100_000;

/**
 * Human-readable title from `/problems/slug/` (fallback when DOM/embeds omit text).
 * @returns {string}
 */
function problemSlugDisplayTitle() {
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

function longestInnerTextAcross(selectors, maxLen) {
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
      if (t.length > best.length && t.length < maxLen) {
        best = t;
      }
    }
  }
  return best;
}

/**
 * Title + problem body from the LeetCode UI (selectors may need updates if the site changes).
 * Picks the longest description-region match so a nested `querySelector` hit does not truncate the statement.
 * @returns {string}
 */
function extractLeetCodeQuestion() {
  const slugTitle = problemSlugDisplayTitle();

  const titleSelectors = [
    '[data-cy="question-title"]',
    '[data-cy="qb-title"]',
    '[data-cy="interview-question-title"]',
    ".text-title-large",
    ".text-headline-medium",
    'a[class*="title"]',
    "h1",
    "h2",
  ];
  let title = "";
  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    const t = (el?.textContent || "").replace(/\u00a0/g, " ").trim();
    if (t) {
      title = t;
      break;
    }
  }
  if (!title) {
    title = document.title?.replace(/\s*[-|]\s*LeetCode.*$/i, "").trim() || "";
  }

  let body = longestInnerTextAcross(
    [
      '[data-cy="question-content"]',
      '[data-cy="description-content"]',
      'div[data-track-load="description_content"]',
      '[class*="description-content"]',
      '[class*="question-content"]',
      '[class*="problem-statement"]',
      '[class*="ProblemStatement"]',
      ".lc-md",
      '[class*="lc-md"]',
      '[class*="_questionContent"]',
    ],
    QUESTION_TEXT_MAX,
  );
  if (!body || body.length < 80) {
    const tabFallback = longestInnerTextAcross(
      ['[data-cy="question-detail-main-tabs"] [role="tabpanel"]'],
      QUESTION_TEXT_MAX,
    );
    if (tabFallback.length > body.length) {
      body = tabFallback;
    }
  }

  const metaDesc =
    document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || "";

  const og = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() || "";

  let combined = "";
  if (body) {
    combined = title ? `${title}\n\n${body}` : body;
  } else if (title) {
    combined = title;
    const extra =
      metaDesc && metaDesc.length > 50
        ? metaDesc
        : og && og.length > 50 && !title.includes(og.slice(0, 30))
          ? og
          : "";
    if (extra) {
      combined += `\n\n${extra}`;
    }
  } else if (metaDesc && metaDesc.length > 50) {
    combined = slugTitle ? `${slugTitle}\n\n${metaDesc}` : metaDesc;
  } else if (og && og.length > 50) {
    combined = slugTitle ? `${slugTitle}\n\n${og}` : og;
  } else if (slugTitle) {
    combined = `${slugTitle}\n\n(Full statement was not readable from the page. Keep the problem **Description** tab visible and try again, or rely on code + video on the server.)`;
  }

  return combined.replace(/\u00a0/g, " ").trim().slice(0, QUESTION_TEXT_MAX);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_QUESTION") {
    try {
      const question = extractLeetCodeQuestion();
      sendResponse({ ok: true, question });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        question: "",
      });
    }
    return true;
  }

  if (msg?.type === "GET_CODE") {
    try {
      const code = extractLeetCodeEditorText();
      sendResponse({ ok: true, code });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code: "",
      });
    }
    return true;
  }
  return false;
});
