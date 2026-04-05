#!/usr/bin/env bash
#
# Interactive installer: GitHub Releases (server tarball + Chrome extension), host
# dependencies (Node 20+, ffmpeg, Tesseract, Python, unzip), WhisperX + local Whisper venvs, Prisma.
# LLM vendor: ↑/↓ menu (OpenAI vs Anthropic). STT_PROVIDER is always set to local (local Whisper).
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
#   RELEASE_TAG                 optional; skip prompt (e.g. latest or v1.2.3)
#   INSTALL_PREFIX              optional; skip install-dir prompt
#   INSTALL_SKIP_PYTHON_VENVS   if 1, skip WhisperX / local Whisper venv steps (CI / smoke)
#   INSTALL_CONSUMER_START_SERVER  if 1 with INSTALL_CONSUMER_YES, start API after install
#   NO_COLOR / INSTALL_NO_COLOR   if set, disable ANSI styling (see https://no-color.org/)
#
set -euo pipefail

VERSION_WIRED="0.2.0-installer"

REPO="${AI_INTERVIEW_COPILOT_REPO:-}"
RELEASE_TAG="${RELEASE_TAG:-}"
INSTALL_PREFIX="${INSTALL_PREFIX:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
RUN_SERVER_AFTER=false
AUTO_YES="${INSTALL_CONSUMER_YES:-}"

SERVER_ASSET_BASENAME=""
EXTENSION_ASSET_NAME="ai-interview-copilot-chrome-extension.zip"

# ---------------------------------------------------------------------------
# UI — terminal theme (cyan / steel; respects NO_COLOR)
# ---------------------------------------------------------------------------

if [[ -z "${NO_COLOR:-}" && -z "${INSTALL_NO_COLOR:-}" && -t 1 ]]; then
  C_RST=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_OK=$'\033[32m'
  C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'
  C_ACCENT=$'\033[36m'
  C_ACCENT_B=$'\033[1;96m'
  C_BAR=$'\033[38;5;109m'
  C_TITLE=$'\033[1;97m'
  C_PROMPT=$'\033[38;5;80m'
  C_MENU_HI=$'\033[30;46m'
  C_MENU_LO=$'\033[2;37m'
else
  C_RST=''
  C_DIM=''
  C_BOLD=''
  C_OK=''
  C_WARN=''
  C_ERR=''
  C_ACCENT=''
  C_ACCENT_B=''
  C_BAR=''
  C_TITLE=''
  C_PROMPT=''
  C_MENU_HI=''
  C_MENU_LO=''
fi

say() { printf '%b\n' "$*"; }
say_dim() { printf '%b\n' "${C_DIM}$*${C_RST}"; }
say_ok() { printf '%b\n' "${C_OK}$*${C_RST}"; }
say_warn() { printf '%b\n' "${C_WARN}$*${C_RST}"; }
say_note() { printf '%b\n' "${C_DIM}${C_WARN}▸${C_RST} ${C_DIM}$*${C_RST}"; }

banner() {
  local title="$*"
  local n=$((${#title} + 4))
  say ""
  printf '%b╭' "${C_BAR}"
  local i
  for ((i = 0; i < n; i++)); do printf '─'; done
  printf '╮%b\n' "${C_RST}"
  printf '%b│ %s%s%s%s│%b\n' "${C_BAR}" "${C_TITLE}" "${title}" "${C_RST}${C_BAR}" "${C_RST}"
  printf '%b╰' "${C_BAR}"
  for ((i = 0; i < n; i++)); do printf '─'; done
  printf '╯%b\n' "${C_RST}"
}

install_welcome() {
  say ""
  printf '%b╔══════════════════════════════════════════════════════════════╗%b\n' "${C_ACCENT_B}" "${C_RST}"
  printf '%b║%b  %-58s%b║%b\n' "${C_ACCENT_B}" "${C_RST}${C_BOLD}" "Ai Interview Copilot" "${C_ACCENT_B}" "${C_RST}"
  printf '%b║%b  %-58s%b║%b\n' "${C_ACCENT_B}" "${C_DIM}" "Installer · ${VERSION_WIRED}" "${C_ACCENT_B}" "${C_RST}"
  printf '%b╚══════════════════════════════════════════════════════════════╝%b\n' "${C_ACCENT_B}" "${C_RST}"
  say ""
  say_dim "Release server + Chrome extension · host tools (ffmpeg, Tesseract, …) · optional Python venvs · SQLite & .env"
  say ""
}

prompt() {
  local text="$1"
  local def="${2:-}"
  local reply
  if [[ -n "$def" ]]; then
    read -r -p "${C_PROMPT}${text}${C_RST} ${C_DIM}[${def}]:${C_RST} " reply || true
    reply="${reply:-$def}"
  else
    read -r -p "${C_PROMPT}${text}${C_RST}${C_DIM}:${C_RST} " reply || true
  fi
  printf '%s' "$reply"
}

prompt_yn() {
  local text="$1"
  local def="${2:-y}"
  if [[ "${AUTO_YES}" == "1" ]]; then
    say_dim "→ ${text} — yes (INSTALL_CONSUMER_YES=1)"
    return 0
  fi
  local r
  r="$(prompt "${text} (y/n)" "$def")"
  r="$(printf '%s' "$r" | tr '[:upper:]' '[:lower:]')"
  [[ "$r" == y || "$r" == yes ]]
}

# Read API key without echoing (stdout is the key only; newline goes to tty).
# In non-interactive mode (AUTO_YES=1), pass secrets via environment variables instead.
read_secret_prompt() {
  local prompt_text="$1"
  local val=""
  read -r -s -p "${C_PROMPT}${prompt_text}${C_DIM} (hidden):${C_RST} " val </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$val"
}

trim_crlf() {
  local s="$1"
  s="${s//$'\r'/}"
  printf '%s' "$s" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# Interactive menu on /dev/tty: ↑/↓ (or 1/2) then Enter. Sets global choose_llm_index: 0=OpenAI, 1=Anthropic.
choose_llm_provider_menu() {
  local labels=(
    "OpenAI — LLM evaluation, video ROI, and local Whisper STT (typical setup)"
    "Anthropic — LLM evaluation only (OpenAI key optional for ROI / OpenAI-only features)"
  )
  local sel=0
  local n=${#labels[@]}
  local k1 k2
  while true; do
    printf '\n' >/dev/tty
    printf '%b  %sLLM provider%s  %s↑/↓ · Enter · 1/2%s\n' "${C_BAR}" "${C_ACCENT_B}" "${C_RST}" "${C_DIM}" "${C_RST}" >/dev/tty
    printf '%b  %s──────────────────%s\n' "${C_BAR}" "${C_DIM}" "${C_RST}" >/dev/tty
    local i
    for ((i = 0; i < n; i++)); do
      if [[ "$i" -eq "$sel" ]]; then
        printf '  %b ▶ %s%s\n' "${C_MENU_HI}" "${labels[$i]}" "${C_RST}" >/dev/tty
      else
        printf '  %b    %s%s\n' "${C_MENU_LO}" "${labels[$i]}" "${C_RST}" >/dev/tty
      fi
    done
    if ! IFS= read -rsn1 k1 </dev/tty 2>/dev/null; then
      choose_llm_index=0
      return 1
    fi
    if [[ "$k1" == $'\e' ]]; then
      IFS= read -rsn2 k2 </dev/tty 2>/dev/null || true
      case "$k2" in
        '[A' | 'OA')
          sel=$(((sel + n - 1) % n))
          ;;
        '[B' | 'OB')
          sel=$(((sel + 1) % n))
          ;;
      esac
    elif [[ "$k1" == $'\n' || "$k1" == $'\r' ]]; then
      choose_llm_index=$sel
      printf '\n' >/dev/tty
      return 0
    elif [[ "$k1" == '1' ]]; then
      choose_llm_index=0
      printf '\n' >/dev/tty
      return 0
    elif [[ "$k1" == '2' ]]; then
      choose_llm_index=1
      printf '\n' >/dev/tty
      return 0
    fi
  done
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
  install_welcome
  banner "Repository & install path"

  if [[ -z "$REPO" ]]; then
    REPO="$(prompt "GitHub repository (owner/name) for releases" "")"
  fi
  if [[ -z "$REPO" || "$REPO" != */* ]]; then
    printf '%b%s%b\n' "${C_ERR}" "A GitHub repo in the form owner/name is required." "${C_RST}" >&2
    exit 1
  fi

  if [[ -z "${RELEASE_TAG}" ]]; then
    RELEASE_TAG="$(prompt "Release tag or 'latest'" "latest")"
  fi
  if [[ -z "${INSTALL_PREFIX}" ]]; then
    INSTALL_PREFIX="$(prompt "Install directory" "${HOME}/.local/share/ai-interview-copilot")"
  fi
  INSTALL_PREFIX="$(mkdir -p "${INSTALL_PREFIX}" && cd "${INSTALL_PREFIX}" && pwd)"

  if ! prompt_yn "Proceed with install into ${INSTALL_PREFIX} from ${REPO} @ ${RELEASE_TAG}?" "y"; then
    say_warn "Aborted."
    exit 0
  fi

  maybe_nvm

  banner "Host dependencies"
  local need_install=false
  if ! node_is_ok; then
    need_install=true
    say_warn "Node.js 20+ not found or too old."
  fi
  for c in ffmpeg ffprobe tesseract python3 unzip curl tar; do
    command -v "$c" >/dev/null 2>&1 || need_install=true
  done
  if [[ "$need_install" == true ]]; then
    say_warn "Missing or not usable on PATH (the server needs these for video, audio, and local tools):"
    if ! node_is_ok; then
      say "  - Node.js 20+ (run: node --version)"
    fi
    for c in ffmpeg ffprobe tesseract python3 unzip curl tar; do
      if ! command -v "$c" >/dev/null 2>&1; then
        say "  - ${c}"
      fi
    done
    if prompt_yn "Install missing tools via Homebrew (macOS) or apt/dnf (Linux)? Uses sudo on Linux." "y"; then
      install_all_system_dependencies || {
        echo "Automatic dependency install failed. Fix errors above, install prerequisites manually, then re-run." >&2
        exit 1
      }
    fi
  else
    say_ok "Host dependency check passed — required tools are on PATH:"
    say_dim "  Video/audio: ffmpeg ($(command -v ffmpeg)), ffprobe ($(command -v ffprobe))"
    say_dim "  OCR: tesseract ($(command -v tesseract))  ·  Node $(node --version 2>/dev/null)  ·  python3 ($(command -v python3))"
    say_dim "  Utilities: unzip, curl, tar"
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
    say_dim "INSTALL_CONSUMER_YES=1: not prompting for secrets — using OPENAI_API_KEY, ANTHROPIC_API_KEY, LLM_PROVIDER,"
    say_dim "HF_TOKEN / HUGGING_FACE_HUB_TOKEN, GEMINI_API_KEY, GEMINI_LIVE_MODEL from the environment if set."
    openai_key="$(trim_crlf "${OPENAI_API_KEY:-}")"
    anthropic_key="$(trim_crlf "${ANTHROPIC_API_KEY:-}")"
    llm_choice="$(trim_crlf "${LLM_PROVIDER:-}")"
    hf_token="$(trim_crlf "${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}")"
    gemini_key="$(trim_crlf "${GEMINI_API_KEY:-}")"
    gemini_model="$(trim_crlf "${GEMINI_LIVE_MODEL:-}")"
  else
    choose_llm_index=0
    if [[ -r /dev/tty && -w /dev/tty ]]; then
      say "${C_ACCENT}Choose LLM vendor:${C_RST} arrow keys or ${C_BOLD}1${C_RST} / ${C_BOLD}2${C_RST}, then Enter."
      choose_llm_provider_menu || true
    else
      say_warn "No TTY for menu; falling back to OpenAI. Set LLM_PROVIDER in .env if you need Anthropic."
      choose_llm_index=0
    fi
    if [[ "${choose_llm_index}" -eq 1 ]]; then
      llm_choice="anthropic"
      say "Anthropic will run rubric evaluation (and related LLM calls). Speech-to-text uses local Whisper (STT_PROVIDER=local)."
      anthropic_key="$(trim_crlf "$(read_secret_prompt "Anthropic API key (Enter to skip)")")"
      openai_key="$(trim_crlf "$(read_secret_prompt "OpenAI API key — for video ROI and other OpenAI features (Enter to skip)")")"
      if [[ -z "$openai_key" ]]; then
        say "No OpenAI key — add OPENAI_API_KEY in .env before using video ROI or other OpenAI-backed features."
      fi
    else
      llm_choice="openai"
      say "OpenAI will power LLM evaluation, video ROI, and (with the local Whisper venv) offline speech-to-text."
      openai_key="$(trim_crlf "$(read_secret_prompt "OpenAI API key (Enter to skip)")")"
      anthropic_key=""
    fi
    say_dim "Hugging Face token (hf_…) — WhisperX/pyannote (huggingface.co/settings/tokens)."
    hf_token="$(trim_crlf "$(read_secret_prompt "Hugging Face token (Enter to skip)")")"
    say_dim "Google Gemini (optional) — Live WebSocket needs GEMINI_API_KEY and GEMINI_LIVE_MODEL."
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
  upsert_env_line "STT_PROVIDER" "STT_PROVIDER=local"

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
    say_note "LLM_PROVIDER=anthropic but no Anthropic key — add ANTHROPIC_API_KEY in .env before using the LLM."
  fi
  if [[ "$llm_choice" == "openai" && -z "$openai_key" ]]; then
    say_note "LLM_PROVIDER=openai but no OpenAI key — add OPENAI_API_KEY in .env for LLM, video ROI, and related OpenAI features."
  fi
  if [[ -z "$hf_token" ]]; then
    say_note "No HF_TOKEN — add one in .env before using WhisperX/pyannote diarization."
  fi
  if [[ -z "$gemini_key" ]]; then
    say_note "Gemini Live is off until GEMINI_API_KEY and GEMINI_LIVE_MODEL are set in .env."
  fi

  printf '%b%s%b\n' "${C_ACCENT}" "Prisma db push…" "${C_RST}"
  # Prisma may not load .env before prisma.config defaults; consumer layout puts config at install root.
  export DATABASE_URL="file:${db_file}"
  npx prisma db push

  banner "Python: WhisperX (diarization / WhisperX SRT)"
  local venv_wx="${INSTALL_PREFIX}/venv-whisperx"
  if [[ "${INSTALL_SKIP_PYTHON_VENVS:-}" == "1" ]]; then
    say "INSTALL_SKIP_PYTHON_VENVS=1: skipping WhisperX venv."
  elif prompt_yn "Create venv and pip install whisperx (large download; needed for DIARIZATION_PROVIDER=whisperx)?" "y"; then
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
  if [[ "${INSTALL_SKIP_PYTHON_VENVS:-}" == "1" ]]; then
    say "INSTALL_SKIP_PYTHON_VENVS=1: skipping local Whisper venv."
  elif prompt_yn "Create venv and pip install openai-whisper (for STT_PROVIDER=local)?" "y"; then
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
    say "LOCAL_WHISPER_EXECUTABLE set; STT_PROVIDER remains local."
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
  if [[ "${AUTO_YES}" == "1" ]]; then
    if [[ "${INSTALL_CONSUMER_START_SERVER:-}" == "1" ]]; then
      say_dim "→ Start the API server now? — yes (INSTALL_CONSUMER_START_SERVER=1)"
      RUN_SERVER_AFTER=true
    else
      say_dim "→ Start the API server now? — no (set INSTALL_CONSUMER_START_SERVER=1 with INSTALL_CONSUMER_YES to start)"
    fi
  elif prompt_yn "Start the API server now?" "n"; then
    RUN_SERVER_AFTER=true
  fi

  banner "Done"
  say_ok "Install root  ${INSTALL_PREFIX}"
  say_ok "Start server  ${starter}"
  say_dim "Optional PATH: export PATH=\"${INSTALL_PREFIX}/bin:\${PATH}\""
  say ""
  say_dim "Tweak ${INSTALL_PREFIX}/.env — EVALUATION_PROVIDER, HF_TOKEN, GEMINI_*, … (STT_PROVIDER stays local.)"
  if [[ "${EXT_INSTALLED}" == true ]] && [[ -f "${EXT_DIR}/manifest.json" ]]; then
    say ""
    say "${C_ACCENT}Chrome:${C_RST} Extensions → Developer mode → Load unpacked → ${C_BOLD}${EXT_DIR}${C_RST}"
  fi
  say ""

  if [[ "${RUN_SERVER_AFTER}" == true ]]; then
    cd "${INSTALL_PREFIX}"
    exec node dist/index.js
  fi
}

main "$@"
