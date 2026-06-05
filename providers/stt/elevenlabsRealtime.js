import WebSocket from 'ws';

const ELEVENLABS_REALTIME_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const INPUT_SAMPLE_RATE = 24000;
const ELEVEN_SAMPLE_RATE = 16000;

function now() {
  return performance.now();
}

function apiKey() {
  return process.env.ELEVENLABS_API_KEY || process.env.ELEVENLAB_API_KEY;
}

function pcm16ToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function resamplePcm16(buffer, inputRate = INPUT_SAMPLE_RATE, outputRate = ELEVEN_SAMPLE_RATE) {
  if (inputRate === outputRate) return Buffer.from(buffer);
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = Buffer.alloc(outputLength * 2);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = Math.max(-32768, Math.min(32767, Math.round(sum / Math.max(1, end - start))));
    output.writeInt16LE(sample, i * 2);
  }

  return output;
}

function realtimeUrl() {
  const params = new URLSearchParams({
    model_id: process.env.ELEVENLABS_STT_MODEL || 'scribe_v2_realtime',
    language_code: process.env.ELEVENLABS_STT_LANGUAGE || 'kat',
    audio_format: 'pcm_16000',
    commit_strategy: process.env.ELEVENLABS_STT_COMMIT_STRATEGY || 'vad',
    vad_silence_threshold_secs: process.env.ELEVENLABS_STT_VAD_SILENCE_SECS || '1.2',
    vad_threshold: process.env.ELEVENLABS_STT_VAD_THRESHOLD || '0.4',
    min_speech_duration_ms: process.env.ELEVENLABS_STT_MIN_SPEECH_MS || '100',
    min_silence_duration_ms: process.env.ELEVENLABS_STT_MIN_SILENCE_MS || '350',
    include_timestamps: 'false',
    include_language_detection: 'false',
    no_verbatim: process.env.ELEVENLABS_STT_NO_VERBATIM || 'false'
  });
  return `${ELEVENLABS_REALTIME_URL}?${params.toString()}`;
}

function log(label, payload) {
  if (payload === undefined) {
    console.log(`[elevenlabs-realtime-stt] ${label}`);
    return;
  }
  console.log(`[elevenlabs-realtime-stt] ${label} ${JSON.stringify(payload, null, 2)}`);
}

export class ElevenLabsRealtimeTranscription {
  constructor({ onReady, onPartial, onFinal, onSpeechStart, onSpeechEnd, onError } = {}) {
    if (!apiKey()) throw new Error('Missing env: ELEVENLABS_API_KEY or ELEVENLAB_API_KEY');
    this.onReady = onReady;
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onError = onError;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingAudio = [];
    this.speechActive = false;
    this.speechStartedAt = 0;
    this.lastText = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = realtimeUrl();
      this.ws = new WebSocket(url, { headers: { 'xi-api-key': apiKey() } });
      const fail = (err) => {
        this.connected = false;
        reject(err);
      };

      this.ws.once('open', () => {
        log('socket opened', { url });
        this.connected = true;
        this.flushPendingAudio();
        this.onReady?.();
        resolve();
      });
      this.ws.once('error', fail);
      this.ws.on('message', (raw) => this.handleMessage(raw));
      this.ws.on('error', (err) => {
        log('socket error', { message: err.message });
        this.onError?.(err);
      });
      this.ws.on('close', (code, reason) => {
        log('socket closed', { code, reason: reason?.toString() || '' });
        this.connected = false;
        if (!this.closed) this.onError?.(new Error('ElevenLabs realtime transcription socket closed'));
      });
    });
  }

  appendAudio(buffer) {
    if (!buffer?.byteLength) return;
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(Buffer.from(buffer));
      return;
    }

    const audio = resamplePcm16(Buffer.from(buffer));
    this.send({
      message_type: 'input_audio_chunk',
      audio_base_64: pcm16ToBase64(audio),
      sample_rate: ELEVEN_SAMPLE_RATE
    });
  }

  commitAudio() {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
      sample_rate: ELEVEN_SAMPLE_RATE,
      previous_text: this.lastText
    });
  }

  flushPendingAudio() {
    const queued = this.pendingAudio.splice(0);
    for (const buffer of queued) this.appendAudio(buffer);
  }

  send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  markSpeechStarted() {
    if (this.speechActive) return;
    this.speechActive = true;
    this.speechStartedAt = now();
    this.onSpeechStart?.({ at: this.speechStartedAt, source: 'elevenlabs_vad' });
  }

  handleMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.message_type === 'session_started') {
      log('session started', event.config);
      return;
    }

    if (event.message_type === 'partial_transcript') {
      const text = (event.text || '').trim();
      if (!text) return;
      this.markSpeechStarted();
      this.onPartial?.({ text, delta: text });
      return;
    }

    if (event.message_type === 'committed_transcript' || event.message_type === 'committed_transcript_with_timestamps') {
      const text = (event.text || '').trim();
      const finalAt = now();
      const speechStartedAt = this.speechStartedAt || finalAt;
      this.lastText = text || this.lastText;
      this.speechActive = false;
      this.onSpeechEnd?.({ at: finalAt, source: 'elevenlabs_vad' });
      if (text) {
        log('final transcript event', { text, languageCode: event.language_code });
        this.onFinal?.({
          text,
          finalAt,
          speechStartedAt,
          speechEndedAt: finalAt,
          provider: 'elevenlabs',
          words: event.words
        });
      }
      return;
    }

    if (event.message_type?.endsWith('_error') || event.error) {
      log('server error event', event);
      this.onError?.(new Error(event.error || event.message || event.message_type || 'ElevenLabs transcription error'));
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
