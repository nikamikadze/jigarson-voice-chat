// ── Sessions admin: /api/sessions ──
// Full control over every OpenClaw session (yours, coworkers', Telegram, etc.)
// via the operator-scoped gateway connection: list, read history, send a
// message, switch model, or abort a running turn — for any session key.

import { Router } from 'express';
import { gwRequest } from '../gateway.js';

const router = Router();

// List all sessions.
router.get('/sessions', async (req, res) => {
  try {
    const out = await gwRequest('sessions.list', { limit: 100 });
    res.json({ sessions: out.sessions || out || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read a session's recent history.
router.get('/sessions/history', async (req, res) => {
  const sessionKey = String(req.query.key || '');
  if (!sessionKey) return res.status(400).json({ error: 'key required' });
  try {
    const out = await gwRequest('chat.history', { sessionKey, limit: 50 });
    res.json({ messages: out.messages || out.history || out || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message into a session (deliver:true => goes out on its channel).
router.post('/sessions/send', async (req, res) => {
  const { key, message, deliver = true } = req.body || {};
  if (!key || !message) return res.status(400).json({ error: 'key and message required' });
  try {
    await gwRequest('chat.send', {
      message, sessionKey: key, deliver: !!deliver,
      idempotencyKey: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch a session's model (OpenClaw /model command, scoped to that session).
router.post('/sessions/model', async (req, res) => {
  const { key, model } = req.body || {};
  if (!key || !model) return res.status(400).json({ error: 'key and model required' });
  try {
    await gwRequest('chat.send', {
      message: `/model ${model}`, sessionKey: key, deliver: false,
      idempotencyKey: `admin-model-${Date.now()}`,
    });
    res.json({ ok: true, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Abort the running turn in a session.
router.post('/sessions/abort', async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await gwRequest('chat.abort', { sessionKey: key });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
