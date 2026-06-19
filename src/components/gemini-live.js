// ── Gemini Live realtime voice (frontend) ──
// Streams mic audio (16kHz PCM) to /api/live and plays Gemini's 24kHz PCM reply.
// Separate from the turn-based VOICE button. Toggle with the LIVE button.

let ws = null;
let micCtx = null;
let micStream = null;
let procNode = null;
let sourceNode = null;
let muteGain = null;

let playCtx = null;
let playHead = 0;
let scheduled = [];      // scheduled AudioBufferSourceNodes (for barge-in stop)
let active = false;

// ── camera (live vision) ──
let camStream = null;    // MediaStream from getUserMedia({video})
let camVideo = null;     // hidden <video> playing the stream
let camCanvas = null;    // offscreen canvas for frame grabs
let camTimer = null;     // setInterval handle (1 fps)
let camPreview = null;   // visible self-view <video> in the HUD
let cameraOn = false;

const IN_RATE = 16000;
const OUT_RATE = 24000;
const CAM_FPS = 1;       // Gemini Live processes video at ~1 frame/sec
const CAM_W = 640;       // downscaled frame width sent to Gemini (keeps tokens low)
const CAM_JPEG_Q = 0.6;

function setState(state) {
  window.dispatchEvent(new CustomEvent('voice-state', { detail: state }));
  const btn = document.getElementById('live-toggle-btn');
  if (btn) {
    btn.classList.remove('state-idle', 'state-listening', 'state-speaking');
    btn.classList.add('state-' + state);
    const label = btn.querySelector('.live-label');
    if (label) label.textContent = active ? 'LIVE ●' : 'LIVE';
  }
}

// ── encoding helpers ──
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

// Float32 @ inRate → Int16 LE @ 16kHz
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

// ── playback (24kHz PCM16) ──
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

// ── server messages ──
function handleMsg(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === 'proxy-ready') { console.log('[LIVE] proxy ready'); return; }
  if (msg.type === 'proxy-error') { window.dispatchEvent(new CustomEvent('voice-error', { detail: 'Gemini Live: ' + msg.message })); return; }

  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) stopPlayback();                       // barge-in
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.data) playPCM(bytesFromB64(p.inlineData.data));
    }
    if (sc.inputTranscription?.text) {
      window.dispatchEvent(new CustomEvent('voice-transcript', { detail: sc.inputTranscription.text }));
    }
    if (sc.outputTranscription?.text) {
      window.dispatchEvent(new CustomEvent('voice-response-text', { detail: sc.outputTranscription.text }));
    }
    if (sc.turnComplete && active) setState('listening');
  }
}

// ── mic ──
async function startMic() {
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  sourceNode = micCtx.createMediaStreamSource(micStream);
  procNode = micCtx.createScriptProcessor(4096, 1, 1);
  muteGain = micCtx.createGain();
  muteGain.gain.value = 0;                 // don't echo mic to speakers
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

// ── camera: stream 1 fps JPEG frames to Gemini on the same socket ──
async function startCamera() {
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
  });

  // hidden video element decodes the stream so we can grab frames
  camVideo = document.createElement('video');
  camVideo.muted = true;
  camVideo.playsInline = true;
  camVideo.srcObject = camStream;
  await camVideo.play();

  camCanvas = document.createElement('canvas');

  // visible self-view in the HUD (bottom-left), so you see what Jigarson sees
  showPreview(camStream);

  cameraOn = true;
  camTimer = setInterval(sendFrame, 1000 / CAM_FPS);
}

function sendFrame() {
  if (!cameraOn || !ws || ws.readyState !== WebSocket.OPEN || !camVideo) return;
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  if (!vw || !vh) return;                       // not ready yet
  const w = CAM_W, h = Math.round((vh / vw) * CAM_W);
  camCanvas.width = w; camCanvas.height = h;
  const ctx = camCanvas.getContext('2d');
  ctx.drawImage(camVideo, 0, 0, w, h);
  camCanvas.toBlob((blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const b64 = String(reader.result).split(',')[1];   // strip data: prefix
      ws.send(JSON.stringify({ realtimeInput: { video: { data: b64, mimeType: 'image/jpeg' } } }));
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', CAM_JPEG_Q);
}

function stopCamera() {
  cameraOn = false;
  if (camTimer) { clearInterval(camTimer); camTimer = null; }
  try { camStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { camVideo?.pause(); } catch {}
  hidePreview();
  camStream = null; camVideo = null; camCanvas = null;
}

function showPreview(stream) {
  if (!camPreview) {
    camPreview = document.createElement('video');
    camPreview.id = 'live-cam-preview';
    camPreview.muted = true;
    camPreview.playsInline = true;
    camPreview.autoplay = true;
    camPreview.style.cssText = `
      position: fixed; left: 24px; bottom: 24px; z-index: 9999;
      width: 180px; height: 135px; object-fit: cover; border-radius: 12px;
      border: 1px solid rgba(var(--accent-rgb,41 211 255),.55);
      box-shadow: 0 0 18px rgba(var(--accent-rgb,41 211 255),.25);
      transform: scaleX(-1);`;                  // mirror like a selfie
    document.body.appendChild(camPreview);
  }
  camPreview.srcObject = stream;
  camPreview.style.display = 'block';
}

function hidePreview() {
  if (camPreview) { try { camPreview.srcObject = null; } catch {} camPreview.style.display = 'none'; }
}

// ── public API ──
export async function startLive() {
  if (active) return;
  active = true;

  // Mutual exclusion: only one voice mode at a time. Stop turn-based VOICE if on.
  try {
    const v = await import('./voice.js');
    if (v.isVoiceActive && v.isVoiceActive()) await v.stopVoiceMode();
  } catch {}

  try {
    playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    await playCtx.resume();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/live`);
    ws.onopen = async () => {
      try { await startMic(); }
      catch (e) { window.dispatchEvent(new CustomEvent('voice-error', { detail: 'Mic: ' + (e.name || e.message) })); stopLive(); return; }
      // Camera is best-effort: if it's denied, voice still works.
      try { await startCamera(); }
      catch (e) { window.dispatchEvent(new CustomEvent('voice-error', { detail: 'Camera: ' + (e.name || e.message) })); }
    };
    ws.onmessage = (e) => handleMsg(e.data);
    ws.onerror = () => window.dispatchEvent(new CustomEvent('voice-error', { detail: 'Live connection error' }));
    ws.onclose = () => { if (active) stopLive(); };
  } catch (e) {
    active = false;
    window.dispatchEvent(new CustomEvent('voice-error', { detail: 'Live start failed: ' + e.message }));
  }
}

export function stopLive() {
  active = false;
  stopPlayback();
  stopCamera();
  try { procNode?.disconnect(); sourceNode?.disconnect(); muteGain?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx?.close(); } catch {}
  try { playCtx?.close(); } catch {}
  try { ws?.close(); } catch {}
  ws = null; micCtx = null; playCtx = null; playHead = 0; scheduled = [];
  setState('idle');
}

export function toggleLive() { return active ? stopLive() : startLive(); }
export function isLiveActive() { return active; }

// ── LIVE button ──
export function initGeminiLive() {
  if (document.getElementById('live-toggle-btn')) return;
  const b = document.createElement('button');
  b.id = 'live-toggle-btn';
  b.type = 'button';
  b.innerHTML = '<span class="live-dot"></span><span class="live-label">LIVE</span>';

  const style = document.createElement('style');
  style.textContent = `
    #live-toggle-btn {
      position: fixed; right: 24px; bottom: 78px; z-index: 9999;
      display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px;
      background: rgba(10,14,20,.72); color: rgb(var(--accent-rgb,41 211 255));
      border: 1px solid rgba(var(--accent-rgb,41 211 255),.55);
      box-shadow: 0 0 18px rgba(var(--accent-rgb,41 211 255),.25); backdrop-filter: blur(8px);
      font-family: inherit; font-size: 12px; letter-spacing: 1.5px; font-weight: 600;
      cursor: pointer; transition: all .2s ease; user-select: none;
    }
    #live-toggle-btn:hover { box-shadow: 0 0 26px rgba(var(--accent-rgb,41 211 255),.5); }
    #live-toggle-btn .live-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .5; }
    #live-toggle-btn.state-listening, #live-toggle-btn.state-speaking {
      background: rgba(var(--accent-rgb,41 211 255),.18); animation: livewave 1.2s ease-in-out infinite;
    }
    #live-toggle-btn.state-listening .live-dot, #live-toggle-btn.state-speaking .live-dot { opacity: 1; }
    @keyframes livewave { 0%,100%{box-shadow:0 0 14px rgba(var(--accent-rgb,41 211 255),.3)} 50%{box-shadow:0 0 30px rgba(var(--accent-rgb,41 211 255),.75)} }
    @media (max-width:768px){
      #live-toggle-btn{
        left:14px; right:auto;
        bottom:calc(196px + env(safe-area-inset-bottom, 0px));
        min-height:44px;
      }
      #live-cam-preview{
        left:auto !important;
        right:14px !important;
        bottom:calc(148px + env(safe-area-inset-bottom, 0px)) !important;
        width:112px !important;
        height:84px !important;
      }
      body.mobile-sheet-open #live-toggle-btn,
      body.mobile-sheet-open #live-cam-preview{
        display:none !important;
      }
    }
  `;
  document.head.appendChild(style);
  b.addEventListener('click', () => toggleLive());
  document.body.appendChild(b);
}
