// ── OpenAI Realtime voice (frontend) ──
// Streams mic audio (16kHz PCM) to /api/live-openai and plays the 24kHz PCM reply.
// Audio-only sibling of gemini-live.js. Toggle with the GPT button.
// The server proxy translates to/from OpenAI's GA realtime protocol, emitting the
// same Gemini-shaped messages this client consumes.

let ws = null;
let micCtx = null, micStream = null, procNode = null, sourceNode = null, muteGain = null;
let playCtx = null, playHead = 0, scheduled = [];
let active = false;

const IN_RATE = 16000;
const OUT_RATE = 24000;

function setState(state) {
  window.dispatchEvent(new CustomEvent('voice-state', { detail: state }));
  const btn = document.getElementById('gpt-toggle-btn');
  if (btn) {
    btn.classList.remove('state-idle', 'state-listening', 'state-speaking');
    btn.classList.add('state-' + state);
    const label = btn.querySelector('.gpt-label');
    if (label) label.textContent = active ? 'GPT ●' : 'GPT';
  }
}

function b64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function downsampleToPCM16(float32, inRate) {
  const ratio = inRate / IN_RATE;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function playPCM(bytes) {
  if (!playCtx) return;
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  const buf = playCtx.createBuffer(1, f32.length, OUT_RATE);
  buf.getChannelData(0).set(f32);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (playHead < now) playHead = now;
  src.start(playHead);
  src.onended = () => { scheduled = scheduled.filter((s) => s !== src); };
  scheduled.push(src);
  playHead += buf.duration;
  setState('speaking');
}
function stopPlayback() {
  scheduled.forEach((s) => { try { s.stop(); } catch {} });
  scheduled = [];
  playHead = 0;
}

function handleMsg(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'proxy-ready') { console.log('[GPT] proxy ready'); return; }
  if (msg.type === 'proxy-error') { window.dispatchEvent(new CustomEvent('voice-error', { detail: 'OpenAI Live: ' + msg.message })); return; }
  if (msg.type === 'live-task') { window.dispatchEvent(new CustomEvent('voice-transcript', { detail: '⚙️ ' + msg.task })); return; }

  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) stopPlayback();
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) if (p.inlineData?.data) playPCM(bytesFromB64(p.inlineData.data));
    if (sc.inputTranscription?.text) window.dispatchEvent(new CustomEvent('voice-transcript', { detail: sc.inputTranscription.text }));
    if (sc.outputTranscription?.text) window.dispatchEvent(new CustomEvent('voice-response-text', { detail: sc.outputTranscription.text }));
    if (sc.turnComplete && active) setState('listening');
  }
}

async function startMic() {
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  sourceNode = micCtx.createMediaStreamSource(micStream);
  procNode = micCtx.createScriptProcessor(4096, 1, 1);
  muteGain = micCtx.createGain();
  muteGain.gain.value = 0;
  sourceNode.connect(procNode);
  procNode.connect(muteGain);
  muteGain.connect(micCtx.destination);
  procNode.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = downsampleToPCM16(input, micCtx.sampleRate);
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBytes(pcm), mimeType: 'audio/pcm;rate=16000' } } }));
  };
  setState('listening');
}

export async function startGptLive() {
  if (active) return;
  active = true;
  // Mutual exclusion with the other voice modes.
  try {
    const g = await import('./gemini-live.js');
    if (g.isLiveActive && g.isLiveActive()) g.stopLive();
  } catch {}
  try {
    const v = await import('./voice.js');
    if (v.isVoiceActive && v.isVoiceActive()) await v.stopVoiceMode();
  } catch {}

  try {
    playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    await playCtx.resume();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/live-openai`);
    ws.onopen = async () => {
      try { await startMic(); }
      catch (e) { window.dispatchEvent(new CustomEvent('voice-error', { detail: 'Mic: ' + (e.name || e.message) })); stopGptLive(); return; }
    };
    ws.onmessage = (e) => handleMsg(e.data);
    ws.onerror = () => window.dispatchEvent(new CustomEvent('voice-error', { detail: 'GPT Live connection error' }));
    ws.onclose = () => { if (active) stopGptLive(); };
  } catch (e) {
    active = false;
    window.dispatchEvent(new CustomEvent('voice-error', { detail: 'GPT Live start failed: ' + e.message }));
  }
}

export function stopGptLive() {
  active = false;
  stopPlayback();
  try { procNode?.disconnect(); sourceNode?.disconnect(); muteGain?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx?.close(); } catch {}
  try { playCtx?.close(); } catch {}
  try { ws?.close(); } catch {}
  ws = null; micCtx = null; playCtx = null; playHead = 0; scheduled = [];
  setState('idle');
}

export function toggleGptLive() { return active ? stopGptLive() : startGptLive(); }
export function isGptLiveActive() { return active; }

export function initOpenAiLive() {
  if (document.getElementById('gpt-toggle-btn')) return;
  const b = document.createElement('button');
  b.id = 'gpt-toggle-btn';
  b.type = 'button';
  b.innerHTML = '<span class="gpt-dot"></span><span class="gpt-label">GPT</span>';

  const style = document.createElement('style');
  style.textContent = `
    #gpt-toggle-btn {
      position: fixed; right: 24px; bottom: 132px; z-index: 9999;
      display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px;
      background: rgba(10,14,20,.72); color: #19c37d;
      border: 1px solid rgba(25,195,125,.55);
      box-shadow: 0 0 18px rgba(25,195,125,.25); backdrop-filter: blur(8px);
      font-family: inherit; font-size: 12px; letter-spacing: 1.5px; font-weight: 600;
      cursor: pointer; transition: all .2s ease; user-select: none;
    }
    #gpt-toggle-btn:hover { box-shadow: 0 0 26px rgba(25,195,125,.5); }
    #gpt-toggle-btn .gpt-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .5; }
    #gpt-toggle-btn.state-listening, #gpt-toggle-btn.state-speaking {
      background: rgba(25,195,125,.18); animation: gptwave 1.2s ease-in-out infinite;
    }
    #gpt-toggle-btn.state-listening .gpt-dot, #gpt-toggle-btn.state-speaking .gpt-dot { opacity: 1; }
    @keyframes gptwave { 0%,100%{box-shadow:0 0 14px rgba(25,195,125,.3)} 50%{box-shadow:0 0 30px rgba(25,195,125,.75)} }
    @media (max-width:768px){
      #gpt-toggle-btn{
        left:14px; right:auto;
        bottom:calc(248px + env(safe-area-inset-bottom, 0px));
        min-height:44px;
      }
      body.mobile-sheet-open #gpt-toggle-btn{ display:none !important; }
    }
  `;
  document.head.appendChild(style);
  b.addEventListener('click', () => toggleGptLive());
  document.body.appendChild(b);
}
