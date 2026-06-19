// ── AI Brain picker ──
// Shows available AI backends (openclaw, openai, deepseek) in the Controls panel.
// Greys out engines with no API key. POSTs selection to /api/brain.

import { showNotification } from './notifications.js';

export async function initBrainPicker() {
  const mount = document.getElementById('brain-picker');
  if (!mount || mount.dataset.ready) return;

  let data;
  try {
    data = await fetch('/api/brain').then(r => r.json());
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.brains) || !data.brains.length) return;

  const label = document.getElementById('brain-label');
  const nameOf = (id) => data.brains.find(b => b.id === id)?.name || id;
  if (label) label.textContent = nameOf(data.current);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;';

  for (const b of data.brains) {
    const btn = document.createElement('button');
    btn.className = 'btn brain-btn';
    btn.textContent = b.name.toUpperCase();
    btn.dataset.brain = b.id;
    btn.title = b.description || '';
    btn.disabled = !b.available;

    const isSelected = b.id === data.current;
    applyBtnStyle(btn, isSelected, b.available);

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      try {
        const r = await fetch('/api/brain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brain: b.id }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'failed');
        data.current = j.brain;
        if (label) label.textContent = nameOf(j.brain);
        updateBrainButtons(j.brain);
        showNotification(`BRAIN: ${nameOf(j.brain).toUpperCase()}`);
      } catch (err) {
        showNotification(`Brain switch failed: ${err.message}`);
      }
    });

    btnRow.appendChild(btn);
  }

  mount.appendChild(btnRow);
  mount.dataset.ready = '1';
}

function applyBtnStyle(btn, selected, available) {
  btn.style.cssText = `
    flex: 1; min-width: 70px;
    padding: 5px 10px;
    font-size: 0.65rem;
    border: 1px solid rgba(var(--accent-rgb), ${selected ? '0.8' : available ? '0.3' : '0.15'});
    background: ${selected ? 'rgba(var(--accent-rgb), 0.15)' : 'transparent'};
    color: ${available ? 'var(--text-primary)' : 'rgba(var(--accent-rgb), 0.3)'};
    cursor: ${available ? 'pointer' : 'not-allowed'};
    font-family: "TheGoodMonolith", monospace;
    letter-spacing: 1px;
  `;
}

function updateBrainButtons(selectedId) {
  document.querySelectorAll('.brain-btn').forEach(btn => {
    const sel = btn.dataset.brain === selectedId;
    const avail = !btn.disabled;
    applyBtnStyle(btn, sel, avail);
  });
}
