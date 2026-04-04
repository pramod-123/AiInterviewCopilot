/**
 * Shared DOM rendering for GET /api/interviews/:id responses (extension pages).
 * Assigns {@link window.InterviewCopilotResultView}.
 */
(function () {
  /**
   * @param {unknown} v
   * @returns {string[]}
   */
  function asStringArray(v) {
    if (!Array.isArray(v)) {
      return [];
    }
    return v.filter((x) => typeof x === "string");
  }

  /**
   * @param {HTMLElement} el
   * @param {string} text
   */
  function setNodeMarkdownOrText(el, text) {
    const md = window.InterviewCopilotMarkdown;
    if (md && typeof md.appendMarkdownToElement === "function") {
      md.appendMarkdownToElement(el, text);
    } else {
      el.textContent = text;
    }
  }

  /**
   * Inline-only markdown (`code`, line breaks) — no fenced blocks. Used for dimension evidence quotes.
   * @param {HTMLElement} el
   * @param {string} text
   */
  function setNodeInlineMarkdownOrText(el, text) {
    const md = window.InterviewCopilotMarkdown;
    if (md && typeof md.appendInlineMarkdownToElement === "function") {
      md.appendInlineMarkdownToElement(el, text);
    } else {
      el.textContent = text;
    }
  }

  /**
   * @param {string} text
   * @returns {HTMLLIElement}
   */
  function createMarkdownListItem(text) {
    const li = document.createElement("li");
    const inner = document.createElement("div");
    inner.className = "md-content md-content--tight";
    setNodeMarkdownOrText(inner, text);
    li.appendChild(inner);
    return li;
  }

  /**
   * @param {number} ms
   */
  function formatTimestampMs(ms) {
    const t = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /**
   * @param {Record<string, unknown>} p
   */
  function pickRationalePointText(p) {
    for (const key of ["text", "body", "summary", "point", "claim"]) {
      const v = p[key];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
    return "";
  }

  /**
   * Area column: rubric key only (rationale lives in Notes with points / evidence).
   * @param {HTMLElement} td
   * @param {string} areaKey
   */
  function fillDimensionAreaCell(td, areaKey) {
    td.replaceChildren();
    td.className = "dim-area-cell";
    const title = document.createElement("div");
    title.className = "dim-area-title";
    title.textContent = areaKey.replace(/_/g, " ");
    td.appendChild(title);
  }

  /**
   * Notes column: per-point bullets + evidence; else flat rationale and/or legacy evidence strings.
   * @param {HTMLElement} td
   * @param {Record<string, unknown>} dim
   */
  function fillDimensionNotesCell(td, dim) {
    td.replaceChildren();
    td.classList.remove("md-content");
    td.classList.add("dim-notes");
    const pointsRaw = dim.rationalePoints ?? dim.rationale_points;
    if (Array.isArray(pointsRaw) && pointsRaw.length > 0) {
      for (const pt of pointsRaw) {
        if (!pt || typeof pt !== "object") {
          continue;
        }
        const p = /** @type {Record<string, unknown>} */ (pt);
        const text = pickRationalePointText(p);
        if (!text) {
          continue;
        }
        const wrap = document.createElement("div");
        wrap.className = "dim-rationale-point";
        const head = document.createElement("p");
        head.className = "dim-rationale-text";
        head.style.margin = "0 0 0.45em";
        head.textContent = text;
        wrap.appendChild(head);
        const ev = p.evidence;
        if (Array.isArray(ev) && ev.length > 0) {
          const ul = document.createElement("ul");
          ul.className = "dim-evidence-list";
          for (const row of ev) {
            if (!row || typeof row !== "object") {
              continue;
            }
            const r = /** @type {Record<string, unknown>} */ (row);
            const quote = typeof r.quote === "string" ? r.quote : "";
            const tms =
              typeof r.timestampMs === "number"
                ? r.timestampMs
                : typeof r.timestamp_ms === "number"
                  ? r.timestamp_ms
                  : Number.NaN;
            const src = typeof r.source === "string" ? r.source : "";
            if (!quote || !Number.isFinite(tms)) {
              continue;
            }
            const li = document.createElement("li");
            const ts = document.createElement("span");
            ts.className = "dim-ev-ts ic-seek-link";
            ts.textContent = `[${formatTimestampMs(tms)}]`;
            ts.dataset.seekMs = String(Math.round(tms));
            ts.title = "Seek video and transcript to this time";
            const srcSpan = document.createElement("span");
            srcSpan.className = "dim-ev-src";
            srcSpan.textContent = src ? ` ${src}` : "";
            const quoteSpan = document.createElement("span");
            quoteSpan.className = "dim-ev-quote";
            const srcLower = src.trim().toLowerCase();
            if (srcLower === "code" || srcLower === "ocr") {
              quoteSpan.classList.add("dim-ev-quote--code");
              const codeEl = document.createElement("code");
              codeEl.className = "dim-ev-snippet";
              codeEl.textContent = quote;
              quoteSpan.appendChild(codeEl);
            } else {
              quoteSpan.classList.add("md-content");
              setNodeInlineMarkdownOrText(quoteSpan, quote);
            }
            li.appendChild(ts);
            li.appendChild(srcSpan);
            li.appendChild(document.createTextNode(" "));
            li.appendChild(quoteSpan);
            ul.appendChild(li);
          }
          if (ul.children.length > 0) {
            wrap.appendChild(ul);
          }
        }
        td.appendChild(wrap);
      }
      if (td.childNodes.length > 0) {
        return;
      }
    }
    let note = typeof dim.rationale === "string" ? dim.rationale.trim() : "";
    const ev = dim.evidence;
    if (Array.isArray(ev) && ev.length > 0) {
      const evLines = ev.filter((x) => typeof x === "string").join("\n");
      if (evLines.trim()) {
        note = note ? `${note}\n\nEvidence:\n${evLines}` : `Evidence:\n${evLines}`;
      }
    }
    td.textContent = note || "—";
  }

  /**
   * @param {number | undefined} score
   * @returns {string}
   */
  function dimScoreClass(score) {
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return "";
    }
    if (score >= 4) {
      return "is-high";
    }
    if (score >= 3) {
      return "is-mid";
    }
    return "is-low";
  }

  /**
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendEvaluationRich(root, evaluation) {
    const strengths = asStringArray(evaluation.strengths);
    const weaknesses = asStringArray(evaluation.weaknesses);
    const prep = asStringArray(evaluation.prepSuggestions ?? evaluation.prep_suggestions);
    const missed = asStringArray(evaluation.missedOpportunities ?? evaluation.missed_opportunities);

    if (strengths.length > 0 || weaknesses.length > 0) {
      const grid = document.createElement("div");
      grid.className = "sess-eval-grid ic-eval-grid";
      if (strengths.length > 0) {
        const col = document.createElement("div");
        col.className = "sess-eval-col strengths ic-eval-col ic-strengths";
        const h4 = document.createElement("h4");
        h4.textContent = "Strengths";
        col.appendChild(h4);
        const ul = document.createElement("ul");
        for (const s of strengths) {
          ul.appendChild(createMarkdownListItem(s));
        }
        col.appendChild(ul);
        grid.appendChild(col);
      }
      if (weaknesses.length > 0) {
        const col = document.createElement("div");
        col.className = "sess-eval-col weaknesses ic-eval-col ic-weaknesses";
        const h4 = document.createElement("h4");
        h4.textContent = "Weaknesses";
        col.appendChild(h4);
        const ul = document.createElement("ul");
        for (const s of weaknesses) {
          ul.appendChild(createMarkdownListItem(s));
        }
        col.appendChild(ul);
        grid.appendChild(col);
      }
      root.appendChild(grid);
    }

    if (missed.length > 0) {
      const block = document.createElement("div");
      block.className = "sess-missed-block ic-missed-block";
      const h4 = document.createElement("h4");
      h4.textContent = "Missed opportunities";
      block.appendChild(h4);
      const ul = document.createElement("ul");
      for (const line of missed) {
        ul.appendChild(createMarkdownListItem(line));
      }
      block.appendChild(ul);
      root.appendChild(block);
    }

    if (prep.length > 0) {
      const block = document.createElement("div");
      block.className = "sess-prep-block ic-prep-block";
      const h4 = document.createElement("h4");
      h4.textContent = "Prep suggestions";
      block.appendChild(h4);
      const ul = document.createElement("ul");
      for (const line of prep) {
        ul.appendChild(createMarkdownListItem(line));
      }
      block.appendChild(ul);
      root.appendChild(block);
    }

    const dims = evaluation.dimensions;
    if (dims && typeof dims === "object" && !Array.isArray(dims)) {
      const section = document.createElement("section");
      section.className = "ic-dimensions-section";
      section.id = "ic-dimensions-section";
      const h3 = document.createElement("h3");
      h3.className = "dim-head";
      h3.textContent = "Dimensions";
      section.appendChild(h3);
      const table = document.createElement("table");
      table.className = "dim-table";
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const label of ["Area", "Score", "Notes"]) {
        const th = document.createElement("th");
        th.textContent = label;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const [key, raw] of Object.entries(dims)) {
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const dim = /** @type {Record<string, unknown>} */ (raw);
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        fillDimensionAreaCell(tdName, key);
        const tdScore = document.createElement("td");
        const sc = dim.score;
        if (typeof sc === "number" && Number.isFinite(sc)) {
          const span = document.createElement("span");
          span.className = `dim-score ${dimScoreClass(sc)}`.trim();
          span.textContent = String(sc);
          const max = document.createElement("span");
          max.className = "dim-max";
          max.textContent = " / 5";
          tdScore.appendChild(span);
          tdScore.appendChild(max);
        } else {
          tdScore.textContent = "—";
        }
        const tdRat = document.createElement("td");
        fillDimensionNotesCell(tdRat, dim);
        tr.appendChild(tdName);
        tr.appendChild(tdScore);
        tr.appendChild(tdRat);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      section.appendChild(table);
      root.appendChild(section);
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendEvaluationPlain(root, evaluation) {
    const strengths = asStringArray(evaluation.strengths);
    const weaknesses = asStringArray(evaluation.weaknesses);
    const prep = asStringArray(evaluation.prepSuggestions ?? evaluation.prep_suggestions);
    const missed = asStringArray(evaluation.missedOpportunities ?? evaluation.missed_opportunities);

    if (strengths.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Strengths";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of strengths) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    if (weaknesses.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Weaknesses";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of weaknesses) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    if (missed.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Missed opportunities";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of missed) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    if (prep.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Prep suggestions";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of prep) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    const dims = evaluation.dimensions;
    if (dims && typeof dims === "object" && !Array.isArray(dims)) {
      const h3 = document.createElement("h3");
      h3.textContent = "Dimensions";
      root.appendChild(h3);
      const table = document.createElement("table");
      table.className = "dim-table";
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const label of ["Area", "Score", "Notes"]) {
        const th = document.createElement("th");
        th.textContent = label;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const [key, raw] of Object.entries(dims)) {
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const dim = /** @type {Record<string, unknown>} */ (raw);
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        fillDimensionAreaCell(tdName, key);
        const tdScore = document.createElement("td");
        tdScore.textContent = typeof dim.score === "number" ? String(dim.score) : "—";
        const tdRat = document.createElement("td");
        fillDimensionNotesCell(tdRat, dim);
        tr.appendChild(tdName);
        tr.appendChild(tdScore);
        tr.appendChild(tdRat);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      root.appendChild(table);
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {{ result?: unknown } & Record<string, unknown>} data
   * @param {{ omitInlineTranscriptionMeta?: boolean; richLayout?: boolean }} [options]
   */
  function renderInterviewGetResponse(root, data, options) {
    root.replaceChildren();

    const payload = data.result;
    if (!payload || typeof payload !== "object") {
      const pre = document.createElement("pre");
      pre.className = "raw";
      pre.textContent = JSON.stringify(data, null, 2);
      root.appendChild(pre);
      return;
    }

    const richLayout = Boolean(options?.richLayout);
    const omitStt = Boolean(options?.omitInlineTranscriptionMeta);

    /** @type {{ evaluation?: Record<string, unknown> } & Record<string, unknown>} */
    const p = /** @type {any} */ (payload);
    const evaluation =
      p.evaluation && typeof p.evaluation === "object"
        ? /** @type {Record<string, unknown>} */ (p.evaluation)
        : null;

    const h2 = document.createElement("h2");
    h2.textContent = "Interview feedback";
    root.appendChild(h2);

    if (evaluation && typeof evaluation.summary === "string" && evaluation.summary.trim()) {
      const sum = document.createElement("div");
      sum.className = "summary md-content";
      setNodeMarkdownOrText(sum, evaluation.summary.trim());
      root.appendChild(sum);
    }

    const st = p.stt && typeof p.stt === "object" ? /** @type {Record<string, unknown>} */ (p.stt) : null;
    if (st && !omitStt) {
      const parts = [];
      if (typeof st.provider === "string") {
        parts.push(st.provider);
      }
      if (typeof st.model === "string") {
        parts.push(st.model);
      }
      if (typeof st.segmentCount === "number") {
        parts.push(`${st.segmentCount} segments`);
      }
      if (parts.length > 0) {
        const h3 = document.createElement("h3");
        h3.textContent = "Transcription";
        root.appendChild(h3);
        const pEl = document.createElement("p");
        pEl.className = "summary";
        pEl.textContent = parts.join(" · ");
        root.appendChild(pEl);
      }
    }

    if (evaluation) {
      if (richLayout) {
        appendEvaluationRich(root, evaluation);
      } else {
        appendEvaluationPlain(root, evaluation);
      }
    }

    const details = document.createElement("details");
    const summ = document.createElement("summary");
    summ.textContent = "Full result JSON";
    details.appendChild(summ);
    const pre = document.createElement("pre");
    pre.className = "raw";
    pre.textContent = JSON.stringify(payload, null, 2);
    details.appendChild(pre);
    root.appendChild(details);
  }

  /**
   * @param {HTMLElement} root
   * @param {string} text
   * @param {boolean} [isError]
   */
  function renderStatusMessage(root, text, isError) {
    root.replaceChildren();
    const p = document.createElement("p");
    p.className = isError ? "detail-err" : "detail-muted";
    p.textContent = text;
    root.appendChild(p);
  }

  window.InterviewCopilotResultView = {
    renderInterviewGetResponse,
    renderStatusMessage,
  };
})();
