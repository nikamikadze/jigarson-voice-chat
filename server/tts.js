// ── TTS engine management with fallback chain ──
// Primary engine first, then automatic fallbacks so audio is NEVER silent.
// Default chain (Georgian): Cartesia → Edge (ka-GE) → Gemini.

import os from 'os';
import { execFile } from 'child_process';
import { mkdtemp, unlink, rmdir, readFile, appendFile } from 'fs/promises';
import path from 'path';
import { geminiTTS, geminiAvailable } from './gemini.js';
import { cartesiaTTS, cartesiaAvailable } from './cartesia.js';
import { openaiTTS } from './openai.js';

// Append TTS attempts/results to tts-debug.log so failures are visible.
function logTTS(obj) {
  appendFile(path.join(process.cwd(), 'tts-debug.log'),
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n').catch(() => {});
}

const TTS_ENGINES = {
  cartesia: { name: 'Cartesia Sonic', available: cartesiaAvailable() },
  gemini: { name: 'Gemini TTS', available: geminiAvailable() },
  openai: { name: 'OpenAI TTS', available: !!process.env.OPENAI_API_KEY },
  macos: { name: 'macOS Say', available: process.platform === 'darwin' },
  edge: { name: 'Edge TTS', available: true },
};

let currentEngine = 'cartesia';
let macosVoice = 'Samantha';
let edgeVoice = 'en-US-AriaNeural';
let edgeFallbackVoice = 'ka-GE-GiorgiNeural';   // free, Georgian, always-available safety net
let geminiVoice = 'Aoede';
let geminiModel = 'gemini-3.1-flash-tts-preview';
let openaiVoice = process.env.OPENAI_TTS_VOICE || 'alloy';

// Full Gemini TTS prebuilt voice roster (30). `tone` is Google's descriptor;
// `gender` is an approximate hint for the UI only.
export const GEMINI_VOICES = [
  { name: 'Zephyr', tone: 'Bright', gender: 'female' },
  { name: 'Puck', tone: 'Upbeat', gender: 'male' },
  { name: 'Charon', tone: 'Informative', gender: 'male' },
  { name: 'Kore', tone: 'Firm', gender: 'female' },
  { name: 'Fenrir', tone: 'Excitable', gender: 'male' },
  { name: 'Leda', tone: 'Youthful', gender: 'female' },
  { name: 'Orus', tone: 'Firm', gender: 'male' },
  { name: 'Aoede', tone: 'Breezy', gender: 'female' },
  { name: 'Callirrhoe', tone: 'Easy-going', gender: 'female' },
  { name: 'Autonoe', tone: 'Bright', gender: 'female' },
  { name: 'Enceladus', tone: 'Breathy', gender: 'male' },
  { name: 'Iapetus', tone: 'Clear', gender: 'male' },
  { name: 'Umbriel', tone: 'Easy-going', gender: 'male' },
  { name: 'Algieba', tone: 'Smooth', gender: 'male' },
  { name: 'Despina', tone: 'Smooth', gender: 'female' },
  { name: 'Erinome', tone: 'Clear', gender: 'female' },
  { name: 'Algenib', tone: 'Gravelly', gender: 'male' },
  { name: 'Rasalgethi', tone: 'Informative', gender: 'male' },
  { name: 'Laomedeia', tone: 'Upbeat', gender: 'female' },
  { name: 'Achernar', tone: 'Soft', gender: 'female' },
  { name: 'Alnilam', tone: 'Firm', gender: 'male' },
  { name: 'Schedar', tone: 'Even', gender: 'male' },
  { name: 'Gacrux', tone: 'Mature', gender: 'female' },
  { name: 'Pulcherrima', tone: 'Forward', gender: 'female' },
  { name: 'Achird', tone: 'Friendly', gender: 'male' },
  { name: 'Zubenelgenubi', tone: 'Casual', gender: 'male' },
  { name: 'Vindemiatrix', tone: 'Gentle', gender: 'female' },
  { name: 'Sadachbia', tone: 'Lively', gender: 'female' },
  { name: 'Sadaltager', tone: 'Knowledgeable', gender: 'male' },
  { name: 'Sulafat', tone: 'Warm', gender: 'female' },
];
let cartesiaVoice = 'a167e0f3-df7e-4d52-a9c3-f949145efdab';
let cartesiaLanguage = 'ka';
let cartesiaModel = 'sonic-3.5';

export function initTTS(config) {
  currentEngine = config.engine
    || (cartesiaAvailable() ? 'cartesia' : (geminiAvailable() ? 'gemini' : (process.platform === 'darwin' ? 'macos' : 'edge')));
  macosVoice = config.voice || 'Samantha';
  edgeVoice = config.edgeVoice || 'en-US-AriaNeural';
  edgeFallbackVoice = config.edgeFallbackVoice || edgeFallbackVoice;
  geminiVoice = config.geminiVoice || 'Aoede';
  geminiModel = config.geminiModel || 'gemini-3.1-flash-tts-preview';
  cartesiaVoice = config.cartesiaVoice || cartesiaVoice;
  cartesiaLanguage = config.cartesiaLanguage || cartesiaLanguage;
  cartesiaModel = config.cartesiaModel || cartesiaModel;
  openaiVoice = config.openaiVoice || openaiVoice;
  if (currentEngine === 'cartesia' && !cartesiaAvailable()) {
    console.warn('[TTS] engine=cartesia but CARTESIA_API_KEY missing; using fallback chain.');
    currentEngine = 'edge';
  }
}

export function stripMarkdown(str) {
  return str
    .replace(/```[\s\S]*?```/g, '')          // code blocks
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/!\[.*?\]\(.*?\)/g, '')         // images
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')   // links → text only
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')         // italic
    .replace(/~~(.*?)~~/g, '$1')             // strikethrough
    .replace(/^[\s]*[-*+]\s+/gm, '')         // unordered list markers
    .replace(/^[\s]*\d+\.\s+/gm, '')         // ordered list markers
    .replace(/^>\s+/gm, '')                  // blockquotes
    .replace(/^---+$/gm, '')                 // horizontal rules
    .replace(/\|/g, '')                      // table pipes
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')  // emoji
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function stripEmoji(str) {
  return str.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').replace(/\s{2,}/g, ' ').trim();
}

export function getEngines() {
  return {
    current: currentEngine,
    engines: Object.entries(TTS_ENGINES).map(([id, e]) => ({ id, ...e, selected: id === currentEngine })),
  };
}

export function setEngine(engine) {
  if (!TTS_ENGINES[engine]) throw new Error('unknown engine');
  if (!TTS_ENGINES[engine].available) throw new Error('engine not available');
  currentEngine = engine;
  return currentEngine;
}

export function getCurrentVoice() {
  if (currentEngine === 'cartesia') return cartesiaVoice;
  if (currentEngine === 'gemini') return geminiVoice;
  if (currentEngine === 'edge') return edgeVoice;
  return macosVoice;
}

// Roster + current selection for the UI voice picker.
export function getVoices() {
  return {
    engine: currentEngine,
    current: geminiVoice,
    voices: GEMINI_VOICES,
  };
}

// Cartesia voice control (the picker uses these).
export function getCartesiaVoice() { return cartesiaVoice; }
export function setCartesiaVoice(id) { if (id && typeof id === 'string') cartesiaVoice = id; return cartesiaVoice; }

// Set the active Gemini voice at runtime (validated against the roster).
export function setVoice(name) {
  const match = GEMINI_VOICES.find(v => v.name.toLowerCase() === String(name || '').toLowerCase());
  if (!match) throw new Error('unknown voice');
  geminiVoice = match.name;
  return geminiVoice;
}

// ── per-engine synthesis (each returns { buffer, contentType }) ──

async function speakEdge(text, voice) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-edge-'));
  const mp3 = path.join(dir, 'speech.mp3');
  try {
    await execAsync('python3', ['-m', 'edge_tts', '--text', text, '--voice', voice, '--write-media', mp3]);
    const buffer = await readFile(mp3);
    if (!buffer.length) throw new Error('edge produced empty audio');
    return { buffer, contentType: 'audio/mpeg' };
  } finally {
    try { await unlink(mp3); } catch {}
    try { await rmdir(dir); } catch {}
  }
}

async function speakMacos(text, voice) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-say-'));
  const aiff = path.join(dir, 'speech.aiff');
  const mp3 = path.join(dir, 'speech.mp3');
  try {
    await execAsync('say', ['-v', voice, '-o', aiff, text]);
    await execAsync('ffmpeg', ['-i', aiff, '-y', '-q:a', '4', mp3]);
    return { buffer: await readFile(mp3), contentType: 'audio/mpeg' };
  } finally {
    try { await unlink(aiff); } catch {}
    try { await unlink(mp3); } catch {}
    try { await rmdir(dir); } catch {}
  }
}

async function speakOne(engine, text) {
  switch (engine) {
    case 'cartesia': return cartesiaTTS(text, { voiceId: cartesiaVoice, language: cartesiaLanguage, model: cartesiaModel });
    case 'gemini':   return geminiTTS(text, { voiceName: geminiVoice, model: geminiModel });
    case 'openai':   return openaiTTS(text, { voice: openaiVoice });
    case 'edge':     return speakEdge(text, edgeFallbackVoice);
    case 'macos':    return speakMacos(text, macosVoice);
    default: throw new Error('unknown engine ' + engine);
  }
}

// Cartesia only — no Edge/macOS fallback. If Cartesia fails, no audio is produced
// (so a wrong voice is never played). Set FORCE_CARTESIA_ONLY=0 to restore fallbacks.
function buildChain() {
  // Fallback ON by default now (set FORCE_CARTESIA_ONLY=1 to force Cartesia-only).
  // Order: Cartesia (primary) → Gemini TTS (your Google key) → Edge → macOS, so
  // when Cartesia runs out of credits you still hear a real voice, not silence.
  const cartesiaOnly = process.env.FORCE_CARTESIA_ONLY === '1';
  if (cartesiaOnly) return ['cartesia'];
  const base = [currentEngine, 'cartesia', 'gemini', 'edge', 'macos'];
  const order = [];
  for (const e of base) {
    if (!order.includes(e) && TTS_ENGINES[e] && TTS_ENGINES[e].available) order.push(e);
  }
  return order;
}

// Synthesize with automatic fallback. Returns { buffer, contentType }.
// `preferEngine` (optional) is tried first — used by the voice pipeline to speak
// the first sentence on the lowest-latency engine (Cartesia) for a fast start.
export async function speakWithFallback(text, preferEngine) {
  const clean = stripMarkdown(text);
  if (!clean) return { buffer: Buffer.alloc(0), contentType: 'audio/mpeg' };

  let order = buildChain();
  if (preferEngine && TTS_ENGINES[preferEngine]?.available) {
    order = [preferEngine, ...order.filter(e => e !== preferEngine)];
  }
  logTTS({ ev: 'start', chain: order, chars: clean.length });
  const errors = [];
  for (const engine of order) {
    try {
      const r = await speakOne(engine, clean);
      if (r && r.buffer && r.buffer.length) {
        if (engine !== order[0]) console.warn(`[TTS] primary failed — used fallback: ${engine}`);
        logTTS({ ev: 'ok', engine, bytes: r.buffer.length, contentType: r.contentType });
        return { ...r, engine };
      }
      errors.push(`${engine}: empty`);
      logTTS({ ev: 'empty', engine });
    } catch (err) {
      errors.push(`${engine}: ${err.message}`);
      logTTS({ ev: 'fail', engine, error: (err.message || String(err)).slice(0, 300) });
      console.warn(`[TTS] ${engine} failed, trying next →`, err.message);
    }
  }
  logTTS({ ev: 'all-failed', errors });
  throw new Error('all TTS engines failed: ' + errors.join(' | '));
}

// /api/tts — stream the synthesized audio to the response.
export async function synthesizeToResponse(text, voice, res) {
  try {
    const { buffer, contentType, engine } = await speakWithFallback(text);
    if (!buffer.length) { res.status(400).json({ error: 'no speakable text' }); return; }
    res.setHeader('Content-Type', contentType);
    if (engine) res.setHeader('X-TTS-Engine', engine);
    res.end(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Voice chat — single buffer with fallback. Returns { buffer, contentType }.
// `preferEngine` lets the caller force a low-latency engine for the first chunk.
export async function ttsSentence(text, preferEngine) {
  return await speakWithFallback(text, preferEngine);
}

// Sentence splitter (kept for callers).
export function splitSentences(text) {
  return text.split(/(?<=[。！？.!?\n])\s*/).filter(s => s.trim().length > 0);
}

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => err ? reject(err) : resolve());
  });
}
