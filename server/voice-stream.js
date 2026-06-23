// ── Voice Stream WebSocket Route: /api/voice-stream ──
// Pipeline: WebSocket PCM16 upload → final WAV header compilation → STT → brain → streaming TTS.

import { WebSocketServer } from 'ws';
import path from 'path';
import { appendFile } from 'fs/promises';
import { gwRequest, acceptSessionKey } from './gateway.js';
import { addVoiceHandler, removeVoiceHandler } from './sse.js';
import { ttsSentence } from './tts.js';
import { transcribe } from './stt.js';
import { deviceSessionKey } from './session-key.js';
import { brainChat, getActiveBrain } from './brain.js';
import { formatVoicePrompt } from './assistant-guidelines.js';

function logVoice(obj) {
  appendFile(path.join(process.cwd(), 'voice-debug.log'),
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n').catch(() => {});
}

// Wrap raw 16kHz PCM mono in a minimal WAV container
function pcm16ToWav(pcmBuffer, sampleRate = 16000) {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export function initVoiceStream(httpServer, config = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, request) => {
    console.log('[VOICE-STREAM] Browser connected');
    let pcmBuffers = [];
    let state = 'idle'; // 'idle' | 'recording' | 'processing'
    let sttLanguage = config.voice?.sttLanguage || '';
    let replyLanguage = config.voice?.replyLanguage || '';
    const sessionKey = config.agent?.sessionKey || 'agent:main:main';
    // Per-device private voice session (so two phones never cross-talk).
    let device = null;
    try { device = new URL(request.url, 'http://x').searchParams.get('device'); } catch {}
    const voiceBase = config.voice?.sessionKey || sessionKey;
    const voiceSessionKey = deviceSessionKey(voiceBase, device, 'wv');
    acceptSessionKey(voiceSessionKey);

    let chunkCount = 0;

    ws.on('message', async (rawData, isBinary) => {
      const isMsgBinary = (isBinary === true) || (Buffer.isBuffer(rawData) && rawData[0] !== 123); // 123 is '{'

      if (isMsgBinary) {
        if (state === 'recording') {
          pcmBuffers.push(Buffer.from(rawData));
          chunkCount++;
          if (chunkCount % 5 === 0) {
            const totalBytes = pcmBuffers.reduce((sum, buf) => sum + buf.length, 0);
            console.log(`[VOICE-STREAM] Streaming chunk #${chunkCount} (${rawData.length} bytes | Accumulated: ${totalBytes} bytes)`);
          }
        }
        return;
      }

      // JSON messages
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.type === 'start') {
          console.log('[VOICE-STREAM] Start recording');
          pcmBuffers = [];
          chunkCount = 0;
          state = 'recording';
          if (msg.language) sttLanguage = msg.language;
          if (msg.replyLanguage) replyLanguage = msg.replyLanguage;
          logVoice({ ev: 'stream-start', language: sttLanguage });
        } else if (msg.type === 'end') {
          if (state !== 'recording') return;
          state = 'processing';
          console.log('[VOICE-STREAM] End recording, transcribing...');

          const t0 = Date.now();
          const timing = { sttMs: 0, firstTokenMs: 0, firstAudioMs: 0, totalMs: 0 };

          // Combine PCM buffers
          const pcmBuffer = Buffer.concat(pcmBuffers);
          if (pcmBuffer.length === 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'No speech detected' }));
            state = 'idle';
            return;
          }

          const wavBuffer = pcm16ToWav(pcmBuffer, 16000);
          logVoice({ ev: 'stream-received', bytes: wavBuffer.length });

          let transcript = '';
          try {
            const r = await transcribe({
              buffer: wavBuffer,
              mimeType: 'audio/wav',
              language: sttLanguage
            });
            transcript = r.text;
            timing.sttMs = Date.now() - t0;
            logVoice({ ev: 'stt', ok: true, engine: r.engine, len: (transcript || '').length, bytes: wavBuffer.length, ms: timing.sttMs });
          } catch (sttErr) {
            logVoice({ ev: 'stt', ok: false, error: (sttErr.message || String(sttErr)).slice(0, 300) });
            console.error('[VOICE-STREAM] STT failed:', sttErr.message);
            ws.send(JSON.stringify({ type: 'error', message: 'STT: ' + sttErr.message }));
            state = 'idle';
            return;
          }

          if (!transcript) {
            ws.send(JSON.stringify({ type: 'error', message: 'no speech detected' }));
            state = 'idle';
            return;
          }

          ws.send(JSON.stringify({ type: 'transcript', text: transcript }));
          console.log(`[VOICE-STREAM] Transcript: "${transcript}"`);

          const idempotencyKey = `voice-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const brain = getActiveBrain();
          console.log(`[VOICE-STREAM] brain=${brain}`);

          // TTS streaming pipeline helpers
          let spokenLen = 0;
          let sentencesSpoken = 0;
          // playbackSeq serializes audio delivery; synthesis runs in parallel immediately
          let playbackSeq = Promise.resolve();
          const SENTENCE_RE = /[^.!?。！？\n]*[.!?。！？\n]+/g;

          const speakChunk = (chunkText) => {
            const clean = chunkText.trim();
            if (!clean) return;
            sentencesSpoken++;
            // Start synthesis immediately — don't wait for the previous sentence
            const synthP = ttsSentence(clean)
              .then(r => ({ r, clean }))
              .catch(err => ({ err, clean }));
            // Deliver audio in order by chaining onto the playback sequence
            playbackSeq = playbackSeq.then(async () => {
              const result = await synthP;
              if (result.err) {
                console.error('[VOICE-STREAM] TTS failed:', result.err.message);
                ws.send(JSON.stringify({ type: 'tts-error', message: result.err.message }));
                return;
              }
              const { r } = result;
              if (r && r.buffer && r.buffer.length) {
                if (!timing.firstAudioMs) timing.firstAudioMs = Date.now() - t0;
                ws.send(JSON.stringify({
                  type: 'tts-chunk',
                  audio: r.buffer.toString('base64'),
                  contentType: r.contentType,
                  text: clean
                }));
              }
            });
          };

          const flushSentences = (fullText, force) => {
            let pending = fullText.slice(spokenLen);
            if (!pending) return;
            if (force) {
              spokenLen = fullText.length;
              speakChunk(pending);
              return;
            }
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
                  await playbackSeq;

                  timing.totalMs = Date.now() - t0;
                  try { ws.send(JSON.stringify({ type: 'timing', ...timing })); } catch {}
                  try { ws.send(JSON.stringify({ type: 'done', fullText: fullText })); } catch {}
                  resolve(fullText);
                };

                handler = (payload) => {
                  console.log(`[VS-DBG] evt sk=${JSON.stringify(payload.sessionKey)} mine=${JSON.stringify(voiceSessionKey)} match=${payload.sessionKey === voiceSessionKey} state=${payload.state}`);
                  // Only react to this device's own voice session.
                  if (payload.sessionKey && payload.sessionKey !== voiceSessionKey) return;
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
                      ws.send(JSON.stringify({ type: 'text-chunk', text: newChars }));
                    }
                    flushSentences(fullText, false);
                  }
                  if (payload.state === 'final' || payload.state === 'aborted') finish();
                };

                addVoiceHandler(handler);

                const outgoing = formatVoicePrompt(transcript, replyLanguage);

                gwRequest('chat.send', {
                  message: outgoing,
                  sessionKey: voiceSessionKey,
                  idempotencyKey,
                  deliver: false,
                }).catch((err) => {
                  removeVoiceHandler(handler);
                  reject(err);
                });

                setTimeout(finish, 60000);
              });
            } else {
              // Direct brain path
              const userMsg = formatVoicePrompt(transcript, replyLanguage);

              let fullText = '';
              responseText = await brainChat({
                user: userMsg,
                onToken: (token) => {
                  fullText += token;
                  if (!timing.firstTokenMs) timing.firstTokenMs = Date.now() - t0;
                  ws.send(JSON.stringify({ type: 'text-chunk', text: token }));
                  flushSentences(fullText, false);
                },
              });
              flushSentences(responseText || fullText, true);
              await playbackSeq;
            }

            // For openclaw, timing+done are already sent inside finish().
            // Only needed here for direct brain path.
            if (brain !== 'openclaw') {
              timing.totalMs = Date.now() - t0;
              logVoice({ ev: 'timing', ...timing });
              console.log(`[VOICE-STREAM] timing stt=${timing.sttMs}ms llm1stToken=${timing.firstTokenMs}ms 1stAudio=${timing.firstAudioMs}ms total=${timing.totalMs}ms`);
              ws.send(JSON.stringify({ type: 'timing', ...timing }));
              ws.send(JSON.stringify({ type: 'done', fullText: responseText }));
            }
          } catch (chatErr) {
            console.error('[VOICE-STREAM] Brain/TTS error:', chatErr);
            ws.send(JSON.stringify({ type: 'error', message: chatErr.message }));
          } finally {
            state = 'idle';
          }
        }
      } catch (err) {
        console.error('[VOICE-STREAM] Message error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Malformed JSON' }));
      }
    });

    ws.on('close', () => {
      console.log('[VOICE-STREAM] Browser disconnected');
      state = 'idle';
      pcmBuffers = [];
    });
  });
  return wss;
}
