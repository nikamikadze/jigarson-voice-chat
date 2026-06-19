# JARVIS UI — Georgian Voice Integration — Handoff / Context

## What this project is
- **App:** `jincocodev/openclaw-jarvis-ui` — a JARVIS-style HUD dashboard (3D orb, chat, system monitor) for an **OpenClaw** AI agent.
- **Where it runs:** locally on the user's Mac, served by **pm2** process named `jarvis` at **http://localhost:9999**.
- **Stack:** Node/Express backend (`server/`) that relays over WebSocket to the OpenClaw Gateway, plus a Vite single-page frontend (`src/`, built to `dist/`).
- **Browser:** user uses **Brave**. OpenClaw app version **2026.6.1**, gateway `ws://127.0.0.1:18789`, session key `agent:main:main`.

## Goal
Talk to the agent **in Georgian**: speak → transcribe (STT) → OpenClaw agent replies in Georgian → reply spoken aloud (TTS), shown in the HUD.

## Architecture of the voice loop
- **STT:** browser Silero VAD (`src/components/voice.js`) records speech → `POST /api/voice` → `server/routes/voice.js` → **Gemini** `geminiTranscribe` (model `gemini-2.5-flash`, language hint Georgian).
- **Brain:** transcript → `gwRequest('chat.send', {deliver:false})` to OpenClaw (a "(reply only in Georgian)" instruction is appended).
- **TTS:** reply text → **Cartesia Sonic 3.5** (`server/cartesia.js`), Blake voice, `language: "ka"`, returns MP3 → streamed to browser → played.
- Typed chat replies also speak via `chat.js speakText()` → `POST /api/tts`.

## Changes already made (all in this repo)
- `server/gateway.js` — **patched** to connect: `maxProtocol` 3→6 (gateway uses newer protocol), and auth sends `{ token, password }` (gateway is **password-auth** mode).
- `server/gemini.js` (NEW) — Gemini STT + TTS helpers, with `postJSON()` retry/backoff on 503/429/500.
- `server/cartesia.js` (NEW) — Cartesia `/tts/bytes` call (Cartesia-Version `2026-03-01`, `X-API-Key`, model `sonic-3.5`, voice id `a167e0f3-df7e-4d52-a9c3-f949145efdab` (Blake), `language: ka`, mp3 out), with retries.
- `server/tts.js` — engine registry now: **cartesia (default)**, gemini, macos, edge. `ttsSentence()` returns `{buffer, contentType}`. Per-engine branches in `synthesizeToResponse` and `ttsSentence`.
- `server/routes/voice.js` — STT switched from missing `whisper-cli` to Gemini; appends reply-language instruction; **single TTS call at `final`** (not per-sentence); handles gateway `state: 'delta'`.
- `server/index.js` — exposes `app.locals.voice`.
- `config.json` — `tts.engine: "cartesia"`, cartesia voice/lang/model; `voice.sttLanguage` / `voice.replyLanguage` = `"Georgian"`.
- `src/components/voice-ui.js` (NEW) + `src/main.js` — adds the **VOICE** mic button (bottom-right), hotkey **⌘⇧V**, maps voice states to the orb, shows transcript + reply in chat.
- `src/components/chat.js` — `speakText()` now plays via a **plain `new Audio()`** element (was routed through the Web Audio graph).
- `test-gemini.js`, `test-georgian.js` — standalone smoke tests.

## Secrets / config (in `.env`, on the Mac)
- `GATEWAY_TOKEN` = the OpenClaw gateway **password** (auth mode: password).
- `GEMINI_API_KEY` = stored only in local `.env`.
- `CARTESIA_API_KEY` = stored only in local `.env`. Source skill: `~/.openclaw/skills/voice-replies/` (Cartesia → ElevenLabs → edge-tts fallback chain).

## Run / build / restart
- Server-only change → `pm2 restart jarvis`
- Frontend (`src/`) change → **must rebuild on the Mac**: `npm run build` then `pm2 restart jarvis`
  - (Build CANNOT run in the assistant sandbox — `node_modules` are macOS-native; Rollup needs the darwin binary.)
- If env vars change, clean restart: `pm2 delete jarvis && pm2 start server/index.js --name jarvis --node-args="--env-file=.env" && pm2 save`

## What is CONFIRMED WORKING
- **Server TTS works:** `curl POST /api/tts` returns audio; `afplay` plays clear **Georgian** (Cartesia mp3, ~117KB sentence; Gemini wav earlier too).
- **Browser can play audio:** in the Brave console, `new Audio(URL.createObjectURL(blob)).play()` on `/api/tts` output → `PLAYED OK`, audible.
- **STT works:** Gemini transcribed Georgian correctly (logs: `[VOICE] 轉錄: "გესმის ჩემი ხმა?"` etc).
- **Agent replies:** gateway `delta`/`final` chat events flow.
- **Build is current:** `dist/assets/index-CnTrIsTR.js` contains the new `speakText` fix ("TTS playback blocked") and the `voice-toggle-btn`.

## THE OPEN PROBLEM (unsolved)
**The web app does not play TTS audio**, even though the server produces it and the browser can play it.
Already ruled out:
- Not stale cache / service worker (sw.js is network-first; bundle on disk is current; fails in **private window** too).
- Not the server (curl works).
- Not browser inability (console plain-Audio works).
- Brave **autoplay was set to Allow** by the user — and it reportedly **still doesn't speak**.

## Key UNKNOWNS to resolve next (do these first)
1. **Which path is silent — typed chat vs the VOICE button?** User never confirmed. They use different code (`chat.js speakText` vs `voice.js queueAudio`). Pin this down first.
2. **Browser console errors during a reply** — need the actual red errors and the Network status of `/api/tts` (typed) or `/api/voice` (voice) when a reply happens. Without this we're guessing.
3. Is the open tab actually executing `index-CnTrIsTR.js`? (Check DevTools → Sources/Network.)

## Suggested next moves
- Add a visible **"🔊 Test Voice" button** to the HUD that, on click (guaranteed user gesture), fetches `/api/tts` and plays via plain `Audio`. If that works in-app → the problem is the *automatic* (non-gesture) playback trigger → implement an **audio-unlock on first user gesture** (play a short/silent buffer on first click, reuse the unlocked context).
- Verify `speakText()` is actually reached on a typed reply (the `done` handler in `chat.js` ~line 359 calls `speakText(replyBuffer)`), and that `replyBuffer` is non-empty.
- For voice mode, confirm `voice.js` receives the `tts-chunk` and that `playNext()/new Audio().play()` isn't rejecting (it swallows errors in `.catch(() => playNext())`).
- Consider routing ALL playback through one robust, gesture-unlocked `Audio` helper.

## Useful commands
```bash
# server TTS smoke test (Georgian)
curl -s -X POST http://localhost:9999/api/tts -H 'Content-Type: application/json' \
  -d '{"text":"გამარჯობა, მე ვარ ჯარვისი"}' -o /tmp/c.mp3 \
  -w 'HTTP %{http_code} type=%{content_type} bytes=%{size_download}\n' && afplay /tmp/c.mp3

# logs
pm2 logs jarvis --lines 50 --nostream

# rebuild + restart after frontend changes
cd ~/openclaw-jarvis-ui && npm run build && pm2 restart jarvis
```
