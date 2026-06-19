// ── Gemini voice helpers: STT (audio understanding) + TTS (speech generation) ──
// Uses the Gemini REST API directly. Requires GEMINI_API_KEY in the environment.
// Docs: https://ai.google.dev/gemini-api/docs/audio  /  /speech-generation

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export function geminiAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set');
  return k;
}

// POST to a Gemini model with automatic retries on transient errors (503/429/500).
async function postJSON(model, body, { retries = 7 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${API_ROOT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      lastErr = networkErr;
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw lastErr;
    }
    if (res.ok) return res.json();
    const status = res.status;
    const errText = await res.text().catch(() => '');
    lastErr = new Error(`Gemini ${status}: ${errText.slice(0, 300)}`);
    if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
      await sleep(backoff(attempt));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// Exponential backoff with jitter, capped at 4s (~0.6, 1.2, 2.4, 4, 4, 4, 4s).
function backoff(attempt) {
  return Math.min(600 * 2 ** attempt, 4000) + Math.floor(Math.random() * 400);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wrap raw PCM (signed 16-bit little-endian, mono) in a minimal WAV container
// so browsers can play it directly. Gemini TTS returns 24kHz PCM by default.
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Pull a sample rate out of a mime type like "audio/L16;codec=pcm;rate=24000"
function rateFromMime(mime, fallback = 24000) {
  if (!mime) return fallback;
  const m = /rate=(\d+)/.exec(mime);
  return m ? parseInt(m[1], 10) : fallback;
}

// ── STT: transcribe an audio buffer to text ──
export async function geminiTranscribe(audioBuffer, {
  mimeType = 'audio/wav',
  model = 'gemini-2.5-flash',
  language = '',          // '' = let Gemini auto-detect
} = {}) {
  const langHint = language ? ` Language is ${language}.` : '';
  const prompt = `Transcribe verbatim in original language using native script. Do not translate.${langHint} Output only transcript, no quotation marks or labels. If silent, output nothing.`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
      ],
    }],
    generationConfig: { temperature: 0 },
  };

  const json = await postJSON(model, body);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

// ── Chat (LLM): streaming text generation for the "brain" path ──
// Uses streamGenerateContent with SSE for low time-to-first-token. Calls
// onToken(text) for each delta and returns the full assembled text.
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';
// Thinking budget for chat: -1 = dynamic (model decides — smartest), 0 = off (fastest
// but dumb), or a token cap (e.g. 2048) to balance. Default: dynamic for quality.
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? -1);

export function geminiChatModel() { return CHAT_MODEL; }

export async function geminiChatStream({ system, user, onToken, temperature = 0.7, signal, model = CHAT_MODEL } = {}) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature, thinkingConfig: { thinkingBudget: THINKING_BUDGET } },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(`${API_ROOT}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini chat ${res.status}: ${t.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const parts = j?.candidates?.[0]?.content?.parts || [];
        const delta = parts.map(p => p.text || '').join('');
        if (delta) { full += delta; onToken?.(delta); }
      } catch { /* skip keep-alive / partial */ }
    }
  }

  return full;
}

// ── TTS: synthesize speech, returns { buffer, contentType } (WAV) ──
// Gemini's TTS classifier can (a) reject a bare transcript with HTTP 400
// ("Model tried to generate text, but it should only be used for TTS") or
// (b) occasionally return text tokens instead of audio. We guard against both:
// a clear "read this aloud" preamble with a labelled transcript fixes (a), and
// a retry loop fixes (b). See Google's TTS limitations docs.
export async function geminiTTS(text, {
  voiceName = 'Aoede',
  model = 'gemini-3.1-flash-tts-preview',
  stylePrompt = '',       // optional natural-language delivery direction
} = {}) {
  const directive = (stylePrompt && stylePrompt.trim())
    || 'Read the following transcript aloud exactly as written, in a natural, clear voice at a brisk, lively conversational pace — do not speak slowly or drag the words. Speak only the transcript — do not translate it, describe it, or add any words.';
  const prompt = `${directive}\n\nTranscript:\n${text}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
  };

  // Fail FAST: at most 2 quick attempts. Gemini TTS is only a fallback now, and
  // long retry storms here used to add ~20s of latency before the real engine
  // (Cartesia) took over. Better to fail over immediately.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let json;
    try {
      json = await postJSON(model, body, { retries: 0 });
    } catch (err) {
      lastErr = err;
      await sleep(200);
      continue;
    }
    const part = json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    const data = part?.inlineData?.data;
    if (data) {
      const pcm = Buffer.from(data, 'base64');
      const rate = rateFromMime(part.inlineData.mimeType, 24000);
      return { buffer: pcmToWav(pcm, rate), contentType: 'audio/wav' };
    }
    const fr = json?.candidates?.[0]?.finishReason || 'unknown';
    lastErr = new Error(`Gemini TTS returned text instead of audio (finishReason=${fr})`);
    await sleep(200);
  }
  throw lastErr || new Error('Gemini TTS failed');
}
