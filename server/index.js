// ── JARVIS 後端入口 ──

import express from 'express';
import path from 'path';
import os from 'os';
import { readFile, appendFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { initGateway, gwRequest, acceptSessionKey } from './gateway.js';
import { addClient, removeClient, broadcastChat, setMainSessionKey } from './sse.js';
import { deviceSessionKey } from './session-key.js';
import { initTTS } from './tts.js';
import { startSystemMonitor } from './system-monitor.js';
import { initLiveProxy } from './gemini-live.js';
import { initVoiceStream } from './voice-stream.js';
import { initGeminiSttStream } from './gemini-stt-stream.js';

// Routes
import chatRoutes from './routes/chat.js';
import statusRoutes from './routes/status.js';
import ttsRoutes from './routes/tts-routes.js';
import tasksRoutes from './routes/tasks.js';
import skillsRoutes from './routes/skills.js';
import memoryRoutes from './routes/memory.js';
import scheduleRoutes from './routes/schedule.js';
import voiceRoutes from './routes/voice.js';
import liveRoutes from './routes/live-routes.js';
import modelRoutes from './routes/model-routes.js';
import sessionsRoutes from './routes/sessions-routes.js';
import sttRoutes from './routes/stt-routes.js';
import brainRoutes from './routes/brain-routes.js';
import keysRoutes from './routes/keys-routes.js';
import { initSTT } from './stt.js';
import usageRoutes from './routes/usage.js';
import controlRoutes from './routes/control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── 讀取設定 ──
let config;
try {
  config = JSON.parse(await readFile(path.join(ROOT, 'config.local.json'), 'utf-8'));
} catch {
  config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf-8'));
}

const GATEWAY_URL = process.env.GATEWAY_URL || config.server.gatewayUrl;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
if (!GATEWAY_TOKEN) { console.error('[JARVIS] GATEWAY_TOKEN env is required'); process.exit(1); }
const PORT = process.env.PORT || config.server.port;
const SERVE_STATIC = process.env.SERVE_STATIC !== 'false';
const SESSION_KEY = config.agent.sessionKey;
const VOICE_SESSION_KEY = config.voice?.sessionKey || SESSION_KEY;  // lean voice agent
const OC_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');

// ── Crash guards ──
// Keep the server alive on stray async errors. Without these, a single
// unhandled throw (e.g. a malformed gateway frame or a dropped SSE client)
// kills the whole process — which the browser then sees as "Load failed".
process.on('uncaughtException', (err) => {
  console.error('[JARVIS] uncaughtException:', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[JARVIS] unhandledRejection:', reason?.stack || reason);
});

// ── Express ──
const app = express();
app.use(express.json());

// CORS middleware to allow Vercel and other origins
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 共享 sessionKey 供路由使用
app.locals.sessionKey = SESSION_KEY;
app.locals.voiceSessionKey = VOICE_SESSION_KEY;
app.locals.voice = config.voice || {};
app.locals.usage = config.usage || {};

// ── SSE ──
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  // Each browser gets its own private session, derived from its device id.
  const key = deviceSessionKey(SESSION_KEY, req.query.device, 'web');
  acceptSessionKey(key);
  addClient(res, key);
  req.on('close', () => removeClient(res));
});

// ── Client debug log（前端診斷 → client-debug.log） ──
app.post('/api/client-log', async (req, res) => {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...req.body }) + '\n';
    await appendFile(path.join(ROOT, 'client-debug.log'), line);
  } catch { /* ignore */ }
  res.json({ ok: true });
});

// ── 掛載路由 ──
app.use('/api', chatRoutes);
app.use('/api', statusRoutes(config, OC_CONFIG));
app.use('/api', ttsRoutes);
app.use('/api', tasksRoutes);
app.use('/api', skillsRoutes);
app.use('/api', memoryRoutes);
app.use('/api', scheduleRoutes);
app.use('/api', voiceRoutes);
app.use('/api', usageRoutes);
app.use('/api', liveRoutes);
app.use('/api', modelRoutes);
app.use('/api', sessionsRoutes);
app.use('/api', sttRoutes);
app.use('/api', brainRoutes);
app.use('/api', keysRoutes);
app.use('/api', controlRoutes);

// ── 靜態檔案 ──
if (SERVE_STATIC) {
  const distPath = path.join(ROOT, 'dist');
  app.use(express.static(distPath));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

// ── 初始化 ──
initTTS(config.tts);
initSTT(config.stt || {});
setMainSessionKey(SESSION_KEY);
initGateway({
  url: GATEWAY_URL, token: GATEWAY_TOKEN, sessionKey: SESSION_KEY,
  onChat: broadcastChat,
  extraSessionKeys: VOICE_SESSION_KEY !== SESSION_KEY ? [VOICE_SESSION_KEY] : [],
});
startSystemMonitor();

const server = app.listen(PORT, () => {
  console.log(`[JARVIS] API server on http://localhost:${PORT}`);
  if (SERVE_STATIC) console.log(`[JARVIS] Serving static files from dist/`);
});

// Gemini Live realtime voice proxy (WebSocket at /api/live)
const liveWss = initLiveProxy(server, {
  model: config.live?.model,
  system: config.live?.system,
  languageCode: config.live?.languageCode,
  sessionKey: SESSION_KEY,
  voice: config.live?.voice || config.tts?.geminiVoice || 'Aoede',
});

// Voice streaming proxy (WebSocket at /api/voice-stream)
const voiceWss = initVoiceStream(server, config);

// Gemini Live streaming STT proxy (WebSocket at /api/voice-stt)
const sttWss = initGeminiSttStream(server, config);

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url.split('?')[0];

  if (pathname === '/api/live') {
    liveWss.handleUpgrade(request, socket, head, (ws) => {
      liveWss.emit('connection', ws, request);
    });
  } else if (pathname === '/api/voice-stream') {
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      voiceWss.emit('connection', ws, request);
    });
  } else if (pathname === '/api/voice-stt') {
    sttWss.handleUpgrade(request, socket, head, (ws) => {
      sttWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});
