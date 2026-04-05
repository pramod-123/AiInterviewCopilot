import type { IAppDao } from "../../dao/IAppDao.js";
import { mergeJsonPayload, type SpeechUtteranceInsert } from "../../dao/dto.js";
import type { SpeechTranscription } from "../../types/speechTranscription.js";
import { codeSnapshotsFromTimelineSec } from "../codeSnapshotsFromTimelineSec.js";

const EVAL_PROBLEM_PAYLOAD_KEY = "evalProblemStatementText";

export type PersistJobEvaluationArtifactsOptions = {
  problemStatementText?: string;
  evaluationFrameTimesSec?: number[];
  evaluationCodeSnapshot?: string[];
  /**
   * When code rows are written, replaces snapshots of this source on the job.
   * If omitted: `EDITOR_SNAPSHOT` when `carryForwardEditorSnapshots` is true, else `VIDEO_OCR` when code arrays are non-empty.
   */
  codeSnapshotSource?: "VIDEO_OCR" | "EDITOR_SNAPSHOT";
  carryForwardEditorSnapshots?: boolean;
};

function toUtteranceRows(jobId: string, transcription: SpeechTranscription): SpeechUtteranceInsert[] {
  return transcription.segments.map((seg, sequence) => {
    const startMs = Math.max(0, Math.round(seg.startSec * 1000));
    let endMs = Math.max(0, Math.round(seg.endSec * 1000));
    if (endMs <= startMs) {
      endMs = startMs + 1;
    }
    return {
      jobId,
      startMs,
      endMs,
      text: seg.text,
      sequence,
      speakerLabel: seg.speakerLabel,
    };
  });
}

/**
 * Ensures the job row exists, persists STT segments, optional code snapshots, and (when provided) staging
 * problem text on {@link Result.payload} for {@link loadInterviewEvaluationInputForJob} before rubric evaluation.
 */
export async function persistJobEvaluationArtifacts(
  db: IAppDao,
  jobId: string,
  transcription: SpeechTranscription,
  options?: PersistJobEvaluationArtifactsOptions,
): Promise<void> {
  await db.upsertJobProcessingShell(jobId);

  const problem = options?.problemStatementText?.trim();
  if (problem) {
    const prevRow = await db.findResultPayloadByJobId(jobId);
    const payload = mergeJsonPayload(prevRow?.payload, { [EVAL_PROBLEM_PAYLOAD_KEY]: problem });
    await db.upsertResultPayload(jobId, payload);
  }

  const segmentRows = toUtteranceRows(jobId, transcription);
  await db.deleteSpeechUtterancesByJobId(jobId);
  if (segmentRows.length > 0) {
    await db.createSpeechUtterances(segmentRows);
  }

  const times = options?.evaluationFrameTimesSec ?? [];
  const texts = options?.evaluationCodeSnapshot ?? [];
  const n = Math.min(times.length, texts.length);
  if (n > 0) {
    const source =
      options?.codeSnapshotSource ??
      (options?.carryForwardEditorSnapshots ? "EDITOR_SNAPSHOT" : "VIDEO_OCR");
    const rows = codeSnapshotsFromTimelineSec(times.slice(0, n), texts.slice(0, n)).map((r) => ({
      jobId,
      source,
      offsetMs: r.offsetMs,
      text: r.text,
      sequence: r.sequence,
    }));
    await db.deleteJobCodeSnapshotsBySource(jobId, source);
    await db.createJobCodeSnapshots(rows);
  }
}
