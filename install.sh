#!/usr/bin/env bash
#
# Installer: GitHub Releases (server tarball + Chrome extension), host dependencies
# (Node 20+, ffmpeg/ffprobe, Python 3, jq, unzip), openai-whisper CLI venv for local STT (required), Prisma.
#
# One-liner (public GitHub API):
#   curl -fsSL https://raw.githubusercontent.com/pramod-123/AiInterviewCopilot/main/install.sh | bash
# Windows (PowerShell 5.1+): download install.ps1 from the repo raw URL, then:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Git Bash on Windows can run this script too (winget deps, win-x64 tarball).
# Same install, stdin stays your terminal (y/n prompts for zsh snippet, extension download, etc.):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/pramod-123/AiInterviewCopilot/main/install.sh)"
# Fully unattended (CI / no TTY): auto-yes; optional API keys only from env when INSTALL_CONSUMER_YES=1.
#
# From a clone (stdin is a TTY): y/n as usual unless INSTALL_CONSUMER_YES=1. API keys are not prompted — use Server config in Chrome after install.
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
#   NODE_MIN_MAJOR                minimum Node major version (default 20)
#   LIVE_REALTIME_PROVIDER        with INSTALL_CONSUMER_YES=1: openai | gemini (default openai)
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
# all y/n. Optional API keys merge from env only when INSTALL_CONSUMER_YES=1.
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
  say_dim "Release server + Chrome extension · host tools (ffmpeg/ffprobe, Python 3, jq, …) · openai-whisper venv (required local STT) · SQLite + .app-runtime-config.json (databaseUrl, listenHost, listenPort, keys). Optional .env: dotenv loads HOST, PORT, DATABASE_URL for the server and Prisma CLI."
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

trim_crlf() {
  local s="$1"
  s="${s//$'\r'/}"
  printf '%s' "$s" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
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
  elif prompt_yn "Append aicopilot shortcuts to ~/.zshrc? (aicopilot = kill listener on listenPort in .app-runtime-config.json or PORT in .env, then start server)" "y"; then
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
  local port="${AI_INTERVIEW_COPILOT_PORT:-}"
  if [[ -z "$port" && -f "${root}/.app-runtime-config.json" ]] && command -v jq >/dev/null 2>&1; then
    port="$(jq -r '(.listenPort // "")|tostring' "${root}/.app-runtime-config.json" 2>/dev/null | tr -d '[:space:]')"
  fi
  if [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && [[ -f "${root}/.env" ]]; then
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

host_is_windows_gitbash() {
  case "$(uname -s)" in
    MINGW64* | MINGW32* | MSYS* | CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

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
    mingw* | msys* | cygwin*)
      if [[ "${arch}" != x64 ]]; then
        echo "Prebuilt server is only available for win-x64 (found win-${arch})." >&2
        exit 1
      fi
      printf '%s' "win-x64"
      ;;
    *)
      echo "Unsupported OS: $(uname -s) — use PowerShell: install.ps1, or WSL/Linux/macOS with install.sh" >&2
      exit 1
      ;;
  esac
}

# Returns: apt | dnf | pacman | empty (unknown).
linux_pkg_family() {
  if [[ ! -f /etc/os-release ]]; then
    printf '%s' ""
    return
  fi
  # shellcheck source=/dev/null
  . /etc/os-release
  case "${ID:-}" in
    ubuntu | debian | pop | linuxmint | zorin | elementary | kali | neon | parrot | devuan | raspbian)
      printf '%s' "apt"
      ;;
    fedora | rhel | centos | almalinux | rocky | ol | nobara | ultramarine | mageia | amzn)
      printf '%s' "dnf"
      ;;
    arch | manjaro | endeavouros | garuda | cachyos)
      printf '%s' "pacman"
      ;;
    *)
      # Derivatives often only set ID_LIKE (e.g. Mint: ID=linuxmint ID_LIKE=ubuntu).
      local like=" ${ID_LIKE:-} "
      if [[ "$like" == *" debian "* ]] || [[ "$like" == *" ubuntu "* ]]; then
        printf '%s' "apt"
      elif [[ "$like" == *" rhel "* ]] || [[ "$like" == *" fedora "* ]] || [[ "$like" == *" centos "* ]]; then
        printf '%s' "dnf"
      elif [[ "$like" == *" arch "* ]]; then
        printf '%s' "pacman"
      else
        printf '%s' ""
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Dependency installation
# ---------------------------------------------------------------------------

# Server and Prisma require Node 20+ (see repo .nvmrc).
NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-20}"

node_major() {
  node -p "Number(process.version.slice(1).split('.')[0])" 2>/dev/null || echo 0
}

node_is_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local m
  m="$(node_major)"
  ((m >= NODE_MIN_MAJOR))
}

node_version_line() {
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$(node -v 2>/dev/null)"
  else
    printf '%s' "not found"
  fi
}

# After brew/apt/dnf, PATH can still point at an old node; hash + nvm + this retry help.
upgrade_node_on_host() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    say_dim "Ensuring Homebrew Node is ${NODE_MIN_MAJOR}+ (upgrade or install)…"
    brew upgrade node 2>/dev/null || brew install node || return 1
    return 0
  fi
  if [[ "$os" != "Linux" ]]; then
    return 1
  fi
  case "$(linux_pkg_family)" in
    apt)
      say_dim "Ensuring NodeSource nodejs package is installed/upgraded…"
      sudo apt-get install -y nodejs
      ;;
    dnf)
      say_dim "Re-running NodeSource 22.x setup and nodejs install…"
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
      sudo dnf install -y nodejs npm
      ;;
    pacman)
      say_dim "Upgrading nodejs (pacman)…"
      sudo pacman -Sy --needed --noconfirm nodejs npm
      ;;
    *) return 1 ;;
  esac
  return 0
}

# After bulk OS install, PATH can hide Homebrew python3; this step reinstalls/upgrade distro Python for openai-whisper.
upgrade_python_on_host() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    say_dim "Ensuring Homebrew Python 3 (install or upgrade)…"
    brew install python3 2>/dev/null || brew upgrade python3 || return 1
    return 0
  fi
  if [[ "$os" != "Linux" ]]; then
    return 1
  fi
  case "$(linux_pkg_family)" in
    apt)
      say_dim "Installing python3, venv, and pip (apt)…"
      sudo apt-get update -qq
      sudo apt-get install -y python3 python3-venv python3-pip
      ;;
    dnf)
      say_dim "Installing python3 and pip (dnf)…"
      sudo dnf install -y python3 python3-pip
      ;;
    pacman)
      say_dim "Installing python and pip (pacman)…"
      sudo pacman -Sy --needed --noconfirm python python-pip
      ;;
    *) return 1 ;;
  esac
  return 0
}

install_deps_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    say "Homebrew is not installed. Install it from https://brew.sh then re-run this script."
    return 1
  fi
  say "brew install node ffmpeg python3 jq unzip"
  brew install node ffmpeg python3 jq unzip
  hash -r 2>/dev/null || true
}

# Git Bash / MSYS: use winget (Windows Package Manager).
install_deps_windows_gitbash() {
  if ! command -v winget >/dev/null 2>&1; then
    say "winget not found. Install dependencies manually or run install.ps1 in PowerShell."
    say "Need: Node.js ${NODE_MIN_MAJOR}+, ffmpeg, ffprobe, Python 3, jq, tar (Windows 10+), unzip (optional for extension)."
    return 1
  fi
  say "Installing dependencies via winget (silent; may require elevation once)…"
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent || true
  winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements --silent || true
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent || true
  winget install -e --id jqlang.jq --accept-package-agreements --accept-source-agreements --silent || true
  hash -r 2>/dev/null || true
  return 0
}

install_deps_linux_apt() {
  say "Configuring Node.js 22.x (NodeSource) and system packages (sudo required)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs ffmpeg python3 python3-venv python3-pip curl ca-certificates jq unzip build-essential
  hash -r 2>/dev/null || true
}

install_deps_linux_dnf() {
  say "Configuring Node.js 22.x (NodeSource RPM) and system packages (sudo required)..."
  if ! curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -; then
    say_warn "NodeSource RPM setup failed; installing distro nodejs (may be below ${NODE_MIN_MAJOR} on some releases)."
  fi
  sudo dnf install -y nodejs npm ffmpeg python3 python3-pip curl jq unzip gcc gcc-c++ make
  hash -r 2>/dev/null || true
}

install_deps_linux_pacman() {
  say "Installing packages with pacman (sudo required). Node should be ${NODE_MIN_MAJOR}+ on rolling repos."
  sudo pacman -Sy --needed --noconfirm nodejs npm ffmpeg python python-pip jq unzip curl tar
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
  if host_is_windows_gitbash; then
    install_deps_windows_gitbash
    return $?
  fi
  if [[ "$os" != "Linux" ]]; then
    say "Unsupported OS for automatic dependency install."
    return 1
  fi
  case "$(linux_pkg_family)" in
    apt) install_deps_linux_apt ;;
    dnf) install_deps_linux_dnf ;;
    pacman) install_deps_linux_pacman ;;
    *)
      say "Unsupported Linux distribution for automatic install."
      if [[ -f /etc/os-release ]]; then
        # shellcheck source=/dev/null
        . /etc/os-release
        say_dim "Detected: ID=${ID:-unknown} VERSION_ID=${VERSION_ID:-} ID_LIKE=${ID_LIKE:-}"
      fi
      say "Install manually: Node.js ${NODE_MIN_MAJOR}+, ffmpeg, ffprobe, Python 3 (+ venv/pip on Debian), jq, unzip, curl, tar."
      say "Debian/Ubuntu and derivatives: https://github.com/nodesource/distributions then apt install ffmpeg python3 python3-venv python3-pip jq unzip build-essential"
      say "Fedora/RHEL family: dnf install nodejs npm ffmpeg python3 python3-pip jq unzip gcc gcc-c++ make (or NodeSource RPM setup_22.x)."
      say "Arch: pacman -S nodejs npm ffmpeg python jq unzip curl tar"
      say "Windows: PowerShell: install.ps1 (or Git Bash + winget via this script when dependencies are missing)"
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

python3_runtime_ok() {
  command -v python3 >/dev/null 2>&1 && return 0
  command -v py >/dev/null 2>&1 && py -3 -c "import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)" 2>/dev/null && return 0
  command -v python >/dev/null 2>&1 && python -c "import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)" 2>/dev/null && return 0
  return 1
}

ensure_runtime_after_install() {
  maybe_nvm
  if ! node_is_ok; then
    echo "Node.js ${NODE_MIN_MAJOR}+ is still not available after install (found: $(command -v node 2>/dev/null || echo none) $(node_version_line))." >&2
    echo "Open a new terminal or run: hash -r  (with nvm: nvm install ${NODE_MIN_MAJOR} && nvm use ${NODE_MIN_MAJOR})" >&2
    return 1
  fi
  if ! python3_runtime_ok; then
    echo "Python 3 is required (python3, py -3, or python on PATH)." >&2
    return 1
  fi
  require_cmds curl tar ffmpeg ffprobe jq unzip || return 1
  return 0
}

# ---------------------------------------------------------------------------
# GitHub release download
# ---------------------------------------------------------------------------

github_download_url() {
  local want_name="$1"
  local json_path="$2"
  local url
  url="$(jq -r --arg name "${want_name}" '
    (.assets // [])
    | map(select(.name == $name))
    | if length > 0 then .[0].browser_download_url else empty end
  ' "${json_path}")"
  [[ -n "${url}" && "${url}" != "null" ]] || return 1
  printf '%s' "${url}"
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

# Consumer tarball layout: install root = server root (same dir as .env).
ensure_app_runtime_config_file() {
  if [[ -f .app-runtime-config.json ]]; then
    return 0
  fi
  if [[ -f .app-runtime-config.example.json ]]; then
    cp .app-runtime-config.example.json .app-runtime-config.json
    return 0
  fi
  printf '%s\n' '{"version":1,"evaluationProvider":"single-agent"}' >.app-runtime-config.json
}

# Set LibSQL DATABASE_URL in .app-runtime-config.json (Prisma / server). Requires jq.
merge_database_url_into_app_runtime_config() {
  local root="$1"
  local url="$2"
  local cfg="${root}/.app-runtime-config.json"
  [[ -f "$cfg" ]] || return 1
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/aic-dburl.XXXXXX")"
  if ! jq --arg u "$url" '.version = 1 | .databaseUrl = $u' "$cfg" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$cfg"
  return 0
}

# Fill empty model / voice fields from shipped .app-runtime-config.defaults.json (first preset in each list).
apply_shipped_runtime_model_defaults() {
  local root="$1"
  local cfg="${root}/.app-runtime-config.json"
  local def="${root}/.app-runtime-config.defaults.json"
  [[ -f "$def" ]] || return 0
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/aic-rt-def.XXXXXX")"
  if ! jq -s '
    .[0] as $cfg | .[1] as $d
    | $cfg
    | .version = 1
    | if (($cfg.openaiRealtimeModel // "") | tostring | length == 0) and (($d.openaiRealtimeModelOptions // []) | length > 0)
        then .openaiRealtimeModel = $d.openaiRealtimeModelOptions[0] else . end
    | if (($cfg.openaiRealtimeVoice // "") | tostring | length == 0) and (($d.openaiRealtimeVoiceOptions // []) | length > 0)
        then .openaiRealtimeVoice = $d.openaiRealtimeVoiceOptions[0] else . end
    | if (($cfg.geminiLiveModel // "") | tostring | length == 0) and (($d.geminiLiveModelOptions // []) | length > 0)
        then .geminiLiveModel = $d.geminiLiveModelOptions[0] else . end
    | if (($cfg.geminiLiveVoice // "") | tostring | length == 0) and (($d.geminiLiveVoiceOptions // []) | length > 0)
        then .geminiLiveVoice = $d.geminiLiveVoiceOptions[0] else . end
    | if (($cfg.openaiModelId // "") | tostring | length == 0) and (($d.openaiEvalModelOptions // []) | length > 0)
        then .openaiModelId = $d.openaiEvalModelOptions[0] else . end
    | if (($cfg.anthropicModelId // "") | tostring | length == 0) and (($d.anthropicEvalModelOptions // []) | length > 0)
        then .anthropicModelId = $d.anthropicEvalModelOptions[0] else . end
    | if (($cfg.geminiModelId // "") | tostring | length == 0) and (($d.geminiEvalModelOptions // []) | length > 0)
        then .geminiModelId = $d.geminiEvalModelOptions[0] else . end
    | if (($cfg.evaluationProvider // "") | tostring | length == 0) and (($d.evaluationProvider // "") | tostring | length > 0)
        then .evaluationProvider = $d.evaluationProvider else . end
  ' "$cfg" "$def" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$cfg"
}

# Merge non-empty fields into .app-runtime-config.json (camelCase keys). Uses jq (required by this installer).
# Args: install_root openai anthropic gemini gemini_live_model llm local_whisper_exe live_realtime_provider patch_providers(0|1)
# When patch_providers=1, empty llm/live args remove llmProvider / liveRealtimeProvider (installer keys pass). When 0, empty args leave those keys unchanged (e.g. whisper-only merge).
# Empty evaluationProvider is always set to single-agent.
merge_app_runtime_config_snippet() {
  local root="$1"
  local cfg="${root}/.app-runtime-config.json"
  local openai_key anthropic_key gemini_key gemini_model llm_choice whisper_sh live_rt
  openai_key="$(trim_crlf "${2:-}")"
  anthropic_key="$(trim_crlf "${3:-}")"
  gemini_key="$(trim_crlf "${4:-}")"
  gemini_model="$(trim_crlf "${5:-}")"
  llm_choice="$(trim_crlf "${6:-}")"
  whisper_sh="$(trim_crlf "${7:-}")"
  live_rt="$(trim_crlf "${8:-}" | tr '[:upper:]' '[:lower:]')"
  local patch_pv_json="false"
  [[ "${9:-0}" == "1" ]] && patch_pv_json="true"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/aic-rt-merge.XXXXXX")"
  if ! { [[ -f "$cfg" ]] && [[ -s "$cfg" ]] && cat "$cfg" || printf '%s\n' '{"version":1}'; } | jq -s \
    --arg o "$openai_key" \
    --arg a "$anthropic_key" \
    --arg g "$gemini_key" \
    --arg gl "$gemini_model" \
    --arg l "$llm_choice" \
    --arg w "$whisper_sh" \
    --arg lr "$live_rt" \
    --argjson patchPv "${patch_pv_json}" \
    '
    .[0] as $raw
    | ($raw | if type == "object" and .version == 1 then . else {"version":1} end) as $base
    | $base
    | (if ($o | length) > 0 then .openaiApiKey = $o else . end)
    | (if ($a | length) > 0 then .anthropicApiKey = $a else . end)
    | (if ($g | length) > 0 then .geminiApiKey = $g else . end)
    | (if ($gl | length) > 0 then .geminiLiveModel = $gl else . end)
    | if $patchPv then
        (if ($l | length) > 0 and ($l == "openai" or $l == "anthropic" or $l == "gemini") then .llmProvider = $l else del(.llmProvider) end)
      else
        (if ($l | length) > 0 and ($l == "openai" or $l == "anthropic" or $l == "gemini") then .llmProvider = $l else . end)
      end
    | (if ($w | length) > 0 then .localWhisperExecutable = $w else . end)
    | if $patchPv then
        (if ($lr | length) > 0 and ($lr == "openai" or $lr == "gemini") then .liveRealtimeProvider = $lr else del(.liveRealtimeProvider) end)
      else
        (if ($lr | length) > 0 and ($lr == "openai" or $lr == "gemini") then .liveRealtimeProvider = $lr else . end)
      end
    | .version = 1
    | if ((.evaluationProvider // "") | length == 0) then .evaluationProvider = "single-agent" else . end
    ' >"$tmp"; then
    rm -f "$tmp"
    printf '%s\n' "merge_app_runtime_config_snippet: jq failed while updating ${cfg} (invalid JSON or jq not installed)." >&2
    exit 1
  fi
  mv "$tmp" "$cfg"
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
  INSTALL_PROGRESS_TOTAL=11
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
    say_warn "Node.js ${NODE_MIN_MAJOR}+ required; current: $(node_version_line) ($(command -v node 2>/dev/null || echo no node on PATH))."
  fi
  for c in ffmpeg ffprobe jq unzip curl tar; do
    command -v "$c" >/dev/null 2>&1 || need_install=true
  done
  if ! python3_runtime_ok; then
    need_install=true
  fi
  if [[ "$need_install" == true ]]; then
    say_warn "Missing or not usable on PATH (the server needs these for recording merge, audio, and local tools):"
    if ! node_is_ok; then
      say "  - Node.js ${NODE_MIN_MAJOR}+ (run: node --version)"
    fi
    if ! python3_runtime_ok; then
      say "  - Python 3 (python3, py -3, or python)"
    fi
    for c in ffmpeg ffprobe jq unzip curl tar; do
      if ! command -v "$c" >/dev/null 2>&1; then
        say "  - ${c}"
      fi
    done
    local _dep_prompt="Install missing tools via Homebrew (macOS), apt/dnf/pacman (Linux), or winget (Windows Git Bash)? Uses sudo on Linux."
    if prompt_yn "${_dep_prompt}" "y"; then
      install_all_system_dependencies || {
        echo "Automatic dependency install failed. Fix errors above, install prerequisites manually, then re-run." >&2
        exit 1
      }
      hash -r 2>/dev/null || true
      maybe_nvm
      if ! node_is_ok; then
        say_warn "Node.js is still below ${NODE_MIN_MAJOR} after package install; running a dedicated Node upgrade step…"
        upgrade_node_on_host || say_warn "Dedicated Node upgrade step did not complete; check errors above."
        hash -r 2>/dev/null || true
        maybe_nvm
      fi
      if ! python3_runtime_ok; then
        say_warn "Python 3 is still missing after package install; running a dedicated Python install step…"
        upgrade_python_on_host || say_warn "Dedicated Python install step did not complete; check errors above."
        hash -r 2>/dev/null || true
      fi
    else
      if ! node_is_ok; then
        say_warn "Node.js ${NODE_MIN_MAJOR}+ is required. Install Node (e.g. https://nodejs.org/, nvm, or Homebrew) and re-run, or accept automatic dependency install when prompted."
      fi
      if ! python3_runtime_ok; then
        say_warn "Python 3 is required for openai-whisper (venv + pip). Install Python 3 or run install.ps1 on Windows, then re-run."
      fi
    fi
  else
    say_ok "Host dependency check passed — required tools are on PATH:"
    say_dim "  Video/audio: ffmpeg ($(command -v ffmpeg)), ffprobe ($(command -v ffprobe))"
    say_dim "  Node $(node --version 2>/dev/null)  ·  Python 3 OK  ·  jq ($(command -v jq))"
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
  local db_url="file:${db_file}"
  ensure_app_runtime_config_file
  if ! merge_database_url_into_app_runtime_config "${INSTALL_PREFIX}" "${db_url}"; then
    say_warn "Could not set databaseUrl in .app-runtime-config.json (jq missing or invalid JSON). Set databaseUrl manually, then run: npx prisma db push"
  fi
  if ! apply_shipped_runtime_model_defaults "${INSTALL_PREFIX}"; then
    say_warn "Could not merge default model ids from .app-runtime-config.defaults.json (jq or file issue). You can set models in Server config later."
  fi
  tick_done "Data directory and .app-runtime-config.json ready (databaseUrl set for SQLite)"
  bump_install_progress "Data / runtime config"

  banner "Runtime configuration"
  say_dim "API keys and providers are not collected during install. Use Chrome → Server config (extension) after install, then restart the server."
  local openai_key="" anthropic_key="" gemini_key="" gemini_model=""
  local llm_choice="openai"
  local live_rt_for_merge=""
  local llm_for_merge=""

  if [[ "${AUTO_YES}" == "1" ]]; then
    say_dim "INSTALL_CONSUMER_YES=1: merging optional keys from env when set (LIVE_REALTIME_PROVIDER, OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, LLM_PROVIDER)."
    local live_rt_raw
    live_rt_raw="$(trim_crlf "${LIVE_REALTIME_PROVIDER:-}")"
    live_rt_raw="$(printf '%s' "$live_rt_raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    openai_key="$(trim_crlf "${OPENAI_API_KEY:-}")"
    gemini_key="$(trim_crlf "${GEMINI_API_KEY:-}")"
    anthropic_key="$(trim_crlf "${ANTHROPIC_API_KEY:-}")"
    llm_choice="$(trim_crlf "${LLM_PROVIDER:-openai}")"
    if [[ "$live_rt_raw" == "openai" && -n "$openai_key" ]]; then
      live_rt_for_merge="openai"
    elif [[ "$live_rt_raw" == "gemini" && -n "$gemini_key" ]]; then
      live_rt_for_merge="gemini"
    fi
    llm_choice="$(printf '%s' "$llm_choice" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    if [[ "$llm_choice" != "openai" && "$llm_choice" != "anthropic" && "$llm_choice" != "gemini" ]]; then
      say_warn "Unrecognized LLM_PROVIDER='${llm_choice}' — using openai."
      llm_choice="openai"
    fi
    case "$llm_choice" in
      openai) [[ -n "$openai_key" ]] && llm_for_merge="openai" ;;
      anthropic) [[ -n "$anthropic_key" ]] && llm_for_merge="anthropic" ;;
      gemini) [[ -n "$gemini_key" ]] && llm_for_merge="gemini" ;;
    esac
    gemini_model=""
    merge_app_runtime_config_snippet "${INSTALL_PREFIX}" \
      "${openai_key}" \
      "${anthropic_key}" \
      "${gemini_key}" \
      "${gemini_model}" \
      "${llm_for_merge}" \
      "" \
      "${live_rt_for_merge}" \
      "1"
  fi

  tick_done "Runtime config ready (configure keys in Server config if needed)"
  bump_install_progress "Runtime config"

  printf '%b%s%b\n' "${C_ACCENT}" "Prisma db push…" "${C_RST}"
  export DATABASE_URL="${db_url}"
  npx prisma db push
  tick_done "Database schema applied (Prisma)"
  bump_install_progress "Prisma"

  banner "openai-whisper CLI (local STT, required)"
  local venv_whisper="${INSTALL_PREFIX}/venv-whisper"
  if ! python3_runtime_ok; then
    printf '%b%s%b\n' "${C_ERR}" "Python 3 is required on PATH for openai-whisper (local speech-to-text). Install Python 3, re-run host dependency install, or re-run this script." "${C_RST}" >&2
    exit 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv "${venv_whisper}"
  elif command -v py >/dev/null 2>&1; then
    py -3 -m venv "${venv_whisper}"
  else
    python -m venv "${venv_whisper}"
  fi
  local pip_cmd whisper_exe_path
  if [[ -x "${venv_whisper}/Scripts/pip.exe" ]]; then
    pip_cmd="${venv_whisper}/Scripts/pip.exe"
    whisper_exe_path="${venv_whisper}/Scripts/whisper.exe"
  else
    pip_cmd="${venv_whisper}/bin/pip"
    whisper_exe_path="${venv_whisper}/bin/whisper"
  fi
  "${pip_cmd}" install -U pip setuptools wheel
  say_dim "Installing openai-whisper (plain CLI; not WhisperX)…"
  "${pip_cmd}" install "openai-whisper"
  mkdir -p "${INSTALL_PREFIX}/bin"
  local whisper_sh
  if host_is_windows_gitbash; then
    whisper_sh="${INSTALL_PREFIX}/bin/whisper.cmd"
    printf '%s\n' '@echo off' '"%~dp0..\venv-whisper\Scripts\whisper.exe" %*' >"${whisper_sh}"
  else
    whisper_sh="${INSTALL_PREFIX}/bin/whisper"
    cat >"${whisper_sh}" <<EOF
#!/usr/bin/env bash
exec "${whisper_exe_path}" "\$@"
EOF
    chmod +x "${whisper_sh}"
  fi
  merge_app_runtime_config_snippet "${INSTALL_PREFIX}" "" "" "" "" "" "${whisper_sh}" "" "0"
  tick_done "openai-whisper CLI ready (${whisper_sh})"
  bump_install_progress "openai-whisper"

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
PORT=""
if [[ -f "${ROOT}/.app-runtime-config.json" ]] && command -v jq >/dev/null 2>&1; then
  PORT="$(jq -r '(.listenPort // "")|tostring' "${ROOT}/.app-runtime-config.json" 2>/dev/null | tr -d '[:space:]')"
fi
if [[ -z "${PORT}" || ! "${PORT}" =~ ^[0-9]+$ ]] && [[ -f "${ROOT}/.env" ]]; then
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
# Stop the API: kill listener on listenPort (.app-runtime-config.json), else PORT in .env, else 3001.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${ROOT}/server.log"
PORT=""
if [[ -f "${ROOT}/.app-runtime-config.json" ]] && command -v jq >/dev/null 2>&1; then
  PORT="$(jq -r '(.listenPort // "")|tostring' "${ROOT}/.app-runtime-config.json" 2>/dev/null | tr -d '[:space:]')"
fi
if [[ -z "${PORT}" || ! "${PORT}" =~ ^[0-9]+$ ]] && [[ -f "${ROOT}/.env" ]]; then
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

  if host_is_windows_gitbash; then
    local wcmd="${INSTALL_PREFIX}/start-server.cmd"
    printf '%s\r\n' '@echo off' 'cd /d "%~dp0"' 'node dist\index.js' >"${wcmd}"
    local wbg="${INSTALL_PREFIX}/start-server-background.ps1"
    cat >"${wbg}" <<'WBG'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT
$log = Join-Path $ROOT 'server.log'
$port = 3001
$cfgp = Join-Path $ROOT '.app-runtime-config.json'
if (Test-Path $cfgp) {
  try {
    $cj = Get-Content $cfgp -Raw | ConvertFrom-Json
    if ($cj.listenPort) { $port = [int]$cj.listenPort }
  } catch { }
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
$stamp = (Get-Date).ToString('u')
Add-Content $log "`n===== $stamp starting (PORT=$port) ====="
$p = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $ROOT -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError $log
$p.Id | Set-Content (Join-Path $ROOT 'server.pid')
Write-Host "Started PID $($p.Id) — log $log"
WBG
    local wstop="${INSTALL_PREFIX}/stop-server.ps1"
    cat >"${wstop}" <<'WST'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3001
$cfgp = Join-Path $ROOT '.app-runtime-config.json'
if (Test-Path $cfgp) {
  try {
    $cj = Get-Content $cfgp -Raw | ConvertFrom-Json
    if ($cj.listenPort) { $port = [int]$cj.listenPort }
  } catch { }
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $ROOT 'server.pid') -ErrorAction SilentlyContinue
Write-Host "Stopped listener on port $port (if any)."
WST
    say_dim "Also wrote start-server.cmd, start-server-background.ps1, stop-server.ps1 for native Windows."
  fi

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
  if host_is_windows_gitbash; then
    say_ok "Windows CMD   ${INSTALL_PREFIX}/start-server.cmd"
    say_ok "Windows bg    powershell -File ${INSTALL_PREFIX}/start-server-background.ps1"
    say_ok "Windows stop  powershell -File ${INSTALL_PREFIX}/stop-server.ps1"
  fi
  local _zshrc_done="${ZDOTDIR:-$HOME}/.zshrc"
  if [[ -f "${_zshrc_done}" ]] && grep -qF "${ZSH_LAUNCHER_MARKER}" "${_zshrc_done}" 2>/dev/null; then
    say_dim "Shell: ${C_BOLD}aicopilot${C_RST} · ${C_BOLD}aicopilot-bg${C_RST} · ${C_BOLD}aicopilot-stop${C_RST} · ${C_BOLD}aicopilot-update${C_RST} (source ${_zshrc_done} first)"
  fi
  say_dim "Optional PATH: export PATH=\"${INSTALL_PREFIX}/bin:\${PATH}\""
  say ""
  say_dim "Tweak ${INSTALL_PREFIX}/.app-runtime-config.json in Chrome Server config for keys, models, listenHost, listenPort, databaseUrl, … .env is optional (shell exports or legacy PORT only). localWhisperExecutable is set to bin/whisper from this install."
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
