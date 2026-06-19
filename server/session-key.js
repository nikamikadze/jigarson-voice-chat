// ── Per-device session keys ──
// Each browser gets its own private OpenClaw session by deriving a session key
// from a base key + a stable per-device id. Without a device id we fall back to
// the base key (legacy / single-session behaviour).

export function deviceSessionKey(baseKey, device, tag = 'web') {
  if (!device) return baseKey;
  // OpenClaw lowercases session keys, so normalise here too — otherwise the
  // key we register/send never matches the key echoed back on chat events.
  const safe = String(device).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24).toLowerCase();
  if (!safe) return baseKey;
  const idx = baseKey.lastIndexOf(':');
  const prefix = idx >= 0 ? baseKey.slice(0, idx) : baseKey;
  return `${prefix}:${tag}-${safe}`;
}
