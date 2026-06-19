// ── OpenAI chat (streaming, OpenAI-compatible) ──
// Direct brain path — bypasses OpenClaw gateway for low-latency responses.
// Requires OPENAI_API_KEY in the environment.

const BASE  = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';

export function openaiAvailable() {
  return !!process.env.OPENAI_API_KEY;
}

export function openaiChatModel() {
  return MODEL;
}

// Streaming chat completion. Calls onToken(text) for each delta as it arrives.
// Returns the full assembled text. Throws on HTTP / network errors.
export async function openaiChatStream({ system, user, history = [], onToken, temperature = 0.7, signal } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of history) messages.push(m);
  messages.push({ role: 'user', content: user });

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: MODEL, messages, stream: true, temperature }),
    signal,
  });

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j     = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onToken?.(delta); }
      } catch { /* skip keep-alive / partial */ }
    }
  }

  return full;
}

// ── OpenAI TTS: returns { buffer (mp3), contentType } ──
export async function openaiTTS(text, {
  voice = process.env.OPENAI_TTS_VOICE || 'alloy',
  model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
} = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI TTS ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('OpenAI TTS empty audio');
  return { buffer: buf, contentType: 'audio/mpeg' };
}

// The 11 OpenAI TTS voices (gpt-4o-mini-tts / tts-1).
export const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
];
