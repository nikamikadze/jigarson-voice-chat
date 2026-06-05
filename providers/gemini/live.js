import WebSocket from 'ws';
import { buildSystemPrompt } from '../../llm/prompt.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function contentPartsText(content) {
  const parts = content?.parts || [];
  return parts
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('');
}

function firstInlineAudio(content) {
  const parts = content?.parts || [];
  for (const part of parts) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) return inlineData;
  }
  return null;
}

export class GeminiLiveSession {
  constructor({
    onReady,
    onSpeechStart,
    onSpeechEnd,
    onInputTranscript,
    onOutputTranscript,
    onText,
    onAudio,
    onInterrupted,
    onTurnComplete,
    onError,
    onClose
  } = {}) {
    this.onReady = onReady;
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onInputTranscript = onInputTranscript;
    this.onOutputTranscript = onOutputTranscript;
    this.onText = onText;
    this.onAudio = onAudio;
    this.onInterrupted = onInterrupted;
    this.onTurnComplete = onTurnComplete;
    this.onError = onError;
    this.onClose = onClose;
    this.closed = false;
    this.ready = false;
    this.pendingAudio = [];
  }

  async connect() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

    const url = new URL(process.env.GEMINI_LIVE_URL || DEFAULT_URL);
    url.searchParams.set('key', apiKey);

    this.ws = new WebSocket(url);
    this.ws.on('open', () => this.configure());
    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('error', (err) => this.onError?.(err));
    this.ws.on('close', (code, reason) => {
      if (!this.closed) this.onClose?.(new Error(`Gemini Live socket closed (${code}) ${reason?.toString() || ''}`.trim()));
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Gemini Live connect timed out')), Number(process.env.GEMINI_CONNECT_TIMEOUT_MS || 10000));
      this.ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  configure() {
    console.log('[Gemini Live] Starting new session');
    const model = process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
    const voiceName = process.env.GEMINI_VOICE || 'Laomedeia';
    const temperature = Number(process.env.GEMINI_TEMPERATURE || 0.85);
    const systemText = buildSystemPrompt('').then((prompt) => {
      sendJson(this.ws, {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            temperature,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName
                }
              }
            }
          },
          systemInstruction: {
            role: 'user',
            parts: [{ text: prompt }]
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              silenceDurationMs: Number(process.env.GEMINI_VAD_SILENCE_MS || 700),
              prefixPaddingMs: Number(process.env.GEMINI_VAD_PREFIX_PADDING_MS || 120)
            },
            activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
          }
        }
      });
    });

    systemText.catch((err) => this.onError?.(err));
  }

  handleMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      this.onError?.(new Error('Invalid Gemini Live JSON message'));
      return;
    }

    if (event.setupComplete) {
      this.ready = true;
      this.onReady?.();
      for (const audio of this.pendingAudio.splice(0)) this.appendAudio(audio);
      return;
    }

    const content = event.serverContent || event.server_content;
    if (!content) return;

    if (content.interrupted) this.onInterrupted?.();
    if (content.inputTranscription || content.input_transcription) {
      this.onInputTranscript?.(content.inputTranscription || content.input_transcription);
    }
    if (content.outputTranscription || content.output_transcription) {
      this.onOutputTranscript?.(content.outputTranscription || content.output_transcription);
    }

    const text = contentPartsText(content.modelTurn || content.model_turn);
    if (text) this.onText?.(text);

    const inlineAudio = firstInlineAudio(content.modelTurn || content.model_turn);
    if (inlineAudio?.data) {
      this.onAudio?.({
        audioB64: inlineAudio.data,
        sampleRate: this.sampleRateFromMime(inlineAudio.mimeType || inlineAudio.mime_type) || 24000
      });
    }

    if (content.turnComplete || content.turn_complete || content.generationComplete || content.generation_complete) {
      this.onTurnComplete?.();
    }
  }

  sampleRateFromMime(mimeType = '') {
    const match = mimeType.match(/rate=(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  appendAudio(raw) {
    if (!this.ready) {
      this.pendingAudio.push(raw);
      return;
    }
    sendJson(this.ws, {
      realtimeInput: {
        audio: {
          data: bufferToBase64(raw),
          mimeType: 'audio/pcm;rate=16000'
        }
      }
    });
  }

  sendText(text) {
    sendJson(this.ws, {
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      }
    });
  }

  cancel() {
    // With automatic activity detection enabled, new realtime audio interrupts
    // model output. Explicit activity markers are only valid when it is disabled.
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
