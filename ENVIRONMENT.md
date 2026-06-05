# Environment

Create `.env` in the project root.

```env
OPENAI_API_KEY=your_openai_key
CARTESIA_API_KEY=your_cartesia_key
GEMINI_API_KEY=your_gemini_key

PORT=3000

# Voice pipeline: `gemini` uses Gemini Live for STT + LLM + TTS.
# Use `legacy` to keep the old STT + LLM + Cartesia chain.
VOICE_PROVIDER=gemini

# Gemini Live
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_VOICE=Laomedeia
GEMINI_TEMPERATURE=0.85
GEMINI_VAD_SILENCE_MS=700
GEMINI_VAD_PREFIX_PADDING_MS=120
GEMINI_CONNECT_TIMEOUT_MS=10000

# STT provider: `elevenlabs` or `openai`
STT_PROVIDER=elevenlabs

# LLM provider: `openai` or `openclaw`
LLM_PROVIDER=openclaw
OPENCLAW_AGENT_URL=http://185.2.101.66:8000/chat
# Optional if your agent requires auth.
# OPENCLAW_API_KEY=your_agent_key
# `voice_site` sends { message, language, temperature, session_id } for this Contabo agent.
# `simple` sends { sessionId, session_id, message, input, text, stream }.
# `openai` sends { model, stream, messages, session_id }.
OPENCLAW_BODY_FORMAT=voice_site
OPENCLAW_LANGUAGE=ka
OPENCLAW_TEMPERATURE=0.7
OPENCLAW_STREAM=false

# ElevenLabs Scribe v2 Realtime
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_STT_MODEL=scribe_v2_realtime
ELEVENLABS_STT_LANGUAGE=kat
ELEVENLABS_STT_COMMIT_STRATEGY=vad
ELEVENLABS_STT_VAD_SILENCE_SECS=1.2
ELEVENLABS_STT_VAD_THRESHOLD=0.4
ELEVENLABS_STT_MIN_SPEECH_MS=100
ELEVENLABS_STT_MIN_SILENCE_MS=350

# OpenAI Realtime transcription
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
OPENAI_REALTIME_TRANSCRIBE_DELAY=high
OPENAI_TRANSCRIBE_LANGUAGE=ka
# Set OPENAI_TRANSCRIBE_LANGUAGE=omit to omit language from the Realtime session.
OPENAI_TRANSCRIBE_PROMPT=Transcribe spoken Georgian accurately. Use Georgian script, do not translate to English, and preserve Georgian names, places, numbers, and natural punctuation. The audio is a live Georgian voice assistant conversation, so prefer conversational Georgian wording over English lookalikes.
OPENAI_STT_NOISE_REDUCTION=near_field
OPENAI_TRANSCRIBE_INCLUDE_LOGPROBS=false
OPENAI_UPLOAD_TRANSCRIBE_MODEL=gpt-4o-transcribe
OPENAI_TRANSCRIPT_CORRECTION=true
OPENAI_TRANSCRIPT_CORRECTION_TIMEOUT_MS=1500
OPENAI_TRANSCRIPT_CORRECTION_MAX_TOKENS=90

# OpenAI server-side VAD
OPENAI_VAD_THRESHOLD=0.42
OPENAI_VAD_PREFIX_PADDING_MS=260
OPENAI_VAD_SILENCE_DURATION_MS=420

# Browser-side VAD, used by gpt-realtime-whisper because it is manually committed.
CLIENT_VAD_START_LEVEL=0.018
CLIENT_VAD_END_LEVEL=0.01
CLIENT_VAD_START_MS=120
CLIENT_VAD_SILENCE_MS=700

# GPT-5 mini
OPENAI_LLM_MODEL=gpt-5-mini
OPENAI_LLM_MAX_TOKENS=180
OPENAI_LLM_REASONING_EFFORT=minimal
# OPENAI_LLM_TEMPERATURE=0.7

# Cartesia streaming TTS
CARTESIA_MODEL=sonic-3.5
CARTESIA_VERSION=2026-03-01
CARTESIA_VOICE_BLAKE=a167e0f3-df7e-4d52-a9c3-f949145efdab
CARTESIA_MAX_BUFFER_DELAY_MS=120
CARTESIA_RECONNECT_MS=350
TTS_SAMPLE_RATE=24000
TTS_FLUSH_CHARS=28
TTS_START_TIMEOUT_MS=1200

# Browser microphone framing
AUDIO_CHUNK_MS=40
```

`DEEPSEEK_API_KEY` is no longer used. Browser `SpeechRecognition` is not used.
