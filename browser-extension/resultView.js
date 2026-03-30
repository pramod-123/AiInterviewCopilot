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
   * @param {number} ms
   */
  function formatTimestampMs(ms) {
    const t = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /**
   * @param {HTMLElement} td
   * @param {Record<string, unknown>} dim
   */
  function fillDimensionNotesCell(td, dim) {
    td.replaceChildren();
    td.classList.add("dim-notes");
    const pointsRaw = dim.rationalePoints ?? dim.rationale_points;
    if (Array.isArray(pointsRaw) && pointsRaw.length > 0) {
      for (const pt of pointsRaw) {
        if (!pt || typeof pt !== "object") {
          continue;
        }
        const p = /** @type {Record<string, unknown>} */ (pt);
        const text = typeof p.text === "string" ? p.text : "";
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
            li.appendChild(ts);
            li.appendChild(srcSpan);
            li.appendChild(document.createTextNode(` ${quote}`));
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
    let note = typeof dim.rationale === "string" ? dim.rationale : "";
    const ev = dim.evidence;
    if (Array.isArray(ev) && ev.length > 0) {
      const evLines = ev.filter((x) => typeof x === "string").join("\n");
      if (evLines) {
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
          const li = document.createElement("li");
          li.textContent = s;
          ul.appendChild(li);
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
          const li = document.createElement("li");
          li.textContent = s;
          ul.appendChild(li);
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
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
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
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
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
        tdName.textContent = key.replace(/_/g, " ");
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
        const li = document.createElement("li");
        li.textContent = s;
        ul.appendChild(li);
      }
      root.appendChild(ul);
    }

    if (weaknesses.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Weaknesses";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of weaknesses) {
        const li = document.createElement("li");
        li.textContent = s;
        ul.appendChild(li);
      }
      root.appendChild(ul);
    }

    if (missed.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Missed opportunities";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of missed) {
        const li = document.createElement("li");
        li.textContent = s;
        ul.appendChild(li);
      }
      root.appendChild(ul);
    }

    if (prep.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Prep suggestions";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of prep) {
        const li = document.createElement("li");
        li.textContent = s;
        ul.appendChild(li);
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
        tdName.textContent = key.replace(/_/g, " ");
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
      const sum = document.createElement("p");
      sum.className = "summary";
      sum.textContent = evaluation.summary;
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

    const tokenUsage =
      evaluation && evaluation.tokenUsage && typeof evaluation.tokenUsage === "object"
        ? /** @type {Record<string, unknown>} */ (evaluation.tokenUsage)
        : null;
    const pipelineObj =
      p.pipeline && typeof p.pipeline === "object"
        ? /** @type {Record<string, unknown>} */ (p.pipeline)
        : null;
    const roiTokenUsage =
      pipelineObj && pipelineObj.roiTokenUsage && typeof pipelineObj.roiTokenUsage === "object"
        ? /** @type {Record<string, unknown>} */ (pipelineObj.roiTokenUsage)
        : null;

    if (tokenUsage || roiTokenUsage) {
      const meta = document.createElement("div");
      meta.className = "ic-token-meta";

      /** @param {Record<string, unknown>} u */
      function num(u, k) {
        const v = u[k];
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      }

      /** @param {string} model */
      function contextWindowForModel(model) {
        if (typeof model !== "string") return 0;
        const m = model.toLowerCase();
        if (m.includes("gpt-4o-mini")) return 128000;
        if (m.includes("gpt-4o")) return 128000;
        if (m.includes("gpt-4-turbo")) return 128000;
        if (m.includes("gpt-4")) return 8192;
        if (m.includes("gpt-3.5")) return 16385;
        if (m.includes("o1-mini")) return 128000;
        if (m.includes("o1")) return 200000;
        if (m.includes("o3-mini")) return 200000;
        if (m.includes("o3")) return 200000;
        if (m.includes("claude-3-5-sonnet")) return 200000;
        if (m.includes("claude-3-5-haiku")) return 200000;
        if (m.includes("claude-3-opus")) return 200000;
        if (m.includes("claude-3-sonnet")) return 200000;
        if (m.includes("claude-3-haiku")) return 200000;
        if (m.includes("claude")) return 200000;
        return 0;
      }

      /**
       * @param {string} label
       * @param {Record<string, unknown>} usage
       * @param {string | null | undefined} model
       */
      function buildUsageLine(label, usage, model) {
        const inp = num(usage, "inputTokens");
        const out = num(usage, "outputTokens");
        const total = num(usage, "totalTokens") || inp + out;
        const parts = [`${label}:`, `in ${inp.toLocaleString()}`, `out ${out.toLocaleString()}`, `total ${total.toLocaleString()}`];

        const cached = num(usage, "cachedTokens");
        if (cached > 0) parts.push(`(${cached.toLocaleString()} cached)`);
        const reasoning = num(usage, "reasoningTokens");
        if (reasoning > 0) parts.push(`(${reasoning.toLocaleString()} reasoning)`);

        const ctx = contextWindowForModel(model);
        if (ctx > 0 && total > 0) {
          const pct = ((total / ctx) * 100).toFixed(1);
          parts.push(`· ${pct}% of ${(ctx / 1000).toLocaleString()}k context`);
        }
        return parts.join(" ");
      }

      const lines = [];
      if (tokenUsage) {
        const model = evaluation && typeof evaluation.model === "string" ? evaluation.model : null;
        const provider = evaluation && typeof evaluation.provider === "string" ? evaluation.provider : "";
        const label = model ? `Evaluation (${provider}/${model})` : "Evaluation";
        lines.push(buildUsageLine(label, tokenUsage, model));
      }
      if (roiTokenUsage) {
        lines.push(buildUsageLine("Vision ROI", roiTokenUsage, null));
      }

      if (tokenUsage && roiTokenUsage) {
        const totalIn = num(tokenUsage, "inputTokens") + num(roiTokenUsage, "inputTokens");
        const totalOut = num(tokenUsage, "outputTokens") + num(roiTokenUsage, "outputTokens");
        lines.push(`Combined: in ${totalIn.toLocaleString()}  out ${totalOut.toLocaleString()}  total ${(totalIn + totalOut).toLocaleString()}`);
      }

      for (const line of lines) {
        const span = document.createElement("span");
        span.className = "ic-token-meta-line";
        span.textContent = line;
        meta.appendChild(span);
      }
      root.appendChild(meta);
    }
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
