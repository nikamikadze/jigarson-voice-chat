// ── Voice mode UI wiring ──
// Adds a mic button + hotkey, drives the orb from voice state, and surfaces
// the spoken transcript and the agent's reply into the chat panel.

import { toggleVoiceMode, isVoiceActive, preWarmVAD } from './voice.js';
import { addChatLine } from './chat.js';
import { showNotification } from './notifications.js';
import { dbg } from '../utils/debug-log.js';
import { playAudioUrl } from '../utils/audio-player.js';
import { clearFloatingResponse, scheduleFloatingResponseHide, showFloatingResponse } from './floating-response.js';

const STATE_LABEL = {
  idle: 'Talk',
  listening: 'Listening',
  processing: 'Thinking',
  speaking: 'Speaking',
};

// Map voice states onto the orb's existing agent-state visuals.
const STATE_TO_ORB = {
  idle: 'idle',
  listening: 'idle',
  processing: 'thinking',
  speaking: 'responding',
};

let btn = null;
let currentReplyLine = null;  // the in-progress agent reply line element
let floatingReplyBuffer = '';

function injectButton() {
  if (document.getElementById('voice-toggle-btn')) return;

  const b = document.createElement('button');
  b.id = 'voice-toggle-btn';
  b.type = 'button';
  b.setAttribute('aria-label', 'Talk to assistant');
  b.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
    <span class="voice-label">Talk</span>`;

  const style = document.createElement('style');
  style.textContent = `
    #voice-toggle-btn {
      position: fixed; right: 24px; bottom: 24px; z-index: 9999;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px; border-radius: 999px;
      background: rgba(10, 14, 20, 0.72);
      color: rgb(var(--accent-rgb, 41 211 255));
      border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.55);
      box-shadow: 0 0 18px rgba(var(--accent-rgb, 41 211 255), 0.25);
      backdrop-filter: blur(8px);
      font-family: inherit; font-size: 12px; letter-spacing: 1.5px;
      cursor: pointer; transition: all .2s ease; user-select: none;
    }
    #voice-toggle-btn:hover { box-shadow: 0 0 26px rgba(var(--accent-rgb, 41 211 255), 0.45); }
    #voice-toggle-btn .voice-label { font-weight: 600; }
    #voice-toggle-btn.state-listening,
    #voice-toggle-btn.state-processing,
    #voice-toggle-btn.state-speaking {
      background: rgba(var(--accent-rgb, 41 211 255), 0.18);
      animation: voicePulse 1.4s ease-in-out infinite;
    }
    #voice-toggle-btn.state-speaking { animation-duration: .9s; }
    @keyframes voicePulse {
      0%, 100% { box-shadow: 0 0 14px rgba(var(--accent-rgb, 41 211 255), 0.3); }
      50%      { box-shadow: 0 0 30px rgba(var(--accent-rgb, 41 211 255), 0.7); }
    }
    @media (max-width: 768px) {
      #voice-toggle-btn {
        left: 14px; right: auto;
        bottom: var(--mobile-action-bottom, calc(272px + env(safe-area-inset-bottom, 0px)));
        min-height: 44px;
        padding: 9px 13px;
        box-shadow: 0 10px 34px rgba(0, 0, 0, 0.36), 0 0 18px rgba(var(--accent-rgb, 41 211 255), 0.25);
      }
      #voice-test-btn {
        left: auto !important; right: 14px !important;
        bottom: var(--mobile-action-bottom, calc(272px + env(safe-area-inset-bottom, 0px))) !important;
        min-height: 40px;
        box-shadow: 0 10px 34px rgba(0, 0, 0, 0.36);
      }
      body.mobile-sheet-open #voice-toggle-btn,
      body.mobile-sheet-open #voice-test-btn {
        display: none;
      }
      body:has(.terminal-panel.chat-panel.chat-collapsed) #voice-toggle-btn,
      body:has(.terminal-panel.chat-panel.chat-collapsed) #voice-test-btn {
        bottom: calc(110px + env(safe-area-inset-bottom, 0px)) !important;
      }
    }
    @media (max-width: 374px) {
      #voice-toggle-btn {
        width: 46px;
        justify-content: center;
        padding: 9px 0;
      }
      #voice-toggle-btn .voice-label {
        display: none;
      }
    }

    #voice-toggle-btn {
      background: rgba(255, 255, 255, 0.88) !important;
      color: #111827 !important;
      border: 1px solid rgba(17, 24, 39, 0.1) !important;
      box-shadow: 0 16px 38px rgba(0, 0, 0, 0.16) !important;
      backdrop-filter: blur(24px) saturate(1.4) !important;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif !important;
      letter-spacing: 0 !important;
      font-weight: 650 !important;
      text-transform: none !important;
    }
    #voice-toggle-btn:hover {
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.2) !important;
      transform: translateY(-1px);
    }
    #voice-toggle-btn.state-listening,
    #voice-toggle-btn.state-processing,
    #voice-toggle-btn.state-speaking {
      background: rgba(10, 132, 255, 0.92) !important;
      color: #fff !important;
      border-color: transparent !important;
    }
    @media (max-width: 768px) {
      #voice-toggle-btn {
        left: 50% !important;
        right: auto !important;
        bottom: calc(var(--mobile-chat-height, 300px) + 18px + env(safe-area-inset-bottom, 0px)) !important;
        transform: translateX(-50%);
        min-width: 148px;
        min-height: 50px !important;
        justify-content: center;
        border-radius: 999px !important;
        font-size: 15px !important;
      }
      #voice-toggle-btn:hover {
        transform: translateX(-50%) translateY(-1px);
      }
      #voice-test-btn {
        display: none !important;
      }
      body:has(.terminal-panel.chat-panel.chat-collapsed) #voice-toggle-btn {
        bottom: calc(116px + env(safe-area-inset-bottom, 0px)) !important;
      }
    }`;
  document.head.appendChild(style);

  b.addEventListener('click', () => toggleVoiceMode());
  document.body.appendChild(b);
  btn = b;

  // 🔊 TEST — guaranteed-user-gesture TTS playback check
  const t = document.createElement('button');
  t.id = 'voice-test-btn';
  t.type = 'button';
  t.textContent = '🔊 TEST';
  t.style.cssText = `
    position: fixed; right: 24px; bottom: 76px; z-index: 9999;
    padding: 8px 14px; border-radius: 999px;
    background: rgba(10, 14, 20, 0.72);
    color: rgb(var(--accent-rgb, 41 211 255));
    border: 1px solid rgba(var(--accent-rgb, 41 211 255), 0.55);
    font-family: inherit; font-size: 11px; letter-spacing: 1px;
    cursor: pointer; backdrop-filter: blur(8px);`;
  t.addEventListener('click', async () => {
    dbg('testBtn.clicked');
    t.textContent = '…';
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'გამარჯობა, ეს არის ხმოვანი ტესტი.' }),
      });
      dbg('testBtn.fetch', { status: res.status, type: res.headers.get('content-type') });
      if (!res.ok) { t.textContent = '✗ ' + res.status; return; }
      const blob = await res.blob();
      dbg('testBtn.blob', { size: blob.size, type: blob.type });
      const url = URL.createObjectURL(blob);
      await playAudioUrl(url);
      URL.revokeObjectURL(url);
      t.textContent = '✓ OK';
      dbg('testBtn.played-to-end');
    } catch (e) {
      t.textContent = '✗ FAIL';
      dbg('testBtn.failed', { err: e?.name || String(e).slice(0, 100) });
    }
    setTimeout(() => { t.textContent = '🔊 TEST'; }, 3000);
  });
  document.body.appendChild(t);
}

function setButtonState(state) {
  if (!btn) return;
  btn.classList.remove('state-idle', 'state-listening', 'state-processing', 'state-speaking');
  btn.classList.add('state-' + state);
  const label = btn.querySelector('.voice-label');
  if (label) label.textContent = STATE_LABEL[state] || 'Talk';
}

export function initVoiceUI() {
  injectButton();

  // Kick off VAD model load immediately in the background so
  // the first click on the voice button is instant (no 1.5s wait).
  preWarmVAD();

  // Only drive the VOICE button when turn-based VOICE mode is the active one —
  // otherwise Gemini Live's state events would light up the VOICE button too.
  window.addEventListener('voice-state', (e) => {
    const state = e.detail || 'idle';
    setButtonState(isVoiceActive() ? state : 'idle');
    window.dispatchEvent(new CustomEvent('agent-state', { detail: STATE_TO_ORB[state] || 'idle' }));
    if (state === 'listening') {
      currentReplyLine = null; // new turn → fresh reply line
      floatingReplyBuffer = '';
      clearFloatingResponse();
    }
    if (state === 'idle' && floatingReplyBuffer) {
      showFloatingResponse(floatingReplyBuffer, { final: true });
      scheduleFloatingResponseHide();
    }
  });

  // What the user said (final confirmed)
  window.addEventListener('voice-transcript', (e) => {
    // Remove any partial-transcript placeholder first
    const existing = document.getElementById('voice-partial-line');
    if (existing) existing.remove();
    if (e.detail) addChatLine(e.detail, 'user-line');
  });

  // Live partial transcript while user is still speaking
  window.addEventListener('voice-partial', (e) => {
    const text = e.detail || '';
    if (!text) return;
    let el = document.getElementById('voice-partial-line');
    if (!el) {
      el = addChatLine('', 'user-line');
      el.id = 'voice-partial-line';
      el.style.opacity = '0.55';
      el.style.fontStyle = 'italic';
    }
    const t = el.querySelector('.msg-text');
    if (t) t.textContent = text + '…';
  });

  // The agent's reply, streamed in text chunks
  window.addEventListener('voice-response-text', (e) => {
    const chunk = e.detail || '';
    if (!chunk) return;
    floatingReplyBuffer += chunk;
    showFloatingResponse(floatingReplyBuffer);
    scheduleFloatingResponseHide();
    if (!currentReplyLine) {
      currentReplyLine = addChatLine(chunk, 'agent-line');
    } else {
      const t = currentReplyLine.querySelector('.msg-text');
      if (t) t.textContent += chunk;
    }
  });

  window.addEventListener('voice-error', (e) => {
    showNotification(e.detail || 'Voice error');
    setButtonState('idle');
  });

  // Hotkey: Cmd/Ctrl + Shift + V (ignored while typing in an input/textarea)
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      toggleVoiceMode();
    }
  });
}

export { isVoiceActive };
