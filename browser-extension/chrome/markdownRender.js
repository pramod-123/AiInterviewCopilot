/**
 * Minimal safe Markdown → HTML for extension pages (no external scripts; CSP `script-src 'self'`).
 * Supports fenced code blocks, inline `code`, paragraphs, line breaks, and single-line # / ## / ### headings.
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

  /**
   * @param {string} lang
   */
  function sanitizeLang(lang) {
    const t = lang.trim();
    if (!t || !/^[\w+#.-]{1,32}$/.test(t)) {
      return "";
    }
    return t;
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
      res += "<code class=\"md-inline-code\">";
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
   * @param {string} lang
   * @param {string} code
   * @returns {string}
   */
  function renderCodeBlock(lang, code) {
    const lg = sanitizeLang(lang);
    const cls = lg ? ` class="language-${escapeHtml(lg)}"` : "";
    return `<pre class="md-fence"><code${cls}>${escapeHtml(code)}</code></pre>`;
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
  }

  window.InterviewCopilotMarkdown = {
    renderMarkdownToHtml,
    appendMarkdownToElement,
    appendInlineMarkdownToElement,
    escapeHtml,
  };
})();
