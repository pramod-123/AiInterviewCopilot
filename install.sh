#!/usr/bin/env bash
#
# Interactive installer: GitHub Releases (server tarball + Chrome extension), host
# dependencies (Node 20+, ffmpeg, Tesseract, Python, unzip), WhisperX + local Whisper venvs, Prisma.
#
# Usage:
#   ./install.sh
#   bash install.sh
#
# Non-interactive (accept all y/n defaults):
#   INSTALL_CONSUMER_YES=1 ./install.sh
#
# Developers working from a git clone should use ./install-dev.sh (npm in server/, dev server).
#
# Environment:
#   AI_INTERVIEW_COPILOT_REPO   default GitHub owner/name for releases
#   GITHUB_TOKEN                API rate limits / private repos
#   INSTALL_CONSUMER_YES        if 1, treat all y/n prompts as "yes" (no secret prompts;
#                               set OPENAI_API_KEY, ANTHROPIC_API_KEY, LLM_PROVIDER,
#                               HF_TOKEN or HUGGING_FACE_HUB_TOKEN, GEMINI_API_KEY,
#                               GEMINI_LIVE_MODEL in the environment as needed)
#
set -euo pipefail

VERSION_WIRED="0.2.0-installer"

REPO="${AI_INTERVIEW_COPILOT_REPO:-}"
RELEASE_TAG="latest"
INSTALL_PREFIX=""
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
RUN_SERVER_AFTER=false
AUTO_YES="${INSTALL_CONSUMER_YES:-}"

SERVER_ASSET_BASENAME=""
EXTENSION_ASSET_NAME="ai-interview-copilot-chrome-extension.zip"

# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

say() { printf '%b\n' "$*"; }
banner() {
  say ""
  say "\033[1m=== $* ===\033[0m"
}

prompt() {
  local text="$1"
  local def="${2:-}"
  local reply
  if [[ -n "$def" ]]; then
    read -r -p "${text} [${def}]: " reply || true
    reply="${reply:-$def}"
  else
    read -r -p "${text}: " reply || true
  fi
  printf '%s' "$reply"
}

prompt_yn() {
  local text="$1"
  local def="${2:-y}"
  if [[ "${AUTO_YES}" == "1" ]]; then
    say "${text} → yes (INSTALL_CONSUMER_YES=1)"
    return 0
  fi
  local r
  r="$(prompt "$text (y/n)" "$def")"
  r="$(printf '%s' "$r" | tr '[:upper:]' '[:lower:]')"
  [[ "$r" == y || "$r" == yes ]]
}

# Read API key without echoing (stdout is the key only; newline goes to tty).
# In non-interactive mode (AUTO_YES=1), pass secrets via environment variables instead.
read_secret_prompt() {
  local prompt_text="$1"
  local val=""
  read -r -s -p "${prompt_text} (hidden): " val </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$val"
}

trim_crlf() {
  local s="$1"
  s="${s//$'\r'/}"
  printf '%s' "$s" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

detect_asset_suffix() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *)
      echo "Unsupported CPU architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
  case "${os}" in
    linux)
      if [[ "${arch}" != x64 ]]; then
        echo "Prebuilt server is only available for linux-x64 (found linux-${arch})." >&2
        exit 1
      fi
      printf '%s' "linux-x64"
      ;;
    darwin) printf '%s' "darwin-${arch}" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

linux_pkg_family() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID:-}" in
      ubuntu | debian | pop) printf '%s' "apt" ;;
      fedora | rhel | centos) printf '%s' "dnf" ;;
      *) printf '%s' "" ;;
    esac
  else
    printf '%s' ""
  fi
}

# ---------------------------------------------------------------------------
# Dependency installation
# ---------------------------------------------------------------------------

node_major() {
  node -p "Number(process.version.slice(1).split('.')[0])" 2>/dev/null || echo 0
}

node_is_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local m
  m="$(node_major)"
  ((m >= 20))
}

install_deps_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    say "Homebrew is not installed. Install it from https://brew.sh then re-run this script."
    return 1
  fi
  say "brew install node ffmpeg tesseract python3 unzip"
  brew install node ffmpeg tesseract python3 unzip
  hash -r 2>/dev/null || true
}

install_deps_linux_apt() {
  say "Configuring Node.js 22.x (NodeSource) and system packages (sudo required)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs ffmpeg tesseract-ocr python3 python3-venv python3-pip curl ca-certificates unzip build-essential
  hash -r 2>/dev/null || true
}

install_deps_linux_dnf() {
  say "Installing Node.js, ffmpeg, tesseract, Python (sudo required)..."
  sudo dnf install -y nodejs npm ffmpeg tesseract python3 python3-pip curl unzip gcc gcc-c++ make
  hash -r 2>/dev/null || true
}

# Install everything we can via the OS package manager; then verify.
install_all_system_dependencies() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Darwin" ]]; then
    install_deps_macos
    return $?
  fi
  if [[ "$os" != "Linux" ]]; then
    say "Unsupported OS for automatic dependency install."
    return 1
  fi
  case "$(linux_pkg_family)" in
    apt) install_deps_linux_apt ;;
    dnf) install_deps_linux_dnf ;;
    *)
      say "Unsupported Linux distribution for automatic install."
      say "Install manually: Node.js 20+, ffmpeg, ffprobe, tesseract, python3, python3-venv, pip, unzip, curl, tar."
      say "Debian/Ubuntu example: use https://github.com/nodesource/distributions then apt install ffmpeg tesseract-ocr python3 python3-venv python3-pip unzip build-essential"
      return 1
      ;;
  esac
}

maybe_nvm() {
  if [[ -n "${NVM_DIR:-}" ]] || [[ -f "${HOME}/.nvm/nvm.sh" ]]; then
    NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
    # shellcheck source=/dev/null
    if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
      source "${NVM_DIR}/nvm.sh"
    fi
  fi
}

require_cmds() {
  local missing=()
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing required commands: ${missing[*]}" >&2
    return 1
  fi
  return 0
}

ensure_runtime_after_install() {
  maybe_nvm
  if ! node_is_ok; then
    echo "Node.js 20+ is still not available after install (found: $(command -v node 2>/dev/null || echo none) $(node -v 2>/dev/null || true))." >&2
    echo "Open a new terminal or run: hash -r" >&2
    return 1
  fi
  require_cmds curl tar python3 ffmpeg ffprobe tesseract unzip || return 1
  return 0
}

# ---------------------------------------------------------------------------
# GitHub release download
# ---------------------------------------------------------------------------

github_download_url() {
  local want_name="$1"
  local json_path="$2"
  python3 -c "
import json, sys
want = sys.argv[1]
with open(sys.argv[2], encoding='utf-8') as f:
    data = json.load(f)
for a in data.get('assets') or []:
    if a.get('name') == want:
        print(a['browser_download_url'])
        raise SystemExit(0)
raise SystemExit(1)
" "${want_name}" "${json_path}"
}

upsert_env_line() {
  local key="$1"
  local line="$2"
  local f=".env"
  [[ -f "$f" ]] || touch "$f"
  local tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$f" 2>/dev/null; then
    grep -v "^${key}=" "$f" >"$tmp" || true
  else
    cp "$f" "$tmp"
  fi
  mv "$tmp" "$f"
  printf '%s\n' "$line" >>"$f"
}

fetch_release_json() {
  local repo="$1"
  local tag="$2"
  local out="$3"
  local url
  if [[ "${tag}" == "latest" ]]; then
    url="https://api.github.com/repos/${repo}/releases/latest"
  else
    url="https://api.github.com/repos/${repo}/releases/tags/${tag}"
  fi
  local auth=()
  [[ -n "${GITHUB_TOKEN}" ]] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" -o "${out}" "${url}"
}

download_asset() {
  local url="$1"
  local dest="$2"
  local auth=()
  [[ -n "${GITHUB_TOKEN}" ]] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  curl -fsSL "${auth[@]}" -L -o "${dest}" "${url}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  banner "Ai Interview Copilot — installer (${VERSION_WIRED})"
  say "Installs host dependencies (Node 20+, ffmpeg, Tesseract, Python, unzip), downloads the"
  say "release server tarball + Chrome extension, creates WhisperX and local Whisper venvs, and configures SQLite."
  say ""

  if [[ -z "$REPO" ]]; then
    REPO="$(prompt "GitHub repository (owner/name) for releases" "")"
  fi
  if [[ -z "$REPO" || "$REPO" != */* ]]; then
    echo "A GitHub repo in the form owner/name is required." >&2
    exit 1
  fi

  RELEASE_TAG="$(prompt "Release tag or 'latest'" "latest")"
  if [[ -z "${INSTALL_PREFIX}" ]]; then
    INSTALL_PREFIX="$(prompt "Install directory" "${HOME}/.local/share/ai-interview-copilot")"
  fi
  INSTALL_PREFIX="$(mkdir -p "${INSTALL_PREFIX}" && cd "${INSTALL_PREFIX}" && pwd)"

  if ! prompt_yn "Proceed with install into ${INSTALL_PREFIX} from ${REPO} @ ${RELEASE_TAG}?" "y"; then
    say "Aborted."
    exit 0
  fi

  maybe_nvm

  banner "Host dependencies"
  local need_install=false
  if ! node_is_ok; then
    need_install=true
    say "Node.js 20+ not found or too old."
  fi
  for c in ffmpeg ffprobe tesseract python3 unzip curl tar; do
    command -v "$c" >/dev/null 2>&1 || need_install=true
  done
  if [[ "$need_install" == true ]]; then
    if prompt_yn "Install missing tools via Homebrew (macOS) or apt/dnf (Linux)? Uses sudo on Linux." "y"; then
      install_all_system_dependencies || {
        echo "Automatic dependency install failed. Fix errors above, install prerequisites manually, then re-run." >&2
        exit 1
      }
    fi
  else
    say "Node 20+, ffmpeg, tesseract, python3, unzip, curl, and tar are already present."
  fi

  maybe_nvm
  if ! ensure_runtime_after_install; then
    exit 1
  fi

  SERVER_ASSET_BASENAME="ai-interview-copilot-server-$(detect_asset_suffix).tar.gz"
  TMP_JSON="$(mktemp)"
  TMP_TGZ="$(mktemp)"
  TMP_EXT=""
  cleanup() { rm -f "${TMP_JSON}" "${TMP_TGZ}" "${TMP_EXT}"; }
  trap cleanup EXIT

  banner "Download server (${SERVER_ASSET_BASENAME})"
  fetch_release_json "${REPO}" "${RELEASE_TAG}" "${TMP_JSON}"
  SERVER_URL="$(github_download_url "${SERVER_ASSET_BASENAME}" "${TMP_JSON}")" || {
    echo "Asset ${SERVER_ASSET_BASENAME} not found in this release." >&2
    exit 1
  }
  download_asset "${SERVER_URL}" "${TMP_TGZ}"
  say "Extracting into ${INSTALL_PREFIX}..."
  tar xzf "${TMP_TGZ}" -C "${INSTALL_PREFIX}"

  cd "${INSTALL_PREFIX}"

  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] && cp .env.example .env
  fi
  mkdir -p "${INSTALL_PREFIX}/data"
  local db_file="${INSTALL_PREFIX}/data/app.db"
  if ! grep -q '^DATABASE_URL=' .env 2>/dev/null; then
    upsert_env_line "DATABASE_URL" "DATABASE_URL=\"file:${db_file}\""
  fi

  banner "API keys (LLM, Gemini Live, Hugging Face)"
  local openai_key anthropic_key llm_choice hf_token gemini_key gemini_model
  local gemini_model_default="gemini-2.5-flash-native-audio-preview-12-2025"
  if [[ "${AUTO_YES}" == "1" ]]; then
    say "INSTALL_CONSUMER_YES=1: not prompting for secrets. Using OPENAI_API_KEY, ANTHROPIC_API_KEY, LLM_PROVIDER,"
    say "HF_TOKEN / HUGGING_FACE_HUB_TOKEN, GEMINI_API_KEY, GEMINI_LIVE_MODEL from the environment if set."
    openai_key="$(trim_crlf "${OPENAI_API_KEY:-}")"
    anthropic_key="$(trim_crlf "${ANTHROPIC_API_KEY:-}")"
    llm_choice="$(trim_crlf "${LLM_PROVIDER:-}")"
    hf_token="$(trim_crlf "${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}")"
    gemini_key="$(trim_crlf "${GEMINI_API_KEY:-}")"
    gemini_model="$(trim_crlf "${GEMINI_LIVE_MODEL:-}")"
  else
    say "OpenAI is used for remote speech-to-text, video ROI, and when LLM_PROVIDER=openai."
    say "Anthropic is used when LLM_PROVIDER=anthropic (evaluation, etc.). You can skip and edit .env later."
    openai_key="$(trim_crlf "$(read_secret_prompt "OpenAI API key (Enter to skip)")")"
    anthropic_key="$(trim_crlf "$(read_secret_prompt "Anthropic API key (Enter to skip)")")"
    if prompt_yn "Use Anthropic for the LLM (LLM_PROVIDER=anthropic)? Otherwise OpenAI." "n"; then
      llm_choice="anthropic"
    else
      llm_choice="openai"
    fi
    say "Hugging Face token (hf_…) is used for WhisperX/pyannote gated models (see huggingface.co/settings/tokens)."
    hf_token="$(trim_crlf "$(read_secret_prompt "Hugging Face token (Enter to skip)")")"
    say "Google Gemini (optional): voice interviewer Live WebSocket needs GEMINI_API_KEY and GEMINI_LIVE_MODEL."
    gemini_key="$(trim_crlf "$(read_secret_prompt "Gemini API key (Enter to skip)")")"
    gemini_model=""
    if [[ -n "$gemini_key" ]]; then
      gemini_model="$(trim_crlf "$(prompt "Gemini Live model id" "${gemini_model_default}")")"
    fi
  fi

  if [[ -z "$llm_choice" ]]; then
    if [[ -n "$anthropic_key" && -z "$openai_key" ]]; then
      llm_choice="anthropic"
    else
      llm_choice="openai"
    fi
  fi
  upsert_env_line "LLM_PROVIDER" "LLM_PROVIDER=${llm_choice}"

  if [[ -n "$openai_key" ]]; then
    upsert_env_line "OPENAI_API_KEY" "OPENAI_API_KEY=${openai_key}"
  fi
  if [[ -n "$anthropic_key" ]]; then
    upsert_env_line "ANTHROPIC_API_KEY" "ANTHROPIC_API_KEY=${anthropic_key}"
  fi

  if [[ -n "$hf_token" ]]; then
    upsert_env_line "HF_TOKEN" "HF_TOKEN=${hf_token}"
  fi

  if [[ -n "$gemini_key" ]]; then
    upsert_env_line "GEMINI_API_KEY" "GEMINI_API_KEY=${gemini_key}"
    if [[ -z "$gemini_model" ]]; then
      gemini_model="${gemini_model_default}"
    fi
    upsert_env_line "GEMINI_LIVE_MODEL" "GEMINI_LIVE_MODEL=${gemini_model}"
  fi

  if [[ "$llm_choice" == "anthropic" && -z "$anthropic_key" ]]; then
    say "Note: LLM_PROVIDER=anthropic but no Anthropic key was set — add ANTHROPIC_API_KEY in .env before using the LLM."
  fi
  if [[ "$llm_choice" == "openai" && -z "$openai_key" ]]; then
    say "Note: LLM_PROVIDER=openai but no OpenAI key was set — add OPENAI_API_KEY in .env for LLM, remote STT, and video ROI."
  fi
  if [[ -z "$hf_token" ]]; then
    say "Note: No HF_TOKEN — add one in .env before using WhisperX/pyannote diarization."
  fi
  if [[ -z "$gemini_key" ]]; then
    say "Note: Gemini Live is off until GEMINI_API_KEY and GEMINI_LIVE_MODEL are set in .env."
  fi

  say "Prisma db push..."
  npx prisma db push

  banner "Python: WhisperX (diarization / WhisperX SRT)"
  local venv_wx="${INSTALL_PREFIX}/venv-whisperx"
  if prompt_yn "Create venv and pip install whisperx (large download; needed for DIARIZATION_PROVIDER=whisperx)?" "y"; then
    require_cmds python3
    say "Creating ${venv_wx} …"
    python3 -m venv "${venv_wx}"
    "${venv_wx}/bin/pip" install -U pip setuptools wheel
    "${venv_wx}/bin/pip" install "whisperx"
    upsert_env_line "DIARIZATION_PYTHON" "DIARIZATION_PYTHON=${venv_wx}/bin/python"
    upsert_env_line "DIARIZATION_PROVIDER" "DIARIZATION_PROVIDER=whisperx"
    say "If you skipped HF_TOKEN earlier, set it in .env for pyannote (see diarize_dialogue_whisperx.py)."
  fi

  banner "Python: local Whisper CLI (offline STT)"
  local venv_whisper="${INSTALL_PREFIX}/venv-whisper"
  if prompt_yn "Create venv and pip install openai-whisper (for STT_PROVIDER=local)?" "y"; then
    python3 -m venv "${venv_whisper}"
    "${venv_whisper}/bin/pip" install -U pip setuptools wheel
    "${venv_whisper}/bin/pip" install "openai-whisper"
    local whisper_sh="${INSTALL_PREFIX}/bin/whisper"
    mkdir -p "${INSTALL_PREFIX}/bin"
    cat >"${whisper_sh}" <<EOF
#!/usr/bin/env bash
exec "${venv_whisper}/bin/whisper" "\$@"
EOF
    chmod +x "${whisper_sh}"
    upsert_env_line "LOCAL_WHISPER_EXECUTABLE" "LOCAL_WHISPER_EXECUTABLE=${whisper_sh}"
    upsert_env_line "STT_PROVIDER" "STT_PROVIDER=local"
    say "STT_PROVIDER=local. For OpenAI Whisper API instead, set STT_PROVIDER=remote in .env."
  fi

  banner "Chrome extension"
  EXT_DIR="${INSTALL_PREFIX}/chrome-extension"
  EXT_INSTALLED=false
  if prompt_yn "Download and unpack the Chrome extension from the same release?" "y"; then
    TMP_EXT="$(mktemp)"
    set +e
    EXT_URL="$(github_download_url "${EXTENSION_ASSET_NAME}" "${TMP_JSON}")"
    ext_ok=$?
    set -e
    if [[ "${ext_ok}" -eq 0 && -n "${EXT_URL}" ]]; then
      download_asset "${EXT_URL}" "${TMP_EXT}"
      rm -rf "${EXT_DIR}"
      mkdir -p "${EXT_DIR}"
      unzip -q -o "${TMP_EXT}" -d "${EXT_DIR}"
      say "Extension: ${EXT_DIR}"
      EXT_INSTALLED=true
    else
      say "No ${EXTENSION_ASSET_NAME} on this release — skip or load unpacked from source."
    fi
    rm -f "${TMP_EXT}"
  fi

  local starter="${INSTALL_PREFIX}/start-server.sh"
  cat >"${starter}" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
exec node dist/index.js
EOS
  chmod +x "${starter}"

  RUN_SERVER_AFTER=false
  if prompt_yn "Start the API server now?" "n"; then
    RUN_SERVER_AFTER=true
  fi

  banner "Done"
  say "Install root:     ${INSTALL_PREFIX}"
  say "Start server:     ${starter}"
  say "Add to PATH (optional): export PATH=\"${INSTALL_PREFIX}/bin:\${PATH}\""
  say ""
  say "Edit ${INSTALL_PREFIX}/.env if needed — EVALUATION_PROVIDER, STT_PROVIDER, HF_TOKEN, GEMINI_*, etc."
  if [[ "${EXT_INSTALLED}" == true ]] && [[ -f "${EXT_DIR}/manifest.json" ]]; then
    say ""
    say "Chrome → Extensions → Developer mode → Load unpacked → ${EXT_DIR}"
  fi
  say ""

  if [[ "${RUN_SERVER_AFTER}" == true ]]; then
    cd "${INSTALL_PREFIX}"
    exec node dist/index.js
  fi
}

main "$@"
