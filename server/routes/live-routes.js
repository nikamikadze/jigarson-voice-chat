// ── Gemini Live voice selection: /api/live/voice ──

import { Router } from 'express';
import { getLiveVoice, setLiveVoice } from '../gemini-live.js';
import { GEMINI_VOICES } from '../tts.js';

const router = Router();

router.get('/live/voice', (req, res) => {
  res.json({ current: getLiveVoice(), voices: GEMINI_VOICES });
});

router.post('/live/voice', (req, res) => {
  const match = GEMINI_VOICES.find(v => v.name.toLowerCase() === String(req.body.voice || '').toLowerCase());
  if (!match) return res.status(400).json({ error: 'unknown voice' });
  res.json({ voice: setLiveVoice(match.name) });
});

export default router;
