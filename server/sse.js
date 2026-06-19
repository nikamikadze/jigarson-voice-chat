// ── SSE 廣播管理 ──

// res -> sessionKey. Each browser registers with its own per-device session
// key so an agent reply is delivered only to the device that asked for it.
const sseClients = new Map();
const voiceChatHandlers = new Set();

// The main/chat-panel session key. Events from other sessions (e.g. the lean
// voice agent) are routed only to voice handlers, never to the chat-panel SSE.
let mainSessionKey = null;
export function setMainSessionKey(k) { mainSessionKey = k || null; }

// Safe write: never let a dead/closed SSE client throw and crash a broadcast.
function safeWrite(res, payload) {
  try {
    res.write(payload);
  } catch {
    sseClients.delete(res);
  }
}

export function addClient(res, sessionKey) { sseClients.set(res, sessionKey || null); }
export function removeClient(res) { sseClients.delete(res); }
export function clientCount() { return sseClients.size; }
export function addVoiceHandler(h) { voiceChatHandlers.add(h); }
export function removeVoiceHandler(h) { voiceChatHandlers.delete(h); }

// 提取文字內容
function extractText(payload) {
  if (!payload.message?.content) return '';
  const content = payload.message.content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('');
  return typeof content === 'string' ? content : '';
}

// Extract live "activity" — which tools the agent is calling and whether it's
// thinking — so the UI can show what's happening behind the scenes.
function extractActivity(payload) {
  const msg = payload.message || {};
  const content = msg.content;
  const tools = [];
  let thinking = false;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const t = b.type;
      if (t === 'toolCall' || t === 'tool_use' || t === 'toolUse') {
        tools.push({ name: b.name || b.toolName || b.tool || 'tool', input: shortInput(b.input || b.args || b.arguments) });
      } else if (t === 'thinking' || t === 'reasoning') {
        thinking = true;
      }
    }
  }
  return { role: msg.role || '', tools, thinking };
}

function shortInput(v) {
  if (v == null) return '';
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch { return ''; }
}

export function broadcastChat(payload) {
  const text = extractText(payload);
  const event = {
    runId: payload.runId,
    state: payload.state,
    text,
    role: payload.message?.role || '',
    done: payload.state === 'final' || payload.state === 'aborted',
  };
  if (payload.message?.model) event.model = payload.message.model;
  if (payload.message?.provider) event.provider = payload.message.provider;
  if (payload.message?.usage) event.usage = payload.message.usage;

  // Live agent activity (tools + thinking) for the UI's process feed.
  const activity = extractActivity(payload);
  if (activity.tools.length || activity.thinking) {
    event.activity = activity;
  }

  // Deliver to the SSE client(s) whose own per-device session matches this
  // event. Legacy clients with no key (key === null) fall back to the main
  // session. Voice-session events match no chat client's key, so spoken-mode
  // replies still never render in the typed chat panel.
  const payloadKey = payload.sessionKey || null;
  const data = JSON.stringify(event);
  for (const [res, key] of sseClients) {
    const match = key
      ? key === payloadKey
      : (!mainSessionKey || !payloadKey || payloadKey === mainSessionKey);
    if (match) safeWrite(res, `data: ${data}\n\n`);
  }
  for (const handler of voiceChatHandlers) { try { handler(payload); } catch {} }
}

export function broadcastSystem(data) {
  const msg = JSON.stringify({ type: 'system', ...data });
  for (const res of sseClients.keys()) safeWrite(res, `data: ${msg}\n\n`);
}

export function broadcastEvent(type) {
  const msg = JSON.stringify({ type });
  for (const res of sseClients.keys()) safeWrite(res, `data: ${msg}\n\n`);
}
