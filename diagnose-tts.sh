#!/usr/bin/env bash
# JARVIS TTS diagnostic — run on your Mac:  bash diagnose-tts.sh
# Tests each engine independently and prints the REAL HTTP status / error.
set -u
cd "$(dirname "$0")"

# load .env
set -a; [ -f .env ] && . ./.env; set +a

GEM_MODEL="gemini-2.5-flash-preview-tts"
STT_MODEL="gemini-2.5-flash"
CART_VOICE="a167e0f3-df7e-4d52-a9c3-f949145efdab"
CART_MODEL="sonic-3.5"

line() { printf '\n========== %s ==========\n' "$1"; }

line "ENV CHECK"
echo "GEMINI_API_KEY  : ${GEMINI_API_KEY:0:6}…  (len ${#GEMINI_API_KEY})"
case "$GEMINI_API_KEY" in
  AIza*) echo "  -> looks like a standard Gemini API key (good, long-lived)";;
  AQ.*)  echo "  -> ⚠️ starts with 'AQ.' = a Gemini LIVE *ephemeral token*. These EXPIRE (often <1h)."
         echo "     If Gemini calls 401 below, this is why. You need a real API key (AIza…) from aistudio.google.com/apikey";;
  *)     echo "  -> unrecognized format";;
esac
echo "CARTESIA_API_KEY: ${CARTESIA_API_KEY:0:8}…  (len ${#CARTESIA_API_KEY})"

line "1) CARTESIA  (configured primary, expects mp3)"
CODE=$(curl -s -o /tmp/jdiag_cart.bin -w '%{http_code}' -X POST https://api.cartesia.ai/tts/bytes \
  -H "Cartesia-Version: 2026-03-01" -H "X-API-Key: ${CARTESIA_API_KEY:-none}" -H "Content-Type: application/json" \
  -d "{\"model_id\":\"$CART_MODEL\",\"transcript\":\"გამარჯობა\",\"voice\":{\"mode\":\"id\",\"id\":\"$CART_VOICE\"},\"language\":\"ka\",\"output_format\":{\"container\":\"mp3\",\"sample_rate\":24000}}")
echo "HTTP $CODE  bytes=$(wc -c </tmp/jdiag_cart.bin)"
[ "$CODE" = 200 ] && { echo "✅ Cartesia OK"; command -v afplay >/dev/null && afplay /tmp/jdiag_cart.bin; } \
                  || { echo "❌ Cartesia error body:"; head -c 500 /tmp/jdiag_cart.bin; echo; }

line "2) GEMINI STT model ($STT_MODEL) — does the key work at all?"
CODE=$(curl -s -o /tmp/jdiag_models.json -w '%{http_code}' \
  "https://generativelanguage.googleapis.com/v1beta/models/$STT_MODEL" -H "x-goog-api-key: ${GEMINI_API_KEY:-none}")
echo "HTTP $CODE"
[ "$CODE" = 200 ] && echo "✅ Gemini key valid (STT model reachable)" || { echo "❌ body:"; head -c 500 /tmp/jdiag_models.json; echo; }

line "3) GEMINI TTS model ($GEM_MODEL) — the fallback that's actually been speaking"
CODE=$(curl -s -o /tmp/jdiag_gtts.json -w '%{http_code}' -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/$GEM_MODEL:generateContent" \
  -H "x-goog-api-key: ${GEMINI_API_KEY:-none}" -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"გამარჯობა"}]}],"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}')
echo "HTTP $CODE"
if [ "$CODE" = 200 ]; then echo "✅ Gemini TTS OK"; else echo "❌ body (look for 429=quota / 401=bad key / 404=model gone):"; head -c 700 /tmp/jdiag_gtts.json; echo; fi

line "4) EDGE-TTS fallback (free, Georgian) — installed?"
if python3 -m edge_tts --text "გამარჯობა" --voice ka-GE-GiorgiNeural --write-media /tmp/jdiag_edge.mp3 2>/tmp/jdiag_edge.err; then
  echo "✅ edge-tts OK ($(wc -c </tmp/jdiag_edge.mp3) bytes)"; command -v afplay >/dev/null && afplay /tmp/jdiag_edge.mp3
else echo "❌ edge-tts not working:"; head -c 300 /tmp/jdiag_edge.err; echo "  (install: pip3 install edge-tts)"; fi

line "5) IS THE SERVER UP on the configured port?"
PORT=$(grep -o '"port"[^,]*' config.json | grep -o '[0-9]\+')
echo "config port = $PORT"
curl -s -o /tmp/jdiag_srv.bin -w 'POST /api/tts -> HTTP %{http_code} type=%{content_type} bytes=%{size_download}\n' \
  -X POST "http://localhost:$PORT/api/tts" -H 'Content-Type: application/json' \
  -d '{"text":"გამარჯობა, მე ვარ ჯარვისი"}'
command -v afplay >/dev/null && [ -s /tmp/jdiag_srv.bin ] && afplay /tmp/jdiag_srv.bin 2>/dev/null

echo; echo "Done. Paste this whole output back."
