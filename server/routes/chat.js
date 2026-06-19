// ── Chat Routes: /api/chat, /api/chat/upload, /api/history, /api/abort ──

import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { copyFile, unlink, mkdir } from 'fs/promises';
import { gwRequest, acceptSessionKey } from '../gateway.js';
import { deviceSessionKey } from '../session-key.js';
import { formatTextPrompt } from '../assistant-guidelines.js';

const router = Router();
const fileUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });
const MEDIA_INBOUND = path.join(os.homedir(), '.openclaw', 'media', 'inbound');

let msgCountToday = 0;
let msgCountDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

export function getMsgCount() { return msgCountToday; }
export function getMsgCountDate() { return msgCountDate; }

function bumpMsgCount() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  if (today !== msgCountDate) { msgCountToday = 0; msgCountDate = today; }
  msgCountToday++;
}

// 檔案上傳
router.post('/chat/upload', fileUpload.array('files', 10), async (req, res) => {
  const message = req.body.message || '';
  const files = req.files || [];
  if (!files.length && !message) return res.status(400).json({ error: 'no files or message' });

  try {
    await mkdir(MEDIA_INBOUND, { recursive: true });
    const filePaths = [];
    for (const file of files) {
      const ext = path.extname(file.originalname) || '';
      const destName = `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
      const destPath = path.join(MEDIA_INBOUND, destName);
      await copyFile(file.path, destPath);
      await unlink(file.path);
      filePaths.push(destPath);
    }

    let fullMessage = message;
    if (filePaths.length) {
      const fileList = filePaths.map(f => `[media attached: ${f}]`).join('\n');
      fullMessage = fullMessage ? `${fullMessage}\n\n${fileList}` : fileList;
    }

    bumpMsgCount();
    const idempotencyKey = `jarvis-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const guardedMessage = formatTextPrompt(fullMessage);
    const sessionKey = deviceSessionKey(req.app.locals.sessionKey, req.body.device, 'web');
    acceptSessionKey(sessionKey);
    const result = await gwRequest('chat.send', {
      message: guardedMessage, sessionKey,
      idempotencyKey, deliver: false,
    });
    res.json({ ok: true, files: filePaths.map(f => path.basename(f)), ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'upload error' });
  }
});

// 送出訊息
router.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  bumpMsgCount();
  try {
    const idempotencyKey = `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionKey = deviceSessionKey(req.app.locals.sessionKey, req.body.device, 'web');
    acceptSessionKey(sessionKey);
    const result = await gwRequest('chat.send', {
      message: formatTextPrompt(message), sessionKey,
      idempotencyKey, deliver: false,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

// 歷史
router.get('/history', async (req, res) => {
  try {
    const sessionKey = deviceSessionKey(req.app.locals.sessionKey, req.query.device, 'web');
    acceptSessionKey(sessionKey);
    const result = await gwRequest('chat.history', {
      sessionKey,
      limit: parseInt(req.query.limit) || 20,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

// 中止
router.post('/abort', async (req, res) => {
  try {
    const result = await gwRequest('chat.abort', {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

export default router;
