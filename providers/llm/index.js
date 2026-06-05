import * as openai from './openai.js';
import * as openclaw from './openclaw.js';

function provider() {
  return (process.env.LLM_PROVIDER || 'openai').toLowerCase();
}

function selected() {
  return provider() === 'openclaw' ? openclaw : openai;
}

export function clearSession(id) {
  return selected().clearSession(id);
}

export function rememberTurn(id, userText, assistantText) {
  return selected().rememberTurn(id, userText, assistantText);
}

export function streamChat(options) {
  return selected().streamChat(options);
}

export { correctTranscript } from './openai.js';
