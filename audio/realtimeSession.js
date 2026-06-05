import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { clearSession, correctTranscript, rememberTurn, streamChat } from '../providers/llm/index.js';
import { OpenAIRealtimeTranscription, realtimeVadConfigFromEnv } from '../providers/stt/openaiRealtime.js';
import { ElevenLabsRealtimeTranscription } from '../providers/stt/elevenlabsRealtime.js';
import { CartesiaTTS } from '../providers/tts/cartesia.js';
import { GeminiLiveSession } from '../providers/gemini/live.js';
import { createChunker } from './textChunker.js';

function send(ws, event) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

function ms(value) {
  return Math.max(0, Math.round(value || 0));
}

function validateTranscript(event) {
  if (!event || typeof event !== 'object') return { ok: false, reason: 'final transcript event is not an object' };
  if (typeof event.text !== 'string') {
    return {
      ok: false,
      reason: `event.text is ${Array.isArray(event.text) ? 'array' : typeof event.text}, expected string`
    };
  }
  const text = event.text.trim();
  if (!text) return { ok: false, reason: 'transcript is empty after trim' };
  return { ok: true, text };
}

function withTimeout(promise, msValue, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${msValue}ms`)), msValue))
  ]);
}

function averageConfidence(logprobs) {
  if (!Array.isArray(logprobs) || !logprobs.length) return null;
  const usable = logprobs.filter((entry) => Number.isFinite(entry?.logprob));
  if (!usable.length) return null;
  const avgLogprob = usable.reduce((sum, entry) => sum + entry.logprob, 0) / usable.length;
  return Number(Math.exp(avgLogprob).toFixed(4));
}

class TurnMetrics {
  constructor(turnId) {
    this.turnId = turnId;
    this.times = {};
  }

  mark(name, at = performance.now()) {
    this.times[name] = at;
  }

  stage(name, from, to) {
    return ms((this.times[to] || 0) - (this.times[from] || 0));
  }

  summary() {
    return {
      speech_start: this.times.speech_start || 0,
      speech_end: this.times.speech_end || 0,
      transcript_final: this.times.transcript_final || 0,
      first_gpt_token: this.times.first_gpt_token || 0,
      first_tts_chunk: this.times.first_tts_chunk || 0,
      first_audio_chunk: this.times.first_audio_chunk || 0,
      playback_start: this.times.playback_start || 0,
      stt_ms: this.stage('speech_end', 'transcript_final'),
      gpt_first_token_ms: this.stage('transcript_final', 'first_gpt_token'),
      tts_first_audio_ms: this.stage('first_gpt_token', 'first_tts_chunk'),
      playback_start_ms: this.stage('first_audio_chunk', 'playback_start'),
      total_ms: this.stage('speech_end', 'playback_start') || this.stage('transcript_final', 'first_tts_chunk')
    };
  }
}

class VoiceSession {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.options = options;
    this.mode = options.mode || 'assistant';
    this.sessionId = 'default';
    this.turnId = 0;
    this.abort = null;
    this.pendingAnswer = '';
    this.activeContextId = null;
    this.currentMetrics = null;
    this.lastSpeechStartAt = 0;
    this.lastSpeechEndAt = 0;
    this.stt = null;
    this.tts = null;
    this.sttProvider = this.options.sttProvider || process.env.STT_PROVIDER || 'openai';
    this.clientVadEnabled = this.sttProvider === 'openai' &&
      (this.options.sttModel || process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe') === 'gpt-realtime-whisper';
  }

  async open() {
    if (this.mode !== 'benchmark') {
      this.tts = new CartesiaTTS({
        onFirstAudio: (contextId) => this.onFirstTtsChunk(contextId),
        onAudio: (payload) => this.onTtsAudio(payload),
        onDone: (contextId) => this.onTtsDone(contextId),
        onError: (err) => send(this.ws, { type: 'error', source: 'tts', message: err.message }),
        onReconnect: () => send(this.ws, { type: 'connection-state', target: 'tts', state: 'reconnecting' })
      });
    }

    const SttProvider = this.sttProvider === 'elevenlabs'
      ? ElevenLabsRealtimeTranscription
      : OpenAIRealtimeTranscription;

    this.stt = new SttProvider({
      onReady: () => send(this.ws, { type: 'connection-state', target: 'stt', state: 'connected' }),
      onPartial: (event) => send(this.ws, { type: 'stt-partial', text: event.text, delta: event.delta }),
      onFinal: (event) => this.onFinalTranscript(event),
      onSpeechStart: (event) => this.onSpeechStart(event),
      onSpeechEnd: (event) => this.onSpeechEnd(event),
      onError: (err) => send(this.ws, { type: 'error', source: 'stt', message: err.message }),
      model: this.options.sttModel,
      language: this.options.sttLanguage
    });

    send(this.ws, {
      type: 'config',
      audio: {
        inputSampleRate: 24000,
        chunkMs: Number(process.env.AUDIO_CHUNK_MS || 40),
        clientVad: this.clientVadEnabled,
        clientVadStartLevel: Number(process.env.CLIENT_VAD_START_LEVEL || 0.018),
        clientVadEndLevel: Number(process.env.CLIENT_VAD_END_LEVEL || 0.01),
        clientVadStartMs: Number(process.env.CLIENT_VAD_START_MS || 120),
        clientVadSilenceMs: Number(process.env.CLIENT_VAD_SILENCE_MS || 700)
      },
      vad: realtimeVadConfigFromEnv(),
      sttProvider: this.sttProvider
    });
    send(this.ws, { type: 'connection-state', target: 'client', state: 'connected' });

    await this.stt.connect();
    if (this.tts) {
      await this.tts.connect();
      send(this.ws, { type: 'connection-state', target: 'tts', state: 'connected' });
    }
    send(this.ws, { type: 'ready' });
  }

  handle(event, raw) {
    if (raw) {
      this.stt?.appendAudio(raw);
      return;
    }
    if (event.type === 'hello') this.sessionId = event.sessionId || this.sessionId;
    if (event.type === 'text') this.onFinalTranscript({ text: event.text, finalAt: performance.now() });
    if (event.type === 'audio-diagnostics') console.log('[AUDIO DIAGNOSTICS]', event.stats);
    if (event.type === 'client-speech-start') this.onSpeechStart({ at: event.at || performance.now(), source: 'client_vad' });
    if (event.type === 'client-speech-end') {
      this.onSpeechEnd({ at: event.at || performance.now(), source: 'client_vad' });
      this.stt?.commitAudio();
    }
    if (event.type === 'cancel') this.bargeIn('client_cancelled');
    if (event.type === 'playback-start') this.onPlaybackStart(event);
    if (event.type === 'clear-session') clearSession(this.sessionId);
  }

  onSpeechStart(event) {
    this.lastSpeechStartAt = event.at;
    this.bargeIn('user_started_speaking');
    send(this.ws, { type: 'speech-start', at: event.at });
    send(this.ws, { type: 'listening', active: true });
  }

  onSpeechEnd(event) {
    this.lastSpeechEndAt = event.at;
    send(this.ws, { type: 'speech-end', at: event.at });
  }

  bargeIn(reason) {
    const hadActiveOutput = Boolean(this.abort || this.activeContextId);
    this.abort?.abort();
    this.tts?.cancel();
    this.abort = null;
    this.activeContextId = null;
    this.pendingAnswer = '';
    if (hadActiveOutput) {
      send(this.ws, { type: 'cancelled', reason });
      console.log(`[barge-in] ${reason}`);
    }
  }

  async onFinalTranscript(event) {
    console.log('[STT FINAL RECEIVED]', {
      textType: typeof event?.text,
      isArray: Array.isArray(event?.text),
      event
    });
    const validation = validateTranscript(event);
    console.log('[STT VALIDATION]', validation);
    if (!validation.ok) {
      console.warn('[STT VALIDATION] transcript discarded', { reason: validation.reason, event });
      return;
    }
    const rawUserText = validation.text;
    let userText = rawUserText;
    try {
      userText = await withTimeout(
        correctTranscript(rawUserText),
        Number(process.env.OPENAI_TRANSCRIPT_CORRECTION_TIMEOUT_MS || 1500),
        'Transcript correction'
      );
    } catch (err) {
      console.warn('[TRANSCRIPT CORRECTION ERROR]', err.message);
    }
    const sttLatencyMs = ms((event.finalAt || performance.now()) - (event.speechEndedAt || this.lastSpeechEndAt || event.finalAt || performance.now()));
    const confidence = averageConfidence(event.logprobs);
    console.log('[TRANSCRIPT RAW]', rawUserText);
    console.log('[TRANSCRIPT]', userText);
    console.log('[TRANSCRIPT LENGTH]', userText.length);
    console.log('[STT LATENCY]', `${sttLatencyMs}ms`);

    this.bargeIn('new_turn');
    this.turnId += 1;
    const turnId = this.turnId;
    const metrics = new TurnMetrics(turnId);
    this.currentMetrics = metrics;
    metrics.mark('speech_start', event.speechStartedAt || this.lastSpeechStartAt || event.finalAt);
    metrics.mark('speech_end', event.speechEndedAt || this.lastSpeechEndAt || event.finalAt);
    metrics.mark('transcript_final', event.finalAt || performance.now());

    this.abort = new AbortController();
    this.pendingAnswer = '';
    this.activeContextId = randomUUID();
    this.lastUserText = userText;

    send(this.ws, {
      type: 'stt-final',
      text: userText,
      rawText: rawUserText === userText ? null : rawUserText,
      turnId,
      sttLatencyMs,
      confidence,
      usage: event.usage || null
    });
    send(this.ws, { type: 'ai-start', turnId });
    this.emitMetric('stt', metrics.stage('speech_end', 'transcript_final'), turnId);

    if (this.mode === 'benchmark') {
      send(this.ws, { type: 'ai-done', text: '', turnId });
      return;
    }

    try {
      let ttsReady = false;
      try {
        await withTimeout(
          this.tts.start(this.activeContextId),
          Number(process.env.TTS_START_TIMEOUT_MS || 1200),
          'Cartesia TTS start'
        );
        ttsReady = true;
      } catch (err) {
        console.error('[TTS START ERROR]', err.message);
        send(this.ws, { type: 'error', source: 'tts', message: err.message });
      }
      const chunker = createChunker({
        flushChars: Number(process.env.TTS_FLUSH_CHARS || 28),
        onChunk: (chunk, isFinal = false) => {
          if (ttsReady) this.tts.sendText(chunk, { isFinal });
        }
      });

      for await (const token of streamChat({
        sessionId: this.sessionId,
        userText,
        signal: this.abort.signal,
        onFirstToken: (latencyMs) => {
          metrics.mark('first_gpt_token');
          this.emitMetric('gpt_first_token', latencyMs, turnId);
        }
      })) {
        if (this.abort.signal.aborted) return;
        this.pendingAnswer += token;
        send(this.ws, { type: 'ai-token', token, turnId });
        chunker.push(token);
      }
      chunker.flush(true);
    } catch (err) {
      if (err.name === 'AbortError') return;
      send(this.ws, { type: 'error', source: 'llm', message: err.message });
      this.tts?.cancel();
      this.abort = null;
      this.activeContextId = null;
    }
  }

  onFirstTtsChunk(contextId) {
    if (contextId !== this.activeContextId) return;
    this.currentMetrics?.mark('first_tts_chunk');
    this.currentMetrics?.mark('first_audio_chunk');
    this.emitMetric('tts_first_audio', this.currentMetrics?.stage('first_gpt_token', 'first_tts_chunk'), this.turnId);
    send(this.ws, { type: 'speaking', turnId: this.turnId });
  }

  onTtsAudio(payload) {
    if (payload.contextId !== this.activeContextId) return;
    send(this.ws, { type: 'audio', ...payload, turnId: this.turnId });
  }

  onPlaybackStart(event) {
    if (!this.currentMetrics || event.turnId !== this.turnId || this.currentMetrics.times.playback_start) return;
    this.currentMetrics.mark('playback_start');
    this.emitMetric('playback_start', this.currentMetrics.stage('first_audio_chunk', 'playback_start'), this.turnId);
    this.emitMetric('total', this.currentMetrics.summary().total_ms, this.turnId);
  }

  onTtsDone(contextId) {
    if (contextId !== this.activeContextId) return;
    const summary = this.currentMetrics?.summary() || {};
    console.log(
      `[metrics:${this.turnId}] STT: ${summary.stt_ms}ms | GPT first token: ${summary.gpt_first_token_ms}ms | ` +
      `TTS first audio: ${summary.tts_first_audio_ms}ms | Playback start: ${summary.playback_start_ms}ms | Total: ${summary.total_ms}ms`
    );
    send(this.ws, { type: 'metrics-summary', turnId: this.turnId, metrics: summary });
    send(this.ws, { type: 'ai-done', text: this.pendingAnswer, turnId: this.turnId });
    rememberTurn(this.sessionId, this.lastUserText, this.pendingAnswer);
    this.abort = null;
    this.activeContextId = null;
  }

  emitMetric(name, value, turnId = this.turnId) {
    const rounded = ms(value);
    console.log(`[metrics:${turnId}] ${name}=${rounded}ms`);
    send(this.ws, { type: 'metric', name, ms: rounded, turnId });
  }

  close() {
    this.bargeIn('socket_closed');
    this.stt?.close();
    this.tts?.close();
  }
}

class GeminiVoiceSession {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.options = options;
    this.mode = options.mode || 'assistant';
    this.sessionId = 'default';
    this.turnId = 0;
    this.currentMetrics = null;
    this.pendingUserText = '';
    this.pendingAnswer = '';
    this.lastInputTranscript = '';
    this.lastOutputTranscript = '';
    this.active = false;
    this.firstOutputSeen = false;
  }

  async open() {
    this.gemini = new GeminiLiveSession({
      onReady: () => {
        send(this.ws, { type: 'connection-state', target: 'gemini', state: 'connected' });
        send(this.ws, { type: 'ready', audio: this.audioConfig() });
      },
      onSpeechStart: (event) => this.onSpeechStart(event),
      onSpeechEnd: (event) => this.onSpeechEnd(event),
      onInputTranscript: (event) => this.onInputTranscript(event),
      onOutputTranscript: (event) => this.onOutputTranscript(event),
      onText: (text) => this.onModelText(text),
      onAudio: (payload) => this.onModelAudio(payload),
      onInterrupted: () => this.onInterrupted(),
      onTurnComplete: () => this.onTurnComplete(),
      onError: (err) => send(this.ws, { type: 'error', source: 'gemini', message: err.message }),
      onClose: (err) => send(this.ws, { type: 'error', source: 'gemini', message: err.message })
    });

    send(this.ws, { type: 'config', audio: this.audioConfig(), voiceProvider: 'gemini' });
    send(this.ws, { type: 'connection-state', target: 'client', state: 'connected' });
    send(this.ws, { type: 'connection-state', target: 'gemini', state: 'connecting' });
    await this.gemini.connect();
  }

  audioConfig() {
    return {
      inputSampleRate: 16000,
      chunkMs: Number(process.env.AUDIO_CHUNK_MS || 40),
      clientVad: false,
      clientVadStartLevel: Number(process.env.CLIENT_VAD_START_LEVEL || 0.018),
      clientVadEndLevel: Number(process.env.CLIENT_VAD_END_LEVEL || 0.01),
      clientVadStartMs: Number(process.env.CLIENT_VAD_START_MS || 120),
      clientVadSilenceMs: Number(process.env.CLIENT_VAD_SILENCE_MS || 700)
    };
  }

  handle(event, raw) {
    if (raw) {
      this.gemini?.appendAudio(raw);
      return;
    }
    if (event.type === 'hello') this.sessionId = event.sessionId || this.sessionId;
    if (event.type === 'text') this.startTextTurn(event.text);
    if (event.type === 'audio-diagnostics') console.log('[AUDIO DIAGNOSTICS]', event.stats);
    if (event.type === 'cancel') this.bargeIn('client_cancelled');
    if (event.type === 'playback-start') this.onPlaybackStart(event);
    if (event.type === 'clear-session') this.resetTurn();
  }

  startTurn({ userText = '', source = 'audio' } = {}) {
    this.bargeIn(source === 'text' ? 'new_text_turn' : 'new_voice_turn');
    this.turnId += 1;
    this.currentMetrics = new TurnMetrics(this.turnId);
    const now = performance.now();
    this.currentMetrics.mark('speech_start', now);
    this.currentMetrics.mark('speech_end', now);
    this.currentMetrics.mark('transcript_final', now);
    this.pendingUserText = userText;
    this.pendingAnswer = '';
    this.active = true;
    this.firstOutputSeen = false;

    if (userText) {
      send(this.ws, {
        type: 'stt-final',
        text: userText,
        rawText: null,
        turnId: this.turnId,
        sttLatencyMs: 0,
        confidence: null,
        usage: null
      });
      send(this.ws, { type: 'ai-start', turnId: this.turnId });
      this.emitMetric('stt', 0, this.turnId);
    }
  }

  startTextTurn(text) {
    const userText = String(text || '').trim();
    if (!userText) return;
    this.startTurn({ userText, source: 'text' });
    this.gemini?.sendText(userText);
  }

  onSpeechStart(event = {}) {
    this.startTurn({ source: 'audio' });
    send(this.ws, { type: 'speech-start', at: event.at || performance.now() });
    send(this.ws, { type: 'listening', active: true });
  }

  onSpeechEnd(event = {}) {
    if (!this.active) return;
    this.currentMetrics?.mark('speech_end', event.at || performance.now());
    send(this.ws, { type: 'speech-end', at: event.at || performance.now() });
  }

  onInputTranscript(event = {}) {
    const text = String(event.text || '').trim();
    if (!text) return;
    if (!this.active) this.startTurn({ source: 'audio' });
    this.pendingUserText = text;
    this.lastInputTranscript = text;
    send(this.ws, { type: 'stt-partial', text, delta: text });
  }

  ensureOutputTurn() {
    if (!this.active) this.startTurn({ source: 'audio' });
    if (!this.firstOutputSeen) {
      this.firstOutputSeen = true;
      const now = performance.now();
      this.currentMetrics?.mark('transcript_final', now);
      this.currentMetrics?.mark('first_gpt_token', now);
      this.currentMetrics?.mark('first_tts_chunk', now);
      this.currentMetrics?.mark('first_audio_chunk', now);
      if (this.pendingUserText) {
        send(this.ws, {
          type: 'stt-final',
          text: this.pendingUserText,
          rawText: null,
          turnId: this.turnId,
          sttLatencyMs: this.currentMetrics?.stage('speech_end', 'transcript_final') || 0,
          confidence: null,
          usage: null
        });
      }
      send(this.ws, { type: 'ai-start', turnId: this.turnId });
      send(this.ws, { type: 'speaking', turnId: this.turnId });
      this.emitMetric('stt', this.currentMetrics?.stage('speech_end', 'transcript_final'), this.turnId);
      this.emitMetric('gpt_first_token', this.currentMetrics?.stage('transcript_final', 'first_gpt_token'), this.turnId);
      this.emitMetric('tts_first_audio', this.currentMetrics?.stage('first_gpt_token', 'first_tts_chunk'), this.turnId);
    }
  }

  onOutputTranscript(event = {}) {
    const text = event.text || '';
    if (!text) return;
    const delta = text.startsWith(this.lastOutputTranscript)
      ? text.slice(this.lastOutputTranscript.length)
      : text;
    this.lastOutputTranscript = text;
    if (delta) this.onModelText(delta);
  }

  onModelText(text) {
    this.ensureOutputTurn();
    this.pendingAnswer += text;
    send(this.ws, { type: 'ai-token', token: text, turnId: this.turnId });
  }

  onModelAudio(payload) {
    this.ensureOutputTurn();
    send(this.ws, { type: 'audio', ...payload, turnId: this.turnId });
  }

  onPlaybackStart(event) {
    if (!this.currentMetrics || event.turnId !== this.turnId || this.currentMetrics.times.playback_start) return;
    this.currentMetrics.mark('playback_start');
    this.emitMetric('playback_start', this.currentMetrics.stage('first_audio_chunk', 'playback_start'), this.turnId);
    this.emitMetric('total', this.currentMetrics.summary().total_ms, this.turnId);
  }

  onTurnComplete() {
    if (!this.active) return;
    const summary = this.currentMetrics?.summary() || {};
    send(this.ws, { type: 'metrics-summary', turnId: this.turnId, metrics: summary });
    send(this.ws, { type: 'ai-done', text: this.pendingAnswer, turnId: this.turnId });
    this.resetTurn();
  }

  onInterrupted() {
    this.bargeIn('gemini_interrupted');
  }

  bargeIn(reason) {
    const hadActiveOutput = this.active || this.firstOutputSeen;
    this.gemini?.cancel();
    this.resetTurn();
    if (hadActiveOutput) send(this.ws, { type: 'cancelled', reason });
  }

  resetTurn() {
    this.currentMetrics = null;
    this.pendingUserText = '';
    this.pendingAnswer = '';
    this.lastInputTranscript = '';
    this.lastOutputTranscript = '';
    this.active = false;
    this.firstOutputSeen = false;
  }

  emitMetric(name, value, turnId = this.turnId) {
    const rounded = ms(value);
    console.log(`[gemini:${turnId}] ${name}=${rounded}ms`);
    send(this.ws, { type: 'metric', name, ms: rounded, turnId });
  }

  close() {
    this.gemini?.close();
  }
}

export function attachRealtimeVoice(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const languageParam = url.searchParams.get('sttLanguage');
    const voiceProvider = (url.searchParams.get('voiceProvider') || process.env.VOICE_PROVIDER || 'gemini').toLowerCase();
    const SessionClass = voiceProvider === 'legacy' ? VoiceSession : GeminiVoiceSession;
    const session = new SessionClass(ws, {
      mode: url.searchParams.get('mode') || 'assistant',
      sttProvider: url.searchParams.get('sttProvider') || undefined,
      sttModel: url.searchParams.get('sttModel') || undefined,
      sttLanguage: languageParam === 'omit' ? null : languageParam || undefined
    });
    session.open().catch((err) => send(ws, { type: 'error', message: err.message }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        session.handle(null, raw);
        return;
      }
      try {
        session.handle(JSON.parse(raw.toString()));
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON event' });
      }
    });
    ws.on('close', () => session.close());
  });
}
