import type { InterviewEvaluationPayload } from "../../types/interviewEvaluation.js";

type RawDimension = { score?: unknown; rationale?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Parses model JSON into {@link InterviewEvaluationPayload}; tolerates minor shape drift.
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

  let dimensions: InterviewEvaluationPayload["dimensions"];
  if (isRecord(parsed.dimensions)) {
    dimensions = {};
    for (const [key, val] of Object.entries(parsed.dimensions)) {
      if (!isRecord(val)) {
        continue;
      }
      const d = val as RawDimension;
      const score = typeof d.score === "number" ? d.score : Number(d.score);
      const rationale = typeof d.rationale === "string" ? d.rationale : "";
      if (!Number.isFinite(score)) {
        continue;
      }
      dimensions[key] = { score, rationale };
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
  };
}
