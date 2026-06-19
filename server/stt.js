import { geminiTranscribe, geminiAvailable } from './gemini.js';

const LANGUAGE_CODES = {
  georgian: 'ka-GE',
  ka: 'ka-GE',
  'ka-ge': 'ka-GE',
  english: 'en-US',
  en: 'en-US',
  'en-us': 'en-US',
  russian: 'ru-RU',
  ru: 'ru-RU',
};

let geminiSttModel = process.env.GEMINI_STT_MODEL || 'gemini-3.5-flash';

export function normalizeLanguage(language) {
  const value = String(language || '').trim();
  if (!value) return 'ka-GE';
  return LANGUAGE_CODES[value.toLowerCase()] || value;
}

export function initSTT(cfg = {}) {
  geminiSttModel = process.env.GEMINI_STT_MODEL || cfg.geminiModel || geminiSttModel;
  if (!geminiAvailable()) {
    console.warn('[STT] GEMINI_API_KEY not set — Gemini STT will fail until it is configured.');
  }
}

export function getSttEngines() {
  return {
    current: 'gemini-live',
    engines: [{
      id: 'gemini-live',
      name: 'Gemini Live streaming STT',
      available: geminiAvailable(),
      selected: true,
    }],
  };
}

export function setSttEngine() {
  return 'gemini-live';
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function transcribe({ buffer, language, mimeType } = {}) {
  const text = await withTimeout(
    geminiTranscribe(buffer, {
      mimeType: mimeType || 'audio/wav',
      model: geminiSttModel,
      language: normalizeLanguage(language),
    }),
    12000,
    'gemini-stt',
  );
  return { text: (text || '').trim(), engine: 'gemini-live' };
}
