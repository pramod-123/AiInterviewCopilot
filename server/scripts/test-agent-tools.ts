/**
 * Exercise {@link DaoInterviewSessionTools} against the local DB and print JSON to stdout.
 *
 * Usage (from `server/`):
 *   npx tsx scripts/test-agent-tools.ts [sessionId] [jobId]
 *
 * If `sessionId` is omitted, uses the most recently updated live session.
 * If `jobId` is omitted, uses the job with `liveSessionId` = session (if any).
 */
import "dotenv/config";
import { appDao, closeAppDatabase, openAppDatabase } from "../src/db.js";
import { DaoInterviewSessionTools } from "../src/agent-tools/InterviewSessionTools.js";

function printSection(title: string, body: unknown): void {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
  console.log(JSON.stringify(body, null, 2));
}

async function main(): Promise<void> {
  let sessionId = process.argv[2]?.trim();
  const jobIdArg = process.argv[3]?.trim();

  await openAppDatabase();

  try {
    if (!sessionId) {
      const latest = await appDao.findLatestLiveSessionId();
      if (!latest) {
        console.error("No InterviewLiveSession rows in the database.");
        console.error("Create a session or pass: npx tsx scripts/test-agent-tools.ts <sessionId> [jobId]");
        process.exit(1);
      }
      sessionId = latest;
      console.log(`(no sessionId arg — using latest session ${sessionId})`);
    }

    const job =
      jobIdArg ||
      (await appDao.findFirstJobIdByLiveSessionId(sessionId));

    const tools = new DaoInterviewSessionTools(appDao);

    const meta = await tools.getSessionMetadata(sessionId);
    printSection("getSessionMetadata", meta);

    const q = await tools.getQuestion(sessionId);
    printSection("getQuestion", q);

    const at0 = await tools.getCodeAt(sessionId, 0);
    printSection("getCodeAt(sessionId, 0)", at0);

    const at30 = await tools.getCodeAt(sessionId, 30);
    printSection("getCodeAt(sessionId, 30)", at30);

    const prog = await tools.getCodeProgressionInTimeRange(sessionId, 0, 3600);
    if (prog.ok) {
      printSection("getCodeProgressionInTimeRange(sessionId, 0, 3600)", {
        ok: true,
        data: {
          snapshotCount: prog.data.snapshots.length,
          snapshots: prog.data.snapshots.map((s) => ({
            timeStampSec: s.timeStampSec,
            textPreview: s.text.slice(0, 400),
            textLength: s.text.length,
          })),
        },
      });
    } else {
      printSection("getCodeProgressionInTimeRange(sessionId, 0, 3600)", prog);
    }

    if (!job) {
      printSection("getTranscriptionInTimeRange", {
        skipped: true,
        reason: "No jobId and no Job with liveSessionId for this session.",
      });
    } else {
      const tr = await tools.getTranscriptionInTimeRange(sessionId, job, 0, 3600);
      printSection(`getTranscriptionInTimeRange(sessionId, job=${job}, 0, 3600)`, tr);
    }

    console.log("\n");
  } finally {
    await closeAppDatabase();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
