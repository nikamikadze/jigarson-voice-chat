// ── Provider API key manager: /api/keys ──
// One key per provider, powering ALL that provider's features (brain, STT, TTS,
// images). Set from the UI; applied live (process.env) and persisted to .env.
// Single-user local tool: this writes secrets, so keep the UI on localhost.

import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '..', '.env'); // routes/ → server/ → root

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', powers: 'brain · STT · TTS · images' },
  { id: 'google', label: 'Google AI Studio', env: 'GEMINI_API_KEY', powers: 'STT · TTS · Live · images' },
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY', powers: 'brain' },
  { id: 'cartesia', label: 'Cartesia', env: 'CARTESIA_API_KEY', powers: 'TTS' },
];

function mask(v) {
  if (!v) return '';
  return v.length <= 12 ? v.slice(0, 3) + '…' : v.slice(0, 6) + '…' + v.slice(-4);
}

const router = Router();

router.get('/keys', (req, res) => {
  res.json({
    providers: PROVIDERS.map(p => {
      const v = process.env[p.env] || '';
      return { id: p.id, label: p.label, powers: p.powers, set: !!v, masked: mask(v) };
    }),
  });
});

router.post('/keys', async (req, res) => {
  const { provider, key } = req.body || {};
  const p = PROVIDERS.find(x => x.id === provider);
  if (!p) return res.status(400).json({ error: 'unknown provider' });
  if (!key || typeof key !== 'string' || !key.trim()) return res.status(400).json({ error: 'key required' });
  const val = key.trim();
  try {
    process.env[p.env] = val;                 // live, no restart needed
    let txt = '';
    try { txt = await readFile(ENV_PATH, 'utf8'); } catch {}
    const line = `${p.env}=${val}`;
    const re = new RegExp(`^${p.env}=.*$`, 'm');
    if (re.test(txt)) txt = txt.replace(re, line);
    else txt = txt + (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n';
    await writeFile(ENV_PATH, txt);
    res.json({ ok: true, provider: p.id, masked: mask(val) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
