// ── Gemini Live Streaming STT: /api/voice-stt ──
// Streams PCM16 audio to Gemini Live in real-time while the user speaks.
// Gemini emits inputTranscript events *during* speech — so by the time
// VAD fires onSpeechEnd the transcript is already assembled.
// Final transcript goes to OpenClaw gateway (same as voice-stream.js).
// This eliminates the ~2.3s post-speech STT wait.

import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { appendFile } from 'fs/promises';
import { gwRequest } from './gateway.js';
import { addVoiceHandler, removeVoiceHandler } from './sse.js';
import { ttsSentence } from './tts.js';
import { brainChat, getActiveBrain } from './brain.js';

const GEMINI_LIVE_URL = (key) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

// Sample rate the browser sends us (matches voice.js downsampleToPCM16)
const SEND_SAMPLE_RATE = 16000;

// Normalize language name → BCP-47 code for Gemini Live
const LANG_MAP = {
  georgian: 'ka-GE', english: 'en-US', russian: 'ru-RU',
  french: 'fr-FR', german: 'de-DE', spanish: 'es-ES',
};

function logStt(obj) {
  appendFile(path.join(process.cwd(), 'voice-stt.log'),
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n').catch(() => {});
}

export function initGeminiSttStream(httpServer, config = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      ws.send(JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY not set on server' }));
      ws.close();
      return;
    }

    const sessionKey = config.agent?.sessionKey || 'agent:main:main';
    const voiceSessionKey = config.voice?.sessionKey || sessionKey;
    const sttModel = config.voice?.sttModel || process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
    const rawLang = config.voice?.sttLanguage || 'ka-GE';
    let sttLanguage = LANG_MAP[rawLang.toLowerCase()] || rawLang;
    let replyLanguage = config.voice?.replyLanguage || '';

    console.log(`[STT-STREAM] Browser connected, model=${sttModel}, lang=${sttLanguage}`);

    // ── State ──
    let state = 'idle'; // idle | recording | processing | done
    let partialTranscript = '';
    let t0 = 0;
    const timing = { sttMs: 0, firstTokenMs: 0, firstAudioMs: 0, totalMs: 0 };

    // ── Gemini upstream management ──
    // We open a fresh Gemini connection per voice turn to avoid state issues.
    let upstream = null;
    let geminiReady = false;
    let pendingChunks = []; // buffer chunks that arrive before Gemini is ready

    function openGeminiUpstream() {
      if (upstream && upstream.readyState <= WebSocket.OPEN) {
        try { upstream.close(); } catch {}
      }
      geminiReady = false;
      pendingChunks = [];

      upstream = new WebSocket(GEMINI_LIVE_URL(key));

      upstream.on('open', () => {
        const setup = {
          setup: {
            model: `models/${sttModel}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { languageCode: sttLanguage },
            },
            // Request streaming transcription of user audio input.
            // These arrive as serverContent.inputTranscription regardless of response modality.
            inputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: 'Transcribe the user speech exactly. Be brief.' }],
            },
          },
        };
        upstream.send(JSON.stringify(setup));
        console.log(`[STT-STREAM] Gemini upstream opened & setup sent (${sttModel})`);
      });

      upstream.on('message', async (raw) => {
        const text = raw.toString();
        let msg;
        try { msg = JSON.parse(text); } catch { return; }

        // Suppress noisy audio chunk logging — only log non-audio messages
        const isAudioChunk = text.includes('"mimeType":"audio/pcm') || text.includes('"inlineData"');
        if (!isAudioChunk) {
          console.log('[STT-STREAM] ← Gemini:', text.slice(0, 300));
        }

        // ── Setup complete ──
        if ('setupComplete' in msg) {
          geminiReady = true;
          console.log(`[STT-STREAM] Gemini ready, flushing ${pendingChunks.length} pending chunks`);
          for (const chunk of pendingChunks) _sendAudioChunk(chunk);
          pendingChunks = [];
          try { ws.send(JSON.stringify({ type: 'stt-ready' })); } catch {}
          return;
        }

        const sc = msg.serverContent;

        // ── Input transcript — FIRE IMMEDIATELY on first event ──
        // This arrives ~178ms after turnComplete is sent (vs 5s to wait for turnComplete).
        // We close the Gemini upstream right after to stop it generating audio.
        const inTrans = sc?.inputTranscription?.text
          || sc?.inputTranscriptionChunks?.[0]?.text;

        if (inTrans) {
          partialTranscript = inTrans;
          const elapsed = t0 ? Date.now() - t0 : 0;
          console.log(`[STT-STREAM] Got transcript +${elapsed}ms: "${inTrans}"`);
          logStt({ ev: 'transcript-event', text: inTrans, ms: elapsed });
          try { ws.send(JSON.stringify({ type: 'partial', text: inTrans })); } catch {}

          // Early pipeline: mid-speech partial contains a complete sentence — don't wait for speech end
          const hasSentenceEnd = /[.!?।।\n]/.test(inTrans);
          if (state === 'recording' && hasSentenceEnd && inTrans.trim().length >= 8) {
            console.log(`[STT-STREAM] Mid-speech sentence complete — firing pipeline early (+${elapsed}ms)`);
            state = 'processing';
            timing.sttMs = elapsed;
            try { upstream.close(); } catch {}
            await runBrainPipeline(inTrans);
            return;
          }

          // Post-speech: fire immediately on first transcript event (don't wait for turnComplete)
          if (state === 'processing') {
            timing.sttMs = elapsed;
            try { upstream.close(); } catch {}
            await runBrainPipeline(inTrans);
          }
        }

        // turnComplete is now just a fallback signal (in case no inputTranscription fires)
        if (sc?.turnComplete && state === 'processing') {
          const elapsed = t0 ? Date.now() - t0 : 0;
          timing.sttMs = elapsed;
          console.log(`[STT-STREAM] turnComplete fallback +${elapsed}ms, transcript: "${partialTranscript}"`);
          try { upstream.close(); } catch {}
          await runBrainPipeline(partialTranscript);
        }
      });

      upstream.on('error', (err) => {
        console.error('[STT-STREAM] Gemini upstream error:', err.message);
        logStt({ ev: 'upstream-error', err: err.message });
        geminiReady = false;
      });

      upstream.on('close', (code, reason) => {
        const r = reason?.toString()?.slice(0, 200);
        console.log(`[STT-STREAM] Gemini upstream closed: ${code} ${r}`);
        geminiReady = false;
        // If we closed mid-recording, fall back via timeout
      });
    }

    // Open the first upstream right away (so it's ready before speech)
    openGeminiUpstream();

    // Helper: send one PCM16 chunk to Gemini Live
    function _sendAudioChunk(pcm16Buf) {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      const b64 = pcm16Buf.toString('base64');
      upstream.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: b64,
            mimeType: `audio/pcm;rate=${SEND_SAMPLE_RATE}`,
          },
        },
      }));
    }

    // ── Browser → server messages ──
    ws.on('message', async (rawData, isBinary) => {
      const isMsgBinary = (isBinary === true) || (Buffer.isBuffer(rawData) && rawData[0] !== 123);

      if (isMsgBinary) {
        if (state !== 'recording') return;
        const chunk = Buffer.from(rawData);
        if (geminiReady) {
          _sendAudioChunk(chunk);
        } else {
          pendingChunks.push(chunk);
        }
        return;
      }

      let msg;
      try { msg = JSON.parse(rawData.toString()); } catch {
        try { ws.send(JSON.stringify({ type: 'error', message: 'Malformed JSON' })); } catch {}
        return;
      }

      if (msg.type === 'start') {
        console.log('[STT-STREAM] Recording started');
        state = 'recording';
        partialTranscript = '';
        t0 = Date.now();
        timing.sttMs = 0; timing.firstTokenMs = 0; timing.firstAudioMs = 0; timing.totalMs = 0;
        if (msg.language) sttLanguage = LANG_MAP[msg.language.toLowerCase()] || msg.language;
        if (msg.replyLanguage) replyLanguage = msg.replyLanguage;
        logStt({ ev: 'start', lang: sttLanguage });

        // If Gemini upstream is dead (closed after previous turn), reopen it
        if (!upstream || upstream.readyState > WebSocket.OPEN) {
          console.log('[STT-STREAM] Reopening Gemini upstream for new turn');
          openGeminiUpstream();
        }

      } else if (msg.type === 'end') {
        if (state !== 'recording') return;
        state = 'processing';
        const elapsed = Date.now() - t0;
        console.log(`[STT-STREAM] Speech ended after ${elapsed}ms, partialSoFar="${partialTranscript}"`);
        logStt({ ev: 'end', ms: elapsed, partialSoFar: partialTranscript });

        // If we already have the transcript (arrived live during speech), run the pipeline immediately
        if (partialTranscript && partialTranscript.trim()) {
          timing.sttMs = elapsed;
          try { upstream.close(); } catch {}
          await runBrainPipeline(partialTranscript);
          return;
        }

        // Signal Gemini that the user's turn is done → triggers final inputTranscription + turnComplete
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({
            clientContent: { turns: [], turnComplete: true },
          }));
          console.log('[STT-STREAM] Sent turnComplete to Gemini');
        } else {
          console.warn('[STT-STREAM] Gemini upstream not open at end — using partial or fallback STT');
        }

        // Fallback: if Gemini never fires turnComplete (e.g. it was closed),
        // use whatever partial we have after 3.5s
        setTimeout(async () => {
          if (state === 'processing') {
            console.log('[STT-STREAM] Fallback timeout — using partial transcript');
            await runBrainPipeline(partialTranscript);
          }
        }, 3500);
      }
    });

    ws.on('close', () => {
      console.log('[STT-STREAM] Browser disconnected');
      state = 'idle';
      if (upstream) { try { upstream.close(); } catch {} upstream = null; }
    });

    ws.on('error', () => {
      if (upstream) { try { upstream.close(); } catch {} upstream = null; }
    });

    // ── Brain + TTS pipeline (identical to voice-stream.js) ──
    async function runBrainPipeline(transcript) {
      if (state !== 'processing') return; // guard double-fire
      state = 'done';

      const t_speech_end = Date.now();
      const elapsedSinceEnd = () => `${Date.now() - t_speech_end}ms`;
      console.log(`[PERF] Speech end. Transcript: "${transcript}"`);

      // Reopen Gemini for the NEXT turn immediately after this one ends
      // (so it's warm before the user speaks again)
      try { if (upstream) upstream.close(); } catch {}
      upstream = null;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log('[STT-STREAM] Pre-warming Gemini for next turn');
          openGeminiUpstream();
        }
      }, 500);

      if (!transcript || !transcript.trim()) {
        try { ws.send(JSON.stringify({ type: 'error', message: 'No speech detected' })); } catch {}
        logStt({ ev: 'no-speech' });
        return;
      }

      console.log(`[STT-STREAM] Transcript: "${transcript}"`);
      logStt({ ev: 'transcript', text: transcript, sttMs: timing.sttMs });
      try { ws.send(JSON.stringify({ type: 'transcript', text: transcript })); } catch {}

      const idempotencyKey = `voice-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const brain = getActiveBrain();
      console.log(`[PERF] Active brain: ${brain} (+${elapsedSinceEnd()})`);

      // TTS streaming pipeline (identical to voice-stream.js)
      let spokenLen = 0;
      let sentencesSpoken = 0;
      let ttsSeq = Promise.resolve();
      const SENTENCE_RE = /[^.!?。！？\n]*[.!?。！？\n]+/g;

      const speakChunk = (chunkText) => {
        const clean = chunkText.trim();
        if (!clean) return;
        sentencesSpoken++;
        const index = sentencesSpoken;
        console.log(`[PERF] Queueing sentence #${index} for TTS: "${clean}" (+${elapsedSinceEnd()})`);

        ttsSeq = ttsSeq.then(async () => {
          const t_tts_start = Date.now();
          console.log(`[PERF] Synthesizing sentence #${index} via Cartesia...`);
          try {
            const r = await ttsSentence(clean);
            if (r && r.buffer && r.buffer.length) {
              const tts_duration = Date.now() - t_tts_start;
              console.log(`[PERF] TTS finished for sentence #${index} in ${tts_duration}ms (+${elapsedSinceEnd()})`);
              if (!timing.firstAudioMs) timing.firstAudioMs = Date.now() - t0;
              try {
                ws.send(JSON.stringify({
                  type: 'tts-chunk', audio: r.buffer.toString('base64'),
                  contentType: r.contentType, text: clean,
                }));
              } catch {}
            }
          } catch (err) {
            console.error(`[PERF] TTS failed for sentence #${index}:`, err.message);
            try { ws.send(JSON.stringify({ type: 'tts-error', message: err.message })); } catch {}
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
        spokenLen += matches.join('').length;
        for (const s of matches) speakChunk(s);
      };

      let responseText = '';

      try {
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

              // Wait for all queued TTS sentences to be synthesized and sent
              await ttsSeq;

              timing.totalMs = Date.now() - t0;
              logStt({ ev: 'timing', ...timing });
              console.log(`[PERF] Request finished. timing stt=${timing.sttMs}ms llm1stToken=${timing.firstTokenMs}ms 1stAudio=${timing.firstAudioMs}ms total=${timing.totalMs}ms (+${elapsedSinceEnd()})`);
              try { ws.send(JSON.stringify({ type: 'timing', ...timing })); } catch {}
              try { ws.send(JSON.stringify({ type: 'done', fullText: fullText })); } catch {}
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
                  if (!timing.firstTokenMs) {
                    timing.firstTokenMs = Date.now() - t0;
                    console.log(`[PERF] First LLM token received: "${newChars.replace(/\n/g, '\\n')}" (+${elapsedSinceEnd()})`);
                  }
                  try { ws.send(JSON.stringify({ type: 'text-chunk', text: newChars })); } catch {}
                }
                flushSentences(fullText, false);
              }
              if (payload.state === 'final' || payload.state === 'aborted') {
                console.log(`[PERF] LLM finished generating response. State: ${payload.state} (+${elapsedSinceEnd()})`);
                finish();
              }
            };

            addVoiceHandler(handler);
            const brevity = 'Reply in short, natural spoken sentences. Lead with the key point first. No markdown, lists, emojis, generic follow-up offers, readiness talk, or repeated tell-me-what-to-do endings. Ask one clarifying question only if necessary.';
            const outgoing = replyLanguage
              ? `${transcript}\n\n(${brevity} Reply only in ${replyLanguage}.)`
              : `${transcript}\n\n(${brevity})`;
            
            console.log(`[PERF] Sending prompt to gateway... (+${elapsedSinceEnd()})`);
            gwRequest('chat.send', { message: outgoing, sessionKey: voiceSessionKey, idempotencyKey, deliver: false })
              .catch((err) => { removeVoiceHandler(handler); reject(err); });
            setTimeout(finish, 60000);
          });
        } else {
          const brevity = 'Reply in short, natural spoken sentences. Lead with the key point first. No markdown, lists, emojis, generic follow-up offers, readiness talk, or repeated tell-me-what-to-do endings. Ask one clarifying question only if necessary.';
          const userMsg = replyLanguage
            ? `${transcript}\n\n(${brevity} Reply only in ${replyLanguage}.)`
            : `${transcript}\n\n(${brevity})`;
          let fullText = '';
          
          console.log(`[PERF] Sending prompt to direct brain (${brain})... (+${elapsedSinceEnd()})`);
          responseText = await brainChat({
            user: userMsg,
            onToken: (token) => {
              fullText += token;
              if (!timing.firstTokenMs) {
                timing.firstTokenMs = Date.now() - t0;
                console.log(`[PERF] First LLM token received: "${token.replace(/\n/g, '\\n')}" (+${elapsedSinceEnd()})`);
              }
              try { ws.send(JSON.stringify({ type: 'text-chunk', text: token })); } catch {}
              flushSentences(fullText, false);
            },
          });
          flushSentences(responseText || fullText, true);
          await ttsSeq;
        }

        if (brain !== 'openclaw') {
          timing.totalMs = Date.now() - t0;
          logStt({ ev: 'timing', ...timing });
          console.log(`[PERF] Request finished. timing stt=${timing.sttMs}ms llm1stToken=${timing.firstTokenMs}ms 1stAudio=${timing.firstAudioMs}ms total=${timing.totalMs}ms (+${elapsedSinceEnd()})`);
          try {
            ws.send(JSON.stringify({ type: 'timing', ...timing }));
            ws.send(JSON.stringify({ type: 'done', fullText: responseText }));
          } catch {}
        }
      } catch (chatErr) {
        console.error('[STT-STREAM] Brain/TTS error:', chatErr);
        try { ws.send(JSON.stringify({ type: 'error', message: chatErr.message })); } catch {}
      }
    }
  });

  return wss;
}
