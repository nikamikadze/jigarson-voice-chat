// ── Agent model switcher: /api/model ──
// Lists the models OpenClaw has configured and switches the live session's model
// by sending the OpenClaw `/model <provider/id>` chat command through the gateway.

import { Router } from 'express';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gwRequest } from '../gateway.js';

const OC_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const router = Router();

router.get('/model', async (req, res) => {
  try {
    const c = JSON.parse(await readFile(OC_CONFIG, 'utf8'));
    const defs = c.agents?.defaults?.models || {};
    const models = Object.entries(defs).map(([id, v]) => ({ id, alias: v?.alias || '' }));
    res.json({ models, primary: c.agents?.defaults?.model?.primary || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/model', async (req, res) => {
  const model = String(req.body.model || '').trim();
  if (!model) return res.status(400).json({ error: 'model required' });
  try {
    // OpenClaw slash command — switches the model for THIS session, live.
    await gwRequest('chat.send', {
      message: `/model ${model}`,
      sessionKey: req.app.locals.sessionKey,
      idempotencyKey: `model-${Date.now()}`,
      deliver: false,
    });
    res.json({ ok: true, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
