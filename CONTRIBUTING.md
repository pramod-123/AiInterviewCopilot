# Contributing

## Setup

### Server

From the repository root:

```bash
cd server
cp .env.example .env
npm ci
npx prisma generate
npx prisma db push
```

### Browser extension

There is no npm build for **`browser-extension/`** (plain HTML/CSS/JS). Load it in Chrome: **Extensions** → **Developer mode** → **Load unpacked** → choose the **`browser-extension`** directory. Point the popup’s **API base URL** at your running server (default `http://127.0.0.1:3001`). Use a **`https://leetcode.com/problems/...`** tab when exercising capture.

## Before opening a PR

Run from `server/`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Manually smoke the extension (start interview → side panel recording → end session → **Sessions** page: video, transcript, evaluation) when you touch **`browser-extension/`** or live-session server code.

## Tests

- Unit tests live in `server/tst/` and run with Vitest (`npm test`).
- Pipeline and API smoke tests require local tools (ffmpeg, tesseract) and credentials; see `server/package.json` scripts such as `pipeline:e2e` and `test:api:mov`.
- Live-session helpers: `npm run live-session:reset-post-process`, `npm run live-session:reprocess` (see `server/scripts/`).

## Style

- ESLint config: `server/eslint.config.js`
- Match existing TypeScript patterns (ES modules, `.js` extensions in imports).
- Extension code: keep MV3 manifest permissions minimal; prefer readable vanilla DOM over new frameworks.
