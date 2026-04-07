Job id: {{JOB_ID}}

## Interview problem / prompt

Source:
- Provided as `problemStatementText` when available
- May come from the live session question, persisted payload, or another upstream source
- Treat this as the official task definition when present

Notes:
- It may be incomplete or missing
- If present, use it as the primary definition of what the candidate was expected to solve
- If missing, infer the task cautiously from speech + code and explicitly mention ambiguity

{{PROBLEM_STATEMENT}}

---

## Interview timeline (JSON)

The following is a JSON array of time-ordered intervals representing the interview.

Each element contains:

- `start` (number): start time in milliseconds from recording start
- `end` (number): end time in milliseconds (`end >= start`)
- `speech` (string): transcript of what the candidate said during this interval (may be empty)
- `frameData` (array of strings): progressive editor/code snapshots within this interval, in time order

---

## Critical: `frameData` semantics

`frameData` is **not** a single code file.

It represents a sequence of editor/code snapshots over time.

Within each interval:
- each string is a later snapshot than the previous one
- code may be partially written, edited, deleted, replaced, or corrected

Across intervals:
- code evolves continuously as the candidate types, revises, debugs, and refactors

You MUST:
- read `frameData` in order (earlier → later)
- track how the code changes over time
- distinguish between:
  - initial drafts
  - implementation progress
  - corrections / debugging
  - regressions if they happen
  - the final available implementation state

Do NOT:
- merge snapshots into a perfect final program that never existed on screen
- assume missing code exists
- ignore earlier mistakes or later fixes
- treat an early broken state as the final implementation if the candidate later corrected it

---

## Code snapshot accuracy

`frameData` should be treated as the exact editor/code text visible in the captured timeline.

Rules:
- do NOT guess or reconstruct code that is not present
- do NOT infer logic not supported by code or speech
- use exact code snippets when referencing implementation
- prefer quoting actual code instead of paraphrasing
- when a claim depends on surrounding context, quote the smallest complete contiguous block that supports the claim rather than isolated one-line fragments

---

## How to interpret signals

You are given up to three sources of evidence:

1. Problem statement → what the candidate was asked to solve
2. Speech → what the candidate is thinking, explaining, or claiming
3. Code (`frameData`) → what the candidate actually implemented on screen

When analyzing:
- use the problem statement to judge intended task requirements when available
- use speech to understand intent, reasoning, tradeoffs, and communication
- use code to verify implementation correctness, structure, and progression
- use the timeline to understand chronology, pivots, corrections, and recovery

If there is a mismatch between speech and code, rely on code for what was actually implemented.

---

## Temporal expectation

This is a time-evolving interview, not just a final submission.

You should:
- evaluate how the candidate progresses across the interview
- identify improvements, mistakes, corrections, and recoveries over time
- distinguish early confusion from later clarity
- score only after considering the full interview arc
- use the final available code state as the primary basis for `coding_accuracy`, while still using earlier states to judge progression, debugging, adaptability, and strengths

---

## Evidence expectation

The assistant MUST:
- use exact snippets from:
  - speech (quotes)
  - code (`frameData` snippets)
- tie observations to specific timestamps or intervals when possible
- ground important claims in concrete evidence rather than vague summaries

When using code evidence:
- prefer the smallest complete contiguous block that makes the point understandable
- do not rely on disconnected one-line snippets when the claim depends on surrounding logic
- you may add short inline evaluator comments inside the quoted block only when they clarify why the snippet matters

---

## Timestamp expectations

All times are offsets from the start of the interview recording.

Rules:
- `start` and `end` are in milliseconds from recording start
- `timestamp_ms` in your output should also be an offset in milliseconds from recording start
- `timestamp_ms` begins at `0` and increases until the interview ends
- `time_range` fields should use seconds from recording start in a consistent string format: `"start_sec-end_sec"`
- do not use wall-clock timestamps

---

## Your response (single JSON object, snake_case keys)

You MUST return one JSON object that includes at least these top-level keys (see system prompt for full schema, dimension definitions, and scoring guidance):

- `summary`
- `dimensions` — every rubric dimension listed in the system prompt, each with:
  - `score`
  - `evidence_sufficiency`
  - `rationale_points` (array of `{ "text", "evidence": [ { "quote", "timestamp_ms", "source": "speech"|"code" } ] }`)
- `strengths`
- `weaknesses`
- `missed_opportunities`
- `missed_interviewer_friendly_behaviors`
- `prep_suggestions`
- `practice_prescriptions`
- `speech_code_conflicts` (array of objects or `[]`)
- `chronological_turning_points` (array of objects or `[]`)
- `moment_by_moment_feedback` (array of objects or `[]`)
- `what_to_say_differently` (array of strings)
- `better_interview_path`
- `final_outcome`
- `interview_process_quality`
- `hire_signal_summary`
- `round_outcome_prediction`

Do not omit required arrays such as `missed_opportunities`, `missed_interviewer_friendly_behaviors`, `speech_code_conflicts`, `chronological_turning_points`, or `moment_by_moment_feedback`; use empty arrays when there is nothing to report.

If evidence is limited for a dimension, make the narrowest defensible claim, set `evidence_sufficiency` accordingly, and score conservatively.

---

## Input data

{{INTERVIEW_TIMELINE_JSON}}
