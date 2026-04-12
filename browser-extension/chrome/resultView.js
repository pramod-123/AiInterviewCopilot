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
      ts.setAttribute("role", "button");
      ts.tabIndex = 0;
      ts.setAttribute("aria-label", `Seek recording to ${formatTimestampMs(tms)}`);
      const srcSpan = document.createElement("span");
      srcSpan.className = "dim-ev-src";
      srcSpan.textContent = src ? ` ${src.trim()}` : "";
      const quoteSpan = document.createElement("span");
      quoteSpan.className = "dim-ev-quote";
      const srcLower = src.trim().toLowerCase();
      if (srcLower === "code") {
        quoteSpan.classList.add("dim-ev-quote--code", "md-content");
        const preEl = document.createElement("pre");
        preEl.className = "md-fence language-java dim-ev-fence";
        const codeEl = document.createElement("code");
        codeEl.className = "language-java";
        codeEl.textContent = quote;
        preEl.appendChild(codeEl);
        quoteSpan.appendChild(preEl);
        const md = window.InterviewCopilotMarkdown;
        if (md && typeof md.highlightFencesIn === "function") {
          md.highlightFencesIn(quoteSpan);
        }
      } else if (srcLower === "ocr") {
        quoteSpan.classList.add("dim-ev-quote--code");
        const codeEl = document.createElement("code");
        codeEl.className = "dim-ev-snippet";
        codeEl.textContent = quote;
        quoteSpan.appendChild(codeEl);
      } else {
        quoteSpan.classList.add("md-content");
        setNodeInlineMarkdownOrText(quoteSpan, quote);
      }
      const codeBlockLayout = srcLower === "code" || srcLower === "ocr";
      if (codeBlockLayout) {
        li.classList.add("dim-ev-li--codeblock");
        const meta = document.createElement("div");
        meta.className = "dim-ev-meta dim-ev-meta--header";
        meta.appendChild(ts);
        meta.appendChild(srcSpan);
        meta.appendChild(document.createTextNode(":"));
        li.appendChild(meta);
        li.appendChild(quoteSpan);
      } else {
        li.appendChild(ts);
        li.appendChild(srcSpan);
        li.appendChild(document.createTextNode(" "));
        li.appendChild(quoteSpan);
      }
      ul.appendChild(li);
    }
  }

  /**
   * @param {Record<string, unknown>} s
   * @returns {string}
   */
  function decisionTraceStepHeadline(s) {
    const step = typeof s.step === "string" ? s.step.trim() : "";
    const checked =
      typeof s.whatWasChecked === "string"
        ? s.whatWasChecked.trim()
        : typeof s.what_was_checked === "string"
          ? s.what_was_checked.trim()
          : "";
    if (step && checked) {
      return `${step} - ${checked}`;
    }
    if (checked) {
      return checked;
    }
    return step;
  }

  /**
   * Rich headline: bold `step` (e.g. problem_understanding), then " - " + what_was_checked when present.
   * @param {HTMLElement} p
   * @param {Record<string, unknown>} s
   */
  function fillDecisionTraceHeadlineEl(p, s) {
    p.replaceChildren();
    const step = typeof s.step === "string" ? s.step.trim() : "";
    const checked =
      typeof s.whatWasChecked === "string"
        ? s.whatWasChecked.trim()
        : typeof s.what_was_checked === "string"
          ? s.what_was_checked.trim()
          : "";
    if (step) {
      const em = document.createElement("strong");
      em.className = "ic-eval-trace-step-id";
      em.textContent = step;
      p.appendChild(em);
      if (checked) {
        p.appendChild(document.createTextNode(` - ${checked}`));
      }
      return;
    }
    if (checked) {
      p.textContent = checked;
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
   * @param {HTMLTableElement} table
   * @param {Record<string, unknown>} dims
   * @param {{ richScores: boolean }} opts
   */
  function fillDimensionsTable(table, dims, opts) {
    table.replaceChildren();
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
      if (opts.richScores) {
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
      } else {
        tdScore.textContent = typeof dim.score === "number" ? String(dim.score) : "—";
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
  }

  /**
   * Collapsible eval panel (`<details open>`). Body uses `ic-eval-list-panel-body`.
   * @param {string} panelClasses Space-separated; must include `ic-eval-list-panel`.
   * @param {string} titleText
   * @param {(body: HTMLDivElement) => void} fillBody
   * @returns {HTMLDetailsElement}
   */
  function createEvalDisclosurePanel(panelClasses, titleText, fillBody) {
    const details = document.createElement("details");
    details.className = `${panelClasses} ic-eval-disclosure`.trim();
    details.open = true;
    const summary = document.createElement("summary");
    summary.className = "ic-eval-list-panel-summary";
    summary.textContent = titleText;
    const body = document.createElement("div");
    body.className = "ic-eval-list-panel-body";
    fillBody(body);
    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }

  /**
   * @param {Record<string, unknown>} dims
   * @param {{ richScores: boolean }} opts
   * @returns {HTMLElement}
   */
  function createDimensionsSection(dims, opts) {
    const disclosure = createEvalDisclosurePanel(
      "ic-dimensions-section ic-eval-list-panel",
      "📊 Dimensions analysis",
      (body) => {
        const table = document.createElement("table");
        table.className = "dim-table";
        fillDimensionsTable(table, dims, opts);
        body.appendChild(table);
      },
    );
    disclosure.id = "ic-dimensions-section";
    return disclosure;
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

    appendEvalNarrativeBlock(
      root,
      "🏁 Final outcome",
      evalPickStr(evaluation, "finalOutcome", "final_outcome"),
      "ic-eval-block ic-eval-block--outcome",
    );
    appendEvalNarrativeBlock(
      root,
      "⚙️ Interview process quality",
      evalPickStr(evaluation, "interviewProcessQuality", "interview_process_quality"),
      "ic-eval-block ic-eval-block--process",
    );
    appendEvalNarrativeBlock(
      root,
      "✨ Hire signal",
      evalPickStr(evaluation, "hireSignalSummary", "hire_signal_summary"),
      "ic-eval-block ic-eval-block--hire",
    );
    const pred = evalPickStr(evaluation, "roundOutcomePrediction", "round_outcome_prediction");
    if (pred) {
      const row = document.createElement("p");
      row.className = "ic-eval-prediction";
      const strong = document.createElement("strong");
      strong.textContent = "🎯 Round prediction: ";
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
        h4.textContent = "💪 Strengths";
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
        h4.textContent = "📉 Weaknesses";
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
  }

  /**
   * Rich layout: coaching / prep / conflicts / dimensions (main column, below missed opportunities).
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendEvaluationRichContinuation(root, evaluation) {
    const altPath = asStringArray(evaluation.alternativeStrongerPath ?? evaluation.alternative_stronger_path);
    const wtsd = evaluation.whatToSayDifferently ?? evaluation.what_to_say_differently;
    if (Array.isArray(wtsd) && wtsd.length > 0) {
      const block = createEvalDisclosurePanel(
        "ic-eval-wtsd ic-eval-list-panel",
        "💬 What to say differently",
        (body) => {
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
              em.textContent = "📍 Situation: ";
              p.appendChild(em);
              p.appendChild(document.createTextNode(situation.trim()));
              card.appendChild(p);
            }
            if (better.trim()) {
              const p = document.createElement("p");
              p.className = "md-content";
              const em = document.createElement("strong");
              em.textContent = "✏️ Better phrasing: ";
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
              em.textContent = "💡 Why it helps: ";
              p.appendChild(em);
              const span = document.createElement("span");
              setNodeMarkdownOrText(span, why.trim());
              p.appendChild(span);
              card.appendChild(p);
            }
            body.appendChild(card);
          }
        },
      );
      root.appendChild(block);
    }

    const prepRaw = evaluation.prepSuggestions ?? evaluation.prep_suggestions;
    if (Array.isArray(prepRaw) && prepRaw.length > 0) {
      const block = createEvalDisclosurePanel("ic-eval-prep ic-eval-list-panel", "📚 Prep suggestions", (body) => {
        const stack = document.createElement("div");
        stack.className = "ic-prep-stack";
        /** @type {HTMLUListElement | null} */
        let stringRunUl = null;
        for (const item of prepRaw) {
          if (typeof item === "string" && item.trim()) {
            if (!stringRunUl) {
              stringRunUl = document.createElement("ul");
              stringRunUl.className = "ic-prep-simple-list";
              stack.appendChild(stringRunUl);
            }
            stringRunUl.appendChild(createMarkdownListItem(item.trim()));
            continue;
          }
          stringRunUl = null;
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
            appendEvalNarrativeBlock(card, "⚠️ Weakness", w.trim(), "ic-prep-field");
          }
          if (pr.trim()) {
            appendEvalNarrativeBlock(card, "💊 Prescription", pr.trim(), "ic-prep-field");
          }
          if (g.trim()) {
            appendEvalNarrativeBlock(card, "🎯 Goal", g.trim(), "ic-prep-field");
          }
          if (card.childNodes.length > 0) {
            stack.appendChild(card);
          }
        }
        body.appendChild(stack);
      });
      root.appendChild(block);
    }

    const conflicts = evaluation.speechCodeConflicts ?? evaluation.speech_code_conflicts;
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      const block = createEvalDisclosurePanel("ic-eval-conflicts ic-eval-list-panel", "🎤 Speech vs code", (body) => {
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
            em.textContent = "⏱️ Time: ";
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
            sub.textContent = "🎤 Speech evidence";
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
            sub.textContent = "💻 Code evidence";
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
            em.textContent = "⚖️ Why it matters: ";
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
            em.textContent = "🎓 Coaching: ";
            p.appendChild(em);
            p.appendChild(document.createTextNode(coach.trim()));
            card.appendChild(p);
          }
          body.appendChild(card);
        }
      });
      root.appendChild(block);
    }

    if (altPath.length > 0) {
      const block = createEvalDisclosurePanel(
        "ic-eval-alt-path ic-eval-list-panel",
        "🛤️ Alternative stronger path",
        (body) => {
          const ul = document.createElement("ul");
          ul.className = "ic-eval-list-panel-ul";
          for (const line of altPath) {
            ul.appendChild(createMarkdownListItem(line));
          }
          body.appendChild(ul);
        },
      );
      root.appendChild(block);
    }

    const trace = evaluation.decisionTrace ?? evaluation.decision_trace;
    if (Array.isArray(trace) && trace.length > 0) {
      const block = createEvalDisclosurePanel("ic-eval-trace ic-eval-list-panel", "🔍 Decision trace", (body) => {
        const ol = document.createElement("ol");
        ol.className = "ic-eval-trace-list";
        for (const step of trace) {
          if (!step || typeof step !== "object") {
            continue;
          }
          const s = /** @type {Record<string, unknown>} */ (step);
          const li = document.createElement("li");
          const headP = document.createElement("p");
          headP.className = "ic-eval-trace-headline";
          fillDecisionTraceHeadlineEl(headP, s);
          if (headP.textContent.trim()) {
            li.appendChild(headP);
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
            em.textContent = "📌 Conclusion: ";
            p.appendChild(em);
            p.appendChild(document.createTextNode(concl.trim()));
            li.appendChild(p);
          }
          ol.appendChild(li);
        }
        body.appendChild(ol);
      });
      root.appendChild(block);
    }

    const dims = evaluation.dimensions;
    if (dims && typeof dims === "object" && !Array.isArray(dims)) {
      root.appendChild(createDimensionsSection(dims, { richScores: true }));
    }
  }

  /**
   * Missed opportunities + missed interviewer-friendly behaviors — rendered outside the
   * main "Interview feedback" block, side-by-side when both are present.
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendMissedOpportunitiesTwoColumn(root, evaluation) {
    const missed = asStringArray(evaluation.missedOpportunities ?? evaluation.missed_opportunities);
    const missedIv = asStringArray(
      evaluation.missedInterviewerFriendlyBehaviors ?? evaluation.missed_interviewer_friendly_behaviors,
    );
    if (missed.length === 0 && missedIv.length === 0) {
      return;
    }

    const section = document.createElement("section");
    section.className = "ic-missed-pair-section";
    const h3 = document.createElement("h3");
    h3.className = "ic-missed-pair-heading";
    h3.textContent = "🎯 Missed opportunities & interviewer rapport";
    section.appendChild(h3);

    const grid = document.createElement("div");
    grid.className = "ic-missed-pair-grid";
    if (!(missed.length > 0 && missedIv.length > 0)) {
      grid.classList.add("ic-missed-pair-grid--single");
    }

    /**
     * @param {string} title
     * @param {string[]} lines
     * @param {string} extraClass
     */
    function appendCol(title, lines, extraClass) {
      if (lines.length === 0) {
        return;
      }
      const col = document.createElement("div");
      col.className = ["ic-missed-pair-col", "sess-missed-block", "ic-missed-block", extraClass].filter(Boolean).join(" ");
      const h4 = document.createElement("h4");
      h4.textContent = title;
      col.appendChild(h4);
      const ul = document.createElement("ul");
      for (const line of lines) {
        ul.appendChild(createMarkdownListItem(line));
      }
      col.appendChild(ul);
      grid.appendChild(col);
    }

    appendCol("🚩 Missed opportunities", missed, "");
    appendCol("🤝 Missed interviewer-friendly behaviors", missedIv, "");
    section.appendChild(grid);
    root.appendChild(section);
  }

  /**
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendEvaluationPlain(root, evaluation) {
    const strengths = asStringArray(evaluation.strengths);
    const weaknesses = asStringArray(evaluation.weaknesses);

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

    plainSection("🏁 Final outcome", evalPickStr(evaluation, "finalOutcome", "final_outcome"));
    plainSection("⚙️ Interview process quality", evalPickStr(evaluation, "interviewProcessQuality", "interview_process_quality"));
    plainSection("✨ Hire signal", evalPickStr(evaluation, "hireSignalSummary", "hire_signal_summary"));
    const pred = evalPickStr(evaluation, "roundOutcomePrediction", "round_outcome_prediction");
    if (pred) {
      plainSection("🎯 Round prediction", pred.replace(/_/g, " "));
    }

    if (strengths.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "💪 Strengths";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of strengths) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }

    if (weaknesses.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "📉 Weaknesses";
      root.appendChild(h3);
      const ul = document.createElement("ul");
      for (const s of weaknesses) {
        ul.appendChild(createMarkdownListItem(s));
      }
      root.appendChild(ul);
    }
  }

  /**
   * Plain layout: sections after strengths/weaknesses (main column).
   * @param {HTMLElement} root
   * @param {Record<string, unknown>} evaluation
   */
  function appendEvaluationPlainContinuation(root, evaluation) {
    const altPath = asStringArray(evaluation.alternativeStrongerPath ?? evaluation.alternative_stronger_path);

    const wtsd = evaluation.whatToSayDifferently ?? evaluation.what_to_say_differently;
    if (Array.isArray(wtsd) && wtsd.length > 0) {
      const h3 = document.createElement("h3");
      h3.textContent = "💬 What to say differently";
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
      h3.textContent = "📚 Prep suggestions";
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
      h3.textContent = "🎤 Speech vs code";
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
      h3.textContent = "🛤️ Alternative stronger path";
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
      h3.textContent = "🔍 Decision trace";
      root.appendChild(h3);
      const ol = document.createElement("ol");
      for (const step of trace) {
        if (!step || typeof step !== "object") {
          continue;
        }
        const s = /** @type {Record<string, unknown>} */ (step);
        const li = document.createElement("li");
        const head = decisionTraceStepHeadline(s);
        const concl = typeof s.conclusion === "string" ? s.conclusion.trim() : "";
        const parts = [head, concl].filter(Boolean);
        li.textContent = parts.join(" — ");
        ol.appendChild(li);
      }
      root.appendChild(ol);
    }

    const dims = evaluation.dimensions;
    if (dims && typeof dims === "object" && !Array.isArray(dims)) {
      root.appendChild(createDimensionsSection(dims, { richScores: false }));
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {{ result?: unknown } & Record<string, unknown>} data
   * @param {{
   *   omitInlineTranscriptionMeta?: boolean;
   *   richLayout?: boolean;
   *   missedMount?: HTMLElement | null;
   *   extendedMount?: HTMLElement | null;
   * }} [options]
   */
  function renderInterviewGetResponse(root, data, options) {
    root.replaceChildren();

    const missedMount = options?.missedMount ?? null;
    const extendedMount = options?.extendedMount ?? null;
    if (missedMount) {
      missedMount.replaceChildren();
    }
    if (extendedMount) {
      extendedMount.replaceChildren();
    }

    const payload = data.result;
    if (!payload || typeof payload !== "object") {
      if (missedMount) {
        missedMount.classList.add("hidden");
      }
      if (extendedMount) {
        extendedMount.classList.add("hidden");
      }
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
    h2.textContent = "📋 Interview feedback";
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
        h3.textContent = "📝 Transcription";
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
      const missedRoot = missedMount ?? root;
      appendMissedOpportunitiesTwoColumn(missedRoot, evaluation);
      if (missedMount) {
        missedMount.classList.toggle("hidden", missedMount.childNodes.length === 0);
      }
      if (extendedMount) {
        if (richLayout) {
          appendEvaluationRichContinuation(extendedMount, evaluation);
        } else {
          appendEvaluationPlainContinuation(extendedMount, evaluation);
        }
        extendedMount.classList.toggle("hidden", extendedMount.childNodes.length === 0);
      }
    } else {
      if (missedMount) {
        missedMount.classList.add("hidden");
      }
      if (extendedMount) {
        extendedMount.classList.add("hidden");
      }
    }

    const details = document.createElement("details");
    const summ = document.createElement("summary");
    summ.textContent = "📦 Full result JSON";
    details.appendChild(summ);
    const pre = document.createElement("pre");
    pre.className = "raw";
    pre.textContent = JSON.stringify(payload, null, 2);
    details.appendChild(pre);
    root.appendChild(details);

    const mdSweep = window.InterviewCopilotMarkdown;
    if (mdSweep && typeof mdSweep.highlightFencesIn === "function") {
      mdSweep.highlightFencesIn(root);
      if (missedMount && missedMount.childNodes.length > 0) {
        mdSweep.highlightFencesIn(missedMount);
      }
      if (extendedMount && extendedMount.childNodes.length > 0) {
        mdSweep.highlightFencesIn(extendedMount);
      }
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
