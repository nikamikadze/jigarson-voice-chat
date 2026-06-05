import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve('data');
export const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
export const PERSONALITY_PATH = path.join(DATA_DIR, 'personality.txt');
export const ALLOWED_KNOWLEDGE_EXTENSIONS = new Set(['.txt', '.md', '.json']);

export const DEFAULT_PERSONALITY = `You are an AI assistant for the business configured by the admin.

You speak Georgian by default.

You are:

* Friendly
* Helpful
* Professional
* Knowledgeable about the uploaded knowledge base
* Slightly humorous when appropriate
* Warm and conversational

Rules:

* Use uploaded knowledge files as the source of truth.
* Never invent prices.
* Never invent stock quantities.
* Never invent policies.
* If information is missing, say you do not have that information.`;

const labelOverrides = {
  id: 'ID',
  sku: 'SKU',
  url: 'URL',
  name: 'Product Name',
  price: 'Price',
  stock: 'Stock',
  quantity: 'Quantity'
};

export async function ensureDataStore() {
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
  try {
    await fs.access(PERSONALITY_PATH);
  } catch {
    await fs.writeFile(PERSONALITY_PATH, DEFAULT_PERSONALITY, 'utf8');
  }
}

export function isAllowedKnowledgeFile(filename = '') {
  return ALLOWED_KNOWLEDGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function safeKnowledgeFilename(filename = '') {
  const parsed = path.parse(filename);
  const ext = parsed.ext.toLowerCase();
  const base = parsed.name
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return `${base || 'knowledge'}${ext}`;
}

export function knowledgeFilePath(filename) {
  const safeName = safeKnowledgeFilename(filename);
  const resolved = path.resolve(KNOWLEDGE_DIR, safeName);
  if (!resolved.startsWith(KNOWLEDGE_DIR + path.sep)) throw new Error('Invalid knowledge filename');
  return resolved;
}

function humanLabel(key) {
  if (labelOverrides[key]) return labelOverrides[key];
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPrimitive(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function jsonToReadable(value, indent = 0, key = '') {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return key ? `${pad}${humanLabel(key)}: none` : `${pad}None`;
    const title = key ? `${pad}${humanLabel(key)}:` : '';
    const rows = value.flatMap((item, index) => {
      if (item && typeof item === 'object') {
        return [`${pad}- Item ${index + 1}:`, jsonToReadable(item, indent + 1).trimEnd()];
      }
      return [`${pad}- ${formatPrimitive(item)}`];
    });
    return [title, ...rows].filter(Boolean).join('\n');
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([childKey, childValue]) => {
        if (childValue && typeof childValue === 'object') return jsonToReadable(childValue, indent, childKey);
        const suffix = childKey.toLowerCase() === 'price' && typeof childValue === 'number' ? ' GEL' : '';
        return `${pad}${humanLabel(childKey)}: ${formatPrimitive(childValue)}${suffix}`;
      })
      .join('\n');
  }

  return key ? `${pad}${humanLabel(key)}: ${formatPrimitive(value)}` : `${pad}${formatPrimitive(value)}`;
}

export function knowledgeBufferToText(filename, buffer) {
  const text = buffer.toString('utf8');
  if (path.extname(filename).toLowerCase() !== '.json') return text;
  return jsonToReadable(JSON.parse(text));
}

async function readKnowledgeFile(entry) {
  const fullPath = path.join(KNOWLEDGE_DIR, entry.name);
  const stat = await fs.stat(fullPath);
  const raw = await fs.readFile(fullPath);
  const text = knowledgeBufferToText(entry.name, raw);
  return {
    name: entry.name,
    size: stat.size,
    uploadedAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    characters: text.length,
    text
  };
}

export async function listKnowledgeFiles() {
  await ensureDataStore();
  const entries = await fs.readdir(KNOWLEDGE_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isAllowedKnowledgeFile(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(files.map(readKnowledgeFile));
}

export async function loadPersonality() {
  await ensureDataStore();
  const text = await fs.readFile(PERSONALITY_PATH, 'utf8');
  console.log('[Personality] Loaded successfully');
  return text;
}

export async function savePersonality(text) {
  await ensureDataStore();
  await fs.writeFile(PERSONALITY_PATH, String(text || '').trim(), 'utf8');
}

export async function loadKnowledgeBase() {
  const files = await listKnowledgeFiles();
  const totalCharacters = files.reduce((sum, file) => sum + file.characters, 0);
  console.log(`[Knowledge] Loaded ${files.length} files`);
  console.log(`[Knowledge] Total characters: ${totalCharacters}`);
  return { files, totalCharacters };
}

export async function knowledgeStatus() {
  const [personality, knowledge] = await Promise.all([loadPersonality(), loadKnowledgeBase()]);
  return {
    files: knowledge.files.map(({ text, ...file }) => file),
    fileCount: knowledge.files.length,
    totalCharacters: knowledge.totalCharacters,
    personalityLoaded: Boolean(personality.trim()),
    personalityCharacters: personality.length
  };
}
