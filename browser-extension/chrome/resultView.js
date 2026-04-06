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
    for (const key of ["claim", "text", "body", "summary", "point"]) {
      const v = p[key];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
    return "";
  }

  /**
   * Structured evidence quotes (evaluation v4 schema).
   * @param {HTMLUListElement} ul
   * @param {unknown} ev
   */
  function appendEvidenceRowsToUl(ul, ev) {
    if (!Array.isArray(ev) || ev.length === 0) {
      return;
    }
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
          appendEvidenceRowsToUl(ul, ev);
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
    td.textContent = "—";
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
   * @param {Record<string, unknown>} e
   * @param {string} camel
   * @param {string} snake
   */
  function evalPickStr(e, camel, snake) {
    const a = e[camel];
    const b = e[snake];
    if (typeof a === "string" && a.trim()) {
      return a.trim();
    }
    if (typeof b === "string" && b.trim()) {
      return b.trim();
    }
    return "";
  }

  /**
   * @param {HTMLElement} root
   * @param {string} title
   * @param {string} body
   * @param {string} wrapClass
   */
  function appendEvalNarrativeBlock(root, title, body, wrapClass) {
    if (!body) {
      return;
    }
    const block = document.createElement("div");
    block.className = wrapClass;
    const h4 = document.createElement("h4");
    h4.textContent = title;
    block.appendChild(h4);
    const div = document.createElement("div");
    div.className = "md-content";
    setNodeMarkdownOrText(div, body);
    block.appendChild(div);
    root.appendChild(block);
  }

  /**
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendEvaluationRich(root, evaluation) {
    const strengths = asStringArray(evaluation.strengths);
    const weaknesses = asStringArray(evaluation.weaknesses);
    const missed = asStringArray(evaluation.missedOpportunities ?? evaluation.missed_opportunities);
    const missedIv = asStringArray(
      evaluation.missedInterviewerFriendlyBehaviors ?? evaluation.missed_interviewer_friendly_behaviors,
    );
    const altPath = asStringArray(evaluation.alternativeStrongerPath ?? evaluation.alternative_stronger_path);

    appendEvalNarrativeBlock(
      root,
      "Final outcome",
      evalPickStr(evaluation, "finalOutcome", "final_outcome"),
      "ic-eval-block ic-eval-block--outcome",
    );
    appendEvalNarrativeBlock(
      root,
      "Interview process quality",
      evalPickStr(evaluation, "interviewProcessQuality", "interview_process_quality"),
      "ic-eval-block ic-eval-block--process",
    );
    appendEvalNarrativeBlock(
      root,
      "Hire signal",
      evalPickStr(evaluation, "hireSignalSummary", "hire_signal_summary"),
      "ic-eval-block ic-eval-block--hire",
    );
    const pred = evalPickStr(evaluation, "roundOutcomePrediction", "round_outcome_prediction");
    if (pred) {
      const row = document.createElement("p");
      row.className = "ic-eval-prediction";
      const strong = document.createElement("strong");
      strong.textContent = "Round prediction: ";
      row.appendChild(strong);
      row.appendChild(document.createTextNode(pred.replace(/_/g, " ")));
      root.appendChild(row);
    }

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

    if (missedIv.length > 0) {
      const block = document.createElement("div");
      block.className = "sess-missed-block ic-missed-block ic-missed-iv";
      const h4 = document.createElement("h4");
      h4.textContent = "Missed interviewer-friendly behaviors";
      block.appendChild(h4);
      const ul = document.createElement("ul");
      for (const line of missedIv) {
        ul.appendChild(createMarkdownListItem(line));
      }
      block.appendChild(ul);
      root.appendChild(block);
    }

    const wtsd = evaluation.whatToSayDifferently ?? evaluation.what_to_say_differently;
    if (Array.isArray(wtsd) && wtsd.length > 0) {
      const block = document.createElement("div");
      block.className = "ic-eval-wtsd";
      const h4 = document.createElement("h4");
      h4.textContent = "What to say differently";
      block.appendChild(h4);
      for (const item of wtsd) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const o = /** @type {Record<string, unknown>} */ (item);
        const situation = typeof o.situation === "string" ? o.situation : "";
        const better =
          typeof o.betterPhrasing === "string"
            ? o.betterPhrasing
            : typeof o.better_phrasing === "string"
              ? o.better_phrasing
              : "";
        const why =
          typeof o.whyItHelps === "string"
            ? o.whyItHelps
            : typeof o.why_it_helps === "string"
              ? o.why_it_helps
              : "";
        const card = document.createElement("div");
        card.className = "ic-eval-wtsd-card";
        if (situation.trim()) {
          const p = document.createElement("p");
          p.className = "ic-eval-wtsd-situation";
          const em = document.createElement("strong");
          em.textContent = "Situation: ";
          p.appendChild(em);
          p.appendChild(document.createTextNode(situation.trim()));
          card.appendChild(p);
        }
        if (better.trim()) {
          const p = document.createElement("p");
          p.className = "md-content";
          const em = document.createElement("strong");
          em.textContent = "Better phrasing: ";
          p.appendChild(em);
          const span = document.createElement("span");
          setNodeMarkdownOrText(span, better.trim());
          p.appendChild(span);
          card.appendChild(p);
        }
        if (why.trim()) {
          const p = document.createElement("p");
          p.className = "md-content";
          const em = document.createElement("strong");
          em.textContent = "Why it helps: ";
          p.appendChild(em);
          const span = document.createElement("span");
          setNodeMarkdownOrText(span, why.trim());
          p.appendChild(span);
          card.appendChild(p);
        }
        block.appendChild(card);
      }
      root.appendChild(block);
    }

    const prepRaw = evaluation.prepSuggestions ?? evaluation.prep_suggestions;
    if (Array.isArray(prepRaw) && prepRaw.length > 0) {
      const block = document.createElement("div");
      block.className = "sess-prep-block ic-prep-block";
      const h4 = document.createElement("h4");
      h4.textContent = "Prep suggestions";
      block.appendChild(h4);
      for (const item of prepRaw) {
        if (typeof item === "string" && item.trim()) {
          const ul = document.createElement("ul");
          ul.appendChild(createMarkdownListItem(item.trim()));
          block.appendChild(ul);
          continue;
        }
        if (!item || typeof item !== "object") {
          continue;
        }
        const o = /** @type {Record<string, unknown>} */ (item);
        const w = typeof o.weakness === "string" ? o.weakness : "";
        const pr = typeof o.prescription === "string" ? o.prescription : "";
        const g = typeof o.goal === "string" ? o.goal : "";
        const card = document.createElement("div");
        card.className = "ic-prep-card";
        if (w.trim()) {
          appendEvalNarrativeBlock(card, "Weakness", w.trim(), "ic-prep-field");
        }
        if (pr.trim()) {
          appendEvalNarrativeBlock(card, "Prescription", pr.trim(), "ic-prep-field");
        }
        if (g.trim()) {
          appendEvalNarrativeBlock(card, "Goal", g.trim(), "ic-prep-field");
        }
        if (card.childNodes.length > 0) {
          block.appendChild(card);
        }
      }
      root.appendChild(block);
    }

    const conflicts = evaluation.speechCodeConflicts ?? evaluation.speech_code_conflicts;
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      const block = document.createElement("div");
      block.className = "ic-eval-conflicts";
      const h4 = document.createElement("h4");
      h4.textContent = "Speech vs code";
      block.appendChild(h4);
      for (const item of conflicts) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const c = /** @type {Record<string, unknown>} */ (item);
        const card = document.createElement("div");
        card.className = "ic-eval-conflict-card";
        const tr =
          typeof c.timeRange === "string"
            ? c.timeRange
            : typeof c.time_range === "string"
              ? c.time_range
              : "";
        if (tr) {
          const p = document.createElement("p");
          p.className = "ic-eval-conflict-range";
          const em = document.createElement("strong");
          em.textContent = "Time: ";
          p.appendChild(em);
          p.appendChild(document.createTextNode(tr));
          card.appendChild(p);
        }
        const issue = typeof c.issue === "string" ? c.issue : "";
        if (issue.trim()) {
          const p = document.createElement("p");
          p.className = "md-content";
          setNodeMarkdownOrText(p, issue.trim());
          card.appendChild(p);
        }
        const se = c.speechEvidence ?? c.speech_evidence;
        const ce = c.codeEvidence ?? c.code_evidence;
        if (Array.isArray(se) && se.length > 0) {
          const sub = document.createElement("p");
          sub.className = "ic-eval-ev-label";
          sub.textContent = "Speech evidence";
          card.appendChild(sub);
          const ul = document.createElement("ul");
          ul.className = "dim-evidence-list";
          appendEvidenceRowsToUl(ul, se);
          if (ul.children.length > 0) {
            card.appendChild(ul);
          }
        }
        if (Array.isArray(ce) && ce.length > 0) {
          const sub = document.createElement("p");
          sub.className = "ic-eval-ev-label";
          sub.textContent = "Code evidence";
          card.appendChild(sub);
          const ul = document.createElement("ul");
          ul.className = "dim-evidence-list";
          appendEvidenceRowsToUl(ul, ce);
          if (ul.children.length > 0) {
            card.appendChild(ul);
          }
        }
        const wim =
          typeof c.whyItMatters === "string"
            ? c.whyItMatters
            : typeof c.why_it_matters === "string"
              ? c.why_it_matters
              : "";
        if (wim.trim()) {
          const p = document.createElement("p");
          const em = document.createElement("strong");
          em.textContent = "Why it matters: ";
          p.appendChild(em);
          p.appendChild(document.createTextNode(wim.trim()));
          card.appendChild(p);
        }
        const coach =
          typeof c.coachingAdvice === "string"
            ? c.coachingAdvice
            : typeof c.coaching_advice === "string"
              ? c.coaching_advice
              : "";
        if (coach.trim()) {
          const p = document.createElement("p");
          const em = document.createElement("strong");
          em.textContent = "Coaching: ";
          p.appendChild(em);
          p.appendChild(document.createTextNode(coach.trim()));
          card.appendChild(p);
        }
        block.appendChild(card);
      }
      root.appendChild(block);
    }

    if (altPath.length > 0) {
      const block = document.createElement("div");
      block.className = "ic-eval-alt-path";
      const h4 = document.createElement("h4");
      h4.textContent = "Alternative stronger path";
      block.appendChild(h4);
      const ul = document.createElement("ul");
      for (const line of altPath) {
        ul.appendChild(createMarkdownListItem(line));
      }
      block.appendChild(ul);
      root.appendChild(block);
    }

    const trace = evaluation.decisionTrace ?? evaluation.decision_trace;
    if (Array.isArray(trace) && trace.length > 0) {
      const block = document.createElement("div");
      block.className = "ic-eval-trace";
      const h4 = document.createElement("h4");
      h4.textContent = "Decision trace";
      block.appendChild(h4);
      const ol = document.createElement("ol");
      ol.className = "ic-eval-trace-list";
      for (const step of trace) {
        if (!step || typeof step !== "object") {
          continue;
        }
        const s = /** @type {Record<string, unknown>} */ (step);
        const li = document.createElement("li");
        const st = typeof s.step === "string" ? s.step : "";
        if (st.trim()) {
          const p = document.createElement("p");
          const em = document.createElement("strong");
          em.textContent = st.trim();
          p.appendChild(em);
          li.appendChild(p);
        }
        const checked =
          typeof s.whatWasChecked === "string"
            ? s.whatWasChecked
            : typeof s.what_was_checked === "string"
              ? s.what_was_checked
              : "";
        if (checked.trim()) {
          const p = document.createElement("p");
          p.className = "detail-muted";
          p.textContent = checked.trim();
          li.appendChild(p);
        }
        const evu = s.evidenceUsed ?? s.evidence_used;
        if (Array.isArray(evu) && evu.length > 0) {
          const ul = document.createElement("ul");
          ul.className = "dim-evidence-list";
          appendEvidenceRowsToUl(ul, evu);
          if (ul.children.length > 0) {
            li.appendChild(ul);
          }
        }
        const concl = typeof s.conclusion === "string" ? s.conclusion : "";
        if (concl.trim()) {
          const p = document.createElement("p");
          const em = document.createElement("strong");
          em.textContent = "Conclusion: ";
          p.appendChild(em);
          p.appendChild(document.createTextNode(concl.trim()));
          li.appendChild(p);
        }
        ol.appendChild(li);
      }
      block.appendChild(ol);
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
      for (const label of ["Area", "Score", "Evidence", "Notes"]) {
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
        const tdSuff = document.createElement("td");
        tdSuff.className = "dim-sufficiency-cell";
        const suff =
          typeof dim.evidenceSufficiency === "string"
            ? dim.evidenceSufficiency
            : typeof dim.evidence_sufficiency === "string"
              ? dim.evidence_sufficiency
              : "";
        tdSuff.textContent = suff ? suff.replace(/_/g, " ") : "—";
        const tdRat = document.createElement("td");
        fillDimensionNotesCell(tdRat, dim);
        tr.appendChild(tdName);
        tr.appendChild(tdScore);
        tr.appendChild(tdSuff);
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
    const missed = asStringArray(evaluation.missedOpportunities ?? evaluation.missed_opportunities);
    const missedIv = asStringArray(
      evaluation.missedInterviewerFriendlyBehaviors ?? evaluation.missed_interviewer_friendly_behaviors,
    );
    const altPath = asStringArray(evaluation.alternativeStrongerPath ?? evaluation.alternative_stronger_path);

    function plainSection(title, text) {
      if (!text) {
        return;
      }
      const h3 = document.createElement("h3");
      h3.textContent = title;
      root.appendChild(h3);
      const p = document.createElement("p");
      p.className = "md-content";
      setNodeMarkdownOrText(p, text);
      root.appendChild(p);
    }

    plainSection("Final outcome", evalPickStr(evaluation, "finalOutcome", "final_outcome"));
    plainSection("Interview process quality", evalPickStr(evaluation, "interviewProcessQuality", "interview_process_quality"));
    plainSection("Hire signal", evalPickStr(evaluation, "hireSignalSummary", "hire_signal_summary"));
    const pred = evalPickStr(evaluation, "roundOutcomePrediction", "round_outcome_prediction");
    if (pred) {
      plainSection("Round prediction", pred.replace(/_/g, " "));
    }

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

    if (missedIv.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Missed interviewer-friendly behaviors";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of missedIv) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    const wtsd = evaluation.whatToSayDifferently ?? evaluation.what_to_say_differently;
    if (Array.isArray(wtsd) && wtsd.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "What to say differently";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const item of wtsd) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const o = /** @type {Record<string, unknown>} */ (item);
        const situation = typeof o.situation === "string" ? o.situation : "";
        const better =
          typeof o.betterPhrasing === "string"
            ? o.betterPhrasing
            : typeof o.better_phrasing === "string"
              ? o.better_phrasing
              : "";
        const why =
          typeof o.whyItHelps === "string"
            ? o.whyItHelps
            : typeof o.why_it_helps === "string"
              ? o.why_it_helps
              : "";
        const parts = [situation, better, why].filter((x) => x.trim()).join(" → ");
        if (parts) {
          ul.appendChild(createMarkdownListItem(parts));
        }
      }
      root.appendChild(ul);
    }

    const prepRaw = evaluation.prepSuggestions ?? evaluation.prep_suggestions;
    if (Array.isArray(prepRaw) && prepRaw.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Prep suggestions";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const item of prepRaw) {
        if (typeof item === "string" && item.trim()) {
          ul.appendChild(createMarkdownListItem(item.trim()));
          continue;
        }
        if (!item || typeof item !== "object") {
          continue;
        }
        const o = /** @type {Record<string, unknown>} */ (item);
        const w = typeof o.weakness === "string" ? o.weakness : "";
        const pr = typeof o.prescription === "string" ? o.prescription : "";
        const g = typeof o.goal === "string" ? o.goal : "";
        const line = [w, pr, g].filter((x) => x.trim()).join(" · ");
        if (line) {
          ul.appendChild(createMarkdownListItem(line));
        }
      }
      root.appendChild(ul);
    }

    const conflicts = evaluation.speechCodeConflicts ?? evaluation.speech_code_conflicts;
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Speech vs code";
      root.appendChild(h3);
      for (const item of conflicts) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const c = /** @type {Record<string, unknown>} */ (item);
        const tr =
          typeof c.timeRange === "string"
            ? c.timeRange
            : typeof c.time_range === "string"
              ? c.time_range
              : "";
        const issue = typeof c.issue === "string" ? c.issue : "";
        const pre = document.createElement("pre");
        pre.className = "ic-eval-conflict-plain";
        pre.textContent = [tr && `Time: ${tr}`, issue].filter(Boolean).join("\n");
        root.appendChild(pre);
      }
    }

    if (altPath.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Alternative stronger path";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of altPath) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    const trace = evaluation.decisionTrace ?? evaluation.decision_trace;
    if (Array.isArray(trace) && trace.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "Decision trace";
      root.appendChild(h3);
      const ol = document.createElement("ol");
      for (const step of trace) {
        if (!step || typeof step !== "object") {
          continue;
        }
        const s = /** @type {Record<string, unknown>} */ (step);
        const li = document.createElement("li");
        const bits = [
          typeof s.step === "string" ? s.step : "",
          typeof s.whatWasChecked === "string"
            ? s.whatWasChecked
            : typeof s.what_was_checked === "string"
              ? s.what_was_checked
              : "",
          typeof s.conclusion === "string" ? s.conclusion : "",
        ].filter((x) => x.trim());
        li.textContent = bits.join(" — ");
        ol.appendChild(li);
      }
      root.appendChild(ol);
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
      for (const label of ["Area", "Score", "Evidence", "Notes"]) {
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
        const tdSuff = document.createElement("td");
        const suff =
          typeof dim.evidenceSufficiency === "string"
            ? dim.evidenceSufficiency
            : typeof dim.evidence_sufficiency === "string"
              ? dim.evidence_sufficiency
              : "";
        tdSuff.textContent = suff ? suff.replace(/_/g, " ") : "—";
        const tdRat = document.createElement("td");
        fillDimensionNotesCell(tdRat, dim);
        tr.appendChild(tdName);
        tr.appendChild(tdScore);
        tr.appendChild(tdSuff);
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
