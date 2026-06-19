// ── Global API Router for Vercel/Remote Hosting ──
// Intercepts and redirects fetches, SSE, and WebSockets to the remote backend if VITE_API_URL is configured.

const apiTarget = import.meta.env.VITE_API_URL;

if (apiTarget && apiTarget !== '/' && apiTarget !== window.location.origin) {
  const base = apiTarget.replace(/\/$/, '');
  
  // 1. Intercept Fetch API
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let url;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else if (input && typeof input === 'object' && input.url) {
      url = input.url;
    }

    if (url && url.startsWith('/api/')) {
      const rewritten = `${base}${url}`;
      if (typeof input === 'string' || input instanceof URL) {
        return originalFetch(rewritten, init);
      } else {
        const newRequest = new Request(rewritten, input);
        return originalFetch(newRequest, init);
      }
    }
    return originalFetch(input, init);
  };

  // 2. Intercept SSE (EventSource)
  const OriginalEventSource = window.EventSource;
  window.EventSource = function(url, options) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      url = `${base}${url}`;
    }
    return new OriginalEventSource(url, options);
  };
  window.EventSource.prototype = OriginalEventSource.prototype;
  Object.assign(window.EventSource, OriginalEventSource);

  // 3. Intercept WebSockets (ws/wss)
  const OriginalWebSocket = window.WebSocket;
  const wsBase = base.replace(/^http/, 'ws'); // maps http -> ws, https -> wss
  window.WebSocket = function(url, protocols) {
    if (typeof url === 'string' && (url.includes('/api/voice-stt') || url.includes('/api/live') || url.includes('/api/voice-stream'))) {
      const pathMatch = url.match(/\/api\/[a-zA-Z0-9\-_]+/);
      if (pathMatch) {
        url = `${wsBase}${pathMatch[0]}`;
      }
    }
    return new OriginalWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(window.WebSocket, OriginalWebSocket);
  
  console.log(`[JARVIS-PATCH] API endpoints redirected to remote backend: ${base}`);
}
