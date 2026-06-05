import { RealtimeSocket } from './socket.js';
import { MicPcmStreamer } from './mic-stream.js';
import { PcmPlayer } from './audio-player.js';

const els = {
  connection: document.querySelector('#connection'),
  state: document.querySelector('#state'),
  hint: document.querySelector('#hint'),
  orb: document.querySelector('#orb'),
  wave: document.querySelector('#wave'),
  mute: document.querySelector('#mute'),
  talk: document.querySelector('#talk')
};

const sessionId = localStorage.jigarsonSession || (localStorage.jigarsonSession = crypto.randomUUID());
const socket = new RealtimeSocket({ sessionId, onEvent });
const player = new PcmPlayer({
  onPlaybackStart: (turnId) => socket.send({ type: 'playback-start', turnId, at: performance.now() })
});

let mic;
let micStarted = false;
let audioConfig = {};
let pushToTalkActive = false;
let ready = false;

const stateCopy = {
  connecting: ['Connecting', 'Starting voice session'],
  idle: ['Ready', 'Hold the button to talk'],
  listening: ['Listening', 'Release when finished'],
  thinking: ['Thinking', 'Preparing a reply'],
  speaking: ['Speaking', 'You can interrupt anytime'],
  error: ['Error', 'Refresh or check the server'],
  type: ['Microphone unavailable', 'Use browser permissions to enable audio']
};

function setState(name) {
  const [label, hint] = stateCopy[name] || [name, ''];
  els.state.textContent = label;
  if (els.hint) els.hint.textContent = hint;
  document.body.dataset.state = name;
  els.orb.classList.toggle('listening', name === 'listening');
  els.orb.classList.toggle('thinking', name === 'thinking');
  els.orb.classList.toggle('speaking', name === 'speaking');
  els.orb.classList.toggle('error', name === 'error' || name === 'type');
  els.wave?.classList.toggle('active', name === 'speaking');
  els.mute?.classList.toggle('active', name === 'speaking' || name === 'thinking');
}

function setConnection(label) {
  if (els.connection) els.connection.textContent = label;
}

async function startMic(config = {}) {
  if (micStarted) return;
  micStarted = true;
  mic = new MicPcmStreamer({
    chunkMs: config.chunkMs || 40,
    targetSampleRate: config.inputSampleRate || 24000,
    vadEnabled: Boolean(config.clientVad),
    vadStartLevel: config.clientVadStartLevel,
    vadEndLevel: config.clientVadEndLevel,
    vadStartMs: config.clientVadStartMs,
    vadSilenceMs: config.clientVadSilenceMs,
    onChunk: (buffer) => socket.sendBinary(buffer),
    onLevel: (level) => {
      const normalized = Math.min(1, level * 18);
      els.orb.style.setProperty('--level', String(normalized));
      els.wave?.style.setProperty('--level', String(normalized));
    },
    onState: () => {},
    onSpeechStart: (event) => socket.send({ type: 'client-speech-start', at: event.at, level: event.level }),
    onSpeechEnd: (event) => socket.send({ type: 'client-speech-end', at: event.at, level: event.level }),
    onStats: (stats) => {
      socket.send({ type: 'audio-diagnostics', stats });
    }
  });
  await mic.start();
}

function silenceFrame(config = {}) {
  const sampleRate = config.inputSampleRate || 24000;
  const chunkMs = config.chunkMs || 40;
  const samples = Math.round(sampleRate * (chunkMs / 1000));
  return new ArrayBuffer(samples * 2);
}

function sendSilenceTail(durationMs = 900) {
  const chunkMs = audioConfig.chunkMs || 40;
  const chunks = Math.ceil(durationMs / chunkMs);
  const frame = silenceFrame(audioConfig);
  for (let i = 0; i < chunks; i += 1) socket.sendBinary(frame);
}

async function beginPushToTalk(event) {
  event?.preventDefault();
  if (!ready || pushToTalkActive) return;
  pushToTalkActive = true;
  if (event?.pointerId !== undefined) els.talk.setPointerCapture?.(event.pointerId);
  els.talk.classList.add('active');
  els.talk.setAttribute('aria-pressed', 'true');
  player.stop();
  socket.send({ type: 'cancel' });
  try {
    await startMic(audioConfig);
    mic?.setActive(true);
    setState('listening');
  } catch (err) {
    pushToTalkActive = false;
    els.talk.classList.remove('active');
    els.talk.setAttribute('aria-pressed', 'false');
    setConnection(err.message);
    setState('type');
  }
}

function endPushToTalk(event) {
  event?.preventDefault();
  if (!pushToTalkActive) return;
  if (event?.pointerId !== undefined) els.talk.releasePointerCapture?.(event.pointerId);
  pushToTalkActive = false;
  els.talk.classList.remove('active');
  els.talk.setAttribute('aria-pressed', 'false');
  mic?.setActive(false);
  sendSilenceTail();
  setState('thinking');
}

function onEvent(event) {
  if (event.type === 'ready') {
    setConnection('connected');
    audioConfig = event.audio || {};
    ready = true;
    els.talk.disabled = false;
    setState('idle');
  }

  if (event.type === 'connection-state') {
    if (event.target === 'gemini') setConnection(event.state);
    if (event.target === 'stt') setConnection(`stt ${event.state}`);
    if (event.target === 'tts' && event.state !== 'connected') setConnection(`tts ${event.state}`);
  }

  if (event.type === 'speech-start') {
    player.stop();
    setState('listening');
  }

  if (event.type === 'stt-partial') {
    setState('listening');
  }

  if (event.type === 'stt-final') {
    setState('thinking');
  }

  if (event.type === 'ai-start') {
    setState('thinking');
  }

  if (event.type === 'speaking') {
    setState('speaking');
  }

  if (event.type === 'audio') player.enqueue(event.audioB64, event.sampleRate, event.turnId);

  if (event.type === 'ai-done') {
    setState('idle');
  }

  if (event.type === 'cancelled') {
    player.stop();
    if (!pushToTalkActive) setState('idle');
  }

  if (event.type === 'error') {
    console.error(event.message);
    setConnection(event.message);
    setState('error');
  }
}

els.mute.addEventListener('click', () => {
  player.stop();
  socket.send({ type: 'cancel' });
});

els.talk.addEventListener('pointerdown', beginPushToTalk);
els.talk.addEventListener('pointerup', endPushToTalk);
els.talk.addEventListener('pointercancel', endPushToTalk);
els.talk.addEventListener('pointerleave', endPushToTalk);
els.talk.addEventListener('contextmenu', (event) => event.preventDefault());
els.talk.addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.code === 'Enter') beginPushToTalk(event);
});
els.talk.addEventListener('keyup', (event) => {
  if (event.code === 'Space' || event.code === 'Enter') endPushToTalk(event);
});

socket.connect();
setState('connecting');
