#!/usr/bin/env bash
# Download a pre-built Ai Interview Copilot server tarball from GitHub Releases,
# install system prerequisites (ffmpeg, ffprobe), apply Prisma schema, and optionally start the API.
#
# Requires: Node.js 20+, curl, tar, gzip. Python 3 is used to parse the GitHub API (no jq).
#
# Create a release by pushing a tag v*.*.* after merging .github/workflows/release.yml (see that file for asset names).

set -euo pipefail

REPO="${AI_INTERVIEW_COPILOT_REPO:-}"
VERSION="latest"
PREFIX=""
WITH_BREW=false
RUN_SERVER=true

usage() {
  cat <<'EOF'
Usage: AI_INTERVIEW_COPILOT_REPO=owner/name ./scripts/install-from-github-release.sh [options]

  --repo OWNER/NAME     GitHub repository (default: env AI_INTERVIEW_COPILOT_REPO)
  --version TAG         Release tag, e.g. v1.0.0 (default: latest)
  --prefix DIR          Install directory (default: $HOME/.local/share/ai-interview-copilot-server)
  --brew, --with-brew   macOS only: brew install ffmpeg
  --no-run              Install and db push only; do not start the server
  -h, --help            Show this help

Requires on PATH: Node.js 20+, ffmpeg, ffprobe, curl, tar, python3.
Release metadata is fetched from the public GitHub API (no token).

After install, edit .env in the install directory (OPENAI_API_KEY, etc.).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --brew | --with-brew) WITH_BREW=true; shift ;;
    --no-run) RUN_SERVER=false; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${REPO}" ]]; then
  echo "Set --repo OWNER/NAME or AI_INTERVIEW_COPILOT_REPO." >&2
  usage >&2
  exit 1
fi

if [[ -z "${PREFIX}" ]]; then
  PREFIX="${HOME}/.local/share/ai-interview-copilot-server"
fi

detect_asset_suffix() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
  case "${os}" in
    linux)
      if [[ "${arch}" != x64 ]]; then
        echo "Release builds are only provided for linux-x64; found ${arch}." >&2
        exit 1
      fi
      echo "linux-x64"
      ;;
    darwin) echo "darwin-${arch}" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

ASSET_SUFFIX="$(detect_asset_suffix)"
ASSET_NAME="ai-interview-copilot-server-${ASSET_SUFFIX}.tar.gz"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to read the GitHub API." >&2
  exit 1
fi

if [[ -n "${NVM_DIR:-}" ]] || [[ -f "${HOME}/.nvm/nvm.sh" ]]; then
  NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  # shellcheck source=/dev/null
  if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    source "${NVM_DIR}/nvm.sh"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required on PATH." >&2
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
  echo "Installing ffmpeg via Homebrew..."
  brew install ffmpeg
fi

missing_bin=()
for cmd in ffmpeg ffprobe tar; do
  command -v "${cmd}" >/dev/null 2>&1 || missing_bin+=("${cmd}")
done
if [[ ${#missing_bin[@]} -gt 0 ]]; then
  echo "Missing on PATH: ${missing_bin[*]}" >&2
  echo "  macOS: brew install ffmpeg" >&2
  echo "  Debian/Ubuntu: sudo apt-get install -y ffmpeg" >&2
  exit 1
fi

if [[ "${VERSION}" == "latest" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
fi

TMP_JSON="$(mktemp)"
TMP_TGZ=""
cleanup() { rm -f "${TMP_JSON}" "${TMP_TGZ}"; }
trap cleanup EXIT

echo "Fetching release metadata from ${API_URL}..."
curl -fsSL -H "Accept: application/vnd.github+json" -o "${TMP_JSON}" "${API_URL}"

DOWNLOAD_URL="$(
  python3 -c "
import json, sys
name = sys.argv[1]
with open(sys.argv[2]) as f:
    data = json.load(f)
assets = data.get('assets') or []
for a in assets:
    if a.get('name') == name:
        print(a['browser_download_url'])
        sys.exit(0)
sys.exit(1)
" "${ASSET_NAME}" "${TMP_JSON}"
)" || {
  echo "No asset named ${ASSET_NAME} in this release. Available assets:" >&2
  python3 -c "import json; print('\n'.join(a['name'] for a in json.load(open('${TMP_JSON}')).get('assets',[])))" >&2 || true
  exit 1
}

mkdir -p "${PREFIX}"
PREFIX="$(cd "${PREFIX}" && pwd)"
TMP_TGZ="$(mktemp)"

echo "Downloading ${ASSET_NAME}..."
curl -fsSL "${CURL_AUTH[@]}" -L -o "${TMP_TGZ}" "${DOWNLOAD_URL}"

echo "Extracting to ${PREFIX}..."
tar xzf "${TMP_TGZ}" -C "${PREFIX}"

cd "${PREFIX}"

if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
  fi
fi

# Portable DB path for installs outside the original monorepo layout (matches runtime resolution from dist/).
mkdir -p "${PREFIX}/data"
DB_FILE="${PREFIX}/data/app.db"
if grep -q '^DATABASE_URL=' .env 2>/dev/null; then
  :
else
  printf '\nDATABASE_URL="file:%s"\n' "${DB_FILE}" >>.env
fi

echo "Prisma db push..."
npx prisma db push

if [[ "${RUN_SERVER}" == false ]]; then
  echo "Done (server not started; used --no-run). Install directory: ${PREFIX}"
  exit 0
fi

echo "Starting server (Ctrl+C to stop)..."
exec node dist/index.js
