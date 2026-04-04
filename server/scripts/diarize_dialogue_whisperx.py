#!/usr/bin/env python3
"""
Transcribe + align + speaker-diarize a 16 kHz mono WAV (e.g. dialogue-mixed-16k.wav).

Requires:
  pip install whisperx torch torchaudio
  ffmpeg on PATH
  Hugging Face token (read access) and acceptance of gated pyannote models (same HF account as the token):
    https://huggingface.co/settings/tokens  — fine-grained: read on gated repos you use; classic: Read scope
    https://huggingface.co/pyannote/speaker-diarization-3.1  — accept user conditions
    https://huggingface.co/pyannote/segmentation-3.0         — accept if downloads ask for it

Usage:
  python3 diarize_dialogue_whisperx.py <in.wav> <out.json>

Env (optional):
  WHISPERX_MODEL            default: base
  WHISPERX_DEVICE           default: cpu
  WHISPERX_COMPUTE_TYPE     default: int8 (cpu-friendly)
  WHISPERX_BATCH_SIZE       default: 8
  HF_TOKEN or HUGGING_FACE_HUB_TOKEN — required for diarization (script mirrors into HF_* for huggingface_hub)
  WHISPERX_MIN_SPEAKERS     optional int
  WHISPERX_MAX_SPEAKERS     optional int
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def _patch_torch_load_for_pyannote_checkpoints() -> None:
    """PyTorch 2.6+ defaults torch.load(weights_only=True); pyannote VAD checkpoints need full unpickle."""
    import torch

    _orig = torch.load

    def _load(*args: object, **kwargs: object):
        # Lightning/pyannote may pass weights_only=True; pyannote checkpoints need full unpickle (trusted HF weights).
        kwargs["weights_only"] = False
        return _orig(*args, **kwargs)

    torch.load = _load  # type: ignore[method-assign]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav_path")
    ap.add_argument("out_json_path")
    args = ap.parse_args()

    try:
        _patch_torch_load_for_pyannote_checkpoints()
        import whisperx
    except ImportError:
        print(
            "whisperx is not installed. Try: pip install -U whisperx",
            file=sys.stderr,
        )
        return 3
    try:
        from whisperx.diarize import DiarizationPipeline
    except ImportError:
        DiarizationPipeline = getattr(whisperx, "DiarizationPipeline", None)
        if DiarizationPipeline is None:
            print(
                "whisperx.diarize.DiarizationPipeline missing; upgrade: pip install -U whisperx",
                file=sys.stderr,
            )
            return 3

    hf = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
    if not hf:
        print(
            "Set HF_TOKEN (or HUGGING_FACE_HUB_TOKEN) for pyannote diarization.",
            file=sys.stderr,
        )
        return 2

    # Gated pyannote weights use huggingface_hub; ensure the token is visible to all loaders.
    os.environ.setdefault("HF_TOKEN", hf)
    os.environ.setdefault("HUGGING_FACE_HUB_TOKEN", hf)

    model_name = os.environ.get("WHISPERX_MODEL", "base").strip() or "base"
    device = os.environ.get("WHISPERX_DEVICE", "cpu").strip() or "cpu"
    compute_type = os.environ.get("WHISPERX_COMPUTE_TYPE", "int8").strip() or "int8"
    batch_size = int(os.environ.get("WHISPERX_BATCH_SIZE", "8") or "8")

    audio = whisperx.load_audio(args.wav_path)
    model = whisperx.load_model(
        model_name,
        device,
        compute_type=compute_type,
    )
    result = model.transcribe(audio, batch_size=batch_size)

    lang = result.get("language") or "en"
    if not isinstance(lang, str):
        lang = "en"

    align_model, align_meta = whisperx.load_align_model(
        language_code=lang,
        device=device,
    )
    result = whisperx.align(
        result["segments"],
        align_model,
        align_meta,
        audio,
        device,
        return_char_alignments=False,
    )

    try:
        diarize_model = DiarizationPipeline(token=hf, device=device)
    except TypeError:
        # Older whisperx builds used use_auth_token=
        diarize_model = DiarizationPipeline(use_auth_token=hf, device=device)
    diarize_kw = {}
    if os.environ.get("WHISPERX_MIN_SPEAKERS"):
        diarize_kw["min_speakers"] = int(os.environ["WHISPERX_MIN_SPEAKERS"])
    if os.environ.get("WHISPERX_MAX_SPEAKERS"):
        diarize_kw["max_speakers"] = int(os.environ["WHISPERX_MAX_SPEAKERS"])
    diarize_segments = diarize_model(audio, **diarize_kw)
    result = whisperx.assign_word_speakers(diarize_segments, result)

    def segment_speaker(seg: dict) -> str:
        if seg.get("speaker"):
            return str(seg["speaker"])
        words = seg.get("words") or []
        counts: dict[str, int] = {}
        for w in words:
            sp = w.get("speaker")
            if sp:
                counts[str(sp)] = counts.get(str(sp), 0) + 1
        if not counts:
            return "UNKNOWN"
        return max(counts, key=counts.get)

    raw_segs: list[dict] = []
    for seg in result.get("segments") or []:
        txt = (seg.get("text") or "").strip()
        if not txt:
            continue
        start = float(seg.get("start", 0))
        end = float(seg.get("end", start))
        raw_segs.append(
            {
                "start": start,
                "end": end,
                "speaker": segment_speaker(seg),
                "text": txt,
            }
        )

    merged = merge_adjacent_segments(raw_segs)

    payload = {
        "provider": "whisperx",
        "model": model_name,
        "language": lang,
        "segments": merged,
    }
    out_path = args.out_json_path
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return 0


def merge_adjacent_segments(
    segments: list[dict],
    max_gap_sec: float = 0.75,
) -> list[dict]:
    if not segments:
        return []
    out: list[dict] = [dict(segments[0])]
    for s in segments[1:]:
        prev = out[-1]
        gap = float(s["start"]) - float(prev["end"])
        same = s.get("speaker") == prev.get("speaker")
        if same and gap <= max_gap_sec:
            prev["text"] = (prev["text"] + " " + str(s["text"])).strip()
            prev["end"] = s["end"]
        else:
            out.append(dict(s))
    return out


if __name__ == "__main__":
    sys.exit(main())
