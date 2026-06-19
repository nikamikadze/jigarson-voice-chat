// ── Memory layer for the direct (Gemini) brain ──
// Two tiers, mirroring the OpenClaw agent's design:
//   1. CORE  — small, always loaded into the system prompt every turn.
//   2. SEARCHABLE — the rest of the workspace; relevant chunks are auto-retrieved
//      per message and injected, so the brain stays fast (small context) yet smart.
//
// File reads are cached in-process and invalidated by mtime, so repeated turns
// don't re-hit disk. No external embeddings — lightweight keyword scoring keeps
// it instant and dependency-free.

import { readFile, readdir, stat } from 'fs/promises';
import os from 'os';
import path from 'path';

const WS = path.join(os.homedir(), '.openclaw', 'workspace');
const MEM = path.join(WS, 'memory');

// CORE: always loaded. (MEMORY.md lives at workspace root; the rest under memory/.)
const CORE_FILES = [
  path.join(WS, 'MEMORY.md'),
  path.join(MEM, 'jigarson_personality.md'),
  path.join(MEM, 'faces.md'),
  path.join(MEM, 'people', 'group.md'),
];
const CORE_DIRS = [path.join(MEM, 'profiles')]; // every .md inside is core

// ── tiny mtime-keyed file cache ──
const fileCache = new Map(); // absPath -> { mtimeMs, text }
async function readCached(abs) {
  try {
    const st = await stat(abs);
    const hit = fileCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = await readFile(abs, 'utf-8');
    fileCache.set(abs, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

async function listMd(dir) {
  try {
    const out = [];
    for (const name of await readdir(dir)) {
      if (name.endsWith('.md')) out.push(path.join(dir, name));
    }
    return out;
  } catch {
    return [];
  }
}

// Recursively gather every .md under memory/ (one level of subdirs is plenty here).
async function allMemoryMd() {
  const files = [...await listMd(MEM)];
  for (const sub of ['profiles', 'people', 'knowledge', 'live-sessions']) {
    files.push(...await listMd(path.join(MEM, sub)));
  }
  return files;
}

// ── CORE ──
let coreCache = { sig: '', text: '' };
export async function loadCore() {
  const files = [...CORE_FILES];
  for (const d of CORE_DIRS) files.push(...await listMd(d));

  const parts = [];
  const sigBits = [];
  for (const abs of files) {
    const text = await readCached(abs);
    if (!text || !text.trim()) continue;
    const rel = path.relative(WS, abs);
    parts.push(`### ${rel}\n${text.trim()}`);
    try { sigBits.push(rel + (fileCache.get(abs)?.mtimeMs || 0)); } catch {}
  }
  const sig = sigBits.join('|');
  if (sig === coreCache.sig) return coreCache.text;     // unchanged → reuse
  coreCache = { sig, text: parts.join('\n\n') };
  return coreCache.text;
}

// ── SEARCH (auto-retrieve) ──
const STOP = new Set(('a an the of to in on for and or but is are was were be been do does did with '
  + 'i you he she it we they me him her them my your his their this that what who when where why how '
  + 'can could would should will shall may might about as at by from into over after before so if then '
  + 'not no yes ok okay just like get got know tell say said about').split(/\s+/));

function terms(q) {
  return [...new Set(String(q).toLowerCase().match(/[a-z0-9Ⴀ-ჿ]{3,}/g) || [])]
    .filter(t => !STOP.has(t));
}

// Split a file into heading-delimited chunks: { heading, body, file }.
function chunk(text, file) {
  const lines = text.split('\n');
  const chunks = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) chunks.push({ heading, body, file });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.*)/);
    if (m) { flush(); heading = m[1].trim(); } else buf.push(line);
  }
  flush();
  return chunks;
}

// Returns a formatted context block of the most relevant chunks, or '' if none.
export async function searchMemory(query, { maxChunks = 4, maxChars = 6000 } = {}) {
  const qt = terms(query);
  if (!qt.length) return { block: '', hits: [] };

  const coreSet = new Set(CORE_FILES.map(f => path.resolve(f)));
  const files = (await allMemoryMd())
    .filter(f => path.basename(f) !== 'MEMORY.md' && !coreSet.has(path.resolve(f)) && !f.includes(`${path.sep}profiles${path.sep}`));

  const scored = [];
  for (const abs of files) {
    const text = await readCached(abs);
    if (!text) continue;
    const rel = path.relative(WS, abs);
    const fnameHit = qt.some(t => rel.toLowerCase().includes(t));
    for (const c of chunk(text, rel)) {
      const hay = (c.heading + '\n' + c.body).toLowerCase();
      let score = 0;
      for (const t of qt) {
        const occ = hay.split(t).length - 1;
        if (occ) score += occ;
        if (c.heading.toLowerCase().includes(t)) score += 3;
      }
      if (fnameHit) score += 2;
      if (score > 0) scored.push({ ...c, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let budget = maxChars;
  for (const c of scored) {
    if (picked.length >= maxChunks) break;
    const piece = `[${c.file}${c.heading ? ' › ' + c.heading : ''}]\n${c.body}`;
    if (piece.length > budget && picked.length) continue;
    picked.push(piece.slice(0, budget));
    budget -= Math.min(piece.length, budget);
    if (budget <= 200) break;
  }

  return {
    block: picked.join('\n\n---\n\n'),
    hits: scored.slice(0, maxChunks).map(c => `${c.file}${c.heading ? '#' + c.heading : ''} (${c.score})`),
  };
}

// Build the full system prompt for the direct brain: persona + core + retrieved.
export async function buildMemorySystem(basePersona, userMessage) {
  const core = await loadCore();
  const { block, hits } = await searchMemory(userMessage);

  let sys = basePersona;
  if (core) {
    sys += `\n\n## ALWAYS-KNOWN MEMORY (your core knowledge — treat as ground truth)\n${core}`;
  }
  if (block) {
    sys += `\n\n## RELEVANT MEMORY (auto-retrieved for this message)\n${block}`;
  }
  sys += `\n\nWhen the user refers to people, projects, or facts, rely on the memory above. `
    + `If something isn't there, say you don't have it in memory rather than inventing details.`;
  return { system: sys, hits };
}
