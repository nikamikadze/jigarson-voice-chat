// ── Sessions admin panel ──
// Lists every OpenClaw session and gives full control of any one: read history,
// send a message, switch its model, or abort its running turn.

import { showNotification } from './notifications.js';

let models = [];
let selectedKey = null;

const $ = (sel, root = document) => root.querySelector(sel);

function sessionKeyOf(s) {
  return s.sessionKey || s.key || s.id || s.session || '';
}
function sessionModelOf(s) {
  return s.model || s.modelId || s.currentModel || s.modelRef
    || s.modelOverride || s.selectedModel || (s.status && s.status.model) || '';
}
function sessionLabel(s) {
  const ch = s.channel || s.channelId || s.source || '';
  const peer = s.peer || s.peerName || s.title || s.name || '';
  const key = sessionKeyOf(s);
  return [ch, peer].filter(Boolean).join(' · ') || key || 'session';
}
function relTime(s) {
  const t = s.updatedAt || s.lastActivityMs || s.mtimeMs || s.mtime || s.ts;
  if (!t) return '';
  const ms = typeof t === 'string' ? Date.parse(t) : t;
  if (!ms) return '';
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return `${sec | 0}s ago`;
  if (sec < 3600) return `${(sec / 60) | 0}m ago`;
  if (sec < 86400) return `${(sec / 3600) | 0}h ago`;
  return `${(sec / 86400) | 0}d ago`;
}

export async function initSessions() {
  const root = document.getElementById('rtab-sessions');
  if (!root) return;

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <span class="control-label">SESSIONS</span>
      <button id="sess-refresh" class="btn" style="padding:4px 10px;font-size:11px;">REFRESH</button>
    </div>
    <div id="sess-list" style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto;"></div>
    <div id="sess-detail" style="margin-top:10px;display:none;"></div>
  `;
  $('#sess-refresh', root).addEventListener('click', loadSessions);

  try { models = (await fetch('/api/model').then(r => r.json())).models || []; } catch {}
  await loadSessions();
}

async function loadSessions() {
  const list = document.getElementById('sess-list');
  if (!list) return;
  list.textContent = 'Loading…';
  let sessions = [];
  try { sessions = (await fetch('/api/sessions').then(r => r.json())).sessions || []; }
  catch (e) { list.textContent = 'Failed to load sessions'; return; }
  if (!sessions.length) { list.textContent = 'No active sessions'; return; }

  list.innerHTML = '';
  for (const s of sessions) {
    const key = sessionKeyOf(s);
    const model = sessionModelOf(s);
    const row = document.createElement('button');
    row.className = 'btn';
    row.style.cssText = 'text-align:left;padding:8px 10px;font-size:11px;line-height:1.4;width:100%;';
    row.innerHTML = `<div style="font-weight:600;">${sessionLabel(s)}</div>
      <div style="opacity:.6;">${model ? '🧠 ' + model.split('/').pop() : 'model: ?'}${relTime(s) ? ' · ' + relTime(s) : ''}</div>`;
    row.addEventListener('click', () => openSession(key, sessionLabel(s), model));
    list.appendChild(row);
  }
}

async function openSession(key, label, currentModel = '') {
  selectedKey = key;
  const d = document.getElementById('sess-detail');
  if (!d) return;
  d.style.display = 'block';

  const modelOpts = models.map(m => `<option value="${m.id}">${m.alias ? m.alias + ' · ' : ''}${m.id}</option>`).join('');
  d.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span class="control-label" style="overflow:hidden;text-overflow:ellipsis;">${label}</span>
      <button id="sess-abort" class="btn" style="padding:4px 10px;font-size:11px;">ABORT</button>
    </div>
    <div style="font-size:11px;opacity:.7;margin:4px 0;">current model: <b>${currentModel ? currentModel.split('/').pop() : 'unknown'}</b></div>
    <div id="sess-history" style="margin:8px 0;max-height:180px;overflow:auto;font-size:11px;line-height:1.5;opacity:.85;"></div>
    <select id="sess-model" style="width:100%;box-sizing:border-box;background:rgba(10,14,20,.9);color:rgb(var(--accent-rgb,41 211 255));border:1px solid rgba(var(--accent-rgb,41 211 255),.4);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:11px;margin-bottom:6px;cursor:pointer;">${modelOpts}</select>
    <div style="display:flex;gap:6px;">
      <input id="sess-input" type="text" placeholder="Message this session…" style="flex:1;background:rgba(10,14,20,.9);color:rgb(var(--accent-rgb,41 211 255));border:1px solid rgba(var(--accent-rgb,41 211 255),.4);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:11px;">
      <button id="sess-send" class="btn" style="padding:4px 12px;font-size:11px;">SEND</button>
    </div>
  `;

  if (currentModel) { try { $('#sess-model', d).value = currentModel; } catch {} }

  $('#sess-abort', d).addEventListener('click', () => act('/api/sessions/abort', { key }, 'Aborted'));
  $('#sess-model', d).addEventListener('change', (e) =>
    act('/api/sessions/model', { key, model: e.target.value }, 'Model switched'));
  $('#sess-send', d).addEventListener('click', sendMsg);
  $('#sess-input', d).addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });

  loadHistory(key);
}

async function loadHistory(key) {
  const h = document.getElementById('sess-history');
  if (!h) return;
  h.textContent = 'Loading…';
  try {
    const msgs = (await fetch('/api/sessions/history?key=' + encodeURIComponent(key)).then(r => r.json())).messages || [];
    if (!msgs.length) { h.textContent = '(no messages)'; return; }
    h.innerHTML = msgs.slice(-30).map(m => {
      const role = m.role || m.from || (m.isAgent ? 'agent' : 'user');
      const c = m.content;
      const text = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('') : (typeof c === 'string' ? c : (m.text || ''));
      return `<div><b style="opacity:.7;">${role}:</b> ${(text || '').slice(0, 400)}</div>`;
    }).join('');
    h.scrollTop = h.scrollHeight;
  } catch { h.textContent = 'Failed to load history'; }
}

async function sendMsg() {
  const input = document.getElementById('sess-input');
  const msg = input?.value.trim();
  if (!msg || !selectedKey) return;
  input.value = '';
  await act('/api/sessions/send', { key: selectedKey, message: msg, deliver: true }, 'Sent');
  setTimeout(() => loadHistory(selectedKey), 1200);
}

async function act(url, body, okMsg) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    showNotification(okMsg);
  } catch (e) {
    showNotification('Failed: ' + e.message);
  }
}
