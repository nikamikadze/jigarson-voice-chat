// ── Mobile hamburger menu ──
// On phones (<=768px) the screen is kept clean: only the orb animation, the
// chat bar, and the VOICE/LIVE buttons (pinned to the right edge) are visible.
// Everything else — full system status, STOP/BACKUP, USAGE, audio spectrum,
// data center and the AI-model settings — is tucked into a left hamburger
// drawer. Menu items "proxy-click" the existing (now hidden) controls, so all
// their original logic keeps working untouched.

import { isPowerSave, setPowerSave } from './powersave.js';

const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

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

  /* Calm mobile shell */
  #mm-hamburger {
    top: calc(12px + env(safe-area-inset-top, 0px));
    left: 14px;
    width: 42px;
    height: 42px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid rgba(17, 24, 39, 0.08);
    color: #111827;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
    backdrop-filter: blur(22px) saturate(1.35);
  }
  #mm-slimbar {
    top: calc(14px + env(safe-area-inset-top, 0px));
    left: 66px;
    right: 14px;
    height: 38px;
    justify-content: flex-start;
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid rgba(17, 24, 39, 0.08);
    color: #111827;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
    font-size: 13px;
    letter-spacing: 0;
    text-transform: none;
  }
  #mm-slimbar .mm-sb-model { max-width: 62%; }
  #mm-overlay {
    background: rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(14px);
  }
  #mm-drawer {
    width: min(88vw, 360px);
    background: rgba(248, 248, 250, 0.92);
    border-right: 1px solid rgba(17, 24, 39, 0.08);
    box-shadow: 24px 0 70px rgba(15, 23, 42, 0.22);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
    text-transform: none;
  }
  #mm-drawer .mm-head {
    color: #111827;
    font-size: 18px;
    letter-spacing: 0;
    font-weight: 700;
  }
  #mm-drawer .mm-close {
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.06);
    color: #111827;
  }
  #mm-drawer .data-panel.system-status {
    display: none !important;
  }
  #mm-drawer .mm-list { gap: 10px; }
  #mm-drawer .mm-item {
    min-height: 52px;
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid rgba(17, 24, 39, 0.06);
    color: #111827;
    border-radius: 16px;
    font-size: 15px;
    letter-spacing: 0;
    box-shadow: 0 8px 22px rgba(15, 23, 42, 0.06);
  }
  #mm-drawer .mm-item .mm-ic {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    background: rgba(10, 132, 255, 0.1);
    color: #0a84ff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  #mm-drawer .mm-item.mm-danger {
    border-color: rgba(255, 59, 48, 0.16);
    color: #b42318;
    background: rgba(255, 255, 255, 0.82);
  }
  #live-toggle-btn {
    display: none !important;
  }
  #gpt-toggle-btn,
  #jarvis-control-panel,
  #usage-btn,
  #voice-test-btn,
  #mobile-toolbar {
    display: none !important;
  }
  #mm-hamburger,
  #mm-slimbar {
    display: none !important;
  }
  body:not(.mobile-chat-open) {
    --mobile-chat-height: 0px;
  }
  body:not(.mobile-chat-open) .terminal-panel.chat-panel {
    pointer-events: none !important;
    opacity: 0 !important;
    transform: translateY(calc(100% + 24px)) scale(0.98) !important;
  }
  body.mobile-chat-open .terminal-panel.chat-panel {
    pointer-events: auto !important;
    opacity: 1 !important;
    transform: translateY(0) scale(1) !important;
  }
  #voice-toggle-btn {
    left: 50% !important;
    right: auto !important;
    top: auto !important;
    bottom: calc(26px + env(safe-area-inset-bottom, 0px)) !important;
    width: 132px !important;
    min-width: 132px !important;
    height: 54px !important;
    min-height: 54px !important;
    max-height: 54px !important;
    padding: 0 20px !important;
    transform: translateX(-50%) !important;
    z-index: 10002 !important;
  }
  body.mobile-chat-open #voice-toggle-btn {
    bottom: calc(var(--mobile-chat-height) + 20px + env(safe-area-inset-bottom, 0px)) !important;
  }
  #mobile-chat-toggle {
    left: calc(50% - 116px) !important;
    width: 92px !important;
    min-width: 92px !important;
  }
  #mobile-more-toggle {
    position: fixed;
    left: calc(50% + 116px);
    bottom: calc(26px + env(safe-area-inset-bottom, 0px));
    z-index: 10002;
    width: 92px;
    min-width: 92px;
    height: 54px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 18px;
    border: 1px solid rgba(17, 24, 39, 0.1);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.88);
    color: #111827;
    box-shadow: 0 16px 38px rgba(15, 23, 42, 0.14);
    backdrop-filter: blur(24px) saturate(1.4);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: 0;
    cursor: pointer;
    transform: translateX(-50%);
    box-sizing: border-box;
    transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease, bottom 0.24s ease;
  }
  body.mobile-chat-open #mobile-more-toggle {
    bottom: calc(var(--mobile-chat-height) + 20px + env(safe-area-inset-bottom, 0px));
  }
  body.usage-panel-open #mobile-chat-toggle,
  body.usage-panel-open #voice-toggle-btn,
  body.usage-panel-open #mobile-more-toggle {
    display: none !important;
  }
  @media (max-width: 390px) {
    #mobile-chat-toggle,
    #mobile-more-toggle {
      min-width: 76px !important;
      padding: 0 14px !important;
    }
    #mobile-chat-toggle span,
    #mobile-more-toggle span {
      display: none;
    }
    #voice-toggle-btn {
      min-width: 128px !important;
    }
  }

  :root {
    --dock-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
    --dock-height: 56px;
    --dock-side: 92px;
    --dock-main: 136px;
    --dock-gap: 10px;
    --dock-chat-gap: 34px;
  }
  #mobile-chat-toggle,
  #mobile-more-toggle,
  #voice-toggle-btn {
    top: auto !important;
    bottom: var(--dock-bottom) !important;
    height: var(--dock-height) !important;
    min-height: var(--dock-height) !important;
    max-height: var(--dock-height) !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 999px !important;
    box-sizing: border-box !important;
    z-index: 10020 !important;
    transform: translateX(-50%) !important;
  }
  #mobile-chat-toggle {
    left: calc(50% - (var(--dock-main) / 2) - (var(--dock-side) / 2) - var(--dock-gap)) !important;
    width: var(--dock-side) !important;
    min-width: var(--dock-side) !important;
  }
  #voice-toggle-btn {
    left: 50% !important;
    right: auto !important;
    width: var(--dock-main) !important;
    min-width: var(--dock-main) !important;
    padding: 0 20px !important;
  }
  #mobile-more-toggle {
    left: calc(50% + (var(--dock-main) / 2) + (var(--dock-side) / 2) + var(--dock-gap)) !important;
    width: var(--dock-side) !important;
    min-width: var(--dock-side) !important;
  }
  #mobile-chat-toggle,
  #mobile-more-toggle {
    background: rgba(255, 255, 255, 0.88) !important;
    color: #111827 !important;
  }
  #mobile-chat-toggle.active {
    background: #111827 !important;
    color: #fff !important;
  }
  body.mobile-chat-open #mobile-chat-toggle,
  body.mobile-chat-open #mobile-more-toggle,
  body.mobile-chat-open #voice-toggle-btn {
    bottom: calc(var(--mobile-chat-height) + var(--dock-chat-gap) + env(safe-area-inset-bottom, 0px)) !important;
  }
  @media (max-width: 390px) {
    :root {
      --dock-side: 84px;
      --dock-main: 124px;
      --dock-gap: 8px;
    }
  }
}`;
  const style = document.createElement('style');
  style.id = 'mm-style';
  style.textContent = css;
  document.head.appendChild(style);
}

let drawer, overlay, hamburger, slimbar, moreButton;
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
  { ic: 'P', label: 'Preferences', fn: () => openDataCenter('controls') },
  { ic: 'A', label: 'Activity', fn: () => openDataCenter() },
  { ic: 'U', label: 'Usage', fn: () => { closeDrawer(); clickEl('#usage-btn'); } },
  { ic: 'S', label: 'Stop assistant', danger: true, fn: () => { closeDrawer(); clickEl('#jcp-stop'); } },
];

function buildDOM() {
  // Hamburger
  hamburger = document.createElement('button');
  hamburger.id = 'mm-hamburger';
  hamburger.type = 'button';
  hamburger.setAttribute('aria-label', 'Open menu');
  hamburger.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  hamburger.addEventListener('click', openDrawer);

  moreButton = document.getElementById('mobile-more-toggle');

  // Slim status strip
  slimbar = document.createElement('div');
  slimbar.id = 'mm-slimbar';
  slimbar.innerHTML = `<span class="mm-sb-model" id="mm-sb-model">Assistant</span><span class="mm-sb-sep">/</span><span class="mm-sb-dim" id="mm-sb-tokens">Ready</span>`;
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
  head.innerHTML = `<span>Menu</span><span class="mm-close" aria-label="Close">x</span>`;
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
    lite.innerHTML = `<span class="mm-ic">L</span><span>Low power ${on ? 'on' : 'off'}</span>`;
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
    sbModel.textContent = alias && alias !== '—' && alias !== '--'
      ? alias
      : (model && model !== '—' && model !== '--' ? model : 'Assistant');
    const tin = txt('tokens-in'), tout = txt('tokens-out'), ctx = txt('context-value');
    const session = txt('session-key');
    const parts = [];
    if (session && session !== '—' && session !== '--') parts.push(session);
    if (ctx && ctx !== '—' && ctx !== '--') parts.push(ctx);
    sbTokens.textContent = parts.length ? parts.join(' / ') : 'Ready';
  };
  update();
  setInterval(update, 1500);
}

export function initMobileMenu() {
  if (!isMobile()) return;
  injectStyle();
  buildDOM();
  window.__openMobileMenu = openDrawer;
  startMirror();
}
