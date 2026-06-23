// ── OpenAI Realtime proxy ──
// Browser <--ws--> JARVIS server (/api/live-openai) <--wss--> OpenAI Realtime (GA) API.
// Translates between the browser's Gemini-Live-shaped protocol (so the existing
// live client is reused) and OpenAI's GA realtime events. Also bridges run_task
// to the OpenClaw agent, mirroring server/gemini-live.js.

import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gwRequest } from './gateway.js';
import { addVoiceHandler, removeVoiceHandler } from './sse.js';

const OPENAI_RT_URL = (model) => `wss://api.openai.com/v1/realtime?model=${model}`;
const OC_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');
const LIVE_LOG = path.join(process.cwd(), 'live-debug.log');

function logRT(tag, extra = {}) {
  const line = { ts: new Date().toISOString(), tag: 'openai-rt.' + tag, ...extra };
  console.log(`[RT] ${tag}`, Object.keys(extra).length ? JSON.stringify(extra) : '');
  try { fs.appendFileSync(LIVE_LOG, JSON.stringify(line) + '\n'); } catch {}
}

// Active OpenAI realtime voice. Runtime-settable.
let rtVoice = 'alloy';
export function getRtVoice() { return rtVoice; }
export function setRtVoice(v) { if (v && typeof v === 'string') rtVoice = v; return rtVoice; }

const VOICE_DIRECTIVE = `# REALTIME VOICE MODE — YOU ARE JIGARSON (ჯიგარსონი)
You are on a live, real-time voice call. Output ONLY natural spoken Georgian words.
NEVER produce markdown, emojis, URLs, code blocks, bullet points, or headings — just speech.
Keep replies conversational, concise, and to the point — the way you'd actually talk out loud.

# CHARACTER & BACKBONE
Your name is Jigarson (ჯიგარსონი). Stay fully in character as defined below.
Be direct, honest, and opinionated. Do NOT be a yes-man: if the user is wrong, say so plainly.
Never flatter or reflexively agree. Have a spine and your own judgment.

# DOING TASKS
You can actually GET THINGS DONE on the user's computer. When the user asks you to perform an
action, run something, control the desktop, look something up, or carry out a multi-step job,
CALL the run_task function with a clear, self-contained description of the job. Never claim you
did something unless run_task actually did it. Say a short word that you're on it, then report
the real result it returns.

`;

const RUN_TASK_TOOL = {
  type: 'function',
  name: 'run_task',
  description: "Execute a task or action on the user's computer via the OpenClaw agent "
    + '(desktop control, apps, files, web, multi-step jobs). Use whenever the user asks you to '
    + 'DO something rather than just chat. Returns the result so you can report it back.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: "Full, self-contained description of the task to perform." },
    },
    required: ['task'],
  },
};

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

// Upsample Int16 PCM base64 from 16kHz → 24kHz (ratio 1.5) via linear interpolation.
// The browser client sends 16kHz mic PCM; OpenAI realtime input defaults to 24kHz pcm16.
function resample16to24(b64) {
  const inBuf = Buffer.from(b64, 'base64');
  const inLen = inBuf.length >> 1;            // int16 samples
  const outLen = Math.floor(inLen * 1.5);
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / 1.5;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = srcPos - i0;
    const s0 = inBuf.readInt16LE(i0 * 2);
    const s1 = inBuf.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out.toString('base64');
}

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
      idempotencyKey: `live-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      deliver: false,
    }).catch(() => finish());
    setTimeout(finish, 120000);
  });
}

export function initOpenAIRealtimeProxy(httpServer, opts = {}) {
  const MODEL = opts.model || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  const SESSION_KEY = opts.sessionKey || 'agent:main:main';
  if (opts.voice) rtVoice = opts.voice;

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) { client.close(1011, 'OPENAI_API_KEY missing'); return; }

    logRT('browser.connected');
    const upstream = new WebSocket(OPENAI_RT_URL(MODEL), { headers: { Authorization: `Bearer ${key}` } });
    let logged = 0;
    const startedAt = Date.now();

    upstream.on('open', () => {
      const system = opts.system || loadPersona();
      upstream.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: system,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: { type: 'server_vad', create_response: true },
            },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: rtVoice },
          },
          tools: [RUN_TASK_TOOL],
          tool_choice: 'auto',
        },
      }));
      logRT('session.sent', { model: MODEL, voice: rtVoice, personaChars: system.length });
      try { client.send(JSON.stringify({ type: 'proxy-ready' })); } catch {}
    });

    // browser → OpenAI (translate Gemini-shaped input → OpenAI events)
    client.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const audio = msg?.realtimeInput?.audio?.data;
      if (audio && upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: resample16to24(audio) }));
      }
      // video frames from the camera are ignored (OpenAI realtime audio-only here)
    });

    // OpenAI → browser (translate OpenAI events → Gemini-shaped messages the client expects)
    upstream.on('message', async (data) => {
      let m = null;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (logged < 40) { logRT('evt', { type: m.type || '?' }); logged++; }
      const t = m.type || '';

      if (t === 'error') {
        logRT('error', { error: JSON.stringify(m.error).slice(0, 400) });
        try { client.send(JSON.stringify({ type: 'proxy-error', message: m.error?.message || 'openai realtime error' })); } catch {}
        return;
      }

      // audio output → modelTurn inlineData
      if (t.endsWith('audio.delta') && m.delta) {
        try { client.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: m.delta } }] } } })); } catch {}
        return;
      }
      // barge-in: user started speaking → tell client to stop playback
      if (t === 'input_audio_buffer.speech_started') {
        try { client.send(JSON.stringify({ serverContent: { interrupted: true } })); } catch {}
        return;
      }
      // user speech transcript (input) — forward both streaming deltas and the final
      if (t === 'conversation.item.input_audio_transcription.delta' && m.delta) {
        try { client.send(JSON.stringify({ serverContent: { inputTranscription: { text: m.delta } } })); } catch {}
        return;
      }
      if (t === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        try { client.send(JSON.stringify({ serverContent: { inputTranscription: { text: m.transcript } } })); } catch {}
        return;
      }
      // assistant spoken transcript (output)
      if (t.includes('audio_transcript.delta') && m.delta) {
        try { client.send(JSON.stringify({ serverContent: { outputTranscription: { text: m.delta } } })); } catch {}
        return;
      }
      // turn finished
      if (t === 'response.done') {
        try { client.send(JSON.stringify({ serverContent: { turnComplete: true } })); } catch {}
        return;
      }

      // ── OpenClaw task bridge: run_task ──
      if (t === 'response.function_call_arguments.done' && m.name === 'run_task') {
        let taskText = '';
        try { taskText = JSON.parse(m.arguments || '{}').task || ''; } catch {}
        const at = Date.now();
        logRT('run_task.start', { task: String(taskText).slice(0, 500) });
        try { client.send(JSON.stringify({ type: 'live-task', task: taskText })); } catch {}
        let result;
        try {
          result = await runOpenClawTask(taskText, SESSION_KEY);
          logRT('run_task.done', { ms: Date.now() - at, result: String(result).slice(0, 1000) });
        } catch (e) {
          result = 'ვერ შესრულდა: ' + (e.message || 'error');
          logRT('run_task.error', { ms: Date.now() - at, error: e.message || String(e) });
        }
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ type: 'conversation.item.create', item: {
            type: 'function_call_output', call_id: m.call_id, output: JSON.stringify({ result }),
          }}));
          upstream.send(JSON.stringify({ type: 'response.create' }));
        }
        return;
      }
    });

    upstream.on('close', (code, reason) => {
      try {
        globalThis.__recordJarvisUsageEvent?.({
          type: 'openai-realtime', provider: 'openai', model: MODEL, status: `closed ${code}`,
          durationSec: (Date.now() - startedAt) / 1000,
        });
      } catch {}
      console.log('[RT] openai closed:', code, reason?.toString()?.slice(0, 200));
      try { client.close(); } catch {}
    });
    upstream.on('error', (err) => {
      console.error('[RT] openai error:', err.message);
      try { client.send(JSON.stringify({ type: 'proxy-error', message: err.message })); } catch {}
      try { client.close(1011, 'upstream error'); } catch {}
    });

    client.on('close', () => { try { upstream.close(); } catch {} });
    client.on('error', () => { try { upstream.close(); } catch {} });
  });

  logRT('proxy.mounted', { model: MODEL, voice: rtVoice });
  return wss;
}
