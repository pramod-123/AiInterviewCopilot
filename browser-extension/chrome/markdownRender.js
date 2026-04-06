/**
 * Minimal safe Markdown → HTML for extension pages (CSP `script-src 'self'`; Prism is vendored locally).
 * Supports fenced code blocks, inline `code`, paragraphs, line breaks, and single-line # / ## / ### headings.
 * Fenced blocks and inline `backticks` use Prism’s Java grammar + Atom Dark theme (fence language tags are ignored).
 * Java grammar ships inside `vendor/prism/prism-bundle.min.js`.
 * All text is HTML-escaped except generated wrapper tags.
 */
(function () {
  /**
   * @param {string} s
   */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Prism grammar for every fenced block (tags like ```python are ignored). */
  const FENCE_PRISM_LANG = "java";

  /**
   * @returns {{ grammar: object; langId: string } | null}
   */
  function resolveFenceGrammar() {
    const P = typeof window !== "undefined" ? window.Prism : undefined;
    const langs = P?.languages;
    if (!langs) {
      return null;
    }
    if (langs.java) {
      return { grammar: langs.java, langId: "java" };
    }
    if (langs.javascript) {
      return { grammar: langs.javascript, langId: "javascript" };
    }
    if (langs.clike) {
      return { grammar: langs.clike, langId: "clike" };
    }
    return null;
  }

  /**
   * Highlight every `pre.md-fence code.language-*` under root (markdown + dimension code evidence).
   * @param {HTMLElement} root
   */
  function highlightFenceBlocksInRoot(root) {
    const P = typeof window !== "undefined" ? window.Prism : undefined;
    const resolved = resolveFenceGrammar();
    if (!P || !root || !resolved) {
      if (typeof console !== "undefined" && console.warn && root && !resolved) {
        console.warn(
          "[InterviewCopilotMarkdown] Prism: no java/javascript/clike grammar — code blocks stay plain text.",
        );
      }
      return;
    }
    const sel = `pre.md-fence code.language-${FENCE_PRISM_LANG}`;
    root.querySelectorAll(sel).forEach((codeEl) => {
      if (!(codeEl instanceof HTMLElement)) {
        return;
      }
      const source = codeEl.textContent ?? "";
      if (!source.trim()) {
        return;
      }
      try {
        codeEl.innerHTML = P.highlight(source, resolved.grammar, resolved.langId);
      } catch (err) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[InterviewCopilotMarkdown] Prism.highlight failed", err);
        }
      }
    });
  }

  /**
   * Deferred highlight so DOM is settled (and Prism plugins have run).
   * @param {HTMLElement} root
   */
  function highlightFencesIn(root) {
    queueMicrotask(() => {
      highlightFenceBlocksInRoot(root);
      highlightInlineCodeInRoot(root);
    });
  }

  /**
   * Highlight `code.md-inline-code.language-java` (single-line or short inline backticks).
   * @param {HTMLElement} root
   */
  function highlightInlineCodeInRoot(root) {
    const P = typeof window !== "undefined" ? window.Prism : undefined;
    const resolved = resolveFenceGrammar();
    if (!P || !root || !resolved) {
      return;
    }
    const sel = `.md-inline-code.language-${FENCE_PRISM_LANG}`;
    root.querySelectorAll(sel).forEach((codeEl) => {
      if (!(codeEl instanceof HTMLElement)) {
        return;
      }
      if (codeEl.querySelector(".token")) {
        return;
      }
      const source = codeEl.textContent ?? "";
      if (!source.trim()) {
        return;
      }
      try {
        codeEl.innerHTML = P.highlight(source, resolved.grammar, resolved.langId);
      } catch (err) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[InterviewCopilotMarkdown] Prism.highlight (inline) failed", err);
        }
      }
    });
  }

  /**
   * Inline backticks only (no blocks).
   * @param {string} text
   * @returns {string}
   */
  function renderInline(text) {
    let res = "";
    let i = 0;
    while (i < text.length) {
      const j = text.indexOf("`", i);
      if (j === -1) {
        res += escapeHtml(text.slice(i));
        break;
      }
      res += escapeHtml(text.slice(i, j));
      const k = text.indexOf("`", j + 1);
      if (k === -1) {
        res += escapeHtml(text.slice(j));
        break;
      }
      res += `<code class="md-inline-code language-${FENCE_PRISM_LANG}">`;
      res += escapeHtml(text.slice(j + 1, k));
      res += "</code>";
      i = k + 1;
    }
    return res;
  }

  /**
   * @param {string} trimmed
   * @returns {string}
   */
  function renderParagraphBlock(trimmed) {
    if (!trimmed.includes("\n") && trimmed.startsWith("### ")) {
      return `<h3 class="md-h3">${renderInline(trimmed.slice(4).trim())}</h3>`;
    }
    if (!trimmed.includes("\n") && trimmed.startsWith("## ")) {
      return `<h2 class="md-h2">${renderInline(trimmed.slice(3).trim())}</h2>`;
    }
    if (!trimmed.includes("\n") && trimmed.startsWith("# ")) {
      return `<h1 class="md-h1">${renderInline(trimmed.slice(2).trim())}</h1>`;
    }
    const lines = trimmed.split("\n");
    const htmlLines = lines.map((line) => renderInline(line));
    return `<p class="md-p">${htmlLines.join('<br class="md-br" />')}</p>`;
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function renderMarkdownTextBlocks(text) {
    const trimmedAll = text.trim();
    if (!trimmedAll) {
      return "";
    }
    const paras = trimmedAll.split(/\n{2,}/);
    const out = [];
    for (const para of paras) {
      const trimmed = para.trim();
      if (trimmed) {
        out.push(renderParagraphBlock(trimmed));
      }
    }
    return out.join("");
  }

  /**
   * @param {string} _lang — ignored; highlighting is always Java-style
   * @param {string} code
   * @returns {string}
   */
  function renderCodeBlock(_lang, code) {
    const safe = escapeHtml(FENCE_PRISM_LANG);
    return `<pre class="md-fence language-${safe}"><code class="language-${safe}">${escapeHtml(code)}</code></pre>`;
  }

  /**
   * @param {string} raw
   * @returns {string}
   */
  function renderMarkdownToHtml(raw) {
    if (!raw || typeof raw !== "string") {
      return "";
    }
    const parts = [];
    let pos = 0;
    while (pos < raw.length) {
      const fenceStart = raw.indexOf("```", pos);
      if (fenceStart === -1) {
        parts.push(renderMarkdownTextBlocks(raw.slice(pos)));
        break;
      }
      if (fenceStart > pos) {
        parts.push(renderMarkdownTextBlocks(raw.slice(pos, fenceStart)));
      }
      let afterOpen = fenceStart + 3;
      const lineEnd = raw.indexOf("\n", afterOpen);
      let lang = "";
      let bodyStart = afterOpen;
      if (lineEnd !== -1) {
        lang = raw.slice(afterOpen, lineEnd).trim();
        bodyStart = lineEnd + 1;
      } else {
        lang = raw.slice(afterOpen).trim();
        bodyStart = raw.length;
      }
      const fenceEnd = raw.indexOf("```", bodyStart);
      if (fenceEnd === -1) {
        const code = bodyStart < raw.length ? raw.slice(bodyStart) : "";
        parts.push(renderCodeBlock(lang, code));
        break;
      }
      let code = raw.slice(bodyStart, fenceEnd);
      if (code.endsWith("\n")) {
        code = code.slice(0, -1);
      }
      parts.push(renderCodeBlock(lang, code));
      pos = fenceEnd + 3;
      if (raw[pos] === "\n") {
        pos += 1;
      } else if (raw[pos] === "\r" && raw[pos + 1] === "\n") {
        pos += 2;
      }
    }
    return parts.join("");
  }

  /**
   * @param {HTMLElement} el
   * @param {string} markdown
   */
  /**
   * Parse trusted HTML we generated ourselves (moved nodes, not template, for consistent behavior in tables).
   * @param {HTMLElement} el
   * @param {string} html
   */
  function injectTrustedHtml(el, html) {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    while (holder.firstChild) {
      el.appendChild(holder.firstChild);
    }
  }

  function appendMarkdownToElement(el, markdown) {
    el.replaceChildren();
    const html = renderMarkdownToHtml(markdown);
    if (!html) {
      return;
    }
    injectTrustedHtml(el, html);
    highlightFenceBlocksInRoot(el);
    highlightInlineCodeInRoot(el);
  }

  /**
   * Inline `code` and line breaks only (safe inside tight containers).
   * @param {HTMLElement} el
   * @param {string} text
   */
  function appendInlineMarkdownToElement(el, text) {
    el.replaceChildren();
    if (!text) {
      return;
    }
    const lines = text.split("\n");
    const html = lines.map((line) => renderInline(line)).join("<br />");
    injectTrustedHtml(el, html);
    highlightInlineCodeInRoot(el);
  }

  window.InterviewCopilotMarkdown = {
    renderMarkdownToHtml,
    appendMarkdownToElement,
    appendInlineMarkdownToElement,
    escapeHtml,
    highlightFencesIn,
  };
})();
