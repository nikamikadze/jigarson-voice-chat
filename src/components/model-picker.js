// ── Agent model picker ──
// Lists OpenClaw's configured models and switches the live session's model via
// the `/model <id>` command (handled by /api/model on the server).

import { showNotification } from './notifications.js';

export async function initModelPicker() {
  const mount = document.getElementById('agent-model-picker');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    data = await fetch('/api/model').then(r => r.json());
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.models) || !data.models.length) return;

  const select = document.createElement('select');
  select.id = 'agent-model-select';
  select.setAttribute('aria-label', 'Select agent model');
  select.style.cssText = `
    width: 100%; box-sizing: border-box;
    background: rgba(10, 14, 20, 0.9);
    color: rgb(var(--accent-rgb, 41 211 255));
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.4);
    border-radius: 8px; padding: 6px 8px;
    font-family: inherit; font-size: 11px; letter-spacing: .5px; cursor: pointer;
  `;

  for (const m of data.models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.alias ? `${m.alias} · ${m.id}` : m.id;
    select.appendChild(o);
  }

  const label = document.getElementById('agent-model-label');
  if (data.primary) select.value = data.primary;
  const short = (id) => id.split('/').pop();
  if (label) label.textContent = short(select.value) || '—';

  select.addEventListener('change', async () => {
    const model = select.value;
    if (label) label.textContent = '…';
    try {
      const r = await fetch('/api/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      if (label) label.textContent = short(model);
      showNotification(`MODEL: ${short(model).toUpperCase()}`);
    } catch (err) {
      if (label) label.textContent = short(data.primary) || '—';
      showNotification(`Model switch failed: ${err.message}`);
    }
  });

  mount.appendChild(select);
  mount.dataset.ready = '1';
}
