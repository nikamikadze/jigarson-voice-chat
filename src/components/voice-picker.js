// ── TTS voice picker ──
// Renders inside the Controls panel (#tts-voice-picker), right under the TTS
// ENGINE row. Reads the roster from GET /api/tts/voices and POSTs the choice to
// /api/tts/voice. Remembers the last pick in localStorage so reloads restore it.

import { showNotification } from './notifications.js';

const LS_KEY = 'jarvis.ttsVoice';

export async function initVoicePicker() {
  const mount = document.getElementById('tts-voice-picker');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    const r = await fetch('/api/tts/voices');
    data = await r.json();
  } catch {
    return; // server not ready / older build — fail quiet
  }
  if (!data || !Array.isArray(data.voices) || !data.voices.length) return;

  const select = document.createElement('select');
  select.id = 'tts-voice-select';
  select.setAttribute('aria-label', 'Select TTS voice');
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

  const label = document.getElementById('tts-voice-label');
  const saved = localStorage.getItem(LS_KEY);
  const initial = saved || data.current;
  if (initial) select.value = initial;
  if (label) label.textContent = select.value || '—';

  // If a saved voice differs from the server's current, push it on load.
  if (saved && saved !== data.current) applyVoice(saved, true, label);

  select.addEventListener('change', () => applyVoice(select.value, false, label));

  mount.appendChild(select);
  mount.dataset.ready = '1';
}

async function applyVoice(voice, silent, label) {
  try {
    const r = await fetch('/api/tts/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    localStorage.setItem(LS_KEY, j.voice);
    if (label) label.textContent = j.voice;
    if (!silent) showNotification(`TTS VOICE: ${j.voice.toUpperCase()}`);
  } catch (err) {
    if (!silent) showNotification(`Voice change failed: ${err.message}`);
  }
}
