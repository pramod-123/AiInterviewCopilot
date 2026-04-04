-- Maintenance SQL for synthetic live session (no TypeScript changes required).
-- DB path: repo root `data/app.db` unless DATABASE_URL points elsewhere.
-- Run: sqlite3 /path/to/app.db < server/fixtures/synthetic/synthetic-session-db-operations.sql
-- Or: sqlite3 /path/to/app.db "PRAGMA busy_timeout=60000; ..."  (one statement at a time if preferred)

PRAGMA foreign_keys = ON;

-- Session id (matches src/fixtures/syntheticLongestSubstringLiveSession.ts)
-- a0000001-0001-4000-8001-000000000001

-- -----------------------------------------------------------------------------
-- 1) Clear post-process job so POST /api/live-sessions/:id/end can schedule again
--    (same effect as: npx tsx scripts/reset-live-session-post-process.ts <id>)
--    You must still delete post-process files on disk separately if you want a
--    clean artifact dir; the TS reset script does both.
-- -----------------------------------------------------------------------------

DELETE FROM Job
WHERE liveSessionId = 'a0000001-0001-4000-8001-000000000001';

-- -----------------------------------------------------------------------------
-- 2) Optional: change stored problem text for evaluation (session.question)
-- -----------------------------------------------------------------------------

-- UPDATE InterviewLiveSession
-- SET question = 'Your problem statement here…',
--     updatedAt = datetime('now')
-- WHERE id = 'a0000001-0001-4000-8001-000000000001';

-- -----------------------------------------------------------------------------
-- 3) Optional: point the single video chunk at another file on disk
--    (e.g. after ffmpeg to WebM, or a new synthetic export path)
-- -----------------------------------------------------------------------------

-- UPDATE LiveVideoChunk
-- SET
--   filePath = '/absolute/path/to/server/data/live-sessions/a0000001-0001-4000-8001-000000000001/video-chunks/your-file.webm',
--   mimeType = 'video/webm',
--   sizeBytes = 12345678
-- WHERE sessionId = 'a0000001-0001-4000-8001-000000000001'
--   AND sequence = 0;

-- -----------------------------------------------------------------------------
-- 4) Inspect current state
-- -----------------------------------------------------------------------------

-- SELECT id, status, length(question) AS questionLen FROM InterviewLiveSession
--   WHERE id = 'a0000001-0001-4000-8001-000000000001';
-- SELECT id, sequence, filePath, mimeType, sizeBytes FROM LiveVideoChunk
--   WHERE sessionId = 'a0000001-0001-4000-8001-000000000001';
-- SELECT id, status, liveSessionId FROM Job
--   WHERE liveSessionId = 'a0000001-0001-4000-8001-000000000001';
