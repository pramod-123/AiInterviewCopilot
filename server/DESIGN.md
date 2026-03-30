# AiInterviewCopilot — Server Design

The full server design document is inlined in the **repository root [`README.md`](../README.md#server-design)** so it appears on the GitHub project home page together with setup and API summaries. That section now covers **classic video jobs**, **live LeetCode sessions** (`LiveSessionRoutesController`, `LiveSessionPostProcessor`, `data/live-sessions/`), and how they share **`VideoJobProcessor`** / **`E2eInterviewPipeline`**.

The **Chrome extension** is documented in **[`README.md` — Browser extension](../README.md#browser-extension-leetcode-live-capture)** (not under `server/`).

Edit the **Server design** section in the root README when updating this documentation.
