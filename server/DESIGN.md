# AiInterviewCopilot — Server Design

This document describes the **Node/TypeScript HTTP server** under `server/`: responsibilities, architecture, persistence, APIs, and how it relates to the **offline video/e2e pipeline**.

---

## 1. Goals

- **HTTP interviews are video-only** (`POST /api/interviews`): every job runs the **full** pipeline — **vision ROI**, **frame extract + Tesseract OCR**, **demuxed-audio Whisper STT**, and **rubric evaluation**. There is **no** audio-only shortcut.
- **Single HTTP poll** (`GET /api/interviews/:id`) for status, transcripts, and final **`result`** JSON.
- **Server startup** fails fast unless **ffmpeg**, **ffprobe**, **tesseract**, **STT**, and **vision ROI** are all available (`assertMandatoryInterviewApiConfig` in `mandatoryInterviewApiEnv.ts`).
- Share **STT + evaluation** and **`E2eInterviewPipeline`** with **CLI** (`pipelineCli e2e`). The **`AudioJobProcessor`** class remains in the codebase for non-HTTP use only; the public API does not call it.

---

## 2. Technology Stack

| Layer | Choice |
|--------|--------|
| Runtime | Node.js (ESM, TypeScript) |
| HTTP | Fastify 5, `@fastify/cors`, `@fastify/multipart` |
| ORM / DB | Prisma 6, **SQLite** (`data/app.db`) |
| External AI | OpenAI (Whisper STT, Chat Completions for ROI + rubric evaluation) |
| Local tools | `ffmpeg`, `ffprobe`, `tesseract` — **required on PATH before the API will start** (and for CLI e2e) |

---

## 3. Architecture

The repo exposes **two HTTP routes** for clients (**submit** + **result**), plus **CLI** (`pipelineCli`). All STT + rubric paths use **`SpeechTranscriptionEvaluationOrchestrator`**; HTTP persists to **Prisma** (`Job.id` is returned to clients as **`id`**).

### 3.1 HTTP (public API)

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
- **`GET /api/interviews/:id`**: **`202`** until `Result` exists; **`200`** with `result` + `transcripts`.

Artifacts: **`data/uploads/<id>/pipeline/`**. Same **`E2eInterviewPipeline`** as CLI e2e (LLM ROI is **not** optional for HTTP).

### 3.2 CLI / video pipeline path (FFmpeg, ROI, OCR)

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

### 3.3 FFmpeg / ffprobe responsibilities (detail)

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

### 3.4 OCR and downstream merge

- **`tesseractRunner.ts`**: wraps **`tesseract`** CLI; **`ocrPng(path)`** per frame PNG.
- Frame list is sorted by filename; **timestamps** come from **`frames-manifest.json`** (same length as OCR lines after alignment trimming).
- **`transcriptFormatting.ts`**: **`alignFramesToSpeech`** combines OCR timeline with Whisper segments; **`buildFinalTranscriptJson`** produces the merged structure written to **`final-transcript.json`**.

### 3.5 Boundary: API vs CLI

| Concern | HTTP API | CLI e2e / video |
|---------|----------|-----------------|
| FFmpeg / ffprobe | Yes (mandatory at startup) | Yes |
| Tesseract | Yes (mandatory at startup) | Yes (e2e / finish-e2e) |
| Vision ROI | Yes (mandatory at startup) | e2e only |
| STT + evaluation | `VideoJobProcessor` only | Same orchestrator |
| `VIDEO_OCR` + `AUDIO_STT` in DB | Both from pipeline | Files only |
| SQLite | Yes | No |

---

## 4. Data Model (Prisma)

- **`Job`** — lifecycle: `PENDING` → `PROCESSING` → `COMPLETED` | `FAILED`; optional `errorMessage`.
- **`InterviewAudio`** — for **HTTP** jobs, **always** created/updated after the pipeline with path to **`pipeline/audio.wav`** (demuxed speech track). Not used for a standalone upload on the public API.
- **`InterviewVideo`** — one-to-one for **HTTP** jobs: the uploaded **source** video path.
- **`TranscriptSegment`** — many per job; `source` is `AUDIO_STT` or `VIDEO_OCR`; times are **milliseconds** on a single session timeline; ordered by `(source, sequence, startMs)` for API responses.
- **`Result`** — one JSON `payload` per job: **`stt`** metadata + **`evaluation`**; video jobs add **`pipeline`** (`kind: "video"`, crop, counts, **`finalTranscript`**, **`alignedTimeline`**).

SQLite file: `server/data/app.db` (URL in `prisma/schema.prisma`: `file:../data/app.db` relative to `prisma/`).

---

## 5. HTTP API (client surface)

### `POST /api/interviews`

- **Multipart** field **`file`** (required) — **video container only** (must include both audio and video streams for a normal interview; FFmpeg still runs demux/STT/OCR).
- **Rejected:** `audio/*` and audio extensions with octet-stream → **`415`** (audio-only is not supported on the public API).
- Creates **`Job`** + **`InterviewVideo`**, runs **`VideoJobProcessor`** (ROI, frames, OCR, STT, eval) on the **full** source length.
- **Response `201`:** `{ id, status: "PENDING", message }` — use **`id`** with **`GET /api/interviews/:id`**.

### `GET /api/interviews/:id`

- **`404`** if no job with that **`id`**.
- **`202`** if **`Result`** is not ready: `id`, `status`, `message`, optional `errorMessage`, `transcripts` (usually empty until done).
- **`200`** when complete: `id`, `status`, `result` (JSON payload), `createdAt`, `transcripts` (STT + OCR segments when present).

---


## 6. Core Services

### `SpeechTranscriptionEvaluationOrchestrator`

- **`transcribeAndEvaluate(audioPath, jobId)`** → `{ transcription, evaluation }`.
- STT via **`ISpeechToTextService`** (OpenAI Whisper with chunked WAV for large files + retries on transient errors).
- Evaluation via **`InterviewEvaluationService`**, which calls an injected **`LlmClient`** (`OpenAiLlmClient`, `AnthropicLlmClient`, …); prompts under `prompts/`.
- Evaluation failures are **captured** in payload (`status: "failed"`) rather than throwing, matching job completion semantics.

### `SpeechTranscriptionEvaluationOrchestratorFactory`

- **`tryCreate()`** — used by **`InterviewCopilotServer`**: if `null`, **`registerRoutes()` throws** (API will not start).
- **`createOrThrow()`** — used by CLIs that require STT.

### `mandatoryInterviewApiEnv`

- **`assertMandatoryInterviewApiConfig(speechAnalysis, visionOpenAiLlm)`** — ensures binaries on PATH, STT orchestrator non-null, and the shared OpenAI **`LlmClient`** for vision ROI is non-null (same instance wired into **`EditorRoiDetectionService`**).

### `AudioJobProcessor` (non-HTTP)

- Not used by **`JobRoutesController`**. Kept for scripts or future internal jobs: STT-only persistence without the video pipeline.

### `VideoJobProcessor`

- Runs **`E2eInterviewPipeline`** with `outputDir = uploads/<jobId>/pipeline/` and **`sttEvalJobId`** = API job id.
- On success: replaces **`VIDEO_OCR`** and **`AUDIO_STT`** segments; **`upsert`** **`InterviewAudio`** pointing at **`pipeline/audio.wav`**; **`Result.payload`** includes **`stt`**, **`evaluation`**, and **`pipeline`** (merged transcript + alignment metadata).
- On failure (missing binaries, ROI/STT errors, FFmpeg errors): **`FAILED`** + `errorMessage`.
- Frame export rate: env **`VIDEO_JOB_FRAME_FPS`** (default **2**, same spirit as CLI e2e).

### Evaluation / STT factories

- **`SpeechToTextServiceFactory`** — `STT_PROVIDER` = **`remote`** (default, OpenAI Whisper only) or **`local`** (Python whisper CLI) or **`none`**; optional **`REMOTE_STT_MAX_CHUNK_BYTES`**; **`OPENAI_STT_MODEL`** on **`OpenAiLlmClient`** for Whisper.
- **`InterviewEvaluationServiceFactory`** — `EVALUATION_PROVIDER` = exactly **`openai`** (default) \| **`anthropic`** \| **`none`**; **`OPENAI_EVAL_MODEL`** / **`ANTHROPIC_EVAL_MODEL`**; builds **`InterviewEvaluationService`** or a skipped evaluator.

---

## 7. Infrastructure

- **`AppPaths`** — resolves `server/data`, `server/data/uploads`, per-job upload dirs.
- **`db.ts`** — singleton `PrismaClient`; **`index.ts`** calls **`prisma.$connect()`** before listening.
- **Entry:** `src/index.ts` — `PORT` / `HOST` from env (defaults `3001` / `127.0.0.1`).

---

## 8. CLI / E2E Pipeline (Related, Not HTTP)

| Subcommand (`pipelineCli.ts`) | Purpose |
|-------------------------------|---------|
| `e2e` | Full path: demux, ROI, cropped video, mpdecimate+fps PNGs, OCR, STT+eval, `final-transcript.json`, artifacts under `data/e2e-pipeline-test/`. |
| `video` | FFmpeg smoke: **mandatory** OpenAI editor ROI on first frame, then crop + frames + manifest (`OPENAI_API_KEY` required). |
| `finish-e2e` | Resume OCR + STT + eval in an existing output dir. |
| `stt-eval` | Re-run Whisper + rubric on `audio.wav` in an output dir. |

**npm scripts:** `pipeline:e2e`, `test:video-pipeline`, `pipeline:e2e:stt-eval`, `pipeline:e2e:finish`.

Shared concepts: **`ffmpegExtract`**, **`transcriptFormatting`**, **`editorRoiDetection`**, **`FfmpegDedupedFrameExtractor`** (service adapter).

---

## 9. Configuration (Environment)

| Variable | Role |
|----------|------|
| `OPENAI_API_KEY` | Remote STT (Whisper), OpenAI evaluation, vision ROI — required for **HTTP** video API |
| `ANTHROPIC_API_KEY` | Evaluation only when `EVALUATION_PROVIDER=anthropic` |
| `STT_PROVIDER` | Exactly **`remote`** (default), **`local`**, or **`none`** |
| `REMOTE_STT_MAX_CHUNK_BYTES` | Optional; remote STT WAV chunk size cap |
| `EVALUATION_PROVIDER` | Exactly **`openai`** (default), **`anthropic`**, or **`none`** |
| `OPENAI_STT_MODEL`, `OPENAI_EVAL_MODEL` | Whisper vs chat/eval/vision model on OpenAI (ROI uses the same chat model as eval) |
| `ANTHROPIC_EVAL_MODEL` | e.g. `claude-3-5-haiku-20241022` |
| `LOCAL_WHISPER_EXECUTABLE`, `LOCAL_WHISPER_MODEL`, `LOCAL_WHISPER_MAX_CHUNK_BYTES` | Only when `STT_PROVIDER=local` |
| `VIDEO_JOB_FRAME_FPS` | Optional fps cap after **`mpdecimate`** for API jobs (default **2**) |
| `PORT`, `HOST` | HTTP server |

**pipelineCli `video`:** requires **`OPENAI_API_KEY`** (editor ROI always runs). Optional: **`VIDEO_PATH`**, **`VIDEO_EXTRACT_FPS`**, **`VIDEO_MAX_DURATION_SEC`**.

---

## 10. Security & Operations (Current Assumptions)

- **Local / dev oriented:** wide CORS, no auth on job APIs.
- **Upload limit:** multipart `500 MiB` in `InterviewCopilotServer`.
- **Secrets:** `.env` for keys; never commit.

---

## 11. Future Extensions (Suggested)

1. **Webhook or SSE** — push `COMPLETED` instead of polling only.
2. **Postgres** — swap datasource for multi-instance deployments.
3. **Link CLI e2e dir → Job** — import existing `frames-manifest` + OCR into `VIDEO_OCR` via batch API or internal job.
4. **Idempotent segment merge** — append OCR without full replace if needed.
5. **Smaller `Result` payloads** — omit or externalize `finalTranscript` / `alignedTimeline` for very long interviews.

---

## 12. Deep dive: ROI, frame extraction, OCR, and alignment

This section matches the **current implementation** in `editorRoiDetection.ts`, `E2eInterviewPipeline.ts`, `ffmpegExtract.ts`, `tesseractRunner.ts`, and `transcriptFormatting.ts`.

### 12.1 ROI detection (what it is, not classical CV)

There is **no** traditional edge detector or template matcher for the editor region. The pipeline:

1. **Extracts one full-resolution PNG** from the source video (`ffmpeg`, `-frames:v 1`) — the **first frame** of the (optionally time-limited) clip.
2. Reads **true PNG width/height** from the file header (`readPngDimensions`) so the model and parser share the same coordinate system.
3. Sends that image to **OpenAI Chat Completions** with **`response_format: json_object`**, **`detail: "high"`** on the image, and prompts from **`prompts/roi-editor-system.md`** + **`roi-editor-user.md`**.

The **system prompt** instructs the model to:

- Transcribe any **visible interview problem text** into `problem_statement` (or null if none).
- Return a **tight axis-aligned rectangle** in **pixel integers**, origin top-left, that contains **only the code-editing surface** (monospace buffer + line-number gutter), excluding problem panels, browser chrome, nav bars, video tiles, toolbars, etc., with explicit rules against a **full-frame** box when a smaller code pane is visible.

The **API response** is parsed by `parseEditorRoiResponse`: JSON with `x`, `y`, `width`, `height` (and optional `problem_statement` / aliases). **`parseCrop`** clamps the rectangle **into the image bounds** (non-negative origin, width/height trimmed so the box stays inside `imageWidth × imageHeight`).

**`E2eInterviewPipeline`** then **snaps the crop to even width/height and even x/y** (`makeEvenCrop`) so **H.264-style** encoding (`yuv420p`) is valid — FFmpeg subsampling prefers even dimensions.

### 12.2 Cropping the video (FFmpeg)

After ROI JSON is accepted:

1. Build a **video filter**: `crop=W:H:X:Y,format=yuv420p` (e2e uses the even-snapped rect).
2. Run **`ffmpeg`** on the **original** input (with the same optional `-t` cap as earlier steps): **re-encode** the visual stream to **`video-roi-cropped.mp4`**, **no audio** (`-an`).

All **subsequent frame extraction** reads this **ROI-only** MP4, not the full recording. That reduces OCR noise and keeps timestamps on the **cropped** timeline (starting near 0 for that file).

The smoke **`VideoProcessingPipeline`** uses the same idea with a **fixed** crop from CLI args (no LLM): `crop` + `format=yuv420p` → `video-cropped.mp4`.

### 12.3 “Duplicate” frames: mpdecimate + optional fps cap

**We do not** compare PNGs in TypeScript. **Deduping is entirely FFmpeg’s `mpdecimate` filter** in `extractDedupedFramesWithTimestamps`:

- **`mpdecimate`** drops frames that are **visually similar** to the previous kept frame (FFmpeg’s internal thresholding on the **luma** plane after prior filters). It is designed for screen/content where static scenes produce many near-identical frames.
- Filter order in code: **`[optional crop] → format=gray → [optional scale] → mpdecimate → [optional fps=N] → showinfo`**.

After decimation, an optional **`fps=`** filter **caps the maximum rate** of frames that continue down the graph. **E2e** passes **`frameExportFps` default `2`**: you keep at most ~2 exports per second **among frames that already survived mpdecimate** — cheap e2e runs and smaller OCR batches, while timestamps still reflect **presentation time** of each kept frame.

**`-vsync vfr`** (variable frame rate) ties output timing to **which** frames are emitted, consistent with decimation.

### 12.4 Grayscale and scaling (OCR-oriented preprocessing)

- **`format=gray`** runs **before** `mpdecimate` so similarity and dropping are judged on **single-channel luma**, which is typical for **text / UI** and reduces color noise.
- **`scale=…`** is **optional** in `ExtractDedupedFramesOptions` (`ffmpegExtract.ts`). If provided, it is inserted **after** gray and **before** `mpdecimate`. Upscaling can help Tesseract on small fonts; **downscaling** reduces pixels. **Today’s `E2eInterviewPipeline` / `VideoProcessingPipeline` do not pass `scale`** when calling `extractFrames` — only **`fps`** (and the video path passes no crop inside the extractor because crop is already baked into the cropped MP4). The **machinery exists** for future tuning (e.g. `scale=200%` or width min).

PNG files are written as **`frame_000001.png`, …** in sort order; **timestamps are not taken from filenames**.

### 12.5 Timestamps: showinfo + pts_time

The same FFmpeg invocation uses **`-loglevel info`** and appends the **`showinfo`** filter so **stderr** contains per-frame **`pts_time:…`** lines. The Node code **streams stderr**, matches **`pts_time:`** on **`showinfo`** lines, and pushes **numeric seconds** into an array **in emission order**.

On success, it **reads the output directory**, keeps files matching **`frame_\d{6}.png`**, **sorts by name**, and **requires** `files.length === timestamps.length`. Each file is paired with **`timestamps[i]`** → **`ExtractedFrame`** / **`frames-manifest.json`** (`timestampSec`). That is the **canonical timeline** for OCR and alignment.

### 12.6 OCR (Tesseract)

For each PNG (sorted list, aligned with manifest order in e2e), **`TesseractRunner.ocrPng`** runs:

```text
tesseract <imagePath> stdout -l eng --dpi 300
```

- **English** by default (`lang` constructor arg).
- **`--dpi 300`** hints expected resolution for layout/OCR heuristics (the actual pixel dimensions come from the PNG).

There is **no** OpenAI vision step for per-frame code OCR in this path — **only Tesseract**. Empty or noisy strings are still stored; e2e may **trim** manifest vs OCR length to **`min(lengths)`** with a warning if they diverge.

### 12.7 Aligning “video” (OCR) with “audio” (speech segments)

Two different structures are produced:

| Source | Timeline | Granularity |
|--------|-----------|----------------|
| Whisper | `SpeechSegment[]` with `startSec`, `endSec`, `text` | **Intervals** (spoken phrases) |
| OCR | One string per kept frame | **Instants** (`timestampSec` per frame) |

#### A. `alignFramesToSpeech` — overlap window

For each frame index `i` (paired time + OCR text):

- Let **`t = frameTimesSec[i]`**.
- Define a **symmetric time window** **`[t - windowHalfSec, t + windowHalfSec]`** with default **`windowHalfSec = 0.75`** seconds.
- Every **speech segment** whose interval **`[startSec, endSec]`** **overlaps** that window (standard interval overlap: `a0 < b1 && b0 < a1`) is attached to that frame as **`overlappingSpeech`**.

So each frame gets **zero or more** speech snippets that are **roughly co-occurring** in time — useful for inspection and **`e2e-result.json`**’s **`alignedTimeline`**, not for rewriting Whisper text.

#### B. `buildFinalTranscriptJson` — speech-driven slices + frame bucket assignment

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

## 13. Useful Commands

```bash
cd server
npx prisma db push          # apply schema to SQLite
npm run typecheck
npm run build
npx tsx src/index.ts        # run API (set PORT/HOST as needed)
npm run pipeline:e2e -- --quick   # short e2e smoke

# Submit interview video only (returns JSON with "id")
curl -sS -X POST http://127.0.0.1:3001/api/interviews \
  -F "file=@./media/Interview.mov;type=video/quicktime"
# Poll result
curl -sS http://127.0.0.1:3001/api/interviews/<id>
```

---

*Last updated to match the codebase layout and behavior as of this document.*
