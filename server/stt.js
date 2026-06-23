import { geminiTranscribe, geminiAvailable } from './gemini.js';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

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
let sttEngine = process.env.STT_ENGINE || 'gemini-live';

export function normalizeLanguage(language) {
  const value = String(language || '').trim();
  if (!value) return 'ka-GE';
  return LANGUAGE_CODES[value.toLowerCase()] || value;
}

export function initSTT(cfg = {}) {
  geminiSttModel = process.env.GEMINI_STT_MODEL || cfg.geminiModel || geminiSttModel;
  sttEngine = process.env.STT_ENGINE || cfg.engine || sttEngine;
  if (!geminiAvailable()) {
    console.warn('[STT] GEMINI_API_KEY not set — Gemini STT will fail until it is configured.');
  }
}

export function googleSttAvailable() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  return existsSync(path.join(os.homedir(), '.config/gcloud/application_default_credentials.json'));
}

export function getSttEngine() {
  return sttEngine;
}

export function getSttEngines() {
  const engines = [{
    id: 'gemini-live',
    name: 'Gemini Live streaming STT',
    available: geminiAvailable(),
    selected: sttEngine === 'gemini-live',
  }, {
    id: 'google-cloud',
    name: 'Google Cloud streaming STT',
    available: googleSttAvailable(),
    selected: sttEngine === 'google-cloud',
  }];

  return {
    current: sttEngine,
    engines,
  };
}

export function setSttEngine(engine) {
  const next = String(engine || '').trim();
  if (!['gemini-live', 'google-cloud'].includes(next)) {
    throw new Error(`Unsupported STT engine: ${engine}`);
  }
  sttEngine = next;
  return sttEngine;
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
