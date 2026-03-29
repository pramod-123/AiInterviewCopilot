Job id: {{JOB_ID}}

## Interview problem / prompt (vision-extracted)

**Source:** text read from the **first frame** of the recording by a vision model (problem description panel, statement, constraints—whatever was visible). **Not** the same as editor OCR inside the timeline below. May be incomplete or empty if nothing readable was on screen. Use this as the **stated task** when judging whether their approach and code address the right problem.

{{PROBLEM_STATEMENT}}

## Interview timeline (JSON)

The following is a **JSON array** (pretty-printed). Each element is one **time interval** on the interview recording (same wall-clock timeline as the transcribed audio).

- **`start`** (number) — interval start in **milliseconds** from the start of the recording.
- **`end`** (number) — interval end in **milliseconds** (`end` ≥ `start`).
- **`speech`** (string) — speech-to-text for that interval (Whisper). May be empty during silent gaps.
- **`frameData`** (array of strings) — **progressive** editor OCR snapshots for that interval, in **time order**: each string is the raw Tesseract output from **one** frame cropped to the code-editor ROI. The editor **evolves** as the candidate types; read strings **in array order** and do not treat them as a single static source file. OCR is **noisy** (misreads, UI chrome). For **audio-only** jobs, `frameData` is typically `[]` for every interval.

{{INTERVIEW_TIMELINE_JSON}}
