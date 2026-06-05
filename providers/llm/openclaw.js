import fetch from 'node-fetch';

function endpoint() {
  return process.env.OPENCLAW_AGENT_URL || process.env.OPENCLAW_URL;
}

function headers() {
  const result = {
    Accept: 'application/json, text/event-stream, text/plain',
    'Content-Type': 'application/json'
  };
  const key = process.env.OPENCLAW_API_KEY || process.env.OPENCLAW_AGENT_KEY;
  if (key) result.Authorization = `Bearer ${key}`;
  return result;
}

function requestBody({ sessionId, userText }) {
  if (process.env.OPENCLAW_BODY_FORMAT === 'voice_site') {
    return {
      message: userText,
      language: process.env.OPENCLAW_LANGUAGE || 'ka',
      temperature: Number(process.env.OPENCLAW_TEMPERATURE || 0.7),
      session_id: sessionId
    };
  }

  if (process.env.OPENCLAW_BODY_FORMAT === 'openai') {
    return {
      model: process.env.OPENCLAW_MODEL || 'agent',
      stream: process.env.OPENCLAW_STREAM !== 'false',
      messages: [{ role: 'user', content: userText }],
      session_id: sessionId
    };
  }

  return {
    sessionId,
    session_id: sessionId,
    message: userText,
    input: userText,
    text: userText,
    stream: process.env.OPENCLAW_STREAM !== 'false'
  };
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return (
    value.token ||
    value.delta ||
    value.text ||
    value.answer ||
    value.reply ||
    value.response ||
    value.output ||
    value.message?.content ||
    value.choices?.[0]?.delta?.content ||
    value.choices?.[0]?.message?.content ||
    ''
  );
}

async function* streamEventSource(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';

    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const text = extractText(parsed);
          if (text) yield text;
        } catch {
          yield data;
        }
      }
    }
  }
}

async function* streamLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const text = extractText(parsed);
        if (text) yield text;
      } catch {
        yield trimmed;
      }
    }
  }
}

export function clearSession() {}

export function rememberTurn() {}

export async function* streamChat({ sessionId = 'default', userText, signal, onFirstToken }) {
  const url = endpoint();
  if (!url) throw new Error('Missing env: OPENCLAW_AGENT_URL');

  const startedAt = performance.now();
  let tokenCount = 0;
  const response = await fetch(url, {
    method: process.env.OPENCLAW_METHOD || 'POST',
    signal,
    headers: headers(),
    body: JSON.stringify(requestBody({ sessionId, userText }))
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`OpenClaw agent failed: HTTP ${response.status}${details ? ` ${details.slice(0, 300)}` : ''}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    for await (const token of streamEventSource(response.body)) {
      if (!tokenCount) onFirstToken?.(performance.now() - startedAt);
      tokenCount += 1;
      yield token;
    }
    return;
  }

  if (contentType.includes('application/x-ndjson') || contentType.includes('text/plain')) {
    for await (const token of streamLines(response.body)) {
      if (!tokenCount) onFirstToken?.(performance.now() - startedAt);
      tokenCount += 1;
      yield token;
    }
    return;
  }

  const payload = await response.json();
  const text = extractText(payload);
  if (!text) throw new Error('OpenClaw agent response did not contain text');
  onFirstToken?.(performance.now() - startedAt);
  yield text;
}
