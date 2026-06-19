// ── Local Whisper STT wrapper (OpenAI whisper CLI) ──
// Shells out to the `whisper` command (/usr/local/bin/whisper) to transcribe an
// audio file on-device. No network, no API key, no billing — immune to the
// Gemini audio 429s.
//
// Config via env:
//   WHISPER_BIN     (default: "whisper")
//   WHISPER_MODEL   (default: "small")   tiny/base/small/medium/large-v3/turbo
//   WHISPER_PYTHON  (unused here; kept for compatibility)

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';

// Map friendly language names (from config) to Whisper language codes.
const LANG_CODES = {
  georgian: 'ka', english: 'en', russian: 'ru', german: 'de',
  french: 'fr', spanish: 'es', chinese: 'zh', japanese: 'ja',
};

export function toWhisperLang(language) {
  if (!language) return '';
  const k = String(language).trim().toLowerCase();
  if (k.length <= 3) return k;            // already a code like "ka"
  return LANG_CODES[k] || '';             // unknown → auto-detect
}

export async function whisperTranscribe(audioPath, { language = '' } = {}) {
  const lang = toWhisperLang(language);
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-stt-'));

  const args = [
    audioPath,
    '--model', WHISPER_MODEL,
    '--task', 'transcribe',
    '--output_format', 'txt',
    '--output_dir', outDir,
    '--fp16', 'False',        // CPU-friendly, silences the fp16 warning
    '--verbose', 'False',
  ];
  if (lang) args.push('--language', lang);

  try {
    await run(WHISPER_BIN, args);
    // whisper writes <stem>.txt into outDir — read whatever .txt it produced.
    const files = (await readdir(outDir)).filter((f) => f.endsWith('.txt'));
    if (!files.length) return '';
    const text = await readFile(path.join(outDir, files[0]), 'utf8');
    return text.trim();
  } finally {
    rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: process.env });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(new Error(`whisper spawn failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error((err || `whisper exited ${code}`).trim().slice(0, 300)));
    });
  });
}
