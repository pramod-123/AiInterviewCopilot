#!/usr/bin/env bash
# Developer install: clone workspace, npm in server/, Prisma, start dev server.
# Run from repo root: ./install-dev.sh   or   bash install-dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="${ROOT}/server"
NVMRC="${ROOT}/.nvmrc"

usage() {
  cat <<'EOF'
Usage: ./install-dev.sh [options]

  Installs npm packages under server/, runs prisma generate + db push,
  then starts the dev server (tsx watch) unless --no-run is set.

Options:
  --brew, --with-brew   On macOS, run: brew install ffmpeg tesseract (needs Homebrew)
  --no-run              Install and migrate only; do not start the server
  --prod                After install, run npm run build && npm start (no watch)
  -h, --help            Show this help

Requires: Node.js 20+, ffmpeg, ffprobe, tesseract on PATH.
Set OPENAI_API_KEY in server/.env (created from .env.example if missing).

For end users installing from GitHub Releases (binary tarball), use ./install.sh instead.
EOF
}

WITH_BREW=false
RUN_SERVER=true
PROD_START=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --brew | --with-brew) WITH_BREW=true ;;
    --no-run) RUN_SERVER=false ;;
    --prod) PROD_START=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ "${PROD_START}" == true && "${RUN_SERVER}" == false ]]; then
  echo "Cannot combine --prod with --no-run" >&2
  exit 1
fi

if [[ -n "${NVM_DIR:-}" ]] || [[ -f "${HOME}/.nvm/nvm.sh" ]]; then
  NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  # shellcheck source=/dev/null
  if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    source "${NVM_DIR}/nvm.sh"
    if [[ -f "${NVMRC}" ]]; then
      nvm install >/dev/null
      nvm use >/dev/null
    fi
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH (20+ required)." >&2
  echo "Install from https://nodejs.org/ or use nvm with the repo .nvmrc." >&2
  exit 1
fi

node_major="$(node -p "Number(process.version.slice(1).split('.')[0])")"
if ((node_major < 20)); then
  echo "Node.js 20+ required; found $(node -v)." >&2
  exit 1
fi

if [[ "${WITH_BREW}" == true ]]; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "--brew is only supported on macOS." >&2
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found. Install from https://brew.sh/" >&2
    exit 1
  fi
  echo "Installing ffmpeg and tesseract via Homebrew..."
  brew install ffmpeg tesseract
fi

missing_bin=()
for cmd in ffmpeg ffprobe tesseract; do
  command -v "${cmd}" >/dev/null 2>&1 || missing_bin+=("${cmd}")
done
if [[ ${#missing_bin[@]} -gt 0 ]]; then
  echo "Missing on PATH: ${missing_bin[*]}" >&2
  echo "  macOS: brew install ffmpeg tesseract   (or re-run: ./install-dev.sh --brew)" >&2
  echo "  Debian/Ubuntu: sudo apt-get install -y ffmpeg tesseract-ocr" >&2
  exit 1
fi

if [[ ! -d "${SERVER}" ]] || [[ ! -f "${SERVER}/package.json" ]]; then
  echo "Expected server directory at ${SERVER}" >&2
  exit 1
fi

cd "${SERVER}"

if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "Created server/.env from .env.example — set OPENAI_API_KEY before using the API."
  else
    echo "No server/.env.example found; create server/.env manually." >&2
  fi
fi

echo "Installing npm dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "Prisma generate + db push..."
npx prisma generate
npx prisma db push

if [[ "${RUN_SERVER}" == false ]]; then
  echo "Done (server not started; used --no-run)."
  exit 0
fi

if [[ "${PROD_START}" == true ]]; then
  echo "Building and starting production server..."
  npm run build
  exec npm start
else
  echo "Starting dev server (Ctrl+C to stop)..."
  exec npm run dev
fi
