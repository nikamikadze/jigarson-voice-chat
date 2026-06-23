// ── Google Cloud Streaming STT: /api/voice-stt ──
// Browser streams PCM16 chunks while the user speaks. Google returns interim
// transcripts live, and the brain/TTS pipeline starts as soon as speech ends.

import { WebSocketServer } from 'ws';
import speech from '@google-cloud/speech';
import path from 'path';
import { appendFile } from 'fs/promises';
import { gwRequest, acceptSessionKey } from './gateway.js';
import { addVoiceHandler, removeVoiceHandler } from './sse.js';
import { deviceSessionKey } from './session-key.js';
import { ttsSentence } from './tts.js';
import { brainChat, getActiveBrain } from './brain.js';
import { googleSttAvailable, normalizeLanguage } from './stt.js';
import { formatVoicePrompt } from './assistant-guidelines.js';

function logStt(obj) {
  appendFile(path.join(process.cwd(), 'voice-stt.log'),
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n').catch(() => {});
}

function createGoogleStream({ languageCode, onData, onError }) {
  const client = new speech.SpeechClient();
  const request = {
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode,
      enableAutomaticPunctuation: true,
      useEnhanced: true,
      model: 'latest_short',
    },
    interimResults: true,
    singleUtterance: false,
  };
  return client
    .streamingRecognize(request)
    .on('error', onError)
    .on('data', onData);
}

export function initGoogleSttStream(httpServer, config = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, request) => {
    const sessionKey = config.agent?.sessionKey || 'agent:main:main';
    if (!googleSttAvailable()) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Google Cloud STT credentials missing. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path or run gcloud application-default login.',
      }));
      ws.close();
      return;
    }

    let device = null;
    try { device = new URL(request.url, 'http://x').searchParams.get('device'); } catch {}
    const voiceBase = config.voice?.sessionKey || sessionKey;
    const voiceSessionKey = deviceSessionKey(voiceBase, device, 'wv');
    acceptSessionKey(voiceSessionKey);

    let languageCode = normalizeLanguage(process.env.GOOGLE_CLOUD_STT_LANGUAGE || config.voice?.sttLanguage || 'ka-GE');
    let replyLanguage = config.voice?.replyLanguage || '';
    let state = 'idle';
    let recognizeStream = null;
    let t0 = 0;
    let finalTranscript = '';
    let partialTranscript = '';
    let pipelineStarted = false;
    let finalFallbackTimer = null;
    const timing = { sttMs: 0, firstTokenMs: 0, firstAudioMs: 0, totalMs: 0 };

    console.log(`[GOOGLE-STT] Browser connected, lang=${languageCode}`);

    function resetTiming() {
      timing.sttMs = 0;
      timing.firstTokenMs = 0;
      timing.firstAudioMs = 0;
      timing.totalMs = 0;
    }

    function closeRecognizeStream() {
      if (!recognizeStream) return;
      try { recognizeStream.end(); } catch {}
      recognizeStream = null;
    }

    function startRecognizeStream() {
      closeRecognizeStream();
      recognizeStream = createGoogleStream({
        languageCode,
        onData: (data) => {
          const result = data.results?.[0];
          const text = result?.alternatives?.[0]?.transcript?.trim() || '';
          if (!text) return;

          if (result.isFinal) finalTranscript = text;
          else partialTranscript = text;

          const elapsed = t0 ? Date.now() - t0 : 0;
          logStt({ ev: result.isFinal ? 'final' : 'partial', text, ms: elapsed });
          try { ws.send(JSON.stringify({ type: 'partial', text })); } catch {}

          if (state === 'processing' && result.isFinal) {
            runBrainPipeline(finalTranscript, elapsed);
          }
        },
        onError: (err) => {
          console.error('[GOOGLE-STT] upstream error:', err.message);
          logStt({ ev: 'upstream-error', error: err.message });
          if (state === 'recording' || state === 'processing') {
            try { ws.send(JSON.stringify({ type: 'error', message: 'Google STT: ' + err.message })); } catch {}
          }
        },
      });
    }

    function scheduleFallback() {
      clearTimeout(finalFallbackTimer);
      finalFallbackTimer = setTimeout(() => {
        if (state !== 'processing' || pipelineStarted) return;
        const transcript = finalTranscript || partialTranscript;
        const elapsed = Date.now() - t0;
        runBrainPipeline(transcript, elapsed);
      }, 700);
    }

    ws.on('message', async (rawData, isBinary) => {
      const isMsgBinary = (isBinary === true) || (Buffer.isBuffer(rawData) && rawData[0] !== 123);

      if (isMsgBinary) {
        if (state === 'recording' && recognizeStream) {
          try { recognizeStream.write({ audioContent: Buffer.from(rawData) }); } catch {}
        }
        return;
      }

      let msg;
      try { msg = JSON.parse(rawData.toString()); } catch {
        try { ws.send(JSON.stringify({ type: 'error', message: 'Malformed JSON' })); } catch {}
        return;
      }

      if (msg.type === 'start') {
        state = 'recording';
        pipelineStarted = false;
        finalTranscript = '';
        partialTranscript = '';
        t0 = Date.now();
        resetTiming();
        if (msg.language) languageCode = normalizeLanguage(msg.language);
        if (msg.replyLanguage) replyLanguage = msg.replyLanguage;
        logStt({ ev: 'start', lang: languageCode });
        console.log(`[GOOGLE-STT] Recording started, lang=${languageCode}`);
        startRecognizeStream();
        try { ws.send(JSON.stringify({ type: 'stt-ready' })); } catch {}
        return;
      }

      if (msg.type === 'end') {
        if (state !== 'recording') return;
        state = 'processing';
        const elapsed = Date.now() - t0;
        console.log(`[GOOGLE-STT] Speech ended after ${elapsed}ms, partial="${partialTranscript}", final="${finalTranscript}"`);
        logStt({ ev: 'end', ms: elapsed, partialSoFar: partialTranscript, finalSoFar: finalTranscript });
        closeRecognizeStream();
        if (finalTranscript) runBrainPipeline(finalTranscript, elapsed);
        else scheduleFallback();
      }
    });

    ws.on('close', () => {
      console.log('[GOOGLE-STT] Browser disconnected');
      clearTimeout(finalFallbackTimer);
      closeRecognizeStream();
      state = 'idle';
    });

    async function runBrainPipeline(transcript, sttElapsed) {
      if (pipelineStarted) return;
      pipelineStarted = true;
      state = 'done';
      clearTimeout(finalFallbackTimer);
      closeRecognizeStream();
      timing.sttMs = sttElapsed || (Date.now() - t0);

      if (!transcript || !transcript.trim()) {
        try { ws.send(JSON.stringify({ type: 'error', message: 'No speech detected' })); } catch {}
        logStt({ ev: 'no-speech' });
        return;
      }

      const tSpeechEnd = Date.now();
      const elapsedSinceEnd = () => `${Date.now() - tSpeechEnd}ms`;
      console.log(`[GOOGLE-STT] Transcript: "${transcript}"`);
      logStt({ ev: 'transcript', text: transcript, sttMs: timing.sttMs });
      try { ws.send(JSON.stringify({ type: 'transcript', text: transcript })); } catch {}

      const idempotencyKey = `voice-google-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const brain = getActiveBrain();
      console.log(`[PERF] Active brain: ${brain} (+${elapsedSinceEnd()})`);

      let spokenLen = 0;
      let sentencesSpoken = 0;
      let ttsSeq = Promise.resolve();
      const SENTENCE_RE = /[^.!?。！？\n]*[.!?。！？\n]+/g;

      const speakChunk = (chunkText) => {
        const clean = chunkText.trim();
        if (!clean) return;
        sentencesSpoken++;
        const synthP = ttsSentence(clean)
          .then((r) => ({ r, clean }))
          .catch((err) => ({ err, clean }));
        ttsSeq = ttsSeq.then(async () => {
          const result = await synthP;
          if (result.err) {
            try { ws.send(JSON.stringify({ type: 'tts-error', message: result.err.message })); } catch {}
            return;
          }
          const { r } = result;
          if (r?.buffer?.length) {
            if (!timing.firstAudioMs) timing.firstAudioMs = Date.now() - t0;
            try {
              ws.send(JSON.stringify({
                type: 'tts-chunk',
                audio: r.buffer.toString('base64'),
                contentType: r.contentType,
                text: result.clean,
              }));
            } catch {}
          }
        });
      };

      const flushSentences = (fullText, force) => {
        let pending = fullText.slice(spokenLen);
        if (!pending) return;
        if (force) { spokenLen = fullText.length; speakChunk(pending); return; }
        while (true) {
          pending = fullText.slice(spokenLen);
          if (!pending) break;
          const sMatch = /^[^.!?。！？\n]*[.!?。！？\n]+/.exec(pending);
          if (sMatch) {
            spokenLen += sMatch[0].length;
            speakChunk(sMatch[0]);
            continue;
          }
          const cMatch = /^[^.!?。！？\n,，;；]{10,}?[,，;；]/.exec(pending);
          if (cMatch) {
            spokenLen += cMatch[0].length;
            speakChunk(cMatch[0]);
            continue;
          }
          break;
        }
      };

      try {
        let responseText = '';
        const outgoing = formatVoicePrompt(transcript, replyLanguage);

        if (brain === 'openclaw') {
          responseText = await new Promise((resolve, reject) => {
            let fullText = '';
            let currentRunId = null;
            let finished = false;
            let handler;
            const finish = async () => {
              if (finished) return;
              finished = true;
              removeVoiceHandler(handler);
              flushSentences(fullText, true);
              await ttsSeq;
              timing.totalMs = Date.now() - t0;
              logStt({ ev: 'timing', ...timing });
              try { ws.send(JSON.stringify({ type: 'timing', ...timing })); } catch {}
              try { ws.send(JSON.stringify({ type: 'done', fullText })); } catch {}
              resolve(fullText);
            };
            handler = (payload) => {
              if (payload.sessionKey && payload.sessionKey !== voiceSessionKey) return;
              const content = payload.message?.content;
              const text = Array.isArray(content)
                ? content.filter((x) => x.type === 'text').map((x) => x.text).join('')
                : (typeof content === 'string' ? content : '');
              if (!currentRunId && payload.runId) currentRunId = payload.runId;
              if (currentRunId && payload.runId !== currentRunId) return;
              if (payload.state === 'streaming' || payload.state === 'delta' || payload.state === 'final') {
                const newChars = text.slice(fullText.length);
                fullText = text;
                if (newChars) {
                  if (!timing.firstTokenMs) timing.firstTokenMs = Date.now() - t0;
                  try { ws.send(JSON.stringify({ type: 'text-chunk', text: newChars })); } catch {}
                }
                flushSentences(fullText, false);
              }
              if (payload.state === 'final' || payload.state === 'aborted') finish();
            };
            addVoiceHandler(handler);
            gwRequest('chat.send', { message: outgoing, sessionKey: voiceSessionKey, idempotencyKey, deliver: false })
              .catch((err) => { removeVoiceHandler(handler); reject(err); });
            setTimeout(finish, 60000);
          });
        } else {
          let fullText = '';
          responseText = await brainChat({
            user: outgoing,
            onToken: (token) => {
              fullText += token;
              if (!timing.firstTokenMs) timing.firstTokenMs = Date.now() - t0;
              try { ws.send(JSON.stringify({ type: 'text-chunk', text: token })); } catch {}
              flushSentences(fullText, false);
            },
          });
          flushSentences(responseText || fullText, true);
          await ttsSeq;
          timing.totalMs = Date.now() - t0;
          logStt({ ev: 'timing', ...timing });
          try {
            ws.send(JSON.stringify({ type: 'timing', ...timing }));
            ws.send(JSON.stringify({ type: 'done', fullText: responseText }));
          } catch {}
        }
      } catch (err) {
        console.error('[GOOGLE-STT] Brain/TTS error:', err.message);
        try { ws.send(JSON.stringify({ type: 'error', message: err.message })); } catch {}
      }
    }
  });

  return wss;
}
