// ── Control Routes: /api/stop (abort all agent work) + /api/backup ──

import { Router } from 'express';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { gwRequest } from '../gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');     // project root (jarvis-ui)
const router = Router();

// 🔴 STOP — abort the agent's current run(s). Mirrors OpenClaw's /stop.
router.post('/stop', async (req, res) => {
  try {
    const result = await gwRequest('chat.abort', {});
    res.json({ ok: true, stopped: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

// 💾 BACKUP — snapshot the whole JARVIS project to a timestamped sibling folder.
// Excludes regenerable/heavy dirs so it's fast and small. Returns the path.
router.post('/backup', async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const destName = `jarvis-backup-${stamp}`;
  const dest = path.join(ROOT, '..', destName);
  const args = [
    '-a',
    '--exclude', 'node_modules',
    '--exclude', '.git',
    '--exclude', 'dist',
    '--exclude', '*.log',
    '--exclude', '__pycache__',
    `${ROOT}/`,
    `${dest}/`,
  ];
  execFile('rsync', args, { timeout: 180000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message || 'backup failed' });
    res.json({ ok: true, name: destName, path: dest });
  });
});

export default router;
