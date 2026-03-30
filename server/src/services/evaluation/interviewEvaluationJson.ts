import type {
  DimensionEvidenceQuote,
  DimensionRationalePoint,
  EvaluationDimension,
  InterviewEvaluationPayload,
  MomentByMomentFeedbackItem,
  SpeechCodeConflict,
} from "../../types/interviewEvaluation.js";

type RawDimension = {
  score?: unknown;
  rationale?: unknown;
  evidence?: unknown;
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

function normalizeEvidenceSource(v: unknown): "speech" | "code" | undefined {
  if (v === "speech" || v === "code") {
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
  }
  return undefined;
}

function parseDimensionEvidenceQuotes(v: unknown): DimensionEvidenceQuote[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: DimensionEvidenceQuote[] = [];
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
    const row: DimensionEvidenceQuote = { quote, timestampMs: Math.round(ts) };
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
    const text = pickStr(item, "text");
    if (!text) {
      continue;
    }
    const evidence = parseDimensionEvidenceQuotes(item.evidence);
    const point: DimensionRationalePoint = { text };
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

function parseSpeechCodeConflicts(v: unknown): SpeechCodeConflict[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: SpeechCodeConflict[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    out.push({
      timeRange: pickStr(item, "time_range", "timeRange"),
      issue: pickStr(item, "issue"),
      speechEvidence: pickStr(item, "speech_evidence", "speechEvidence"),
      codeEvidence: pickStr(item, "code_evidence", "codeEvidence"),
      whyItMatters: pickStr(item, "why_it_matters", "whyItMatters"),
      coachingAdvice: pickStr(item, "coaching_advice", "coachingAdvice"),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseMomentByMomentFeedback(v: unknown): MomentByMomentFeedbackItem[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: MomentByMomentFeedbackItem[] = [];
  for (const item of v) {
    if (!isRecord(item)) {
      continue;
    }
    const evidence = asStringArray(item.evidence) ?? [];
    out.push({
      timeRange: pickStr(item, "time_range", "timeRange"),
      observation: pickStr(item, "observation"),
      evidence,
      impact: pickStr(item, "impact"),
      suggestion: pickStr(item, "suggestion"),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parses model JSON into {@link InterviewEvaluationPayload}; tolerates minor shape drift.
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
  const strengths = asStringArray(parsed.strengths);
  const weaknesses = asStringArray(parsed.weaknesses);
  const prepSuggestions =
    asStringArray(parsed.prep_suggestions) ?? asStringArray(parsed.prepSuggestions);
  const missedOpportunities =
    asStringArray(parsed.missed_opportunities) ?? asStringArray(parsed.missedOpportunities);
  const speechCodeConflicts =
    parseSpeechCodeConflicts(parsed.speech_code_conflicts) ??
    parseSpeechCodeConflicts(parsed.speechCodeConflicts);
  const momentByMomentFeedback =
    parseMomentByMomentFeedback(parsed.moment_by_moment_feedback) ??
    parseMomentByMomentFeedback(parsed.momentByMomentFeedback);

  let dimensions: InterviewEvaluationPayload["dimensions"];
  if (isRecord(parsed.dimensions)) {
    dimensions = {};
    for (const [key, val] of Object.entries(parsed.dimensions)) {
      if (!isRecord(val)) {
        continue;
      }
      const d = val as RawDimension;
      const score = typeof d.score === "number" ? d.score : Number(d.score);
      let rationale = typeof d.rationale === "string" ? d.rationale : "";
      if (!Number.isFinite(score)) {
        continue;
      }
      const evidence = asStringArray(d.evidence);
      const rationalePoints =
        parseRationalePoints(d.rationale_points) ?? parseRationalePoints(d.rationalePoints);
      if (rationalePoints && rationalePoints.length > 0 && !rationale.trim()) {
        rationale = rationalePoints.map((p) => p.text).join("\n\n");
      }
      const dim: EvaluationDimension = {
        score,
        rationale,
      };
      if (evidence && evidence.length > 0) {
        dim.evidence = evidence;
      }
      if (rationalePoints && rationalePoints.length > 0) {
        dim.rationalePoints = rationalePoints;
      }
      dimensions[key] = dim;
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
    dimensions,
    strengths,
    weaknesses,
    prepSuggestions,
    missedOpportunities,
    speechCodeConflicts,
    momentByMomentFeedback,
  };
}
