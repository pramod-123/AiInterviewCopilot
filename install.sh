#!/usr/bin/env bash
#
# Installer: GitHub Releases (server tarball + Chrome extension), host dependencies
# (Node 20+, ffmpeg/ffprobe, Python, unzip), Python venvs (WhisperX + local Whisper), Prisma.
#
# One-liner (public GitHub API):
#   curl -fsSL https://raw.githubusercontent.com/pramod-123/AiInterviewCopilot/main/install.sh | bash
# Same install, stdin stays your terminal (menus / prompts behave like ./install.sh):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/pramod-123/AiInterviewCopilot/main/install.sh)"
# Fully unattended (CI / no TTY): secrets must be passed via env; installer auto-yes without prompts.
#
# From a clone (stdin is a TTY): same prompts; y/n as usual unless INSTALL_CONSUMER_YES=1.
#   ./install.sh
#
# Developers from git should use ./install-dev.sh (npm in server/, dev server).
#
# Environment (optional overrides):
#   AI_INTERVIEW_COPILOT_REPO   default pramod-123/AiInterviewCopilot if unset
#   RELEASE_TAG                 default latest
#   INSTALL_PREFIX              default ~/.local/share/ai-interview-copilot
#   INSTALL_CONSUMER_YES        if 1: all y/n yes; secrets only from env (no prompts)
#   INSTALL_INTERACTIVE         if 1: prompt for repo, tag, install path (defaults still shown)
#   INSTALL_CONSUMER_START_SERVER  if 1 with INSTALL_CONSUMER_YES, start API after install
#   NO_COLOR / INSTALL_NO_COLOR   if set, disable ANSI styling (see https://no-color.org/)
#   INSTALL_NO_CURL_PROGRESS      if set, hide curl transfer bar for large downloads
#   INSTALL_SKIP_ZSH_SNIPPET      if 1, do not offer / append ~/.zshrc launcher shortcuts
#
set -euo pipefail

VERSION_WIRED="0.2.0-installer"

# Idempotency marker for ~/.zshrc snippet (see maybe_append_zsh_launcher_snippet).
ZSH_LAUNCHER_MARKER='# Ai Interview Copilot launcher (install.sh)'

# Upstream releases (override with AI_INTERVIEW_COPILOT_REPO=owner/name for forks).
REPO="${AI_INTERVIEW_COPILOT_REPO:-pramod-123/AiInterviewCopilot}"
RELEASE_TAG="${RELEASE_TAG:-latest}"
INSTALL_PREFIX="${INSTALL_PREFIX:-"${HOME}/.local/share/ai-interview-copilot"}"
RUN_SERVER_AFTER=false
# curl … | bash: stdin is the script, so it must not be used for prompts (would consume the script).
# If there is no usable controlling terminal (typical CI), default to fully non-interactive: auto-yes
# all y/n and take API keys only from the environment. In a normal Terminal, /dev/tty exists — we do not
# force INSTALL_CONSUMER_YES, so prompt()/read_secret_prompt on /dev/tty restores interactive keys.
if [[ ! -t 0 ]]; then
  if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
    INSTALL_CONSUMER_YES="${INSTALL_CONSUMER_YES:-1}"
  fi
fi
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

# Directory containing this script when run from a file (empty for curl | bash).
INSTALLER_SCRIPT_DIR=""
_install_src="${BASH_SOURCE[0]:-}"
if [[ -n "${_install_src}" && -f "${_install_src}" && "${_install_src}" != /dev/fd/* && "${_install_src}" != /proc/self/fd/* ]]; then
  INSTALLER_SCRIPT_DIR="$(cd "$(dirname "${_install_src}")" && pwd)"
fi
unset _install_src

say() { printf '%b\n' "$*"; }
say_dim() { printf '%b\n' "${C_DIM}$*${C_RST}"; }
say_ok() { printf '%b\n' "${C_OK}$*${C_RST}"; }
say_warn() { printf '%b\n' "${C_WARN}$*${C_RST}"; }
say_note() { printf '%b\n' "${C_DIM}${C_WARN}▸${C_RST} ${C_DIM}$*${C_RST}"; }

# Green check + message (completed step).
tick_done() {
  printf '%b %s %s%b\n' "${C_OK}" "✓" "$*" "${C_RST}"
}

# [████░░░░] style bar; cur/total 0..total (total >= 1).
draw_progress_bar() {
  local cur=${1:-0}
  local total=${2:-1}
  local w=${3:-32}
  [[ "$total" -lt 1 ]] && total=1
  [[ "$cur" -gt "$total" ]] && cur=$total
  [[ "$cur" -lt 0 ]] && cur=0
  local filled=$((cur * w / total))
  [[ "$filled" -gt "$w" ]] && filled=$w
  local empty=$((w - filled))
  local pct=$((cur * 100 / total))
  printf '%b│' "${C_BAR}"
  local i
  for ((i = 0; i < filled; i++)); do printf '█'; done
  for ((i = 0; i < empty; i++)); do printf '%b░%b' "${C_DIM}" "${C_RST}"; done
  printf '%b│%b %3d%%%b' "${C_BAR}" "${C_DIM}" "$pct" "${C_RST}"
}

# Increment global step counter and print overall progress line (dim label).
bump_install_progress() {
  INSTALL_PROGRESS_NUM=$((INSTALL_PROGRESS_NUM + 1))
  local n=$INSTALL_PROGRESS_NUM
  local t=${INSTALL_PROGRESS_TOTAL:-10}
  printf '  '
  draw_progress_bar "$n" "$t" 30
  printf '  %b%s  (%d/%d)%b\n' "${C_DIM}" "$*" "$n" "$t" "${C_RST}"
}

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

# Optional bitmap when repo assets exist and chafa (brew) or iTerm imgcat is available.
install_try_logo_png() {
  if [[ -n "${NO_COLOR:-}" || -n "${INSTALL_NO_COLOR:-}" ]] || [[ ! -t 1 ]]; then
    return 1
  fi
  [[ -n "${INSTALLER_SCRIPT_DIR}" ]] || return 1
  local png=""
  for png in "${INSTALLER_SCRIPT_DIR}/brand/app-mark-512.png" "${INSTALLER_SCRIPT_DIR}/browser-extension/chrome/icons/icon-512.png" "${INSTALLER_SCRIPT_DIR}/icons/icon-512.png"; do
    [[ -f "${png}" ]] && break
  done
  [[ -f "${png}" ]] || return 1
  if command -v chafa >/dev/null 2>&1; then
    if chafa --fill=block --symbols=block -s 38x16 "${png}" 2>/dev/null; then
      say ""
      return 0
    fi
  fi
  if [[ -n "${ITERM_SESSION_ID:-}" ]] && command -v imgcat >/dev/null 2>&1; then
    if imgcat -W 38 "${png}" 2>/dev/null; then
      say ""
      return 0
    fi
  fi
  return 1
}

install_welcome() {
  install_try_logo_png || true
  say ""
  printf '%b╔══════════════════════════════════════════════════════════════╗%b\n' "${C_ACCENT_B}" "${C_RST}"
  printf '%b║%b  %-58s%b║%b\n' "${C_ACCENT_B}" "${C_RST}${C_BOLD}" "Ai Interview Copilot" "${C_ACCENT_B}" "${C_RST}"
  printf '%b║%b  %-58s%b║%b\n' "${C_ACCENT_B}" "${C_DIM}" "Installer · ${VERSION_WIRED}" "${C_ACCENT_B}" "${C_RST}"
  printf '%b╚══════════════════════════════════════════════════════════════╝%b\n' "${C_ACCENT_B}" "${C_RST}"
  say ""
  say_dim "Release server + Chrome extension · host tools (ffmpeg/ffprobe, …) · Python venvs (WhisperX + Whisper) · SQLite & .env"
  say ""
}

prompt() {
  local text="$1"
  local def="${2:-}"
  local reply
  local in=/dev/stdin
  [[ -r /dev/tty ]] && in=/dev/tty
  if [[ -n "$def" ]]; then
    read -r -p "${C_PROMPT}${text}${C_RST} ${C_DIM}[${def}]:${C_RST} " reply <"$in" || true
    reply="${reply:-$def}"
  else
    read -r -p "${C_PROMPT}${text}${C_RST}${C_DIM}:${C_RST} " reply <"$in" || true
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

# Read API key from /dev/tty (echoed — paste is easier to verify).
read_secret_prompt() {
  local prompt_text="$1"
  local val=""
  read -r -p "${C_PROMPT}${prompt_text}${C_DIM}:${C_RST} " val </dev/tty || true
  printf '%s' "$val"
}

trim_crlf() {
  local s="$1"
  s="${s//$'\r'/}"
  printf '%s' "$s" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# Interactive menu on /dev/tty: ↑/↓ redraw in place; Enter / Space / 1 / 2 to confirm.
# Sets global choose_llm_index: 0=OpenAI, 1=Anthropic.
choose_llm_provider_menu() {
  local labels=(
    "OpenAI — LLM evaluation and local Whisper STT (typical setup)"
    "Anthropic — LLM evaluation only (OpenAI key optional for Whisper / OpenAI-only features)"
  )
  local sel=0
  local n=${#labels[@]}
  # Lines we paint each frame (must match printf count): title + rule + n options
  local menu_lines=$((2 + n))
  local drawn=0
  local k1 k2
  while true; do
    if [[ "$drawn" -eq 1 ]]; then
      # Move cursor up to first menu line and redraw in place (no scroll spam)
      printf '\033[%dA' "$menu_lines" >/dev/tty
    fi
    drawn=1
    printf '%b  %sLLM provider%s  %s↑/↓ move · Enter/Space confirm · 1/2 pick%s\n' "${C_BAR}" "${C_ACCENT_B}" "${C_RST}" "${C_DIM}" "${C_RST}" >/dev/tty
    printf '%b  %s────────────────────────────────────────────────────────%s\n' "${C_BAR}" "${C_DIM}" "${C_RST}" >/dev/tty
    local i
    for ((i = 0; i < n; i++)); do
      if [[ "$i" -eq "$sel" ]]; then
        printf '  %b ▶ %s%s\033[K\n' "${C_MENU_HI}" "${labels[$i]}" "${C_RST}" >/dev/tty
      else
        printf '  %b    %s%s\033[K\n' "${C_MENU_LO}" "${labels[$i]}" "${C_RST}" >/dev/tty
      fi
    done
    # Read one byte; Enter is often '\n' but some terminals/IDE shells need empty or different handling
    if ! IFS= read -r -s -n1 k1 </dev/tty 2>/dev/null; then
      choose_llm_index=0
      printf '\n' >/dev/tty
      return 1
    fi
    if [[ "$k1" == $'\e' ]]; then
      # CSI / SS3 arrows: ESC [ A / ESC [ B or ESC O A / ESC O B
      IFS= read -r -s -n2 k2 </dev/tty 2>/dev/null || true
      case "$k2" in
        '[A' | 'OA') sel=$(((sel + n - 1) % n)) ;;
        '[B' | 'OB') sel=$(((sel + 1) % n)) ;;
      esac
    elif [[ "$k1" == $'\n' || "$k1" == $'\r' || -z "$k1" ]]; then
      choose_llm_index=$sel
      printf '\n' >/dev/tty
      return 0
    elif [[ "$k1" == ' ' ]]; then
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

# Append aicopilot / aicopilot-server helpers to ~/.zshrc (once; uses ZSH_LAUNCHER_MARKER).
maybe_append_zsh_launcher_snippet() {
  local prefix="$1"
  local repo="$2"
  local zshrc="${ZDOTDIR:-$HOME}/.zshrc"
  if [[ "${INSTALL_SKIP_ZSH_SNIPPET:-}" == "1" ]]; then
    tick_done "Shell shortcuts skipped (INSTALL_SKIP_ZSH_SNIPPET=1)"
    return 0
  fi
  local do_append=false
  if [[ "${AUTO_YES}" == "1" ]]; then
    say_dim "→ Append aicopilot shortcuts to ~/.zshrc? — yes (INSTALL_CONSUMER_YES=1)"
    do_append=true
  elif prompt_yn "Append aicopilot shortcuts to ~/.zshrc? (aicopilot = kill listener on PORT from .env, then start server)" "y"; then
    do_append=true
  fi
  if [[ "$do_append" != true ]]; then
    tick_done "Shell shortcuts declined"
    return 0
  fi
  if [[ -f "$zshrc" ]] && grep -qF "${ZSH_LAUNCHER_MARKER}" "$zshrc" 2>/dev/null; then
    say_dim "Shortcuts already in ${zshrc}"
    tick_done "Shell shortcuts already present"
    return 0
  fi
  if [[ ! -f "$zshrc" ]]; then
    if ! touch "$zshrc" 2>/dev/null; then
      say_warn "Could not create ${zshrc} — skip shell shortcuts."
      tick_done "Shell shortcuts skipped (no .zshrc)"
      return 0
    fi
    say_dim "Created ${zshrc}"
  fi
  {
    printf '\n%s\n' "${ZSH_LAUNCHER_MARKER}"
    printf 'export AI_INTERVIEW_COPILOT_HOME=%q\n' "${prefix}"
    printf 'export AI_INTERVIEW_COPILOT_REPO=%q\n' "${repo}"
    cat <<'EOS'
aicopilot-server() {
  local root="${AI_INTERVIEW_COPILOT_HOME}"
  if [[ ! -x "${root}/start-server.sh" ]]; then
    echo "aicopilot-server: missing ${root}/start-server.sh (set AI_INTERVIEW_COPILOT_HOME?)" >&2
    return 1
  fi
  (cd "$root" && exec ./start-server.sh)
}

aicopilot-server-restart() {
  local root="${AI_INTERVIEW_COPILOT_HOME}"
  local port="${AI_INTERVIEW_COPILOT_PORT:-3001}"
  if [[ -f "${root}/.env" ]]; then
    local line
    line=$(command grep -E '^[[:space:]]*PORT[[:space:]]*=' "${root}/.env" 2>/dev/null | tail -1)
    if [[ -n "$line" ]]; then
      port="${line#*=}"
      port="${port//\"/}"
      port="${port//\'/}"
      port="${port// /}"
    fi
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || port=3001
  command lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null | command xargs kill 2>/dev/null
  sleep 0.3
  aicopilot-server
}

alias aicopilot='aicopilot-server-restart'

aicopilot-server-bg() {
  local root="${AI_INTERVIEW_COPILOT_HOME}"
  if [[ ! -x "${root}/start-server-background.sh" ]]; then
    echo "aicopilot-server-bg: missing ${root}/start-server-background.sh" >&2
    return 1
  fi
  (cd "$root" && ./start-server-background.sh)
}

alias aicopilot-bg='aicopilot-server-bg'

aicopilot-server-stop() {
  local root="${AI_INTERVIEW_COPILOT_HOME}"
  if [[ ! -x "${root}/stop-server.sh" ]]; then
    echo "aicopilot-server-stop: missing ${root}/stop-server.sh" >&2
    return 1
  fi
  (cd "$root" && ./stop-server.sh)
}

alias aicopilot-stop='aicopilot-server-stop'

aicopilot-check-update() {
  local root="${AI_INTERVIEW_COPILOT_HOME}"
  if [[ ! -x "${root}/check-update.sh" ]]; then
    echo "aicopilot-check-update: missing ${root}/check-update.sh" >&2
    return 1
  fi
  (cd "$root" && ./check-update.sh)
}

alias aicopilot-update='aicopilot-check-update'
EOS
  } >>"$zshrc"
  say_ok "Shell shortcuts → ${zshrc} — ${C_BOLD}aicopilot${C_RST} · ${C_BOLD}aicopilot-bg${C_RST} · ${C_BOLD}aicopilot-stop${C_RST} · ${C_BOLD}aicopilot-update${C_RST}"
  tick_done "Shell shortcuts installed"
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
  say "brew install node ffmpeg python3 unzip"
  brew install node ffmpeg python3 unzip
  hash -r 2>/dev/null || true
}

install_deps_linux_apt() {
  say "Configuring Node.js 22.x (NodeSource) and system packages (sudo required)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs ffmpeg python3 python3-venv python3-pip curl ca-certificates unzip build-essential
  hash -r 2>/dev/null || true
}

install_deps_linux_dnf() {
  say "Installing Node.js, ffmpeg, Python (sudo required)..."
  sudo dnf install -y nodejs npm ffmpeg python3 python3-pip curl unzip gcc gcc-c++ make
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
      say "Install manually: Node.js 20+, ffmpeg, ffprobe, python3, python3-venv, pip, unzip, curl, tar."
      say "Debian/Ubuntu example: use https://github.com/nodesource/distributions then apt install ffmpeg python3 python3-venv python3-pip unzip build-essential"
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
  require_cmds curl tar python3 ffmpeg ffprobe unzip || return 1
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
  curl -fsSL -H "Accept: application/vnd.github+json" -o "${out}" "${url}"
}

download_asset() {
  local url="$1"
  local dest="$2"
  if [[ -z "${NO_COLOR:-}" && -z "${INSTALL_NO_CURL_PROGRESS:-}" && -t 2 ]]; then
    curl -fSL --progress-bar -L -o "${dest}" "${url}"
  else
    curl -fsSL -L -o "${dest}" "${url}"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  INSTALL_PROGRESS_TOTAL=12
  INSTALL_PROGRESS_NUM=0

  install_welcome
  banner "Repository & install path"

  if [[ "${INSTALL_INTERACTIVE:-}" == "1" ]]; then
    REPO="$(prompt "GitHub repository (owner/name) for releases" "${REPO}")"
    RELEASE_TAG="$(prompt "Release tag or 'latest'" "${RELEASE_TAG}")"
    INSTALL_PREFIX="$(prompt "Install directory" "${INSTALL_PREFIX}")"
  else
    say_dim "Using ${REPO} @ ${RELEASE_TAG} → ${INSTALL_PREFIX} (set INSTALL_INTERACTIVE=1 to prompt for these)"
  fi
  if [[ -z "$REPO" || "$REPO" != */* ]]; then
    printf '%b%s%b\n' "${C_ERR}" "A GitHub repo in the form owner/name is required." "${C_RST}" >&2
    exit 1
  fi

  INSTALL_PREFIX="$(mkdir -p "${INSTALL_PREFIX}" && cd "${INSTALL_PREFIX}" && pwd)"

  if ! prompt_yn "Proceed with install into ${INSTALL_PREFIX} from ${REPO} @ ${RELEASE_TAG}?" "y"; then
    say_warn "Aborted."
    exit 0
  fi
  tick_done "Install target confirmed (${RELEASE_TAG} → ${INSTALL_PREFIX})"
  bump_install_progress "Configured"

  maybe_nvm

  banner "Host dependencies"
  local need_install=false
  if ! node_is_ok; then
    need_install=true
    say_warn "Node.js 20+ not found or too old."
  fi
  for c in ffmpeg ffprobe python3 unzip curl tar; do
    command -v "$c" >/dev/null 2>&1 || need_install=true
  done
  if [[ "$need_install" == true ]]; then
    say_warn "Missing or not usable on PATH (the server needs these for recording merge, audio, and local tools):"
    if ! node_is_ok; then
      say "  - Node.js 20+ (run: node --version)"
    fi
    for c in ffmpeg ffprobe python3 unzip curl tar; do
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
    say_dim "  Node $(node --version 2>/dev/null)  ·  python3 ($(command -v python3))"
    say_dim "  Utilities: unzip, curl, tar"
  fi

  maybe_nvm
  if ! ensure_runtime_after_install; then
    exit 1
  fi
  tick_done "Host dependencies satisfied (Node, ffmpeg/ffprobe, …)"
  bump_install_progress "Host ready"

  SERVER_ASSET_BASENAME="ai-interview-copilot-server-$(detect_asset_suffix).tar.gz"
  TMP_JSON="$(mktemp)"
  TMP_TGZ="$(mktemp)"
  TMP_EXT=""
  cleanup() { rm -f "${TMP_JSON}" "${TMP_TGZ}" "${TMP_EXT}"; }
  trap cleanup EXIT

  banner "Download server (${SERVER_ASSET_BASENAME})"
  say_dim "Fetching release metadata…"
  fetch_release_json "${REPO}" "${RELEASE_TAG}" "${TMP_JSON}"
  tick_done "Release metadata loaded"
  SERVER_URL="$(github_download_url "${SERVER_ASSET_BASENAME}" "${TMP_JSON}")" || {
    echo "Asset ${SERVER_ASSET_BASENAME} not found in this release." >&2
    exit 1
  }
  say_dim "Downloading ${SERVER_ASSET_BASENAME} (curl progress below)…"
  download_asset "${SERVER_URL}" "${TMP_TGZ}"
  tick_done "Server archive downloaded"
  bump_install_progress "Downloaded"
  say_dim "Extracting into ${INSTALL_PREFIX}…"
  tar xzf "${TMP_TGZ}" -C "${INSTALL_PREFIX}"
  tick_done "Server unpacked"
  bump_install_progress "Extracted"

  printf '%s\n' "${REPO}" >"${INSTALL_PREFIX}/.install-repo"

  cd "${INSTALL_PREFIX}"

  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] && cp .env.example .env
  fi
  mkdir -p "${INSTALL_PREFIX}/data"
  local db_file="${INSTALL_PREFIX}/data/app.db"
  if ! grep -q '^DATABASE_URL=' .env 2>/dev/null; then
    upsert_env_line "DATABASE_URL" "DATABASE_URL=\"file:${db_file}\""
  fi
  tick_done "Data directory and DATABASE_URL ready"
  bump_install_progress "Data / .env base"

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
      say_warn "No TTY for menu; defaulting to OpenAI. Set LLM_PROVIDER=anthropic before running to force Anthropic."
      choose_llm_index=0
    fi
    if [[ "${choose_llm_index}" -eq 1 ]]; then
      llm_choice="anthropic"
      say "Anthropic will run rubric evaluation (and related LLM calls). Speech-to-text uses local Whisper (STT_PROVIDER=local)."
      anthropic_key="$(trim_crlf "$(read_secret_prompt "Anthropic API key (Enter to skip)")")"
      openai_key="$(trim_crlf "$(read_secret_prompt "OpenAI API key — optional for Whisper / OpenAI features (Enter to skip)")")"
      if [[ -z "$openai_key" ]]; then
        say "No OpenAI key — add OPENAI_API_KEY in .env before using OpenAI-backed features."
      fi
    else
      llm_choice="openai"
      say "OpenAI will power LLM evaluation and (with the local Whisper venv) offline speech-to-text."
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

  llm_choice="$(printf '%s' "$llm_choice" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ -n "$llm_choice" && "$llm_choice" != "openai" && "$llm_choice" != "anthropic" ]]; then
    say_warn "Unrecognized LLM_PROVIDER='${llm_choice}' — using inferred default."
    llm_choice=""
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
    say_note "LLM_PROVIDER=openai but no OpenAI key — add OPENAI_API_KEY in .env for LLM and related OpenAI features."
  fi
  if [[ -z "$hf_token" ]]; then
    say_note "No HF_TOKEN — add one in .env before using WhisperX/pyannote diarization."
  fi
  if [[ -z "$gemini_key" ]]; then
    say_note "Gemini Live is off until GEMINI_API_KEY and GEMINI_LIVE_MODEL are set in .env."
  fi
  tick_done "API keys and provider env written (as entered)"
  bump_install_progress "Secrets / LLM"

  printf '%b%s%b\n' "${C_ACCENT}" "Prisma db push…" "${C_RST}"
  # Prisma may not load .env before prisma.config defaults; consumer layout puts config at install root.
  export DATABASE_URL="file:${db_file}"
  npx prisma db push
  tick_done "Database schema applied (Prisma)"
  bump_install_progress "Prisma"

  banner "Python: WhisperX (diarization / WhisperX SRT)"
  local venv_wx="${INSTALL_PREFIX}/venv-whisperx"
  if [[ "${INSTALL_SKIP_PYTHON_VENVS:-}" == "1" ]]; then
    say_dim "INSTALL_SKIP_PYTHON_VENVS=1: skipping WhisperX venv."
    tick_done "WhisperX venv skipped"
  elif prompt_yn "Create venv and pip install whisperx (large download; needed for DIARIZATION_PROVIDER=whisperx)?" "y"; then
    require_cmds python3
    say_dim "Creating ${venv_wx} …"
    python3 -m venv "${venv_wx}"
    "${venv_wx}/bin/pip" install -U pip setuptools wheel
    say_dim "Installing whisperx (pip may show its own progress)…"
    "${venv_wx}/bin/pip" install "whisperx"
    upsert_env_line "DIARIZATION_PYTHON" "DIARIZATION_PYTHON=${venv_wx}/bin/python"
    upsert_env_line "DIARIZATION_PROVIDER" "DIARIZATION_PROVIDER=whisperx"
    tick_done "WhisperX venv ready (${venv_wx})"
    say_dim "If you skipped HF_TOKEN earlier, set it in .env for pyannote (see diarize_dialogue_whisperx.py)."
  else
    tick_done "WhisperX venv declined"
  fi
  bump_install_progress "WhisperX"

  banner "Python: local Whisper CLI (offline STT)"
  local venv_whisper="${INSTALL_PREFIX}/venv-whisper"
  if [[ "${INSTALL_SKIP_PYTHON_VENVS:-}" == "1" ]]; then
    say_dim "INSTALL_SKIP_PYTHON_VENVS=1: skipping local Whisper venv."
    tick_done "Local Whisper venv skipped"
  elif prompt_yn "Create venv and pip install openai-whisper (for STT_PROVIDER=local)?" "y"; then
    python3 -m venv "${venv_whisper}"
    "${venv_whisper}/bin/pip" install -U pip setuptools wheel
    say_dim "Installing openai-whisper…"
    "${venv_whisper}/bin/pip" install "openai-whisper"
    local whisper_sh="${INSTALL_PREFIX}/bin/whisper"
    mkdir -p "${INSTALL_PREFIX}/bin"
    cat >"${whisper_sh}" <<EOF
#!/usr/bin/env bash
exec "${venv_whisper}/bin/whisper" "\$@"
EOF
    chmod +x "${whisper_sh}"
    upsert_env_line "LOCAL_WHISPER_EXECUTABLE" "LOCAL_WHISPER_EXECUTABLE=${whisper_sh}"
    tick_done "Local Whisper CLI ready (${whisper_sh})"
  else
    tick_done "Local Whisper venv declined"
  fi
  bump_install_progress "Local Whisper"

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
      say_dim "Downloading Chrome extension zip…"
      download_asset "${EXT_URL}" "${TMP_EXT}"
      rm -rf "${EXT_DIR}"
      mkdir -p "${EXT_DIR}"
      unzip -q -o "${TMP_EXT}" -d "${EXT_DIR}"
      tick_done "Chrome extension unpacked → ${EXT_DIR}"
      EXT_INSTALLED=true
    else
      say_warn "No ${EXTENSION_ASSET_NAME} on this release — skip or load unpacked from source."
      tick_done "Chrome extension skipped (asset missing)"
    fi
    rm -f "${TMP_EXT}"
  else
    tick_done "Chrome extension download skipped"
  fi
  bump_install_progress "Extension"

  local starter="${INSTALL_PREFIX}/start-server.sh"
  cat >"${starter}" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
exec node dist/index.js
EOS
  chmod +x "${starter}"

  local starter_bg="${INSTALL_PREFIX}/start-server-background.sh"
  cat >"${starter_bg}" <<'EOS'
#!/usr/bin/env bash
# Run the API in the background with nohup; append stdout/stderr to server.log in this directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
LOG="${ROOT}/server.log"
PORT=3001
if [[ -f "${ROOT}/.env" ]]; then
  _line=$(command grep -E '^[[:space:]]*PORT[[:space:]]*=' "${ROOT}/.env" 2>/dev/null | tail -1)
  if [[ -n "${_line}" ]]; then
    PORT="${_line#*=}"
    PORT="${PORT//\"/}"
    PORT="${PORT//\'/}"
    PORT="${PORT// /}"
  fi
fi
[[ "${PORT}" =~ ^[0-9]+$ ]] || PORT=3001
command lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | command xargs kill 2>/dev/null || true
sleep 0.3
{
  echo ""
  echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") UTC · local $(date +"%Y-%m-%d %H:%M:%S %Z") — starting server (PORT=${PORT}) ====="
} >>"${LOG}"
nohup node dist/index.js >>"${LOG}" 2>&1 &
echo $! >"${ROOT}/server.pid"
printf 'Started in background, PID %s — log: %s\n' "$(cat "${ROOT}/server.pid")" "${LOG}"
EOS
  chmod +x "${starter_bg}"

  local stopper="${INSTALL_PREFIX}/stop-server.sh"
  cat >"${stopper}" <<'EOS'
#!/usr/bin/env bash
# Stop the API: kill whatever is listening on PORT from .env (default 3001). Removes server.pid if present.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${ROOT}/server.log"
PORT=3001
if [[ -f "${ROOT}/.env" ]]; then
  _line=$(command grep -E '^[[:space:]]*PORT[[:space:]]*=' "${ROOT}/.env" 2>/dev/null | tail -1)
  if [[ -n "${_line}" ]]; then
    PORT="${_line#*=}"
    PORT="${PORT//\"/}"
    PORT="${PORT//\'/}"
    PORT="${PORT// /}"
  fi
fi
[[ "${PORT}" =~ ^[0-9]+$ ]] || PORT=3001
if command lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  command lsof -ti "tcp:${PORT}" -sTCP:LISTEN | command xargs kill 2>/dev/null || true
  {
    echo ""
    echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") UTC · local $(date +"%Y-%m-%d %H:%M:%S %Z") — stopped server (PORT=${PORT}) ====="
  } >>"${LOG}" 2>/dev/null || true
  printf 'Stopped process listening on port %s.\n' "${PORT}"
else
  printf 'No process listening on port %s.\n' "${PORT}"
fi
rm -f "${ROOT}/server.pid"
EOS
  chmod +x "${stopper}"

  local checker="${INSTALL_PREFIX}/check-update.sh"
  cat >"${checker}" <<'EOS'
#!/usr/bin/env bash
# Compare local package.json version to GitHub releases/latest for the install repo.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_FILE="${ROOT}/.install-repo"
REPO="${AI_INTERVIEW_COPILOT_REPO:-}"
if [[ -z "${REPO}" && -f "${REPO_FILE}" ]]; then
  REPO="$(tr -d '[:space:]' <"${REPO_FILE}" || true)"
fi
if [[ -z "${REPO}" || "${REPO}" != */* ]]; then
  printf 'check-update: set AI_INTERVIEW_COPILOT_REPO=owner/name or write %s\n' "${REPO_FILE}" >&2
  exit 1
fi
if [[ ! -f "${ROOT}/package.json" ]]; then
  echo "check-update: missing ${ROOT}/package.json" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "check-update: node is required to read package.json" >&2
  exit 1
fi
local_ver="$(cd "${ROOT}" && node -p "require('./package.json').version" 2>/dev/null || true)"
if [[ -z "${local_ver}" ]]; then
  echo "check-update: could not read version from package.json" >&2
  exit 1
fi
url="https://api.github.com/repos/${REPO}/releases/latest"
if ! json="$(curl -fsSL -H "Accept: application/vnd.github+json" "${url}" 2>/dev/null)"; then
  printf 'check-update: failed to fetch %s (network or GitHub API error).\n' "${url}" >&2
  exit 2
fi
tag="$(printf '%s' "${json}" | sed -n 's/.*\"tag_name\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' | head -1)"
if [[ -z "${tag}" ]]; then
  echo "check-update: could not parse tag_name from GitHub response" >&2
  exit 2
fi
remote_ver="${tag#v}"
highest="$(printf '%s\n%s\n' "${local_ver}" "${remote_ver}" | sort -V | tail -1)"
if [[ "${highest}" == "${remote_ver}" && "${local_ver}" != "${remote_ver}" ]]; then
  printf 'Update available: installed %s → latest release %s (%s)\n' "${local_ver}" "${remote_ver}" "${tag}"
  printf 'Re-run the installer from the repo (./install.sh) or download a newer release tarball.\n'
  exit 0
fi
printf 'Up to date: installed %s (latest GitHub release %s)\n' "${local_ver}" "${tag}"
exit 0
EOS
  chmod +x "${checker}"
  tick_done "start/stop/background scripts + check-update.sh"
  bump_install_progress "Launcher"

  maybe_append_zsh_launcher_snippet "${INSTALL_PREFIX}" "${REPO}"
  bump_install_progress "Shell shortcuts"

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
  printf '  '
  draw_progress_bar "${INSTALL_PROGRESS_TOTAL}" "${INSTALL_PROGRESS_TOTAL}" 30
  printf '%b  100%% — all steps%b\n' "${C_OK}" "${C_RST}"
  tick_done "Installation complete"
  say ""
  say_ok "Install root  ${INSTALL_PREFIX}"
  say_ok "Start server  ${starter}"
  say_ok "Background + logs  ${starter_bg}  (appends ${INSTALL_PREFIX}/server.log, writes ${INSTALL_PREFIX}/server.pid)"
  say_ok "Stop server     ${stopper}"
  say_ok "Check updates   ${checker}  (shell: aicopilot-update)"
  local _zshrc_done="${ZDOTDIR:-$HOME}/.zshrc"
  if [[ -f "${_zshrc_done}" ]] && grep -qF "${ZSH_LAUNCHER_MARKER}" "${_zshrc_done}" 2>/dev/null; then
    say_dim "Shell: ${C_BOLD}aicopilot${C_RST} · ${C_BOLD}aicopilot-bg${C_RST} · ${C_BOLD}aicopilot-stop${C_RST} · ${C_BOLD}aicopilot-update${C_RST} (source ${_zshrc_done} first)"
  fi
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
