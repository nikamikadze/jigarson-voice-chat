// ── Cartesia TTS (Sonic) — high-quality, low-latency, Georgian-capable ──
// Mirrors the working call from the OpenClaw voice-replies skill.
// Requires CARTESIA_API_KEY in the environment.

const TTS_URL = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = '2026-03-01';

export function cartesiaAvailable() {
  return !!process.env.CARTESIA_API_KEY;
}

// List available Cartesia voices. Returns [{ id, name, language }]. Handles the
// paginated /voices response shape defensively.
export async function listCartesiaVoices() {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error('CARTESIA_API_KEY not set');
  const res = await fetch('https://api.cartesia.ai/voices?limit=100', {
    headers: { 'Cartesia-Version': CARTESIA_VERSION, 'X-API-Key': key },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Cartesia voices ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const arr = Array.isArray(j) ? j : (j.data || j.voices || []);
  return arr
    .map(v => ({ id: v.id || v.voice_id || '', name: v.name || v.id || 'voice', language: v.language || v.lang || '' }))
    .filter(v => v.id);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returns { buffer (mp3), contentType }. Retries transient errors.
export async function cartesiaTTS(text, {
  voiceId = 'a167e0f3-df7e-4d52-a9c3-f949145efdab',  // Blake
  language = 'ka',
  model = 'sonic-3.5',
  retries = 3,
} = {}) {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error('CARTESIA_API_KEY not set');

  const body = {
    model_id: model,
    transcript: text,
    voice: { mode: 'id', id: voiceId },
    language,
    output_format: { container: 'mp3', sample_rate: 24000 },
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(TTS_URL, {
        method: 'POST',
        headers: {
          'Cartesia-Version': CARTESIA_VERSION,
          'X-API-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      lastErr = networkErr;
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      throw lastErr;
    }

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length) return { buffer: buf, contentType: 'audio/mpeg' };
      lastErr = new Error('Cartesia returned empty audio');
    } else {
      const errText = await res.text().catch(() => '');
      lastErr = new Error(`Cartesia ${res.status}: ${errText.slice(0, 300)}`);
      // Non-transient (e.g. 401 auth, 402 out of credits, 400 bad request) → fail fast
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastErr;
    }
    if (attempt < retries) await sleep(600 * (attempt + 1));
  }
  throw lastErr;
}
