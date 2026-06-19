// ── DeepSeek chat (OpenAI-compatible, streaming) ──
// Used by the voice pipeline as a direct, low-latency brain (bypassing OpenClaw).
// Requires DEEPSEEK_API_KEY in the environment.

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

export function deepseekAvailable() {
  return !!process.env.DEEPSEEK_API_KEY;
}

export function deepseekModel() {
  return MODEL;
}

// Streaming chat completion. Calls onToken(text) for each delta as it arrives.
// Returns the full assembled text. Throws on HTTP / network errors.
export async function deepseekChatStream({ system, user, onToken, temperature = 0.7, signal } = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
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
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 300)}`);
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
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onToken?.(delta); }
      } catch { /* skip keep-alive / partial */ }
    }
  }

  return full;
}
