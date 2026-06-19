// ── Brain manager — swappable AI backends ──
// Manages which AI brain handles voice/text responses.
// Backends: openclaw (gateway, default), openai (direct), deepseek (direct)

import { openaiAvailable, openaiChatStream, openaiChatModel } from './openai.js';
import { deepseekAvailable, deepseekChatStream, deepseekModel } from './deepseek.js';

// Default system prompt — applied only for direct (non-gateway) brains.
const DEFAULT_SYSTEM = process.env.JARVIS_SYSTEM ||
  'You are JARVIS, a highly capable personal AI assistant. Be concise, clear, and helpful. Speak naturally.';

const BRAINS = {
  openclaw: {
    name: 'OpenClaw',
    description: 'Full agent via OpenClaw gateway (tools, memory, sessions)',
    available: () => true,          // always available
  },
  openai: {
    name: 'OpenAI',
    description: `Direct OpenAI streaming chat (${process.env.OPENAI_CHAT_MODEL || 'gpt-4o'})`,
    available: openaiAvailable,
  },
  deepseek: {
    name: 'DeepSeek',
    description: `Direct DeepSeek streaming chat (${process.env.DEEPSEEK_MODEL || 'deepseek-chat'})`,
    available: deepseekAvailable,
  },
};

let activeBrain = process.env.BRAIN || 'openclaw';

// On startup, fall back to openclaw if the configured brain has no key.
if (!BRAINS[activeBrain]?.available()) activeBrain = 'openclaw';

export function getBrains() {
  return {
    current: activeBrain,
    brains: Object.entries(BRAINS).map(([id, b]) => ({
      id,
      name: b.name,
      description: b.description,
      available: b.available(),
      selected: id === activeBrain,
    })),
  };
}

export function setBrain(id) {
  if (!BRAINS[id]) throw new Error(`Unknown brain: ${id}`);
  if (!BRAINS[id].available()) throw new Error(`${id} has no API key configured`);
  activeBrain = id;
  return activeBrain;
}

export function getActiveBrain() { return activeBrain; }

// Run a chat turn through the active brain.
// - For openclaw: caller must use gwRequest directly (brain returns null — signal to caller).
// - For direct brains: streams tokens via onToken, returns full text.
export async function brainChat({ user, system, onToken, signal } = {}) {
  if (activeBrain === 'openclaw') return null;   // caller handles gateway path

  const sys = system || DEFAULT_SYSTEM;

  if (activeBrain === 'openai') {
    return openaiChatStream({ system: sys, user, onToken, signal });
  }
  if (activeBrain === 'deepseek') {
    return deepseekChatStream({ system: sys, user, onToken, signal });
  }

  throw new Error(`Unhandled brain: ${activeBrain}`);
}
