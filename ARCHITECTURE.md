# Realtime Architecture

```text
Microphone
  -> browser PCM16 capture, 16 kHz mono frames
  -> app WebSocket /realtime
  -> Gemini Live API WebSocket
  -> native realtime audio understanding + model turn + speech output
  -> raw PCM chunks, 24 kHz mono
  -> browser AudioContext streaming playback
```

The browser only captures microphone audio and plays PCM output. It does not use browser `SpeechRecognition` or `MediaRecorder` for the conversation path.

The backend owns the realtime session:

- `/providers/gemini/live.js` connects to Gemini Live and forwards 16 kHz PCM16 audio through `realtimeInput.audio`.
- Gemini Live provides input transcription, model response, output transcription, barge-in, and 24 kHz PCM16 speech output in one WebSocket session.
- `/audio/realtimeSession.js` adapts Gemini events to the existing browser event contract.

Set `VOICE_PROVIDER=legacy` to use the previous provider chain:

- `/providers/stt/openaiRealtime.js` connects to OpenAI Realtime transcription mode and forwards 24 kHz PCM16 audio through `input_audio_buffer.append`.
- `/providers/llm/openai.js` streams GPT-5 mini token by token, preserves session memory, and keeps the existing persona prompt.
- `/providers/tts/cartesia.js` keeps one Cartesia WebSocket open per browser session, streams text chunks as GPT tokens arrive, and reconnects automatically on failure.

Barge-in path:

```text
Gemini Live detects new user activity
  -> browser stops playback and clears queued audio
  -> Gemini interrupts current model output
  -> Gemini continues on the same live session
```

Metrics are printed in the Node console and shown in the UI:

- `speech_start`
- `speech_end`
- `transcript_final`
- `first_gpt_token`
- `first_tts_chunk`
- `first_audio_chunk`
- `playback_start`

Summary format:

```text
STT: 320ms | GPT first token: 410ms | TTS first audio: 180ms | Playback start: 40ms | Total: 950ms
```

Run locally:

```bash
npm install
npm start
```

Open `http://localhost:3000`, grant microphone permission, and speak Georgian.
