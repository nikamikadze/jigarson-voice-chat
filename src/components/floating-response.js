const MOBILE_QUERY = '(max-width: 768px)';
const MAX_FLOATING_CHARS = 420;
const DISMISS_DELAY = 8500;

let panel = null;
let textEl = null;
let hideTimer = null;

function isMobile() {
  return window.matchMedia?.(MOBILE_QUERY).matches;
}

function clippedText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= MAX_FLOATING_CHARS) return value;
  return value.slice(0, MAX_FLOATING_CHARS).trimEnd() + '...';
}

function ensurePanel() {
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'mobile-ai-response';
  panel.setAttribute('aria-live', 'polite');
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = `
    <div class="mobile-ai-response-inner">
      <span class="mobile-ai-response-dot"></span>
      <p class="mobile-ai-response-text"></p>
    </div>`;

  textEl = panel.querySelector('.mobile-ai-response-text');
  document.body.appendChild(panel);
  return panel;
}

export function showFloatingResponse(text, options = {}) {
  if (!isMobile()) return;

  const value = clippedText(text);
  if (!value) return;

  ensurePanel();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  textEl.textContent = value;
  panel.classList.add('visible');
  panel.classList.toggle('is-final', Boolean(options.final));
  panel.setAttribute('aria-hidden', 'false');
}

export function scheduleFloatingResponseHide(delay = DISMISS_DELAY) {
  if (!panel) return;
  if (hideTimer) clearTimeout(hideTimer);

  hideTimer = setTimeout(() => {
    panel.classList.remove('visible', 'is-final');
    panel.setAttribute('aria-hidden', 'true');
  }, delay);
}

export function clearFloatingResponse() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!panel) return;
  panel.classList.remove('visible', 'is-final');
  panel.setAttribute('aria-hidden', 'true');
  if (textEl) textEl.textContent = '';
}
