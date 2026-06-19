// ── Cartesia voice picker ──
// Lists Cartesia's voices (from /api/tts/cartesia-voices) and sets the active one
// via /api/tts/cartesia-voice. Remembers the choice in localStorage.

import { showNotification } from './notifications.js';

const LS_KEY = 'jarvis.cartesiaVoice';

export async function initCartesiaVoicePicker() {
  const mount = document.getElementById('cartesia-voice-picker');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    data = await fetch('/api/tts/cartesia-voices').then(r => r.json());
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.voices) || !data.voices.length) {
    const label = document.getElementById('cartesia-voice-label');
    if (label) label.textContent = data && data.error ? 'unavailable' : '—';
    return;
  }

  const select = document.createElement('select');
  select.id = 'cartesia-voice-select';
  select.setAttribute('aria-label', 'Select Cartesia voice');
  select.style.cssText = `
    width: 100%; box-sizing: border-box;
    background: rgba(10, 14, 20, 0.9);
    color: rgb(var(--accent-rgb, 41 211 255));
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.4);
    border-radius: 8px; padding: 6px 8px;
    font-family: inherit; font-size: 11px; letter-spacing: .5px; cursor: pointer;
  `;

  // Sort: Georgian first, then by name.
  const voices = data.voices.slice().sort((a, b) => {
    const ka = (x) => (x.language === 'ka' ? 0 : 1);
    return ka(a) - ka(b) || a.name.localeCompare(b.name);
  });
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.language ? `${v.name} (${v.language})` : v.name;
    select.appendChild(o);
  }

  const label = document.getElementById('cartesia-voice-label');
  const saved = localStorage.getItem(LS_KEY);
  const initial = saved || data.current;
  if (initial) select.value = initial;
  const nameOf = (id) => (voices.find(v => v.id === id)?.name || id || '—');
  if (label) label.textContent = nameOf(select.value);
  if (saved && saved !== data.current) applyVoice(saved, true, label, nameOf);

  select.addEventListener('change', () => applyVoice(select.value, false, label, nameOf));

  mount.appendChild(select);
  mount.dataset.ready = '1';
}

async function applyVoice(voice, silent, label, nameOf) {
  try {
    const r = await fetch('/api/tts/cartesia-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    localStorage.setItem(LS_KEY, j.voice);
    if (label) label.textContent = nameOf(j.voice);
    if (!silent) showNotification(`CARTESIA VOICE: ${nameOf(j.voice).toUpperCase()}`);
  } catch (err) {
    if (!silent) showNotification(`Voice change failed: ${err.message}`);
  }
}
