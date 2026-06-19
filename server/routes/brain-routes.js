// ── Brain routes: GET /api/brain, POST /api/brain ──

import { Router } from 'express';
import { getBrains, setBrain } from '../brain.js';

const router = Router();

router.get('/brain', (req, res) => res.json(getBrains()));

router.post('/brain', (req, res) => {
  try {
    const id = String(req.body.brain || '').trim();
    if (!id) return res.status(400).json({ error: 'brain id required' });
    res.json({ brain: setBrain(id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
