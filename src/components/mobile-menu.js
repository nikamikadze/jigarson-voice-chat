// ── Mobile hamburger menu ──
// On phones (<=768px) the screen is kept clean: only the orb animation, the
// chat bar, and the VOICE/LIVE buttons (pinned to the right edge) are visible.
// Everything else — full system status, STOP/BACKUP, USAGE, audio spectrum,
// data center and the AI-model settings — is tucked into a left hamburger
// drawer. Menu items "proxy-click" the existing (now hidden) controls, so all
// their original logic keeps working untouched.

import { isPowerSave, setPowerSave } from './powersave.js';

const isMobile = window.matchMedia('(max-width: 768px)').matches;

function injectStyle() {
  const css = `
@media (max-width: 768px) {
  /* The scattered floating controls now live inside the hamburger menu. */
  #jarvis-control-panel, #usage-btn, #voice-test-btn, #mobile-toolbar { display: none !important; }
  body.mobile-sheet-open #live-toggle-btn { display: none !important; }

  /* ── Hamburger button (top-left) ── */
  #mm-hamburger {
    position: fixed; top: calc(8px + env(safe-area-inset-top, 0px)); left: 10px;
    width: 38px; height: 38px; z-index: 9001;
    display: flex; align-items: center; justify-content: center;
    border-radius: 10px; cursor: pointer;
    background: rgba(10, 14, 20, 0.72); backdrop-filter: blur(8px);
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.55);
    color: rgb(var(--accent-rgb, 41 211 255));
    box-shadow: 0 0 16px rgba(var(--accent-rgb, 41 211 255), 0.22);
  }
  #mm-hamburger svg { width: 20px; height: 20px; }

  /* ── Slim status strip (top, leaves room for the hamburger) ── */
  #mm-slimbar {
    position: fixed; top: calc(10px + env(safe-area-inset-top, 0px));
    left: 56px; right: 10px; height: 34px; z-index: 9000;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 0 14px; border-radius: 999px;
    background: rgba(10, 14, 20, 0.72); backdrop-filter: blur(8px);
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.4);
    color: rgb(var(--accent-rgb, 41 211 255));
    font-family: inherit; font-size: 10px; letter-spacing: 1px;
    white-space: nowrap; overflow: hidden; cursor: pointer;
  }
  #mm-slimbar .mm-sb-model { font-weight: 600; overflow: hidden; text-overflow: ellipsis; max-width: 50%; }
  #mm-slimbar .mm-sb-sep { opacity: 0.35; }
  #mm-slimbar .mm-sb-dim { opacity: 0.72; }

  /* ── Overlay + drawer ── */
  #mm-overlay {
    position: fixed; inset: 0; z-index: 10000; display: none;
    background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px);
  }
  #mm-overlay.open { display: block; }

  #mm-drawer {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 10001;
    width: min(86vw, 340px);
    transform: translateX(-105%); transition: transform 0.3s cubic-bezier(0.23, 1, 0.32, 1);
    background: rgba(8, 11, 16, 0.96); backdrop-filter: blur(12px);
    border-right: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.35);
    box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
    display: flex; flex-direction: column;
    padding: calc(12px + env(safe-area-inset-top, 0px)) 12px calc(16px + env(safe-area-inset-bottom, 0px));
    overflow-y: auto; -webkit-overflow-scrolling: touch;
  }
  #mm-drawer.open { transform: translateX(0); }
  #mm-drawer .mm-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; color: rgb(var(--accent-rgb, 41 211 255));
    font-size: 13px; letter-spacing: 2px; font-weight: 600;
  }
  #mm-drawer .mm-close { cursor: pointer; font-size: 20px; line-height: 1; opacity: 0.8; padding: 2px 8px; }

  /* Full system status relocated into the drawer */
  #mm-drawer .data-panel.system-status {
    position: static !important; top: auto !important; left: auto !important;
    right: auto !important; bottom: auto !important; transform: none !important;
    width: 100% !important; margin: 0 0 14px !important; max-width: none !important;
  }

  /* Menu items */
  #mm-drawer .mm-list { display: flex; flex-direction: column; gap: 8px; }
  #mm-drawer .mm-item {
    display: flex; align-items: center; gap: 12px; width: 100%;
    padding: 13px 14px; border-radius: 10px; cursor: pointer; text-align: left;
    background: rgba(var(--accent-rgb, 41 211 255), 0.06);
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.22);
    color: var(--text-primary, #cfeff7);
    font-family: inherit; font-size: 13px; letter-spacing: 1px;
  }
  #mm-drawer .mm-item:active { background: rgba(var(--accent-rgb, 41 211 255), 0.16); }
  #mm-drawer .mm-item .mm-ic { width: 20px; text-align: center; font-size: 15px; }
  #mm-drawer .mm-item.mm-danger { border-color: rgba(255, 80, 80, 0.5); color: #ff8a8a; background: rgba(255, 60, 60, 0.08); }

  /* ── VOICE + LIVE pinned to the right edge, stacked near the orb ──
     Fixed height stops the buttons from stretching between top & bottom
     (that's what ballooned VOICE into a giant capsule over the orb). */
  #live-toggle-btn, #voice-toggle-btn {
    left: auto !important; right: 10px !important; bottom: auto !important;
    height: 38px !important; min-height: 38px !important; max-height: 38px !important;
    padding: 0 13px !important; gap: 6px !important;
  }
  #live-toggle-btn  { top: 40% !important; }
  #voice-toggle-btn { top: calc(40% + 48px) !important; }
  #live-toggle-btn .live-label, #voice-toggle-btn .voice-label { font-size: 11px !important; }
  #voice-toggle-btn svg { width: 18px !important; height: 18px !important; }

  /* Hide the floating bits while the drawer is open */
  body.mm-open #voice-toggle-btn,
  body.mm-open #live-toggle-btn,
  body.mm-open #mm-slimbar,
  body.mm-open #mm-hamburger { visibility: hidden; }
}`;
  const style = document.createElement('style');
  style.id = 'mm-style';
  style.textContent = css;
  document.head.appendChild(style);
}

let drawer, overlay, hamburger, slimbar;
let refreshLite = () => {};

function openDrawer() {
  refreshLite();
  drawer.classList.add('open');
  overlay.classList.add('open');
  document.body.classList.add('mm-open');
}
function closeDrawer() {
  drawer.classList.remove('open');
  overlay.classList.remove('open');
  document.body.classList.remove('mm-open');
}

function clickEl(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (el) el.click();
}

// Open the Data Center sheet (which holds all tabs incl. CONTROLS/settings).
function openDataCenter(tab) {
  closeDrawer();
  clickEl('.mobile-toolbar-btn[data-panel="info-center"]');
  if (tab) {
    setTimeout(() => clickEl(`.tab-btn-r[data-rtab="${tab}"]`), 80);
  }
}

const MENU = [
  { ic: '⚙', label: 'SETTINGS / MODELS', fn: () => openDataCenter('controls') },
  { ic: '🗂', label: 'DATA CENTER', fn: () => openDataCenter() },
  { ic: '📈', label: 'AUDIO SPECTRUM', fn: () => { closeDrawer(); clickEl('.mobile-toolbar-btn[data-panel="spectrum"]'); } },
  { ic: '◈', label: 'USAGE', fn: () => { closeDrawer(); clickEl('#usage-btn'); } },
  { ic: '💾', label: 'BACKUP', fn: () => { closeDrawer(); clickEl('#jcp-backup'); } },
  { ic: '🔊', label: 'TEST AUDIO', fn: () => { closeDrawer(); clickEl('#voice-test-btn'); } },
  { ic: '⏹', label: 'STOP AGENT', danger: true, fn: () => { closeDrawer(); clickEl('#jcp-stop'); } },
];

function buildDOM() {
  // Hamburger
  hamburger = document.createElement('button');
  hamburger.id = 'mm-hamburger';
  hamburger.type = 'button';
  hamburger.setAttribute('aria-label', 'Open menu');
  hamburger.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  hamburger.addEventListener('click', openDrawer);

  // Slim status strip
  slimbar = document.createElement('div');
  slimbar.id = 'mm-slimbar';
  slimbar.innerHTML = `<span class="mm-sb-model" id="mm-sb-model">—</span><span class="mm-sb-sep">·</span><span class="mm-sb-dim" id="mm-sb-tokens">—</span>`;
  slimbar.addEventListener('click', openDrawer);

  // Overlay
  overlay = document.createElement('div');
  overlay.id = 'mm-overlay';
  overlay.addEventListener('click', closeDrawer);

  // Drawer
  drawer = document.createElement('div');
  drawer.id = 'mm-drawer';
  const head = document.createElement('div');
  head.className = 'mm-head';
  head.innerHTML = `<span>☰ MENU</span><span class="mm-close" aria-label="Close">✕</span>`;
  head.querySelector('.mm-close').addEventListener('click', closeDrawer);
  drawer.appendChild(head);

  // Slot where the full system-status panel gets relocated
  const statusSlot = document.createElement('div');
  statusSlot.id = 'mm-status-slot';
  drawer.appendChild(statusSlot);

  // Menu list
  const list = document.createElement('div');
  list.className = 'mm-list';

  // LITE MODE toggle — caps the 3D/visualizer framerate to cut phone heat & battery.
  const lite = document.createElement('button');
  lite.type = 'button';
  lite.className = 'mm-item';
  refreshLite = () => {
    const on = isPowerSave();
    lite.innerHTML = `<span class="mm-ic">${on ? '🔋' : '⚡'}</span><span>LITE MODE — ${on ? 'ON' : 'OFF'}</span>`;
    lite.style.borderColor = on ? 'rgba(var(--accent-rgb, 41 211 255), 0.85)' : '';
    lite.style.background = on ? 'rgba(var(--accent-rgb, 41 211 255), 0.18)' : '';
  };
  lite.addEventListener('click', () => { setPowerSave(!isPowerSave()); refreshLite(); });
  refreshLite();
  list.appendChild(lite);

  MENU.forEach((m) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mm-item' + (m.danger ? ' mm-danger' : '');
    item.innerHTML = `<span class="mm-ic">${m.ic}</span><span>${m.label}</span>`;
    item.addEventListener('click', m.fn);
    list.appendChild(item);
  });
  drawer.appendChild(list);

  document.body.appendChild(hamburger);
  document.body.appendChild(slimbar);
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  // Relocate the full system status HUD into the drawer
  const ss = document.querySelector('.data-panel.system-status');
  if (ss) statusSlot.appendChild(ss);

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

// Mirror the live model + token readouts into the slim top strip.
function startMirror() {
  const sbModel = document.getElementById('mm-sb-model');
  const sbTokens = document.getElementById('mm-sb-tokens');
  if (!sbModel || !sbTokens) return;
  const txt = (id) => (document.getElementById(id)?.textContent || '').trim();
  const update = () => {
    const model = txt('model-name');
    const alias = txt('model-alias');
    sbModel.textContent = alias && alias !== '—'
      ? alias
      : (model && model !== '—' ? model : 'JARVIS');
    const tin = txt('tokens-in'), tout = txt('tokens-out'), ctx = txt('context-value');
    const session = txt('session-key');
    const parts = [];
    if (session && session !== '—') parts.push(session);
    if (tin && tin !== '—') parts.push(`↑${tin}`);
    if (tout && tout !== '—') parts.push(`↓${tout}`);
    if (ctx && ctx !== '—') parts.push(`CTX ${ctx}`);
    sbTokens.textContent = parts.length ? parts.join('  ') : 'ONLINE';
  };
  update();
  setInterval(update, 1500);
}

export function initMobileMenu() {
  if (!isMobile) return;
  injectStyle();
  buildDOM();
  startMirror();
}
