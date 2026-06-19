// ── Voice Chat Route: /api/voice ──
// Pipeline: STT → brain (openclaw/openai/deepseek) → streaming TTS.

import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { unlink, readFile, appendFile } from 'fs/promises';
import { gwRequest } from '../gateway.js';
import { addVoiceHandler, removeVoiceHandler } from '../sse.js';
import { ttsSentence } from '../tts.js';
import { transcribe } from '../stt.js';
import { brainChat, getActiveBrain } from '../brain.js';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

// Append STT outcomes to voice-debug.log so failures are visible.
function logVoice(obj) {
  appendFile(path.join(process.cwd(), 'voice-debug.log'),
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n').catch(() => {});
}

// 訊息計數（共用）
let msgCountToday = 0;
let msgCountDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

router.post('/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'Transfer-Encoding': 'chunked',
  });

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const audioPath = req.file.path;

  // ── latency instrumentation (ms from request arrival) ──
  const t0 = Date.now();
  const timing = { sttMs: 0, firstTokenMs: 0, firstAudioMs: 0, totalMs: 0 };
  logVoice({ ev: 'request', mime: req.file?.mimetype || '', bytes: req.file?.size || 0 });

  try {
    const voiceCfg = req.app.locals.voice || {};
    const sttLang = process.env.GEMINI_STT_LANG || voiceCfg.sttLanguage || '';
    const replyLang = voiceCfg.replyLanguage || '';
    const audioBytes = await readFile(audioPath);
    let transcript = '';
    try {
      const r = await transcribe({ buffer: audioBytes, path: audioPath, mimeType: req.file.mimetype || 'audio/wav', language: sttLang });
      transcript = r.text;
      timing.sttMs = Date.now() - t0;
      logVoice({ ev: 'stt', ok: true, engine: r.engine, len: (transcript || '').length, bytes: audioBytes.length, ms: timing.sttMs });
    } catch (sttErr) {
      logVoice({ ev: 'stt', ok: false, error: (sttErr.message || String(sttErr)).slice(0, 300) });
      console.error('[VOICE] STT failed:', sttErr.message);
      send({ type: 'error', message: 'STT: ' + sttErr.message }); send({ type: 'done' }); res.end(); return;
    }
    if (!transcript) { send({ type: 'error', message: 'no speech detected' }); send({ type: 'done' }); res.end(); return; }

    send({ type: 'transcript', text: transcript });
    console.log(`[VOICE] 轉錄: "${transcript}"`);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (today !== msgCountDate) { msgCountToday = 0; msgCountDate = today; }
    msgCountToday++;

    const idempotencyKey = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const brain = getActiveBrain();
    console.log(`[VOICE] brain=${brain}`);

    // ── Shared TTS streaming helpers ──────────────────────────────────────────
    // Used by both gateway path and direct-brain path. Each completed sentence
    // is synthesized in parallel and emitted in order, so playback starts fast.
    let spokenLen = 0;
    let sentencesSpoken = 0;
    let ttsSeq    = Promise.resolve();
    const SENTENCE_RE = /[^.!?。！？\n]*[.!?。！？\n]+/g;

    const speakChunk = (chunkText) => {
      const clean = chunkText.trim();
      if (!clean) return;
      sentencesSpoken++;
      ttsSeq = ttsSeq.then(async () => {
        try {
          const r = await ttsSentence(clean);
          if (r && r.buffer && r.buffer.length) {
            if (!timing.firstAudioMs) timing.firstAudioMs = Date.now() - t0;
            send({ type: 'tts-chunk', audio: r.buffer.toString('base64'), contentType: r.contentType, text: clean });
          }
        } catch (err) {
          console.error('[VOICE] TTS 失敗:', err.message);
          send({ type: 'tts-error', message: err.message });
        }
      });
    };

    const flushSentences = (fullText, force) => {
      const pending = fullText.slice(spokenLen);
      if (!pending) return;
      if (force) { spokenLen = fullText.length; speakChunk(pending); return; }
      if (spokenLen === 0 && !/[.!?。！？\n]/.test(pending)) {
        const m = /^[^,，;；]{24,}?[,，;；]/.exec(pending);
        if (m) { spokenLen += m[0].length; speakChunk(m[0]); }
        return;
      }
      SENTENCE_RE.lastIndex = 0;
      const matches = pending.match(SENTENCE_RE);
      if (!matches) return;
      const consumed = matches.join('').length;
      spokenLen += consumed;
      for (const s of matches) speakChunk(s);
    };

    let responseText;

    if (brain === 'openclaw') {
      // ── Gateway path (original behavior) ────────────────────────────────────
      responseText = await new Promise((resolve, reject) => {
        let fullText = '';
        let currentRunId = null;
        let finished = false;
        let handler;

        const finish = async () => {
          if (finished) return;
          finished = true;
          if (handler) removeVoiceHandler(handler);
          flushSentences(fullText, true);
          await ttsSeq;
          resolve(fullText);
        };

        handler = (payload) => {
          const text = (() => {
            if (!payload.message?.content) return '';
            const c = payload.message.content;
            if (Array.isArray(c)) return c.filter(x => x.type === 'text').map(x => x.text).join('');
            return typeof c === 'string' ? c : '';
          })();

          if (!currentRunId && payload.runId) currentRunId = payload.runId;
          if (currentRunId && payload.runId !== currentRunId) return;

          if (payload.state === 'streaming' || payload.state === 'delta' || payload.state === 'final') {
            const newChars = text.slice(fullText.length);
            fullText = text;
            if (newChars) {
              if (!timing.firstTokenMs) timing.firstTokenMs = Date.now() - t0;
              send({ type: 'text-chunk', text: newChars });
            }
            flushSentences(fullText, false);
          }
          if (payload.state === 'final' || payload.state === 'aborted') finish();
        };

        addVoiceHandler(handler);

        const brevity = 'Reply in short, natural spoken sentences. Lead with the key point first. No markdown, lists, emojis, generic follow-up offers, readiness talk, or repeated tell-me-what-to-do endings. Ask one clarifying question only if necessary.';
        const outgoing = replyLang
          ? `${transcript}\n\n(${brevity} Reply only in ${replyLang}.)`
          : `${transcript}\n\n(${brevity})`;

        gwRequest('chat.send', {
          message: outgoing, sessionKey: req.app.locals.voiceSessionKey || req.app.locals.sessionKey,
          idempotencyKey, deliver: false,
        }).catch((err) => { if (handler) removeVoiceHandler(handler); reject(err); });

        setTimeout(finish, 60000);
      });

    } else {
      // ── Direct brain path (openai / deepseek) ───────────────────────────────
      const brevity = 'Reply in short, natural spoken sentences. Lead with the key point first. No markdown, lists, emojis, generic follow-up offers, readiness talk, or repeated tell-me-what-to-do endings. Ask one clarifying question only if necessary.';
      const userMsg = replyLang
        ? `${transcript}\n\n(${brevity} Reply only in ${replyLang}.)`
        : `${transcript}\n\n(${brevity})`;

      let fullText = '';
      responseText = await brainChat({
        user: userMsg,
        onToken: (token) => {
          fullText += token;
          if (!timing.firstTokenMs) timing.firstTokenMs = Date.now() - t0;
          send({ type: 'text-chunk', text: token });
          flushSentences(fullText, false);
        },
      });
      flushSentences(responseText || fullText, true);
      await ttsSeq;
    }

    timing.totalMs = Date.now() - t0;
    logVoice({ ev: 'timing', ...timing });
    console.log(`[VOICE] timing  stt=${timing.sttMs}ms  llm1stToken=${timing.firstTokenMs}ms  1stAudio=${timing.firstAudioMs}ms  total=${timing.totalMs}ms`);
    send({ type: 'timing', ...timing });
    send({ type: 'done', fullText: responseText });
  } catch (err) {
    console.error('[VOICE] 錯誤:', err);
    send({ type: 'error', message: err.message });
  } finally {
    try { await unlink(audioPath); } catch {}
    res.end();
  }
});

export default router;
