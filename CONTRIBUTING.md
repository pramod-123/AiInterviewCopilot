# Contributing

## Setup

From the repository root:

```bash
cd server
cp .env.example .env
npm ci
npx prisma generate
```

## Before opening a PR

Run from `server/`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Tests

- Unit tests live in `server/tst/` and run with Vitest (`npm test`).
- Pipeline and API smoke tests require local tools (ffmpeg, tesseract) and credentials; see `server/package.json` scripts such as `pipeline:e2e` and `test:api:mov`.

## Style

- ESLint config: `server/eslint.config.js`
- Match existing TypeScript patterns (ES modules, `.js` extensions in imports).
