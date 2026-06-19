#!/usr/bin/env python3
# Local Whisper STT for JARVIS — no API, no billing, runs on-device.
# Usage: python3 whisper_stt.py <audio_path> [language_code]
# Prints the transcript to stdout. Any diagnostics go to stderr.
#
# Model + device are configurable via env:
#   WHISPER_MODEL   (default: "small")   e.g. tiny / base / small / medium / large-v3
#   WHISPER_DEVICE  (default: "cpu")
#   WHISPER_COMPUTE (default: "int8")    int8 is fast + low-memory on CPU
#
# Requires: pip3 install faster-whisper

import os
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: whisper_stt.py <audio_path> [language_code]", file=sys.stderr)
        sys.exit(2)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    if language in ("", "auto", "None"):
        language = None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper not installed. Run: pip3 install faster-whisper",
              file=sys.stderr)
        sys.exit(3)

    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute = os.environ.get("WHISPER_COMPUTE", "int8")

    # The model is downloaded once and cached in ~/.cache/huggingface.
    model = WhisperModel(model_size, device=device, compute_type=compute)

    segments, _info = model.transcribe(
        audio_path,
        language=language,        # None = auto-detect
        vad_filter=True,          # drop silence/noise so empty clips stay empty
        beam_size=5,
    )

    text = "".join(seg.text for seg in segments).strip()
    # Print only the transcript on stdout.
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
