// ── Shared, gesture-unlocked audio player ──
// One reusable <audio> element, unlocked on the first user gesture by playing
// a silent clip. Once an element has played from a gesture, later play()
// calls on the SAME element are allowed by autoplay policy — this is the
// canonical fix for "TTS audio silently blocked".

import { dbg } from './debug-log.js';

// 0.05s of silence, 16-bit mono 8kHz WAV
const SILENT_WAV =
  'data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YVYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const player = new Audio();
player.preload = 'auto';

let unlocked = false;
let pendingPlay = null; // { url, resolve, reject } waiting for unlock

function unlock() {
  if (unlocked) return;
  player.src = SILENT_WAV;
  player.play().then(() => {
    unlocked = true;
    dbg('audio.unlocked');
    if (pendingPlay) {
      const p = pendingPlay;
      pendingPlay = null;
      startPlayback(p.url, p.resolve, p.reject);
    }
  }).catch((e) => {
    dbg('audio.unlock.failed', { err: e?.name });
  });
}

// Any real user gesture unlocks the player (capture: fires before app handlers)
['pointerdown', 'keydown', 'touchstart'].forEach((evt) =>
  window.addEventListener(evt, unlock, { capture: true })
);

function startPlayback(url, resolve, reject) {
  player.onended = () => resolve('ended');
  player.onerror = () => {
    dbg('audio.element.error', { code: player.error?.code });
    reject(new Error('media-error-' + (player.error?.code ?? '?')));
  };
  player.src = url;
  player.play().then(() => {
    dbg('audio.play.ok');
  }).catch((err) => {
    dbg('audio.play.rejected', { err: err?.name, msg: String(err?.message).slice(0, 140) });
    if (err?.name === 'NotAllowedError' && !pendingPlay) {
      // Not unlocked yet — keep it and retry on the next user gesture
      pendingPlay = { url, resolve, reject };
      dbg('audio.play.queued-until-gesture');
      return;
    }
    reject(err);
  });
}

/** Play a blob/object URL. Resolves when playback ends. */
export function playAudioUrl(url) {
  return new Promise((resolve, reject) => startPlayback(url, resolve, reject));
}

export function stopAudio() {
  try {
    pendingPlay = null;
    player.onended = null;
    player.onerror = null;
    player.pause();
    player.removeAttribute('src');
    player.load();
  } catch {
    // ignore
  }
}

export function isAudioPlaying() {
  return !player.paused && !player.ended;
}
