Job id: {{JOB_ID}}

## Interview problem / prompt (vision-extracted)

Source:
- Extracted from the FIRST frame of the recording (problem statement panel, constraints, examples, etc.)
- This is NOT the same as editor OCR in the timeline

Notes:
- May be incomplete or empty
- If present, treat this as the official task definition
- If missing, infer the task cautiously from speech + code and explicitly mention ambiguity

{{PROBLEM_STATEMENT}}

---

## Interview timeline (JSON)

The following is a JSON array of time-ordered intervals representing the interview.

Each element contains:

- start (number): start time in milliseconds from recording start
- end (number): end time in milliseconds (end ≥ start)
- speech (string): transcript of what the candidate said during this interval (may be empty)
- frameData (array of strings): progressive OCR snapshots of the code editor

---

## CRITICAL: frameData semantics

frameData is NOT a single code file.

It represents a sequence of snapshots of the editor over time.

Within each interval:
- Each string is a later snapshot than the previous one
- Code may be partially written, edited, or overwritten

Across intervals:
- Code evolves continuously as the candidate types and debugs

You MUST:
- Read frameData in order (earlier → later)
- Track how the code changes over time
- Distinguish between:
  - initial drafts
  - implementation
  - corrections / debugging

Do NOT:
- Merge snapshots into a perfect final program
- Assume missing code exists
- Ignore earlier mistakes or later fixes

---

## OCR Accuracy

OCR is accurate and should be treated as exact code visible on screen.

Rules:
- Do NOT guess or reconstruct missing code
- Do NOT infer logic not present in OCR or speech
- Use exact code snippets when referencing implementation
- Prefer quoting actual code instead of paraphrasing

---

## How to interpret signals

You are given three sources of truth:

1. Problem statement → what the candidate was asked to solve
2. Speech → what the candidate is thinking and explaining
3. Code (frameData) → what the candidate actually implemented

When analyzing:
- Use speech to understand intent and reasoning
- Use code to verify implementation correctness
- Use timeline to understand progression

If there is a mismatch between speech and code, rely on code for what was actually done.

---

## Temporal expectation

This is a time-evolving interview, not a final submission.

You should:
- Evaluate how the candidate progresses
- Identify improvements, mistakes, and corrections over time
- Consider early confusion vs later clarity

---

## Evidence expectation

The assistant MUST:
- Use exact snippets from:
  - speech (quotes)
  - code (OCR snippets)
- Tie observations to specific intervals or progression when possible

Avoid vague summaries without evidence.

---

## Your response (single JSON object, snake_case keys)

You MUST return one JSON object that includes at least these top-level keys (see system prompt for full schema and dimension definitions):

- `summary`
- `dimensions` — every rubric dimension listed in the system prompt, each with `score` and `rationale_points` (array of `{ "text", "evidence": [ { "quote", "timestamp_ms", "source": "speech"|"code" } ] }`; use `[]` for `rationale_points` only when there is nothing to say for that dimension)
- `strengths`, `weaknesses`, `missed_opportunities`, `prep_suggestions` (arrays of strings)
- `speech_code_conflicts` (array of objects or `[]`)
- `moment_by_moment_feedback` (array of objects or `[]`)

Do not omit `missed_opportunities`, `speech_code_conflicts`, or `moment_by_moment_feedback`; use empty arrays when there is nothing to report.

---

## Input data

{{INTERVIEW_TIMELINE_JSON}}