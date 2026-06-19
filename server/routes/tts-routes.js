// ── TTS Routes: /api/tts, /api/tts/engines, /api/tts/engine ──

import { Router } from 'express';
import { getEngines, setEngine, getVoices, setVoice, getCartesiaVoice, setCartesiaVoice, synthesizeToResponse } from '../tts.js';
import { listCartesiaVoices } from '../cartesia.js';

const router = Router();

router.get('/tts/engines', (req, res) => res.json(getEngines()));

// Cartesia voice roster + current selection.
router.get('/tts/cartesia-voices', async (req, res) => {
  try {
    res.json({ current: getCartesiaVoice(), voices: await listCartesiaVoices() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tts/cartesia-voice', (req, res) => {
  const voice = String(req.body.voice || '').trim();
  if (!voice) return res.status(400).json({ error: 'voice required' });
  res.json({ voice: setCartesiaVoice(voice) });
});

// Voice roster + current selection (for the in-app picker).
router.get('/tts/voices', (req, res) => res.json(getVoices()));

router.post('/tts/voice', (req, res) => {
  try {
    res.json({ voice: setVoice(req.body.voice) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/tts/engine', (req, res) => {
  try {
    const engine = setEngine(req.body.engine);
    res.json({ engine });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/tts', async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  await synthesizeToResponse(text, voice, res);
});

export default router;
