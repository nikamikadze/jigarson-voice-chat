// ── Gemini Live voice picker ──
// Renders in the Controls panel (#live-voice-picker). Reads the roster from
// GET /api/live/voice and POSTs the choice to /api/live/voice. If a Live session
// is active, it reconnects so the new voice applies immediately.

import { showNotification } from './notifications.js';
import { isLiveActive, stopLive, startLive } from './gemini-live.js';

const LS_KEY = 'jarvis.liveVoice';

export async function initLiveVoicePicker() {
  const mount = document.getElementById('live-voice-picker');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    data = await fetch('/api/live/voice').then(r => r.json());
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.voices) || !data.voices.length) return;

  const select = document.createElement('select');
  select.id = 'live-voice-select';
  select.setAttribute('aria-label', 'Select Gemini Live voice');
  select.style.cssText = `
    width: 100%; box-sizing: border-box;
    background: rgba(10, 14, 20, 0.9);
    color: rgb(var(--accent-rgb, 41 211 255));
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.4);
    border-radius: 8px; padding: 6px 8px;
    font-family: inherit; font-size: 11px; letter-spacing: .5px; cursor: pointer;
  `;

  const females = data.voices.filter(v => v.gender === 'female');
  const males = data.voices.filter(v => v.gender !== 'female');
  const addGroup = (title, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = title;
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = `${v.name} · ${v.tone}`;
      g.appendChild(o);
    }
    select.appendChild(g);
  };
  addGroup('Female', females);
  addGroup('Male', males);

  const label = document.getElementById('live-voice-label');
  const saved = localStorage.getItem(LS_KEY);
  const initial = saved || data.current;
  if (initial) select.value = initial;
  if (label) label.textContent = select.value || '—';
  if (saved && saved !== data.current) applyVoice(saved, true, label);

  select.addEventListener('change', () => applyVoice(select.value, false, label));

  mount.appendChild(select);
  mount.dataset.ready = '1';
}

async function applyVoice(voice, silent, label) {
  try {
    const r = await fetch('/api/live/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    localStorage.setItem(LS_KEY, j.voice);
    if (label) label.textContent = j.voice;
    if (!silent) showNotification(`LIVE VOICE: ${j.voice.toUpperCase()}`);
    // Reconnect an active Live session so the new voice takes effect now.
    if (!silent && isLiveActive()) { await stopLive(); setTimeout(() => startLive(), 250); }
  } catch (err) {
    if (!silent) showNotification(`Live voice change failed: ${err.message}`);
  }
}
