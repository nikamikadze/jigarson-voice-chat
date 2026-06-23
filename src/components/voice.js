// ── 語音對話模組 ──
// VAD（語音活動偵測）+ 自動錄音 + 打斷功能

import { MicVAD, utils } from '@ricky0123/vad-web';
import { dbg } from '../utils/debug-log.js';
import { playAudioUrl, stopAudio, isAudioPlaying } from '../utils/audio-player.js';
import { getDeviceId } from '../utils/device-id.js';

let vad = null;
let isVoiceMode = false;
let isProcessing = false;  // 正在處理語音（避免重複送出）
let playbackQueue = [];     // TTS 音訊播放佇列
let isPlaying = false;
let ws = null;
let isRecordingStream = false;
let isServerDone = true;


// ── 麥克風音訊串流變數 ──
let micCtx = null;
let micStream = null;
let procNode = null;
let sourceNode = null;
let muteGain = null;

const TARGET_RATE = 16000;
const VAD_AUDIO_RATE = 16000;
const PCM_CHUNK_BYTES = 32 * 1024;

// ── 狀態回調 ──
let onStateChange = null;   // (state: 'idle'|'listening'|'processing'|'speaking') => void

function setState(state) {
  if (onStateChange) onStateChange(state);
  // 同步 orb 視覺
  window.dispatchEvent(new CustomEvent('voice-state', { detail: state }));
}

// Float32 @ inRate → Int16 LE PCM @ 16kHz
function downsampleToPCM16(float32, inRate) {
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function sendCapturedSpeech(audioData) {
  if (!audioData || !audioData.length || !ws || ws.readyState !== WebSocket.OPEN) return 0;
  const pcm16 = downsampleToPCM16(audioData, VAD_AUDIO_RATE);
  for (let offset = 0; offset < pcm16.byteLength; offset += PCM_CHUNK_BYTES) {
    ws.send(pcm16.slice(offset, offset + PCM_CHUNK_BYTES));
  }
  return pcm16.byteLength;
}

async function primeMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    s.getTracks().forEach((t) => t.stop());
  } catch (err) {
    throw err;
  }
}

// ── VAD 初始化 ──
// Pre-warm VAD immediately on module load so the first click is instant.
let vadReady = null;

export function preWarmVAD() {
  if (vadReady) return vadReady;
  vadReady = initVAD()
    .then(() => dbg('voice.vadPrewarmOk'))
    .catch((e) => {
      dbg('voice.vadPrewarmFail', { err: String(e?.message).slice(0, 80) });
      vadReady = null; // allow retry on next startVoiceMode
    });
  return vadReady;
}

async function initVAD() {
  if (vad) return vad;   // idempotent: never build two VAD instances
  vad = await MicVAD.new({
    model: 'v5',
    startOnLoad: false,
    baseAssetPath: '/vad/',
    // Load the ONNX Runtime WASM from our own origin (/vad/), matching the
    // installed onnxruntime-web version. The old CDN pin (1.14.0) mismatched
    // the bundled runtime and failed to import as a module on iOS Safari
    // ("NO AVAILABLE BACKEND … importing a module script failed").
    onnxWASMBasePath: '/vad/',

    // iOS Safari cannot allocate the multi-threaded WASM build's large shared
    // memory reservation and throws "RangeError: out of memory". Force the
    // runtime to run single-threaded (non-shared memory) — desktop is fine
    // either way, and the VAD is tiny so single-threaded is plenty fast.
    ortConfig: (ort) => {
      try {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
      } catch {}
    },
    positiveSpeechThreshold: 0.8,
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: 5,
    preSpeechPadFrames: 10,
    redemptionFrames: 4,   // ~384ms silence — faster end-of-speech; still rides short pauses

    onSpeechStart: () => {
      dbg('voice.speechStart');
      // 打斷：如果 AI 正在播放語音，立刻停止
      if (isPlaying) {
        console.log('[VOICE] 打斷播放');
        stopPlayback();
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'start' }));
      }
      isRecordingStream = true;
      setState('listening');
    },

    onSpeechEnd: async (audioData) => {
      dbg('voice.speechEnd', { samples: audioData?.length || 0 });
      if (!isRecordingStream) return;
      isRecordingStream = false;
      setState('processing');

      // Reset isServerDone before ending the recording turn
      isServerDone = false;

      // Pause VAD during AI thinking and TTS playback to prevent feedback loop
      if (vad) await vad.pause();

      if (ws && ws.readyState === WebSocket.OPEN) {
        const bytes = sendCapturedSpeech(audioData);
        dbg('voice.sentCapturedSpeech', { bytes });
        ws.send(JSON.stringify({ type: 'end' }));
      }

      // 等播放完才回到 listening
      await waitPlaybackDone();

      // Short guard so speakers turn off and echoes settle before re-listening
      // (350ms; was 600ms). Lower = faster next turn, but too low risks echo re-trigger.
      await new Promise(resolve => setTimeout(resolve, 350));

      // Resume VAD for the next turn
      if (isVoiceMode && !isRecordingStream) {
        if (vad) await vad.start();
        setState('listening');
      }
    },

    onVADMisfire: () => {
      dbg('voice.misfire');
      isRecordingStream = false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'end' }));
      }
      setState('listening');
    }
  });
  return vad;
}

// ── 麥克風串流初始化 ──

async function startMicStreaming() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  // iOS Safari creates the AudioContext in a 'suspended' state — must resume
  // it (within the user gesture) or no audio frames are ever processed.
  if (micCtx.state === 'suspended') { try { await micCtx.resume(); } catch {} }
  sourceNode = micCtx.createMediaStreamSource(micStream);
  procNode = micCtx.createScriptProcessor(4096, 1, 1);
  muteGain = micCtx.createGain();
  muteGain.gain.value = 0; // 避免喇叭回授

  sourceNode.connect(procNode);
  procNode.connect(muteGain);
  muteGain.connect(micCtx.destination);

  procNode.onaudioprocess = (ev) => {
    if (isRecordingStream && ws && ws.readyState === WebSocket.OPEN) {
      const input = ev.inputBuffer.getChannelData(0);
      const pcm16 = downsampleToPCM16(input, micCtx.sampleRate);
      ws.send(pcm16);
    }
  };
}

function stopMicStreaming() {
  try { procNode?.disconnect(); sourceNode?.disconnect(); muteGain?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx?.close(); } catch {}
  micCtx = null; micStream = null; procNode = null; sourceNode = null; muteGain = null;
}

// ── WebSocket 訊息處理 ──

function handleWsMsg(rawData) {
  try {
    const data = JSON.parse(rawData);

    if (data.type === 'partial') {
      // Live partial transcript while user is still speaking
      window.dispatchEvent(new CustomEvent('voice-partial', { detail: data.text }));
    }

    if (data.type === 'transcript') {
      dbg('voice.transcript', { text: (data.text || '').slice(0, 80) });
      // Final confirmed transcript
      window.dispatchEvent(new CustomEvent('voice-transcript', { detail: data.text }));
    }

    if (data.type === 'tts-chunk') {
      // 收到一段 TTS 音訊（base64）
      setState('speaking');
      queueAudio(data.audio, data.contentType || 'audio/mp4');
    }

    if (data.type === 'text-chunk') {
      // 文字回應（給 chat 面板顯示用）
      window.dispatchEvent(new CustomEvent('voice-response-text', { detail: data.text }));
    }

    if (data.type === 'done') {
      dbg('voice.done');
      isServerDone = true;
    }

    if (data.type === 'error') {
      dbg('voice.serverError', { msg: String(data.message).slice(0, 140) });
      window.dispatchEvent(new CustomEvent('voice-error', { detail: data.message }));
      isServerDone = true;
    }
  } catch (err) {
    console.error('[VOICE] WebSocket message error:', err);
  }
}

// ── 音訊播放佇列 ──

function queueAudio(base64, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: contentType });
  const url = URL.createObjectURL(blob);

  dbg('voice.queueAudio', { bytes: blob.size, contentType, queued: playbackQueue.length });
  playbackQueue.push(url);
  if (!isPlaying) playNext();
}

function playNext() {
  if (playbackQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const url = playbackQueue.shift();
  dbg('voice.playNext', { remaining: playbackQueue.length });
  // 透過共用的、已在使用者手勢解鎖的 audio element 播放
  playAudioUrl(url)
    .catch((e) => dbg('voice.play.failed', { err: e?.name || String(e).slice(0, 100) }))
    .finally(() => {
      URL.revokeObjectURL(url);
      playNext();
    });
}

function stopPlayback() {
  stopAudio();
  // 清空佇列
  playbackQueue.forEach(url => URL.revokeObjectURL(url));
  playbackQueue = [];
  isPlaying = false;
}

function waitPlaybackDone() {
  return new Promise((resolve) => {
    const check = () => {
      if (isServerDone && !isPlaying && playbackQueue.length === 0 && !isAudioPlaying()) return resolve();
      setTimeout(check, 200);
    };
    check();
  });
}

// ── 公開 API ──

export async function startVoiceMode() {
  if (isVoiceMode) return;
  dbg('voice.start');

  try {
    // 1) Acquire microphone permission inside the user's tap, then immediately
    //    release it. VAD owns the actual live mic stream; keeping a second
    //    parallel stream open causes broken/choppy capture on some phones.
    await primeMicPermission();
    dbg('voice.micPermissionReady');

    // 2) Mutual exclusion: only one voice mode at a time. Stop Gemini Live if on.
    try {
      const live = await import('./gemini-live.js');
      if (live.isLiveActive && live.isLiveActive()) await live.stopLive();
    } catch {}

    // 3) Ensure the VAD is ready. Let a real failure throw (with a clear
    //    message) instead of silently leaving `vad` null and then crashing on
    //    `vad.start()` with "null is not an object".
    if (vadReady) { try { await vadReady; } catch {} }
    if (!vad) await initVAD();
    if (!vad) throw new Error('VAD 初始化失敗（模型/worklet 載入失敗）');
    dbg('voice.vadInitOk');

    // 4) Open WebSocket to the STT backend.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // /api/voice-stt streams PCM16 to Gemini Live for transcription only.
    // The answer model and Cartesia TTS remain separate downstream stages.
    ws = new WebSocket(`${proto}://${location.host}/api/voice-stt?device=${encodeURIComponent(getDeviceId())}`);
    ws.onmessage = (e) => handleWsMsg(e.data);

    // Wait for the WebSocket to open
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      };
    });

    // Restore standard error and close handlers
    ws.onerror = () => {
      dbg('voice.wsError');
      window.dispatchEvent(new CustomEvent('voice-error', { detail: '語音連線錯誤' }));
      isServerDone = true;
    };
    ws.onclose = () => {
      dbg('voice.wsClose');
      isServerDone = true;
    };

    // 5) Start detecting speech.
    await vad.start();
    dbg('voice.vadStarted');

    isVoiceMode = true;
    setState('listening');
  } catch (err) {
    dbg('voice.startFailed', { name: err?.name, msg: String(err?.message).slice(0, 140) });
    // 通知 UI
    window.dispatchEvent(new CustomEvent('voice-error', {
      detail: err.name === 'NotAllowedError' ? '麥克風權限被拒絕' : `語音模式啟動失敗: ${err.message}`
    }));
    setState('idle');
    stopVoiceMode();
  }
}

export async function stopVoiceMode() {
  if (!isVoiceMode) return;
  console.log('[VOICE] 關閉語音模式');

  isVoiceMode = false;
  isRecordingStream = false;
  isServerDone = true;

  if (vad) await vad.pause();
  stopPlayback();
  stopMicStreaming();
  setState('idle');

  if (ws) {
    ws.close();
    ws = null;
  }
}

export function toggleVoiceMode() {
  return isVoiceMode ? stopVoiceMode() : startVoiceMode();
}

export function isVoiceActive() {
  return isVoiceMode;
}

export function setOnStateChange(cb) {
  onStateChange = cb;
}
