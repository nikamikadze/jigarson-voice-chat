// ── STT engine management (swappable providers) ──
// Georgian-capable providers: Gemini and OpenAI. (Cartesia Ink-Whisper is
// English-only; DeepSeek has no STT — so they're intentionally not here.)
// Selectable at runtime; falls back to the other available engine on failure.

import { geminiTranscribe } from './gemini.js';
import { whisperTranscribe } from './whisper.js';

let sttEngine = 'whisper';
let openaiModel = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';
let geminiSttModel = process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash';

const STT_ENGINES = {
  whisper: { name: 'Whisper (local · no key)', available: () => true },
  gemini: { name: 'Gemini (cloud)', available: () => !!process.env.GEMINI_API_KEY },
  openai: { name: 'OpenAI (gpt-4o-transcribe)', available: () => !!process.env.OPENAI_API_KEY },
};

// Friendly language name → ISO-639-1 code (OpenAI wants a code; Gemini takes either).
const LANG_CODE = {
  georgian: 'ka', english: 'en', russian: 'ru', german: 'de', french: 'fr',
  spanish: 'es', italian: 'it', turkish: 'tr', arabic: 'ar', ukrainian: 'uk',
  chinese: 'zh', japanese: 'ja', korean: 'ko', hindi: 'hi',
};
function toCode(lang) {
  if (!lang) return '';
  const l = String(lang).toLowerCase().trim();
  return LANG_CODE[l] || (l.length <= 3 ? l : '');
}

export function initSTT(cfg = {}) {
  if (cfg.engine) sttEngine = cfg.engine;
  if (cfg.openaiModel) openaiModel = cfg.openaiModel;
  if (cfg.geminiModel) geminiSttModel = cfg.geminiModel;
  // If the configured engine has no key, fall back to one that does.
  if (!STT_ENGINES[sttEngine]?.available()) {
    const alt = Object.keys(STT_ENGINES).find(e => STT_ENGINES[e].available());
    if (alt) sttEngine = alt;
  }
}

export function getSttEngines() {
  return {
    current: sttEngine,
    engines: Object.entries(STT_ENGINES).map(([id, e]) => ({
      id, name: e.name, available: e.available(), selected: id === sttEngine,
    })),
  };
}

export function setSttEngine(id) {
  if (!STT_ENGINES[id]) throw new Error('unknown STT engine');
  if (!STT_ENGINES[id].available()) throw new Error(`${id} has no API key configured`);
  sttEngine = id;
  return sttEngine;
}

async function openaiTranscribe(buffer, { language, mimeType }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/wav' }), 'audio.wav');
  form.append('model', openaiModel);
  const code = toCode(language);
  if (code) form.append('language', code);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  return (j.text || '').trim();
}

// Transcribe with the selected engine, falling back to the next available one.
// `path` is the audio file on disk (Whisper needs it); `buffer` is its bytes
// (cloud engines need it). Returns { text, engine }.
// Race a promise against a timeout so one stuck engine (e.g. a cloud STT hanging
// on auth/quota retries) can never freeze the whole voice turn — it throws and
// we fall through to the next engine instead.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function transcribe({ buffer, path, language, mimeType } = {}) {
  const order = [sttEngine, ...Object.keys(STT_ENGINES).filter(e => e !== sttEngine)]
    .filter(e => STT_ENGINES[e].available());
  if (!order.length) throw new Error('no STT engine available');
  let lastErr;
  for (const eng of order) {
    try {
      let text = '';
      if (eng === 'whisper') text = await withTimeout(whisperTranscribe(path, { language }), 20000, 'whisper');
      else if (eng === 'gemini') text = await withTimeout(geminiTranscribe(buffer, { mimeType, model: geminiSttModel, language }), 12000, 'gemini');
      else if (eng === 'openai') text = await withTimeout(openaiTranscribe(buffer, { language, mimeType }), 12000, 'openai');
      return { text: (text || '').trim(), engine: eng };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('all STT engines failed');
}
