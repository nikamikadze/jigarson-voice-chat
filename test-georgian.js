// Georgian round-trip test for the Gemini voice integration.
// Run: node --env-file=.env test-georgian.js
// Confirms: TTS speaks Georgian, and STT transcribes it back in Georgian script.

import { writeFile } from 'fs/promises';
import { geminiTTS, geminiTranscribe, geminiAvailable } from './server/gemini.js';

if (!geminiAvailable()) {
  console.error('❌ GEMINI_API_KEY is not set.');
  process.exit(1);
}

const GE = 'გამარჯობა, მე ვარ ჯარვისი. ქართული ხმის ინტეგრაცია წარმატებით მუშაობს.';

console.log('1/2  TTS  → speaking a Georgian sentence...');
const { buffer } = await geminiTTS(GE, { voiceName: 'Kore' });
await writeFile('/tmp/jarvis-georgian.wav', buffer);
console.log(`     ✅ ${buffer.length} bytes → /tmp/jarvis-georgian.wav`);
console.log(`     original: ${GE}`);

console.log('2/2  STT  → transcribing it back (language hint: Georgian)...');
const transcript = await geminiTranscribe(buffer, { mimeType: 'audio/wav', language: 'Georgian' });
console.log(`     transcript: ${transcript}`);

const georgianChars = (transcript.match(/[Ⴀ-ჿ]/g) || []).length;
console.log(georgianChars > 5
  ? '\n🎉 Georgian round-trip works (transcript is in Georgian script).'
  : '\n⚠️  Transcript does not look like Georgian script — paste this output to debug.');
