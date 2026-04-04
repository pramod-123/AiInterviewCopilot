#!/usr/bin/env bash
# Manual run (same logic as server post-process when DIARIZATION_PROVIDER=whisperx).
# Requires: pip install -U whisperx torch, ffmpeg, HF token with pyannote access.
#
# Usage:
#   export HF_TOKEN=...
#   ./whisperx-diarize.example.sh path/to/dialogue-mixed-16k.wav path/to/out/diarization.json
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "" || "${2:-}" == "" ]]; then
  echo "Usage: $0 <16kHz-mono.wav> <out.json>"
  exit 1
fi
exec python3 "$SCRIPT_DIR/diarize_dialogue_whisperx.py" "$1" "$2"
