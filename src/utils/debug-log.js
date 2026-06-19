// ── Client-side debug logger ──
// Mirrors console logs to the server (/api/client-log → client-debug.log)
// so playback issues can be diagnosed without DevTools open.

export function dbg(tag, data = {}) {
  try {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    console.log(`[${timeStr}] [DBG]`, tag, data);
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: now.toISOString(), tag, ...data }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never break the app over logging
  }
}

export function initDebugLog() {
  window.addEventListener('error', (e) => {
    dbg('window.error', { msg: e.message, src: (e.filename || '').split('/').pop(), line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    dbg('unhandledrejection', { reason: String(e.reason).slice(0, 200) });
  });
  dbg('page.load', { ua: navigator.userAgent.slice(0, 90) });
}
