import WebSocket from 'ws';

const CARTESIA_VERSION = process.env.CARTESIA_VERSION || '2026-03-01';
const MODEL = process.env.CARTESIA_MODEL || 'sonic-3.5';
const VOICE_ID = process.env.CARTESIA_VOICE_BLAKE || process.env.CARTESIA_VOICE_ID || 'a167e0f3-df7e-4d52-a9c3-f949145efdab';
const SAMPLE_RATE = Number(process.env.TTS_SAMPLE_RATE || 24000);

function mostlyEnglish(text) {
  const latin = (text.match(/[a-z]/gi) || []).length;
  const georgian = (text.match(/[\u10a0-\u10ff]/g) || []).length;
  return latin > georgian;
}

function isStaleContextError(message = '') {
  return /context ID does not exist|already been cancelled/i.test(message);
}

export class CartesiaTTS {
  constructor({ onAudio, onFirstAudio, onDone, onError, onReconnect } = {}) {
    if (!process.env.CARTESIA_API_KEY) throw new Error('Missing env: CARTESIA_API_KEY');
    this.onAudio = onAudio;
    this.onFirstAudio = onFirstAudio;
    this.onDone = onDone;
    this.onError = onError;
    this.onReconnect = onReconnect;
    this.ws = null;
    this.contextId = null;
    this.firstAudioSeen = false;
    this.closed = false;
    this.connecting = null;
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`;
      this.ws = new WebSocket(url, {
        headers: {
          'X-API-Key': process.env.CARTESIA_API_KEY,
          Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`
        }
      });
      this.ws.once('open', () => {
        this.connecting = null;
        resolve();
      });
      this.ws.once('error', (err) => {
        this.connecting = null;
        reject(err);
      });
      this.ws.on('message', (raw) => this.handleMessage(raw));
      this.ws.on('error', (err) => this.onError?.(err));
      this.ws.on('close', () => {
        this.ws = null;
        if (!this.closed) this.scheduleReconnect();
      });
    });
    return this.connecting;
  }

  scheduleReconnect() {
    this.onReconnect?.();
    setTimeout(() => {
      if (!this.closed) this.connect().catch((err) => this.onError?.(err));
    }, Number(process.env.CARTESIA_RECONNECT_MS || 350));
  }

  async start(contextId) {
    await this.connect();
    this.contextId = contextId;
    this.firstAudioSeen = false;
  }

  sendText(transcript, { isFinal = false } = {}) {
    if ((!transcript || !transcript.trim()) && !isFinal) return;
    if (!this.contextId || this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        model_id: MODEL,
        transcript,
        voice: { mode: 'id', id: VOICE_ID },
        language: mostlyEnglish(transcript) ? 'en' : 'ka',
        context_id: this.contextId,
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: SAMPLE_RATE
        },
        max_buffer_delay_ms: Number(process.env.CARTESIA_MAX_BUFFER_DELAY_MS || 120),
        continue: !isFinal
      }));
    } catch (err) {
      if (isStaleContextError(err.message)) return;
      this.onError?.(err);
    }
  }

  cancel() {
    if (this.contextId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
    }
    this.contextId = null;
    this.firstAudioSeen = false;
  }

  close() {
    this.closed = true;
    this.cancel();
    this.ws?.close();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'chunk' && message.data) {
      if (!this.firstAudioSeen) {
        this.firstAudioSeen = true;
        this.onFirstAudio?.(message.context_id);
      }
      this.onAudio?.({ audioB64: message.data, sampleRate: SAMPLE_RATE, contextId: message.context_id });
    }
    if (message.type === 'done') this.onDone?.(message.context_id);
    if (message.type === 'error') {
      const errorMessage = message.message || 'Cartesia TTS error';
      if (isStaleContextError(errorMessage)) {
        console.warn('[Cartesia stale context ignored]', errorMessage);
        return;
      }
      this.onError?.(new Error(errorMessage));
    }
  }
}
