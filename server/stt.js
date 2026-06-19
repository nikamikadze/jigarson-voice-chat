import speech from '@google-cloud/speech';
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

let languageCode = process.env.GOOGLE_CLOUD_STT_LANGUAGE || 'ka-GE';
let client = null;

export function googleSttAvailable() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return true;
  if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT) return true;
  return existsSync(path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));
}

function getClient() {
  if (!client) client = new speech.SpeechClient();
  return client;
}

export function normalizeLanguage(language) {
  const value = String(language || languageCode || '').trim();
  if (!value) return 'ka-GE';
  return LANGUAGE_CODES[value.toLowerCase()] || value;
}

export function initSTT(cfg = {}) {
  languageCode = normalizeLanguage(
    process.env.GOOGLE_CLOUD_STT_LANGUAGE || cfg.language || cfg.languageCode || languageCode,
  );
}

export function getSttEngines() {
  return {
    current: 'google',
    engines: [{
      id: 'google',
      name: 'Google Cloud Speech-to-Text',
      available: googleSttAvailable(),
      selected: true,
    }],
  };
}

export function setSttEngine() {
  return 'google';
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function transcribe({ buffer, language, mimeType } = {}) {
  const encoding = mimeType?.includes('webm') ? 'WEBM_OPUS' : 'LINEAR16';
  const request = {
    audio: { content: buffer.toString('base64') },
    config: {
      encoding,
      sampleRateHertz: encoding === 'LINEAR16' ? 16000 : undefined,
      languageCode: normalizeLanguage(language),
      enableAutomaticPunctuation: true,
      useEnhanced: true,
      model: 'latest_short',
    },
  };

  const [response] = await withTimeout(getClient().recognize(request), 12000, 'google-stt');
  const text = (response.results || [])
    .map((result) => result.alternatives?.[0]?.transcript || '')
    .join(' ')
    .trim();
  return { text, engine: 'google' };
}
