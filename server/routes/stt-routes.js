// ── STT engine selection: /api/stt/engines, /api/stt/engine ──

import { Router } from 'express';
import { getSttEngines, setSttEngine } from '../stt.js';

const router = Router();

router.get('/stt/engines', (req, res) => res.json(getSttEngines()));

router.post('/stt/engine', (req, res) => {
  try {
    res.json({ engine: setSttEngine(req.body.engine) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
