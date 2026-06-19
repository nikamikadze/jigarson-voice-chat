// Temporary battle-test harness — exercises the real Gemini paths via the app's own code.
import { geminiAvailable, geminiTTS, geminiTranscribe } from './gemini.js';
import { writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const key = process.env.GEMINI_API_KEY || '';
console.log('KEY present:', geminiAvailable(), 'len:', key.length, 'last6:', key.slice(-6));

// 1) Plain text generateContent — proves the key/billing on text.
async function testText() {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'say OK' }] }] }),
  });
  console.log('\n[1] TEXT generateContent ->', r.status, r.ok ? 'OK' : (await r.text()).slice(0, 200));
}

// 2) Gemini TTS — synthesize a short English phrase to audio (also proves TTS model).
let wavPath = null;
async function testTTS() {
  try {
    const { buffer, contentType } = await geminiTTS('This is a speech to text test, one two three.', {});
    wavPath = path.join(os.tmpdir(), 'bt-tts.wav');
    await writeFile(wavPath, buffer);
    console.log('\n[2] GEMINI TTS -> OK', buffer.length, 'bytes', contentType, '->', wavPath);
  } catch (e) {
    console.log('\n[2] GEMINI TTS -> FAIL:', String(e.message).slice(0, 220));
  }
}

// 3) The actual STT path — transcribe that audio with the same function the mic uses.
async function testSTT() {
  if (!wavPath) { console.log('\n[3] STT -> skipped (no audio from TTS)'); return; }
  const { readFile } = await import('fs/promises');
  const audio = await readFile(wavPath);
  for (const model of ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']) {
    try {
      const t = await geminiTranscribe(audio, { mimeType: 'audio/wav', model, language: 'English' });
      console.log(`\n[3] STT (${model}) -> OK: "${t}"`);
    } catch (e) {
      console.log(`\n[3] STT (${model}) -> FAIL:`, String(e.message).slice(0, 200));
    }
  }
}

await testText();
await testTTS();
await testSTT();
console.log('\n--- battle test done ---');
