# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

AI Interview Copilot — a Node.js/TypeScript (Fastify + Prisma/SQLite) backend that processes interview screen recordings via OCR (Tesseract), speech-to-text (OpenAI Whisper), and LLM evaluation. A companion Chrome extension (`browser-extension/`) provides live LeetCode capture. See `README.md` for full details.

### System dependencies

The server requires these binaries on `PATH`: `ffmpeg`, `ffprobe`, `tesseract`. Without them the server refuses to start (`assertMandatoryVideoPipelineBinaries`).

### Running the server

All commands run from `server/`. Standard scripts are documented in `README.md` → "Scripts" table.

- **Dev mode:** `npm run dev` (tsx watch, port 3001 by default)
- The server **requires `OPENAI_API_KEY`** in `server/.env` to start. Without it, the startup assertion in `assertMandatoryInterviewApiConfig` throws. For local dev without a real key, set a placeholder value — the server will start and respond to HTTP requests, but actual video pipeline processing (STT, vision ROI, evaluation) will fail at call time.
- `.env` is created from `.env.example` (`cp .env.example .env`); never committed.

### Lint / Test / Typecheck / Build

From `server/`:

```
npm run lint        # ESLint
npm test            # Vitest unit tests (no API keys or system binaries needed)
npm run typecheck   # tsc --noEmit
npm run build       # tsc to dist/
```

Unit tests (`server/tst/`) do **not** require ffmpeg, tesseract, or API keys — they test pure logic.

### Database

SQLite via Prisma, file at `server/data/app.db`. After `npm ci` (which runs `prisma generate` via postinstall), run `npx prisma db push` to create/sync the schema. To wipe: `npm run db:reset`.

### Hello world / smoke test

To verify the full pipeline end-to-end (requires a real `OPENAI_API_KEY`):

```bash
# Create a session, set question, submit code, upload a video chunk, and end
SID=$(curl -s -X POST http://127.0.0.1:3001/api/live-sessions | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -s -X PATCH "http://127.0.0.1:3001/api/live-sessions/$SID" -H 'Content-Type: application/json' -d '{"question":"Two Sum"}'
curl -s -X POST "http://127.0.0.1:3001/api/live-sessions/$SID/code-snapshot" -H 'Content-Type: application/json' -d '{"code":"function twoSum() {}","offsetSeconds":10}'
# Upload a WebM chunk (create one with ffmpeg if needed)
curl -s -X POST "http://127.0.0.1:3001/api/live-sessions/$SID/end"
# Poll GET /api/live-sessions/$SID until postProcessJob.status is COMPLETED
```

### Gotchas

- The `punycode` deprecation warning on server startup is a known Node 22 issue and is harmless.
- The Prisma config lives in `prisma.config.ts` (not the default `prisma/schema.prisma` alone); Prisma CLI commands auto-detect it.
- `server/data/` and `server/media/` are gitignored; the SQLite DB and uploaded artifacts live there.
- The `OPENAI_API_KEY` secret must be provided as an environment variable (injected via Cursor Secrets). The update script creates `.env` from `.env.example` if missing, but the key must be set manually or via secret injection.
- The post-processing pipeline (triggered by ending a live session) runs asynchronously in the background. Poll `GET /api/live-sessions/:id` and check `postProcessJob.status` — it transitions through `PROCESSING` → `COMPLETED` (or `FAILED`).
