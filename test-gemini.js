// Smoke test for the Gemini voice integration.
// Run: node --env-file=.env test-gemini.js
// Verifies: (1) GEMINI_API_KEY works, (2) TTS produces audio, (3) STT reads it back.

import { writeFile } from 'fs/promises';
import { geminiTTS, geminiTranscribe, geminiAvailable } from './server/gemini.js';

if (!geminiAvailable()) {
  console.error('❌ GEMINI_API_KEY is not set. Add it to .env first.');
  process.exit(1);
}

const SENTENCE = 'JARVIS online. Gemini voice integration successful.';

console.log('1/2  TTS  → asking Gemini to speak a test sentence...');
const { buffer, contentType } = await geminiTTS(SENTENCE, { voiceName: 'Kore' });
await writeFile('/tmp/jarvis-tts-test.wav', buffer);
console.log(`     ✅ got ${buffer.length} bytes (${contentType}) → /tmp/jarvis-tts-test.wav`);

console.log('2/2  STT  → sending that audio back to Gemini to transcribe...');
const transcript = await geminiTranscribe(buffer, { mimeType: 'audio/wav' });
console.log(`     ✅ transcript: "${transcript}"`);

console.log('\n🎉 Both directions work. Voice mode is ready — pm2 restart jarvis.');
