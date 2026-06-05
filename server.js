import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { promises as fs } from 'node:fs';
import fetch, { File, FormData } from 'node-fetch';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { attachRealtimeVoice } from './audio/realtimeSession.js';
import {
  ensureDataStore,
  isAllowedKnowledgeFile,
  knowledgeFilePath,
  knowledgeBufferToText,
  knowledgeStatus,
  loadPersonality,
  safeKnowledgeFilename,
  savePersonality
} from './llm/knowledge.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/realtime' });
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const GEORGIAN_TRANSCRIBE_PROMPT = [
  'Transcribe spoken Georgian accurately.',
  'Use Georgian script, do not translate to English, and preserve Georgian names, places, numbers, and natural punctuation.',
  'The audio is a live Georgian voice assistant conversation, so prefer conversational Georgian wording over English lookalikes.'
].join(' ');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_AUDIO_MAX_BYTES || 25 * 1024 * 1024) }
});
const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.KNOWLEDGE_UPLOAD_MAX_BYTES || 5 * 1024 * 1024) }
});

function localNetworkUrls(port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`);
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.password || req.body?.password;
  if (password !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    res.status(401).json({ error: 'Admin password required' });
    return;
  }
  next();
}

app.get('/admin', (_req, res) => {
  res.sendFile('admin.html', { root: 'public' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, mode: 'realtime' });
});

app.post('/api/transcribe-upload', upload.single('audio'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('Missing env: OPENAI_API_KEY');
    if (!req.file?.buffer?.length) {
      res.status(400).json({ error: 'Upload an audio file in the audio field.' });
      return;
    }

    const form = new FormData();
    form.set('model', process.env.OPENAI_UPLOAD_TRANSCRIBE_MODEL || 'gpt-4o-transcribe');
    form.set('language', process.env.OPENAI_TRANSCRIBE_LANGUAGE || 'ka');
    form.set('prompt', process.env.OPENAI_TRANSCRIBE_PROMPT || GEORGIAN_TRANSCRIBE_PROMPT);
    form.set('response_format', 'json');
    form.set(
      'file',
      new File([req.file.buffer], req.file.originalname || 'iphone-audio.m4a', {
        type: req.file.mimetype || 'audio/mp4'
      })
    );

    const response = await fetch(TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(response.status).json({ error: payload.error?.message || 'OpenAI transcription failed' });
      return;
    }
    res.json({
      text: payload.text || '',
      model: process.env.OPENAI_UPLOAD_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
      language: process.env.OPENAI_TRANSCRIBE_LANGUAGE || 'ka',
      file: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/status', requireAdmin, async (_req, res) => {
  try {
    res.json(await knowledgeStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/personality', requireAdmin, async (_req, res) => {
  try {
    res.json({ text: await loadPersonality() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/personality', requireAdmin, async (req, res) => {
  try {
    await savePersonality(req.body?.text || '');
    res.json({ ok: true, text: await loadPersonality() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/knowledge', requireAdmin, knowledgeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      res.status(400).json({ error: 'Upload a knowledge file.' });
      return;
    }
    if (!isAllowedKnowledgeFile(req.file.originalname)) {
      res.status(400).json({ error: 'Only TXT, MD, and JSON files are supported.' });
      return;
    }
    try {
      knowledgeBufferToText(req.file.originalname, req.file.buffer);
    } catch {
      res.status(400).json({ error: 'JSON file could not be parsed.' });
      return;
    }
    const filename = safeKnowledgeFilename(req.file.originalname);
    await ensureDataStore();
    await fs.writeFile(knowledgeFilePath(filename), req.file.buffer);
    res.json({ ok: true, filename, status: await knowledgeStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/knowledge/:filename', requireAdmin, async (req, res) => {
  try {
    await ensureDataStore();
    await fs.unlink(knowledgeFilePath(req.params.filename));
    res.json({ ok: true, status: await knowledgeStatus() });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Knowledge file not found.' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

attachRealtimeVoice(wss);

server.listen(PORT, HOST, () => {
  console.log(`Mr. Jigarson realtime voice server: http://localhost:${PORT}`);
  console.log('WebSocket endpoint: ws://localhost:%s/realtime', PORT);
  for (const url of localNetworkUrls(PORT)) console.log(`iPhone upload test: ${url}/iphone-test.html`);
});
