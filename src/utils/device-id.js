// Stable per-device id, used to give each browser its own private agent
// session (so two phones on the same site don't share chats or hear each
// other's voice replies). Persisted in localStorage; falls back to an
// ephemeral per-load id when storage is unavailable (e.g. private mode).

const KEY = 'jarvis-device-id';
let cached = null;

export function getDeviceId() {
  if (cached) return cached;
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      localStorage.setItem(KEY, id);
    }
    cached = id;
  } catch {
    cached = 'tmp' + Math.random().toString(36).slice(2, 10);
  }
  return cached;
}
