# AiInterviewCopilot — Server design (detailed)

This document is the **low-level** design for the Node/TypeScript server under `server/`: goals, architecture, data model, HTTP behavior, services, FFmpeg/OCR/STT details, and CLI alignment.

**High-level** setup, repository layout, **HTTP route summaries**, and the **Chrome extension** live in the **[repository README](../README.md)** (including [HTTP API (summary)](../README.md#http-api-summary) and [Browser extension](../README.md#browser-extension-leetcode-live-capture)).

> **Note (2026):** The classic **`POST /api/interviews`** video job pipeline, **Tesseract**, **LLM ROI**, **`pipelineCli`**, and **`E2eInterviewPipeline`** were **removed** (including **`prompts/roi-editor-*.md`**). The server still needs **ffmpeg**/**ffprobe** and **STT + evaluation** config. Sections below that describe upload-video OCR/ROI are **historical** until this file is rewritten.

---

#### 1. Goals

- **HTTP interviews are video-only** (`POST /api/interviews`): every job runs the **full** pipeline — **vision ROI**, **frame extract + Tesseract OCR**, **demuxed-audio Whisper STT**, and **rubric evaluation**. There is **no** audio-only shortcut.
- **Live LeetCode sessions** (`/api/live-sessions/…`): after **`POST …/end`**, **`LiveSessionPostProcessor`** merges **WebM**, extracts **WAV**, runs **STT + rubric** using **extension-delivered code snapshots** on the timeline — **no** vision ROI and **no** Tesseract on the merged video (uploaded-video jobs are the only path that runs frame OCR).
- **Single HTTP poll** (`GET /api/interviews/:id`) for status, **`speechTranscript`** / **`codeSnapshots`**, and final **`result`** JSON (including jobs created from ended live sessions).
- **Server startup** fails fast unless **ffmpeg**, **ffprobe**, **tesseract**, **STT**, and **vision ROI** are all available (`assertMandatoryInterviewApiConfig` in `mandatoryInterviewApiEnv.ts`).
- Share **STT + evaluation** and **`E2eInterviewPipeline`** with **CLI** (`pipelineCli e2e`). The **`AudioJobProcessor`** class remains in the codebase for non-HTTP use only; the public API does not call it.

---

#### 2. Technology Stack

| Layer | Choice |
|--------|--------|
| Runtime | Node.js (ESM, TypeScript) |
| HTTP | Fastify 5, `@fastify/cors`, `@fastify/multipart` |
| ORM / DB | Prisma 7, **SQLite** (`data/app.db`) |
| External AI | OpenAI (Whisper STT, Chat Completions for ROI + rubric evaluation) |
| Local tools | `ffmpeg`, `ffprobe`, `tesseract` — **required on PATH before the API will start** (and for CLI e2e) |

---

#### 3. Architecture

The repo exposes **classic interview job** routes (**submit** + **result**), **live-session** routes for the Chrome extension, plus **CLI** (`pipelineCli`). STT + rubric paths use **`SpeechTranscriptionEvaluationOrchestrator`**; HTTP persists to **Prisma** (`Job.id` is returned to clients as **`id`**).

##### 3.1 HTTP (public API)

```
┌─────────────────────────────────────────────────────────────────┐
│                  JobRoutesController                             │
│  POST /api/interviews   ·   GET /api/interviews/:id             │
└─────┬──────────────────────────────────────────────────────────┘
      │
      └── video file only ──► VideoJobProcessor ──► E2eInterviewPipeline ──► Prisma
            (ROI + OCR + STT + eval + derived InterviewAudio WAV)
```

- **`POST /api/interviews`**: multipart field **`file`** must be **video** (`video/*`, or `application/octet-stream` with `.mp4`, `.mov`, `.mkv`, `.avi`, `.m4v`, `.webm`). **Audio-only files → `415`**. Jobs process the **entire** uploaded file (no duration query param or env cap).
- **`GET /api/interviews/:id`**: **`202`** until `Result` exists; **`200`** with `result` + **`speechTranscript`** (STT windows) + **`codeSnapshots`** (OCR/editor instants) + **`transcripts`** (alias of `speechTranscript`).

Artifacts: **`data/uploads/<id>/pipeline/`**. Same **`E2eInterviewPipeline`** as CLI e2e (LLM ROI is **not** optional for HTTP).

##### 3.1a Live sessions (`LiveSessionRoutesController`)

```
┌─────────────────────────────────────────────────────────────────┐
│              LiveSessionRoutesController                         │
│  POST/GET /api/live-sessions  ·  PATCH /:id  ·  POST …/end      │
│  POST …/video-chunk  ·  POST …/code-snapshot                     │
│  GET …/recording.webm (merged WebM, Range-capable)               │
└─────┬───────────────────────────────────────────────────────────┘
      │
      ├── chunks on disk: data/live-sessions/<sessionId>/video-chunks/
      ├── code rows: InterviewLiveSession → LiveCodeSnapshot (session DB)
      ├── end → mergeLiveSessionRecording / remux → recording.webm
      └── LiveSessionPostProcessor: WAV extract → STT + eval (code timeline
          from snapshots) → Job + SpeechUtterance + CodeSnapshot(EDITOR_SNAPSHOT)
          + Result  (no ROI, no frame OCR)
```

- **While `ACTIVE`**, the extension streams **WebM** time slices and periodic **Monaco** code snapshots; **`PATCH`** stores the **LeetCode problem statement** (scraped in the page).
- **`POST …/end`** flips status to **`ENDED`**, writes a **playable** merged **WebM**, creates a **`Job`** with **`liveSessionId`**, and schedules **`LiveSessionPostProcessor`**: **FFmpeg** audio extract → **`SpeechTranscriptionEvaluationOrchestrator`** with **`evaluationFrameTimesSec`** / **`evaluationCodeSnapshot`** from **`LiveCodeSnapshot`** → persists **`SpeechUtterance`** + **`CodeSnapshot`** (`EDITOR_SNAPSHOT`) + **`Result`**. Merged file is **`InterviewVideo`**; **Tesseract is not used** on this path.
- Session-facing artifacts and **`interview-feedback.json`** also live under **`data/live-sessions/<id>/`** for the extension UI.

##### 3.2 CLI / video pipeline path (FFmpeg, ROI, OCR)

Triggered by **`pipelineCli.ts`** (`e2e`, `video`, `finish-e2e`, `stt-eval`). Default e2e output is **`data/e2e-pipeline-test/run-<timestamp>/`**. **SQLite is not updated** by the CLI; **API video uploads** run the same **`E2eInterviewPipeline`** class and **do** persist to the DB.

```
  input video (.mov / .mp4, …)
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  FFmpeg — demux / probe inputs (`FfmpegRunner`, ffmpegExtract.ts) │
│  • WAV: -vn pcm_s16le -ar 16000 -ac 1 → audio.wav (for Whisper)   │
│  • Optional: video-only copy (e2e)                                │
│  • First frame PNG (-frames:v 1) → first-frame.png (ROI input)   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Vision ROI (e2e only) — editorRoiDetection.ts                   │
│  First-frame PNG → OpenAI vision → crop rect + problem-statement   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  FFmpeg — ROI crop encode → video-roi-cropped.mp4 (even WxH)       │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  ffprobe — ffprobeFormatDurationSec(cropped mp4)                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Deduped frame extract (`IDedupedFrameExtractor` /               │
│  `FfmpegDedupedFrameExtractor` → extractDedupedFramesWithTimestamps) │
│  Input: ROI-cropped MP4 (e2e) or user crop (video smoke)          │
│  Filter chain: format=gray → mpdecimate → optional fps=… cap      │
│  Output: PNG sequence + parse FFmpeg stderr `showinfo` for       │
│          pts_time → per-frame timestampSeconds                     │
│  Manifest: writeFramesManifest() → frames-manifest.json            │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  OCR (`TesseractRunner` / tesseract CLI)                           │
│  One PNG at a time → raw text per frame; order aligned to manifest │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Speech + rubric (shared with API)                               │
│  SpeechTranscriptionEvaluationOrchestrator on audio.wav          │
│  → segments, duration, interview-feedback-style JSON on disk     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  transcriptFormatting.ts                                         │
│  alignFramesToSpeech() + buildFinalTranscriptJson()              │
│  → final-transcript.json, e2e-result.json (meta + alignedTimeline)│
└──────────────────────────────────────────────────────────────────┘
```

**`VideoProcessingPipeline`** (subcommand `video`) is the **FFmpeg-only** slice: extract WAV, first frame, optional fixed crop, then the same **mpdecimate + showinfo + manifest** path via `FfmpegDedupedFrameExtractor` — **no** LLM ROI, **no** Tesseract, **no** STT in that smoke run.

**`E2eInterviewPipeline`** wires the **full** chain: demux → first frame → **vision ROI** → crop encode → **ffprobe** duration → **deduped PNGs** → **Tesseract** loop → **Whisper + rubric** → **alignment** + artifact writers (`E2eSpeechAnalysisArtifacts`, etc.).

##### 3.3 FFmpeg / ffprobe responsibilities (detail)

| Step | Tool | Role in code |
|------|------|----------------|
| Audio for STT | `ffmpeg` | 16 kHz mono `pcm_s16le` WAV; matches Whisper-friendly input. |
| First frame | `ffmpeg` | Single PNG for ROI model (`first-frame.png`). |
| ROI crop encode | `ffmpeg` | `-vf crop=…` (even dimensions enforced in TS) → cropped MP4 fed to frame extract. |
| Duration | `ffprobe` | `format=duration` on cropped file for logging / sanity. |
| Frame export | `ffmpeg` | Filter graph: gray → **mpdecimate** (drop near-duplicates) → optional **fps** cap (e2e default **2 fps** after decimate). **`-vsync vfr`** + PNG output. |
| Frame timestamps | `ffmpeg` | **`showinfo`** on stderr; parser collects **`pts_time`** per written frame — source of truth for OCR time alignment (not filename order alone). |
| Manifest | TS | `frames-manifest.json`: file name + **timestampSec** per extracted frame. |

Implementation: **`ffmpegExtract.ts`** (`FfmpegRunner`, `ffprobeFormatDurationSec`, `extractDedupedFramesWithTimestamps`, `writeFramesManifest`).

##### 3.4 OCR and downstream merge

- **`tesseractRunner.ts`**: wraps **`tesseract`** CLI; **`ocrPng(path)`** per frame PNG.
- Frame list is sorted by filename; **timestamps** come from **`frames-manifest.json`** (same length as OCR lines after alignment trimming).
- **`transcriptFormatting.ts`**: **`alignFramesToSpeech`** combines OCR timeline with Whisper segments; **`buildFinalTranscriptJson`** produces the merged structure written to **`final-transcript.json`**.

##### 3.5 Boundary: API vs CLI

| Concern | HTTP API | CLI e2e / video |
|---------|----------|-----------------|
| FFmpeg / ffprobe | Yes (mandatory at startup) | Yes |
| Tesseract | Yes (mandatory at startup) | Yes (e2e / finish-e2e) |
| Vision ROI | Yes (mandatory at startup) | e2e only |
| STT + evaluation | `VideoJobProcessor` + **`LiveSessionPostProcessor`** | Same orchestrator |
| **SQLite speech + code** | **`SpeechUtterance`** (STT windows) + **`CodeSnapshot`** (`VIDEO_OCR` from frames, `EDITOR_SNAPSHOT` from live) | Files only (no DB) |
| Live sessions | **`LiveSessionRoutesController`** + `data/live-sessions/` | No |
| SQLite | Yes | No |

---

#### 4. Data Model (Prisma)

- **`Job`** — lifecycle: `PENDING` → `PROCESSING` → `COMPLETED` | `FAILED`; optional `errorMessage`; optional **`liveSessionId`** when spawned from **`LiveSessionPostProcessor`**.
- **`InterviewLiveSession`** — browser live capture: `ACTIVE` | `ENDED`, optional **`question`** (problem text), timestamps.
- **`LiveVideoChunk`** — ordered **WebM** slice files per session (`sequence`, `filePath`, mime/size metadata).
- **`LiveCodeSnapshot`** — **canonical session capture**: editor **`code`** + **`offsetSeconds`** (+ `sequence`, `capturedAt`) before a post-process job exists. Used as input to STT+eval and copied into job-level **`CodeSnapshot`** (`EDITOR_SNAPSHOT`) after post-process.
- **`InterviewAudio`** — path to **16 kHz mono WAV** used for STT (video: `uploads/<jobId>/pipeline/audio.wav`; live: `live-sessions/<sessionId>/post-process/audio.wav`).
- **`InterviewVideo`** — uploaded **source** video (classic jobs) or **merged** `recording.webm` (live jobs).
- **`SpeechUtterance`** — many per job: **speech-only** STT intervals (**`startMs`**, **`endMs`**, **`text`**, **`sequence`**, optional DB **`speakerLabel`** from diarization). Table **`speech_utterances`**. API DTO list: **`speechTranscript`** (each item includes **`speaker`**, mapped from **`speakerLabel`**; legacy alias **`transcripts`**).
- **`CodeSnapshot`** — many per job: **point-in-time** screen/editor text (**`offsetMs`** = capture instant, **`text`**, **`sequence`**). Enum **`CodeSnapshotSource`**: **`VIDEO_OCR`** (Tesseract on ROI frames from **uploaded-video** pipeline) \| **`EDITOR_SNAPSHOT`** (from **live** `LiveCodeSnapshot` rows). Table **`code_snapshots`**. API: **`codeSnapshots`** on **`GET /api/interviews/:id`**.
- **`Result`** — one JSON `payload` per job: **`stt`** metadata + **`evaluation`**; video jobs add **`pipeline`** (`kind: "video"`, crop, counts, **`finalTranscript`**, **`alignedTimeline`**); live jobs use **`pipeline.kind: "live_session"`** (paths under post-process dir).

**Separation:** speech uses **time windows** (`startMs`–`endMs`); code uses **single instants** (`offsetMs`). Same interview timeline (ms from start).

SQLite file: `data/app.db` at repo root (see `prisma.config.ts` / `DATABASE_URL`).

---

#### 5. HTTP API (client surface)

##### Live sessions (extension)

See **[README — HTTP API (summary)](../README.md#http-api-summary)** for the route list. Typical flow: **`POST /api/live-sessions`** → **`PATCH`** question → **`POST …/video-chunk`** (repeat) + **`POST …/code-snapshot`** (periodic) → **`POST …/end`** → poll **`GET /api/interviews/:jobId`** using **`postProcessJob.id`** from **`GET /api/live-sessions/:id`**.

##### `POST /api/interviews`

- **Multipart** field **`file`** (required) — **video container only** (must include both audio and video streams for a normal interview; FFmpeg still runs demux/STT/OCR).
- **Rejected:** `audio/*` and audio extensions with octet-stream → **`415`** (audio-only is not supported on the public API).
- Creates **`Job`** + **`InterviewVideo`**, runs **`VideoJobProcessor`** (ROI, frames, OCR, STT, eval) on the **full** source length.
- **Response `201`:** `{ id, status: "PENDING", message }` — use **`id`** with **`GET /api/interviews/:id`**.

##### `GET /api/interviews/:id`

- **`404`** if no job with that **`id`**.
- **`202`** if **`Result`** is not ready: `id`, `status`, `message`, optional `errorMessage`, `speechTranscript` / `codeSnapshots` (often empty until done), `transcripts` (= `speechTranscript`).
- **`200`** when complete: `id`, `status`, `result` (JSON payload), `createdAt`, **`speechTranscript`** (`SpeechUtteranceDto[]`), **`codeSnapshots`** (`CodeSnapshotDto[]`), **`transcripts`** (alias for `speechTranscript`).

---


#### 6. Core Services

##### `SpeechTranscriptionEvaluationOrchestrator`

- **`transcribeAndEvaluate(audioPath, jobId)`** → `{ transcription, evaluation }`.
- STT via **`ISpeechToTextService`** (OpenAI Whisper with chunked WAV for large files + retries on transient errors).
- Evaluation via **`InterviewEvaluationService`**, which calls an injected **`LlmClient`** (`OpenAiLlmClient`, `AnthropicLlmClient`, …); prompts under `prompts/`. The JSON rubric includes **dimensions** (with rationale points and optional timestamped evidence), **moment-by-moment** feedback, and related fields typed in **`interviewEvaluation.ts`** / parsed by **`interviewEvaluationJson.ts`**.
- Evaluation failures are **captured** in payload (`status: "failed"`) rather than throwing, matching job completion semantics.

##### `SpeechTranscriptionEvaluationOrchestratorFactory`

- **`create()`** — builds STT + evaluation orchestrator; **`@throws`** if speech-to-text is not configured (used by **`InterviewCopilotServer`** and CLIs).

##### `mandatoryInterviewApiEnv`

- **`assertMandatoryInterviewApiConfig(speechAnalysis, visionOpenAiLlm)`** — ensures binaries on PATH, STT orchestrator non-null, and the shared OpenAI **`LlmClient`** for vision ROI is non-null (same instance wired into **`EditorRoiDetectionService`**).

##### `AudioJobProcessor` (non-HTTP)

- Not used by **`JobRoutesController`**. Kept for scripts or future internal jobs: STT-only persistence without the video pipeline.

##### `VideoJobProcessor`

- Runs **`E2eInterviewPipeline`** with `outputDir = uploads/<jobId>/pipeline/` and **`sttEvalJobId`** = API job id.
- On success: replaces **`CodeSnapshot`** rows with `source: VIDEO_OCR` and all **`SpeechUtterance`** rows for the job; **`upsert`** **`InterviewAudio`** → **`pipeline/audio.wav`**; **`Result.payload`** includes **`stt`**, **`evaluation`**, **`pipeline`** (video kind: `finalTranscript`, `alignedTimeline`, counts).
- On failure (missing binaries, ROI/STT errors, FFmpeg errors): **`FAILED`** + `errorMessage`.
- Frame export rate: env **`VIDEO_JOB_FRAME_FPS`** (default **2**, same spirit as CLI e2e).

##### `LiveSessionPostProcessor`

- After **`InterviewLiveSession`** ends: merge WebM, **FFmpeg** extract WAV, call **`SpeechTranscriptionEvaluationOrchestrator.transcribeAndEvaluate`** with times/texts from **`LiveCodeSnapshot`**, optionally **`carryForwardEditorSnapshots`**, **`problemStatementText`** from session **`question`**.
- On success: **`SpeechUtterance`** + **`CodeSnapshot`** (`EDITOR_SNAPSHOT`) **`createMany`**; **`InterviewAudio`**, **`Result`**, **`Job` COMPLETED**; artifacts under **`data/live-sessions/<id>/post-process/`**.
- **Does not** invoke **`E2eInterviewPipeline`**, ROI, or Tesseract.

##### Evaluation / STT factories

- **`SpeechToTextServiceFactory`** — `STT_PROVIDER` = **`remote`** (default, OpenAI Whisper only) or **`local`** (Python whisper CLI); **`none`** is rejected for the HTTP API; optional **`REMOTE_STT_MAX_CHUNK_BYTES`**; remote Whisper uses fixed **`whisper-1`** on **`OpenAiLlmClient`** (not `OPENAI_MODEL_ID`).
- **`InterviewEvaluationServiceFactory`** — `EVALUATION_PROVIDER` = **`llm`** (one-shot) \| **`single-agent`** (tool agent); **`LLM_PROVIDER`** = **`openai`** \| **`anthropic`** (shared with **`LlmClientFactory`**, WhisperX role mapping); **`OPENAI_MODEL_ID`** / **`ANTHROPIC_MODEL_ID`**; builds **`InterviewEvaluationService`** or **`SingleAgentInterviewEvaluator`**.

---

#### 7. Infrastructure

- **`AppPaths`** — resolves `server/data`, `server/data/uploads`, per-job upload dirs, and **`data/live-sessions/<sessionId>/`** (chunks, merged **`recording.webm`**, post-process artifacts).
- **`db.ts`** — singleton `PrismaClient`; **`index.ts`** calls **`prisma.$connect()`** before listening.
- **Entry:** `src/index.ts` — `PORT` / `HOST` from env (defaults `3001` / `127.0.0.1`).

---

#### 8. CLI / E2E Pipeline (Related, Not HTTP)

| Subcommand (`pipelineCli.ts`) | Purpose |
|-------------------------------|---------|
| `e2e` | Full path: demux, ROI, cropped video, mpdecimate+fps PNGs, OCR, STT+eval, `final-transcript.json`, artifacts under `data/e2e-pipeline-test/`. |
| `video` | FFmpeg smoke: **mandatory** OpenAI editor ROI on first frame, then crop + frames + manifest (`OPENAI_API_KEY` required). |
| `finish-e2e` | Resume OCR + STT + eval in an existing output dir. |
| `stt-eval` | Re-run Whisper + rubric on `audio.wav` in an output dir. |

**npm scripts:** `pipeline:e2e`, `test:video-pipeline`, `pipeline:e2e:stt-eval`, `pipeline:e2e:finish`.

Shared concepts: **`ffmpegExtract`**, **`transcriptFormatting`**, **`editorRoiDetection`**, **`FfmpegDedupedFrameExtractor`** (service adapter).

---

#### 9. Configuration (Environment)

| Variable | Role |
|----------|------|
| `OPENAI_API_KEY` | Remote STT (Whisper), OpenAI evaluation, vision ROI — required for **HTTP** video API |
| `ANTHROPIC_API_KEY` | Required when `LLM_PROVIDER=anthropic` |
| `STT_PROVIDER` | **`remote`** (default) or **`local`**; **`none`** rejected for the interview HTTP API |
| `REMOTE_STT_MAX_CHUNK_BYTES` | Optional; remote STT WAV chunk size cap |
| `EVALUATION_PROVIDER` | Exactly **`llm`** or **`single-agent`** (evaluator mode) |
| `LLM_PROVIDER` | Exactly **`openai`** or **`anthropic`** (app-wide chat LLM: eval, `LlmClientFactory`, WhisperX mapping) |
| `OPENAI_MODEL_ID` | Chat/eval/vision model on OpenAI (ROI uses the same model); remote Whisper STT uses `whisper-1` in code |
| `ANTHROPIC_MODEL_ID` | e.g. `claude-opus-4-6` when `LLM_PROVIDER=anthropic` |
| `WHISPER_MODEL` | Whisper **size** for local CLI + WhisperX (fallback: `LOCAL_WHISPER_MODEL`, `WHISPERX_MODEL`) |
| `LOCAL_WHISPER_EXECUTABLE`, `LOCAL_WHISPER_MAX_CHUNK_BYTES` | Only when `STT_PROVIDER=local` |
| `VIDEO_JOB_FRAME_FPS` | Optional fps cap after **`mpdecimate`** for API jobs (default **2**) |
| `PORT`, `HOST` | HTTP server |

**pipelineCli `video`:** requires **`OPENAI_API_KEY`** (editor ROI always runs). Optional: **`VIDEO_PATH`**, **`VIDEO_EXTRACT_FPS`**, **`VIDEO_MAX_DURATION_SEC`**.

---

#### 10. Security & Operations (Current Assumptions)

- **Local / dev oriented:** wide CORS, no auth on job APIs.
- **Upload limit:** multipart `500 MiB` in `InterviewCopilotServer`.
- **Secrets:** `.env` for keys; never commit.

---

#### 11. Future Extensions (Suggested)

1. **Webhook or SSE** — push `COMPLETED` instead of polling only.
2. **Postgres** — swap datasource for multi-instance deployments.
3. **Link CLI e2e dir → Job** — import existing `frames-manifest` + OCR into **`CodeSnapshot`** (`VIDEO_OCR`) via batch API or internal job.
4. **Idempotent code rows** — append snapshots without full replace if needed.
5. **Smaller `Result` payloads** — omit or externalize `finalTranscript` / `alignedTimeline` for very long interviews.

---

#### 12. Deep dive: ROI, frame extraction, OCR, and alignment

This section matches the **current implementation** in `editorRoiDetection.ts`, `E2eInterviewPipeline.ts`, `ffmpegExtract.ts`, `tesseractRunner.ts`, and `transcriptFormatting.ts`.

##### 12.1 ROI detection (what it is, not classical CV)

There is **no** traditional edge detector or template matcher for the editor region. The pipeline:

1. **Extracts one full-resolution PNG** from the source video (`ffmpeg`, `-frames:v 1`) — the **first frame** of the (optionally time-limited) clip.
2. Reads **true PNG width/height** from the file header (`readPngDimensions`) so the model and parser share the same coordinate system.
3. ~~Sends that image to OpenAI Chat Completions with `response_format: json_object`, `detail: "high"`, and prompts from `prompts/roi-editor-*.md` (those prompt files were **removed** with the ROI pipeline).~~

The **system prompt** instructs the model to:

- Transcribe any **visible interview problem text** into `problem_statement` (or null if none).
- Return a **tight axis-aligned rectangle** in **pixel integers**, origin top-left, that contains **only the code-editing surface** (monospace buffer + line-number gutter), excluding problem panels, browser chrome, nav bars, video tiles, toolbars, etc., with explicit rules against a **full-frame** box when a smaller code pane is visible.

The **API response** is parsed by `parseEditorRoiResponse`: JSON with `x`, `y`, `width`, `height` (and optional `problem_statement` / aliases). **`parseCrop`** clamps the rectangle **into the image bounds** (non-negative origin, width/height trimmed so the box stays inside `imageWidth × imageHeight`).

**`E2eInterviewPipeline`** then **snaps the crop to even width/height and even x/y** (`makeEvenCrop`) so **H.264-style** encoding (`yuv420p`) is valid — FFmpeg subsampling prefers even dimensions.

##### 12.2 Cropping the video (FFmpeg)

After ROI JSON is accepted:

1. Build a **video filter**: `crop=W:H:X:Y,format=yuv420p` (e2e uses the even-snapped rect).
2. Run **`ffmpeg`** on the **original** input (with the same optional `-t` cap as earlier steps): **re-encode** the visual stream to **`video-roi-cropped.mp4`**, **no audio** (`-an`).

All **subsequent frame extraction** reads this **ROI-only** MP4, not the full recording. That reduces OCR noise and keeps timestamps on the **cropped** timeline (starting near 0 for that file).

The smoke **`VideoProcessingPipeline`** uses the same idea with a **fixed** crop from CLI args (no LLM): `crop` + `format=yuv420p` → `video-cropped.mp4`.

##### 12.3 “Duplicate” frames: mpdecimate + optional fps cap

**We do not** compare PNGs in TypeScript. **Deduping is entirely FFmpeg’s `mpdecimate` filter** in `extractDedupedFramesWithTimestamps`:

- **`mpdecimate`** drops frames that are **visually similar** to the previous kept frame (FFmpeg’s internal thresholding on the **luma** plane after prior filters). It is designed for screen/content where static scenes produce many near-identical frames.
- Filter order in code: **`[optional crop] → format=gray → [optional scale] → mpdecimate → [optional fps=N] → showinfo`**.

After decimation, an optional **`fps=`** filter **caps the maximum rate** of frames that continue down the graph. **E2e** passes **`frameExportFps` default `2`**: you keep at most ~2 exports per second **among frames that already survived mpdecimate** — cheap e2e runs and smaller OCR batches, while timestamps still reflect **presentation time** of each kept frame.

**`-vsync vfr`** (variable frame rate) ties output timing to **which** frames are emitted, consistent with decimation.

##### 12.4 Grayscale and scaling (OCR-oriented preprocessing)

- **`format=gray`** runs **before** `mpdecimate` so similarity and dropping are judged on **single-channel luma**, which is typical for **text / UI** and reduces color noise.
- **`scale=…`** is **optional** in `ExtractDedupedFramesOptions` (`ffmpegExtract.ts`). If provided, it is inserted **after** gray and **before** `mpdecimate`. Upscaling can help Tesseract on small fonts; **downscaling** reduces pixels. **Today’s `E2eInterviewPipeline` / `VideoProcessingPipeline` do not pass `scale`** when calling `extractFrames` — only **`fps`** (and the video path passes no crop inside the extractor because crop is already baked into the cropped MP4). The **machinery exists** for future tuning (e.g. `scale=200%` or width min).

PNG files are written as **`frame_000001.png`, …** in sort order; **timestamps are not taken from filenames**.

##### 12.5 Timestamps: showinfo + pts_time

The same FFmpeg invocation uses **`-loglevel info`** and appends the **`showinfo`** filter so **stderr** contains per-frame **`pts_time:…`** lines. The Node code **streams stderr**, matches **`pts_time:`** on **`showinfo`** lines, and pushes **numeric seconds** into an array **in emission order**.

On success, it **reads the output directory**, keeps files matching **`frame_\d{6}.png`**, **sorts by name**, and **requires** `files.length === timestamps.length`. Each file is paired with **`timestamps[i]`** → **`ExtractedFrame`** / **`frames-manifest.json`** (`timestampSec`). That is the **canonical timeline** for OCR and alignment.

##### 12.6 OCR (Tesseract)

For each PNG (sorted list, aligned with manifest order in e2e), **`TesseractRunner.ocrPng`** runs:

```text
tesseract <imagePath> stdout -l eng --dpi 300
```

- **English** by default (`lang` constructor arg).
- **`--dpi 300`** hints expected resolution for layout/OCR heuristics (the actual pixel dimensions come from the PNG).

There is **no** OpenAI vision step for per-frame code OCR in this path — **only Tesseract**. Empty or noisy strings are still stored; e2e may **trim** manifest vs OCR length to **`min(lengths)`** with a warning if they diverge.

##### 12.7 Aligning “video” (OCR) with “audio” (speech segments)

Two different structures are produced:

| Source | Timeline | Granularity |
|--------|-----------|----------------|
| Whisper | `SpeechSegment[]` with `startSec`, `endSec`, `text` | **Intervals** (spoken phrases) |
| OCR | One string per kept frame | **Instants** (`timestampSec` per frame) |

###### A. `alignFramesToSpeech` — overlap window

For each frame index `i` (paired time + OCR text):

- Let **`t = frameTimesSec[i]`**.
- Define a **symmetric time window** **`[t - windowHalfSec, t + windowHalfSec]`** with default **`windowHalfSec = 0.75`** seconds.
- Every **speech segment** whose interval **`[startSec, endSec]`** **overlaps** that window (standard interval overlap: `a0 < b1 && b0 < a1`) is attached to that frame as **`overlappingSpeech`**.

So each frame gets **zero or more** speech snippets that are **roughly co-occurring** in time — useful for inspection and **`e2e-result.json`**’s **`alignedTimeline`**, not for rewriting Whisper text.

###### B. `buildFinalTranscriptJson` — speech-driven slices + frame bucket assignment

This builds **`final-transcript.json`**:

1. **Sort** speech segments by `startSec`.
2. **`pairN = min(frameTimestamps.length, ocrTexts.length)`** — only paired prefix is used.
3. **`durationSec`** = max of transcription `durationSec`, max frame time, max segment end (and a tiny floor) so the timeline has finite extent.
4. **`buildTimelineSlices`** partitions **`[0, durationSec]`** into ordered slices:
   - **Leading gap** (before first speech),
   - **Speech** slices (one per segment, trimmed text),
   - **Gaps between** segments,
   - **Trailing gap** after last speech (or **full gap** if no segments).
5. Each slice becomes one **`FinalTranscriptSegment`** stub with **`start` / `end` in milliseconds** and **`audioTranscript`** (speech text or empty for gaps).
6. For each frame **`i < pairN`** at time **`t`**, **`timeInSlice(t, slice)`** decides **which slice owns that instant**:
   - **Speech** and **gap** slices use inclusive/exclusive rules consistent with their kind (e.g. gap_between uses **`t > afterSec && t < beforeSec`**).
7. The frame’s OCR text is **`push`**ed into that slice’s **`frameData`** as `{ frameNumber, text }`. If **no** slice contains **`t`**, the frame is **appended to the last** output segment (fallback).

**Net effect:** the **primary structure follows Whisper’s timeline** (what was said when). **OCR lines are grouped under the speech interval (or gap)** that contains their **`pts_time`**, so code visible on screen is **associated with the nearest narrative time** without changing Whisper’s words.

---

#### 13. Useful Commands

```bash
cd server
npx prisma db push          # apply schema to SQLite
npm run typecheck
npm run build
npx tsx src/index.ts        # run API (set PORT/HOST as needed)
npm run pipeline:e2e -- --quick   # short e2e smoke

# Submit interview video only (returns JSON with "id")
curl -sS -X POST http://127.0.0.1:3001/api/interviews \
  -F "file=@/path/to/your-interview.mov;type=video/quicktime"
# Poll result
curl -sS http://127.0.0.1:3001/api/interviews/<id>
```

---

*Low-level server design; the repository [README](../README.md) holds setup, API summaries, and extension notes.*
