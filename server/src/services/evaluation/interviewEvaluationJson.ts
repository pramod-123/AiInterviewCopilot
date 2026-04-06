import type {
  ChronologicalTurningPoint,
  DecisionTraceStep,
  DimensionRationalePoint,
  EvaluationDimension,
  EvaluationEvidenceQuote,
  InterviewEvaluationPayload,
  PrepSuggestionItem,
  RoundOutcomePrediction,
  SpeechCodeConflict,
  WhatToSayDifferentlyItem,
} from "../../types/interviewEvaluation.js";

type RawDimension = {
  score?: unknown;
  evidence_sufficiency?: unknown;
  evidenceSufficiency?: unknown;
  rationale_points?: unknown;
  rationalePoints?: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  return v.filter((x): x is string => typeof x === "string");
}

function parseNumberMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function normalizeEvidenceSource(v: unknown): EvaluationEvidenceQuote["source"] {
  if (v === "speech" || v === "code" || v === "question") {
    return v;
  }
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "speech" || s === "audio") {
      return "speech";
    }
    if (s === "code" || s === "ocr") {
      return "code";
    }
    if (s === "question") {
      return "question";
    }
  }
  return undefined;
}

function parseEvidenceQuotes(v: unknown): EvaluationEvidenceQuote[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: EvaluationEvidenceQuote[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const quote = pickStr(item, "quote");
    if (!quote) {
      continue;
    }
    const ts =
      parseNumberMs(item.timestamp_ms) ??
      parseNumberMs(item.timestampMs) ??
      parseNumberMs(item.start_ms) ??
      parseNumberMs(item.startMs);
    if (ts === undefined) {
      continue;
    }
    const src = normalizeEvidenceSource(item.source);
    const row: EvaluationEvidenceQuote = { quote, timestampMs: Math.round(ts) };
    if (src) {
      row.source = src;
    }
    out.push(row);
  }
  return out.length > 0 ? out : undefined;
}

function parseRationalePoints(v: unknown): DimensionRationalePoint[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: DimensionRationalePoint[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const claim = pickStr(item, "claim", "text");
    if (!claim) {
      continue;
    }
    const evidence = parseEvidenceQuotes(item.evidence);
    const point: DimensionRationalePoint = { claim };
    if (evidence) {
      point.evidence = evidence;
    }
    out.push(point);
  }
  return out.length > 0 ? out : undefined;
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") {
      return v;
    }
  }
  return "";
}

function normalizeEvidenceSufficiency(v: unknown): EvaluationDimension["evidenceSufficiency"] | undefined {
  if (v === "limited" || v === "moderate" || v === "strong") {
    return v;
  }
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (s === "limited" || s === "moderate" || s === "strong") {
      return s;
    }
  }
  return undefined;
}

function normalizeRoundOutcome(v: unknown): RoundOutcomePrediction | undefined {
  if (
    v === "strong_pass" ||
    v === "pass" ||
    v === "borderline" ||
    v === "weak_no_pass"
  ) {
    return v;
  }
  if (typeof v === "string") {
    const s = v.toLowerCase().trim().replace(/\s+/g, "_");
    if (
      s === "strong_pass" ||
      s === "pass" ||
      s === "borderline" ||
      s === "weak_no_pass"
    ) {
      return s as RoundOutcomePrediction;
    }
  }
  return undefined;
}

function parsePrepSuggestions(v: unknown): PrepSuggestionItem[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: PrepSuggestionItem[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const weakness = pickStr(item, "weakness");
    const prescription = pickStr(item, "prescription");
    const goal = pickStr(item, "goal");
    if (!weakness && !prescription && !goal) {
      continue;
    }
    out.push({ weakness, prescription, goal });
  }
  return out.length > 0 ? out : undefined;
}

function parseWhatToSayDifferently(v: unknown): WhatToSayDifferentlyItem[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: WhatToSayDifferentlyItem[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const situation = pickStr(item, "situation");
    const betterPhrasing = pickStr(item, "better_phrasing", "betterPhrasing");
    const whyItHelps = pickStr(item, "why_it_helps", "whyItHelps");
    if (!situation && !betterPhrasing && !whyItHelps) {
      continue;
    }
    out.push({ situation, betterPhrasing, whyItHelps });
  }
  return out.length > 0 ? out : undefined;
}

function parseSpeechCodeConflicts(v: unknown): SpeechCodeConflict[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: SpeechCodeConflict[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const speechEvidence =
      parseEvidenceQuotes(item.speech_evidence) ??
      parseEvidenceQuotes(item.speechEvidence) ??
      [];
    const codeEvidence =
      parseEvidenceQuotes(item.code_evidence) ??
      parseEvidenceQuotes(item.codeEvidence) ??
      [];
    out.push({
      timeRange: pickStr(item, "time_range", "timeRange"),
      issue: pickStr(item, "issue"),
      speechEvidence,
      codeEvidence,
      whyItMatters: pickStr(item, "why_it_matters", "whyItMatters"),
      coachingAdvice: pickStr(item, "coaching_advice", "coachingAdvice"),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseChronologicalTurningPoints(v: unknown): ChronologicalTurningPoint[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: ChronologicalTurningPoint[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const evidence = parseEvidenceQuotes(item.evidence) ?? [];
    out.push({
      timeRange: pickStr(item, "time_range", "timeRange"),
      phase: pickStr(item, "phase"),
      observation: pickStr(item, "observation"),
      evidence,
      impact: pickStr(item, "impact"),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseDecisionTrace(v: unknown): DecisionTraceStep[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: DecisionTraceStep[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const evidenceUsed = parseEvidenceQuotes(item.evidence_used) ?? parseEvidenceQuotes(item.evidenceUsed) ?? [];
    out.push({
      step: pickStr(item, "step"),
      whatWasChecked: pickStr(item, "what_was_checked", "whatWasChecked"),
      evidenceUsed,
      conclusion: pickStr(item, "conclusion"),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parses model JSON into {@link InterviewEvaluationPayload}.
 * Expects snake_case keys per `interview-evaluation-system.md`; accepts camelCase aliases where noted.
 */
export function parseInterviewEvaluationJson(
  rawText: string,
  providerId: string,
  modelId: string | null,
): InterviewEvaluationPayload {
  let parsed: unknown;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      status: "failed",
      provider: providerId,
      model: modelId,
      errorMessage: "Model returned non-JSON output.",
    };
  }

  if (!isRecord(parsed)) {
    return {
      status: "failed",
      provider: providerId,
      model: modelId,
      errorMessage: "Expected a JSON object from the model.",
    };
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
  const finalOutcome =
    typeof parsed.final_outcome === "string"
      ? parsed.final_outcome
      : typeof parsed.finalOutcome === "string"
        ? parsed.finalOutcome
        : undefined;
  const interviewProcessQuality =
    typeof parsed.interview_process_quality === "string"
      ? parsed.interview_process_quality
      : typeof parsed.interviewProcessQuality === "string"
        ? parsed.interviewProcessQuality
        : undefined;
  const hireSignalSummary =
    typeof parsed.hire_signal_summary === "string"
      ? parsed.hire_signal_summary
      : typeof parsed.hireSignalSummary === "string"
        ? parsed.hireSignalSummary
        : undefined;
  const roundOutcomePrediction =
    normalizeRoundOutcome(parsed.round_outcome_prediction) ??
    normalizeRoundOutcome(parsed.roundOutcomePrediction);

  const strengths = asStringArray(parsed.strengths);
  const weaknesses = asStringArray(parsed.weaknesses);
  const missedOpportunities =
    asStringArray(parsed.missed_opportunities) ?? asStringArray(parsed.missedOpportunities);
  const missedInterviewerFriendlyBehaviors =
    asStringArray(parsed.missed_interviewer_friendly_behaviors) ??
    asStringArray(parsed.missedInterviewerFriendlyBehaviors);

  const prepSuggestions =
    parsePrepSuggestions(parsed.prep_suggestions) ?? parsePrepSuggestions(parsed.prepSuggestions);
  const whatToSayDifferently =
    parseWhatToSayDifferently(parsed.what_to_say_differently) ??
    parseWhatToSayDifferently(parsed.whatToSayDifferently);
  const speechCodeConflicts =
    parseSpeechCodeConflicts(parsed.speech_code_conflicts) ??
    parseSpeechCodeConflicts(parsed.speechCodeConflicts);
  const chronologicalTurningPoints =
    parseChronologicalTurningPoints(parsed.chronological_turning_points) ??
    parseChronologicalTurningPoints(parsed.chronologicalTurningPoints);
  const alternativeStrongerPath =
    asStringArray(parsed.alternative_stronger_path) ?? asStringArray(parsed.alternativeStrongerPath);
  const decisionTrace =
    parseDecisionTrace(parsed.decision_trace) ?? parseDecisionTrace(parsed.decisionTrace);

  let dimensions: InterviewEvaluationPayload["dimensions"];
  if (isRecord(parsed.dimensions)) {
    dimensions = {};
    for (const [key, val] of Object.entries(parsed.dimensions)) {
      if (!isRecord(val)) {
        continue;
      }
      const d = val as RawDimension;
      const score = typeof d.score === "number" ? d.score : Number(d.score);
      if (!Number.isFinite(score)) {
        continue;
      }
      const evidenceSufficiency =
        normalizeEvidenceSufficiency(d.evidence_sufficiency) ??
        normalizeEvidenceSufficiency(d.evidenceSufficiency) ??
        "limited";
      const rationalePoints =
        parseRationalePoints(d.rationale_points) ?? parseRationalePoints(d.rationalePoints) ?? [];
      dimensions[key] = {
        score,
        evidenceSufficiency,
        rationalePoints,
      };
    }
    if (Object.keys(dimensions).length === 0) {
      dimensions = undefined;
    }
  }

  return {
    status: "complete",
    provider: providerId,
    model: modelId,
    summary,
    finalOutcome,
    interviewProcessQuality,
    hireSignalSummary,
    roundOutcomePrediction,
    dimensions,
    strengths,
    weaknesses,
    missedOpportunities,
    missedInterviewerFriendlyBehaviors,
    whatToSayDifferently,
    prepSuggestions,
    speechCodeConflicts,
    chronologicalTurningPoints,
    alternativeStrongerPath,
    decisionTrace,
  };
}
