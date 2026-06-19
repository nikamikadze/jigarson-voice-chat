// ── STT engine picker ──
// Lists transcription engines (from /api/stt/engines) and switches the active
// one via /api/stt/engine. Greys out engines with no API key.

import { showNotification } from './notifications.js';

export async function initSttPicker() {
  const mount = document.getElementById('stt-engine-picker');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    data = await fetch('/api/stt/engines').then(r => r.json());
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.engines) || !data.engines.length) return;

  const select = document.createElement('select');
  select.id = 'stt-engine-select';
  select.setAttribute('aria-label', 'Select STT engine');
  select.style.cssText = `
    width: 100%; box-sizing: border-box;
    background: rgba(10, 14, 20, 0.9);
    color: rgb(var(--accent-rgb, 41 211 255));
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.4);
    border-radius: 8px; padding: 6px 8px;
    font-family: inherit; font-size: 11px; letter-spacing: .5px; cursor: pointer;
  `;

  for (const e of data.engines) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.available ? e.name : `${e.name} — no key`;
    o.disabled = !e.available;
    select.appendChild(o);
  }

  const label = document.getElementById('stt-engine-label');
  if (data.current) select.value = data.current;
  const nameOf = (id) => (data.engines.find(e => e.id === id)?.name || id);
  if (label) label.textContent = nameOf(select.value);

  select.addEventListener('change', async () => {
    const engine = select.value;
    try {
      const r = await fetch('/api/stt/engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      if (label) label.textContent = nameOf(j.engine);
      showNotification(`STT: ${nameOf(j.engine).toUpperCase()}`);
    } catch (err) {
      if (label) label.textContent = nameOf(data.current);
      select.value = data.current;
      showNotification(`STT switch failed: ${err.message}`);
    }
  });

  mount.appendChild(select);
  mount.dataset.ready = '1';
}
