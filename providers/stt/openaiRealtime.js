import WebSocket from 'ws';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const INPUT_SAMPLE_RATE = 24000;
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const DEFAULT_GEORGIAN_PROMPT = [
  'Transcribe spoken Georgian accurately.',
  'Use Georgian script, do not translate to English, and preserve Georgian names, places, numbers, and natural punctuation.',
  'The audio is a live Georgian voice assistant conversation, so prefer conversational Georgian wording over English lookalikes.'
].join(' ');

function usesManualCommit(model) {
  return model === 'gpt-realtime-whisper';
}

function now() {
  return performance.now();
}

function pcm16ToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

export function realtimeVadConfigFromEnv() {
  return {
    type: 'server_vad',
    threshold: Number(process.env.OPENAI_VAD_THRESHOLD || 0.42),
    prefix_padding_ms: Number(process.env.OPENAI_VAD_PREFIX_PADDING_MS || 260),
    silence_duration_ms: Number(process.env.OPENAI_VAD_SILENCE_DURATION_MS || 420)
  };
}

export function realtimeTranscriptionSessionConfig(overrides = {}) {
  const noiseReduction = process.env.OPENAI_STT_NOISE_REDUCTION || 'near_field';
  const envLanguage = process.env.OPENAI_TRANSCRIBE_LANGUAGE || 'ka';
  const language = overrides.language === undefined ? envLanguage : overrides.language;
  const model = overrides.model || process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const transcription = {
    model
  };
  if (usesManualCommit(model)) {
    transcription.delay = process.env.OPENAI_REALTIME_TRANSCRIBE_DELAY || 'high';
  } else {
    transcription.prompt = process.env.OPENAI_TRANSCRIBE_PROMPT || DEFAULT_GEORGIAN_PROMPT;
  }
  if (language !== null && language !== 'omit') transcription.language = language;
  const input = {
    format: { type: 'audio/pcm', rate: INPUT_SAMPLE_RATE },
    noise_reduction: noiseReduction === 'null' ? null : { type: noiseReduction },
    transcription
  };
  if (usesManualCommit(model)) {
    input.turn_detection = null;
  } else {
    input.turn_detection = realtimeVadConfigFromEnv();
  }
  return {
    type: 'transcription',
    audio: {
      input
    },
    include: process.env.OPENAI_TRANSCRIBE_INCLUDE_LOGPROBS === 'true'
      ? ['item.input_audio_transcription.logprobs']
      : undefined
  };
}

function log(label, payload) {
  if (payload === undefined) {
    console.log(`[openai-realtime-stt] ${label}`);
    return;
  }
  console.log(`[openai-realtime-stt] ${label} ${JSON.stringify(payload, null, 2)}`);
}

export class OpenAIRealtimeTranscription {
  constructor({ onReady, onPartial, onFinal, onSpeechStart, onSpeechEnd, onError, model, language } = {}) {
    if (!process.env.OPENAI_API_KEY) throw new Error('Missing env: OPENAI_API_KEY');
    this.onReady = onReady;
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onError = onError;
    this.model = model || process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
    this.language = language;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingAudio = [];
    this.items = new Map();
    this.speechStartedAt = 0;
    this.speechEndedAt = 0;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      });

      const fail = (err) => {
        this.onError?.(err);
        reject(err);
      };

      this.ws.once('open', () => {
        log('socket opened', { url: REALTIME_URL, model: this.model });
        this.connected = true;
        this.configureSession();
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
        if (!this.closed) this.onError?.(new Error('OpenAI realtime transcription socket closed'));
      });
    });
  }

  configureSession() {
    const session = realtimeTranscriptionSessionConfig({ model: this.model, language: this.language });
    const event = {
      type: 'session.update',
      session
    };
    log('sending session.update', event);
    this.send(event);
  }

  appendAudio(buffer) {
    if (!buffer?.byteLength) return;
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(Buffer.from(buffer));
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(buffer) });
  }

  commitAudio() {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'input_audio_buffer.commit' });
  }

  flushPendingAudio() {
    const queued = this.pendingAudio.splice(0);
    for (const buffer of queued) this.appendAudio(buffer);
  }

  send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  handleMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      this.speechStartedAt = now();
      this.speechEndedAt = 0;
      this.onSpeechStart?.({ itemId: event.item_id, at: this.speechStartedAt });
      return;
    }

    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.speechEndedAt = now();
      this.onSpeechEnd?.({ itemId: event.item_id, at: this.speechEndedAt });
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const existing = this.items.get(event.item_id) || '';
      const text = existing + (event.delta || '');
      this.items.set(event.item_id, text);
      log('partial transcript event', { itemId: event.item_id, delta: event.delta || '', text });
      this.onPartial?.({ itemId: event.item_id, text, delta: event.delta || '' });
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const text = (event.transcript || this.items.get(event.item_id) || '').trim();
      this.items.delete(event.item_id);
      log('final transcript event', { itemId: event.item_id, text });
      this.onFinal?.({
        itemId: event.item_id,
        text,
        usage: event.usage,
        logprobs: event.logprobs,
        speechStartedAt: this.speechStartedAt,
        speechEndedAt: this.speechEndedAt || now(),
        finalAt: now()
      });
      return;
    }

    if (event.type === 'session.created' || event.type === 'transcription_session.created') {
      log('session created', event.session);
      return;
    }

    if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
      log('session updated', event.session);
      return;
    }

    if (event.type === 'error') {
      log('server error event', event.error || event);
      this.onError?.(new Error(event.error?.message || 'OpenAI realtime transcription error'));
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
