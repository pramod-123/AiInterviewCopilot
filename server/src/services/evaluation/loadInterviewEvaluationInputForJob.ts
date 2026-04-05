import type { InterviewEvaluationInput } from "../../types/interviewEvaluation.js";
import { SpeechSegment, SpeechTranscription } from "../../types/speechTranscription.js";
import type { IAppDao } from "../../dao/IAppDao.js";
import { transcriptionToEvaluationInput } from "./transcriptionToEvaluationInput.js";
import {
  applyCarryForwardEditorSnapshots,
  buildFinalTranscriptJson,
  finalTranscriptToEvaluationTimeline,
  stringifyInterviewTimelineForEvaluation,
} from "../../video-pipeline/transcriptFormatting.js";

const EVAL_PROBLEM_PAYLOAD_KEY = "evalProblemStatementText";

export type LoadInterviewEvaluationInputResult =
  | {
      ok: true;
      input: InterviewEvaluationInput;
      liveSessionId: string | null;
    }
  | { ok: false; errorMessage: string };

function readEvalProblemFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const raw = (payload as Record<string, unknown>)[EVAL_PROBLEM_PAYLOAD_KEY];
  if (typeof raw !== "string") {
    return undefined;
  }
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Builds rubric evaluation input from persisted {@link SpeechUtterance} rows and code timeline sources
 * ({@link CodeSnapshot} on the job and/or {@link LiveCodeSnapshot} on the linked live session).
 */
export async function loadInterviewEvaluationInputForJob(
  db: IAppDao,
  jobId: string,
): Promise<LoadInterviewEvaluationInputResult> {
  const job = await db.findJobForEvaluationLoad(jobId);

  if (!job) {
    return { ok: false, errorMessage: `Evaluation job not found: ${jobId}` };
  }

  const utterances = job.speechUtterances;
  if (utterances.length === 0) {
    return {
      ok: false,
      errorMessage: `No speech utterances persisted for job ${jobId}; run STT (or persist transcript) before evaluation.`,
    };
  }

  const resultRow = await db.findResultPayloadByJobId(jobId);
  const sttMeta = resultRow?.payload;
  const sttObj =
    sttMeta && typeof sttMeta === "object" && !Array.isArray(sttMeta)
      ? (sttMeta as Record<string, unknown>).stt
      : undefined;
  const providerId =
    sttObj && typeof sttObj === "object" && !Array.isArray(sttObj)
      ? String((sttObj as Record<string, unknown>).provider ?? "unknown")
      : "unknown";
  const modelId =
    sttObj && typeof sttObj === "object" && !Array.isArray(sttObj)
      ? ((v) => (typeof v === "string" ? v : null))((sttObj as Record<string, unknown>).model)
      : null;
  const language =
    sttObj && typeof sttObj === "object" && !Array.isArray(sttObj)
      ? ((v) => (typeof v === "string" ? v : null))((sttObj as Record<string, unknown>).language)
      : null;

  const segments = utterances.map(
    (u) => new SpeechSegment(u.startMs / 1000, u.endMs / 1000, u.text, u.speakerLabel),
  );
  const durationSec = Math.max(...utterances.map((u) => u.endMs)) / 1000;
  const fullText = segments.map((s) => s.text).join(" ").trim() || null;

  const transcription = new SpeechTranscription(
    segments,
    durationSec,
    language,
    fullText,
    providerId,
    modelId,
  );

  const evalInput = transcriptionToEvaluationInput(jobId, transcription);

  const [editorOnJob, videoOnJob] = await Promise.all([
    db.findJobCodeSnapshotsBySource(jobId, "EDITOR_SNAPSHOT"),
    db.findJobCodeSnapshotsBySource(jobId, "VIDEO_OCR"),
  ]);

  let timesSec: number[] = [];
  let codeTexts: string[] = [];
  let carryForward = false;

  if (editorOnJob.length > 0) {
    timesSec = editorOnJob.map((r) => r.offsetMs / 1000);
    codeTexts = editorOnJob.map((r) => r.text);
    carryForward = Boolean(job.liveSessionId);
  } else if (videoOnJob.length > 0) {
    timesSec = videoOnJob.map((r) => r.offsetMs / 1000);
    codeTexts = videoOnJob.map((r) => r.text);
    carryForward = false;
  } else if (job.liveSession?.codeSnapshots?.length) {
    timesSec = job.liveSession.codeSnapshots.map((s) => s.offsetSeconds);
    codeTexts = job.liveSession.codeSnapshots.map((s) => s.code);
    carryForward = true;
  }

  let finalTranscript = buildFinalTranscriptJson(transcription, timesSec, codeTexts);
  if (carryForward) {
    finalTranscript = applyCarryForwardEditorSnapshots(finalTranscript);
  }
  const timelineSegs = finalTranscriptToEvaluationTimeline(finalTranscript);
  evalInput.interviewTimelineJson = stringifyInterviewTimelineForEvaluation(timelineSegs);

  const fromSession = job.liveSession?.question?.trim();
  if (fromSession) {
    evalInput.problemStatementText = fromSession;
  } else {
    const fromPayload = readEvalProblemFromPayload(resultRow?.payload);
    if (fromPayload) {
      evalInput.problemStatementText = fromPayload;
    }
  }

  return {
    ok: true,
    input: evalInput,
    liveSessionId: job.liveSessionId,
  };
}
