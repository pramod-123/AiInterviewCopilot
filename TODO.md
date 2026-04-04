# TODO

- [ ] Update docs to reflect the split persistence model and API response shape:
  - `SpeechUtterance` (speech windows) and `CodeSnapshot` (point-in-time code/OCR)
  - `GET /api/interviews/:id` fields: `speechTranscript`, `codeSnapshots`, `transcripts` alias
  - Live-session path clarification: no ROI/Tesseract on merged live recording

- [ ] Add use-cases document: browser extension live capture vs screen-recording upload
  - Typical scenarios where each path is better
  - Pros/cons: setup friction, reliability, timeline accuracy, OCR quality, privacy, cost
  - Recommended defaults by user persona (candidate practice, interviewer review, offline batch)

- [ ] Add benchmarking plan + baseline
  - End-to-end latency by stage (merge/remux, audio extract, OCR/snapshot ingest, STT, evaluation)
  - Quality metrics (transcript usefulness, code evidence coverage, rubric consistency)
  - Cost metrics (token usage, runtime cost per interview length bucket)
  - Reproducible benchmark script and sample dataset spec

- [ ] Add comparison doc: prompting/agent strategies
  - Single prompt
  - Single agent + tools
  - Multi-agent + tools
  - Compare trade-offs: quality, latency, determinism, observability, and cost
  - Define a repeatable evaluation rubric and report template
