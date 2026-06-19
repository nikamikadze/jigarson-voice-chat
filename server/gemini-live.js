// ── Gemini Live realtime proxy ──
// Browser <--ws--> JARVIS server (/api/live) <--wss--> Gemini Live API.
// Adds: voice selection, a firm in-character (Jigarson) persona, and an OpenClaw
// task bridge — Gemini can call run_task → OpenClaw executes → result spoken back.

import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gwRequest } from './gateway.js';
import { addVoiceHandler, removeVoiceHandler } from './sse.js';

const GEMINI_LIVE_URL = (key) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

const OC_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');
const LIVE_LOG = path.join(process.cwd(), 'live-debug.log');

// Append a structured line to live-debug.log so the task bridge is easy to watch
// with `tail -f live-debug.log`. Also mirrored to the console.
function logLive(tag, extra = {}) {
  const line = { ts: new Date().toISOString(), tag, ...extra };
  console.log(`[LIVE] ${tag}`, Object.keys(extra).length ? JSON.stringify(extra) : '');
  try { fs.appendFileSync(LIVE_LOG, JSON.stringify(line) + '\n'); } catch {}
}

// Active Live voice (one of the Gemini prebuilt voices). Runtime-settable.
let liveVoice = 'Aoede';
export function getLiveVoice() { return liveVoice; }
export function setLiveVoice(v) { if (v && typeof v === 'string') liveVoice = v; return liveVoice; }

const VOICE_DIRECTIVE = `# REALTIME VOICE + VIDEO MODE — YOU ARE JIGARSON (ჯიგარსონი)
You are on a live, real-time call with BOTH audio and the user's live camera. You can SEE
the user and their surroundings through the video frames streaming in (about one per second).
Use what you see naturally — comment on it, answer questions about it, react to what they show
you — but don't narrate every frame or mention "frames"/"images"; just behave as if you can see.
Output ONLY natural spoken Georgian words.
NEVER produce markdown, emojis, URLs, code blocks, bullet points, or headings — just speech.
Keep replies conversational, concise, and to the point — the way you'd actually talk out loud.

# CHARACTER & BACKBONE
Your name is Jigarson (ჯიგარსონი). Stay fully in character as defined below.
Be direct, honest, and opinionated. Do NOT be a yes-man: if the user is wrong, mistaken, or
about to make a bad call, say so plainly and explain why. Push back when it's warranted.
Never flatter or reflexively agree. Have a spine and your own judgment.

# DOING TASKS
You can actually GET THINGS DONE on the user's computer. When the user asks you to perform an
action, run something, control the desktop, look something up in their system, or carry out a
multi-step job, CALL the run_task function with a clear, self-contained description of the job.
Never claim you've done something unless run_task actually did it. You may say a short word
that you're on it, then report the real result it returns.

`;

// Tool the model can call to hand a job to the OpenClaw agent.
const LIVE_TOOLS = [{
  functionDeclarations: [{
    name: 'run_task',
    description: "Execute a task or action on the user's computer via the OpenClaw agent "
      + '(desktop control, apps, files, web, multi-step jobs). Use whenever the user asks you to '
      + 'DO something rather than just chat. Returns the result so you can report it back.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: "Full, self-contained description of the task to perform, in the user's words plus any needed detail." },
      },
      required: ['task'],
    },
  }],
}];

// Load the JARVIS/Jigarson persona (directive + IDENTITY + SOUL). Re-read each
// connection so edits take effect immediately.
function loadPersona() {
  try {
    let out = VOICE_DIRECTIVE;
    try { out += fs.readFileSync(path.join(OC_WORKSPACE, 'IDENTITY.md'), 'utf8') + '\n\n'; } catch {}
    out += fs.readFileSync(path.join(OC_WORKSPACE, 'SOUL.md'), 'utf8');
    return out;
  } catch {
    return VOICE_DIRECTIVE + 'You are JIGARSON, a sharp, direct personal assistant. Speak Georgian.';
  }
}

// Run a task through the OpenClaw agent; resolve with the final reply text.
function runOpenClawTask(message, sessionKey) {
  return new Promise((resolve) => {
    let fullText = '';
    let runId = null;
    let done = false;
    let handler;
    const finish = () => {
      if (done) return;
      done = true;
      if (handler) removeVoiceHandler(handler);
      resolve(fullText.trim() || 'დასრულდა.');
    };
    handler = (payload) => {
      const c = payload.message?.content;
      const text = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('') : (typeof c === 'string' ? c : '');
      if (!runId && payload.runId) runId = payload.runId;
      if (runId && payload.runId !== runId) return;
      if (payload.state === 'streaming' || payload.state === 'delta' || payload.state === 'final') fullText = text;
      if (payload.state === 'final' || payload.state === 'aborted') finish();
    };
    addVoiceHandler(handler);
    gwRequest('chat.send', {
      message, sessionKey,
      idempotencyKey: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      deliver: false,
    }).catch(() => finish());
    setTimeout(finish, 120000);   // safety cap
  });
}

export function initLiveProxy(httpServer, opts = {}) {
  const MODEL = opts.model || process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
  const LANG = opts.languageCode || 'ka-GE';
  const SESSION_KEY = opts.sessionKey || 'agent:main:main';
  if (opts.voice) liveVoice = opts.voice;

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) { client.close(1011, 'GEMINI_API_KEY missing'); return; }

    logLive('browser.connected');
    const upstream = new WebSocket(GEMINI_LIVE_URL(key));
    let loggedFromGemini = 0;
    const liveStartedAt = Date.now();
    let liveAudioInBytes = 0;
    let liveAudioOutBytes = 0;
    let liveUsage = null;

    upstream.on('open', () => {
      const system = opts.system || loadPersona();
      const setup = {
        setup: {
          model: `models/${MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            // Live video frames come in on the same socket; LOW keeps token cost
            // and latency down (fine for "what am I showing you" use).
            mediaResolution: 'MEDIA_RESOLUTION_LOW',
            speechConfig: {
              languageCode: LANG,
              voiceConfig: { prebuiltVoiceConfig: { voiceName: liveVoice } },
            },
          },
          systemInstruction: { parts: [{ text: system }] },
          tools: LIVE_TOOLS,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
      upstream.send(JSON.stringify(setup));
      console.log(`[LIVE] setup sent (model=${MODEL}, lang=${LANG}, voice=${liveVoice}, persona=${system.length} chars)`);
      try { client.send(JSON.stringify({ type: 'proxy-ready' })); } catch {}
    });

    // browser → Gemini
    client.on('message', (data) => {
      liveAudioInBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data.toString());
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });

    // Gemini → browser (+ intercept tool calls for the OpenClaw bridge)
    upstream.on('message', async (data) => {
      const text = data.toString();
      liveAudioOutBytes += Buffer.byteLength(text);
      let msg = null;
      try { msg = JSON.parse(text); } catch {}
      if (msg && (msg.usageMetadata || msg.usage)) liveUsage = msg.usageMetadata || msg.usage;

      // ── OpenClaw task bridge: handle run_task server-side, never forward it ──
      if (msg && msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        for (const fc of msg.toolCall.functionCalls) {
          let result = '';
          if (fc.name === 'run_task') {
            const taskText = fc.args?.task || '';
            const startedAt = Date.now();
            logLive('run_task.start', { task: String(taskText).slice(0, 500) });
            try { client.send(JSON.stringify({ type: 'live-task', task: taskText })); } catch {}
            try {
              result = await runOpenClawTask(taskText, SESSION_KEY);
              logLive('run_task.done', { ms: Date.now() - startedAt, result: String(result).slice(0, 1000) });
            } catch (e) {
              result = 'ვერ შესრულდა: ' + (e.message || 'error');
              logLive('run_task.error', { ms: Date.now() - startedAt, error: e.message || String(e) });
            }
          }
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({
              toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] },
            }));
          }
        }
        return;
      }

      if (loggedFromGemini < 4) { console.log('[LIVE] gemini →', text.slice(0, 300)); loggedFromGemini++; }
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });

    upstream.on('close', (code, reason) => {
      try {
        const inTok = liveUsage?.promptTokenCount || liveUsage?.inputTokenCount || 0;
        const outTok = liveUsage?.candidatesTokenCount || liveUsage?.outputTokenCount || 0;
        const inRate = Number(process.env.GEMINI_LIVE_INPUT_PER_1M_USD || 0);
        const outRate = Number(process.env.GEMINI_LIVE_OUTPUT_PER_1M_USD || 0);
        const costUsd = inRate || outRate ? ((inTok / 1000000) * inRate) + ((outTok / 1000000) * outRate) : 0;
        globalThis.__recordJarvisUsageEvent?.({
          type: 'gemini-live', provider: 'gemini', model: MODEL, status: `closed ${code}`,
          durationSec: (Date.now() - liveStartedAt) / 1000,
          audioInBytes: liveAudioInBytes, audioOutBytes: liveAudioOutBytes,
          usage: liveUsage || null, inputTokens: inTok, outputTokens: outTok,
          totalTokens: liveUsage?.totalTokenCount || 0, costUsd,
        });
      } catch {}
      console.log('[LIVE] gemini closed:', code, reason?.toString()?.slice(0, 200));
      try { client.close(); } catch {}
    });
    upstream.on('error', (err) => {
      console.error('[LIVE] gemini error:', err.message);
      try { client.send(JSON.stringify({ type: 'proxy-error', message: err.message })); } catch {}
      try { client.close(1011, 'upstream error'); } catch {}
    });

    client.on('close', () => { try { upstream.close(); } catch {} });
    client.on('error', () => { try { upstream.close(); } catch {} });
  });

  logLive('proxy.mounted', { model: MODEL, lang: LANG, voice: liveVoice });
  return wss;
}
