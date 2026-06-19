// ── Provider API key manager ──
// One key per provider, powering all that provider's features. Reads status from
// GET /api/keys, saves via POST /api/keys (applied live + persisted to .env).

import { showNotification } from './notifications.js';

export async function initKeysManager() {
  const mount = document.getElementById('keys-manager');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    data = await fetch('/api/keys').then(r => r.json());
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.providers)) return;

  mount.innerHTML = '';
  const label = document.getElementById('keys-label');
  const setCount = () => {
    const n = [...mount.querySelectorAll('[data-set="1"]')].length;
    if (label) label.textContent = `${n}/${data.providers.length} set`;
  };

  for (const p of data.providers) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px;';
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
        <span><b>${p.label}</b> <span style="opacity:.5;">${p.powers}</span></span>
        <span data-status style="opacity:.7;">${p.set ? '✓ ' + p.masked : '— not set'}</span>
      </div>
      <div style="display:flex;gap:6px;">
        <input type="password" placeholder="paste ${p.label} key…" data-input
          style="flex:1;min-width:0;background:rgba(10,14,20,.9);color:rgb(var(--accent-rgb,41 211 255));border:1px solid rgba(var(--accent-rgb,41 211 255),.4);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:11px;">
        <button class="btn" data-save style="padding:4px 12px;font-size:11px;">SAVE</button>
      </div>`;
    if (p.set) row.dataset.set = '1';

    const input = row.querySelector('[data-input]');
    const status = row.querySelector('[data-status]');
    row.querySelector('[data-save]').addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      try {
        const r = await fetch('/api/keys', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: p.id, key }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'failed');
        status.textContent = '✓ ' + j.masked;
        row.dataset.set = '1';
        input.value = '';
        setCount();
        showNotification(`${p.label} key saved`);
        // Refresh dependent pickers so newly-enabled engines show up.
        document.querySelectorAll('#stt-engine-picker,#brain-picker').forEach(el => { el.dataset.ready = ''; el.innerHTML = ''; });
      } catch (err) {
        showNotification(`${p.label} save failed: ${err.message}`);
      }
    });

    mount.appendChild(row);
  }
  setCount();
  mount.dataset.ready = '1';
}
