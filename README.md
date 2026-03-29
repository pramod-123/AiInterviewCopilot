# Ai Interview Copilot

Backend service that ingests **interview screen recordings**, extracts an **editor ROI** (vision), runs **frame OCR** (Tesseract) and **speech-to-text** (Whisper), then produces a structured **rubric evaluation** (LLM). Exposes a small **HTTP API** for uploading video jobs and polling results.

## Repository layout

| Path | Purpose |
|------|---------|
| `server/` | Node.js + Fastify app, Prisma (SQLite), video pipeline, prompts |
| `server/tst/` | Vitest unit tests |
| `server/DESIGN.md` | Architecture and API notes |

## Prerequisites

- **Node.js** 20+ (see [`.nvmrc`](./.nvmrc); 22 recommended)
- **ffmpeg** & **ffprobe** (demux, WAV, crop, frames)
- **tesseract** (OCR on ROI frames)
- **OpenAI API key** for remote Whisper, vision ROI, and (by default) evaluation

## Quick start

```bash
cd server
cp .env.example .env
# Edit .env: set OPENAI_API_KEY and any optional overrides

npm ci
npx prisma generate
npx prisma db push

npm run dev
```

Server listens on `http://127.0.0.1:3001` by default (`PORT` / `HOST` in `.env`).

## HTTP API

- **`POST /api/interviews`** — multipart field `file`: interview **video** (e.g. `.mov`, `.mp4`)
- **`GET /api/interviews/:id`** — job status; when complete, includes `result` (STT summary, evaluation payload, pipeline metadata) and `transcripts`

## Scripts (from `server/`)

| Command | Description |
|---------|-------------|
| `npm run dev` | Watch mode (`tsx`) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled app |
| `npm test` | Unit tests |
| `npm run test:coverage` | Tests + coverage report in `coverage/` |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript `--noEmit` |

## Configuration

Copy [`server/.env.example`](./server/.env.example) to `server/.env`. Never commit real keys.

## Security

- Keep `.env` out of git (see root [`.gitignore`](./.gitignore)).
- Uploaded artifacts and the SQLite DB live under `server/data/` (ignored by git).
- See [`SECURITY.md`](./SECURITY.md) for reporting vulnerabilities.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
