// No-op service worker: clears any stale caches, never intercepts requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    await self.clients.claim();
  })());
});
// No 'fetch' handler → every request goes to the network, always fresh.
